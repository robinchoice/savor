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

export async function record(): Promise<Recording> {
  // Browsers only offer the microphone to secure pages.
  if (!navigator.mediaDevices) throw new Error('Voice input needs a secure connection: open Savor over https or on localhost.')
  const { ready } = await api<{ ready: boolean }>('POST', '/voice/prepare', {})
  if (!ready) throw new ModelMissing('The speech model is not downloaded yet.')
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((e: Error) => {
    throw new Error(`Microphone: ${e.message}`)
  })
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream)
    recorder.start()
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    throw e
  }
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => chunks.push(e.data)
  const stopped = new Promise((resolve) => (recorder.onstop = resolve))
  const finish = () => {
    if (recorder.state !== 'inactive') recorder.stop()
    stream.getTracks().forEach((t) => t.stop())
    return stopped
  }
  return {
    async stop() {
      await finish()
      const pcm = await toPcm(new Blob(chunks, { type: recorder.mimeType }))
      // Under half a second is a double click, not speech.
      if (pcm.length < 8000) return ''
      const audio = (await readFileAsDataUrl(new Blob([pcm]))).split(',')[1]
      const { text } = await api<{ text: string }>('POST', '/voice/transcribe', { audio })
      return text
    },
    cancel: () => void finish(),
  }
}

// The daemon takes 16 kHz mono 16-bit PCM. Decoding in an audio context of that rate resamples the recording.
async function toPcm(blob: Blob) {
  const samples = (await new OfflineAudioContext(1, 1, 16_000).decodeAudioData(await blob.arrayBuffer())).getChannelData(0)
  return Int16Array.from(samples, (s) => Math.max(-1, Math.min(1, s)) * 0x7fff)
}
