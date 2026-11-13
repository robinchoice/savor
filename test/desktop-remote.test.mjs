// The desktop app as a client of another computer: it pairs with it directly (Tailnet, LAN) by a pairing link and
// switches between it and this computer. Two real daemons, the UI in headless Chromium, and in place of Electron a
// stand-in for desktop/main.cjs and preload.cjs that keeps its list with desktop/computers.cjs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import computers from '../desktop/computers.cjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONNECT_URL = pathToFileURL(path.join(ROOT, 'desktop/connect.html')).href
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-desktop-remote-'))
const children = []
let browser, page, here, there

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('timed out')
}

// A daemon of its own; `base` is how the app reaches it. This computer's is on localhost like in the app,
// the other one on 127.0.0.1, a host of its own for cookies.
async function daemon(name, host, env = {}) {
  const port = await freePort()
  const home = path.join(TMP, name)
  const base = `http://${host}:${port}`
  const child = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.mjs')], {
    env: { ...process.env, SAVOR_HOME: home, SAVOR_PORT: String(port), SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'), ...env(base) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(child)
  await new Promise((resolve) => child.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
  const token = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).token
  const call = async (method, p, body) => {
    const r = await fetch(`${base}/api${p}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return r.json()
  }
  fs.mkdirSync(path.join(TMP, `${name}-project`))
  await call('POST', '/projects', { path: path.join(TMP, `${name}-project`) })
  return { base, token, call }
}

// Stands in for the shell: the same origin checks as main.cjs, the list in computers.cjs, navigation in the page.
const shell = { state: { server: true, last: computers.LOCAL, computers: [] }, showing: null, pending: null }
const accessOf = (origin) => computers.access(shell.state, origin, { local: here.base, pending: shell.pending })
// Changing the list takes this computer's page, a paired computer's or the connect page; a pairing page only reads and switches.
const CHANGES = ['pairComputer', 'forgetComputer', 'setServer']
const load = (url) => setTimeout(() => page.goto(url).catch(() => {}))
function openComputer(id) {
  if (id === computers.LOCAL && shell.state.server) {
    shell.showing = id
    return load(`${here.base}/?token=${here.token}`)
  }
  const computer = shell.state.computers.find((c) => c.id === id)
  shell.showing = computer?.id ?? null
  load(computer?.url ?? 'about:blank')
}
const openStart = () => openComputer(computers.startId(shell.state))
const bridge = {
  computers: () => ({
    server: shell.state.server,
    current: shell.showing,
    list: [...(shell.state.server ? [{ id: computers.LOCAL, name: 'this-mac', via: 'local' }] : []), ...shell.state.computers.map(({ id, name, via }) => ({ id, name, via }))],
  }),
  openComputer,
  pairComputer(link) {
    const url = computers.pairingUrl(link)
    if (!url) return false
    shell.pending = computers.originOf(url)
    shell.showing = null
    load(url)
    return true
  },
  forgetComputer(id) {
    shell.state = computers.forget(shell.state, id)
    if (shell.showing === id) openStart()
  },
  setServer(on) {
    shell.state = { ...shell.state, server: on === true }
  },
  connected(info, origin) {
    if (accessOf(origin) === 'local') {
      shell.showing = computers.LOCAL
      shell.state = { ...shell.state, last: computers.LOCAL }
      return
    }
    const computer = computers.computerAt(origin, info)
    shell.showing = computer.id
    shell.pending = null
    shell.state = computers.remember(shell.state, computer)
  },
  deviceName: () => 'this-mac',
}

before(async () => {
  here = await daemon('here', 'localhost', () => ({}))
  // The other computer, as reached over the Tailnet: its address is what its pairing links carry.
  there = await daemon('there', '127.0.0.1', (base) => ({ SAVOR_PUBLIC_URL: base }))
  browser = await chromium.launch({ executablePath: process.env.SAVOR_CHROMIUM })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' })
  page.on('dialog', (d) => d.accept())
  await page.exposeBinding('savorShell', ({ frame }, op, arg) => {
    const origin = computers.originOf(frame.url())
    const access = accessOf(origin)
    if ((!access && frame.url().split('?')[0] !== CONNECT_URL) || (CHANGES.includes(op) && access === 'pairing')) return null
    return bridge[op](arg, origin) ?? null
  })
  // What preload.cjs exposes: the folder dialog only on this computer's page.
  await page.addInitScript((local) => {
    const call = (op) => (arg) => window.savorShell(op, arg)
    window.savorDesktop = {
      checkForUpdates: async () => null,
      installUpdate: async () => {},
      onUpdateReady: () => {},
      notify: () => {},
      onOpen: () => {},
      ...Object.fromEntries(['computers', 'openComputer', 'pairComputer', 'forgetComputer', 'setServer', 'connected', 'deviceName'].map((op) => [op, call(op)])),
      ...(location.origin === local && { pickFolder: async () => null, showPath: () => {}, setContextActions: () => {} }),
    }
  }, here.base)
})

after(async () => {
  await browser?.close()
  for (const c of children) c.kill()
  await until(() => !execFileSync('ps', ['-eo', 'args']).toString().includes(TMP))
  fs.rmSync(TMP, { recursive: true, force: true })
})

const me = () => page.evaluate(() => fetch('/api/me').then((r) => r.json()))

async function computerRows() {
  await page.click('.account')
  await page.waitForSelector('.account-dialog >> text=Computers')
  await page.waitForSelector('.account-dialog .computer')
  return page.$$eval('.account-dialog .computer', (rows) => rows.map((r) => r.innerText.replace(/\s+/g, ' ').trim()))
}

test('the desktop app pairs with another computer directly, as a remote device there', async () => {
  openStart()
  await page.waitForSelector('.topbar')
  await until(() => shell.showing === computers.LOCAL)
  assert.equal((await me()).origin, 'local')
  assert.deepEqual(await computerRows(), ['This computer this-mac Connected'])

  const { url } = await there.call('POST', '/devices/pairing')
  assert.ok(url.startsWith(`${there.base}/#/pair/`), url)
  await page.click('.account-dialog >> text=Pair another computer')
  await page.fill('.pair-computer input', 'https://example.com/not-a-pairing-link')
  await page.click('.pair-computer button:has-text("Pair")')
  await page.waitForSelector('.pair-computer >> text=That is not a Savor pairing link.')
  await page.fill('.pair-computer input', url)
  await page.click('.pair-computer button:has-text("Pair")')

  // The other computer's own page pairs, under this computer's name, and asks there.
  await page.waitForSelector('text=Pair this device')
  assert.equal(await page.inputValue('input >> nth=1'), 'this-mac')
  await page.click('button:has-text("Pair")')
  let request
  await until(async () => ([request] = await there.call('GET', '/devices/requests')).length)
  assert.deepEqual([request.name, request.via], ['this-mac', 'lan'])
  assert.equal((await page.textContent('.check-number')).replace(' ', ''), request.check)
  await there.call('POST', `/devices/requests/${request.id}`, { approve: true })

  await page.waitForSelector('.topbar')
  await until(() => shell.state.computers.length === 1)
  const [computer] = shell.state.computers
  assert.deepEqual(computer, { id: there.base, name: os.hostname(), url: `${there.base}/`, via: 'direct' })
  assert.equal(shell.showing, there.base)
  assert.deepEqual([(await me()).origin, (await me()).device], ['remote', 'this-mac'])
  assert.deepEqual((await there.call('GET', '/devices')).map((d) => [d.name, d.via]), [['this-mac', 'lan']])

  // No shortcut to the owner's rights: the terminal stays off until it is allowed on that computer.
  const [project] = await there.call('GET', '/projects')
  assert.equal(await page.evaluate((pid) => fetch(`/api/projects/${pid}/terminal`).then((r) => r.status), project.id), 403)
  assert.equal(await page.evaluate(() => fetch('/api/devices').then((r) => r.status)), 403)
  // Nor to this computer's files: its folder dialog is not offered on the other computer's page.
  assert.equal(await page.evaluate(() => typeof window.savorDesktop.pickFolder), 'undefined')
})

test('the desktop app switches between this computer and the paired one', async () => {
  assert.deepEqual(await computerRows(), ['This computer this-mac Switch', `${os.hostname()} Direct Connected`])
  await page.click('.account-dialog .computer:has-text("This computer") button:has-text("Switch")')
  await until(() => shell.showing === computers.LOCAL)
  await page.waitForSelector('.topbar')
  assert.equal((await me()).origin, 'local')
  assert.equal(await page.evaluate(() => typeof window.savorDesktop.pickFolder), 'function')

  // Back without pairing again: the computer still knows this app.
  assert.deepEqual(await computerRows(), ['This computer this-mac Connected', `${os.hostname()} Direct Switch`])
  await page.click(`.account-dialog .computer:has-text("Direct") button:has-text("Switch")`)
  await until(() => shell.showing === there.base)
  await page.waitForSelector('.topbar')
  assert.deepEqual([(await me()).origin, (await me()).device], ['remote', 'this-mac'])
  assert.equal(computers.startId(shell.state), there.base, 'the app opens it again on its next start')
})

test('a pairing declined on the other computer leads back to the computers of the app', async () => {
  await computerRows()
  const { url } = await there.call('POST', '/devices/pairing')
  await page.click('.account-dialog >> text=Pair another computer')
  await page.fill('.pair-computer input', url)
  await page.click('.pair-computer button:has-text("Pair")')
  await page.waitForSelector('text=Pair this device')
  await page.click('button:has-text("Pair")')
  let request
  await until(async () => ([request] = await there.call('GET', '/devices/requests')).length)
  await there.call('POST', `/devices/requests/${request.id}`, { approve: false })
  await page.waitForSelector('text=Pairing was not allowed on your computer.')
  await page.click('button:has-text("Switch to This computer")')
  await until(() => shell.showing === computers.LOCAL)
  await page.waitForSelector('.topbar')
  assert.equal((await me()).origin, 'local')
})

test('a client-only app lists only the paired computers, and forgetting the last one leaves none', async () => {
  await computerRows()
  await page.click(`.account-dialog .computer:has-text("Direct") button:has-text("Switch")`)
  await until(() => shell.showing === there.base)
  await computerRows()
  await page.click('.account-dialog .run-here [role=switch]')
  await until(() => !shell.state.server)
  await page.click('.account-dialog >> text=Done')
  assert.deepEqual(await computerRows(), [`${os.hostname()} Direct Connected`])
  await page.click('.account-dialog .computer button[title="Remove from this app"]')
  await until(() => !shell.state.computers.length)
  assert.equal(computers.startId(shell.state), null, 'the app asks for a pairing link on its next start')
})

test('the connect page refreshes the computer list when the local server is enabled', async () => {
  // Forgetting the last computer left the window with nothing to show.
  await page.waitForURL('about:blank')
  await page.goto(`${CONNECT_URL}?error=unreachable&name=offline`)
  await page.waitForFunction(() => document.querySelector('#server').checked === false)
  // The shell blocks page-initiated file navigation; updating the list must work without a reload.
  await page.evaluate(() => navigation.addEventListener('navigate', (event) => event.preventDefault()))
  await page.check('#server')
  await page.waitForSelector('#list button:has-text("This computer")', { timeout: 5000 })
  assert.equal(shell.state.server, true)
  assert.equal(await page.locator('#list button').count(), 1)
})
