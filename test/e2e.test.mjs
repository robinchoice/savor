// End-to-end tests: real daemon, real UI in headless Chromium, fake agents (test/fake-claude.mjs,
// test/fake-codex.mjs speaking the app-server protocol, test/fake-acp.mjs speaking ACP for OpenCode),
// a fake whisper.cpp (test/fake-whisper.mjs) behind Chromium's fake microphone and a fake GitHub CLI
// (test/fake-gh.mjs).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-e2e-'))
const HOME = path.join(TMP, 'home')
const PROJECT = path.join(TMP, 'project')
const AGENT_LOG = path.join(TMP, 'agents.jsonl') // the fake agents log their command lines here
const WHISPER_MODEL = path.join(TMP, 'ggml-test.bin')
let server, browser, page, port, token, base

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const api = async (method, p, body, cookie = `savor_token=${token}`) => {
  const r = await fetch(`${base}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).catch((e) => {
    throw new Error(`${method} ${p}: ${e.message} (${e.cause?.code ?? e.cause?.message ?? 'no cause'})`)
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timed out')
}

// Pairs over the LAN; this computer answers the request the device's code opened.
async function redeem(code, name, approve = true) {
  const reply = fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, check: '042137' }) })
  let request
  await until(async () => (request = (await api('GET', '/devices/requests')).body.find((r) => r.name === name)))
  assert.deepEqual([request.via, request.check], ['lan', '042137'])
  await api('POST', `/devices/requests/${request.id}`, { approve })
  return reply
}

async function newConversation() {
  await page.click('.new-btn')
  await page.waitForSelector('text=What do you want to build?')
}

async function send(text) {
  await page.fill('.composer textarea', text)
  await page.keyboard.press('Enter')
}

async function startDaemon() {
  const entry = fs.existsSync(path.join(ROOT, 'dist/server/index.mjs')) ? 'dist/server/index.mjs' : 'bin/savor.js'
  server = spawn(process.execPath, [path.join(ROOT, entry)], {
    env: {
      ...process.env,
      SAVOR_HOME: HOME,
      SAVOR_PORT: String(port),
      SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'),
      SAVOR_CODEX_BIN: path.join(ROOT, 'test/fake-codex.mjs'),
      SAVOR_OPENCODE_BIN: path.join(ROOT, 'test/fake-acp.mjs'),
      SAVOR_GROK_BIN: path.join(TMP, 'no-such-grok'),
      SAVOR_GEMINI_BIN: path.join(ROOT, 'test/fake-acp.mjs'),
      SAVOR_ANTIGRAVITY_BIN: path.join(ROOT, 'test/fake-agy.mjs'),
      SAVOR_ANTIGRAVITY_HOME: path.join(TMP, 'agy'),
      SAVOR_WHISPER_BIN: path.join(ROOT, 'test/fake-whisper.mjs'),
      SAVOR_GH_BIN: path.join(ROOT, 'test/fake-gh.mjs'),
      SAVOR_WHISPER_MODEL: WHISPER_MODEL,
      FAKE_AGENT_LOG: AGENT_LOG,
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'),
      CODEX_HOME: path.join(TMP, 'codex'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
}

before(async () => {
  port = await freePort()
  base = `http://127.0.0.1:${port}`
  fs.mkdirSync(PROJECT)
  fs.writeFileSync(WHISPER_MODEL, '')
  await startDaemon()
  token = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).token
  browser = await chromium.launch({ executablePath: process.env.SAVOR_CHROMIUM, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' })
  await page.goto(`${base}/?token=${token}`)
})

after(async () => {
  await browser?.close()
  server?.kill()
  // The daemon's preview browser and agents outlive it for a moment, and the browser keeps writing its profile.
  await until(() => !execFileSync('ps', ['-eo', 'args']).toString().includes(TMP))
  fs.rmSync(TMP, { recursive: true, force: true })
})

test('add a project and get a conclusion with next actions', async () => {
  await page.click('text=Projects')
  await page.click('text=Open any folder')
  await page.fill('.menu-form input', PROJECT)
  await page.click('.menu-form button')
  await page.waitForSelector('text=What do you want to build?')
  await send('hello savor')
  await page.waitForSelector('text=Echo: hello savor')
  await page.waitForSelector('.label-pill:has-text("Fake agent test")')
  await page.waitForSelector('.next-actions >> text=Do it again')
  await page.click('.mark-complete')
  await page.waitForSelector('.status:has-text("Finished")')
})

test('only new input moves a conversation up, finishing hides it right away', async () => {
  const start = async (text) => {
    await newConversation()
    await send(text)
    await page.waitForSelector(`text=Echo: ${text}`)
    return new URL(page.url()).hash
  }
  const older = await start('older one')
  const newer = await start('newer one')
  const order = () => page.locator('.cards a.card').evaluateAll((cards) => cards.map((c) => c.getAttribute('href')))
  assert.deepEqual((await order()).slice(0, 2), [newer, older])
  await page.click(`a.card[href="${older}"]`)
  await page.waitForSelector(`a.card.active[href="${older}"]`)
  assert.deepEqual((await order()).slice(0, 2), [newer, older], 'opening keeps the order')
  await send('again')
  await page.waitForSelector('text=Echo: again')
  await until(async () => (await order())[0] === older)
  await page.click('.mark-complete')
  await page.waitForSelector(`a.card[href="${older}"]`, { state: 'detached' })
})

test('agent settings fit the viewport and apply right away', async () => {
  await newConversation()
  for (const viewport of [{ width: 1400, height: 900 }, { width: 900, height: 600 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.click('.agent-btn')
    await page.waitForSelector('.agent-menu')
    const bounds = await page.locator('.agent-menu').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, overflow: el.scrollWidth - el.clientWidth }
    })
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= viewport.width && bounds.bottom <= viewport.height, JSON.stringify(bounds))
    assert.ok(bounds.overflow <= 1, JSON.stringify(bounds))
    await page.keyboard.press('Escape')
    await page.waitForSelector('.agent-menu', { state: 'detached' })
  }
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.click('.agent-btn')
  await page.locator('.ap-agent', { hasText: 'Codex' }).click()
  assert.equal(await page.locator('.ap-model.selected b').innerText(), 'Default')
  await page.locator('.ap-effort button', { hasText: 'Low' }).click()
  assert.equal(await page.locator('.ap-effort button.selected').innerText(), 'Low')
  assert.match(await page.locator('.agent-btn').innerText(), /Low/)
  await page.click('.conv-head h2')
  await page.waitForSelector('.agent-menu', { state: 'detached' })
})

test('errors retain their provider after switching agents', async () => {
  const [project] = (await api('GET', '/projects')).body
  const t = (await api('POST', `/projects/${project.id}/threads`, { text: 'fail: Session limit reached', agent: project.agent })).body
  const route = `/projects/${project.id}/threads/${t.id}`
  await until(async () => (await api('GET', route)).body.messages.some((m) => m.kind === 'error'))
  await api('PATCH', route, { agent: { ...project.agent, provider: 'codex', permissionMode: 'on-request' } })
  await page.goto(`${base}/#/p/${project.id}/t/${t.id}`)
  await page.waitForSelector('.msg.error')
  assert.equal(await page.locator('.msg.error .msg-head b').innerText(), 'Claude Code')
  assert.equal((await api('GET', route)).body.messages.find((m) => m.kind === 'error').modelInfo.provider, 'claude')
  await api('PATCH', `/projects/${project.id}`, { agent: project.agent })
})

test('a Claude Code that is too old says how to update it', async () => {
  const [project] = (await api('GET', '/projects')).body
  fs.writeFileSync(AGENT_LOG + '.outdated', '')
  const t = (await api('POST', `/projects/${project.id}/threads`, { text: 'hello', agent: project.agent })).body
  const route = `/projects/${project.id}/threads/${t.id}`
  await until(async () => (await api('GET', route)).body.messages.some((m) => m.kind === 'error'))
  fs.rmSync(AGENT_LOG + '.outdated')
  assert.equal(
    (await api('GET', route)).body.messages.find((m) => m.kind === 'error').text,
    "Claude Code is too old for Savor (error: unknown option '--permission-prompts'). Update it with `claude update` and send your message again.",
  )
  await api('POST', `${route}/messages`, { text: 'hello again' })
  await until(async () => (await api('GET', route)).body.messages.some((m) => m.kind === 'conclusion' && m.text === 'Echo: hello again'))
})

test('historical approvals render and failed conversation loads can be retried', async () => {
  const [project] = (await api('GET', '/projects')).body
  const t = (await api('POST', `/projects/${project.id}/threads`, { text: 'historical approval' })).body
  const endpoint = `${base}/api/projects/${project.id}/threads/${t.id}`
  await until(async () => !(await api('GET', `/projects/${project.id}/threads/${t.id}`)).body.busy)
  let fail = true
  await page.route(endpoint, async (route) => {
    if (fail) return route.fulfill({ status: 500, json: { error: 'Temporary read failure' } })
    const response = await route.fetch()
    const data = await response.json()
    data.messages.splice(1, 0, { id: 'historical-approval', kind: 'approval', ts: t.createdAt, approval: { tool: 'Bash', input: { command: 'pwd' }, status: 'allowed' } })
    data.messages.splice(2, 0, { id: 'historical-error', kind: 'error', ts: t.createdAt, text: 'Earlier session limit' })
    data.thread.agent.provider = 'codex'
    await route.fulfill({ response, json: data })
  })
  const errors = []
  const collect = (error) => errors.push(error.message)
  page.on('pageerror', collect)
  try {
    await page.goto(`${base}/#/p/${project.id}/t/${t.id}`)
    await page.waitForSelector('text=Could not load this conversation')
    fail = false
    await page.getByRole('button', { name: 'Try again' }).click()
    await page.waitForSelector('#msg-historical-approval')
    assert.match(await page.locator('#msg-historical-approval').innerText(), /Allowed/)
    assert.equal(await page.locator('#msg-historical-error .msg-head b').innerText(), 'Claude Code')
    assert.ok(await page.locator('.composer textarea').isVisible())
    assert.deepEqual(errors, [])
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.locator('.msg.conclusion button[title="Copy message"]').click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Echo: historical approval')
  } finally {
    page.off('pageerror', collect)
    await page.unroute(endpoint)
  }
})

test('questions are answered in one reply', async () => {
  await newConversation()
  await send('ask: Ship it?')
  await page.waitForSelector('.option')
  await page.waitForSelector('.sec.for-you .card.active .chip.blocked >> text=Question')
  assert.deepEqual(await page.locator('.option:not(.other)').allTextContents(), ['NoRecommended', 'Yes'], 'the recommended option comes first')
  assert.ok(await page.locator('.composer button:has-text("Send answers")').isDisabled(), 'nothing is sent before every question has an answer')
  await page.click('.option:has-text("Yes")')
  await page.fill('.composer textarea', 'Tag the release too.')
  await page.click('.composer button:has-text("Send answers")')
  await page.waitForSelector('text=Selected: Yes')
  await page.waitForSelector('text=Comment: Tag the release too.')
})

test('picked answers stay with their conversation until they are sent', async () => {
  await newConversation()
  await send('ask: Ship it?')
  await page.waitForSelector('.option')
  const asked = await page.evaluate(() => location.hash)
  const back = async () => {
    await page.goto(`${base}/${asked}`)
    await page.waitForSelector('.option')
  }
  await page.click('.option:has-text("Yes")')
  await newConversation()
  await back()
  await page.waitForSelector('.option.selected:has-text("Yes")')
  // A free answer survives switching conversations and reloading the page.
  await page.fill('.option.other .other-answer', 'On Friday')
  await page.goto(`${base}/#/all/inbox`)
  await page.reload()
  await page.waitForSelector('.all-inbox')
  await back()
  assert.equal(await page.inputValue('.option.other .other-answer'), 'On Friday')
  await page.click('.composer button:has-text("Send answers")')
  await page.waitForSelector('text=Answer: On Friday')
  assert.equal(await page.evaluate((id) => localStorage.getItem(`savor-answers:${id}`), asked.split('/').at(-1)), null)
})

test('Enter sends the answers from a picked option', async () => {
  await newConversation()
  await send('ask: Ship it?')
  await page.click('.option:has-text("Yes")')
  await page.keyboard.press('Enter')
  await page.waitForSelector('text=Selected: Yes')
})

test('a comment can be sent before every question is answered', async () => {
  await newConversation()
  await send('ask: Ship it?')
  await page.waitForSelector('.option')
  await page.fill('.composer textarea', 'Drop this, try another way.')
  await page.click('.composer button:has-text("Send comment")')
  await page.waitForSelector('text=Not answered')
  await page.waitForSelector('text=Comment: Drop this, try another way.')
  await page.waitForSelector('.answered:has-text("Skipped")')
  assert.equal(await page.locator('.filter.attention').count(), 0, 'nothing waits for the user anymore')
})

test('approvals are routed to the user, "Always allow" remembers the rule', async () => {
  await newConversation()
  await send('approve: now')
  await page.waitForSelector('.approval >> text=Allow')
  await page.click('.approval button:has-text("Always allow")')
  await page.waitForSelector('text=Permission: allow always')
  await send('approve: again')
  await page.waitForSelector('.approval:has(button:has-text("Deny"))')
  await page.click('.approval button:has-text("Deny")')
  await page.waitForSelector('text=Permission: deny')
})

test('an MCP server can ask to open a page, as a link with Done and Decline', async () => {
  await newConversation()
  await send('open-page: https://docs.example/sign-in')
  await page.waitForSelector('.approval:has-text("docs asks you to open a page") >> text=Sign in to Docs.')
  assert.equal(await page.locator('.approval a.approval-link').getAttribute('href'), 'https://docs.example/sign-in')
  await page.click('.approval button:has-text("Done, continue")')
  await page.waitForSelector('text=Page: accept')
  // Only web pages become links.
  await send('open-page: javascript:alert(1)')
  await page.waitForSelector('text=Page: refused')

  const [project] = (await api('GET', '/projects')).body
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'open-page: https://docs.example/codex', agent: { provider: 'codex', permissionMode: 'default' } })).body
  const t = `/projects/${project.id}/threads/${thread.id}`
  let approval
  await until(async () => (approval = (await api('GET', t)).body.messages.find((m) => m.approval?.status === 'pending')))
  assert.equal(approval.approval.url, 'https://docs.example/codex')
  await api('POST', `${t}/approvals/${approval.id}`, { choice: 'decline' })
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'Codex page: decline'))
  await api('PATCH', `/projects/${project.id}`, { agent: project.agent })
})

test("an agent's own clarifying questions become decisions", async () => {
  await newConversation()
  await send('native-ask: Which color?')
  const other = page.locator('.option.other textarea.other-answer')
  await other.fill('Purple')
  const oneLine = (await other.boundingBox()).height
  await other.fill('A long answer that wraps onto more lines. '.repeat(10))
  assert.ok((await other.boundingBox()).height > oneLine * 2)
  await other.fill('Purple')
  await page.click('.composer button:has-text("Send answers")')
  await page.waitForSelector('text=Answered: Purple')
})

test('input during a turn waits in the queue; "send now" interrupts', async () => {
  await newConversation()
  await send('slow: first')
  await page.waitForSelector('text=On it.')
  await send('second')
  await page.waitForSelector('.msg.queued >> text=second')
  assert.ok(await page.locator('.stop-work').isVisible())
  assert.match(await page.locator('.thread-sub .working').innerText(), /Working ·/)
  fs.writeFileSync(AGENT_LOG + '.release', 'slow: first')
  await page.waitForSelector('text=Echo: first')
  await page.waitForSelector('text=Echo: second')
  assert.equal(await page.locator('.msg.queued').count(), 0)

  await send('slow: third')
  await page.waitForSelector('.working-row')
  await send('fourth')
  await page.click('.queued-row >> text=Stop work and send now')
  await page.waitForSelector('text=Echo: fourth')
  assert.equal(await page.locator('text=Echo: third').count(), 0, 'the interrupted turn did not conclude')
})

test('stop ends a running turn, and the next input starts the agent again', async () => {
  await newConversation()
  await send('slow: stop me')
  await page.waitForSelector('.working-row')
  await send('queued behind it')
  await page.waitForSelector('.msg.queued >> text=queued behind it')
  await page.click('.composer .send.stop')
  await page.waitForSelector('.msg-card.error:has-text("Turn stopped.")')
  await page.waitForSelector('.composer .send.stop', { state: 'detached' })
  assert.equal(await page.locator('.stop-work').count(), 0)
  assert.equal(await page.locator('.msg.queued').count(), 1, 'what was queued stays queued after a stop')
  assert.equal(await page.locator('text=Echo: stop me').count(), 0, 'the stopped turn did not conclude')
  await page.waitForSelector('.thread-sub .status:has-text("Stopped")')
  assert.equal(await page.locator('.thread-sub .status.error').count() + (await page.locator('.card.active .error-badge').count()), 0, 'a stop is not an error')

  await page.click('.queued-row >> text=Remove')
  await send('after the stop')
  await page.waitForSelector('text=Echo: after the stop')
})

