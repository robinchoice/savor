// End-to-end test of remote access through the relay: real relay, real daemon, UI served by the
// relay in headless Chromium, fake agent. Also checks that the relay only ever sees ciphertext.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import * as tunnel from '../shared/tunnel.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-relay-'))
const TAP = path.join(TMP, 'tap.log')
const USAGE_DB = path.join(TMP, 'usage.db')
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

const call = (base, owner) => async (method, p, body) => {
  const r = await fetch(`${base}/api${p}`, { method, headers: { cookie: `savor_token=${owner}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  return r.json()
}
const local = (method, p, body) => call(daemonBase, token)(method, p, body)

const HANDSHAKE_MS = 1500

function socket(url) {
  const ws = new WebSocket(url)
  ws.closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)))
  ws.opened = new Promise((resolve) => ws.addEventListener('open', resolve))
  return ws
}

async function relayId() {
  return (await local('GET', '/relay')).id
}

// Relay and daemon still serve, and the daemon is still connected to the relay.
async function bothAlive() {
  assert.equal((await fetch(relayBase + '/healthz')).status, 200)
  assert.equal((await local('GET', '/relay')).state, 'online')
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
  await start('dist/relay/server.mjs', { RELAY_PORT: String(relayPort), RELAY_TAP_FILE: TAP, RELAY_HANDSHAKE_TIMEOUT_MS: String(HANDSHAKE_MS), RELAY_DB: USAGE_DB, RELAY_USAGE_TOKEN: 'usage-token' }, 'Savor relay listening')
  await start(
    'dist/server/index.mjs',
    {
      SAVOR_HOME: path.join(TMP, 'home'),
      SAVOR_PORT: String(daemonPort),
      SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'),
      SAVOR_TUNNEL_HANDSHAKE_MS: String(HANDSHAKE_MS),
      SAVOR_USAGE_URL: relayBase + '/usage',
    },
    'Savor running',
  )
  token = JSON.parse(fs.readFileSync(path.join(TMP, 'home/state.json'), 'utf8')).token
  fs.mkdirSync(path.join(TMP, 'project'))
  await local('POST', '/projects', { path: path.join(TMP, 'project') })
  await local('PUT', '/relay', { url: relayBase, enabled: true })
  await until(async () => (await local('GET', '/relay')).state === 'online')
  browser = await chromium.launch({ executablePath: process.env.SAVOR_CHROMIUM })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' })
})

after(async () => {
  await browser?.close()
  for (const c of children) c.kill()
  // The daemon's preview browser and agents outlive it for a moment, and the browser keeps writing its profile.
  await until(() => !execFileSync('ps', ['-eo', 'args']).toString().includes(TMP))
  fs.rmSync(TMP, { recursive: true, force: true })
})

test('state.json is readable by the owner only', () => {
  assert.equal(fs.statSync(path.join(TMP, 'home/state.json')).mode & 0o777, 0o600)
})

test('relay and daemon send a strict CSP and security headers', async () => {
  for (const base of [relayBase, daemonBase]) {
    const r = await fetch(base + '/')
    const csp = r.headers.get('content-security-policy')
    assert.match(csp, /script-src 'self'/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(r.headers.get('x-frame-options'), 'DENY')
  }
  const relayCsp = (await fetch(relayBase + '/')).headers.get('content-security-policy')
  assert.ok(relayCsp.includes('ws://' + new URL(relayBase).host), relayCsp)
})

test('the relay vouches for the Android app (Trusted Web Activity)', async () => {
  const r = await fetch(relayBase + '/.well-known/assetlinks.json')
  assert.equal(r.headers.get('content-type'), 'application/json')
  assert.equal((await r.json())[0].target.package_name, 'org.pleasance.savor')
})

test('malformed daemon logins do not take the relay down', async () => {
  for (const frame of [JSON.stringify({ t: 'auth', pk: '!!!', mac: '' }), JSON.stringify({ t: 'auth', pk: 42, mac: [] }), JSON.stringify({ t: 'auth', pk: tunnel.b64.enc(new Uint8Array(32)), mac: 'AAAA' }), 'not json', '[]']) {
    const ws = socket(relayBase.replace('http', 'ws') + '/daemon')
    ws.addEventListener('message', () => ws.send(frame), { once: true })
    assert.equal(await ws.closed, frame === '[]' || frame === 'not json' ? 4400 : 4401)
  }
  const silent = socket(relayBase.replace('http', 'ws') + '/daemon')
  assert.equal(await silent.closed, 4408, 'unauthenticated daemon sockets time out')
  await bothAlive()
})

test('malformed handshakes do not take the daemon down', async () => {
  await local('POST', '/devices/pairing') // an open pairing window, as when a QR code is shown
  const id = await relayId()
  const hellos = [
    { type: 'hello', mode: 'pair', e: 'AAAA' },
    { type: 'hello', mode: 'pair', e: 42 },
    { type: 'hello', mode: 'session', e: 'AAAA', device: 'BBBB' },
    { type: 'hello', mode: 'session', e: tunnel.b64.enc(tunnel.keypair().pk), device: '!!!' },
    'not json',
  ]
  for (const hello of hellos) {
    const ws = socket(relayBase.replace('http', 'ws') + '/connect?id=' + id)
    await ws.opened
    ws.send(typeof hello === 'string' ? hello : JSON.stringify(hello))
    await ws.closed
  }
  await bothAlive()
})

test('pairing refuses a device key that is not a key', async () => {
  const { code } = await local('POST', '/devices/pairing')
  const daemonPk = tunnel.b64.dec((await local('GET', '/relay')).publicKey)
  const ws = socket(relayBase.replace('http', 'ws') + '/connect?id=' + (await relayId()))
  const pairing = tunnel.devicePairing(daemonPk, code)
  await ws.opened
  const welcome = new Promise((resolve) => ws.addEventListener('message', (m) => resolve(JSON.parse(m.data)), { once: true }))
  ws.send(JSON.stringify(pairing.hello))
  const { channel } = pairing.finish(await welcome)
  const reply = new Promise((resolve) => ws.addEventListener('message', (m) => resolve(String(m.data)), { once: true }))
  ws.send(channel.seal({ name: 'bad key', device: 'AAAA' }))
  assert.equal(JSON.parse(await reply).error, 'bad handshake')
  assert.deepEqual(await local('GET', '/devices'), [])
  await bothAlive()
})

test('a wrong pairing code is rejected', async () => {
  const { relayUrl } = await local('POST', '/devices/pairing')
  await page.goto(relayUrl.replace(/\/[0-9A-F]+$/, '/0000000000'))
  await page.click('button:has-text("Pair")')
  await page.waitForSelector('text=Pairing code invalid or expired.')
})

// Someone at the computer answers the request, after checking that both show the same number.
async function answerPairing(approve, computer = local) {
  let request
  await until(async () => ([request] = await computer('GET', '/devices/requests')).length)
  assert.equal(request.via, 'relay')
  assert.equal((await page.textContent('.check-number')).replace(' ', ''), request.check)
  await computer('POST', `/devices/requests/${request.id}`, { approve })
}

test('a pairing declined on the computer adds no device', async () => {
  const { relayUrl } = await local('POST', '/devices/pairing')
  await page.goto(relayUrl)
  await page.fill('input', 'CI stranger')
  await page.click('button:has-text("Pair")')
  await answerPairing(false)
  await page.waitForSelector('text=Pairing was not allowed on your computer.')
  assert.deepEqual(await local('GET', '/devices'), [])
})

test('pair through the relay and work on the project remotely', async () => {
  const { relayUrl } = await local('POST', '/devices/pairing')
  assert.ok(relayUrl.startsWith(relayBase))
  await page.goto(relayUrl)
  await page.fill('input', 'CI phone')
  await page.click('button:has-text("Pair")')
  await answerPairing(true)
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
  const key = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('savor', 1)
        open.onsuccess = () => {
          const get = open.result.transaction('keys').objectStore('keys').get('device')
          get.onsuccess = () => resolve({ webcrypto: get.result.privateKey instanceof CryptoKey, extractable: get.result.privateKey?.extractable, raw: 'sk' in get.result })
        }
      }),
  )
  assert.deepEqual(key, { webcrypto: true, extractable: false, raw: false }, 'the device key cannot be read out')
  assert.deepEqual(Object.keys(JSON.parse(await page.evaluate(() => localStorage.getItem('savor-remote')))).sort(), ['daemonPk', 'host', 'name'], 'only public pairing metadata in localStorage')

  const tapped = fs.readFileSync(TAP, 'utf8')
  assert.ok(tapped.length > 1000, 'traffic went through the relay')
  for (const plain of ['hello through the relay', 'Echo:', 'Fake agent test', token]) assert.ok(!tapped.includes(plain), `relay saw "${plain}"`)
})

test('twenty phone photos go through the relay in one message, and a reply too large for the relay leaves the connection up', async () => {
  // A 12-megapixel photo, several MB like the ones from a phone.
  const photo = Buffer.from(
    await page.evaluate(async () => {
      const noise = document.createElement('canvas')
      noise.width = 672
      noise.height = 504
      const pixels = noise.getContext('2d').createImageData(noise.width, noise.height)
      for (let i = 0; i < pixels.data.length; i += 65536) crypto.getRandomValues(pixels.data.subarray(i, i + 65536))
      for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255
      noise.getContext('2d').putImageData(pixels, 0, 0)
      const canvas = document.createElement('canvas')
      canvas.width = 4032
      canvas.height = 3024
      canvas.getContext('2d').drawImage(noise, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95))
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(bin)
    }),
    'base64',
  )
  assert.ok(photo.length > 3 * 1024 * 1024, `the test photo has ${photo.length} bytes`)
  const photos = Array.from({ length: 20 }, (_, i) => path.join(TMP, `IMG_00${String(i).padStart(2, '0')}.JPG`))
  for (const file of photos) fs.writeFileSync(file, photo)
  await page.setInputFiles('.composer input[type=file]', photos)
  await page.waitForFunction(() => document.querySelectorAll('.composer .thumb').length === 20)
  await page.fill('.composer textarea', 'twenty photos')
  await page.keyboard.press('Enter')
  await page.waitForSelector('text=Echo: twenty photos', { timeout: 30_000 })
  const [, pid, tid] = page.url().match(/#\/p\/(\w+)\/t\/(\w+)/)
  const t = `/projects/${pid}/threads/${tid}`
  const sent = (await local('GET', t)).messages.findLast((m) => m.kind === 'user')
  assert.equal(sent.images.length, 20)
  for (const name of sent.images) {
    assert.match(name, /-IMG_00\d\d\.jpg$/)
    const r = await fetch(`${daemonBase}/api${t}/attachments/${name}`, { headers: { cookie: `savor_token=${token}` } })
    const size = (await r.arrayBuffer()).byteLength
    assert.ok(size < 1024 * 1024, `${name} was made smaller (${size} bytes)`)
  }

  // An attachment that only fits the daemon's limit: the device's request for it gets an error, nothing else breaks.
  await page.evaluate(() => {
    window.lostConnection = false
    new MutationObserver(() => (window.lostConnection ||= !!document.querySelector('.link-banner'))).observe(document.body, { subtree: true, childList: true })
  })
  const big = `data:image/png;base64,${crypto.randomBytes(20 * 1024 * 1024).toString('base64')}`
  await local('POST', `${t}/messages`, { text: 'a huge image', attachments: [{ name: 'huge.png', dataUrl: big }] })
  await page.waitForSelector('text=Echo: a huge image', { timeout: 30_000 })
  await page.fill('.composer textarea', 'still connected')
  await page.keyboard.press('Enter')
  await page.waitForSelector('text=Echo: still connected')
  assert.equal((await local('GET', '/relay')).state, 'online')
  assert.equal(await page.evaluate(() => window.lostConnection), false)
})

test('the live preview streams through the tunnel', async () => {
  await page.click('.modes [title="Browser"]')
  await page.fill('.preview-bar input', relayBase + '/healthz')
  assert.equal(await page.inputValue('.preview-bar input'), relayBase + '/healthz')
  await page.keyboard.press('Enter')
  await page.waitForSelector('img.screen')
  assert.match(await page.getAttribute('img.screen', 'src'), /^data:image\/jpeg;base64,/)
})

test('remote devices can create projects in the projects folder but cannot manage devices or open other folders', async () => {
  await page.click('.account')
  assert.equal(await page.locator('text=Devices & remote access').count(), 0)
  assert.equal(await page.locator('text=Forget this computer').count(), 1)
  await page.click('.account-dialog >> text=Done')
  await page.click('text=Projects')
  await page.waitForSelector('text=Your projects')
  assert.equal(await page.locator('text=Start new project').count(), 1)
  assert.equal(await page.locator('text=Open any folder').count(), 0)
  await page.click('text=Start new project')
  assert.equal(await page.locator('text=Change folder').count(), 0)
  await page.click('.project-type:has-text("Academic writing")')
  await page.fill('input[placeholder="Name of the new project"]', 'Relay Thesis')
  await page.click('button:has-text("Next")')
  await page.click('.type-form button:has-text("Create project")')
  // The new project opens on its own page once its setup is done.
  await until(async () => (await local('GET', '/projects')).some((p) => p.name === 'Relay Thesis'))
  const thesis = (await local('GET', '/projects')).find((p) => p.name === 'Relay Thesis')
  await page.waitForURL(new RegExp(`#/p/${thesis.id}$`))
  await page.waitForSelector('.study-work:has-text("Manuscript")')
  assert.equal(thesis.path, path.join(TMP, 'relay-thesis'))
  assert.equal(thesis.type, 'academic-writing')
  assert.match((await local('GET', `/projects/${thesis.id}/role`)).role, /This project is a piece of academic writing/)
  assert.ok((await local('GET', `/projects/${thesis.id}/workflows`)).every((w) => w.origin === 'remote'))
  await local('DELETE', `/projects/${thesis.id}`)
})

test('a device pairs with a second computer and switches between both', async () => {
  const home = path.join(TMP, 'home2')
  const base = `http://127.0.0.1:${await freePort()}`
  await start('dist/server/index.mjs', { SAVOR_HOME: home, SAVOR_PORT: new URL(base).port, SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs') }, 'Savor running')
  const second = call(base, JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).token)
  await second('PUT', '/relay', { url: relayBase, enabled: true })
  await until(async () => (await second('GET', '/relay')).state === 'online')

  const { relayUrl } = await second('POST', '/devices/pairing')
  await page.goto(relayUrl)
  await page.fill('input', 'CI phone')
  await page.click('button:has-text("Pair")')
  await answerPairing(true, second)
  await page.click('.account')
  await page.waitForSelector('.account-dialog >> text=Computers')
  assert.equal(await page.locator('.account-dialog >> text="Connected"').count(), 1)
  assert.equal(await page.locator('.account-dialog button:has-text("Switch")').count(), 1)
  const [first] = await local('GET', '/devices')
  const [paired] = await second('GET', '/devices')
  assert.equal(paired.name, 'CI phone')

  // Pairing the same computer again keeps its one device entry, so revoking it still cuts the device off.
  await page.click('.account-dialog >> text=Done')
  await page.goto((await second('POST', '/devices/pairing')).relayUrl)
  await page.fill('input', 'CI phone again')
  await page.click('button:has-text("Pair")')
  await answerPairing(true, second)
  await page.waitForSelector('.account')
  assert.deepEqual((await second('GET', '/devices')).map((d) => [d.id, d.name]), [[paired.id, 'CI phone again']])

  await page.click('.account')
  await page.click('.account-dialog button:has-text("Switch")')
  await page.click('text=Projects')
  await page.waitForSelector('text=Your projects')
  assert.deepEqual((await local('GET', '/devices')).map((d) => d.id), [first.id])

  // The desktop app opens either of them by its key, on a page of the relay that is already open or a new one.
  const active = () => page.evaluate(() => JSON.parse(localStorage.getItem('savor-remote')).daemonPk)
  const keyOf = (link) => link.split('/#/rpair/')[1].split('/')[0]
  const [firstPk, secondPk] = [keyOf((await local('POST', '/devices/pairing')).relayUrl), keyOf(relayUrl)]
  assert.equal(await active(), firstPk)
  await page.goto(`${relayBase}/#/computer/${secondPk}`)
  await page.waitForSelector('.account')
  assert.equal(await active(), secondPk)
  await page.goto('about:blank')
  await page.goto(`${relayBase}/#/computer/${firstPk}`)
  await page.waitForSelector('.account')
  assert.equal(await active(), firstPk)
})

test('a demo instance lets every device in with its fixed code, without asking', async () => {
  const home = path.join(TMP, 'demo')
  const base = `http://127.0.0.1:${await freePort()}`
  await start('dist/server/index.mjs', { SAVOR_HOME: home, SAVOR_PORT: new URL(base).port, SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'), SAVOR_DEMO_PAIRING: 'demo2026' }, 'Savor running')
  const demo = call(base, JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).token)
  await demo('PUT', '/relay', { url: relayBase, enabled: true })
  await until(async () => (await demo('GET', '/relay')).state === 'online')

  for (const name of ['Reviewer 1', 'Reviewer 2']) {
    const reviewer = await browser.newPage({ locale: 'en-US' })
    await reviewer.goto(`${relayBase}/#/rpair/${(await demo('GET', '/relay')).publicKey}/DEMO2026`)
    await reviewer.fill('input', name)
    await reviewer.click('button:has-text("Pair")')
    await reviewer.waitForSelector('.account')
    await reviewer.close()
  }
  assert.deepEqual((await demo('GET', '/devices')).map((d) => [d.name, d.terminal ?? false]), [['Reviewer 1', false], ['Reviewer 2', false]])
  assert.deepEqual(await demo('GET', '/devices/requests'), [])
})

// A cloud instance: the daemon started with SAVOR_SETUP, and its output so far. Like cloud/install.sh, the
// state it starts with holds the relay, the daemon's key and the setup code cloud/new-instance.sh put in its link.
async function startCloud(home, env = {}, base) {
  base ??= `http://127.0.0.1:${await freePort()}`
  const child = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.mjs')], {
    env: { ...process.env, SAVOR_HOME: home, SAVOR_PORT: new URL(base).port, SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'), SAVOR_SETUP: '1', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(child)
  const daemon = { base, child, out: '' }
  child.stdout.on('data', (d) => (daemon.out += d))
  return until(() => daemon.out.includes('Savor running')).then(() => daemon)
}
async function stopCloud(cloud) {
  cloud.child.kill()
  await new Promise((resolve) => cloud.child.once('exit', resolve))
}
function provision(home, expires = Date.now() + 60_000) {
  const identity = tunnel.b64.enc(crypto.getRandomValues(new Uint8Array(32)))
  const code = 'AB12CD34EF56AB12CD34EF56AB12CD34'
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ relay: { url: relayBase, enabled: true }, identity, setupCode: { code, expires } }))
  const created = Math.floor(Date.now() / 1000) - 60
  return { code, link: `${relayBase}/#/rpair/${tunnel.b64.enc(tunnel.keypairFrom(tunnel.b64.dec(identity)).pk)}/${code}/${created}` }
}
const pairLan = (base, code, name = 'Owner laptop') =>
  fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, check: '042137' }) })

