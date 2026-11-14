// Checks this checkout against the newest agent CLIs: installs the latest Claude Code, Codex and OpenCode
// into ~/.cache/savor-upstream-check, starts a
// daemon with them and runs one real conversation per agent: a prompt, a permission request, an
// interrupt. It uses the agents' logins on this computer, so it runs as a weekly Savor workflow on the
// maintainer's computer, not in CI. An agent whose CLI is not on this computer or that is not signed in
// here is skipped. Exits 1 when an agent broke.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(os.homedir(), '.cache', 'savor-upstream-check')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-upstream-'))
const HOME = path.join(TMP, 'home')
const LOG = path.join(TMP, 'daemon.log')
// Each agent's last result, which scripts/upstream-preflight.mjs compares with the newest versions.
const STATE = process.env.SAVOR_UPSTREAM_STATE || path.join(os.homedir(), '.local', 'state', 'savor-upstream-check', 'last-run.json')

// The cheapest model that still uses tools reliably, where the agent lets us pick one.
const AGENTS = [
  { provider: 'claude', pkg: '@anthropic-ai/claude-code', bin: 'claude', env: 'SAVOR_CLAUDE_BIN', agent: { model: 'haiku', reasoning: '', permissionMode: 'manual' } },
  { provider: 'codex', pkg: '@openai/codex', bin: 'codex', env: 'SAVOR_CODEX_BIN', agent: { model: '', reasoning: 'low', permissionMode: 'read-only' } },
  { provider: 'opencode', pkg: 'opencode-ai', bin: 'opencode', env: 'SAVOR_OPENCODE_BIN', agent: { model: '', reasoning: '', permissionMode: 'build' } },
]
// Agents named on the command line, e.g. `node scripts/upstream-check.mjs opencode`, are the only ones checked.
// Without names, an agent whose CLI is not on this computer is skipped and keeps its last result.
const only = process.argv.slice(2)
const onComputer = (bin) => (path.isAbsolute(bin) ? [''] : [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')]).some((dir) => fs.existsSync(path.join(dir, bin)))
const missing = only.length ? [] : AGENTS.filter((a) => !onComputer(a.bin))
for (const a of missing) console.log(`skip  ${a.provider}: ${a.bin} is not on this computer`)
AGENTS.splice(0, AGENTS.length, ...AGENTS.filter((a) => (only.length ? only.includes(a.provider) : !missing.includes(a))))

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

async function until(what, fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${what}`)
}

console.log(`Installing the latest CLIs into ${CACHE}`)
fs.mkdirSync(CACHE, { recursive: true })
if (AGENTS.length) execFileSync('npm', ['install', '--prefix', CACHE, '--no-audit', '--no-fund', '--loglevel=error', ...AGENTS.map((a) => `${a.pkg}@latest`)], { stdio: 'inherit' })
const bin = (a) => path.join(CACHE, 'node_modules', '.bin', a.bin)
for (const a of AGENTS) {
  try {
    a.version = execFileSync(bin(a), ['--version']).toString().trim()
  } catch {
    a.version = 'not installed'
  }
}

const port = await freePort()
const base = `http://127.0.0.1:${port}`
const log = fs.openSync(LOG, 'w')
const server = spawn(process.execPath, [path.join(ROOT, 'bin/savor.js')], {
  env: { ...process.env, SAVOR_HOME: HOME, SAVOR_PORT: String(port), ...Object.fromEntries(AGENTS.map((a) => [a.env, bin(a)])) },
  stdio: ['ignore', 'pipe', log],
})
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => {
    fs.writeSync(log, d)
    if (d.toString().includes('Savor running')) resolve()
  })
  server.on('exit', (code) => reject(new Error(`daemon exited with ${code}, see ${LOG}`)))
})
const token = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).token

async function api(method, p, body) {
  const r = await fetch(`${base}/api${p}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  const json = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(json)}`)
  return json
}

// The messages after the user message `mid`, once its request has ended; an error ends it too.
async function answered(pid, tid, mid, ms) {
  return until(
    'the answer',
    async () => {
      const t = await api('GET', `/projects/${pid}/threads/${tid}`)
      const after = t.messages.slice(t.messages.findIndex((m) => m.id === mid) + 1)
      const error = after.find((m) => m.kind === 'error' && m.text !== 'Turn stopped.')
      if (error) throw new Error(`error: ${error.text}`)
      return !t.busy && after.some((m) => m.kind === 'conclusion') && after
    },
    ms,
  )
}

async function pendingApproval(pid, tid) {
  const { messages } = await api('GET', `/projects/${pid}/threads/${tid}`)
  const error = messages.find((m) => m.kind === 'error')
  if (error) throw new Error(`error: ${error.text}`)
  return messages.find((m) => m.approval?.status === 'pending')
}

