// The daemon as a service restarts into an installed update: with automatic restarts off it only
// offers the restart, switched on it counts down, and "Restart now" ends it right away.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-restart-'))
const HOME = path.join(TMP, 'home')
const APP = path.join(TMP, 'Savor.AppImage')
let server
after(() => {
  server?.kill()
  fs.rmSync(TMP, { recursive: true, force: true })
})

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

async function until(fn, ms) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 500))
  }
}

test('an installed update restarts the daemon after a countdown, or on request', { timeout: 60_000 }, async () => {
  fs.writeFileSync(APP, 'v1')
  const port = await freePort()
  const entry = fs.existsSync(path.join(ROOT, 'dist/server/index.mjs')) ? 'dist/server/index.mjs' : 'bin/savor.js'
  server = spawn(process.execPath, [path.join(ROOT, entry)], { env: { ...process.env, SAVOR_HOME: HOME, SAVOR_PORT: String(port), SAVOR_EXIT_ON_UPDATE: APP }, stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise((resolve) => server.on('exit', resolve))
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
  const { token } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return r.json()
  }

  assert.deepEqual(await api('GET', '/settings'), { autoUpdate: true, autoRestart: true, service: true })
  assert.deepEqual(await api('PATCH', '/settings', { autoRestart: false }), { autoUpdate: true, autoRestart: false, service: true })
  assert.deepEqual(await api('GET', '/restart'), { updated: false, left: null })

  fs.writeFileSync(APP, 'v2')
  // Waiting with the restart switched off: only offered.
  assert.deepEqual(await until(async () => (await api('GET', '/restart')).updated && api('GET', '/restart'), 30_000), { updated: true, left: null })
  // Switched on: the countdown starts.
  await api('PATCH', '/settings', { autoRestart: true })
  const { left } = await api('GET', '/restart')
  assert.ok(left > 20_000 && left <= 30_000, `left: ${left}`)

  await api('POST', '/restart')
  assert.equal(await exited, 0)
})
