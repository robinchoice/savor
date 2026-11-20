// The app dock in the footer of the landing page (site/dock.js): site/ served as static files, pleasance.org
// answered from here, the page in headless Chromium.
import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site')
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp' }
// The landing page's CSP with the two sources the dock needs
const CSP = "default-src 'self'; connect-src 'self' https://pleasance.org; img-src 'self' https://pleasance.org; form-action 'none'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
let server, base, browser, page, errors

before(async () => {
  server = http.createServer((req, res) => {
    let file = path.join(SITE, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!file.startsWith(SITE) || !fs.existsSync(file)) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
  server?.close()
})

const icon = (name) => `https://pleasance.org/img/werkzeuge/${name}.svg`
const APPS = [
  { name: 'Music Hub', url: 'https://hub.pleasance.org', icon: icon('musichub'), band: { from: 1.35, to: 2.2 } },
  { name: 'Songgate', url: 'https://songgate.app', icon: icon('musiclink'), band: { from: 3.85, to: 4.55 } },
]
const savor = () => ({ name: 'Savor', url: base, icon: icon('savor'), band: { from: 5.5, to: 6.45 }, desktop: true })

// Console errors fail the test, CSP violations included
beforeEach(async () => {
  errors = []
  page = await browser.newPage({ locale: 'en-US' })
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()))
  page.on('pageerror', (err) => errors.push(err.message))
  await page.route('https://pleasance.org/img/**', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="24"/></svg>' }),
  )
})
afterEach(async () => {
  await page.close()
  assert.deepEqual(errors, [])
})

const serveApps = (apps) =>
  page.route('https://pleasance.org/apps.json', (route) => route.fulfill({ json: { apps }, headers: { 'access-control-allow-origin': '*' } }))

test('the sender links to pleasance.org, hovering the band pops up the apps', async () => {
  await serveApps([...APPS, savor()])
  await page.goto(`${base}/de/`)
  const footer = page.locator('footer')
  assert.equal(await footer.getByRole('link', { name: 'ein Werkzeug von Pleasance' }).getAttribute('href'), 'https://pleasance.org')
  const band = footer.getByRole('button', { name: 'Werkzeuge von Pleasance' })
  assert.equal(await band.getAttribute('aria-expanded'), 'false')

  await band.hover()
  const dock = footer.getByRole('list', { name: 'Werkzeuge von Pleasance' })
  await dock.getByRole('link').nth(2).waitFor()
  assert.equal(await dock.getByRole('link').count(), 3)
  assert.equal(await dock.getByRole('link', { name: 'Savor, Desktop-App' }).getAttribute('aria-current'), 'page')
  assert.equal(await dock.getByRole('link', { name: 'Songgate' }).getAttribute('href'), 'https://songgate.app')

  // Like the Dock: the icon under the pointer grows
  const hub = dock.getByRole('link', { name: 'Music Hub' })
  const bounds = await hub.boundingBox()
  const before = bounds.width
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.waitForFunction(([name, width]) => document.querySelector(`a[href="${name}"]`).getBoundingClientRect().width > width * 1.4, ['https://hub.pleasance.org', before])

  await page.mouse.move(600, 100)
  await page.waitForFunction(() => document.querySelector('.dock button').getAttribute('aria-expanded') === 'false')
})

test('the keyboard walks the apps and Escape closes the dock', async () => {
  await serveApps([...APPS, savor()])
  await page.goto(base)
  const band = page.getByRole('button', { name: 'Tools by Pleasance' })
  await band.focus()
  await page.keyboard.press('Enter')
  const dock = page.getByRole('list', { name: 'Tools by Pleasance' })
  // Starts at the current app
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-current') === 'page')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await dock.getByRole('link', { name: 'Songgate' }).evaluate((a) => a === document.activeElement), true)
  await page.keyboard.press('Escape')
  assert.equal(await band.evaluate((b) => b === document.activeElement), true)
  assert.equal(await band.getAttribute('aria-expanded'), 'false')
})

test('an apps.json with a javascript: link leaves the band a line', async () => {
  await serveApps([...APPS, { ...savor(), url: 'javascript:alert(1)' }])
  await page.goto(base)
  const band = page.getByRole('button', { name: 'Tools by Pleasance' })
  await band.hover()
  await page.waitForTimeout(500)
  assert.equal(await band.getAttribute('aria-expanded'), 'false')
  assert.equal(await page.locator('#pleasance-apps').count(), 0)
})

test('regression: a page restored from the bfcache shows the dock closed', async () => {
  await serveApps([...APPS, savor()])
  await page.goto(base)
  const band = page.getByRole('button', { name: 'Tools by Pleasance' })
  await band.hover()
  await page.waitForFunction(() => document.querySelector('.dock button').getAttribute('aria-expanded') === 'true')
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  assert.equal(await band.getAttribute('aria-expanded'), 'false')
})
