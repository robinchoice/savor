// End-to-end test of remote access through the relay: real relay, real daemon, UI served by the
// relay in headless Chromium, fake agent. Also checks that the relay only ever sees ciphertext.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-relay-'))
const TAP = path.join(TMP, 'tap.log')
const children = []
let browser, page, daemonBase, relayBase, token

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

function start(entry, env, ready) {
  const child = spawn(process.execPath, [path.join(ROOT, entry)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(child)
  return new Promise((resolve) => child.stdout.on('data', (d) => d.toString().includes(ready) && resolve()))
}

const local = async (method, p, body) => {
  const r = await fetch(`${daemonBase}/api${p}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  return r.json()
}

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('timed out')
}

before(async () => {
  const [daemonPort, relayPort] = [await freePort(), await freePort()]
  daemonBase = `http://127.0.0.1:${daemonPort}`
  relayBase = `http://127.0.0.1:${relayPort}`
  await start('dist/relay/server.mjs', { RELAY_PORT: String(relayPort), RELAY_TAP_FILE: TAP }, 'Savor relay listening')
  await start(
    'dist/server/index.mjs',
    { SAVOR_HOME: path.join(TMP, 'home'), SAVOR_PORT: String(daemonPort), SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs') },
    'Savor running',
  )
  token = JSON.parse(fs.readFileSync(path.join(TMP, 'home/state.json'), 'utf8')).token
  fs.mkdirSync(path.join(TMP, 'project'))
  await local('POST', '/projects', { path: path.join(TMP, 'project') })
  await local('PUT', '/relay', { url: relayBase, enabled: true })
  await until(async () => (await local('GET', '/relay')).state === 'online')
  browser = await chromium.launch({ executablePath: process.env.SAVOR_CHROMIUM })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
})

after(async () => {
  await browser?.close()
  for (const c of children) c.kill()
  fs.rmSync(TMP, { recursive: true, force: true })
})

test('state.json is readable by the owner only', () => {
  assert.equal(fs.statSync(path.join(TMP, 'home/state.json')).mode & 0o777, 0o600)
})

test('a wrong pairing code is rejected', async () => {
  const { relayUrl } = await local('POST', '/devices/pairing')
  await page.goto(relayUrl.replace(/\/[0-9A-F]+$/, '/0000000000'))
  await page.click('button:has-text("Pair")')
  await page.waitForSelector('text=Pairing code invalid or expired.')
})

test('pair through the relay and work on the project remotely', async () => {
  const { relayUrl } = await local('POST', '/devices/pairing')
  assert.ok(relayUrl.startsWith(relayBase))
  await page.goto(relayUrl)
  await page.fill('input', 'CI phone')
  await page.click('button:has-text("Pair")')
  await page.waitForSelector('text=What do you want to build?')
  await page.fill('.composer textarea', 'hello through the relay')
  await page.keyboard.press('Enter')
  await page.waitForSelector('text=Echo: hello through the relay')

  const devices = await local('GET', '/devices')
  assert.deepEqual(
    devices.map((d) => [d.name, d.via]),
    [['CI phone', 'relay']],
  )
  assert.equal(await page.locator('.account svg').count(), 1, 'account shows a remote device')

  const tapped = fs.readFileSync(TAP, 'utf8')
  assert.ok(tapped.length > 1000, 'traffic went through the relay')
  for (const plain of ['hello through the relay', 'Echo:', 'Fake agent test', token]) assert.ok(!tapped.includes(plain), `relay saw "${plain}"`)
})

test('the live preview streams through the tunnel', async () => {
  await page.click('button[title="Side panel"]')
  await page.click('.panel-tabs >> text=Preview')
  await page.fill('.preview-bar input', relayBase + '/healthz')
  assert.equal(await page.inputValue('.preview-bar input'), relayBase + '/healthz')
  await page.keyboard.press('Enter')
  await page.waitForSelector('img.screen')
  assert.match(await page.getAttribute('img.screen', 'src'), /^data:image\/jpeg;base64,/)
})

test('remote devices cannot manage devices or add projects', async () => {
  await page.click('.account')
  assert.equal(await page.locator('text=Devices & remote access').count(), 0)
  assert.equal(await page.locator('text=Forget this computer').count(), 1)
  await page.click('.account')
  await page.click('text=Projects')
  await page.fill('.menu-form input', '/')
  await page.click('.menu-form button')
  await page.waitForSelector('text=Only available on this computer.')
})

test('revoking the device cuts the tunnel', async () => {
  const [device] = await local('GET', '/devices')
  await local('DELETE', `/devices/${device.id}`)
  await page.reload()
  await page.waitForSelector('text=unknown device')
})
