// End-to-end tests: real daemon, real UI in headless Chromium, fake agents (test/fake-claude.mjs,
// test/fake-codex.mjs speaking the app-server protocol, test/fake-acp.mjs speaking ACP for OpenCode)
// and a fake whisper.cpp (test/fake-whisper.mjs) behind Chromium's fake microphone.
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

async function newConversation() {
  await page.click('.new-btn')
  await page.waitForSelector('text=What do you want to build?')
}

async function send(text) {
  await page.fill('.composer textarea', text)
  await page.keyboard.press('Enter')
}

before(async () => {
  port = await freePort()
  base = `http://127.0.0.1:${port}`
  fs.mkdirSync(PROJECT)
  fs.writeFileSync(WHISPER_MODEL, '')
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
      SAVOR_ANTIGRAVITY_BIN: path.join(TMP, 'no-such-agy'),
      SAVOR_WHISPER_BIN: path.join(ROOT, 'test/fake-whisper.mjs'),
      SAVOR_WHISPER_MODEL: WHISPER_MODEL,
      FAKE_AGENT_LOG: AGENT_LOG,
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'),
      CODEX_HOME: path.join(TMP, 'codex'),
      SAVOR_ENJOY_DIR: path.join(TMP, 'enjoy'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
  token = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).token
  browser = await chromium.launch({ executablePath: process.env.SAVOR_CHROMIUM, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' })
  await page.goto(`${base}/?token=${token}`)
})

after(async () => {
  await browser?.close()
  server?.kill()
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
  await page.waitForSelector('.status:has-text("Completed")')
})

test('agent settings fit the viewport and effort is directly selectable', async () => {
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
  await page.locator('.agent-menu').getByRole('button', { name: /Codex/ }).click()
  assert.equal(await page.locator('.agent-menu select').first().evaluate((el) => el.selectedOptions[0]?.textContent), 'Default')
  await page.keyboard.press('Escape')
  await page.locator('.quick-effort button', { hasText: 'Medium' }).click()
  assert.equal(await page.locator('.quick-effort button.selected').innerText(), 'Medium')
  await page.click('.agent-btn')
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
  await page.waitForSelector('text=One thing before I continue')
  assert.equal(await page.locator('.filter.attention').count(), 1, 'Needs you filter lights up')
  await page.click('.option:has-text("Yes")')
  await page.click('text=Send reply')
  await page.waitForSelector('text=Selected: Yes')
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

test("an agent's own clarifying questions become decisions", async () => {
  await newConversation()
  await send('native-ask: Which color?')
  await page.waitForSelector('text=One thing before I continue')
  await page.click('.option:has-text("Green")')
  await page.click('text=Send reply')
  await page.waitForSelector('text=Answered: Green')
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
  const thread = (await api('POST', `/projects/${project.id}/threads`, { text: 'hello acp', agent: { provider: 'opencode', permissionMode: 'plan' } })).body
  const t = `/projects/${project.id}/threads/${thread.id}`
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'ACP echo: hello acp'))
  await api('POST', `${t}/messages`, { text: 'approve: this' })
  let approval
  await until(async () => (approval = (await api('GET', t)).body.messages.find((m) => m.approval?.status === 'pending')))
  assert.deepEqual(approval.approval.options.map((o) => [o.id, o.kind]), [['allow_once', 'allow'], ['reject_once', 'deny']])
  await api('POST', `${t}/approvals/${approval.id}`, { choice: 'allow_once' })
  await until(async () => (await api('GET', t)).body.messages.some((m) => m.text === 'ACP permission: allow_once'))
  // The MCP token travelled inside the protocol, not on the command line.
  const run = fs.readFileSync(AGENT_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.agent === 'opencode')
  assert.deepEqual(run.argv.slice(2), ['acp'])
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
  assert.ok(by.opencode.models.some((m) => m.id === 'fake/model'))
  assert.equal(by.grok.installed, false)
  assert.ok(by.claude.modes.find((m) => m.id === 'bypassPermissions').unsafe)
})

test('presets are saved globally and only from this computer', async () => {
  const agent = { provider: 'codex', model: 'fake-model', reasoning: 'high', fast: false, permissionMode: 'read-only' }
  const preset = (await api('POST', '/presets', { name: 'Careful Codex', agent })).body
  assert.deepEqual((await api('GET', '/presets')).body.map((p) => p.name), ['Careful Codex'])
  const pairing = (await api('POST', '/devices/pairing')).body
  const redeem = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, name: 'CI watch' }) })
  const device = redeem.headers.get('set-cookie').split(';')[0]
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
  const thread = (await api('POST', `/projects/${project.id}/workflows/${wf.id}/run`)).body
  await page.goto(`${base}/#/p/${project.id}/t/${thread.id}`)
  await page.waitForSelector('text=Echo: Run workflow')
})

