#!/usr/bin/env node
// Stand-in for whisper.cpp's whisper-cli used by the end-to-end tests. Instead of a transcript it
// prints what it got: the recording's length and format, the language and the audio context.
// `--help` succeeds like the real CLI, so Savor finds it installed.
import fs from 'node:fs'

const args = process.argv.slice(2)
if (args[0] === '--help') process.exit(0)
const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : 'none')
fs.accessSync(arg('-m'))
const wav = fs.readFileSync(arg('-f'))
const rate = wav.readUInt32LE(24)
const seconds = wav.readUInt32LE(40) / wav.readUInt32LE(28)
console.log(` Heard ${seconds.toFixed(1)} seconds, ${rate} Hz, ${wav.readUInt16LE(22)} channel, ${wav.readUInt16LE(34)} bit,`)
console.log(` language ${arg('-l')}, audio context ${arg('-ac')}.`)
