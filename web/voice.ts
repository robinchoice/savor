// Voice input: the browser records the microphone, the daemon turns the speech into text with transcribe.cpp.
import { api, readFileAsDataUrl } from './api'

export interface Recording { stop(): Promise<string>; cancel(): void }

// The speech model isn't downloaded yet: the composer offers the download.
export class ModelMissing extends Error {}

export const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`

export interface VoiceModels {
  selected: string
  models: { id: string; name: string; detail: string; license: string; size: number; installed: boolean; downloaded: number | null; error: string | null }[]
}

// The recording turns into text while it runs, so the speaker sees what was understood. The engine needs longer the
// longer the audio, so after a few seconds the part so far is settled at a pause and only what follows is redone.
const SETTLE = 12

export async function record(onText: (text: string) => void): Promise<Recording> {
  // Browsers only offer the microphone to secure pages.
  if (!navigator.mediaDevices) throw new Error('Voice input needs a secure connection: open Savor over https or on localhost.')
  const { ready } = await api<{ ready: boolean }>('POST', '/voice/prepare', {})
  if (!ready) throw new ModelMissing('The speech model is not downloaded yet.')
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((e: Error) => {
    throw new Error(`Microphone: ${e.message}`)
  })
  const context = new AudioContext()
  const rate = context.sampleRate
  let samples = new Float32Array(rate * 60) as Float32Array<ArrayBuffer>
  let length = 0
  let stopped = false
  const finish = () => {
    stopped = true
    stream.getTracks().forEach((t) => t.stop())
    void context.close()
  }
  try {
    const source = context.createMediaStreamSource(stream)
    const tap = context.createScriptProcessor(4096, 1, 1)
    tap.onaudioprocess = (e) => {
      if (stopped) return
      const chunk = e.inputBuffer.getChannelData(0)
      if (length + chunk.length > samples.length) {
        const grown = new Float32Array(samples.length * 2)
        grown.set(samples.subarray(0, length))
        samples = grown
      }
      samples.set(chunk, length)
      length += chunk.length
    }
    source.connect(tap)
    tap.connect(context.destination)
    await context.resume()
  } catch (e) {
    finish()
    throw e
  }

  const join = (...parts: string[]) => parts.filter(Boolean).join(' ')
  const text = (from: number, to: number) => transcribe(samples.slice(from, to), rate)
  let settled = ''
  let from = 0
  let shown = 0
  const live = (async () => {
    while (!stopped) {
      const end = length
      if (end - from > SETTLE * rate) {
        const cut = quietest(samples, from + (SETTLE / 2) * rate, end - rate / 2, rate * 0.3)
        settled = join(settled, await text(from, cut))
        from = cut
      } else if (end - from >= rate / 2 && end > shown) {
        const partial = await text(from, end)
        shown = end
        if (!stopped) onText(join(settled, partial))
      } else await new Promise((resolve) => setTimeout(resolve, 300))
    }
  })()
  live.catch(() => {})
  return {
    async stop() {
      finish()
      await live
      // Under half a second is a double click, not speech.
      if (length < rate / 2) return ''
      return join(settled, await text(from, length))
    },
    cancel: finish,
  }
}

// Where a part of the recording ends: its quietest moment, most likely a pause between words.
function quietest(samples: Float32Array, from: number, to: number, window: number) {
  window = Math.round(window)
  let energy = 0
  let best = Infinity
  let at = to
  for (let i = from; i < to; i++) {
    energy += samples[i] ** 2
    if (i - from < window) continue
    energy -= samples[i - window] ** 2
    if (energy < best) [best, at] = [energy, i - window / 2]
  }
  return Math.round(at)
}

// The daemon takes 16 kHz mono 16-bit PCM. Rendering in an audio context of that rate resamples the recording.
async function transcribe(samples: Float32Array<ArrayBuffer>, rate: number) {
  const context = new OfflineAudioContext(1, Math.ceil((samples.length * 16_000) / rate), 16_000)
  const source = context.createBufferSource()
  source.buffer = context.createBuffer(1, samples.length, rate)
  source.buffer.copyToChannel(samples, 0)
  source.connect(context.destination)
  source.start()
  const pcm = Int16Array.from((await context.startRendering()).getChannelData(0), (s) => Math.max(-1, Math.min(1, s)) * 0x7fff)
  const audio = (await readFileAsDataUrl(new Blob([pcm]))).split(',')[1]
  return (await api<{ text: string }>('POST', '/voice/transcribe', { audio })).text
}
