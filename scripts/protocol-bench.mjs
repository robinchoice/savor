// Measures how reliably a model follows Savor's message protocol: a dev daemon, a throwaway git project per run
// and real turns through the agent CLI on this computer. Each run is one small task in a new conversation:
// - edit: change a file, then report (acknowledgement, exactly one conclusion)
// - ask: a choice the agent must leave to the user (a conclusion with a question and options, no code yet)
// - commit: fix a bug and commit it (the conclusion names the new commit)
// Usage: node scripts/protocol-bench.mjs [--reps N] [--out file.json] <provider>:<model> ...
//   e.g. node scripts/protocol-bench.mjs --reps 3 opencode:opencode-go/glm-5.3 opencode:ollama/qwen3-4b-24k
// Models of a local Ollama come from `opencode.json` in each project, written from SAVOR_BENCH_OLLAMA (a model
// name, default qwen3-4b-24k). Every run costs real agent turns; the conversations stay in the printed folder.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-bench-'))
const HOME = path.join(TMP, 'home')
const LOG = path.join(TMP, 'daemon.log')
const OLLAMA = process.env.SAVOR_BENCH_OLLAMA || 'qwen3-4b-24k'

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(name)
  return i < 0 ? def : args.splice(i, 2)[1]
}
const REPS = Number(flag('--reps', '3'))
const OUT = flag('--out', path.join(TMP, 'results.json'))
const TIMEOUT = Number(flag('--timeout', '600')) * 1000
const MODELS = args.map((a) => {
  const [provider, ...model] = a.split(':')
  return { provider, model: model.join(':') }
})
if (!MODELS.length) throw new Error('name at least one <provider>:<model>')

const TASKS = {
  edit: {
    text: 'In notes.md, replace the line "status: draft" with "status: done". Change nothing else.',
    check: ({ dir }) => fs.readFileSync(path.join(dir, 'notes.md'), 'utf8').includes('status: done'),
  },
  ask: {
    text: 'Add a function greet(name) to greet.js. Before you write any code, ask me whether it should greet in English or in German, and wait for my answer.',
    check: ({ dir }) => !fs.readFileSync(path.join(dir, 'greet.js'), 'utf8').includes('greet('),
  },
  commit: {
    text: 'sum.js has a bug: sum(a, b) subtracts. Fix it and commit the fix with git.',
    check: ({ dir, head }) => head !== git(dir, 'rev-parse', 'HEAD') && fs.readFileSync(path.join(dir, 'sum.js'), 'utf8').includes('a + b'),
  },
}

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir }).toString().trim()

