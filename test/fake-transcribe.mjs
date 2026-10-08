// Stand-in for transcribe.cpp used by the end-to-end tests. Instead of a transcript it says what it got:
// the recording's length and kind, and the model file.
import fs from 'node:fs'
import path from 'node:path'

export class TranscribeModel {
  static async load(file) {
    fs.accessSync(file)
    return Object.assign(new TranscribeModel(), { file })
  }

  async transcribe(samples) {
    return { text: ` Heard ${(samples.length / 16000).toFixed(1)} seconds of ${samples.constructor.name} with ${path.basename(this.file)}. ` }
  }
}
