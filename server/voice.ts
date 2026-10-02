// Voice input: the composer records speech, and whisper.cpp turns it into text on this computer.
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { BIN, WHISPER_MODEL } from './config.js'
import { HOME } from './store.js'

// The languages whisper knows. For any other browser language it detects the language itself, which takes an extra pass.
const LANGUAGES = new Set('en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue'.split(' '))

const MODEL = WHISPER_MODEL.endsWith('.bin') ? WHISPER_MODEL : path.join(HOME, 'models', `ggml-${WHISPER_MODEL}.bin`)
let download: Promise<void> | null = null

async function downloadModel() {
  const res = await fetch(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${path.basename(MODEL)}`)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  fs.mkdirSync(path.dirname(MODEL), { recursive: true })
  await pipeline(res.body, fs.createWriteStream(MODEL + '.part'))
  fs.renameSync(MODEL + '.part', MODEL)
}

// Like Chromium for the preview, the model is downloaded on first use.
function ensureModel() {
  if (fs.existsSync(MODEL)) return Promise.resolve()
  download ??= downloadModel()
    .catch((e) => {
      throw new Error(`Downloading the speech model ${path.basename(MODEL)} failed: ${e.message}`)
    })
    .finally(() => (download = null))
  return download
}

// Checks that whisper.cpp is installed, and starts a missing model's download so it runs while the user speaks.
export async function prepare() {
  const found = await new Promise<boolean>((resolve) => execFile(BIN.whisper, ['--help'], { timeout: 10_000 }, (err) => resolve(!err)))
  if (!found) throw new Error(`Voice input needs whisper.cpp: install it (macOS: brew install whisper-cpp, others: github.com/ggml-org/whisper.cpp) so that ${BIN.whisper} is on the PATH, or set SAVOR_WHISPER_BIN.`)
  const downloading = !fs.existsSync(MODEL)
  if (downloading) ensureModel().catch(() => {})
  return { downloading }
}

// Turns 16 kHz mono 16-bit PCM into text.
export async function transcribe(pcm: Buffer, language: string) {
  await ensureModel()
  const file = path.join(os.tmpdir(), `savor-voice-${crypto.randomUUID()}.wav`)
  fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length), pcm]), { mode: 0o600 })
  const args = ['-m', MODEL, '-l', LANGUAGES.has(language) ? language : 'auto', '-nt', '-np', '-f', file]
  // whisper.cpp encodes 30-second windows. A shorter recording only needs audio context for its own
  // length (50 per second, plus a second to spare), which makes it several times faster.
  const context = Math.ceil((pcm.length / 32_000) * 50) + 50
  if (context < 1500) args.push('-ac', String(context))
  try {
    const out = await new Promise<string>((resolve, reject) =>
      execFile(BIN.whisper, args, (err, stdout, stderr) => (err ? reject(new Error(stderr.trim().split('\n').pop() || err.message)) : resolve(stdout))),
    )
    return out.replace(/\s+/g, ' ').trim()
  } finally {
    fs.rmSync(file, { force: true })
  }
}

function wavHeader(size: number) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + size, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(16_000, 24)
  h.writeUInt32LE(32_000, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(size, 40)
  return h
}