async function approve(pid, tid, m) {
  const choice = m.approval.options.find((o) => o.kind === 'allow').id
  await api('POST', `/projects/${pid}/threads/${tid}/approvals/${m.id}`, { choice })
}

async function check(a) {
  const dir = path.join(TMP, a.provider)
  const p = await api('POST', '/projects', { path: dir, name: a.provider, create: true })
  if (a.provider === 'claude') {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(touch savor-check.txt)'] } }))
  }
  // OpenCode runs commands without asking unless its config says otherwise.
  if (a.provider === 'opencode') fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ permission: { bash: 'ask' } }))
  const marker = path.join(dir, 'savor-check.txt')
  const text = `This is an automated compatibility check. Run exactly this shell command and nothing else: touch savor-check.txt. Then reply with "check ok".`

  const t = await api('POST', `/projects/${p.id}/threads`, { text, agent: { provider: a.provider, ...a.agent } })
  const first = (await api('GET', `/projects/${p.id}/threads/${t.id}`)).messages.find((m) => m.kind === 'user')
  const approval = await until('a permission request', () => pendingApproval(p.id, t.id), 180_000)
  if (fs.existsSync(marker)) throw new Error('the command ran before permission was granted')
  await approve(p.id, t.id, approval)
  await answered(p.id, t.id, first.id, 180_000)
  if (!fs.existsSync(marker)) throw new Error('the allowed command did not run')

  // An interrupt: "Send now" stops a long command, and the queued message gets its answer.
  // Not `sleep`: Claude Code 2.1.319 blocks a foreground `sleep N` before it runs.
  const long = await api('POST', `/projects/${p.id}/threads/${t.id}/messages`, { text: 'Run exactly this shell command in the foreground, not in the background: tail -f /dev/null. It never ends on its own: this check stops it to test interrupting a running command. Then reply with "stopped".' })
  const command = async () => (await api('GET', `/projects/${p.id}/threads/${t.id}/activity`)).find((e) => e.type === 'command' && /tail -f \/dev\/null/.test(e.label))
  const asked = await until('the long command', async () => (await pendingApproval(p.id, t.id)) || ((await command()) && 'running'), 180_000)
  if (asked !== 'running') await approve(p.id, t.id, asked)
  await new Promise((r) => setTimeout(r, 5000))
  // A turn that already ended would take the next message right away, and "Send now" would stop that one.
  const ran = await command()
  if (!ran || ran.finishedAt || !(await api('GET', `/projects/${p.id}/threads/${t.id}`)).busy) {
    const said = (await api('GET', `/projects/${p.id}/threads/${t.id}`)).messages.filter((m) => m.kind === 'conclusion').at(-1)?.text ?? ''
    throw new Error(`the long command ${ran?.finishedAt ? `ended after ${Date.parse(ran.finishedAt) - Date.parse(ran.time)} ms` : 'did not run'} before "Send now"${said ? `; the agent said: ${said.slice(0, 200)}` : ''}`)
  }
  const next = await api('POST', `/projects/${p.id}/threads/${t.id}/messages`, { text: 'Stop waiting and reply with just "interrupted".' })
  await api('POST', `/projects/${p.id}/threads/${t.id}/send-now`)
  await answered(p.id, t.id, next.id, 240_000)
}

const failed = []
const results = {}
const info = Object.fromEntries((await api('GET', '/agents?refresh')).map((i) => [i.id, i]))
for (const a of AGENTS) {
  const started = Date.now()
  const at = new Date().toISOString()
  if (!info[a.provider]?.installed || !info[a.provider].signedIn) {
    const reason = info[a.provider]?.installed ? `not signed in, run ${info[a.provider].signIn}` : 'not installed'
    results[a.provider] = { version: a.version, result: 'skip', reason, at }
    console.log(`skip  ${a.provider} ${a.version}: ${reason}`)
    continue
  }
  try {
    await check(a)
    results[a.provider] = { version: a.version, result: 'ok', at }
    console.log(`ok    ${a.provider} ${a.version} (${Math.round((Date.now() - started) / 1000)}s)`)
  } catch (e) {
    failed.push(a.provider)
    results[a.provider] = { version: a.version, result: 'fail', reason: e.message, at }
    console.log(`FAIL  ${a.provider} ${a.version}: ${e.message}`)
  }
}
// A run of only some agents keeps the others' last results.
let state = {}
try {
  state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
} catch {}
fs.mkdirSync(path.dirname(STATE), { recursive: true })
fs.writeFileSync(`${STATE}.tmp`, JSON.stringify({ ...state, ...results }, null, 2))
fs.renameSync(`${STATE}.tmp`, STATE)

server.kill()
await new Promise((r) => setTimeout(r, 2000))
// A failed run keeps the conversations (<agent>/.savor/threads) and the daemon log for the fix.
if (failed.length) console.log(`\nThe conversations and the daemon log are in ${TMP}`)
else fs.rmSync(TMP, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