test('a setup link waits for its instance, lets the first device in as the owner once, and then says it was used', async () => {
  const home = path.join(TMP, 'cloud')
  const { code, link } = provision(home)
  const phone = await browser.newPage({ locale: 'en-US' })
  await phone.goto(link)
  await phone.waitForSelector('text=Your Savor is being set up')
  assert.match(await phone.textContent('.gate'), /About \d+ minutes left/)

  let cloud = await startCloud(home)
  await phone.goto('about:blank')
  await phone.goto(link)
  await phone.waitForSelector('text=Your Savor is ready')
  await phone.click('button:has-text("Change")')
  await phone.fill('input', 'Owner phone')
  await phone.click('button:has-text("Open Savor")')
  // Through the tunnel the owner counts as this computer, which alone gets the first-start setup.
  await phone.waitForSelector('text=Welcome to your Savor')
  await phone.close()
  const state = () => JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'))
  assert.deepEqual(state().devices.map((d) => [d.name, d.owner]), [['Owner phone', true]])
  assert.equal(state().setupCode, undefined)
  assert.ok(!cloud.out.includes(code), 'the setup code is never logged')

  const again = await browser.newPage({ locale: 'en-US' })
  await again.goto(link)
  await again.waitForSelector('text=This link was used already')
  await again.close()
  assert.equal((await pairLan(cloud.base, code)).status, 400)

  // Even with the owner gone, the link stays spent, also across restarts.
  await stopCloud(cloud)
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ ...state(), devices: [] }))
  cloud = await startCloud(home, {}, cloud.base)
  assert.equal((await pairLan(cloud.base, code)).status, 400)
  assert.deepEqual(state().devices, [])
})