test('auth: tokens, pairing and remote limits', async () => {
  assert.equal((await api('GET', '/projects', undefined, '')).status, 401)
  const pairing = (await api('POST', '/devices/pairing')).body
  const redeem = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, name: 'CI phone' }) })
  assert.equal(redeem.status, 200)
  const device = redeem.headers.get('set-cookie').split(';')[0]
  assert.equal((await api('GET', '/me', undefined, device)).body.origin, 'remote')
  assert.equal((await api('POST', '/devices/pairing', undefined, device)).status, 403)
  assert.equal((await api('POST', '/projects', { path: '/' }, device)).status, 403)
  assert.equal((await api('GET', '/enjoy', undefined, device)).status, 403)
  // Pairing links use the address set for direct connections, which only this computer can change.
  assert.equal((await api('PUT', '/devices/address', { url: 'https://evil.example' }, device)).status, 403)
  assert.equal((await api('PUT', '/devices/address', { url: 'ftp://x' })).status, 400)
  assert.equal((await api('PUT', '/devices/address', { url: 'https://desk.tailnet.example/' })).body.url, 'https://desk.tailnet.example')
  assert.match((await api('POST', '/devices/pairing')).body.url, /^https:\/\/desk\.tailnet\.example\/#\/pair\/[0-9A-F]{10}$/)
  assert.equal((await api('PUT', '/devices/address', { url: '' })).body.url, null)
  assert.ok((await api('POST', '/devices/pairing')).body.url.startsWith('http://localhost:'))
  const again = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, name: 'x' }) })
  assert.equal(again.status, 400)

  // Revoking a LAN device ends its open event stream right away, not only its next request.
  const events = await fetch(`${base}/api/events`, { headers: { cookie: device } })
  const reader = events.body.getReader()
  await reader.read()
  const paired = (await api('GET', '/devices')).body.find((d) => d.name === 'CI phone')
  await api('DELETE', `/devices/${paired.id}`)
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
  for (const r of runs) assert.ok(!r.argv.some((a) => a.includes(mcpToken)), `${r.agent} got the MCP token on its command line`)
  for (const r of runs.filter((r) => r.agent === 'claude')) assert.equal(r.configMode, 0o600)
})

test('what a paired device changes never runs as local', async () => {
  const pairing = (await api('POST', '/devices/pairing')).body
  const redeem = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, name: 'CI tablet' }) })
  const device = redeem.headers.get('set-cookie').split(';')[0]
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
  const redeem = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, name }) })
  return redeem.headers.get('set-cookie').split(';')[0]
}

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

  await page.goto(`${base}/#/p/${project.id}`)
  await page.waitForSelector('.wt-head >> text=feature/wt')
  await page.waitForSelector('.wt-head >> text=1 commit ahead')
  await page.goto(`${base}/#${t.replace('/projects/', '/p/').replace('/threads/', '/t/')}`)
  await page.waitForSelector('.status.worktree >> text=feature/wt')

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
      rec({ type: 'user', timestamp: '2026-09-29T10:00:01.000Z', sessionId: sid, cwd: PROJECT, isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: 'Enjoy context:\n{"threadLabel":null}\n\nNew input:\nBuild the login page' }] } }),
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

