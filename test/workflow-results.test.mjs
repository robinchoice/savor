import { test, before, after } from 'node:test'
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-workflow-results-'))
const HOME = path.join(TMP, 'home')
const LOG = path.join(TMP, 'agents.jsonl')
let server, port, token, mcpToken, project, base
const clients = []

async function until(fn) {
  for (let end = Date.now() + 20000; Date.now() < end;) {
    const value = await fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('timed out')
}
async function start() {
  server = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.mjs')], {
    env: { ...process.env, SAVOR_HOME: HOME, SAVOR_PORT: String(port), SAVOR_CODEX_BIN: path.join(ROOT, 'test/fake-codex.mjs'), SAVOR_GH_BIN: path.join(ROOT, 'test/fake-gh.mjs'), FAKE_AGENT_LOG: LOG, CODEX_HOME: path.join(TMP, 'codex') },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve())
    server.on('exit', (code) => reject(new Error(`daemon exited ${code}`)))
  })
  ;({ token, mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')))
}
async function stop() {
  for (const c of clients.splice(0)) await c.close()
  const exited = new Promise((r) => server.once('exit', r))
  server.kill()
  await exited
}
const api = async (method, url, body, status = 200) => {
  const r = await fetch(`${base}/api${url}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  const result = await r.json()
  assert.equal(r.status, status, JSON.stringify(result))
  return result
}
const checkConfig = (name) => ({ file: `.workflow-checks/${name}.json`, maxAgeSeconds: 60 })
const signal = (name, patch = {}) => {
  fs.writeFileSync(path.join(project.path, checkConfig(name).file), JSON.stringify({ checkedAt: new Date().toISOString(), status: 'ok', work: false, pending: false, reason: 'Versions and commits unchanged; no pending checks.', evidence: ['agent 1.2.3, commit abc123, pending queue empty'], followUp: [], ...patch }))
}
const workflow = (name, patch = {}) => api('POST', `/projects/${project.id}/workflows`, { name, prompt: 'inspect work', preflight: checkConfig(name), ...patch })
const run = (wf) => api('POST', `/projects/${project.id}/workflows/${wf.id}/run`)
const runs = (wf) => api('GET', `/projects/${project.id}/workflows/${wf.id}/runs`)
const read = (t) => api('GET', `/projects/${project.id}/threads/${t.id}`)
const done = (t) => until(async () => !(await read(t)).busy)
const result = (status, followUp = []) => ({ status, reason: `Outcome ${status}`, evidence: ['verified check output'], followUp })
async function mcp(t) {
  const client = new Client({ name: 'workflow-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?project=${project.id}&thread=${t.id}`), { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
  clients.push(client)
  return async (name, args, error = false) => {
    const r = await client.callTool({ name, arguments: args })
    assert.equal(!!r.isError, error, JSON.stringify(r))
    return error ? r : JSON.parse(r.content[0].text)
  }
}

before(async () => {
  port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
  base = `http://127.0.0.1:${port}`
  await start()
  project = await api('POST', '/projects', { path: path.join(TMP, 'app'), create: true })
  await api('PATCH', `/projects/${project.id}`, { agent: { provider: 'codex', model: 'fake', permissionMode: 'read-only' } })
  fs.mkdirSync(path.join(project.path, '.workflow-checks'))
})
after(async () => { if (server?.exitCode === null) await stop(); fs.rmSync(TMP, { recursive: true, force: true }) })

test('idle work, missing prerequisites and invalid preflights never start a model', async () => {
  const idle = await workflow('idle')
  signal('idle')
  const t = await run(idle)
  assert.equal((await read(t)).messages.length, 0)
  assert.equal((await read(t)).thread.completed, true)
  let [r] = await runs(idle)
  assert.equal(r.outcome, 'skipped')
  assert.equal(r.modelStarted, false)
  assert.equal(r.workedMs, 0)
  assert.equal(r.usd, undefined)
  assert.equal(r.tokens, undefined)
  assert.ok(r.elapsedMs >= 0)
  assert.equal(fs.existsSync(LOG), false)
  for (const [name, data, expected] of [
    ['missing', null, 'blocked'],
    ['stale', { checkedAt: '2020-01-01T00:00:00.000Z' }, 'blocked'],
    ['future', { checkedAt: '2099-01-01T00:00:00.000Z' }, 'blocked'],
    ['blocked', { status: 'blocked', followUp: ['Unlock signing access.'] }, 'blocked'],
    ['failed', { status: 'failed', followUp: ['Repair producer.'] }, 'failed'],
    ['invalid', { work: 'unknown' }, 'failed'],
  ]) {
    const wf = await workflow(name)
    if (data) signal(name, data)
    await run(wf)
    ;[r] = await runs(wf)
    assert.equal(r.outcome, expected, name)
    assert.equal(r.modelStarted, false)
    assert.ok(r.steps[0].result.followUp.length)
  }
  assert.equal(fs.existsSync(LOG), false)
})

test('pending checks run despite identical versions; blocked runs resume after restart without new conversations', async () => {
  const wf = await workflow('recheck')
  const t = await run(wf)
  assert.equal((await runs(wf))[0].outcome, 'blocked')
  await stop()
  await start()
  signal('recheck', { pending: true, followUp: ['Repeat the failed countercheck.'] })
  const resumed = await run(wf)
  assert.equal(resumed.id, t.id)
  await done(t)
  let [r] = await runs(wf)
  assert.equal(r.modelStarted, true)
  assert.equal(r.outcome, 'unknown')
  assert.equal(r.attemptCounts.resume, 1)
  assert.equal(r.attempts.filter((a) => a.kind === 'check').length, 2)
  assert.ok(r.tokens > 0)
  const call = await mcp(t)
  await call('report_workflow_result', { id: wf.id, result: result('blocked', ['Countercheck needs access.']) })
  await api('PATCH', `/projects/${project.id}/threads/${t.id}`, { completed: true })
  assert.equal((await runs(wf))[0].outcome, 'blocked')
  signal('recheck')
  assert.equal((await run(wf)).id, t.id)
  assert.equal((await runs(wf))[0].outcome, 'blocked', 'idle proof cannot close an unfinished countercheck')
  signal('recheck', { pending: true, followUp: ['Repeat countercheck.'] })
  const [a, b] = await Promise.all([run(wf), run(wf)])
  assert.equal(a.id, t.id)
  assert.equal(b.id, t.id)
  await done(t)
  assert.equal((await runs(wf)).length, 1)
  assert.equal((await read(t)).messages.filter((m) => m.kind === 'user').length, 2)
  await call('report_workflow_result', { id: wf.id, result: result('successful') })
  assert.equal((await call('list_workflow_runs', { id: wf.id }))[0].outcome, 'successful')
})

test('new work starts and permission mode remains read-only; existing ungated workflows still start normally', async () => {
  const wf = await workflow('newwork')
  signal('newwork', { work: true, reason: 'New relevant commit def456.' })
  const t = await run(wf)
  await done(t)
  const r = (await read(t)).thread
  assert.equal(r.agent.permissionMode, 'read-only')
  assert.equal((await runs(wf))[0].outcome, 'unknown', 'finished turns do not imply success')
  const legacy = await workflow('legacy', { preflight: null })
  const first = await run(legacy)
  await done(first)
  const second = await run(legacy)
  await done(second)
  assert.notEqual(first.id, second.id)
})

test('a running workflow recovers the same request after a restart and counts human input separately', async () => {
  const wf = await workflow('interrupted')
  signal('interrupted', { work: true })
  const t = await run(wf)
  await done(t)
  await api('POST', `/projects/${project.id}/threads/${t.id}/messages`, { text: 'slow: workflow recovery' })
  await until(async () => (await read(t)).thread.workingSince)
  await stop()
  await start()
  await until(async () => (await read(t)).busy)
  assert.equal((await run(wf)).id, t.id)
  fs.writeFileSync(LOG + '.release', 'slow: workflow recovery')
  await done(t)
  const [r] = await runs(wf)
  assert.equal((await runs(wf)).length, 1)
  assert.equal(r.attemptCounts.restart, 1)
  assert.equal(r.attemptCounts.human, 1)
  assert.equal((await read(t)).messages.filter((m) => m.kind === 'user').length, 2)
})

test('a scheduled slot resumed into an existing run is not dispatched again after restart', async () => {
  const wf = await workflow('slot', { cron: '0 0 1 1 *' })
  const t = await run(wf)
  signal('slot', { work: true })
  const file = path.join(project.path, '.savor/workflows', `${wf.id}.json`)
  const unset = () => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), settledAt: '2000-01-01T00:00:00.000Z' }))
  unset()
  await api('PUT', `/projects/${project.id}/workflows/${wf.id}`, { name: 'slot resumed' })
  await done(t)
  const call = await mcp(t)
  await call('report_workflow_result', { id: wf.id, result: result('successful') })
  unset()
  await stop()
  await start()
  assert.equal((await runs(wf)).length, 1)
  assert.equal((await runs(wf))[0].attemptCounts.resume, 1)
})

