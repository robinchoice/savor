// Unattended runs at a usage limit: a conversation a workflow run started goes on with the next agent, and
// waits like the user's own conversations only when every agent is used up. With a key for API credit, Claude
// Code goes on with that first. With the fallback set on this computer, the user's conversations switch too.
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
  // Claude Code reports its limits on get_usage; the weekly window has reset since.
  const later = new Date(Date.now() + 3_600_000).toISOString()
  const limits = [
    { group: 'session', percent: 40, resets_at: later },
    { group: 'weekly', percent: 90, resets_at: new Date(Date.now() - 60_000).toISOString() },
    { group: 'weekly', percent: 5, resets_at: later, scope: { model: { display_name: 'Fable' } } },
  ]
  fs.writeFileSync(AGENT_LOG + '.limits', JSON.stringify(limits))
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
  // The turn may still be ending: its error goes once it has.
  await until(async () => !(await read(switched)).busy)
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

  // With a key for API credit, Claude Code goes on with it first, up to the budget of a takeover, and the key
  // reaches only its process.
  server.kill()
  await new Promise((resolve) => server.on('exit', resolve))
  const KEY = 'sk-ant-test-0123456789'
  fs.writeFileSync(path.join(TMP, 'secrets'), `# Claude API credit\nexport OTHER=1\nexport FAKE_CREDIT_KEY=${KEY}\n`)
  const state = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  fs.writeFileSync(path.join(HOME, 'state.json'), JSON.stringify({ ...state, apiCredit: { envFile: path.join(TMP, 'secrets'), variable: 'FAKE_CREDIT_KEY', headers: 'anthropic-workspace-id: wrkspc_test', budgetUsd: 5 } }))
  fs.writeFileSync(AGENT_LOG, '')
  await startDaemon()
  const credit = await start('limit-later: credit')
  await until(async () => (await read(credit)).messages.some((m) => m.kind === 'conclusion'))
  r = await read(credit)
  assert.equal(r.messages.find((m) => m.kind === 'conclusion').text, 'Echo: limit-later: credit (on API credit)')
  assert.deepEqual(r.messages.filter((m) => m.kind === 'update').map((m) => m.text), ['Claude Code reached its usage limit and goes on through the API credit, up to $5.'])
  assert.equal(r.thread.agent.provider, 'claude')
  const runs = fs.readFileSync(AGENT_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.agent === 'claude' && l.argv)
  const onCredit = runs.filter((l) => l.apiKey)
  assert.equal(onCredit.length, 1)
  assert.equal(onCredit[0].apiKey, KEY)
  assert.equal(onCredit[0].headers, 'anthropic-workspace-id: wrkspc_test')
  assert.equal(onCredit[0].argv[onCredit[0].argv.indexOf('--max-budget-usd') + 1], '5')
  assert.ok(runs.some((l) => !l.apiKey && !l.argv.includes('--max-budget-usd')))

  // When the credit doesn't carry it either, Codex takes over.
  const empty = await start('limit-later: credit-empty')
  await until(async () => (await read(empty)).messages.some((m) => m.kind === 'conclusion'))
  r = await read(empty)
  assert.equal(r.messages.find((m) => m.kind === 'conclusion').text, 'Codex echo: limit-later: credit-empty (took over)')
  assert.deepEqual(r.messages.filter((m) => m.kind === 'update').map((m) => m.text), ['Claude Code reached its usage limit and goes on through the API credit, up to $5.', 'Claude Code stopped on the API credit too. Codex takes over.'])
  assert.deepEqual([r.thread.agent.provider, r.thread.apiCredit, r.thread.error], ['codex', null, null])

  // The user's own conversation still waits, and the key is nowhere in what Savor keeps.
  const mine = (await api('POST', t, { text: 'limit-later: still mine' })).id
  await until(async () => (await read(mine)).thread.resumeAt)
  assert.ok(!(await read(mine)).messages.some((m) => m.kind === 'update'))
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  for (const f of [...files(HOME), ...files(path.join(TMP, 'app'))]) assert.ok(!fs.readFileSync(f, 'utf8').includes(KEY), f)
})

test('with the fallback on, every conversation switches at a usage limit, skips known limits and goes back after the reset', { timeout: 120_000 }, async () => {
  server.kill()
  await new Promise((resolve) => server.on('exit', resolve))
  await startDaemon()
  const { token } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return r.json()
  }
  const [project] = await api('GET', '/projects')
  const t = `/projects/${project.id}/threads`
  const read = (id) => api('GET', `${t}/${id}`)
  const done = (id, n = 1) => until(async () => (await read(id)).messages.filter((m) => m.kind === 'conclusion').length >= n)

  // Off by default, with the agents workflow runs go on with.
  let f = await api('GET', '/fallback')
  assert.deepEqual([f.on, f.agents.map((a) => a.provider)], [false, ['claude', 'codex', 'antigravity', 'opencode']])
  const codex = { provider: 'codex', model: 'gpt-6.1', reasoning: 'high', fast: false, ultracode: false, permissionMode: 'auto-review' }
  f = await api('PUT', '/fallback', { on: true, agents: [f.agents[0], codex, f.agents[2]] })
  assert.deepEqual([f.on, f.agents[1]], [true, codex])

  // The user's own conversation goes on with Codex, as set there, and keeps Claude as the one to go back to.
  const mine = (await api('POST', t, { text: 'limit-later: with fallback' })).id
  await done(mine)
  let r = await read(mine)
  assert.equal(r.messages.find((m) => m.kind === 'conclusion').text, 'Codex echo: limit-later: with fallback (took over)')
  assert.deepEqual(r.messages.filter((m) => m.kind === 'update').map((m) => m.text), ['Claude Code reached its usage limit. Codex takes over.'])
  assert.deepEqual([r.thread.agent, r.thread.preferred.provider, r.thread.resumeAt], [codex, 'claude', null])
  assert.ok((await api('GET', '/fallback')).limited.includes('claude'))

  // A new conversation for Claude starts on Codex right away.
  const next = (await api('POST', t, { text: 'skip it', agent: { provider: 'claude' } })).id
  await done(next)
  r = await read(next)
  assert.deepEqual(r.messages.filter((m) => m.kind !== 'user').map((m) => [m.kind, m.text]), [['update', 'Claude Code is at its usage limit. Codex takes over.'], ['conclusion', 'Codex echo: skip it']])
  assert.equal(r.thread.agent.provider, 'codex')

  // Once Claude's limit has reset, the next request goes back to it.
  server.kill()
  await new Promise((resolve) => server.on('exit', resolve))
  await startDaemon()
  await api('POST', `${t}/${mine}/messages`, { text: 'back again' })
  await done(mine, 2)
  r = await read(mine)
  assert.equal(r.messages.findLast((m) => m.kind === 'update').text, 'The usage limit of Claude Code has reset. It takes over again.')
  assert.equal(r.messages.findLast((m) => m.kind === 'conclusion').text, 'Echo: back again')
  assert.deepEqual([r.thread.agent.provider, r.thread.preferred], ['claude', null])
})