test('a device paired with the setup code has the rights of this computer, also after a restart', async () => {
  const home = path.join(TMP, 'cloud-lan')
  const { code } = provision(home)
  let cloud = await startCloud(home)
  const reply = await pairLan(cloud.base, code)
  assert.equal(reply.status, 200)
  const cookie = reply.headers.get('set-cookie').split(';')[0]
  const asOwner = (method, p) => fetch(`${cloud.base}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json' } })
  assert.equal((await (await asOwner('GET', '/me')).json()).origin, 'local')
  const listed = await asOwner('GET', '/devices')
  assert.equal(listed.status, 200)
  assert.deepEqual((await listed.json()).map((d) => [d.name, d.via, d.owner]), [['Owner laptop', 'lan', true]])

  await stopCloud(cloud)
  cloud = await startCloud(home, {}, cloud.base)
  assert.equal((await (await asOwner('GET', '/me')).json()).origin, 'local')
})

test('the owner of a cloud instance signs Claude Code and GitHub in from the setup and starts with a repository', async () => {
  const home = path.join(TMP, 'cloud-signin')
  const { code } = provision(home)
  const file = path.join(home, 'state.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), projectsDir: path.join(home, 'projects') }))
  const missing = path.join(home, 'missing')
  const cloud = await startCloud(home, {
    FAKE_CLAUDE_LOGIN: path.join(home, 'claude-login'),
    SAVOR_GH_BIN: path.join(ROOT, 'test/fake-gh.mjs'),
    FAKE_GH_LOGIN: path.join(home, 'gh-login'),
    ...Object.fromEntries(['CODEX', 'OPENCODE'].map((a) => [`SAVOR_${a}_BIN`, missing])),
  })
  const [name, value] = (await pairLan(cloud.base, code)).headers.get('set-cookie').split(';')[0].split('=')
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 } })
  await context.addCookies([{ name, value, url: cloud.base }])
  const phone = await context.newPage()
  await phone.goto(cloud.base)

  // Only installed agents show; nothing goes on before one is signed in.
  await phone.waitForSelector('text=Welcome to your Savor')
  await phone.waitForSelector('button:has-text("Sign in with Claude")')
  await phone.waitForSelector('button:has-text("Connect GitHub")')
  assert.deepEqual(await phone.locator('.setup-list .agent-status b').allTextContents(), ['Claude Code', 'GitHub'])
  assert.ok(await phone.locator('.dialog-foot button:has-text("Continue")').isDisabled())

  // Claude Code: its page opens on the phone, and the code from its end goes back to the server.
  await phone.click('button:has-text("Sign in with Claude")')
  assert.match(await phone.getAttribute('a:has-text("Open Claude\'s sign-in page")', 'href'), /^https:\/\/claude\.test\/oauth\/authorize/)
  await phone.fill('input[placeholder="Paste the code"]', 'wrong')
  await phone.click('button:has-text("Done")')
  await phone.waitForSelector("text=Login failed: That code wasn't accepted.")
  await phone.click('button:has-text("Sign in with Claude")')
  await phone.fill('input[placeholder="Paste the code"]', 'good#code')
  await phone.click('button:has-text("Done")')
  await phone.waitForSelector('.agent-status:has-text("Claude Code") >> text=Signed in')

  // GitHub: a one-time code to enter on GitHub's page, then Savor notices the sign-in on its own.
  await phone.click('button:has-text("Connect GitHub")')
  await phone.waitForSelector('.signin-code:has-text("FA4E-C0DE")')
  assert.equal(await phone.getAttribute('a:has-text("Copy code and open the page")', 'href'), 'https://github.com/login/device')
  await phone.waitForSelector('text=@octo')

  // The agent and how much it may do are one step, then the first project comes from GitHub.
  await phone.click('.dialog-foot button:has-text("Continue")')
  await phone.waitForSelector('text=Which agent should start?')
  await phone.waitForSelector('.mode-card.selected:has-text("Auto")')
  await phone.click('.dialog-foot button:has-text("Continue")')
  await phone.waitForSelector('text=Where do you want to start?')
  assert.equal(await phone.locator('text=Open any folder').count(), 0)
  await phone.click('button:has-text("Get a repository from GitHub")')
  await phone.waitForSelector('.repo-list .repo')
  assert.deepEqual(await phone.locator('.repo-list .repo b').allTextContents(), ['octo/shop', 'octo/old-site'])
  await phone.fill('input[placeholder="Search your repositories"]', 'shop')
  await phone.click('.repo:has-text("octo/shop")')
  await phone.waitForURL(/#\/p\//)
  await phone.waitForSelector('.setup-dialog', { state: 'detached' })
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(state.projects.map((p) => p.path), [path.join(home, 'projects', 'shop')])
  assert.equal(state.agent.provider, 'claude')
  assert.ok(fs.existsSync(path.join(home, 'projects', 'shop', 'README.md')))
  await context.close()
  await stopCloud(cloud)
})

test('an expired setup code lets no device in and its link says so; without SAVOR_SETUP no code works', async () => {
  const home = path.join(TMP, 'cloud-expired')
  const { code, link } = provision(home, Date.now() - 1)
  const expired = await startCloud(home)
  assert.equal((await pairLan(expired.base, code)).status, 400)
  const phone = await browser.newPage({ locale: 'en-US' })
  await phone.goto(link)
  await phone.waitForSelector('text=This link has run out')
  await phone.close()

  const plainHome = path.join(TMP, 'cloud-plain')
  const plain = provision(plainHome)
  const cloud = await startCloud(plainHome, { SAVOR_SETUP: '' })
  assert.equal((await pairLan(cloud.base, plain.code)).status, 400)
})

test('idle sockets cannot lock real devices out', async () => {
  const id = await relayId()
  const sockets = Array.from({ length: 10 }, () => socket(relayBase.replace('http', 'ws') + '/connect?id=' + id))
  const codes = await Promise.all(sockets.map((ws) => ws.closed))
  assert.ok(codes.includes(4429), 'one address cannot take every slot: ' + codes)
  // 4408: the relay's handshake timeout, 1000: the daemon's (whichever fires first)
  assert.ok(codes.every((c) => [4429, 4408, 1000].includes(c)), 'idle sockets are closed after the handshake timeout: ' + codes)
  await page.fill('.composer textarea', 'still reachable')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg >> text=Echo: still reachable')
})

// A phone coming back to the page finds its tunnel closed, and the next request reopens it before the timed reconnect does.
test('events keep flowing when a request reopens a lost tunnel', async () => {
  await page.addInitScript(() => {
    const Native = WebSocket
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args)
        window.lastSocket = this
      }
    }
  })
  await page.reload()
  await page.waitForSelector('.composer textarea')
  await page.evaluate(() => new Promise((resolve) => (window.lastSocket.addEventListener('close', resolve), window.lastSocket.close())))
  await page.fill('.composer textarea', 'after the tunnel came back')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg >> text=Echo: after the tunnel came back', { timeout: 10_000 })
})

test('revoking the device cuts its open tunnel at once', async () => {
  const [device] = await local('GET', '/devices')
  await local('DELETE', `/devices/${device.id}`)
  await page.waitForSelector('.link-banner', { timeout: 5000 })
  await page.reload()
  await page.waitForSelector('text=unknown device')
})

// Last: fills this address's rate-limit window.
test('a relay that accepts but never answers does not leave the daemon connecting', async () => {
  const held = []
  const silent = net.createServer((c) => held.push(c)).listen(0)
  try {
    await local('PUT', '/relay', { url: `http://127.0.0.1:${silent.address().port}`, enabled: true })
    await until(async () => (await local('GET', '/relay')).state === 'error', HANDSHAKE_MS * 3)
  } finally {
    silent.close()
    for (const c of held) c.destroy()
    await local('PUT', '/relay', { url: relayBase, enabled: true })
    await until(async () => (await local('GET', '/relay')).state === 'online')
  }
})