test('an agent that waits for background work between turns can be stopped', async () => {
  await newConversation()
  await send('background: long build')
  await page.waitForSelector('.thread-sub .working:has-text("Waiting for background work")')
  await page.waitForSelector('.working-row:has-text("Waiting for background work")')
  const [, projectId, threadId] = page.url().match(/#\/p\/([^/]+)\/t\/([^/]+)/)
  const t = `/projects/${projectId}/threads/${threadId}`
  assert.equal((await api('GET', `/projects/${projectId}/threads`)).body.find((x) => x.id === threadId).waiting, true)

  await page.click('.composer .send.stop')
  await page.waitForSelector('.msg-card.error:has-text("Turn stopped.")')
  await page.waitForSelector('.composer .send.stop', { state: 'detached' })
  assert.equal(await page.locator('.stop-work').count(), 0)
  const { waiting, processes } = (await api('GET', t)).body
  assert.equal(waiting, false)
  assert.equal(processes.length, 1, 'the process the agent started keeps running')

  await send('after the wait')
  await page.waitForSelector('text=Echo: after the wait')
  assert.equal((await api('POST', `/projects/${projectId}/processes/${processes[0].pid}/kill`)).status, 200)
})

test("background work inside the agent's own process counts as waiting and can be stopped", async () => {
  await newConversation()
  await send('own-background: first build')
  await page.waitForSelector('.thread-sub .working:has-text("Waiting for background work")')
  await page.click('.stop-work')
  await page.waitForSelector('.msg-card.error:has-text("Turn stopped.")')
  await page.waitForSelector('.stop-work', { state: 'detached' })

  // Left alone, the agent continues by itself when its background work is done.
  await send('own-background: second build')
  await page.waitForSelector('.thread-sub .working:has-text("Waiting for background work")')
  fs.writeFileSync(AGENT_LOG + '.release', 'own-background: second build')
  await page.waitForSelector('text=Echo: own-background: second build')
  await page.waitForSelector('.stop-work', { state: 'detached' })
})

test('background work an agent leaves running after its conclusion can be stopped', async () => {
  await newConversation()
  await send('own-server: dev server')
  await page.waitForSelector('text=Echo: own-server: dev server')
  await page.waitForSelector('.thread-sub .status:has-text("Background work running")')
  await page.click('.composer .send.stop')
  await page.waitForSelector('.thread-sub .status:has-text("Background work running")', { state: 'detached' })
  assert.equal(await page.locator('.composer .send.stop').count(), 0)
  assert.equal(await page.locator('.msg-card.error').count(), 0, 'no request was cut off, so nothing is reported')
})

test('queued messages can be removed before they are sent', async () => {
  const [project] = (await api('GET', '/projects')).body
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'slow: busy' })).body
  const t = `/projects/${project.id}/threads/${thread.id}`
  const queued = (await api('POST', `${t}/messages`, { text: 'never mind' })).body
  assert.equal(queued.delivered, false)
  assert.equal((await api('DELETE', `${t}/messages/${queued.id}`)).status, 200)
  assert.equal((await api('DELETE', `${t}/messages/${thread.id}`)).status, 404)
  fs.writeFileSync(AGENT_LOG + '.release', 'slow: busy')
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'Echo: busy'))
  assert.ok(!(await api('GET', t)).body.messages.some((m) => m.text === 'never mind'))
})

test('Codex runs through the app-server protocol with approvals and questions', async () => {
  const [project] = (await api('GET', '/projects')).body
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'approve: run', agent: { provider: 'codex', permissionMode: 'default' } })).body
  const t = `/projects/${project.id}/threads/${thread.id}`
  let approval
  await until(async () => (approval = (await api('GET', t)).body.messages.find((m) => m.approval?.status === 'pending')))
  assert.deepEqual(approval.approval.options.map((o) => o.id), ['accept', 'acceptForSession', 'decline'])
  assert.equal((await api('POST', `${t}/approvals/${approval.id}`, { choice: 'nonsense' })).status, 400)
  await api('POST', `${t}/approvals/${approval.id}`, { choice: 'acceptForSession' })
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'Codex permission: acceptForSession'))

  await api('POST', `${t}/messages`, { text: 'ask-native: Which one?' })
  let decision
  await until(async () => (decision = (await api('GET', t)).body.decisions.find((d) => !d.resolved)))
  assert.deepEqual(decision.options, ['Red', 'Blue'])
  await api('POST', `${t}/decisions`, { answers: [{ id: decision.id, selected: 1 }] })
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'Codex answered: Blue'))
  assert.ok((await api('GET', `${t}/activity`)).body.some((a) => a.type === 'command' && a.label === 'echo hi'))
  // A mode the provider does not have is refused, and the project's default agent goes back to Claude.
  assert.equal((await api('POST', `/projects/${project.id}/threads`, { text: 'x', agent: { provider: 'codex', permissionMode: 'bypassPermissions' } })).status, 400)
  await api('PATCH', `/projects/${project.id}`, { agent: project.agent })
})

test('OpenCode runs through the Agent Client Protocol', async () => {
  const [project] = (await api('GET', '/projects')).body
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'hello acp', agent: { provider: 'opencode', model: 'fake/model', reasoning: 'high', permissionMode: 'plan' } })).body
  const t = `/projects/${project.id}/threads/${thread.id}`
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'ACP echo: hello acp'))
  // The effort is a variant of the model, and the context the agent reports is shown.
  assert.ok(agentRuns().some((r) => r.agent === 'opencode' && r['session/set_model'] === 'fake/model/high'))
  await until(async () => (await api('GET', t)).body.thread.context?.tokens === 4200)
  assert.equal((await api('GET', t)).body.thread.context.window, 100000)
  // A side question goes to a fork of the session.
  assert.equal((await api('POST', `${t}/btw`, { text: 'which file?' })).body.text, 'ACP aside: which file?')
  assert.ok(agentRuns().some((r) => r.agent === 'opencode' && r.fork === 'fake-acp-session'))
  await api('POST', `${t}/messages`, { text: 'approve: this' })
  let approval
  await until(async () => (approval = (await api('GET', t)).body.messages.find((m) => m.approval?.status === 'pending')))
  assert.deepEqual(approval.approval.options.map((o) => [o.id, o.kind]), [['allow_once', 'allow'], ['reject_once', 'deny']])
  await api('POST', `${t}/approvals/${approval.id}`, { choice: 'allow_once' })
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'ACP permission: allow_once'))
  // The MCP token travelled inside the protocol, not on the command line.
  const run = fs.readFileSync(AGENT_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.agent === 'opencode' && r.argv)
  assert.deepEqual(run.argv.slice(2), ['acp'])
  await api('PATCH', `/projects/${project.id}`, { agent: project.agent })
})

test('Gemini CLI runs through the Agent Client Protocol', async () => {
  const [project] = (await api('GET', '/projects')).body
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'hello gemini', agent: { provider: 'gemini', permissionMode: 'autoEdit' } })).body
  const t = `/projects/${project.id}/threads/${thread.id}`
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'ACP echo: hello gemini'))
  const run = fs.readFileSync(AGENT_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.agent === 'gemini' && r.argv)
  assert.deepEqual(run.argv.slice(2), ['--acp'])
  await api('PATCH', `/projects/${project.id}`, { agent: project.agent })
})

test('Antigravity continues its conversation with the chosen model, effort and mode, and reaches Savor through MCP', async () => {
  const [project] = (await api('GET', '/projects')).body
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'hello agy', agent: { provider: 'antigravity', model: 'fake-claude', reasoning: 'high', permissionMode: 'plan' } })).body
  const t = `/projects/${project.id}/threads/${thread.id}`
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'Antigravity echo: hello agy'))
  await until(async () => !(await api('GET', t)).body.busy)
  await api('POST', `${t}/messages`, { text: 'again' })
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'Antigravity echo: again'))
  const runs = agentRuns().filter((r) => r.agent === 'antigravity')
  const flag = (r, name) => r.argv[r.argv.indexOf(name) + 1]
  assert.deepEqual([flag(runs[0], '--model'), flag(runs[0], '--effort'), flag(runs[0], '--mode')], ['fake-claude', 'high', 'plan'])
  assert.ok(!runs[0].argv.includes('--conversation'))
  assert.equal(flag(runs[1], '--conversation'), 'fake-agy-conversation')
  // Savor's MCP server is a stdio bridge in agy's config, and the token stays off every command line.
  const config = JSON.parse(fs.readFileSync(path.join(TMP, 'agy', 'config', 'mcp_config.json'), 'utf8'))
  assert.equal(config.mcpServers.savor.command, 'sh')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(TMP, 'agy', 'antigravity-cli', 'settings.json'), 'utf8')).permissions.allow, ['mcp(savor/*)'])
  const { mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  assert.ok(!JSON.stringify([runs, config]).includes(mcpToken))
  const { body } = await api('GET', t)
  assert.equal(body.thread.context.tokens, 12000)
  assert.ok((await api('GET', `${t}/activity`)).body.some((a) => a.type === 'command' && a.label === 'ls'))
  assert.equal((await api('POST', `${t}/btw`, { text: 'which file?' })).body.text, 'Antigravity aside: which file?')
  await until(async () => (await api('GET', '/usage')).body.some((u) => u.provider === 'antigravity'))
  assert.deepEqual((await api('GET', '/usage')).body.find((u) => u.provider === 'antigravity').windows.map((w) => [w.label, w.percent]), [['Weekly · Gemini Models', 25]])
  await api('PATCH', `/projects/${project.id}`, { agent: project.agent })
})

test('the agent list reports what is installed, signed in and offered', async () => {
  const agents = (await api('GET', '/agents')).body
  const by = Object.fromEntries(agents.map((a) => [a.id, a]))
  assert.equal(by.claude.signedIn, true)
  assert.equal(by.claude.account, 'fake@claude.test')
  // Claude's models come from the CLI: "default" is Savor's empty model, and Ultracode sits on top of the effort levels.
  assert.deepEqual(by.claude.models.map((m) => m.id), ['', 'fake-fable[1m]', 'fake-haiku'])
  assert.deepEqual(by.claude.models[1].efforts, ['low', 'high', 'max', 'ultracode'])
  assert.deepEqual(by.claude.models[2].efforts, [])
  assert.ok(by.codex.models.some((m) => m.id === 'fake-model' && m.efforts.includes('high')))
  assert.equal(by.codex.account, 'fake@codex.test')
  assert.deepEqual(by.opencode.models.map((m) => [m.id, m.efforts]), [['fake/model', ['low', 'high']], ['fake/other', []]])
  assert.equal(by.antigravity.signedIn, true)
  assert.deepEqual(by.antigravity.models.map((m) => m.id), ['', 'fake-gemini-high', 'fake-claude'])
  assert.equal(by.grok.installed, false)
  assert.equal(by.gemini.version, '9.9.9')
  assert.ok(by.gemini.modes.find((m) => m.id === 'yolo').unsafe)
  assert.ok(by.claude.modes.find((m) => m.id === 'bypassPermissions').unsafe)
})

test('presets are saved globally and only from this computer', async () => {
  const agent = { provider: 'codex', model: 'fake-model', reasoning: 'high', fast: false, permissionMode: 'read-only' }
  const preset = (await api('POST', '/presets', { name: 'Careful Codex', agent })).body
  assert.deepEqual((await api('GET', '/presets')).body.map((p) => p.name), ['Careful Codex'])
  const pairing = (await api('POST', '/devices/pairing')).body
  const device = (await redeem(pairing.code, 'CI watch')).headers.get('set-cookie').split(';')[0]
  assert.equal((await api('POST', '/presets', { name: 'Sneaky', agent }, device)).status, 403)
  assert.equal((await api('GET', '/presets', undefined, device)).status, 200)
  await api('DELETE', `/presets/${preset.id}`)
  assert.deepEqual((await api('GET', '/presets')).body, [])
  const watch = (await api('GET', '/devices')).body.find((d) => d.name === 'CI watch')
  await api('DELETE', `/devices/${watch.id}`)
})

test('files can be attached to a message', async () => {
  const [project] = (await api('GET', '/projects')).body
  const dataUrl = `data:text/plain;base64,${Buffer.from('hello from a file').toString('base64')}`
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'read this', attachments: [{ name: 'notes.txt', dataUrl }] })).body
  const t = `/projects/${project.id}/threads/${thread.id}`
  const first = (await api('GET', t)).body.messages[0]
  assert.equal(first.files.length, 1)
  assert.match(first.files[0], /^[0-9a-f]{16}-notes\.txt$/)
  // The agent gets the path and can read the file.
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text?.includes('Echo: read this') && m.text.includes(first.files[0])))
  const r = await fetch(`${base}/api${t}/attachments/${first.files[0]}`, { headers: { cookie: `savor_token=${token}` } })
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="notes.txt"')
  assert.equal(await r.text(), 'hello from a file')
  const tooMany = (await api('POST', `${t}/messages`, { text: 'x', attachments: Array(9).fill({ name: 'a.txt', dataUrl }) })).status
  assert.equal(tooMany, 400)
})

test('voice input turns a recording into text in the composer', async () => {
  await newConversation()
  await page.click('.voice button[title="Voice input"]')
  await page.waitForSelector('.voice-time')
  await page.waitForTimeout(1500)
  await page.click('.voice button.recording')
  await page.waitForFunction(() => document.querySelector('.composer textarea').value.includes('Heard'))
  // The browser sent 16 kHz mono 16-bit PCM in its own language, and the daemon cut the audio context to the length.
  const text = await page.inputValue('.composer textarea')
  const [, seconds, context] = text.match(/^Heard (\d+\.\d) seconds, 16000 Hz, 1 channel, 16 bit, language en, audio context (\d+)\. $/) ?? []
  assert.ok(seconds >= 1.4 && seconds < 3, text)
  assert.ok(Math.abs(context - (seconds * 50 + 50)) < 5, text)
  await page.fill('.composer textarea', '')
})

test('voice input discards recordings and releases a microphone granted after navigation', async () => {
  await newConversation()
  await page.fill('.composer textarea', 'Keep this draft')
  await page.click('.voice button[title="Voice input"]')
  await page.waitForSelector('.voice-time')
  await page.click('.voice button[title="Discard the recording"]')
  await page.waitForSelector('.voice-time', { state: 'detached' })
  assert.equal(await page.inputValue('.composer textarea'), 'Keep this draft')
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    window.voiceTracks = null
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints)
      window.voiceTracks = stream.getTracks()
      await new Promise((resolve) => { window.allowVoice = resolve })
      return stream
    }
  })
  await page.click('.voice button[title="Voice input"]')
  await page.waitForFunction(() => window.allowVoice)
  await page.locator('a.card').first().click()
  await page.waitForSelector('text=What do you want to build?', { state: 'detached' })
  await page.evaluate(() => window.allowVoice())
  await page.waitForFunction(() => window.voiceTracks.every((track) => track.readyState === 'ended'))
  await page.reload()
})

test('voice input rejects missing or incomplete PCM', async () => {
  for (const audio of [undefined, '', 'AQ==']) {
    assert.equal((await api('POST', '/voice/transcribe', { audio })).status, 400)
  }
})

test('deleting a conversation whose agent session is still open leaves the daemon running', async () => {
  const [project] = (await api('GET', '/projects')).body
  const t = `/projects/${project.id}/threads`
  // One with an idle session after its turn, one deleted in the middle of a turn.
  const idle = (await api('POST', t, { text: 'delete me' })).body
  await until(async () => (await api('GET', `${t}/${idle.id}`)).body.messages.some((m) => m.text === 'Echo: delete me'))
  const working = (await api('POST', t, { text: 'slow: delete me too' })).body
  await until(async () => (await api('GET', `${t}/${working.id}`)).body.messages.some((m) => m.text === 'On it.'))
  // The acknowledgement brings the summary the list shows.
  assert.equal((await api('GET', `${t}/${working.id}`)).body.thread.summary, 'Work on the request.')
  assert.equal((await api('DELETE', `${t}/${idle.id}`)).status, 200)
  assert.equal((await api('DELETE', `${t}/${working.id}`)).status, 200)
  // The sessions end a moment later; the daemon has to survive that.
  await new Promise((r) => setTimeout(r, 1000))
  assert.equal((await api('GET', '/me')).status, 200)
  assert.equal((await api('GET', `${t}/${idle.id}`)).status, 404)
  assert.equal((await api('GET', '/projects')).body.find((p) => p.id === project.id).counts.working, 0)
})

