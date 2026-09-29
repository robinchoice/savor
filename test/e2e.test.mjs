// End-to-end tests: real daemon, real UI in headless Chromium, fake agent (test/fake-claude.mjs).
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-e2e-'))
const HOME = path.join(TMP, 'home')
const PROJECT = path.join(TMP, 'project')
let server, browser, page, port, token, base

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const api = async (method, p, body, cookie = `savor_token=${token}`) => {
  const r = await fetch(`${base}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

async function send(text) {
  await page.fill('.composer textarea', text)
  await page.keyboard.press('Enter')
}

before(async () => {
  port = await freePort()
  base = `http://127.0.0.1:${port}`
  fs.mkdirSync(PROJECT)
  const entry = fs.existsSync(path.join(ROOT, 'dist/server/index.mjs')) ? 'dist/server/index.mjs' : 'bin/savor.js'
  server = spawn(process.execPath, [path.join(ROOT, entry)], {
    env: { ...process.env, SAVOR_HOME: HOME, SAVOR_PORT: String(port), SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs') },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
  token = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).token
  browser = await chromium.launch({ executablePath: process.env.SAVOR_CHROMIUM })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.goto(`${base}/?token=${token}`)
})

after(async () => {
  await browser?.close()
  server?.kill()
  fs.rmSync(TMP, { recursive: true, force: true })
})

test('add a project and get a conclusion with next actions', async () => {
  await page.click('text=Projects')
  await page.fill('.menu-form input', PROJECT)
  await page.click('.menu-form button')
  await page.waitForSelector('text=What do you want to build?')
  await send('hello savor')
  await page.waitForSelector('text=Echo: hello savor')
  await page.waitForSelector('.label-pill:has-text("Fake agent test")')
  await page.waitForSelector('.next-actions >> text=Do it again')
  await page.click('.mark-complete')
  await page.waitForSelector('.status:has-text("Completed")')
})

test('questions are answered in one reply', async () => {
  await page.click('.new-btn')
  await send('ask: Ship it?')
  await page.waitForSelector('text=One thing before I continue')
  assert.equal(await page.locator('.filter.attention').count(), 1, 'Needs you filter lights up')
  await page.click('.option:has-text("Yes")')
  await page.click('text=Send reply')
  await page.waitForSelector('text=Selected: Yes')
})

test('approvals are routed to the user', async () => {
  await page.click('.new-btn')
  await send('approve: now')
  await page.waitForSelector('.approval >> text=Allow')
  await page.click('.approval button:has-text("Allow")')
  await page.waitForSelector('text=Permission: allow')
})

test('workflows run in a new conversation', async () => {
  const [project] = (await api('GET', '/projects')).body
  const wf = (await api('POST', `/projects/${project.id}/workflows`, { name: 'Nightly', prompt: 'nightly check', cron: '0 3 * * *' })).body
  assert.match(wf.id, /^[0-9a-f]{16}$/)
  assert.equal((await api('POST', `/projects/${project.id}/workflows`, { name: 'Bad', prompt: 'x', cron: 'not a cron' })).status, 400)
  const thread = (await api('POST', `/projects/${project.id}/workflows/${wf.id}/run`)).body
  await page.goto(`${base}/#/p/${project.id}/t/${thread.id}`)
  await page.waitForSelector('text=Echo: Run workflow')
})

test('auth: tokens, pairing and remote limits', async () => {
  assert.equal((await api('GET', '/projects', undefined, '')).status, 401)
  const pairing = (await api('POST', '/devices/pairing')).body
  const redeem = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, name: 'CI phone' }) })
  assert.equal(redeem.status, 200)
  const device = redeem.headers.get('set-cookie').split(';')[0]
  assert.equal((await api('GET', '/me', undefined, device)).body.origin, 'remote')
  assert.equal((await api('POST', '/devices/pairing', undefined, device)).status, 403)
  assert.equal((await api('POST', '/projects', { path: '/' }, device)).status, 403)
  const again = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, name: 'x' }) })
  assert.equal(again.status, 400)
})
