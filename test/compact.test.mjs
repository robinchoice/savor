// Idle compaction: Savor compacts an open Claude conversation with a large context before its prompt cache
// expires, also when a restart came in between. Finished conversations and projects that turn it off in
// Claude's settings are left alone, and input that arrives meanwhile waits.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-compact-'))
const HOME = path.join(TMP, 'home')
const AGENT_LOG = path.join(TMP, 'agents.jsonl')
let server, port
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

async function until(fn, ms = 30_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 200))
  }
}

// Agent processes close right after a turn, and conversations of more than 30,000 tokens compact 4 seconds after their last message.
async function startDaemon() {
  const entry = fs.existsSync(path.join(ROOT, 'dist/server/index.mjs')) ? 'dist/server/index.mjs' : 'bin/savor.js'
  server = spawn(process.execPath, [path.join(ROOT, entry)], {
    env: {
      ...process.env,
      SAVOR_HOME: HOME,
      SAVOR_PORT: String(port),
      SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'),
      SAVOR_CODEX_BIN: path.join(TMP, 'no-such-codex'),
      SAVOR_OPENCODE_BIN: path.join(TMP, 'no-such-opencode'),
      SAVOR_GROK_BIN: path.join(TMP, 'no-such-grok'),
      SAVOR_ANTIGRAVITY_BIN: path.join(TMP, 'no-such-agy'),
      SAVOR_GH_BIN: path.join(ROOT, 'test/fake-gh.mjs'),
      SAVOR_IDLE_CLOSE_MS: '100',
      SAVOR_IDLE_COMPACT_MS: '4000',
      CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '30000',
      FAKE_AGENT_LOG: AGENT_LOG,
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve, reject) => {
    const onExit = (code, signal) => reject(new Error(`Daemon exited before startup: code=${code}, signal=${signal}`))
    server.once('error', reject)
    server.once('exit', onExit)
    server.stdout.on('data', (d) => {
      if (!d.toString().includes('Savor running')) return
      server.off('error', reject)
      server.off('exit', onExit)
      resolve()
    })
  })
}

test('open Claude conversations compact when left idle, as Claude settings allow', { timeout: 120_000 }, async () => {
  port = await freePort()
  await startDaemon()
  const { token } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return r.json()
  }
  const project = await api('POST', '/projects', { path: path.join(TMP, 'app'), create: true })
  const off = await api('POST', '/projects', { path: path.join(TMP, 'off'), create: true })
  fs.mkdirSync(path.join(TMP, 'off', '.claude'))
  fs.writeFileSync(path.join(TMP, 'off', '.claude', 'settings.local.json'), JSON.stringify({ idleCompaction: false }))
  const read = (p, id) => api('GET', `/projects/${p.id}/threads/${id}`)
  const start = async (p, text) => {
    const { id } = await api('POST', `/projects/${p.id}/threads`, { text })
    await until(async () => (await read(p, id)).messages.some((m) => m.text === `Echo: ${text}`))
    return id
  }
  const compactions = () => fs.readFileSync(AGENT_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.compact).map((l) => l.compact)
  const sessionOf = async (p, id) => (await read(p, id)).thread.agentSessions[0].sessionId
  fs.writeFileSync(AGENT_LOG + '.release', '/compact')

  // A restart in between: the time still counts from the last message.
  const restarted = await start(project, 'before the restart')
  server.kill()
  await new Promise((resolve) => server.on('exit', resolve))
  await startDaemon()
  await until(async () => (await read(project, restarted)).messages.at(-1).compacted)
  let r = await read(project, restarted)
  assert.deepEqual(r.messages.at(-1).compacted, { from: 38000, to: 4000 })
  assert.equal(r.thread.context.tokens, 4000)
  assert.deepEqual(compactions(), [await sessionOf(project, restarted)])

  // Input during a compaction waits for it.
  fs.rmSync(AGENT_LOG + '.release')
  const open = await start(project, 'open')
  const done = await start(project, 'done')
  await api('PATCH', `/projects/${project.id}/threads/${done}`, { completed: true })
  const disabled = await start(off, 'off')
  await until(async () => compactions().includes(await sessionOf(project, open)))
  await api('POST', `/projects/${project.id}/threads/${open}/messages`, { text: 'meanwhile' })
  await new Promise((r) => setTimeout(r, 500))
  r = await read(project, open)
  assert.equal(r.messages.at(-1).delivered, false)
  assert.equal(r.messages.at(-2).text, 'Echo: open')
  fs.writeFileSync(AGENT_LOG + '.release', '/compact')
  await until(async () => (await read(project, open)).messages.some((m) => m.text === 'Echo: meanwhile'))
  r = await read(project, open)
  assert.deepEqual(r.messages.find((m) => m.text === 'Echo: open').compacted, { from: 38000, to: 4000 })

  // The finished conversation and the project that turns it off are left alone.
  await new Promise((r) => setTimeout(r, 3000))
  for (const [p, id] of [[project, done], [off, disabled]]) {
    assert.ok(!(await read(p, id)).messages.some((m) => m.compacted))
    assert.ok(!compactions().includes(await sessionOf(p, id)))
  }
})