test('the relay counts installations from their daily ping, and keeps the counts across a restart', async () => {
  // Earlier tunnel failures can fill this address's connection budget on fast runners.
  const freshPort = await freePort()
  await start('dist/relay/server.mjs', { RELAY_PORT: String(freshPort), RELAY_DB: USAGE_DB, RELAY_USAGE_TOKEN: 'usage-token' }, 'Savor relay listening')
  relayBase = `http://127.0.0.1:${freshPort}`
  await local('PUT', '/relay', { url: relayBase, enabled: true })
  await until(async () => (await local('GET', '/relay')).state === 'online')
  const usage = (base, token = 'usage-token') => fetch(base + '/usage', { headers: { authorization: `Bearer ${token}` } })
  const ping = (body) => fetch(relayBase + '/usage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  await until(async () => (await (await usage(relayBase)).json()).active7.external === 1)
  const state = JSON.parse(fs.readFileSync(path.join(TMP, 'home/state.json'), 'utf8'))
  assert.match(state.installId, /^[\w-]{22}$/)
  assert.ok(state.usagePingedAt)
  assert.equal((await local('GET', '/settings')).usagePing, true)

  assert.equal((await ping({ id: 'x'.repeat(22), version: '1.0.0', platform: 'darwin', internal: true })).status, 204)
  for (const bad of [{ id: 'short', version: '1.0.0', platform: 'linux', internal: false }, { id: 'y'.repeat(22), version: '<b>', platform: 'linux', internal: false }, { id: 'y'.repeat(22), version: '1.0.0', platform: 'beos', internal: false }, { id: 'y'.repeat(22), version: '1.0.0', platform: 'linux' }])
    assert.equal((await ping(bad)).status, 400)
  assert.equal((await usage(relayBase, 'wrong')).status, 401)

  // A second relay on the same database, as after a redeploy.
  const port = await freePort()
  await start('dist/relay/server.mjs', { RELAY_PORT: String(port), RELAY_DB: USAGE_DB, RELAY_USAGE_TOKEN: 'usage-token' }, 'Savor relay listening')
  const counts = await (await usage(`http://127.0.0.1:${port}`)).json()
  assert.deepEqual(counts.active7, { internal: 1, external: 1 })
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  assert.deepEqual(
    counts.weeks.map(({ week, ...rest }) => rest).sort((a, b) => a.platform.localeCompare(b.platform)),
    [
      { internal: true, platform: 'darwin', version: '1.0.0', installs: 1 },
      { internal: false, platform: process.platform, version, installs: 1 },
    ],
  )
})

test('the relay lists online daemons with their version, behind the usage token', async () => {
  const instances = (token = 'usage-token') => fetch(relayBase + '/instances', { headers: { authorization: `Bearer ${token}` } })
  const mine = async () => (await (await instances()).json()).instances.find((i) => i.id === relay.id)
  const relay = await local('GET', '/relay')
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  assert.equal((await instances('wrong')).status, 401)
  assert.equal((await fetch(relayBase + '/instances')).status, 401)
  const online = await mine()
  assert.deepEqual(Object.keys(online).sort(), ['id', 'lastSeen', 'online', 'since', 'version'])
  assert.equal(online.version, version)
  assert.equal(online.online, true)

  await local('PUT', '/relay', { url: relayBase, enabled: false })
  try {
    await until(async () => (await mine())?.online === false)
    const offline = await mine()
    assert.equal(offline.version, version)
    assert.ok(offline.lastSeen >= online.since && offline.lastSeen <= Date.now())
  } finally {
    await local('PUT', '/relay', { url: relayBase, enabled: true })
    await until(async () => (await local('GET', '/relay')).state === 'online')
  }
  assert.equal((await mine()).online, true)
})

test('spoofed X-Forwarded-For does not bypass the rate limit', async () => {
  const outcomes = []
  for (let i = 0; i < 70; i++) {
    const r = await new Promise((resolve) => {
      const req = http.request(relayBase + '/connect?id=x', { headers: { connection: 'upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'x-forwarded-for': `10.0.${i}.1` } })
      req.on('upgrade', (res, sock) => (sock.destroy(), resolve('upgraded')))
      req.on('error', () => resolve('refused'))
      req.on('response', () => resolve('refused'))
      req.end()
    })
    outcomes.push(r)
  }
  assert.ok(outcomes.includes('refused'), 'the relay kept counting the real address')
})
