// Unattended runs at a usage limit: a conversation a workflow run started goes on with the next agent, and
// waits like the user's own conversations only when every agent is used up.
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-fallback-'))
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

// OpenCode is not installed, so Codex and Antigravity are the agents to go on with.
async function startDaemon() {
  const entry = fs.existsSync(path.join(ROOT, 'dist/server/index.mjs')) ? 'dist/server/index.mjs' : 'bin/savor.js'
  server = spawn(process.execPath, [path.join(ROOT, entry)], {
    env: {
      ...process.env,
      SAVOR_HOME: HOME,
      SAVOR_PORT: String(port),
      SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'),
      SAVOR_CODEX_BIN: path.join(ROOT, 'test/fake-codex.mjs'),
      SAVOR_OPENCODE_BIN: path.join(TMP, 'no-such-opencode'),
      SAVOR_GROK_BIN: path.join(TMP, 'no-such-grok'),
      SAVOR_ANTIGRAVITY_BIN: path.join(ROOT, 'test/fake-agy.mjs'),
      SAVOR_ANTIGRAVITY_HOME: path.join(TMP, 'agy'),
      SAVOR_GH_BIN: path.join(ROOT, 'test/fake-gh.mjs'),
      FAKE_AGENT_LOG: AGENT_LOG,
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'),
      CODEX_HOME: path.join(TMP, 'codex'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
}

test('unattended conversations switch agents at a usage limit, and wait when all are used up', { timeout: 120_000 }, async () => {
  port = await freePort()
  fs.writeFileSync(AGENT_LOG + '.full', '')
  // Claude Code's limits come from its cached usage; the weekly window has reset since.
  const later = new Date(Date.now() + 3_600_000).toISOString()
  const limits = [
    { group: 'session', percent: 40, resets_at: later },
    { group: 'weekly', percent: 90, resets_at: new Date(Date.now() - 60_000).toISOString() },
    { group: 'weekly', percent: 5, resets_at: later, scope: { model: { display_name: 'Fable' } } },
  ]
  fs.mkdirSync(path.join(TMP, 'claude'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'claude', '.claude.json'), JSON.stringify({ cachedUsageUtilization: { utilization: { limits } } }))
  await startDaemon()
  const { token, mcpToken } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return r.json()
  }
  const project = await api('POST', '/projects', { path: path.join(TMP, 'app'), create: true })
  const t = `/projects/${project.id}/threads`
  const read = (id) => api('GET', `${t}/${id}`)

  // A workflow run starts the conversations, as the nightly ones do.
  const wf = await api('POST', `/projects/${project.id}/workflows`, { name: 'Night', prompt: 'roll out' })
  const run = await api('POST', `/projects/${project.id}/workflows/${wf.id}/run`)
  await until(async () => (await read(run.id)).messages.some((m) => m.kind === 'conclusion'))
  const start = async (prompt) => {
    const client = new Client({ name: 'fallback-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?project=${project.id}&thread=${run.id}`), { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
    const { id } = JSON.parse((await client.callTool({ name: 'start_conversation', arguments: { prompt } })).content[0].text)
    await client.close()
    return id
  }

  // Codex and Antigravity are at 100 %: the conversation waits for Claude's reset, on Claude.
  const full = await start('limit-later: all full')
  assert.equal((await read(full)).thread.unattended, true)
  await until(async () => (await read(full)).thread.resumeAt)
  await until(async () => (await api('GET', '/usage')).find((u) => u.provider === 'codex')?.windows[0].percent === 100)
  const claude = (await api('GET', '/usage')).find((u) => u.provider === 'claude')
  assert.deepEqual(claude.windows.map((w) => [w.label, w.percent]), [['5 hours', 40], ['Weekly', 0], ['Weekly · Fable', 5]])
  await new Promise((r) => setTimeout(r, 1000))
  let r = await read(full)
  assert.equal(r.thread.agent.provider, 'claude')
  assert.ok(Date.parse(r.thread.resumeAt) > Date.now() + 50 * 60_000)
  assert.ok(!r.messages.some((m) => m.text?.includes('takes over')))
  await api('POST', `${t}/${full}/stop`)

  // With room left, Codex takes over the same request and is told why.
  server.kill()
  await new Promise((resolve) => server.on('exit', resolve))
  fs.rmSync(AGENT_LOG + '.full')
  await startDaemon()
  const switched = await start('limit-later: switch')
  await until(async () => (await read(switched)).messages.some((m) => m.kind === 'conclusion'))
  r = await read(switched)
  assert.equal(r.messages.find((m) => m.kind === 'conclusion').text, 'Codex echo: limit-later: switch (took over)')
  const update = r.messages.find((m) => m.kind === 'update')
  assert.equal(update.text, 'Claude Code reached its usage limit. Codex takes over.')
  assert.equal(update.modelInfo.provider, 'codex')
  assert.deepEqual([r.thread.agent.provider, r.thread.agent.permissionMode, r.thread.resumeAt, r.thread.error], ['codex', 'auto-review', null, null])
  assert.equal(r.messages.filter((m) => m.kind === 'ack').length, 1)

  // The user's own conversation keeps waiting for the reset.
  const own = (await api('POST', t, { text: 'limit-later: mine' })).id
  await until(async () => (await read(own)).thread.resumeAt)
  r = await read(own)
  assert.equal(r.thread.agent.provider, 'claude')
  assert.ok(!r.messages.some((m) => m.kind === 'update'))
})
