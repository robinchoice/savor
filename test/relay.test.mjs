// End-to-end test of remote access through the relay: real relay, real daemon, UI served by the
// relay in headless Chromium, fake agent. Also checks that the relay only ever sees ciphertext.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
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