test('Enjoy projects come over with their records and continue with the same agent session', async () => {
  // An Enjoy store as Enjoy writes it: an index of project folders, YAML records, markdown with front matter.
  const folder = path.join(TMP, 'from-enjoy')
  const enjoy = path.join(TMP, 'enjoy', 'projects', 'demo-1a2b3c4d')
  // The conversation this test opens in the UI has no preview, so the daemon does not start a preview browser for it.
  const thread = (id, extra = '', preview = id === 'aaaa1111' ? '' : 'productPreview:\n  title: Demo\n  url: http://localhost:5173/\n') => `version: 2
id: ${id}
title: Fix the login
sessionId: enjoy-session-${id}
reasoning: ultracode
provider: claude
model: fake-fable[1m]
fast: false
permissionMode: auto
status: idle
createdAt: 2026-10-01T10:00:00.000Z
label:
  name: Login fix
  hue: 210
agentSessions:
  - provider: claude
    sessionId: enjoy-session-${id}
${preview}requests: []
messages:
  - id: ${id}
    role: user
    text: please fix the login
    createdAt: 2026-10-01T10:00:00.000Z
    delivered: true
    read: true
    images:
      - .enjoy/attachments/shot.png
    inputSource: local
  - id: req1-acknowledgement
    role: assistant
    text: Looking into it.
    createdAt: 2026-10-01T10:00:05.000Z
    read: true
  - id: req1-conclusion
    role: assistant
    text: "Fixed in **auth.ts**."
    createdAt: 2026-10-01T10:02:00.000Z
    read: true
    suggestions:
      - Add a test for it
    commits:
      - ${'a'.repeat(40)}
    workTiming:
      startedAt: 2026-10-01T10:00:00.000Z
      finishedAt: 2026-10-01T10:02:00.000Z
${extra}`
  fs.mkdirSync(folder)
  execFileSync('git', ['init', '-q'], { cwd: folder })
  for (const sub of ['threads/aaaa1111', 'decisions', 'docs', 'recipes', 'attachments']) fs.mkdirSync(path.join(enjoy, sub), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'enjoy', 'projects', 'projects.json'), JSON.stringify({ version: 1, projects: { [folder]: 'demo-1a2b3c4d', [path.join(TMP, 'gone')]: 'gone-00000000' } }))
  fs.writeFileSync(path.join(enjoy, 'config.yml'), 'name: Demo from Enjoy\ntint: "#ffcbe2"\nverbosity: low\npaused: false\nlastAgentConfig:\n  provider: claude\n  model: fake-fable[1m]\n  reasoning: ultracode\n  fast: false\n  permissionMode: auto\n')
  fs.writeFileSync(path.join(enjoy, 'ROLE.md'), 'Answer in German.\n')
  fs.writeFileSync(path.join(enjoy, 'threads/aaaa1111/messages.md'), thread('aaaa1111'))
  fs.writeFileSync(path.join(enjoy, 'threads/aaaa1111/activity.md'), 'version: 2\nevents:\n  - id: 1\n    type: files\n    name: Edit\n    label: Edit · auth.ts\n    time: 2026-10-01T10:01:00.000Z\n    finishedAt: 2026-10-01T10:01:30.000Z\n')
  fs.writeFileSync(path.join(enjoy, 'decisions/req0-conclusion-question-0.md'), '---\nid: req0-conclusion-question-0\ntitle: Which provider?\noptions:\n  - GitHub\n  - Google\nselected: 1\nresolved: true\nthreadId: aaaa1111\nkind: product\ngroupId: req0-conclusion\ncreatedAt: 2026-10-01T09:00:00.000Z\n---\n')
  fs.writeFileSync(path.join(enjoy, 'docs/Plan.md'), '---\ntitle: Login plan\nid: doc1\ncreatedAt: 2026-10-01T09:00:00.000Z\nupdatedAt: 2026-10-01T09:30:00.000Z\n---\n# Login plan\n\nFirst the session cookie.\n')
  fs.writeFileSync(path.join(enjoy, 'recipes/wf1.md'), '---\nid: wf1\nname: Weekly check\ncron: 0 9 * * 1\ntimezone: Europe/Berlin\nsourceRequest: check weekly\n---\nCheck the login every week.\n')
  fs.writeFileSync(path.join(enjoy, 'attachments/shot.png'), 'png')
  // Claude Code's transcript of the first conversation's session; the others have none.
  const transcripts = path.join(TMP, 'claude', 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(transcripts, { recursive: true })
  fs.writeFileSync(path.join(transcripts, 'enjoy-session-aaaa1111.jsonl'), '')
  fs.mkdirSync(path.join(TMP, 'enjoy', 'projects', 'gone-00000000'))
  fs.writeFileSync(path.join(TMP, 'enjoy', 'projects', 'gone-00000000', 'config.yml'), 'name: Gone\n')

  await page.goto(`${base}/`)
  await page.click('text=Projects')
  await page.click('text=Import from Enjoy…')
  await page.waitForSelector('.import-row:has-text("Demo from Enjoy") >> text=1 conversation · 1 document · 1 workflow')
  // A project whose folder is gone can't be chosen.
  assert.equal(await page.locator('.import-row:has-text("Gone") input').isDisabled(), true)
  await page.click('.dialog-foot button.primary')
  await page.waitForSelector('text=Imported 1 conversation, 1 document and 1 workflow from 1 project.')
  await page.click('.dialog .link')

  const p = (await api('GET', '/projects')).body.find((x) => x.path === folder)
  assert.deepEqual([p.name, p.tint, p.verbosity], ['Demo from Enjoy', '#ffcbe2', 'low'])
  assert.deepEqual(p.agent, { provider: 'claude', model: 'fake-fable[1m]', reasoning: 'ultracode', fast: false, permissionMode: 'auto' })
  assert.equal((await api('GET', `/projects/${p.id}/role`)).body.role, 'Answer in German.\n')
  // The history is private, so the repository does not see it.
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: folder }).toString(), '')

  await page.click('.card:has-text("Fix the login")')
  await page.waitForSelector('.label-pill:has-text("Login fix")')
  await page.waitForSelector('.msg-card.conclusion strong:has-text("auth.ts")')
  await page.waitForSelector('.next-actions >> text=Add a test for it')
  const t = `/projects/${p.id}/threads/aaaa1111`
  const before = (await api('GET', t)).body
  assert.deepEqual(before.messages.map((m) => m.kind), ['user', 'ack', 'conclusion'])
  assert.deepEqual(before.messages[0].images, ['shot.png'])
  assert.deepEqual(before.messages[2].commits, ['a'.repeat(40)])
  assert.deepEqual([before.thread.completed, before.thread.preview, before.thread.label.hue], [false, null, 210])
  assert.deepEqual(before.decisions.map((d) => [d.title, d.options[d.selected], d.resolved]), [['Which provider?', 'Google', true]])
  assert.deepEqual((await api('GET', `${t}/activity`)).body.map((e) => [e.type, e.label]), [['edit', 'Edit · auth.ts']])
  assert.equal((await fetch(`${base}/api${t}/attachments/shot.png`, { headers: { cookie: `savor_token=${token}` } })).status, 200)
  const docs = (await api('GET', `/projects/${p.id}/docs`)).body
  assert.deepEqual(docs.map((d) => [d.id, d.title, d.content, d.updatedAt]), [['doc1', 'Login plan', 'First the session cookie.', '2026-10-01T09:30:00.000Z']])
  const workflows = (await api('GET', `/projects/${p.id}/workflows`)).body
  assert.deepEqual(workflows.map((w) => [w.id, w.name, w.prompt, w.cron, w.timezone, w.enabled]), [['wf1', 'Weekly check', 'Check the login every week.', '0 9 * * 1', 'Europe/Berlin', true]])

  // A follow-up resumes the session the conversation had in Enjoy, with the same settings.
  await send('and now?')
  await page.waitForSelector('text=Echo: and now?')
  const run = fs.readFileSync(AGENT_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.agent === 'claude' && r.cwd === folder).at(-1)
  const arg = (flag) => run.argv[run.argv.indexOf(flag) + 1]
  assert.deepEqual([arg('--resume'), arg('--model'), arg('--effort'), arg('--permission-mode')], ['enjoy-session-aaaa1111', 'fake-fable[1m]', 'xhigh', 'auto'])
  assert.deepEqual(JSON.parse(arg('--settings')), { disableAllHooks: true, fastMode: false, ultracode: true })
  assert.equal(arg('--disallowed-tools'), 'ScheduleWakeup,CronCreate,PushNotification,RemoteTrigger')
  assert.ok(run.argv.includes('--chrome'))
  assert.match(arg('--append-system-prompt'), /Answer in German\./)

  // Importing again: what happened in Enjoy since comes in, what was continued in Savor stays.
  fs.mkdirSync(path.join(enjoy, 'threads/bbbb2222'))
  fs.writeFileSync(path.join(enjoy, 'threads/bbbb2222/messages.md'), thread('bbbb2222').replace('status: idle', 'status: completed'))
  fs.mkdirSync(path.join(enjoy, 'threads/cccc3333'))
  fs.writeFileSync(path.join(enjoy, 'threads/cccc3333/messages.md'), thread('cccc3333'))
  fs.writeFileSync(path.join(enjoy, 'threads/aaaa1111/messages.md'), thread('aaaa1111', '  - id: later\n    role: user\n    text: written in Enjoy later\n    createdAt: 2026-10-02T10:00:00.000Z\n'))
  const second = (await api('POST', '/enjoy', { paths: [folder] })).body[0]
  assert.deepEqual([second.added, second.updated, second.kept, second.documents, second.workflows], [2, 0, 1, 0, 0])
  assert.ok((await api('GET', t)).body.messages.some((m) => m.text === 'Echo: and now?'))
  const done = (await api('GET', `/projects/${p.id}/threads/bbbb2222`)).body.thread
  // An open conversation keeps its preview; a completed one's usually points at a server that is gone.
  assert.deepEqual([done.completed, done.preview], [true, null])
  assert.equal((await api('GET', `/projects/${p.id}/threads/cccc3333`)).body.thread.preview, 'http://localhost:5173/')
  // A Claude session whose transcript is gone is not resumed; the conversation starts a new one.
  assert.deepEqual([before.thread.agentSessions, done.agentSessions], [[{ provider: 'claude', sessionId: 'enjoy-session-aaaa1111' }], []])
  // What changes in Savor alone (here: reopening a completed conversation) survives the next import.
  await api('PATCH', `/projects/${p.id}/threads/bbbb2222`, { completed: false })
  fs.writeFileSync(path.join(enjoy, 'threads/cccc3333/messages.md'), thread('cccc3333', '  - id: later\n    role: user\n    text: written in Enjoy later\n    createdAt: 2026-10-02T10:00:00.000Z\n'))
  const third = (await api('POST', '/enjoy', { paths: [folder] })).body[0]
  assert.deepEqual([third.added, third.updated, third.kept], [0, 1, 2])
  assert.equal((await api('GET', `/projects/${p.id}/threads/cccc3333`)).body.messages.at(-1).text, 'written in Enjoy later')
  assert.equal((await api('GET', `/projects/${p.id}/threads/bbbb2222`)).body.thread.completed, false)
})

test('unpinned projects leave the tab bar and stay in the Projects menu', async () => {
  const other = (await api('GET', '/projects')).body.find((p) => p.path === PROJECT)
  const row = `.menu a[href="#/p/${other.id}"]`
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
  const [one, other] = (await api('GET', `/projects/${project.id}/threads`)).body
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