test('workflows run in a new conversation', async () => {
  const [project] = (await api('GET', '/projects')).body
  const wf = (await api('POST', `/projects/${project.id}/workflows`, { name: 'Nightly', prompt: 'nightly check', cron: '0 3 * * *' })).body
  assert.match(wf.id, /^[0-9a-f]{16}$/)
  assert.equal((await api('POST', `/projects/${project.id}/workflows`, { name: 'Bad', prompt: 'x', cron: 'not a cron' })).status, 400)
  const w = `/projects/${project.id}/workflows/${wf.id}`
  const labelled = (await api('PUT', w, { collection: 'Night', scheduleLabel: 'Every night at three' })).body
  assert.deepEqual([labelled.collection, labelled.scheduleLabel], ['Night', 'Every night at three'])
  const thread = (await api('POST', `${w}/run`)).body
  await page.goto(`${base}/#/p/${project.id}/t/${thread.id}`)
  await page.waitForSelector('text=Echo: Run workflow')
  // A run is not an edit.
  const ran = (await api('GET', `/projects/${project.id}/workflows`)).body.find((x) => x.id === wf.id)
  assert.ok(ran.lastRunAt)
  assert.equal(ran.updatedAt, labelled.updatedAt)

  // The list groups workflows by collection and shows the schedule in the words it was given.
  await page.goto(`${base}/#/p/${project.id}/workflows`)
  await page.waitForSelector('.side-list .menu-label:has-text("Night")')
  await page.waitForSelector('.side-list .card:has-text("Nightly") >> text=Every night at three')

  // An agent updates the workflow it read: an edit made in between is not overwritten.
  const { mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const client = new Client({ name: 'e2e', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?project=${project.id}&thread=${thread.id}`), { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
  const read = async () => JSON.parse((await client.callTool({ name: 'read_workflow', arguments: { id: wf.id } })).content[0].text)
  const { revision } = await read()
  // The label described the old schedule and goes with it.
  assert.equal((await api('PUT', w, { cron: '0 4 * * *' })).body.scheduleLabel, null)
  assert.equal((await client.callTool({ name: 'update_workflow', arguments: { id: wf.id, revision, prompt: 'stale' } })).isError, true)
  assert.ok(!(await client.callTool({ name: 'update_workflow', arguments: { id: wf.id, revision: (await read()).revision, prompt: 'nightly check, thoroughly' } })).isError)
  const saved = await read()
  await client.close()
  assert.deepEqual([saved.prompt, saved.cron], ['nightly check, thoroughly', '0 4 * * *'])
})

test('a workflow runs at the first scheduled time after it was saved', async () => {
  const [project] = (await api('GET', '/projects')).body
  const wf = (await api('POST', `/projects/${project.id}/workflows`, { name: 'Every five', prompt: 'every five', cron: '*/5 * * * * *' })).body
  const first = Math.floor(Date.parse(wf.settledAt) / 5000) * 5000 + 5000
  let run
  await until(async () => (run = (await api('GET', `/projects/${project.id}/threads`)).body.find((t) => t.title === 'Every five')), 15_000)
  await api('PUT', `/projects/${project.id}/workflows/${wf.id}`, { enabled: false })
  assert.ok(Date.parse(run.createdAt) < first + 1000, `ran at ${run.createdAt}, due at ${new Date(first).toISOString()}`)
})

test('a workflow lists its runs, catches up a missed time and skips one while a run is open', async () => {
  const [project] = (await api('GET', '/projects')).body
  const list = `/projects/${project.id}/workflows`
  // Due once a year, so the test decides when a scheduled time counts as missed.
  const wf = (await api('POST', list, { name: 'Yearly', prompt: 'yearly check', cron: '0 0 1 1 *' })).body
  const w = `${list}/${wf.id}`
  const file = path.join(PROJECT, '.savor/workflows', `${wf.id}.json`)
  const runs = async () => (await api('GET', `${w}/runs`)).body
  const threadFile = (id) => path.join(PROJECT, '.savor/threads', id, 'thread.json')
  const patchFile = (f, patch) => fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch }))
  // Savor was not running at the last scheduled time: what it had settled lies before it. Any save looks at the schedules again.
  const miss = async (name) => {
    patchFile(file, { settledAt: '2000-01-01T00:00:00.000Z' })
    await api('PUT', w, { name })
  }
  assert.deepEqual(await runs(), [])

  const manual = (await api('POST', `${w}/run`)).body
  await until(async () => (await runs())[0].status === 'finished')
  let all = await runs()
  assert.deepEqual([all[0].trigger, all[0].threadId, all[0].summary], ['manual', manual.id, 'Echo: Run workflow “Yearly”: yearly check'])
  assert.ok(all[0].workedMs >= 0)

  // The missed time is caught up once, as a run of its own kind that knows when it was due.
  await miss('Yearly check')
  await until(async () => (await runs()).length === 2 && (await runs())[0].status === 'finished')
  all = await runs()
  assert.equal(all[0].trigger, 'caught')
  assert.ok(Date.parse(all[0].due) < Date.now() - 60_000)
  const caught = all[0].threadId
  assert.deepEqual((await api('GET', `/projects/${project.id}/threads/${caught}`)).body.thread.workflow, { id: wf.id, name: 'Yearly check', trigger: 'caught', due: all[0].due })

  // While a run waits for an answer, the next scheduled time is skipped and points at that run.
  patchFile(threadFile(caught), { needsYou: true })
  await miss('Yearly')
  all = await runs()
  assert.deepEqual([all.length, all[0].status, all.find((r) => r.status === 'skipped').threadId], [3, 'needs', caught])
  // The list shows the run that is open, not the time skipped after it.
  assert.deepEqual((await api('GET', list)).body.find((x) => x.id === wf.id).lastRun.status, 'needs')
  patchFile(threadFile(caught), { needsYou: false })

  // A workflow that does not catch up lets the missed time pass.
  await api('PUT', w, { catchUp: false })
  await miss('Yearly')
  assert.equal((await runs()).length, 3)
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).settledAt, '2000-01-01T00:00:00.000Z')

  // The workflow opens on its runs; a run opens its conversation, which starts with the workflow instead of a typed message.
  await page.goto(`${base}/#/p/${project.id}/workflows/${wf.id}`)
  await page.waitForSelector('.wf-over h1:has-text("Yearly")')
  await page.waitForSelector('.side-list .card:has-text("Yearly") .last-run:has-text("Finished")')
  await page.waitForSelector('.run.skipped >> text=was still open')
  await page.click('.run.finished:has-text("Caught up")')
  await page.waitForSelector('.wf-chip:has-text("Yearly check") >> text=Caught up')
  assert.equal(await page.locator('.msg.user').count(), 0)
  await page.click('.wf-chip')
  await page.waitForSelector('.wf-chip-body >> text=yearly check')
  await page.click('.wf-chip-body a')
  await page.waitForSelector('.wf-over')
  // Editing is one step away, and leads back.
  await page.click('.wf-actions a')
  await page.waitForSelector('.form')
  assert.equal(await page.isChecked('.form label.with-hint input'), false)
  await page.click('.back-link')
  await page.waitForSelector('.wf-over')
})

test('auth: tokens, pairing and remote limits', async () => {
  assert.equal((await api('GET', '/projects', undefined, '')).status, 401)
  const pair = (body) => fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const pairing = (await api('POST', '/devices/pairing')).body
  const other = (await api('POST', '/devices/pairing')).body
  assert.equal((await pair({ code: pairing.code, name: 'no check' })).status, 400)
  const paired = await redeem(pairing.code, 'CI phone')
  assert.equal(paired.status, 200)
  const device = paired.headers.get('set-cookie').split(';')[0]
  assert.equal((await api('GET', '/me', undefined, device)).body.origin, 'remote')
  assert.equal((await api('POST', '/devices/pairing', undefined, device)).status, 403)
  assert.equal((await api('GET', '/devices/requests', undefined, device)).status, 403)
  // Allowing a device voids every other open code.
  assert.equal((await pair({ code: other.code, name: 'late', check: '000000' })).status, 400)
  // A declined request spends its code and adds no device.
  const declined = await redeem((await api('POST', '/devices/pairing')).body.code, 'CI stranger', false)
  assert.equal(declined.status, 403)
  assert.ok(!declined.headers.get('set-cookie'))
  assert.ok(!(await api('GET', '/devices')).body.some((d) => d.name === 'CI stranger'))
  assert.equal((await api('POST', '/projects', { path: '/' }, device)).status, 403)
  // Pairing links use the address set for direct connections, which only this computer can change.
  assert.equal((await api('PUT', '/devices/address', { url: 'https://evil.example' }, device)).status, 403)
  assert.equal((await api('PUT', '/devices/address', { url: 'ftp://x' })).status, 400)
  assert.equal((await api('PUT', '/devices/address', { url: 'https://desk.tailnet.example/' })).body.url, 'https://desk.tailnet.example')
  assert.match((await api('POST', '/devices/pairing')).body.url, /^https:\/\/desk\.tailnet\.example\/#\/pair\/[0-9A-F]{10}$/)
  assert.equal((await api('PUT', '/devices/address', { url: '' })).body.url, null)
  assert.ok((await api('POST', '/devices/pairing')).body.url.startsWith('http://localhost:'))
  assert.equal((await pair({ code: pairing.code, name: 'x', check: '000000' })).status, 400)

  // Revoking a LAN device ends its open event stream right away, not only its next request.
  const events = await fetch(`${base}/api/events`, { headers: { cookie: device } })
  const reader = events.body.getReader()
  await reader.read()
  const phone = (await api('GET', '/devices')).body.find((d) => d.name === 'CI phone')
  await api('DELETE', `/devices/${phone.id}`)
  const outcome = await Promise.race([
    (async () => {
      for (;;) if ((await reader.read()).done) return 'ended'
    })().catch(() => 'ended'),
    new Promise((resolve) => setTimeout(() => resolve('still open'), 3000)),
  ])
  assert.equal(outcome, 'ended')
  assert.equal((await api('GET', '/me', undefined, device)).status, 401)
})

test('the MCP token stays off agent command lines, which every user on the machine can read', async () => {
  const [project] = (await api('GET', '/projects')).body
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'hello codex', agent: { provider: 'codex' } })).body
  await until(async () => (await api('GET', `/projects/${project.id}/threads/${thread.id}`)).body.messages.some((m) => m.text === 'Codex echo: hello codex'))
  await api('PATCH', `/projects/${project.id}`, { agent: project.agent })

  const { mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const runs = fs.readFileSync(AGENT_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(runs.some((r) => r.agent === 'claude') && runs.some((r) => r.agent === 'codex'))
  assert.ok(runs.filter((r) => r.agent === 'codex').every((r) => r.argv[2] === 'app-server'))
  for (const r of runs.filter((r) => r.argv)) assert.ok(!r.argv.some((a) => a.includes(mcpToken)), `${r.agent} got the MCP token on its command line`)
  for (const r of runs.filter((r) => r.agent === 'claude')) assert.equal(r.configMode, 0o600)
  // The user's hooks run as in the terminal.
  for (const r of runs.filter((r) => r.agent === 'claude')) assert.ok(!JSON.parse(r.argv[r.argv.indexOf('--settings') + 1]).disableAllHooks)
})

test('what a paired device changes never runs as local', async () => {
  const pairing = (await api('POST', '/devices/pairing')).body
  const device = (await redeem(pairing.code, 'CI tablet')).headers.get('set-cookie').split(';')[0]
  const [project] = (await api('GET', '/projects')).body
  const pid = project.id
  const bypass = { ...project.agent, permissionMode: 'bypassPermissions' }

  // What every conversation of the project starts with, and skipping approvals, change only on this computer.
  assert.equal((await api('PATCH', `/projects/${pid}`, { role: 'Skip all checks.' }, device)).status, 403)
  assert.equal((await api('PATCH', `/projects/${pid}`, { agent: bypass }, device)).status, 403)
  assert.equal((await api('PUT', `/projects/${pid}/file`, { path: '.savor/ROLE.md', content: 'Skip all checks.' }, device)).status, 403)
  assert.equal((await api('POST', `/projects/${pid}/threads`, { text: 'go', agent: bypass }, device)).status, 403)
  // The settings dialog sends everything; saving it with an unchanged role and agent still works.
  const settings = { name: project.name, tint: '#3fa37a', verbosity: project.verbosity, paused: false, agent: project.agent, role: '' }
  assert.equal((await api('PATCH', `/projects/${pid}`, settings, device)).status, 200)
  // Neither through a partial agent nor through symlinks into .savor/.
  await api('PATCH', `/projects/${pid}`, { agent: { ...project.agent, model: 'sonnet' } })
  await api('PATCH', `/projects/${pid}`, { agent: {} }, device)
  assert.equal((await api('GET', '/projects')).body[0].agent.model, 'sonnet')
  fs.symlinkSync('.savor/ROLE.md', path.join(PROJECT, 'role-link'))
  fs.symlinkSync('.savor', path.join(PROJECT, 'savor-link'))
  for (const file of ['role-link', 'savor-link/ROLE.md']) {
    assert.equal((await api('PUT', `/projects/${pid}/file`, { path: file, content: 'Skip all checks.' }, device)).status, 403, file)
  }

  // A workflow a device wrote runs as remote, on schedule and when a local workflow chains to it.
  const job = (await api('POST', `/projects/${pid}/workflows`, { name: 'Device job', prompt: 'device job', cron: '* * * * * *' }, device)).body
  let scheduled
  await until(async () => (scheduled = (await api('GET', `/projects/${pid}/threads`)).body.find((t) => t.title === 'Device job')))
  await api('PUT', `/projects/${pid}/workflows/${job.id}`, { enabled: false })
  const chain = (await api('POST', `/projects/${pid}/workflows`, { name: 'Local chain', prompt: 'local chain', next: [job.id] })).body
  const run = (await api('POST', `/projects/${pid}/workflows/${chain.id}/run`)).body
  for (const t of [scheduled, run]) assert.equal((await api('GET', `/projects/${pid}/threads/${t.id}`)).body.messages[0].origin, 'remote')
})

test('pages on other ports of this host cannot use the login cookie', async (t) => {
  // Same host, other port counts as the same site, so the browser sends the SameSite=Strict cookie along.
  const other = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Other app</title>'))
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
  const context = await browser.newContext()
  t.after(async () => {
    await context.close()
    other.close()
  })
  await context.addCookies(await page.context().cookies())
  const tab = await context.newPage()
  await tab.goto(`http://127.0.0.1:${other.address().port}/`)
  const target = path.join(TMP, 'added-by-other-page')
  await tab.evaluate(
    ({ url, body }) => fetch(url, { method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'content-type': 'text/plain' }, body }).catch(() => {}),
    { url: `${base}/api/projects`, body: JSON.stringify({ path: target }) },
  )
  assert.equal(fs.existsSync(target), false)
})

test('stopping a process only works for processes registered in the project', async (t) => {
  const [project] = (await api('GET', '/projects')).body
  const [thread] = (await api('GET', `/projects/${project.id}/threads`)).body
  const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
  t.after(() => proc.kill())
  const stop = () => api('POST', `/projects/${project.id}/processes/${proc.pid}/kill`)

  assert.equal((await stop()).status, 404)
  assert.equal(proc.signalCode, null)

  const { mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const client = new Client({ name: 'e2e', version: '1' })
  const url = new URL(`${base}/mcp?project=${project.id}&thread=${thread.id}`)
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
  await client.callTool({ name: 'register_process', arguments: { pid: proc.pid, name: 'idle node', command: 'node -e …' } })
  await client.close()

  assert.equal((await stop()).status, 200)
  await until(() => proc.signalCode === 'SIGTERM')
})

const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=Test', ...args], { cwd, stdio: 'pipe' }).toString().trim()
const agentRuns = () => fs.readFileSync(AGENT_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
async function pairDevice(name) {
  const pairing = (await api('POST', '/devices/pairing')).body
  return (await redeem(pairing.code, name)).headers.get('set-cookie').split(';')[0]
}

test('a paired device keeps its push subscription until it is revoked', async () => {
  assert.equal((await api('GET', '/push')).body.publicKey, null)
  assert.equal((await api('PUT', '/push', { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } })).status, 403)
  const device = await pairDevice('CI push phone')
  assert.match((await api('GET', '/push', undefined, device)).body.publicKey, /^B[A-Za-z0-9_-]{86}$/)
  assert.equal((await api('PUT', '/push', { endpoint: 'http://127.0.0.1:1/x', keys: { p256dh: 'a', auth: 'b' } }, device)).status, 400)
  assert.equal((await api('PUT', '/push', { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } }, device)).status, 200)
  assert.equal((await api('POST', '/push/visible', { visible: true }, device)).status, 200)
  const stateFile = path.join(HOME, 'state.json')
  assert.ok(fs.readFileSync(stateFile, 'utf8').includes('https://push.example/x'))
  assert.ok(!JSON.stringify((await api('GET', '/devices')).body).includes('push.example'))
  const paired = (await api('GET', '/devices')).body.find((d) => d.name === 'CI push phone')
  await api('DELETE', `/devices/${paired.id}`)
  assert.ok(!fs.readFileSync(stateFile, 'utf8').includes('https://push.example/x'))
})

test('a conversation can work in its own git worktree, which merges back and can be deleted', async () => {
  const [project] = (await api('GET', '/projects')).body
  gitIn(PROJECT, 'init', '-q', '-b', 'main')
  gitIn(PROJECT, 'commit', '-q', '--allow-empty', '-m', 'init')
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'hello worktree', worktree: 'feature/wt' })).body
  const t = `/projects/${project.id}/threads/${thread.id}`
  assert.equal(thread.worktree.branch, 'feature/wt')
  assert.ok(thread.worktree.path.startsWith(path.join(HOME, 'worktrees', project.id) + path.sep))
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'Echo: hello worktree'))
  // The agent ran inside the worktree, and git in the conversation means git in the worktree.
  assert.equal(fs.realpathSync(agentRuns().filter((r) => r.agent === 'claude').at(-1).cwd), fs.realpathSync(thread.worktree.path))
  assert.equal((await api('GET', `/projects/${project.id}/git?thread=${thread.id}`)).body.branch, 'feature/wt')
  assert.equal((await api('GET', `/projects/${project.id}/git`)).body.branch, 'main')
  let [wt] = (await api('GET', `/projects/${project.id}/worktrees`)).body
  assert.deepEqual([wt.branch, wt.ahead, wt.dirty], ['feature/wt', 0, false])
  // A second conversation on the same branch shares the worktree.
  const sibling = (await api('POST', `/projects/${project.id}/threads`, { text: 'more', worktree: 'feature/wt' })).body
  assert.equal(sibling.worktree.path, wt.path)
  assert.equal((await api('POST', `/projects/${project.id}/threads`, { text: 'x', worktree: 'not a branch' })).status, 400)

  fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'hello\n')
  gitIn(wt.path, 'add', '.')
  gitIn(wt.path, 'commit', '-q', '-m', 'add feature')
  wt = (await api('GET', `/projects/${project.id}/worktrees`)).body[0]
  assert.equal(wt.ahead, 1)
  const hash = gitIn(wt.path, 'rev-parse', 'HEAD')
  const commit = (await api('GET', `/projects/${project.id}/git/commits/${hash}?thread=${thread.id}`)).body
  assert.equal(commit.subject, 'add feature')
  assert.deepEqual(commit.files.map((f) => [f.path, f.additions, f.deletions]), [['feature.txt', 1, 0]])
  assert.ok(commit.files[0].patch.includes('+hello'))
  assert.equal((await api('GET', `/projects/${project.id}/git/commits/nothash`)).status, 400)

  // Changes: uncommitted edits with new files, and everything since the worktree branched off.
  fs.appendFileSync(path.join(wt.path, 'feature.txt'), 'more\n')
  fs.writeFileSync(path.join(wt.path, 'new file.txt'), 'fresh\n')
  const uncommitted = (await api('GET', `/projects/${project.id}/git/changes?thread=${thread.id}`)).body
  assert.deepEqual(uncommitted.map((f) => [f.path, f.additions, f.deletions]), [['feature.txt', 1, 0], ['new file.txt', 1, 0]])
  const sinceBase = (await api('GET', `/projects/${project.id}/git/changes?thread=${thread.id}&against=base`)).body
  assert.deepEqual(sinceBase.map((f) => [f.path, f.additions]), [['feature.txt', 2], ['new file.txt', 1]])
  assert.ok(sinceBase[0].patch.includes('+hello\n+more'))

  await page.goto(`${base}/#/p/${project.id}`)
  await page.waitForSelector('.wt-head >> text=feature/wt')
  await page.waitForSelector('.wt-head >> text=1 commit ahead')
  await page.goto(`${base}/#${t.replace('/projects/', '/p/').replace('/threads/', '/t/')}`)
  await page.waitForSelector('.status.worktree >> text=feature/wt')

  // Line comments on the changes are kept with the conversation and go to the agent with the next message.
  await page.click('.modes button[title="Changes"]')
  const newFile = page.locator('.diff-file', { hasText: 'new file.txt' })
  await newFile.locator('.gutter').first().click()
  await page.fill('.review-box textarea', 'Say hi instead')
  await page.click('.review-box >> text=Add comment')
  await page.waitForSelector('.chip-ctx >> text=new file.txt:1')
  await newFile.locator('.review-text >> text=Say hi instead').waitFor()
  assert.equal((await api('GET', `${t}/review`)).body.length, 1)
  await page.click('.thread .composer button.send[title="Send"]')
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.kind === 'user' && m.text.includes('new file.txt:1\n```diff\n+fresh\n```\nSay hi instead')))
  await until(async () => (await api('GET', `${t}/review`)).body.length === 0)

  assert.equal((await api('POST', `/projects/${project.id}/worktrees/merge`, { path: wt.path })).status, 200)
  assert.equal(fs.readFileSync(path.join(PROJECT, 'feature.txt'), 'utf8'), 'hello\n')
  assert.equal((await api('GET', `/projects/${project.id}/worktrees`)).body[0].ahead, 0)

  // Deleting is for this computer only. Afterwards the conversations continue in the project folder with a fresh session.
  const device = await pairDevice('CI laptop')
  assert.equal((await api('DELETE', `/projects/${project.id}/worktrees?path=${encodeURIComponent(wt.path)}`, undefined, device)).status, 403)
  assert.equal((await api('DELETE', `/projects/${project.id}/worktrees?path=${encodeURIComponent(wt.path)}`)).status, 200)
  assert.equal((await api('GET', `/projects/${project.id}/worktrees`)).body.length, 0)
  assert.ok(!fs.existsSync(wt.path))
  assert.ok(!gitIn(PROJECT, 'branch', '--list', 'feature/wt'))
  const after = (await api('GET', t)).body.thread
  assert.deepEqual([after.worktree, after.completed, after.agentSessions], [null, true, []])
  await api('POST', `${t}/messages`, { text: 'back home' })
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'Echo: back home'))
  assert.equal(fs.realpathSync(agentRuns().filter((r) => r.agent === 'claude').at(-1).cwd), fs.realpathSync(PROJECT))
})

