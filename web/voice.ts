// Voice input: the browser records the microphone, the daemon turns the speech into text with whisper.cpp.
import { api, readFileAsDataUrl } from './api'

export interface Recording { downloading: boolean; stop(): Promise<string>; cancel(): void }

export async function record(): Promise<Recording> {
  // Browsers only offer the microphone to secure pages.
  if (!navigator.mediaDevices) throw new Error('Voice input needs a secure connection: open Savor over https or on localhost.')
  const { downloading } = await api<{ downloading: boolean }>('POST', '/voice/prepare', {})
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
    downloading,
    async stop() {
      await finish()
      const pcm = await toPcm(new Blob(chunks, { type: recorder.mimeType }))
      // Under half a second is a double click, not speech.
      if (pcm.length < 8000) return ''
      const audio = (await readFileAsDataUrl(new Blob([pcm]))).split(',')[1]
      const { text } = await api<{ text: string }>('POST', '/voice/transcribe', { audio, language: navigator.language.split('-')[0].toLowerCase() })
      return text
    },
    cancel: () => void finish(),
  }
}

// whisper.cpp wants 16 kHz mono 16-bit PCM. Decoding in an audio context of that rate resamples the recording.
async function toPcm(blob: Blob) {
  const samples = (await new OfflineAudioContext(1, 1, 16_000).decodeAudioData(await blob.arrayBuffer())).getChannelData(0)
  return Int16Array.from(samples, (s) => Math.max(-1, Math.min(1, s)) * 0x7fff)
}