test('intentional waiting is preserved even after closing the conversation', async () => {
  const wf = await workflow('waiting', { cron: '0 0 1 1 *' })
  signal('waiting', { work: true })
  const t = await run(wf)
  await done(t)
  const call = await mcp(t)
  await call('report_workflow_result', { id: wf.id, result: result('waiting', ['Wait for the approved choice.']) })
  await api('PATCH', `/projects/${project.id}/threads/${t.id}`, { completed: true })
  const file = path.join(project.path, '.savor/workflows', `${wf.id}.json`)
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), settledAt: '2000-01-01T00:00:00.000Z' }))
  await api('PUT', `/projects/${project.id}/workflows/${wf.id}`, { name: 'waiting on user' })
  assert.equal((await runs(wf))[0].outcome, 'waiting')
  assert.equal((await runs(wf))[0].attemptCounts.start, 1)
  assert.ok((await runs(wf)).some((r) => r.status === 'skipped'))
  assert.equal((await run(wf)).id, t.id)
  await done(t)
  assert.equal((await runs(wf))[0].attemptCounts.resume, 1, 'manual run can explicitly resume intentional waiting without an open question')
})

test('ungated workflows start fresh after delegation, waiting and closing an unanswered question', async () => {
  const wf = await workflow('legacy-outcomes', { preflight: null, cron: '0 0 1 1 *' })
  const t = await run(wf)
  await done(t)
  const call = await mcp(t)
  const child = await call('start_conversation', { prompt: 'Inspect one delegated outcome.' })
  await done({ id: child.id })
  assert.equal((await runs(wf))[0].outcome, 'partial')
  const second = await run(wf)
  assert.notEqual(second.id, t.id)
  await done(second)
  const secondCall = await mcp(second)
  await secondCall('report_workflow_result', { id: wf.id, result: result('waiting', ['Wait for a choice.']) })
  const threadFile = path.join(project.path, '.savor/threads', second.id, 'thread.json')
  fs.writeFileSync(threadFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(threadFile, 'utf8')), needsYou: true }))
  await api('PATCH', `/projects/${project.id}/threads/${second.id}`, { completed: true })
  const file = path.join(project.path, '.savor/workflows', `${wf.id}.json`)
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), settledAt: '2000-01-01T00:00:00.000Z' }))
  await api('PUT', `/projects/${project.id}/workflows/${wf.id}`, { name: 'legacy schedule' })
  await until(async () => (await runs(wf)).length === 3)
  const [scheduled] = await runs(wf)
  await done({ id: scheduled.threadId })
  assert.notEqual(scheduled.threadId, second.id)
  assert.equal((await runs(wf)).find((r) => r.threadId === t.id).outcome, 'partial')
  assert.equal((await runs(wf)).find((r) => r.threadId === second.id).outcome, 'waiting')
})

