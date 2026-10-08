// The speech engine's process, started by voice.ts: transcribe.cpp runs native and GPU code, and a crash here
// leaves the daemon running.
import { pathToFileURL } from 'node:url'
import type { TranscribeModel } from 'transcribe-cpp'

// The end-to-end tests swap in a fake engine.
const engine: Promise<typeof import('transcribe-cpp')> = import(process.env.SAVOR_TRANSCRIBE_MODULE ? pathToFileURL(process.env.SAVOR_TRANSCRIBE_MODULE).href : 'transcribe-cpp')
let model: TranscribeModel | null = null

process.on('message', async ({ id, type, path, samples }: { id: number; type: 'load' | 'transcribe'; path: string; samples: Float32Array }) => {
  try {
    if (type === 'load') {
      model = await (await engine).TranscribeModel.load(path, process.argv.includes('--cpu') ? { backend: 'cpu' } : {})
      process.send!({ id })
    } else {
      process.send!({ id, text: (await model!.transcribe(samples)).text })
    }
  } catch (e) {
    process.send!({ id, error: (e as Error).message })
  }
})
// The daemon is gone.
process.on('disconnect', () => process.exit())