test('agents can start conversations in a worktree', async () => {
  const [project] = (await api('GET', '/projects')).body
  const [thread] = (await api('GET', `/projects/${project.id}/threads`)).body
  const { mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const client = new Client({ name: 'e2e', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?project=${project.id}&thread=${thread.id}`), { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
  await client.callTool({ name: 'start_conversation', arguments: { prompt: 'child work', worktree: 'agent/child' } })
  await client.close()
  const child = (await api('GET', `/projects/${project.id}/threads`)).body.find((t) => t.title === 'child work')
  assert.equal(child.worktree.branch, 'agent/child')
  await until(async () => (await api('GET', `/projects/${project.id}/threads/${child.id}`)).body.messages.some((m) => m.text === 'Echo: child work'))
  assert.equal(fs.realpathSync(agentRuns().filter((r) => r.agent === 'claude').at(-1).cwd), fs.realpathSync(child.worktree.path))
  await api('DELETE', `/projects/${project.id}/worktrees?path=${encodeURIComponent(child.worktree.path)}`)
})

test('a new worktree gets the files .worktreeinclude names, and its first turn waits for the project setup', async () => {
  const [project] = (await api('GET', '/projects')).body
  const p = `/projects/${project.id}`
  fs.writeFileSync(path.join(PROJECT, '.gitignore'), '.env\nsecret/\n')
  fs.writeFileSync(path.join(PROJECT, '.worktreeinclude'), '.env\nsecret/\nnotes.local\n')
  gitIn(PROJECT, 'add', '.gitignore', '.worktreeinclude')
  gitIn(PROJECT, 'commit', '-q', '-m', 'ignore secrets')
  fs.writeFileSync(path.join(PROJECT, '.env'), 'KEY=main\n')
  fs.mkdirSync(path.join(PROJECT, 'secret'))
  fs.writeFileSync(path.join(PROJECT, 'secret', 'token.txt'), 'abc\n')
  fs.writeFileSync(path.join(PROJECT, 'notes.local'), 'not ignored, so not copied\n')
  const threadIn = async (body) => {
    const t = (await api('POST', `${p}/threads`, body)).body
    return { ...t, url: `${p}/threads/${t.id}` }
  }
  const conclusion = async (t) => {
    await until(async () => (await api('GET', t.url)).body.messages.some((m) => m.kind === 'conclusion'))
    return (await api('GET', t.url)).body.messages.find((m) => m.kind === 'conclusion').text
  }

  // The setup command is a shell command on this computer: a paired device can't set it.
  const device = await pairDevice('CI setup phone')
  assert.equal((await api('PATCH', p, { worktreeSetup: 'true' }, device)).status, 403)
  await api('PATCH', p, { worktreeSetup: 'sleep 1; echo "$SAVOR_ROOT_PATH" > setup.txt; cat .env' })
  const ok = await threadIn({ text: 'note: set up', worktree: 'setup/ok' })
  assert.equal(await conclusion(ok), "Note: Savor ran the project's worktree setup `sleep 1; echo \"$SAVOR_ROOT_PATH\" > setup.txt; cat .env` in this new worktree, and it succeeded.")
  const wt = ok.worktree.path
  assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'KEY=main\n')
  assert.equal(fs.readFileSync(path.join(wt, 'secret', 'token.txt'), 'utf8'), 'abc\n')
  assert.ok(!fs.existsSync(path.join(wt, 'notes.local')))
  assert.equal(fs.readFileSync(path.join(wt, 'setup.txt'), 'utf8').trim(), PROJECT)
  assert.equal(fs.readFileSync(`${wt}.setup.log`, 'utf8'), 'KEY=main\n')
  assert.ok((await api('GET', `${ok.url}/activity`)).body.some((e) => e.label === 'Worktree setup · sleep 1; echo "$SAVOR_ROOT_PATH" > setup.txt; cat .env' && e.finishedAt))

  // A failed setup still starts the turn, and the agent gets the end of its output.
  await api('PATCH', p, { worktreeSetup: 'echo cannot install >&2; exit 3' })
  const failed = await threadIn({ text: 'note: set up', worktree: 'setup/failed' })
  const note = await conclusion(failed)
  assert.ok(note.startsWith("Note: The project's worktree setup `echo cannot install >&2; exit 3` failed in this new worktree (exit code 3)."), note)
  assert.ok(note.includes(`all of it is in ${failed.worktree.path}.setup.log:\ncannot install\n`), note)

  // Stop works while the turn waits for the setup.
  await api('PATCH', p, { worktreeSetup: 'sleep 5' })
  const stopped = await threadIn({ text: 'note: never', worktree: 'setup/stopped' })
  assert.equal((await api('GET', stopped.url)).body.busy, true)
  await api('POST', `${stopped.url}/stop`)
  await until(async () => !(await api('GET', stopped.url)).body.busy)
  assert.ok((await api('GET', stopped.url)).body.messages.some((m) => m.kind === 'error' && m.text === 'Turn stopped.'))

  await api('PATCH', p, { worktreeSetup: '' })
  for (const t of [ok, failed, stopped]) await api('DELETE', `${p}/worktrees?path=${encodeURIComponent(t.worktree.path)}`)
  assert.ok(!fs.existsSync(`${wt}.setup.log`))
})

test('agents can start conversations in other projects, and input from a paired device stays visible there', async () => {
  const [project] = (await api('GET', '/projects')).body
  const folder = path.join(TMP, 'design-target')
  const other = (await api('POST', '/projects', { path: folder, name: 'Design Target', create: true })).body
  await api('PATCH', `/projects/${other.id}`, { agent: { provider: 'claude', model: 'design-model', reasoning: 'high', fast: false, permissionMode: 'acceptEdits' } })
  const { mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const connect = async (thread) => {
    const client = new Client({ name: 'e2e', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?project=${project.id}&thread=${thread.id}`), { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
    return client
  }
  const call = async (client, name, args) => {
    const r = await client.callTool({ name, arguments: args })
    return { isError: !!r.isError, text: r.content[0].text }
  }
  const childIn = async (pid, title) => {
    let child
    await until(async () => (child = (await api('GET', `/projects/${pid}/threads`)).body.find((t) => t.title === title)))
    await until(async () => (await api('GET', `/projects/${pid}/threads/${child.id}`)).body.messages.some((m) => m.text === `Echo: ${title}`))
    return { ...child, messages: (await api('GET', `/projects/${pid}/threads/${child.id}`)).body.messages }
  }

  // The agent learns the projects, an unknown one fails with the list, and a path works like the id.
  const [thread] = (await api('GET', `/projects/${project.id}/threads`)).body
  const client = await connect(thread)
  assert.ok(JSON.parse((await call(client, 'list_projects', {})).text).some((p) => p.id === other.id && p.name === 'Design Target'))
  const unknown = await call(client, 'start_conversation', { prompt: 'lost', project: 'nope' })
  assert.ok(unknown.isError && unknown.text.includes(other.id), unknown.text)
  const started = JSON.parse((await call(client, 'start_conversation', { prompt: 'design session', project: folder })).text)
  await client.close()
  assert.equal(started.project, other.id)
  assert.ok(started.url.endsWith(`/p/${other.id}/t/${started.id}`), started.url)
  const child = await childIn(other.id, 'design session')
  assert.equal(child.id, started.id)
  assert.equal(child.parentId, undefined)
  assert.equal(child.worktree, undefined)
  assert.equal(child.messages[0].origin, 'local')
  // Without agent settings it gets that project's default agent; agent settings change only what they name.
  assert.equal(child.agent.model, 'design-model')
  assert.equal(fs.realpathSync(agentRuns().filter((r) => r.agent === 'claude').at(-1).cwd), fs.realpathSync(folder))
  assert.ok(!(await api('GET', `/projects/${project.id}/threads`)).body.some((t) => t.title === 'design session'))

  // Started from a paired device's input, the conversation there says which device it came from.
  const device = await pairDevice('CI design phone')
  const remote = (await api('POST', `/projects/${project.id}/threads`, { text: 'plan the designs' }, device)).body
  await until(async () => (await api('GET', `/projects/${project.id}/threads/${remote.id}`)).body.messages.some((m) => m.text === 'Echo: plan the designs'))
  const remoteClient = await connect(remote)
  await call(remoteClient, 'start_conversation', { prompt: 'remote design session', project: other.id, agent: { provider: 'claude', reasoning: 'low' } })
  await remoteClient.close()
  const fromPhone = await childIn(other.id, 'remote design session')
  assert.deepEqual([fromPhone.messages[0].origin, fromPhone.messages[0].device], ['remote', 'CI design phone'])
  assert.deepEqual([fromPhone.agent.model, fromPhone.agent.reasoning], ['design-model', 'low'])

  await api('DELETE', `/devices/${(await api('GET', '/devices')).body.find((d) => d.name === 'CI design phone').id}`)
  await api('DELETE', `/projects/${other.id}`)
})

test('agents add projects: a new folder gets a git repository, an existing project stays the same, paired devices cannot', async () => {
  const [project] = (await api('GET', '/projects')).body
  const { mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const connect = async (thread) => {
    const client = new Client({ name: 'e2e', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?project=${project.id}&thread=${thread.id}`), { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
    return client
  }
  const call = async (client, name, args) => {
    const r = await client.callTool({ name, arguments: args })
    return { isError: !!r.isError, text: r.content[0].text }
  }
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'add a project' })).body
  await until(async () => (await api('GET', `/projects/${project.id}/threads/${thread.id}`)).body.messages.some((m) => m.text === 'Echo: add a project'))
  const client = await connect(thread)
  const folder = path.join(TMP, 'agent-made')
  const made = JSON.parse((await call(client, 'create_project', { path: folder, name: 'Agent Made' })).text)
  assert.deepEqual([made.name, made.path], ['Agent Made', folder])
  assert.ok(fs.existsSync(path.join(folder, '.git')))
  assert.ok((await api('GET', '/projects')).body.some((p) => p.id === made.id))
  assert.equal(JSON.parse((await call(client, 'create_project', { path: folder })).text).id, made.id)
  assert.ok((await call(client, 'create_project', { path: 'relative/dir' })).isError)
  await client.close()

  const device = await pairDevice('CI project phone')
  const remote = (await api('POST', `/projects/${project.id}/threads`, { text: 'make a project' }, device)).body
  await until(async () => (await api('GET', `/projects/${project.id}/threads/${remote.id}`)).body.messages.some((m) => m.text === 'Echo: make a project'))
  const remoteClient = await connect(remote)
  const refused = await call(remoteClient, 'create_project', { path: path.join(TMP, 'phone-made') })
  await remoteClient.close()
  assert.ok(refused.isError && !fs.existsSync(path.join(TMP, 'phone-made')), refused.text)

  await api('DELETE', `/devices/${(await api('GET', '/devices')).body.find((d) => d.name === 'CI project phone').id}`)
  await api('DELETE', `/projects/${made.id}`)
})

test('agents send messages to conversations in other projects, marked as theirs, and a message they set off sends none on', async () => {
  const [project] = (await api('GET', '/projects')).body
  const other = (await api('POST', '/projects', { path: path.join(TMP, 'message-target'), name: 'Message Target', create: true })).body
  const { mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const connect = async (pid, tid) => {
    const client = new Client({ name: 'e2e', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?project=${pid}&thread=${tid}`), { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
    return client
  }
  const call = async (client, name, args) => {
    const r = await client.callTool({ name, arguments: args })
    return { isError: !!r.isError, text: r.content[0].text }
  }
  const messages = async (pid, tid) => (await api('GET', `/projects/${pid}/threads/${tid}`)).body.messages
  const echoed = (pid, tid, text) => until(async () => (await messages(pid, tid)).some((m) => m.text === `Echo: ${text}`))

  const sender = (await api('POST', `/projects/${project.id}/threads`, { text: 'plan the starter' })).body
  await echoed(project.id, sender.id, 'plan the starter')
  const target = (await api('POST', `/projects/${other.id}/threads`, { text: 'design work' })).body
  await echoed(other.id, target.id, 'design work')

  // The sender finds the conversation in the other project and writes to it; the receiving agent learns who wrote.
  const client = await connect(project.id, sender.id)
  assert.ok(JSON.parse((await call(client, 'list_conversations', { project: other.id })).text).some((t) => t.id === target.id))
  assert.ok((await call(client, 'send_to_conversation', { id: sender.id, text: 'me' })).isError)
  const sent = JSON.parse((await call(client, 'send_to_conversation', { id: target.id, project: other.id, text: 'context: the starter has a new sender' })).text)
  assert.ok(sent.url.endsWith(`/p/${other.id}/t/${target.id}`), sent.url)
  let reply
  await until(async () => (reply = (await messages(other.id, target.id)).find((m) => m.text?.startsWith('Context: '))))
  const context = JSON.parse(reply.text.slice('Context: '.length))
  assert.equal(context.requestOrigin, 'agent')
  assert.deepEqual([context.fromThread.project, context.fromThread.id, context.fromThread.label, context.fromThread.origin], [project.id, sender.id, 'Fake agent test', 'local'])
  const read = JSON.parse((await call(client, 'read_conversation', { id: target.id, project: other.id })).text)
  assert.deepEqual(read.messages.find((m) => m.text === 'context: the starter has a new sender').from, { projectId: project.id, project: project.name, threadId: sender.id, label: 'Fake agent test' })
  await client.close()

  // The conversation shows the message as the other agent's, with a link to it.
  await page.goto(`${base}/#/p/${other.id}/t/${target.id}`)
  const bubble = page.locator('.msg.user.from-agent')
  await bubble.waitFor()
  assert.equal(await bubble.locator('.from-agent-link').getAttribute('href'), `#/p/${project.id}/t/${sender.id}`)
  assert.ok((await bubble.locator('.msg-head').textContent()).includes(`Agent · Fake agent test (${project.name})`))

  // The turn it set off cannot write back, and neither can a conversation that turn starts.
  const receiver = await connect(other.id, target.id)
  const back = await call(receiver, 'send_to_conversation', { id: sender.id, project: project.id, text: 'thanks' })
  assert.ok(back.isError && back.text.includes('set off by a message from another agent'), back.text)
  const started = JSON.parse((await call(receiver, 'start_conversation', { prompt: 'relay further' })).text)
  await receiver.close()
  await echoed(other.id, started.id, 'relay further')
  assert.equal((await messages(other.id, started.id))[0].chained, true)
  const relay = await connect(other.id, started.id)
  assert.ok((await call(relay, 'send_to_conversation', { id: sender.id, project: project.id, text: 'thanks' })).isError)
  await relay.close()
  // The user's next input lifts that.
  await api('POST', `/projects/${other.id}/threads/${target.id}/messages`, { text: 'carry on' })
  await echoed(other.id, target.id, 'carry on')
  const again = await connect(other.id, target.id)
  assert.ok(!(await call(again, 'send_to_conversation', { id: sender.id, project: project.id, text: 'done' })).isError)
  await again.close()
  await echoed(project.id, sender.id, 'done')

  // A message a paired device's input set off carries that origin along.
  const device = await pairDevice('CI message phone')
  const remote = (await api('POST', `/projects/${project.id}/threads`, { text: 'tell the designers' }, device)).body
  await echoed(project.id, remote.id, 'tell the designers')
  const remoteClient = await connect(project.id, remote.id)
  await call(remoteClient, 'send_to_conversation', { id: target.id, project: other.id, text: 'from the phone' })
  await remoteClient.close()
  await echoed(other.id, target.id, 'from the phone')
  const fromPhone = (await messages(other.id, target.id)).find((m) => m.text === 'from the phone')
  assert.deepEqual([fromPhone.origin, fromPhone.device, fromPhone.from.threadId], ['remote', 'CI message phone', remote.id])

  // A finished conversation gets marked as done, in another project too, but never the agent's own.
  const closer = await connect(project.id, sender.id)
  assert.ok((await call(closer, 'complete_conversation', { id: sender.id })).isError)
  assert.ok(!(await call(closer, 'complete_conversation', { id: target.id, project: other.id })).isError)
  await closer.close()
  assert.equal((await api('GET', `/projects/${other.id}/threads/${target.id}`)).body.thread.completed, true)

  await api('DELETE', `/devices/${(await api('GET', '/devices')).body.find((d) => d.name === 'CI message phone').id}`)
  await api('DELETE', `/projects/${other.id}`)
})

test('the terminal starts with a shell per folder and worktree, opens and closes more, on paired devices only once allowed here', async () => {
  const [project] = (await api('GET', '/projects')).body
  const t = `/projects/${project.id}/terminal`
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'terminal work', worktree: 'term/wt' })).body

  // The panel follows the open conversation into its worktree, and the shell runs there.
  await page.goto(`${base}/#/p/${project.id}/t/${thread.id}`)
  await page.click('.subbar button[title^="Terminal"]')
  await page.waitForSelector('.terminal-place.on >> text=term/wt')
  await page.waitForFunction(() => document.querySelector('.terminal-screen .xterm-rows')?.textContent.trim())
  await page.click('.terminal-screen')
  await page.keyboard.type('pwd; echo $((6*7))-terminal\n')
  await page.waitForSelector('.terminal-screen >> text=42-terminal')
  assert.ok((await page.textContent('.terminal-screen')).includes(path.basename(thread.worktree.path)))
  const { places, terminals } = (await api('GET', t)).body
  assert.deepEqual(places.map((p) => p.branch), [null, 'term/wt'])
  assert.deepEqual(places[1].threads, [thread.id])
  assert.deepEqual(terminals.map((x) => [x.path, x.running]), [[project.path, false], [thread.worktree.path, true]])
  assert.equal((await api('POST', `${t}/open`, { id: 'nope', cols: 80, rows: 24 })).status, 404)
  assert.equal((await api('POST', t, { path: TMP })).status, 404)

  // More terminals open in any folder, and close again.
  await page.click('.terminal-bar button[title="New terminal"]')
  await page.click('.terminal-bar .menu button:has-text("term/wt")')
  await page.waitForSelector('.terminal-place.on >> text=term/wt 2')
  await until(async () => (await api('GET', t)).body.terminals.filter((x) => x.running).length === 2)
  await page.click('.terminal-place.on button[title="Close terminal"]')
  await page.waitForSelector('.terminal-place.on >> text=term/wt')
  assert.deepEqual((await api('GET', t)).body.terminals.map((x) => [x.path, x.running]), [[project.path, false], [thread.worktree.path, true]])
  const id = terminals[1].id

  // Paired devices get it only once it is switched on at this computer, and lose it when it is switched off.
  const device = await pairDevice('CI terminal')
  const wt = thread.worktree.path
  assert.equal((await api('GET', t, undefined, device)).status, 403)
  assert.equal((await api('POST', `${t}/input`, { id, data: 'touch from-device\r' }, device)).status, 403)
  assert.equal((await api('PUT', '/terminal', { remote: true }, device)).status, 403)
  assert.equal((await api('PUT', '/terminal', { remote: true })).body.remote, true)
  assert.equal((await api('GET', t, undefined, device)).status, 200)
  const stream = await fetch(`${base}/api${t}/stream?id=${id}`, { headers: { cookie: device } })
  const reader = stream.body.getReader()
  let seen = ''
  while (!seen.includes('42-terminal')) seen += new TextDecoder().decode((await reader.read()).value)
  await api('POST', `${t}/input`, { id, data: 'touch from-device\r' }, device)
  await until(() => fs.existsSync(path.join(wt, 'from-device')))
  await api('PUT', '/terminal', { remote: false })
  const outcome = await Promise.race([
    (async () => {
      for (;;) if ((await reader.read()).done) return 'ended'
    })().catch(() => 'ended'),
    new Promise((resolve) => setTimeout(() => resolve('still open'), 3000)),
  ])
  assert.equal(outcome, 'ended')
  assert.equal((await api('GET', t, undefined, device)).status, 403)

  // Deleting the worktree ends its shell.
  await page.click('.terminal-bar button[title^="Close ("]')
  await api('DELETE', `/projects/${project.id}/worktrees?path=${encodeURIComponent(wt)}`)
  assert.deepEqual((await api('GET', t)).body.terminals.map((x) => [x.path, x.running]), [[project.path, false]])
})

test("a conversation continues in the agent's own terminal UI", async () => {
  const [project] = (await api('GET', '/projects')).body
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'before the terminal' })).body
  const url = `/projects/${project.id}/threads/${thread.id}`
  await until(async () => (await api('GET', url)).body.messages.some((m) => m.text === 'Echo: before the terminal'))
  await until(async () => !(await api('GET', url)).body.busy)
  const sid = (await api('GET', url)).body.thread.agentSessions[0].sessionId

  await page.goto(`${base}/#/p/${project.id}/t/${thread.id}`)
  await page.click('.thread-head button[title="More"]')
  await page.click('.menu button:has-text("Open in terminal")')
  // A new terminal in the conversation's folder resumes the agent's session there.
  await page.waitForSelector(`.terminal-screen >> text=--resume ${sid}`)
  const { terminals } = (await api('GET', `/projects/${project.id}/terminal`)).body
  assert.equal(terminals.filter((x) => x.path === project.path).length, 2)
  await page.click('.terminal-place.on button[title="Close terminal"]')
  await page.click('.terminal-bar button[title^="Close ("]')
  await api('PATCH', url, { completed: true })
})

