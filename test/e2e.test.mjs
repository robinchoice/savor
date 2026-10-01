// End-to-end tests: real daemon, real UI in headless Chromium, fake agents (test/fake-claude.mjs, test/fake-codex.mjs).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
let server, browser, page, port, token, base

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const api = async (method, p, body, cookie = `savor_token=${token}`) => {
  const r = await fetch(`${base}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
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
  const entry = fs.existsSync(path.join(ROOT, 'dist/server/index.mjs')) ? 'dist/server/index.mjs' : 'bin/savor.js'
  server = spawn(process.execPath, [path.join(ROOT, entry)], {
    env: {
      ...process.env,
      SAVOR_HOME: HOME,
      SAVOR_PORT: String(port),
      SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'),
      SAVOR_CODEX_BIN: path.join(ROOT, 'test/fake-codex.mjs'),
      FAKE_AGENT_LOG: AGENT_LOG,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
  token = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).token
  browser = await chromium.launch({ executablePath: process.env.SAVOR_CHROMIUM })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.goto(`${base}/?token=${token}`)
})

after(async () => {
  await browser?.close()
  server?.kill()
  fs.rmSync(TMP, { recursive: true, force: true })
})

test('add a project and get a conclusion with next actions', async () => {
  await page.click('text=Projects')
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

test('questions are answered in one reply', async () => {
  await newConversation()
  await send('ask: Ship it?')
  await page.waitForSelector('text=One thing before I continue')
  assert.equal(await page.locator('.filter.attention').count(), 1, 'Needs you filter lights up')
  await page.click('.option:has-text("Yes")')
  await page.click('text=Send reply')
  await page.waitForSelector('text=Selected: Yes')
})

test('approvals are routed to the user', async () => {
  await newConversation()
  await send('approve: now')
  await page.waitForSelector('.approval >> text=Allow')
  await page.click('.approval button:has-text("Allow")')
  await page.waitForSelector('text=Permission: allow')
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
  const again = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, name: 'x' }) })
  assert.equal(again.status, 400)

  // Revoking a LAN device ends its open event stream right away, not only its next request.
  const events = await fetch(`${base}/api/events`, { headers: { cookie: device } })
  const reader = events.body.getReader()
  await reader.read()
  const [paired] = (await api('GET', '/devices')).body
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