// A git project of its own per run, so no run sees another's changes or conversation.
function project(name, { provider, model }) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nstatus: draft\n')
  fs.writeFileSync(path.join(dir, 'greet.js'), '// Greetings\n')
  fs.writeFileSync(path.join(dir, 'sum.js'), 'export function sum(a, b) {\n  return a - b\n}\n')
  // OpenCode names conversations with a small model of the default provider, which may be at its limit when the
  // measured one is not: the measured model names them too. A local model on a CPU needs minutes for the first answer.
  if (provider === 'opencode')
    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({
        provider: { ollama: { name: 'Ollama', npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:11434/v1', timeout: false, headerTimeout: false, chunkTimeout: false }, models: { [OLLAMA]: { name: OLLAMA, tools: true } } } },
        small_model: model,
      }),
    )
  fs.writeFileSync(path.join(dir, '.gitignore'), '.savor/\nopencode.json\n')
  git(dir, 'init', '-q', '-b', 'main')
  // A throwaway repo: the agent's commit must not wait for a signing key.
  git(dir, 'config', 'user.name', 'Savor bench')
  git(dir, 'config', 'user.email', 'bench@savor.invalid')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'start')
  return dir
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const port = await freePort()
const base = `http://127.0.0.1:${port}`
const log = fs.openSync(LOG, 'w')
const server = spawn(process.execPath, [path.join(ROOT, 'bin/savor.js')], { env: { ...process.env, SAVOR_HOME: HOME, SAVOR_PORT: String(port) }, stdio: ['ignore', 'pipe', log] })
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One run: the task in a new conversation until the request has a conclusion or an error and the agent is idle,
// or until it hangs: idle for a minute without either, or past the timeout.
async function run(m, task, rep) {
  const dir = project(`${m.model.replace(/\W+/g, '-')}-${task}-${rep}`, m)
  const head = git(dir, 'rev-parse', 'HEAD')
  const p = await api('POST', '/projects', { path: dir, name: path.basename(dir) })
  const started = Date.now()
  const t = await api('POST', `/projects/${p.id}/threads`, { text: TASKS[task].text, agent: { provider: m.provider, model: m.model, reasoning: '', permissionMode: 'build' } })
  let thread
  let idleSince = 0
  let ended = ''
  while (!ended) {
    await sleep(2000)
    thread = await api('GET', `/projects/${p.id}/threads/${t.id}`)
    const done = thread.messages.some((x) => x.kind === 'conclusion' || x.kind === 'error')
    if (thread.busy) idleSince = 0
    else idleSince ||= Date.now()
    if (!thread.busy && done) ended = 'done'
    else if (idleSince && Date.now() - idleSince > 60_000) ended = 'hang'
    else if (Date.now() - started > TIMEOUT) ended = 'timeout'
  }
  const seconds = Math.round((Date.now() - started) / 1000)
  if (ended !== 'done') await api('POST', `/projects/${p.id}/threads/${t.id}/stop`).catch(() => {})
  const activity = JSON.stringify(await api('GET', `/projects/${p.id}/threads/${t.id}/activity`))
  const msgs = thread.messages.filter((x) => x.kind !== 'user')
  const conclusions = msgs.filter((x) => x.kind === 'conclusion')
  // Savor posts the agent's final text as the conclusion when the agent sent no message at all.
  const viaTool = activity.includes('send_conclusion_message')
  const error = msgs.find((x) => x.kind === 'error')?.text ?? ''
  const newHead = git(dir, 'rev-parse', 'HEAD')
  const r = {
    model: m.model,
    task,
    rep,
    seconds,
    ended,
    error: error.slice(0, 200),
    ack: msgs.some((x) => x.kind === 'ack'),
    conclusions: conclusions.length,
    viaTool,
    // Follow-ups Savor sends itself when a turn ends without a conclusion.
    followUps: thread.messages.filter((x) => x.kind === 'user').length - 1,
    question: msgs.some((x) => (x.kind === 'conclusion' || x.kind === 'question') && x.questions?.some((q) => q.options?.length >= 2)),
    commit: task === 'commit' && newHead !== head && conclusions.some((x) => x.commits?.some((c) => newHead.startsWith(c) || c.startsWith(newHead))),
    done: TASKS[task].check({ dir, head }),
  }
  console.log(JSON.stringify(r))
  return r
}

const info = Object.fromEntries((await api('GET', '/agents?refresh')).map((i) => [i.id, i]))
const results = []
for (const m of MODELS) {
  if (!info[m.provider]?.installed || !info[m.provider].signedIn) {
    console.log(`skip  ${m.provider}: not installed or not signed in`)
    continue
  }
  for (let rep = 1; rep <= REPS; rep++)
    for (const task of Object.keys(TASKS)) {
      results.push(await run(m, task, rep).catch((e) => ({ model: m.model, task, rep, ended: 'fail', error: e.message })))
      fs.writeFileSync(OUT, JSON.stringify(results, null, 2))
    }
}

// Per model: how many runs met each part of the protocol. Runs that ended with an error (a usage limit, a crash)
// say nothing about the protocol and count only in the last column.
const pct = (n, d) => (d ? `${n}/${d}` : '–')
console.log('\n| Model | Acknowledgement | Question with options | Exactly one conclusion (tool) | Commit hash | Hanging | Task done | Median s | Errors |')
console.log('|---|---|---|---|---|---|---|---|---|')
for (const m of MODELS) {
  const all = results.filter((r) => r.model === m.model)
  if (!all.length) continue
  const rs = all.filter((r) => !r.error)
  const of = (task) => rs.filter((r) => r.task === task)
  const s = rs.map((r) => r.seconds).sort((a, b) => a - b)
  console.log(
    `| ${m.model} | ${pct(rs.filter((r) => r.ack).length, rs.length)} | ${pct(of('ask').filter((r) => r.question).length, of('ask').length)} | ${pct(rs.filter((r) => r.conclusions === 1 && r.viaTool).length, rs.length)} | ${pct(of('commit').filter((r) => r.commit).length, of('commit').length)} | ${pct(rs.filter((r) => r.ended !== 'done').length, rs.length)} | ${pct(rs.filter((r) => r.done).length, rs.length)} | ${s[Math.floor(s.length / 2)] ?? '–'} | ${all.length - rs.length} |`,
  )
}
console.log(`\nResults: ${OUT}\nConversations and daemon log: ${TMP}`)
server.kill()
await sleep(2000)
process.exit(0)