test('a shell command in a message runs in the terminal with one click', async () => {
  const [project] = (await api('GET', '/projects')).body
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'Run this:\n\n```bash\necho $((6*7))-clicked\n```\n\n```js\nconsole.log(1)\n```\n\n```\nnpm test\n```' })).body
  await page.goto(`${base}/#/p/${project.id}/t/${thread.id}`)
  await page.waitForSelector('.msg .md-command')
  // The shell block and the one without a language get the button, the js block doesn't.
  assert.equal(await page.locator('.msg .md-command').count(), 2)
  await page.click('.msg .md-command >> nth=0 >> button:has-text("Run in terminal")')
  await page.waitForSelector('.terminal-screen >> text=42-clicked')
  await page.click('.terminal-bar button[title^="Close ("]')
  await api('PATCH', `/projects/${project.id}/threads/${thread.id}`, { completed: true })
})

test('text from the context menu runs in a new or an open conversation of another project', async (t) => {
  const [project] = (await api('GET', '/projects')).body
  const other = (await api('POST', '/projects', { path: path.join(TMP, 'elsewhere-target'), name: 'Elsewhere Target', create: true })).body
  const source = (await api('POST', `/projects/${project.id}/threads`, { text: 'plan both sides' })).body
  await until(async () => (await api('GET', `/projects/${project.id}/threads/${source.id}`)).body.messages.some((m) => m.text === 'Echo: plan both sides'))
  // The desktop shell's bridge, faked: the test plays the clicks of its context menu.
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'en-US' })
  t.after(() => context.close())
  await context.addCookies(await page.context().cookies())
  await context.addInitScript(() => {
    window.savorDesktop = { pickFolder: async () => null, checkForUpdates: async () => null, installUpdate: async () => {}, onUpdateReady: () => {}, setContextActions: (_root, cb) => (window.contextAction = cb) }
  })
  const tab = await context.newPage()
  await tab.goto(`${base}/#/p/${project.id}/t/${source.id}`)
  await tab.waitForFunction(() => window.contextAction)
  const user = async (pid, tid, text) => (await api('GET', `/projects/${pid}/threads/${tid}`)).body.messages.find((m) => m.kind === 'user' && m.text.startsWith(text))?.text

  await tab.evaluate(() => window.contextAction('elsewhere', 'Add the same endpoint here'))
  await tab.selectOption('.elsewhere-dialog select >> nth=0', other.id)
  await tab.click('.elsewhere-dialog button:has-text("Start")')
  await tab.waitForSelector('.elsewhere-dialog >> text=Started a new conversation in Elsewhere Target.')
  const [started] = (await api('GET', `/projects/${other.id}/threads`)).body
  let sent
  await until(async () => (sent = await user(other.id, started.id, 'Add the same endpoint here')))
  assert.match(sent, new RegExp(`\\n\\n---\\nFrom “.+” in ${project.name} \\(read_conversation id ${source.id}, project ${project.id}\\)$`))
  await tab.click('.elsewhere-dialog button:has-text("Done")')

  // Into the open conversation, edited and without the line naming its source.
  await tab.evaluate(() => window.contextAction('elsewhere', 'And a test'))
  await tab.selectOption('.elsewhere-dialog select >> nth=0', other.id)
  await tab.waitForSelector(`.elsewhere-dialog option[value="${started.id}"]`, { state: 'attached' })
  await tab.selectOption('.elsewhere-dialog select >> nth=1', started.id)
  await tab.fill('.elsewhere-dialog textarea', 'And a test for it')
  await tab.uncheck('.elsewhere-dialog input[type=checkbox]')
  await tab.press('.elsewhere-dialog textarea', 'Enter')
  await tab.click('.elsewhere-dialog button:has-text("Open conversation")')
  await tab.waitForURL(`**/#/p/${other.id}/t/${started.id}`)
  await until(async () => (await user(other.id, started.id, 'And a test')) === 'And a test for it')
  await api('DELETE', `/projects/${other.id}`)
})

test('a prompt fans out to several agents in worktrees of their own, and the picked one merges', async () => {
  const [project] = (await api('GET', '/projects')).body
  assert.equal((await api('POST', `/projects/${project.id}/fanout`, { text: 'x', agents: [{ provider: 'claude' }] })).status, 400)
  const runs = (await api('POST', `/projects/${project.id}/fanout`, { text: 'Add a dark mode toggle', agents: [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'claude' }] })).body
  const branches = runs.map((t) => t.worktree.branch)
  assert.ok(branches.every((b) => b.startsWith('add-a-dark-mode/')) && new Set(branches).size === 3, branches.join(', '))
  assert.equal(new Set(runs.map((t) => t.fanout.id)).size, 1)
  const id = runs[0].fanout.id
  for (const t of runs) await until(async () => (await api('GET', `/projects/${project.id}/threads/${t.id}`)).body.messages.some((m) => m.kind === 'conclusion'))
  const third = fs.realpathSync(runs[2].worktree.path)
  assert.ok(agentRuns().some((r) => r.agent === 'claude' && r.cwd && fs.existsSync(r.cwd) && fs.realpathSync(r.cwd) === third))

  // What each worktree changed shows up, committed or not; only Codex committed.
  const [a, b] = runs
  fs.writeFileSync(path.join(a.worktree.path, 'notes.txt'), 'one\ntwo\n')
  fs.writeFileSync(path.join(b.worktree.path, 'dark.css'), 'body {}\n')
  gitIn(b.worktree.path, 'add', '.')
  gitIn(b.worktree.path, 'commit', '-q', '-m', 'dark mode')
  let cmp = (await api('GET', `/projects/${project.id}/fanout/${id}`)).body
  assert.deepEqual(cmp.map((r) => r.changes.map((c) => [c.path, c.additions, c.deletions])), [[['notes.txt', 2, 0]], [['dark.css', 1, 0]], []])
  assert.deepEqual(cmp.map((r) => [r.worktree.ahead, r.worktree.dirty, r.merged]), [[0, true, false], [1, false, false], [0, false, false]])
  assert.equal(cmp[1].answer, 'Codex echo: Add a dark mode toggle')
  assert.equal((await api('GET', `/projects/${project.id}/fanout/nope`)).status, 404)

  // The list groups them; the comparison picks Codex's, merges it and deletes the other two worktrees.
  await page.goto(`${base}/#/p/${project.id}`)
  await page.click('.fan-head')
  await page.waitForSelector('.fan-col >> nth=2')
  await page.locator('.fan-col').nth(1).locator('button:has-text("Pick")').click()
  await page.click('.pick-dialog button:has-text("Merge and delete")')
  await page.waitForSelector('.fan-col.won')
  // The dialog closes once the other worktrees are deleted, which follows the merge.
  await page.waitForSelector('.pick-dialog', { state: 'detached' })
  assert.equal(fs.readFileSync(path.join(PROJECT, 'dark.css'), 'utf8'), 'body {}\n')
  cmp = (await api('GET', `/projects/${project.id}/fanout/${id}`)).body
  assert.deepEqual(cmp.map((r) => [!!r.worktree, r.merged, r.thread.completed]), [[false, false, true], [true, true, false], [false, false, true]])
  assert.deepEqual(cmp[1].changes.map((c) => c.path), ['dark.css'])
  assert.ok(!fs.existsSync(a.worktree.path))
  await api('DELETE', `/projects/${project.id}/worktrees?path=${encodeURIComponent(b.worktree.path)}`)
})

