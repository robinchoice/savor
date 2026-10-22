// A hard reset can leave zeros, blank and cut-off lines in a conversation's activity (22 Oct 2026): the
// daemon starts anyway, continues the conversation the reset cut off and keeps what was in it. A request
// that keeps getting cut off by restarts is continued only a few times.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-crash-'))
const HOME = path.join(TMP, 'home')
const AGENT_LOG = path.join(TMP, 'agents.jsonl')
let server
let output = ''
after(() => {
  server?.kill('SIGKILL')
  fs.rmSync(TMP, { recursive: true, force: true })
})

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

async function until(fn, ms = 20_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out; daemon output:\n${output}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

let port
async function start() {
  const entry = fs.existsSync(path.join(ROOT, 'dist/server/index.mjs')) ? 'dist/server/index.mjs' : 'bin/savor.js'
  server = spawn(process.execPath, [path.join(ROOT, entry)], { env: { ...process.env, SAVOR_HOME: HOME, SAVOR_PORT: String(port), SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'), CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'), FAKE_AGENT_LOG: AGENT_LOG }, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stderr.on('data', (d) => (output += d))
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => ((output += d), String(d).includes('Savor running') && resolve()))
    server.on('exit', (code) => reject(new Error(`daemon exited with ${code}:\n${output}`)))
  })
}

// Like the hard reset: no shutdown, the agents are cut off.
async function crash() {
  const exited = new Promise((resolve) => server.on('exit', resolve))
  server.kill('SIGKILL')
  await exited
}

const api = async (method, p, body) => {
  const { token } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  return r.json()
}
const launches = () => fs.readFileSync(AGENT_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.argv?.includes('--mcp-config'))

test('a damaged activity log neither stops the daemon nor loses the conversation', { timeout: 120_000 }, async () => {
  port = await freePort()
  await start()
  const project = await api('POST', '/projects', { path: path.join(TMP, 'app'), create: true })
  const thread = await api('POST', `/projects/${project.id}/threads`, { text: 'slow: build it' })
  const read = () => api('GET', `/projects/${project.id}/threads/${thread.id}`)
  await until(async () => (await read()).messages.some((m) => m.kind === 'ack'))
  await crash()

  const file = path.join(project.path, '.savor/threads', thread.id, 'activity.jsonl')
  const before = { id: 41, type: 'note', label: 'Before the reset', time: new Date().toISOString() }
  fs.appendFileSync(file, `${JSON.stringify(before)}\n${'\0'.repeat(380)}\n   \n{"id":42,"type":"note","lab`)
  const damaged = fs.readFileSync(file, 'utf8')
  const messages = fs.readFileSync(path.join(project.path, '.savor/threads', thread.id, 'messages.jsonl'), 'utf8')

  fs.writeFileSync(AGENT_LOG + '.release', 'slow: build it')
  await start()
  await until(async () => (await read()).messages.some((m) => m.text === 'Echo: build it (after a restart)'))
  const activity = await api('GET', `/projects/${project.id}/threads/${thread.id}/activity`)
  assert.ok(activity.some((e) => e.id === 41 && e.label === 'Before the reset'))
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.startsWith(damaged), 'the activity log keeps what was in it')
  assert.ok(fs.readFileSync(path.join(project.path, '.savor/threads', thread.id, 'messages.jsonl'), 'utf8').startsWith(messages))
  // What comes after the cut-off line starts on a line of its own.
  for (const line of text.slice(damaged.length).split('\n').filter(Boolean)) JSON.parse(line)

  // The conversation goes on as usual.
  await api('POST', `/projects/${project.id}/threads/${thread.id}/messages`, { text: 'and on' })
  await until(async () => (await read()).messages.some((m) => m.text === 'Echo: and on'))
  const r = await read()
  assert.equal(r.thread.error, null)
  assert.equal(server.exitCode, null)
  assert.ok(!output.includes('Uncaught error'), output)
})

test('a request that restarts keep cutting off waits for the user after three', { timeout: 120_000 }, async () => {
  const project = await api('POST', '/projects', { path: path.join(TMP, 'loop'), create: true })
  const thread = await api('POST', `/projects/${project.id}/threads`, { text: 'slow: never done' })
  const read = () => api('GET', `/projects/${project.id}/threads/${thread.id}`)
  await until(async () => (await read()).messages.some((m) => m.kind === 'ack'))
  const runs = () => launches().filter((l) => l.cwd === project.path).length
  for (let i = 1; i <= 3; i++) {
    await crash()
    await start()
    await until(() => runs() === i + 1)
  }
  await crash()
  await start()
  const r = await until(async () => {
    const r = await read()
    return r.thread.error && r
  })
  assert.match(r.thread.error, /restarted 3 times/)
  assert.equal(r.thread.workingSince, null)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  assert.equal(runs(), 4)
})