test('a human reply releases business waiting instead of permanently suppressing the gated workflow', async () => {
  const wf = await workflow('reply')
  signal('reply', { work: true })
  const t = await run(wf)
  await done(t)
  const call = await mcp(t)
  await call('report_workflow_result', { id: wf.id, result: result('waiting', ['Choose one action.']) })
  await api('POST', `/projects/${project.id}/threads/${t.id}/messages`, { text: 'Use the first action.' })
  await done(t)
  assert.equal((await runs(wf))[0].outcome, 'partial')
  assert.equal((await run(wf)).id, t.id)
  await done(t)
  assert.equal((await runs(wf))[0].attemptCounts.resume, 1)
})

test('optional conclusion questions do not overwrite an already successful business result', async () => {
  const wf = await workflow('success-question', { preflight: null })
  const t = await run(wf)
  await done(t)
  const call = await mcp(t)
  await call('report_workflow_result', { id: wf.id, result: result('successful') })
  await api('POST', `/projects/${project.id}/threads/${t.id}/messages`, { text: 'slow: optional question' })
  await call('send_conclusion_message', { text: 'Optional follow-up.', questions: [{ title: 'Another independent task?', options: [] }] })
  assert.equal((await runs(wf))[0].outcome, 'successful')
  await api('POST', `/projects/${project.id}/threads/${t.id}/stop`)
  fs.writeFileSync(LOG + '.release', 'slow: optional question')
  await done(t)
})

test('manual starts of ungated workflows remain independent, including a paused workflow', async () => {
  const wf = await workflow('manual-legacy', { preflight: null, enabled: false })
  const t = await run(wf)
  await done(t)
  assert.equal((await runs(wf))[0].modelStarted, true)
  await api('POST', `/projects/${project.id}/threads/${t.id}/messages`, { text: 'slow: independent manual start' })
  const next = await run(wf)
  assert.notEqual(next.id, t.id)
  await done(next)
  fs.writeFileSync(LOG + '.release', 'slow: independent manual start')
  await done(t)
})