test('Claude Code and Codex sessions of the project can be imported and continue', async () => {
  const [project] = (await api('GET', '/projects')).body
  const rec = (o) => JSON.stringify(o) + '\n'
  const claudeDir = path.join(TMP, 'claude', 'projects', PROJECT.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(claudeDir, { recursive: true })
  const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  fs.writeFileSync(
    path.join(claudeDir, `${sid}.jsonl`),
    [
      rec({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-29T10:00:00.000Z', sessionId: sid }),
      rec({ type: 'user', timestamp: '2026-09-29T10:00:01.000Z', sessionId: sid, cwd: PROJECT, isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: 'Savor context:\n{"threadLabel":null}\n\nNew input:\nBuild the login page' }] } }),
      rec({ type: 'assistant', timestamp: '2026-09-29T10:00:02.000Z', sessionId: sid, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Starting.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
      rec({ type: 'user', timestamp: '2026-09-29T10:00:03.000Z', sessionId: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      rec({ type: 'assistant', timestamp: '2026-09-29T10:00:04.000Z', sessionId: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'Done: the login page exists.' }] } }),
      rec({ type: 'user', timestamp: '2026-09-29T10:00:05.000Z', sessionId: sid, isMeta: true, message: { role: 'user', content: '[Image: a screenshot]' } }),
      rec({ type: 'user', timestamp: '2026-09-29T10:00:06.000Z', sessionId: sid, message: { role: 'user', content: '<local-command-stdout>x</local-command-stdout>' } }),
      rec({ type: 'user', timestamp: '2026-09-29T10:00:07.000Z', sessionId: sid, isSidechain: true, message: { role: 'user', content: [{ type: 'text', text: 'subagent prompt' }] } }),
    ].join(''),
  )
  fs.mkdirSync(path.join(TMP, 'claude', 'projects', '-elsewhere'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'claude', 'projects', '-elsewhere', 'ffffffff-0000-4000-8000-000000000000.jsonl'), rec({ type: 'user', timestamp: '2026-09-29T10:00:01.000Z', message: { role: 'user', content: 'other project' } }))
  const codexDir = path.join(TMP, 'codex', 'sessions', '2026', '10', '01')
  fs.mkdirSync(codexDir, { recursive: true })
  const cid = '01a0fe68-0000-7020-bf38-bb0817cf96ee'
  fs.writeFileSync(
    path.join(codexDir, `rollout-2026-10-01T10-00-00-${cid}.jsonl`),
    [
      rec({ timestamp: '2026-10-01T10:00:00.000Z', type: 'session_meta', payload: { id: cid, timestamp: '2026-10-01T10:00:00.000Z', cwd: PROJECT, originator: 'codex_exec', cli_version: '0.159.0' } }),
      rec({ timestamp: '2026-10-01T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>x</cwd>\n</environment_context>' }, { type: 'input_text', text: '# AGENTS.md instructions\n\nbe nice' }] } }),
      rec({ timestamp: '2026-10-01T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the diff' }] } }),
      rec({ timestamp: '2026-10-01T10:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looks good.' }] } }),
      rec({ timestamp: '2026-10-01T10:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join(''),
  )
  fs.writeFileSync(
    path.join(codexDir, 'rollout-2026-10-01T11-00-00-01a0fe68-1111-7020-bf38-bb0817cf96ee.jsonl'),
    rec({ timestamp: '2026-10-01T11:00:00.000Z', type: 'session_meta', payload: { id: '01a0fe68-1111-7020-bf38-bb0817cf96ee', timestamp: '2026-10-01T11:00:00.000Z', cwd: '/elsewhere' } }),
  )

  const list = (await api('GET', `/projects/${project.id}/import`)).body
  assert.deepEqual(
    list.map((s) => [s.provider, s.title, s.messages, s.imported]),
    [
      ['codex', 'Review the diff', 2, false],
      ['claude', 'Build the login page', 2, false],
    ],
  )
  const device = await pairDevice('CI phone 2')
  assert.equal((await api('GET', `/projects/${project.id}/import`, undefined, device)).status, 403)
  const sessions = list.map(({ provider, id }) => ({ provider, id }))
  const threads = (await api('POST', `/projects/${project.id}/import`, { sessions })).body
  assert.equal(threads.length, 2)
  const imported = threads.find((t) => t.agent.provider === 'claude')
  assert.deepEqual(imported.agentSessions, [{ provider: 'claude', sessionId: sid }])
  assert.equal(imported.createdAt, '2026-09-29T10:00:01.000Z')
  const t = `/projects/${project.id}/threads/${imported.id}`
  assert.deepEqual(
    (await api('GET', t)).body.messages.map((m) => [m.kind, m.text]),
    [
      ['user', 'Build the login page'],
      ['conclusion', 'Starting.\n\nDone: the login page exists.'],
    ],
  )
  assert.deepEqual((await api('GET', `/projects/${project.id}/threads/${threads.find((x) => x.agent.provider === 'codex').id}`)).body.messages.map((m) => m.text), ['Review the diff', 'Looks good.'])
  assert.ok((await api('GET', `/projects/${project.id}/import`)).body.every((s) => s.imported))
  assert.equal((await api('POST', `/projects/${project.id}/import`, { sessions })).body.length, 0)
  // Continuing resumes the agent's own session instead of starting a new one.
  await api('POST', `${t}/messages`, { text: 'continue' })
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'Echo: continue'))
  const run = agentRuns().filter((r) => r.agent === 'claude').at(-1)
  assert.equal(run.argv[run.argv.indexOf('--resume') + 1], sid)
  // Deleting a conversation deletes the agent's transcript with it.
  await api('DELETE', t)
  await api('DELETE', `/projects/${project.id}/threads/${threads.find((x) => x.agent.provider === 'codex').id}`)
  assert.ok(!fs.existsSync(path.join(claudeDir, `${sid}.jsonl`)))
  assert.ok(!fs.existsSync(path.join(codexDir, `rollout-2026-10-01T10-00-00-${cid}.jsonl`)))
  assert.ok(fs.existsSync(path.join(TMP, 'claude', 'projects', '-elsewhere', 'ffffffff-0000-4000-8000-000000000000.jsonl')))
  assert.equal(fs.statSync(path.join(PROJECT, '.savor')).mode & 0o777, 0o700)
})

test('the workflow gallery fills the editor with a recipe', async () => {
  const [project] = (await api('GET', '/projects')).body
  await page.goto(`${base}/#/p/${project.id}/workflows/gallery`)
  await page.click('.recipe:has-text("Standup notes")')
  await page.waitForSelector('text=New workflow from “Standup notes”')
  assert.equal(await page.inputValue('.form input[required]'), 'Standup notes')
  assert.equal(await page.inputValue('.form select'), '0 9 * * 1-5')
  await page.click('.form button[type=submit]')
  await page.waitForSelector('.side-list .card:has-text("Standup notes")')
  const wf = (await api('GET', `/projects/${project.id}/workflows`)).body.find((w) => w.name === 'Standup notes')
  assert.equal(wf.cron, '0 9 * * 1-5')
  assert.ok(wf.prompt.includes('standup notes'))
})

test('files open in the code editor, markdown and documents in the rich editor', async () => {
  const [project] = (await api('GET', '/projects')).body
  fs.writeFileSync(path.join(PROJECT, 'hello.js'), 'const a = 1\n')
  await page.goto(`${base}/#/p/${project.id}/files/f/hello.js`)
  await page.click('.cm-editor .cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('const b = 2')
  await page.waitForSelector('text=Unsaved changes')
  await page.keyboard.press('Control+s')
  await until(() => fs.readFileSync(path.join(PROJECT, 'hello.js'), 'utf8') === 'const a = 1\nconst b = 2')

  fs.writeFileSync(path.join(PROJECT, 'NOTES.md'), '# Notes\n\nSome **bold** text.\n')
  await page.goto(`${base}/#/p/${project.id}/files/f/NOTES.md`)
  await page.waitForSelector('.rich-content h1:has-text("Notes")')
  await page.waitForSelector('.rich-content strong:has-text("bold")')
  await page.click('.segmented button:has-text("Markdown")')
  await page.waitForSelector('.cm-editor')
  await page.click('.segmented button:has-text("Rich")')
  await page.waitForSelector('.rich-content')

  await page.click('.tree-head .icon-btn[title="New document"]')
  await page.waitForSelector('.rich-content')
  await page.fill('.title-input', 'Launch plan')
  await page.click('.rich-content')
  await page.keyboard.type('# Plan')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Ship it')
  let doc
  await until(async () => (doc = (await api('GET', `/projects/${project.id}/docs`)).body.find((d) => d.title === 'Launch plan' && d.content.includes('Ship it')))).catch(async (error) => {
    assert.fail(`${error.message}: ${JSON.stringify((await api('GET', `/projects/${project.id}/docs`)).body)}`)
  })
  assert.equal(doc.content, '# Plan\n\nShip it\n')
  await page.waitForSelector('.editor-page >> text=Saved')
})

test('unpinned projects leave the tab bar and stay in the Projects menu', async () => {
  const other = (await api('GET', '/projects')).body.find((p) => p.path === PROJECT)
  const row = `.menu a[href="#/p/${other.id}"]`
  await page.goto(`${base}/#/all`)
  await page.click('text=Projects')
  await page.click(`${row} .pin`)
  await page.waitForSelector(`.project-tab[href="#/p/${other.id}"]`, { state: 'detached' })
  assert.equal((await api('GET', '/projects')).body.find((p) => p.id === other.id).pinned, false)
  // Opened from the menu, it has a tab for as long as it is the project on screen.
  await page.click(row)
  await page.waitForSelector(`.project-tab.active[href="#/p/${other.id}"]`)
  await page.click('text=Projects')
  await page.click(`${row} .pin`)
  await until(async () => (await api('GET', '/projects')).body.find((p) => p.id === other.id).pinned)
  await page.keyboard.press('Escape')
  await page.click('.conv-head h2')
})

test('a draft stays with its conversation', async () => {
  const project = (await api('GET', '/projects')).body.find((p) => p.path === PROJECT)
  const [one, other] = (await api('GET', `/projects/${project.id}/threads`)).body.filter((t) => !t.completed)
  const draft = () => page.inputValue('.composer textarea')
  await page.goto(`${base}/#/p/${project.id}/t/${one.id}`)
  await page.waitForSelector('.thread-head')
  await page.fill('.composer textarea', 'half a thought')
  await page.goto(`${base}/#/p/${project.id}/t/${other.id}`)
  await page.waitForSelector(`.card.active[href="#/p/${project.id}/t/${other.id}"]`)
  assert.equal(await draft(), '')
  await page.goto(`${base}/#/p/${project.id}/t/${one.id}`)
  await page.waitForSelector(`.card.active[href="#/p/${project.id}/t/${one.id}"]`)
  assert.equal(await draft(), 'half a thought')
  // Sending it clears the draft.
  await page.press('.composer textarea', 'Enter')
  await page.waitForSelector('text=Echo: half a thought')
  await page.reload()
  await page.waitForSelector('.thread-head')
  assert.equal(await draft(), '')
})

test('typing / lists the skills of the agent and runs the one picked', async () => {
  const project = (await api('GET', '/projects')).body.find((p) => p.path === PROJECT)
  const skills = async (provider) => (await api('GET', `/projects/${project.id}/skills?provider=${provider}`)).body.map((s) => s.name)
  // Each agent reports its own skills and commands. Claude Code's commands for the terminal UI stay out,
  // as do the skills Codex has switched off; Codex's own commands come last.
  assert.deepEqual(await skills('claude'), ['greet', 'tools:lint', 'code-review', 'compact', 'btw'])
  assert.deepEqual(await skills('codex'), ['greet', 'review', 'compact', 'goal', 'mcp', 'btw'])
  assert.deepEqual(await skills('grok'), [])
  assert.deepEqual(await skills('opencode'), ['review', 'btw'])
  assert.deepEqual(await skills('antigravity'), ['fake-skill', 'btw'])

  await page.goto(`${base}/#/p/${project.id}/new`)
  await page.waitForSelector('text=What do you want to build?')
  await page.fill('.composer textarea', '/')
  await page.waitForSelector('.slash button.selected:has-text("/greet")')
  assert.equal(await page.locator('.slash button').count(), 4)
  // The list narrows while the name is typed, and Enter completes the name instead of sending.
  await page.keyboard.type('li')
  await page.waitForSelector('.slash button.selected:has-text("/tools:lint")')
  await page.keyboard.press('Enter')
  assert.equal(await page.inputValue('.composer textarea'), '/tools:lint ')
  assert.equal(await page.locator('.slash').count(), 0)
  await page.fill('.composer textarea', '/')
  await page.keyboard.press('ArrowDown')
  await page.waitForSelector('.slash button.selected:has-text("/tools:lint")')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Tab')
  await page.keyboard.type('Robin')
  await page.keyboard.press('Enter')
  // Claude Code got the command as a text block of its own, which is where it runs slash commands.
  await page.waitForSelector('text=Skill greet Robin')

  // Codex gets the skill itself next to the text.
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: '/greet Robin', agent: { provider: 'codex', permissionMode: 'default' } })).body
  await until(async () => (await api('GET', `/projects/${project.id}/threads/${thread.id}`)).body.messages.some((m) => m.text === 'Codex skill: greet from /fake/skills/greet/SKILL.md'))
  await api('PATCH', `/projects/${project.id}`, { agent: project.agent })
})

test('a restart opens the conversation that was open last', async () => {
  const projects = (await api('GET', '/projects')).body
  const project = projects.find((p) => p.path === PROJECT)
  const thread = (await api('GET', `/projects/${project.id}/threads`)).body.find((t) => !t.completed)
  await page.goto(`${base}/#/all`)
  await page.goto(`${base}/#/p/${project.id}/t/${thread.id}`)
  await page.waitForSelector(`.card.active[href="#/p/${project.id}/t/${thread.id}"]`)
  // The app starts on the bare URL, as the desktop app does after an update.
  await page.goto(`${base}/`)
  await page.waitForSelector(`.card.active[href="#/p/${project.id}/t/${thread.id}"]`)
})

test('/btw asks a copy of the agent session, also while it works, and stays out of the conversation', async () => {
  const project = (await api('GET', '/projects')).body.find((p) => p.path === PROJECT)
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'slow: long work', agent: { provider: 'claude' } })).body
  const url = `/projects/${project.id}/threads/${thread.id}`
  await until(async () => (await api('GET', url)).body.thread.agentSessions.length)
  await page.goto(`${base}/#/p/${project.id}/t/${thread.id}`)
  await page.fill('.composer textarea', '/btw what are you doing?')
  await page.press('.composer textarea', 'Enter')
  const sid = (await api('GET', url)).body.thread.agentSessions[0].sessionId
  await page.waitForSelector(`.aside-answer >> text=Aside from ${sid} (fork): what are you doing?`)
  assert.equal(await page.inputValue('.composer textarea'), '')
  const messages = (await api('GET', url)).body.messages
  assert.ok(!messages.some((m) => m.text.includes('what are you doing')))
  assert.equal((await api('GET', url)).body.busy, true)
  await page.click('.aside button[aria-label="Close"]')
  assert.equal(await page.locator('.aside').count(), 0)
  fs.writeFileSync(AGENT_LOG + '.release', 'slow: long work')
  await until(async () => (await api('GET', url)).body.messages.some((m) => m.text === 'Echo: long work'))

  // Codex answers in an ephemeral fork of its thread.
  const codex = (await api('POST', `/projects/${project.id}/threads`, { text: 'hello', agent: { provider: 'codex', permissionMode: 'default' } })).body
  await until(async () => !(await api('GET', `/projects/${project.id}/threads/${codex.id}`)).body.busy && (await api('GET', `/projects/${project.id}/threads/${codex.id}`)).body.messages.some((m) => m.text === 'Codex echo: hello'))
  const answer = await api('POST', `/projects/${project.id}/threads/${codex.id}/btw`, { text: 'which file?' })
  assert.equal(answer.body.text, 'Codex aside in fork-of-fake-codex-thread: which file?')
  assert.equal((await api('POST', `/projects/${project.id}/threads/${codex.id}/btw`, { text: ' ' })).status, 400)
  await api('PATCH', `/projects/${project.id}`, { agent: project.agent })
})

test('input added to the running turn reaches the agent at its next step and belongs to the same request', async () => {
  const project = (await api('GET', '/projects')).body.find((p) => p.path === PROJECT)
  for (const agent of [{ provider: 'claude' }, { provider: 'codex', permissionMode: 'default' }]) {
    const thread = (await api('POST', `/projects/${project.id}/threads`, { text: `slow: steered ${agent.provider}`, agent })).body
    const url = `/projects/${project.id}/threads/${thread.id}`
    await until(async () => (await api('GET', url)).body.busy)
    await page.goto(`${base}/#/p/${project.id}/t/${thread.id}`)
    await page.fill('.composer textarea', 'use tabs')
    await page.press('.composer textarea', 'Control+Enter')
    await until(async () => (await api('GET', url)).body.messages.some((m) => m.text === 'use tabs' && m.delivered))
    // A queued one can be added from the queue too.
    await page.fill('.composer textarea', 'and spaces')
    await page.press('.composer textarea', 'Enter')
    await page.click('.queued-row button:has-text("Add to this turn")')
    await until(async () => (await api('GET', url)).body.messages.every((m) => m.delivered !== false))
    assert.equal((await api('GET', url)).body.busy, true)
    fs.writeFileSync(AGENT_LOG + '.release', `slow: steered ${agent.provider}`)
    const echo = agent.provider === 'claude' ? 'Echo: steered claude (added: use tabs, and spaces)' : 'Codex echo: slow: steered codex (added: use tabs, and spaces)'
    await until(async () => (await api('GET', url)).body.messages.some((m) => m.text === echo))
    await until(async () => !(await api('GET', url)).body.busy)
    // One request: the added input started no turn of its own.
    assert.equal((await api('GET', url)).body.messages.filter((m) => m.kind === 'conclusion').length, 1)
    await api('PATCH', url, { completed: true })
  }
  await api('PATCH', `/projects/${project.id}`, { agent: project.agent })
})

