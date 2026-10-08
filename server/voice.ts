// Voice input: the composer records speech, and transcribe.cpp turns it into text on this computer.
// The engine runs in a process of its own (voice-worker.ts), so a crash in native or GPU code only ends that process.
import { fork, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { emit } from './events.js'
import * as store from './store.js'

// The speech models to choose from, from transcribe.cpp's catalog (github.com/handy-computer/transcribe.cpp),
// pinned to a revision and checked against its SHA-256. The first one is the default.
const MODELS = [
  {
    id: 'parakeet-v3',
    name: 'Parakeet V3',
    detail: 'Fast on any computer. 25 European languages, which it recognizes by itself.',
    license: 'NVIDIA, CC BY 4.0',
    repo: 'handy-computer/parakeet-tdt-0.6b-v3-gguf',
    revision: '85ac09ea12fc4b1112fa76810059364bc6adc9de',
    file: 'parakeet-tdt-0.6b-v3-Q8_0.gguf',
    size: 739508576,
    sha256: '5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7',
  },
  {
    id: 'whisper-small',
    name: 'Whisper Small',
    detail: 'The smallest download, for 99 languages. Slower than Parakeet and less accurate.',
    license: 'OpenAI, Apache 2.0',
    repo: 'handy-computer/whisper-small-gguf',
    revision: 'c0214bd34be9296695486f838e0142f900803159',
    file: 'whisper-small-Q5_K_M.gguf',
    size: 193749056,
    sha256: '326cd00c3e7217c751667c7c1600eaf7e0de174e186ca2c16b4bf590251c3c3b',
  },
  {
    id: 'whisper-turbo',
    name: 'Whisper Large V3 Turbo',
    detail: 'Accurate in 99 languages, but only quick with a GPU, such as an Apple Silicon Mac’s.',
    license: 'OpenAI, Apache 2.0',
    repo: 'handy-computer/whisper-large-v3-turbo-gguf',
    revision: '5eaf945c7978e564bae5b28a5b1639dd93c2bfb1',
    file: 'whisper-large-v3-turbo-Q5_K_M.gguf',
    size: 619628128,
    sha256: '977b5db4e004349dffd1ab9caa10ba5aaba3fc3edd3ba72cadb84328a3203e36',
  },
]
type Model = (typeof MODELS)[number]

const DIR = path.join(store.HOME, 'models')
const fileOf = (m: Model) => path.join(DIR, m.file)
const installed = (m: Model) => fs.existsSync(fileOf(m))
const downloads = new Map<string, { done: number }>()
const failures = new Map<string, string>()
const changed = () => emit({ type: 'voice' })

function find(id: string) {
  const m = MODELS.find((m) => m.id === id)
  if (!m) throw new store.NotFound(`speech model ${id}`)
  return m
}
const selected = () => MODELS.find((m) => m.id === store.state().voiceModel) ?? MODELS[0]

export function models() {
  return {
    selected: selected().id,
    models: MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      detail: m.detail,
      license: m.license,
      size: m.size,
      installed: installed(m),
      downloaded: downloads.get(m.id)?.done ?? null,
      error: failures.get(m.id) ?? null,
    })),
  }
}

export function select(id: string) {
  const s = store.state()
  s.voiceModel = find(id).id
  store.saveState(s)
  changed()
}

export function download(id: string) {
  const m = find(id)
  if (installed(m) || downloads.has(m.id)) return
  const progress = { done: 0 }
  downloads.set(m.id, progress)
  failures.delete(m.id)
  changed()
  fetchModel(m, progress)
    .catch((e) => failures.set(m.id, `Downloading ${m.name} failed: ${e.message}`))
    .finally(() => {
      downloads.delete(m.id)
      changed()
    })
}