test('early checks without an agent start do not consume the upcoming scheduled slot', async () => {
  for (const name of ['early-idle', 'early-blocked']) {
    const wf = await workflow(name, { cron: '0 * * * *' })
    if (name === 'early-idle') signal(name)
    const file = path.join(project.path, '.savor/workflows', `${wf.id}.json`)
    const before = JSON.parse(fs.readFileSync(file, 'utf8')).settledAt
    await api('POST', `/projects/${project.id}/workflows/${wf.id}/run`, { early: true })
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settledAt, before)
    signal(name, { work: true })
    const started = await api('POST', `/projects/${project.id}/workflows/${wf.id}/run`, { early: true })
    await done(started)
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).settledAt > before)
    const call = await mcp(started)
    await call('report_workflow_result', { id: wf.id, result: result('waiting', ['Wait for a decision.']) })
    const nextSlot = JSON.parse(fs.readFileSync(file, 'utf8')).settledAt
    // An actual open question must not be bypassed by the early-run button.
    const threadFile = path.join(project.path, '.savor/threads', started.id, 'thread.json')
    fs.writeFileSync(threadFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(threadFile, 'utf8')), needsYou: true }))
    assert.equal((await api('POST', `/projects/${project.id}/workflows/${wf.id}/run`, { early: true })).id, started.id)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settledAt, nextSlot)
    await api('PUT', `/projects/${project.id}/workflows/${wf.id}`, { enabled: false })
  }
})

test('linked steps are gated, cycles settle once, and delegation requires explicit verification', async () => {
  const child = await workflow('child')
  signal('child')
  const wf = await workflow('parent', { preflight: null, next: [child.id] })
  await api('PUT', `/projects/${project.id}/workflows/${child.id}`, { next: [wf.id] })
  const t = await run(wf)
  await done(t)
  const call = await mcp(t)
  await call('report_workflow_result', { id: child.id, result: result('successful') }, true)
  assert.equal((await call('begin_workflow_step', { id: child.id })).run, false)
  const delegated = await call('start_conversation', { prompt: 'Verify one fix.' })
  await until(async () => !(await api('GET', `/projects/${project.id}/threads/${delegated.id}`)).busy)
  await api('PATCH', `/projects/${project.id}/threads/${delegated.id}`, { completed: true })
  await call('report_workflow_result', { id: wf.id, result: result('successful') }, true)
  assert.equal((await runs(wf))[0].outcome, 'partial')
  await call('report_workflow_result', { id: wf.id, result: result('successful'), verifiedDelegations: [{ threadId: delegated.id, evidence: 'Fix commit and its checks independently verified.' }] })
  assert.equal((await runs(wf))[0].outcome, 'successful')
  assert.equal((await call('begin_workflow_step', { id: wf.id })).run, false)
  assert.equal((await runs(wf))[0].steps.length, 2)
})

test('missing linked work stays blocked until its definition is explicitly corrected', async () => {
  const wf = await workflow('missing-linked', { next: ['missing-step'] })
  signal('missing-linked', { work: true })
  const t = await run(wf)
  await done(t)
  const call = await mcp(t)
  await call('report_workflow_result', { id: wf.id, result: result('successful') })
  const missing = await call('begin_workflow_step', { id: 'missing-step' })
  assert.equal(missing.run, false)
  assert.equal((await runs(wf))[0].outcome, 'blocked')
  const messages = (await read(t)).messages.length
  assert.equal((await run(wf)).id, t.id)
  assert.equal((await runs(wf))[0].outcome, 'blocked')
  await api('PUT', `/projects/${project.id}/workflows/${wf.id}`, { next: [] })
  assert.equal((await run(wf)).id, t.id)
  const [resolved] = await runs(wf)
  assert.equal(resolved.outcome, 'successful')
  assert.equal(resolved.steps.find((s) => s.id === 'missing-step').result.status, 'skipped')
  assert.equal((await read(t)).messages.length, messages, 'correcting an unstarted missing step does not rerun completed work')
})

test('preflight configuration cannot introduce execution or escape its project directory', async () => {
  for (const preflight of [
    { command: 'touch /tmp/unsafe', maxAgeSeconds: 60 },
    { file: '../elsewhere.json', maxAgeSeconds: 60 },
    { file: '/tmp/outside.json', maxAgeSeconds: 60 },
    { file: '.env', maxAgeSeconds: 60 },
    { file: '.workflow-checks/check.json', maxAgeSeconds: 0 },
  ]) await api('POST', `/projects/${project.id}/workflows`, { name: 'unsafe', prompt: 'x', preflight }, 400)
  const wf = await workflow('link')
  const outside = path.join(TMP, 'outside.json')
  fs.writeFileSync(outside, JSON.stringify({ private: 'do-not-return' }))
  fs.symlinkSync(outside, path.join(project.path, checkConfig('link').file))
  const t = await run(wf)
  assert.equal((await runs(wf))[0].outcome, 'failed')
  assert.ok(!JSON.stringify(await runs(wf)).includes('do-not-return'))
  assert.equal((await read(t)).messages.length, 0)
})