test("Codex's own commands run through the app-server methods behind them", async () => {
  const project = (await api('GET', '/projects')).body.find((p) => p.path === PROJECT)
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: '/review', agent: { provider: 'codex', permissionMode: 'default' } })).body
  const said = async (text) => {
    await until(async () => (await api('GET', `/projects/${project.id}/threads/${thread.id}`)).body.messages.some((m) => m.kind === 'conclusion' && m.text === text))
    await until(async () => !(await api('GET', `/projects/${project.id}/threads/${thread.id}`)).body.busy)
  }
  const send = (text) => api('POST', `/projects/${project.id}/threads/${thread.id}/messages`, { text })
  await said('Codex review of uncommittedChanges')
  await send('/review only the tests')
  await said('Codex review of custom: only the tests')
  await send('/compact')
  await said('Context compacted.')
  await send('!ls -a')
  await said("```\n$ /bin/bash -lc 'ls -a'\nfake output\n```")
  // A goal keeps Codex working turn after turn; the request ends once the goal is met.
  await send('/goal ship it')
  await said('Codex goal met: ship it')
  const conclusions = (await api('GET', `/projects/${project.id}/threads/${thread.id}`)).body.messages.filter((m) => m.kind === 'conclusion')
  assert.ok(!conclusions.some((m) => m.text === 'Codex goal: halfway'))
  await send('/goal')
  await said('Goal (complete): ship it')
  await send('/goal clear')
  await said('Goal cleared.')
  await send('/mcp')
  await said('- docs: connected, oAuth\n- tracker: authenticationRequired, notLoggedIn')
  // Signing in to an MCP server opens its page and ends once Codex reports the sign-in.
  await send('/mcp login tracker')
  let approval
  await until(async () => (approval = (await api('GET', `/projects/${project.id}/threads/${thread.id}`)).body.messages.find((m) => m.approval?.status === 'pending')))
  assert.equal(approval.approval.url, 'https://auth.example/tracker')
  await api('POST', `/projects/${project.id}/threads/${thread.id}/approvals/${approval.id}`, { choice: 'accept' })
  await said('Signed in to tracker.')
  await api('PATCH', `/projects/${project.id}/threads/${thread.id}`, { completed: true })
  await api('PATCH', `/projects/${project.id}`, { agent: project.agent })
})

test('a new project gets its own folder with a git repository', async () => {
  const dir = path.join(TMP, 'new projects')
  await page.click('text=Projects')
  await page.click('text=Start new project')
  await page.click('text=Change folder')
  await page.fill('input[placeholder="Folder for new projects"]', dir)
  await page.fill('input[placeholder="Name of the new project"]', 'Bakery Site')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.project-tab.active:has-text("Bakery Site")')
  await page.waitForSelector('text=What do you want to build?')
  const folder = path.join(dir, 'bakery-site')
  assert.ok(fs.existsSync(path.join(folder, '.git')), 'git repository')
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: folder }).toString(), '', '.savor/ stays out of git')
  // The next new project is offered the same folder, and a folder that exists is not taken over.
  assert.ok((await api('GET', '/me')).body.projectsDir.endsWith('new projects'))
  assert.equal((await api('POST', '/projects', { path: folder, name: 'Bakery Site', create: true })).status, 400)
})

test('a project type brings its role, workflows and a conversation that sets it up', async () => {
  await page.click('text=Projects')
  await page.click('text=Start new project')
  await page.click('.project-type:has-text("Kontor")')
  await page.fill('input[placeholder="Name of the new project"]', 'Household')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.project-tab.active:has-text("Household")')
  await page.waitForURL(/#\/p\/[^/]+\/t\//)
  const project = (await api('GET', '/projects')).body.find((p) => p.name === 'Household')
  assert.match((await api('GET', `/projects/${project.id}/role`)).body.role, /This project is a Kontor/)
  const workflows = (await api('GET', `/projects/${project.id}/workflows`)).body
  assert.deepEqual(workflows.map((w) => w.name).sort(), ['Inbox triage', 'Kontor briefing', 'Kontor weekly review'])
  assert.ok(workflows.every((w) => w.collection === 'Kontor' && w.cron))
  const [thread] = (await api('GET', `/projects/${project.id}/threads`)).body
  assert.match((await api('GET', `/projects/${project.id}/threads/${thread.id}`)).body.messages[0].text, /^Set up this project as a Kontor\./)
  await api('PATCH', `/projects/${project.id}/threads/${thread.id}`, { completed: true })
})

test('appearance: theme, density and what a conversation shows stay on the device', async () => {
  const project = (await api('GET', '/projects')).body.find((p) => p.path === PROJECT)
  await page.goto(`${base}/#/p/${project.id}`)
  await page.waitForSelector('.card .label-pill')
  await page.click('button[title="Appearance"]')
  await page.click('.appearance >> text=Light')
  await page.waitForSelector('html[data-theme="light"]')
  await page.click('.appearance >> text=Choose what to show')
  await page.uncheck('.appearance label:has-text("Label") input')
  await page.waitForSelector('.card .label-pill', { state: 'detached' })
  await page.click('.appearance .density >> nth=0 >> text=Compact')
  await page.waitForSelector('.card.compact')
  await page.reload()
  await page.waitForSelector('.card.compact')
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light')
  // Back to the defaults.
  await page.evaluate(() => ['savor-prefs', 'savor-theme'].forEach((k) => localStorage.removeItem(k)))
  await page.reload()
  await page.waitForSelector('.card .label-pill')
})

test('feedback opens the issue form on GitHub with the text and the version', async () => {
  await page.context().route('https://github.com/**', (route) => route.fulfill({ body: 'ok' }))
  await page.click('button[title="Send feedback"]')
  await page.fill('.feedback-dialog textarea', 'Pins should be sortable')
  const [issue] = await Promise.all([page.context().waitForEvent('page'), page.click('text=Continue on GitHub')])
  await issue.waitForURL(/github\.com/)
  const url = new URL(issue.url())
  assert.equal(url.origin + url.pathname, 'https://github.com/robinchoice/savor/issues/new')
  assert.equal(url.searchParams.get('title'), 'Pins should be sortable')
  assert.match(url.searchParams.get('body'), /^Pins should be sortable\n\n---\nSavor \d+\.\d+\.\d+ · \w+ \w+$/)
  await issue.close()
  await page.click('.feedback-dialog >> text=Done')
  await page.waitForSelector('.feedback-dialog', { state: 'detached' })
})

test('the bug button reports a bug with a marked screenshot on GitHub, once it is switched on', async () => {
  assert.equal(await page.locator('.bug-button').count(), 0)
  await page.click('.account')
  await page.click('.account-dialog summary:has-text("App settings")')
  await page.click('.account-dialog .setting:has-text("Bug button") .switch')
  await page.click('.account-dialog >> text=Done')
  await page.click('.bug-button')
  // The screenshot leaves out the bug button itself.
  const shot = await page.waitForSelector('.feedback-dialog .bug-shot')
  assert.match(await shot.getAttribute('src'), /^data:image\/png;base64,/)
  await page.click('text=Mark the spot')
  const box = await page.locator('.bug-mark-canvas img').boundingBox()
  await page.mouse.move(box.x + 20, box.y + 20)
  await page.mouse.down()
  await page.mouse.move(box.x + 120, box.y + 80)
  await page.mouse.up()
  await page.click('.bug-mark-bar >> text=Done')
  await page.waitForSelector('.bug-mark', { state: 'detached' })
  await page.fill('.feedback-dialog textarea', 'The pin icon overlaps the name')
  const [issue] = await Promise.all([page.context().waitForEvent('page'), page.click('text=Continue on GitHub')])
  await issue.waitForURL(/github\.com/)
  const body = new URL(issue.url()).searchParams.get('body')
  assert.match(body, /^The pin icon overlaps the name\n\n---\nPage: .+\nVersion: Savor \d+\.\d+\.\d+ .+\nDevice: .+\nWindow: \d+×\d+ @\d+(\.\d+)?x\nLanguage: .+\nFailed calls: .+$/)
  await issue.close()
  await page.waitForSelector('.feedback-dialog >> text=/The screenshot (is in your clipboard|was downloaded)/')
  await page.click('.feedback-dialog >> text=Done')
  await page.click('.account')
  await page.click('.account-dialog summary:has-text("App settings")')
  await page.click('.account-dialog .setting:has-text("Bug button") .switch')
  await page.click('.account-dialog >> text=Done')
  await page.waitForSelector('.bug-button', { state: 'detached' })
})

test('the account dialog shows this computer, its devices and agents', async () => {
  const me = (await api('GET', '/me')).body
  assert.equal(me.host, os.hostname())
  await page.click('.account')
  await page.waitForSelector(`.account-dialog >> text=Savor ${me.version}`)
  await page.click('text=Connect a personal device')
  await page.waitForSelector('.account-dialog .qr svg')
  await page.click('.account-dialog summary:has-text("Agents")')
  await page.waitForSelector('.account-dialog .setting:has-text("Claude Code") >> text=Signed in')
  // The feedback button can leave the toolbar.
  await page.uncheck('.account-dialog label:has-text("Show feedback in toolbar") input')
  await page.waitForSelector('button[title="Send feedback"]', { state: 'detached' })
  await page.check('.account-dialog label:has-text("Show feedback in toolbar") input')
  await page.click('.account-dialog >> text=Done')
  await page.waitForSelector('button[title="Send feedback"]')
})

test('browser mode gives the page the stage and draws it in the size of that space', async (t) => {
  const site = http.createServer((_, res) => res.setHeader('content-type', 'text/html').end('<h1>Brotzeit</h1>')).listen(0)
  t.after(() => site.close())
  const project = (await api('GET', '/projects')).body.find((p) => p.path === PROJECT)
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'build a page' })).body
  const threadBase = `/projects/${project.id}/threads/${thread.id}`
  await page.goto(`${base}/#/p/${project.id}/t/${thread.id}`)
  await page.waitForSelector('text=Echo: build a page')
  // Without a preview the conversation is a chat with the list beside it.
  assert.deepEqual([await page.isVisible('.conv-list'), await page.isVisible('.stage')], [true, false])

  // The first preview opens the browser: the list makes room, and the page is as large as the stage.
  assert.equal((await api('POST', `${threadBase}/browser/open`, { url: `http://127.0.0.1:${site.address().port}/` })).status, 200)
  await page.waitForSelector('.stage .screen')
  assert.equal(await page.isVisible('.conv-list'), false)
  const sizes = () => page.evaluate(() => {
    const img = document.querySelector('.screen'), wrap = document.querySelector('.screen-wrap')
    return { frame: [img.naturalWidth, img.naturalHeight], space: [wrap.clientWidth, wrap.clientHeight], shown: [img.width, img.height] }
  })
  const told = async () => assert.fail('timed out: ' + JSON.stringify([await sizes(), await page.locator('.preview .error-text').allTextContents()]))
  await until(async () => {
    const { frame, space } = await sizes()
    return frame[0] === space[0] && frame[1] === space[1]
  }).catch(told)
  // The phone layout is drawn one to one, the desktop layout scaled down to the space.
  await page.click('.devices >> text=390')
  await until(async () => (await sizes()).frame[0] === 390).catch(told)
  await page.click('.devices >> text=1280')
  await until(async () => (await sizes()).frame[0] === 1280).catch(told)
  const desktop = await sizes()
  assert.equal(desktop.shown[0], desktop.space[0])
  await page.click('.devices >> text=Fit')

  // With the chat hidden, a small composer stays over the page and shows what the agent answers.
  await page.click('[title="Hide chat"]')
  await page.waitForSelector('.float .composer')
  assert.equal(await page.isVisible('.thread-head'), false)
  await send('make it warmer')
  await page.click('.bubble:has-text("Echo: make it warmer")')
  await page.waitForSelector('.messages >> text=Echo: make it warmer')

  // Back in the chat, a card under the answer leads to the preview. The choice stays with the conversation.
  await page.click('.modes [title="Chat"]')
  await page.waitForSelector('.conv-list')
  await page.waitForSelector('.preview-card')
  await page.reload()
  await page.waitForSelector('.thread-head')
  assert.equal(await page.isVisible('.stage'), false)
  await page.click('.preview-card')
  await page.waitForSelector('.stage .screen')

  // On a phone the page takes the whole view, and finding in the conversation leads back to the chat.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForSelector('.float .composer')
  assert.equal(await page.isVisible('.messages'), false)
  await page.keyboard.press('Control+f')
  await page.waitForSelector('.find-bar input')
  await page.setViewportSize({ width: 1400, height: 900 })
})

test('the preview takes the mouse, shortcuts and the clipboard', async (t) => {
  let typed = null
  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/v?')) typed = decodeURIComponent(req.url.slice(3))
    res.setHeader('content-type', 'text/html').end(`<input style="position:fixed;left:0;top:0;width:300px;height:40px" oninput="fetch('/v?' + encodeURIComponent(this.value))">
      <p style="position:fixed;left:0;top:100px;margin:0;font:40px monospace">Brotzeit Weißwurst</p>`)
  }).listen(0)
  t.after(() => site.close())
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  const project = (await api('GET', '/projects')).body.find((p) => p.path === PROJECT)
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'build a form' })).body
  await page.goto(`${base}/#/p/${project.id}/t/${thread.id}`)
  await page.waitForSelector('text=Echo: build a form')
  await api('POST', `/projects/${project.id}/threads/${thread.id}/browser/open`, { url: `http://127.0.0.1:${site.address().port}/` })
  await page.waitForSelector('.stage .screen')
  // Points in the page, where they are drawn in the UI.
  const at = (x, y) => page.evaluate(([x, y]) => {
    const img = document.querySelector('.screen'), r = img.getBoundingClientRect()
    return { x: r.left + (x * r.width) / img.naturalWidth, y: r.top + (y * r.height) / img.naturalHeight }
  }, [x, y])
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText())

  let p = await at(100, 20)
  await page.mouse.click(p.x, p.y)
  await page.evaluate(() => navigator.clipboard.writeText('Leberkäs'))
  await page.keyboard.press('Control+v')
  await until(() => typed === 'Leberkäs')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+x')
  await until(() => typed === '')
  assert.equal(await clipboard(), 'Leberkäs')

  // A double click selects a word, a drag selects across words (from behind, a press in the selection would drag it).
  p = await at(60, 120)
  await page.mouse.dblclick(p.x, p.y)
  await page.keyboard.press('Control+c')
  await until(async () => (await clipboard()) === 'Brotzeit')
  const end = await at(400, 120)
  await page.mouse.move(end.x, end.y)
  await page.mouse.down()
  await page.mouse.move(p.x - 55, p.y, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.press('Control+c')
  await until(async () => (await clipboard()).startsWith('Brotzeit Wei'))
})

