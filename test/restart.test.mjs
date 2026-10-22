// The daemon as a service restarts into an installed update: with automatic restarts off it only
// offers the restart, switched on it counts down, and "Restart now" ends it right away.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-restart-'))
const HOME = path.join(TMP, 'home')
const APP = path.join(TMP, 'Savor.AppImage')
const AGENT_LOG = path.join(TMP, 'agents.jsonl')
let server
after(() => {
  server?.kill()
  fs.rmSync(TMP, { recursive: true, force: true })
})

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

async function until(fn, ms) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 500))
  }
}

test('an installed update restarts the daemon after a countdown, or on request', { timeout: 60_000 }, async () => {
  fs.writeFileSync(APP, 'v1')
  const port = await freePort()
  const entry = fs.existsSync(path.join(ROOT, 'dist/server/index.mjs')) ? 'dist/server/index.mjs' : 'bin/savor.js'
  server = spawn(process.execPath, [path.join(ROOT, entry)], { env: { ...process.env, SAVOR_HOME: HOME, SAVOR_PORT: String(port), SAVOR_EXIT_ON_UPDATE: APP, SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'), CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'), FAKE_AGENT_LOG: AGENT_LOG }, stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise((resolve) => server.on('exit', resolve))
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
  const { token } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return r.json()
  }

  assert.deepEqual(await api('GET', '/settings'), { autoUpdate: true, autoRestart: true, service: true, usagePing: null, pushDelay: 5 })
  assert.deepEqual(await api('PATCH', '/settings', { autoRestart: false }), { autoUpdate: true, autoRestart: false, service: true, usagePing: null, pushDelay: 5 })
  assert.deepEqual(await api('GET', '/restart'), { updated: false, left: null })

  // The service keeps watching its AppImage, but its agents must not pass that watch to test daemons.
  const project = await api('POST', '/projects', { path: path.join(TMP, 'project'), create: true })
  const thread = await api('POST', `/projects/${project.id}/threads`, { text: 'check the environment' })
  await until(async () => (await api('GET', `/projects/${project.id}/threads/${thread.id}`)).messages.some((m) => m.text === 'Echo: check the environment'), 10_000)
  const launches = fs.readFileSync(AGENT_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(launches.length > 0)
  assert.ok(launches.every((launch) => launch.exitOnUpdate === undefined))

  fs.writeFileSync(APP, 'v2')
  // Waiting with the restart switched off: only offered.
  assert.deepEqual(await until(async () => (await api('GET', '/restart')).updated && api('GET', '/restart'), 30_000), { updated: true, left: null })
  // Switched on: the countdown starts.
  await api('PATCH', '/settings', { autoRestart: true })
  const { left } = await api('GET', '/restart')
  assert.ok(left > 20_000 && left <= 30_000, `left: ${left}`)

  await api('POST', '/restart')
  assert.equal(await exited, 0)
})

test('background work starts immediately and retired budget waits resume without delaying real limits', { timeout: 60_000 }, async () => {
  const port = await freePort()
  const start = async () => {
    server = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.mjs')], {
      env: { ...process.env, SAVOR_HOME: HOME, SAVOR_PORT: String(port), SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'), SAVOR_CODEX_BIN: path.join(TMP, 'no-codex'), SAVOR_ANTIGRAVITY_BIN: path.join(TMP, 'no-agy'), SAVOR_GROK_BIN: path.join(TMP, 'no-grok'), SAVOR_OPENCODE_BIN: path.join(TMP, 'no-opencode'), CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'), FAKE_AGENT_LOG: AGENT_LOG },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve())
      server.once('exit', (code) => reject(new Error(`daemon exited ${code}`)))
    })
  }
  const stop = async () => {
    const exited = new Promise((resolve) => server.once('exit', resolve))
    server.kill()
    await exited
  }
  const { token } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const api = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    assert.ok(r.ok)
    return r.json()
  }
  fs.writeFileSync(AGENT_LOG + '.limits', JSON.stringify([{ group: 'session', percent: 80, resets_at: new Date(Date.now() + 4 * 3600_000).toISOString() }]))
  await start()
  const p = await api('POST', '/projects', { path: path.join(TMP, 'background'), create: true })
  const q = await api('POST', '/projects', { path: path.join(TMP, 'parallel'), create: true })
  const read = (project, thread) => api('GET', `/projects/${project.id}/threads/${thread.id}`)
  const run = async (project, prompt) => {
    const wf = await api('POST', `/projects/${project.id}/workflows`, { name: prompt, prompt })
    return api('POST', `/projects/${project.id}/workflows/${wf.id}/run`)
  }
  const waiting = await run(p, 'slow: waiting before admission')
  const checkpoint = await run(q, 'slow: /already-executed')
  await until(async () => (await read(p, waiting)).busy && (await read(q, checkpoint)).messages.some((m) => m.kind === 'ack'), 15_000)
  const parallel = await run(q, 'runs alongside other projects')
  await until(async () => (await read(q, parallel)).messages.some((m) => m.kind === 'conclusion'), 15_000)
  assert.equal((await read(p, waiting)).busy, true)
  const limited = await api('POST', `/projects/${p.id}/threads`, { text: 'limit-later: real limit' })
  const resumeAt = await until(async () => (await read(p, limited)).thread.resumeAt, 15_000)
  await stop()
  // Simulate both kinds of persisted waits from the previous release.
  for (const [project, thread, note] of [[p, waiting, ''], [q, checkpoint, 'Continue the same request from the completed tool results. Savor paused before the next model call to pace the shared Claude budget. ']]) {
    const file = path.join(project.path, '.savor', 'threads', thread.id, 'thread.json')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!note) {
      saved.agentSessions = []
      const messages = path.join(path.dirname(file), 'messages.jsonl')
      const input = fs.readFileSync(messages, 'utf8').trim().split('\n').map(JSON.parse).find((m) => m.kind === 'user')
      fs.writeFileSync(messages, JSON.stringify(input) + '\n')
    }
    fs.writeFileSync(file, JSON.stringify({ ...saved, budgetWait: { note }, resumeAt: new Date(Date.now() + 3600_000).toISOString() }))
  }
  fs.writeFileSync(AGENT_LOG + '.release', 'slow: waiting before admission')
  await start()
  await until(async () => (await read(p, waiting)).messages.some((m) => m.kind === 'conclusion') && (await read(q, checkpoint)).messages.some((m) => m.kind === 'conclusion'), 15_000)
  for (const [project, thread] of [[p, waiting], [q, checkpoint]]) {
    const state = await read(project, thread)
    assert.equal(state.thread.resumeAt, null)
    assert.equal('budgetWait' in state.thread, false)
    assert.equal(state.messages.filter((m) => m.kind === 'ack').length, 1)
    assert.ok(!state.messages.some((m) => m.kind === 'update' && m.text.includes('five-hour budget')))
  }
  assert.equal((await read(p, waiting)).messages.find((m) => m.kind === 'conclusion').text, 'Echo: waiting before admission')
  assert.equal((await read(q, checkpoint)).messages.find((m) => m.kind === 'conclusion').text, 'Echo: Continue the same request.')
  assert.equal((await read(p, limited)).thread.resumeAt, resumeAt)
  const launches = fs.readFileSync(AGENT_LOG, 'utf8').trim().split('\n').map(JSON.parse).filter((l) => l.argv)
  for (const { argv } of launches) {
    const denied = argv[argv.indexOf('--disallowed-tools') + 1].split(',')
    assert.ok(['Agent', 'Task', 'Workflow'].every((name) => !denied.includes(name)))
    assert.equal(JSON.parse(argv[argv.indexOf('--settings') + 1]).disableWorkflows, undefined)
  }
  await stop()
})
