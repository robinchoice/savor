// Terminals in server/terminal.ts: the screen a window gets when it opens, and the shell's environment.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-terminal-'))
process.env.SAVOR_HOME = HOME
process.env.SHELL = '/bin/sh'
// As in the desktop app on Linux, which runs from an AppImage's mount.
const MOUNT = '/tmp/.mount_SavorTest'
Object.assign(process.env, { APPDIR: MOUNT, APPIMAGE: '/opt/Savor.AppImage', GSETTINGS_SCHEMA_DIR: `${MOUNT}/usr/share/glib-2.0/schemas`, XDG_DATA_DIRS: `${MOUNT}/usr/share/:/usr/share` })
const terminal = await import('../server/terminal.ts')
after(() => fs.rmSync(HOME, { recursive: true, force: true }))

const until = async (check) => {
  for (let i = 0; i < 100; i++) if (await check()) return
  else await new Promise((r) => setTimeout(r, 50))
  assert.fail('timed out')
}

// A window watching a terminal, with the messages it got.
function viewer(t) {
  const res = Object.assign(new EventEmitter(), { messages: [], writeHead() {}, write(chunk) { if (chunk.startsWith('data: ')) res.messages.push(JSON.parse(chunk.slice(6))) } })
  terminal.watch(t, res, false)
  return res
}

test('a window that opens later gets the screen with the modes the program set', async () => {
  const { id } = terminal.add('p1', HOME)
  const t = terminal.get('p1', id)
  await terminal.start(t, 80, 24)
  const first = viewer(t)
  terminal.input(t, "printf '\\033[?2004h\\033[?1049h%s\\n' alt-screen-on\n")
  await until(() => first.messages.some((m) => m.o?.includes('alt-screen-on\r\n')))
  // Far more output than the last raw bytes kept would have held before.
  terminal.input(t, "i=0; while [ $i -lt 3000 ]; do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done; echo done-\"\"marker\n")
  await until(() => first.messages.map((m) => m.o ?? '').join('').includes('done-marker'))

  const later = viewer(t)
  await until(() => later.messages.length)
  const [shown] = later.messages
  assert.equal(shown.reset, true)
  assert.equal(shown.running, true)
  assert.match(shown.o, /\x1b\[\?1049h/)
  assert.match(shown.o, /\x1b\[\?2004h/)
  assert.match(shown.o, /done-marker/)
  assert.ok(shown.o.length < 200_000)

  // Output after it opened follows the screen.
  terminal.input(t, 'echo after-""open\n')
  await until(() => later.messages.some((m) => m.o?.includes('after-open')))
  terminal.close(t)
  first.emit('close')
  later.emit('close')
})

test("the shell gets the user's environment, not the AppImage's", async () => {
  const { id } = terminal.add('p2', HOME)
  const t = terminal.get('p2', id)
  await terminal.start(t, 80, 24)
  const v = viewer(t)
  terminal.input(t, 'echo "[$XDG_DATA_DIRS|${GSETTINGS_SCHEMA_DIR-unset}|${APPDIR-unset}|${APPIMAGE-unset}]"\n')
  await until(() => v.messages.some((m) => m.o?.includes('[/usr/share|')))
  assert.ok(v.messages.map((m) => m.o ?? '').join('').includes('[/usr/share|unset|unset|unset]'))
  terminal.close(t)
  v.emit('close')
})