// A download that broke off continues where it stopped.
async function fetchModel(m: Model, progress: { done: number }) {
  const part = fileOf(m) + '.part'
  fs.mkdirSync(DIR, { recursive: true })
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0
  if (have < m.size) {
    const res = await fetch(`https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`, { headers: have ? { range: `bytes=${have}-` } : {} })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    // A server that ignores the range sends the whole file again.
    const resumed = res.status === 206
    progress.done = resumed ? have : 0
    let shown = 0
    const count = new Transform({
      transform(chunk: Buffer, _, next) {
        progress.done += chunk.length
        if (Date.now() - shown > 500) {
          shown = Date.now()
          changed()
        }
        next(null, chunk)
      },
    })
    await pipeline(res.body, count, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }))
  }
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(part)) hash.update(chunk)
  if (hash.digest('hex') !== m.sha256) {
    fs.rmSync(part)
    throw new Error('the file arrived damaged, please try again.')
  }
  fs.renameSync(part, fileOf(m))
}

export function remove(id: string) {
  const m = find(id)
  if (engine?.model === fileOf(m)) engine.proc.kill()
  fs.rmSync(fileOf(m), { force: true })
  changed()
}

// ---- the engine process ----

// In development the daemon runs from the TypeScript sources, built from dist/server.
const WORKER = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? 'voice-worker.ts' : 'voice-worker.mjs', import.meta.url))
// An idle engine gives its memory back: Parakeet holds about 1 GB.
const IDLE = 5 * 60_000

class Crash extends Error {}
interface Engine {
  proc: ChildProcess
  model: string
  ready: Promise<unknown>
  calls: Map<number, { resolve: (result: any) => void; reject: (e: Error) => void }>
}
let engine: Engine | null = null
let cpuOnly = false
let idle: NodeJS.Timeout | undefined
let nextCall = 0

function start(model: string): Engine {
  const proc = fork(WORKER, cpuOnly ? ['--cpu'] : [], {
    serialization: 'advanced',
    execArgv: WORKER.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  const e: Engine = { proc, model, ready: Promise.resolve(), calls: new Map() }
  proc.on('message', ({ id, error, ...result }: { id: number; error?: string }) => {
    const pending = e.calls.get(id)
    e.calls.delete(id)
    if (error) pending?.reject(new Error(error))
    else pending?.resolve(result)
  })
  proc.on('exit', (code, signal) => {
    if (engine === e) engine = null
    for (const pending of e.calls.values()) pending.reject(signal === 'SIGTERM' ? new Error('Voice input stopped.') : new Crash(`The speech engine crashed (${signal ?? code}).`))
  })
  e.ready = call(e, { type: 'load', path: model })
  e.ready.catch(() => proc.kill())
  return e
}

function call(e: Engine, message: object) {
  const id = nextCall++
  return new Promise<any>((resolve, reject) => {
    e.calls.set(id, { resolve, reject })
    e.proc.send({ id, ...message })
  })
}

function engineFor(model: string) {
  if (engine?.model !== model) {
    engine?.proc.kill()
    engine = start(model)
  }
  const e = engine
  clearTimeout(idle)
  idle = setTimeout(() => e.proc.kill(), IDLE)
  return e
}

// Recording starts: the engine loads the model while the user speaks, so the text follows right after.
export function prepare() {
  const m = selected()
  if (!installed(m)) return { ready: false }
  engineFor(fileOf(m)).ready.catch(() => {})
  return { ready: true }
}

// Turns 16 kHz mono 16-bit PCM into text, in whatever language it was spoken.
export async function transcribe(pcm: Buffer) {
  const samples = Float32Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768)
  const run = async () => {
    const e = engineFor(fileOf(selected()))
    await e.ready
    const { text } = await call(e, { type: 'transcribe', samples })
    return (text as string).replace(/\s+/g, ' ').trim()
  }
  try {
    return await run()
  } catch (e) {
    // Mostly a GPU driver: the engine tries once more on the CPU alone, and stays there.
    if (!(e instanceof Crash) || cpuOnly) throw e
    cpuOnly = true
    return await run()
  }
}
