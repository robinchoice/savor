import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-pacing-'))
const HOME = path.join(TMP, 'home')
const LOG = path.join(TMP, 'agents.jsonl')
let server, base, port, token, mcpToken
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn) {
  for (let end = Date.now() + 20_000; Date.now() < end;) {
    const value = await fn()
    if (value) return value
    await sleep(50)
  }
  throw new Error('timed out')
}
async function start() {
  server = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.mjs')], {
    env: { ...process.env, SAVOR_HOME: HOME, SAVOR_PORT: String(port), SAVOR_USAGE_URL: '', SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'), SAVOR_CODEX_BIN: path.join(ROOT, 'test/fake-codex.mjs'), SAVOR_CLAUDE_PACING_INTERVAL_MS: '1000', FAKE_AGENT_LOG: LOG, CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'), CODEX_HOME: path.join(TMP, 'codex') },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve())
    server.on('exit', (code) => reject(new Error(`daemon exited ${code}`)))
  })
  ;({ token, mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')))
}
async function stop() {
  if (!server || server.exitCode != null) return
  const exited = new Promise((r) => server.once('exit', r))
  server.kill()
  await exited
}
after(async () => { await stop(); fs.rmSync(TMP, { recursive: true, force: true }) })
const api = async (method, url, body) => {
  const r = await fetch(`${base}/api${url}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  const result = await r.json()
  assert.ok(r.ok, JSON.stringify(result))
  return result
}
const read = (p, t) => api('GET', `/projects/${p.id}/threads/${t.id}`)
const logs = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse) : []
const sample = (percent) => fs.writeFileSync(LOG + '.limits', JSON.stringify([{ group: 'session', percent, resets_at: new Date(Date.now() + 4 * 3600_000).toISOString() }]))
async function workflow(p, prompt) {
  const w = await api('POST', `/projects/${p.id}/workflows`, { name: prompt, prompt })
  return api('POST', `/projects/${p.id}/workflows/${w.id}/run`)
}

test('usage gates background work across projects, persists waits, checkpoints and keeps humans responsive', { timeout: 120_000 }, async () => {
  port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)) })
  })
  base = `http://127.0.0.1:${port}`
  sample(80)
  await start()
  const a = await api('POST', '/projects', { path: path.join(TMP, 'a'), create: true })
  const b = await api('POST', '/projects', { path: path.join(TMP, 'b'), create: true })
  const first = await workflow(a, 'paced: inspect results')
  const second = await workflow(b, 'hello second project')
  await until(async () => (await read(a, first)).thread.budgetWait && (await read(b, second)).thread.budgetWait)
  const client = new Client({ name: 'pacing-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?project=${a.id}&thread=${first.id}`), { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
  const child = JSON.parse((await client.callTool({ name: 'start_conversation', arguments: { project: b.id, prompt: 'workflow child' } })).content[0].text)
  await client.close()
  await until(async () => (await read(b, child)).thread.budgetWait)
  assert.equal((await read(b, child)).thread.unattended, true)
  assert.equal(logs().filter((l) => l.argv).length, 0)
  const human = second
  await api('POST', `/projects/${b.id}/threads/${human.id}/messages`, { text: 'hello human' })
  await until(async () => (await read(b, human)).messages.some((m) => m.kind === 'conclusion'))
  const interactive = logs().find((l) => l.argv)
  assert.ok(!interactive.argv[interactive.argv.indexOf('--disallowed-tools') + 1].includes('Workflow'))
  await stop()
  // A reset without a usable Usage response must not release the saved queue.
  fs.writeFileSync(LOG + '.limits', '[]')
  await start()
  await sleep(1500)
  assert.equal(logs().filter((l) => l.argv).length, 1)
  assert.ok((await read(a, first)).thread.budgetWait)
  await stop()
  sample(0)
  await start()
  await until(async () => (await read(a, first)).messages.some((m) => m.kind === 'conclusion'))
  await until(async () => (await read(b, second)).messages.some((m) => m.kind === 'conclusion'))
  await until(async () => (await read(b, child)).messages.some((m) => m.kind === 'conclusion'))
  await until(async () => !(await read(a, first)).busy)
  const result = await read(a, first)
  assert.equal(result.messages.filter((m) => m.kind === 'ack').length, 1)
  assert.equal(result.messages.find((m) => m.kind === 'conclusion').text, 'Echo: Continue the same request.')
  assert.ok(result.messages.some((m) => m.kind === 'update' && m.text.includes('shared five-hour budget')))
  assert.equal(result.thread.budgetWait, null)
  assert.equal(result.thread.workingSince, null)
  assert.ok(result.messages.filter((m) => m.kind === 'update' && m.text.includes('queued against')).length >= 2)
  const background = logs().filter((l) => l.argv && l.argv[l.argv.indexOf('--disallowed-tools') + 1].includes('Workflow'))
  assert.ok(background.length >= 2)
  for (const l of background) {
    const denied = l.argv[l.argv.indexOf('--disallowed-tools') + 1].split(',')
    for (const name of ['Agent', 'Task', 'Workflow']) assert.ok(denied.includes(name))
    const settings = JSON.parse(l.argv[l.argv.indexOf('--settings') + 1])
    assert.equal(settings.disableWorkflows, true)
  }
  assert.ok(logs().some((l) => l.hooks?.PostToolBatch?.[0].hookCallbackIds.includes('savor_budget')))
  assert.ok(logs().some((l) => l.unsolicitedDenied === true))

  const slow = await workflow(a, 'slow: occupies the shared slot')
  await until(async () => (await read(a, slow)).messages.some((m) => m.kind === 'ack'))
  const waiting = await workflow(b, 'must stay queued')
  await until(async () => (await read(b, waiting)).thread.budgetWait)
  const queued = await Promise.all(['first addition', 'second addition'].map((text) => api('POST', `/projects/${a.id}/threads/${slow.id}/messages`, { text })))
  const steered = await Promise.all(queued.map((m) => api('POST', `/projects/${a.id}/threads/${slow.id}/messages/${m.id}/steer`)))
  assert.ok(steered.every((r) => r.steered))
  await until(() => logs().filter((l) => l.steerAccepted === true).length === 2)
  await api('POST', `/projects/${b.id}/threads/${waiting.id}/stop`)
  await api('POST', `/projects/${a.id}/threads/${slow.id}/stop`)
  await sleep(1500)
  assert.equal((await read(b, waiting)).thread.resumeAt, null)
  assert.ok(!(await read(b, waiting)).messages.some((m) => m.kind === 'conclusion'))
  const owned = await workflow(a, 'own-server: preserve work on a human reply')
  await until(async () => (await read(a, owned)).messages.some((m) => m.kind === 'conclusion'))
  await until(async () => !(await read(a, owned)).busy)
  const beforeReply = logs().filter((l) => l.argv).length
  await api('POST', `/projects/${a.id}/threads/${owned.id}/messages`, { text: 'keep working' })
  await until(async () => (await read(a, owned)).messages.some((m) => m.text === 'Echo: keep working'))
  assert.equal(logs().filter((l) => l.argv).length, beforeReply)
  assert.equal((await read(a, owned)).background, true)
  await api('POST', `/projects/${a.id}/threads/${owned.id}/stop`)
  fs.writeFileSync(LOG + '.reject-hooks', '')
  const incompatible = await workflow(a, 'reject missing checkpoint support')
  await until(async () => (await read(a, incompatible)).thread.error)
  assert.match((await read(a, incompatible)).thread.error, /could not install the budget checkpoint/)
  assert.ok(!(await read(a, incompatible)).messages.some((m) => m.kind === 'ack'))
  fs.unlinkSync(LOG + '.reject-hooks')
})
