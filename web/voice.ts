// Voice input: the browser records the microphone, the daemon turns the speech into text with transcribe.cpp.
import { api, readFileAsDataUrl } from './api'
import { t } from './i18n'

// stop() ends the recording and turns what isn't text yet into text. When that fails, the audio stays and stop()
// tries again.
export interface Recording { stop(): Promise<string>; cancel(): void }

// The speech model isn't downloaded yet: the composer offers the download.
export class ModelMissing extends Error {}
// The recording holds nothing to turn into text, so trying again won't help.
export class NothingHeard extends Error {}

export const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`

export interface VoiceModels {
  selected: string
  models: { id: string; name: string; detail: string; license: string; size: number; installed: boolean; downloaded: number | null; error: string | null }[]
}

// The recording turns into text while it runs, so the speaker sees what was understood. The engine needs longer the
// longer the audio, so after a few seconds the part so far is settled at a pause and only what follows is redone.
const SETTLE = 12
// Below this peak level the microphone delivered silence: muted, the wrong input device, or taken by another tab.
const SILENT = 1e-4

export async function record(onText: (text: string) => void): Promise<Recording> {
  // Browsers only offer the microphone to secure pages.
  if (!navigator.mediaDevices) throw new Error(t('Voice input needs a secure connection: open Savor over https or on localhost.'))
  const { ready } = await api<{ ready: boolean }>('POST', '/voice/prepare', {})
  if (!ready) throw new ModelMissing(t('The speech model is not downloaded yet.'))
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((e: Error) => {
    throw new Error(`${t('Microphone:')} ${e.message}`)
  })
  const context = new AudioContext()
  const rate = context.sampleRate
  let samples = new Float32Array(rate * 60) as Float32Array<ArrayBuffer>
  let length = 0
  let peak = 0
  let stopped = false
  const started = Date.now()
  // Ends the live loop's pause, so stop() doesn't wait for it.
  let wake = () => {}
  const finish = () => {
    if (stopped) return
    stopped = true
    wake()
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
      for (const s of chunk) peak = Math.max(peak, Math.abs(s))
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
  // No part is longer than SETTLE, also when the parts before it failed for a while.
  const settle = async (end: number) => {
    const cut = quietest(samples, from + (SETTLE / 2) * rate, Math.min(end - rate / 2, from + SETTLE * rate), rate * 0.3)
    settled = join(settled, await text(from, cut))
    from = cut
  }
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      wake = () => (clearTimeout(timer), resolve())
    })
  let failures = 0
  const live = (async () => {
    while (!stopped) {
      const end = length
      try {
        // Silence has nothing to hear. Said early, the speaker can check the microphone before the recording is over.
        if (peak < SILENT) {
          if (Date.now() - started > 3000) onText(t('No sound from the microphone so far.'))
          await sleep(300)
        } else if (end - from > SETTLE * rate) await settle(end)
        // Half a second of new speech at a time: each request carries the whole unsettled part, through the relay too.
        else if (end - from >= rate / 2 && end - shown >= rate / 2) {
          const partial = await text(from, end)
          shown = end
          if (!stopped) onText(join(settled, partial))
        } else await sleep(300)
        failures = 0
      } catch {
        // E.g. while the relay reconnects: the part is tried again, and stop() does what is left.
        await sleep(Math.min(1000 * 2 ** failures++, 10_000))
      }
    }
  })()
  return {
    async stop() {
      finish()
      await live
      if (length < rate / 2) {
        // Less than half a second of audio within a second is a double click, not speech.
        if (Date.now() - started < 1000) return ''
        throw new NothingHeard(t('No sound arrived from the microphone.'))
      }
      if (peak < SILENT) throw new NothingHeard(t('The microphone delivered only silence. Check the input device and whether another tab or app is using it.'))
      while (length - from > SETTLE * rate) await settle(length)
      if (length > from) {
        settled = join(settled, await text(from, length))
        from = length
      }
      if (!settled) {
        // The audio stays, e.g. to try again with another speech model.
        from = 0
        throw new Error(t('No speech was recognized in the recording.'))
      }
      return settled
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
  const buffer = context.createBuffer(1, samples.length, rate)
  // Filled before it goes to the source: Firefox takes the buffer's contents when it is assigned and renders silence.
  buffer.copyToChannel(samples, 0)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.start()
  const pcm = Int16Array.from((await context.startRendering()).getChannelData(0), (s) => Math.max(-1, Math.min(1, s)) * 0x7fff)
  const audio = (await readFileAsDataUrl(new Blob([pcm]))).split(',')[1]
  return (await api<{ text: string }>('POST', '/voice/transcribe', { audio })).text
}