test('a turn cut off by a restart continues in the same agent session', async () => {
  const [project] = (await api('GET', '/projects')).body
  const t = `/projects/${project.id}/threads`
  const thread = (await api('POST', t, { text: 'slow: survive' })).body
  const read = async () => (await api('GET', `${t}/${thread.id}`)).body
  await until(async () => (await read()).messages.some((m) => m.text === 'On it.'))
  assert.equal((await api('POST', `${t}/${thread.id}/messages`, { text: 'after the restart' })).body.delivered, false)
  // An update the agent sends again after the restart, because it cannot know whether it arrived.
  const { mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const update = async () => {
    const client = new Client({ name: 'e2e', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?project=${project.id}&thread=${thread.id}`), { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
    const r = await client.callTool({ name: 'send_user_requested_message', arguments: { idempotencyKey: 'halfway', text: 'Halfway there.' } })
    await client.close()
    return JSON.parse(r.content[0].text).id
  }
  const sent = await update()

  server.kill()
  await new Promise((resolve) => server.on('exit', resolve))
  await startDaemon()
  assert.equal(await update(), sent)

  // The conversation is working again without anyone sending something, in the session the agent had.
  await until(async () => (await read()).busy)
  const sessionId = (await read()).thread.agentSessions[0].sessionId
  await until(() => agentRuns().some((r) => r.agent === 'claude' && r.argv[r.argv.indexOf('--resume') + 1] === sessionId))
  fs.writeFileSync(AGENT_LOG + '.release', 'slow: survive')
  await until(async () => (await read()).messages.some((m) => m.text === 'Echo: survive (after a restart)'))
  // What was queued follows, and the request kept its one acknowledgement.
  await until(async () => (await read()).messages.some((m) => m.text === 'Echo: after the restart'))
  const { messages, thread: saved } = await read()
  assert.equal(messages.filter((m) => m.kind === 'ack' && m.ts < messages.find((m) => m.text === 'after the restart').ts).length, 1)
  assert.equal(messages.filter((m) => m.text === 'Halfway there.').length, 1)
  assert.equal(saved.workingSince, null)
})

test('a turn that stops at a usage limit continues once it resets, also after a restart, and what is queued waits', async () => {
  const [project] = (await api('GET', '/projects')).body
  const t = `/projects/${project.id}/threads`
  const read = async (id) => (await api('GET', `${t}/${id}`)).body
  const thread = (await api('POST', t, { text: 'limit: soon' })).body
  await until(async () => (await read(thread.id)).messages.some((m) => m.text === 'On it.'))
  assert.equal((await api('POST', `${t}/${thread.id}/messages`, { text: 'queued behind the limit' })).body.delivered, false)
  fs.writeFileSync(AGENT_LOG + '.release', 'limit: soon')
  await until(async () => (await read(thread.id)).thread.resumeAt)
  let r = await read(thread.id)
  assert.equal(r.waiting, true)
  assert.ok(r.messages.some((m) => m.kind === 'error' && m.text === "You've hit your limit · resets 3pm"))
  assert.ok(r.messages.some((m) => m.text === 'queued behind the limit' && m.delivered === false), 'the queue waits for the limit')
  // The turn continues on the same request, and the queue follows.
  await until(async () => (await read(thread.id)).messages.some((m) => m.text === 'Echo: limit: soon (after the limit)'))
  await until(async () => (await read(thread.id)).messages.some((m) => m.text === 'Echo: queued behind the limit'))
  r = await read(thread.id)
  assert.equal(r.messages.filter((m) => m.kind === 'ack').length, 2)
  assert.deepEqual([r.thread.resumeAt, r.thread.error, r.waiting], [null, null, false])

  // A limit that resets later: the conversation shows when it continues, a stop cancels that.
  const stopped = (await api('POST', t, { text: 'limit-later: stop me' })).body
  await until(async () => (await read(stopped.id)).thread.resumeAt)
  await page.goto(`${base}/#/p/${project.id}/t/${stopped.id}`)
  await page.waitForSelector('.working-row:has-text("Usage limit · continues")')
  await api('POST', `${t}/${stopped.id}/stop`)
  r = await read(stopped.id)
  assert.deepEqual([r.thread.resumeAt, r.waiting, r.messages.at(-1).text], [null, false, 'Turn stopped.'])

  // The time to continue is kept on disk; one that passed while Savor was down continues at the start.
  const later = (await api('POST', t, { text: 'limit-later: survive' })).body
  await until(async () => (await read(later.id)).thread.resumeAt)
  server.kill()
  await new Promise((resolve) => server.on('exit', resolve))
  const file = path.join(project.path, '.savor', 'threads', later.id, 'thread.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), resumeAt: new Date(Date.now() - 1000).toISOString() }))
  await startDaemon()
  await until(async () => (await read(later.id)).messages.some((m) => m.text === 'Echo: limit-later: survive (after the limit)'))
  assert.equal((await read(later.id)).thread.resumeAt, null)
})

test('agents wait for CI without holding their turn, and Savor continues the request with the result', async () => {
  const [project] = (await api('GET', '/projects')).body
  const t = `/projects/${project.id}/threads`
  const read = async (id) => (await api('GET', `${t}/${id}`)).body
  const conclusion = async (id) => {
    await until(async () => (await read(id)).messages.some((m) => m.kind === 'conclusion'), 40_000)
    return (await read(id)).messages.find((m) => m.kind === 'conclusion').text
  }
  const head = gitIn(PROJECT, 'rev-parse', 'HEAD')
  const run = (status, conclusion, name = 'CI') => ({ databaseId: 7, name, workflowName: name, status, conclusion, url: `https://github.com/acme/app/actions/runs/7` })
  const runs = (list) => fs.writeFileSync(AGENT_LOG + '.gh.json', JSON.stringify({ [head]: list }))

  // Runs that already finished come back right away; gh failing reaches the agent as an error.
  runs([run('completed', 'success')])
  assert.equal(await conclusion((await api('POST', t, { text: 'ci: done already' })).body.id), `Watch: CI for ${head.slice(0, 7)}: all 1 runs passed.\n- CI: success https://github.com/acme/app/actions/runs/7`)
  runs('logged-out')
  assert.match(await conclusion((await api('POST', t, { text: 'ci: no login' })).body.id), /^Watch: gh run list failed: To get started with GitHub CLI/)

  // Runs still going: the turn ends without a conclusion, the conversation waits, and the request continues with the result.
  runs([run('in_progress', '')])
  const waiting = (await api('POST', t, { text: 'ci: wait for it' })).body
  await until(async () => (await read(waiting.id)).waiting)
  assert.equal((await read(waiting.id)).thread.ciWatch.sha, head)
  await page.goto(`${base}/#/p/${project.id}/t/${waiting.id}`)
  await page.waitForSelector(`.working-row:has-text("Waiting for CI · ${head.slice(0, 7)}")`)
  runs([run('completed', 'failure')])
  assert.equal(
    await conclusion(waiting.id),
    `After CI: CI for ${head.slice(0, 7)}: 1 of 1 runs failed.\n- CI: failure https://github.com/acme/app/actions/runs/7\nThe log of a failed run: gh run view 7 --log-failed`,
  )
  assert.deepEqual([(await read(waiting.id)).thread.ciWatch, (await read(waiting.id)).waiting], [null, false])

  // A stop ends the wait.
  runs([run('in_progress', '')])
  const stopped = (await api('POST', t, { text: 'ci: stop me' })).body
  await until(async () => (await read(stopped.id)).waiting)
  await api('POST', `${t}/${stopped.id}/stop`)
  assert.deepEqual([(await read(stopped.id)).thread.ciWatch, (await read(stopped.id)).waiting], [null, false])

  // An agent that concluded without waiting: the watch survives a restart, and only a failure reaches the user.
  const concluded = (await api('POST', t, { text: 'ci-done: fire and forget' })).body
  assert.equal(await conclusion(concluded.id), 'Done without waiting.')
  assert.equal((await read(concluded.id)).waiting, false)
  server.kill()
  await new Promise((resolve) => server.on('exit', resolve))
  runs([run('completed', 'cancelled', 'Deploy')])
  await startDaemon()
  // The list leaves the conversation unread, opening it would not.
  await until(async () => (await api('GET', t)).body.find((x) => x.id === concluded.id).unread)
  const after = await read(concluded.id)
  assert.ok(after.messages.at(-1).kind === 'error' && after.messages.at(-1).text.startsWith(`CI for ${head.slice(0, 7)}: 1 of 1 runs failed.\n- Deploy: cancelled`))
  assert.deepEqual([after.thread.ciWatch, after.messages.filter((m) => m.kind === 'conclusion').length], [null, 1])
})

test("the header shows how full the agent's context window is", async () => {
  const [project] = (await api('GET', '/projects')).body
  await page.goto(`${base}/#/p/${project.id}`)
  await page.reload()
  await newConversation()
  await send('how full')
  await page.waitForSelector('text=Echo: how full')
  await page.waitForSelector('.thread-sub .context:has-text("Context 19%")')
  assert.match(await page.locator('.thread-sub .context').getAttribute('title'), /^38,000 of 200,000 tokens/)

  // Codex names the window with every update. Another agent starts with an empty context.
  const threads = `/projects/${project.id}/threads`
  const thread = (await api('POST', threads, { text: 'codex context', agent: { provider: 'codex' } })).body
  await until(async () => (await api('GET', `${threads}/${thread.id}`)).body.messages.some((m) => m.kind === 'conclusion'))
  assert.deepEqual((await api('GET', `${threads}/${thread.id}`)).body.thread.context, { tokens: 51200, window: 256000 })
  assert.equal((await api('PATCH', `${threads}/${thread.id}`, { agent: project.agent })).body.context, null)
})

test('a fork continues in a conversation of its own, as a copy of the agent session where there is one', async () => {
  const [project] = (await api('GET', '/projects')).body
  const threads = `/projects/${project.id}/threads`
  const read = async (id) => (await api('GET', `${threads}/${id}`)).body
  const idle = (id) => until(async () => !(await read(id)).busy && (await read(id)).messages.some((m) => m.kind === 'conclusion'))
  const flag = (run, name) => run.argv[run.argv.indexOf(name) + 1]
  const sessionOf = (thread, provider) => thread.agentSessions.find((s) => s.provider === provider)?.sessionId

  // The page learns from a reload that Claude Code is the project's agent again.
  await page.goto(`${base}/#/p/${project.id}`)
  await page.reload()
  await newConversation()
  await send('first approach')
  await page.waitForSelector('text="Echo: first approach"')
  const parentId = page.url().match(/\/t\/(\w+)/)[1]
  assert.equal((await read(parentId)).thread.agent.provider, 'claude')
  await idle(parentId)
  await page.click('.head-actions [title="More"]')
  await page.click('.menu >> text=Fork conversation')
  await page.waitForSelector('h1:has-text("Fork of first approach")')
  const forkId = page.url().match(/\/t\/(\w+)/)[1]
  assert.notEqual(forkId, parentId)
  await send('another approach')
  await page.waitForSelector('text="Echo: another approach"')
  // Claude Code resumed the session of the first conversation as a fork under an ID of its own.
  const parentSession = sessionOf((await read(parentId)).thread, 'claude')
  const run = agentRuns().find((r) => r.agent === 'claude' && r.argv.includes('--fork-session') && flag(r, '--resume') === parentSession)
  assert.ok(run, 'a Claude Code process forked the session of the first conversation')
  assert.equal(sessionOf((await read(forkId)).thread, 'claude'), flag(run, '--session-id'))
  assert.notEqual(flag(run, '--session-id'), parentSession)
  assert.equal((await read(parentId)).messages.length, 3, 'the first conversation stays as it was')
  // The fork leads back to where it came from.
  await page.click('.thread-sub .fork')
  await page.waitForSelector('text="Echo: first approach"')
  assert.ok(page.url().endsWith(`/t/${parentId}`))

  // Codex and OpenCode fork their sessions.
  for (const provider of ['codex', 'opencode']) {
    const parent = (await api('POST', threads, { text: `${provider} original`, agent: { provider } })).body
    await idle(parent.id)
    const session = sessionOf((await read(parent.id)).thread, provider)
    const fork = (await api('POST', `${threads}/${parent.id}/fork`)).body
    assert.deepEqual(fork.fork, { provider, sessionId: session, messages: (await read(parent.id)).messages.length })
    assert.equal(fork.parentId, parent.id)
    await api('POST', `${threads}/${fork.id}/messages`, { text: 'branch' })
    await idle(fork.id)
    const own = sessionOf((await read(fork.id)).thread, provider)
    assert.equal(own, `fork-of-${session}`)
  }

  // A conversation that moved on after the fork is not copied any more: the fork gets its history up to the fork.
  const late = (await api('POST', `${threads}/${parentId}/fork`)).body
  await api('POST', `${threads}/${parentId}/messages`, { text: 'later in the original' })
  await until(async () => (await read(parentId)).messages.some((m) => m.text === 'Echo: later in the original'))
  await api('POST', `${threads}/${late.id}/messages`, { text: 'recall' })
  await idle(late.id)
  const upTo = (await read(late.id)).messages.find((m) => m.kind === 'conclusion').text
  assert.match(upTo, /\[agent\] Echo: first approach/)
  assert.ok(!upTo.includes('later in the original'))
  const lateSession = sessionOf((await read(late.id)).thread, 'claude')
  assert.ok(!agentRuns().find((r) => r.agent === 'claude' && flag(r, '--session-id') === lateSession).argv.includes('--fork-session'))

  // An agent without a session to branch off gets the history of the first conversation, and where to read all of it.
  const codexParent = (await api('GET', threads)).body.find((t) => t.title === 'codex original')
  const other = (await api('POST', `${threads}/${codexParent.id}/fork`)).body
  await api('PATCH', `${threads}/${other.id}`, { agent: project.agent })
  await api('POST', `${threads}/${other.id}/messages`, { text: 'recall' })
  await idle(other.id)
  const handed = (await read(other.id)).messages.find((m) => m.kind === 'conclusion').text
  assert.match(handed, /\[user\] codex original/)
  assert.match(handed, /\[agent\] Codex echo: codex original/)
  assert.ok(handed.includes(`read_conversation with the id ${codexParent.id} returns all of it`))

  // While the agent works there is nothing settled to fork.
  const working = (await api('POST', threads, { text: 'slow: fork me' })).body
  await until(async () => (await read(working.id)).messages.some((m) => m.text === 'On it.'))
  assert.equal((await api('POST', `${threads}/${working.id}/fork`)).status, 400)
  fs.writeFileSync(AGENT_LOG + '.release', 'slow: fork me')
  await idle(working.id)
  await api('PATCH', `/projects/${project.id}`, { agent: project.agent })
})

test('the All tab answers questions in place and starts what waits in the backlog', async () => {
  const [project] = (await api('GET', '/projects')).body
  const threads = `/projects/${project.id}/threads`
  const read = async (id) => (await api('GET', `${threads}/${id}`)).body
  const asked = (await api('POST', threads, { text: 'ask: Ship the footer?', agent: { provider: 'claude' } })).body
  const done = (await api('POST', threads, { text: 'plan the footer', agent: { provider: 'claude' } })).body
  await until(async () => (await read(asked.id)).decisions.some((d) => !d.resolved) && (await read(done.id)).messages.some((m) => m.kind === 'conclusion') && !(await read(done.id)).busy)

  // The inbox opens the next conversation that needs you, across projects, as with J in a project.
  await page.goto(`${base}/#/all/inbox`)
  await page.click('.all-inbox .next-btn')
  await page.waitForFunction(() => /^#\/all\/inbox\/[^/]+\/[^/]+$/.test(location.hash))
  const first = await page.evaluate(() => location.hash)
  // The hash changes before Savor renders the conversation; until then J would still lead to it.
  await page.waitForSelector(`.all-inbox .card.active[href="${first}"]`)
  // The composer has the focus now, so it takes Alt+J.
  await page.keyboard.press('Alt+j')
  await page.waitForFunction((first) => location.hash !== first, first)

  // Finish & next closes a settled conversation and opens the next one that needs you.
  const settled = (await api('POST', threads, { text: 'plan the header', agent: { provider: 'claude' } })).body
  await until(async () => (await read(settled.id)).messages.some((m) => m.kind === 'conclusion') && !(await read(settled.id)).busy)
  await page.goto(`${base}/#/all/inbox/${project.id}/${settled.id}`)
  await page.click('.mark-complete:has-text("Finish & next")')
  await page.waitForFunction((id) => /^#\/all\/inbox\/[^/]+\/[^/]+$/.test(location.hash) && !location.hash.endsWith(id), settled.id)
  assert.ok((await read(settled.id)).thread.completed)

  // The overview brings the open question along and answers it right there.
  const listed = (await api('GET', '/overview')).body.threads.find((t) => t.id === asked.id)
  assert.deepEqual(listed.decisions.map((d) => d.options), [['Yes', 'No']])
  await page.goto(`${base}/#/all`)
  await page.click(`.wait-card:has-text("Ship the footer?") >> button:text-is("Yes")`)
  await until(async () => (await read(asked.id)).decisions.every((d) => d.resolved && d.selected === 0))

  // The backlog holds the items put there, until started or deleted, and not the next steps conversations suggest.
  assert.equal((await api('POST', `/projects/${project.id}/backlog`, { title: '  ' })).status, 400)
  assert.deepEqual((await api('GET', '/backlog')).body, { items: [] })
  await page.goto(`${base}/#/all/board`)
  await page.fill('.board-add textarea', 'Write the footer copy')
  await page.click('.board-add >> text=Add')
  await page.waitForSelector('.board-card:has-text("Write the footer copy")')
  const [item] = (await api('GET', '/backlog')).body.items
  assert.deepEqual([item.title, item.projectId], ['Write the footer copy', project.id])
  await page.click('.board-card:has-text("Write the footer copy") >> text=Start')
  await until(async () => (await api('GET', threads)).body.some((t) => t.title === 'Write the footer copy'))
  await until(async () => !(await api('GET', '/backlog')).body.items.length)

  // Agents put follow-ups on the backlog and find them there.
  const { mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const client = new Client({ name: 'e2e', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?project=${project.id}&thread=${done.id}`), { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text)
  const added = await call('add_to_backlog', { title: 'Translate the footer' })
  assert.ok(added.url.endsWith('/#/all/board'))
  assert.deepEqual((await call('list_backlog', {})).map((i) => [i.id, i.title]), [[added.id, 'Translate the footer']])
  await page.waitForSelector('.board-card:has-text("Translate the footer")')
  await client.close()
})
