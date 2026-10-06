// Takes the screenshots for the README (docs/screenshots/*.png) and the landing page (site/img/*.webp):
// a real daemon with scripts/demo-claude.mjs as Claude Code plays the demo conversations, headless
// Chromium photographs them. Needs a build (npm run build) and Chromium (npx playwright-core install chromium).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = path.join(ROOT, 'docs/screenshots')
const SITE = path.join(ROOT, 'site/img')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-shots-'))
const SITE_PORT = 8792
const TZ = 'Europe/Berlin'

const BAKERY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Brotzeit Bakery</title>
<style>
@font-face { font-family: Bricolage; src: url(/font.woff2) format('woff2'); font-weight: 200 800; }
body { margin: 0; font-family: Bricolage, sans-serif; background: #faf6f0; color: #3b2a1e; text-align: center; }
.hero { padding: 72px 24px 56px; }
.eyebrow { font: 600 11px/1 Bricolage, sans-serif; letter-spacing: .25em; color: #d9792b; }
h1 { font-size: clamp(3rem, 7vw, 6rem); line-height: 1.05; margin: 24px 0; }
p { max-width: 36em; margin: 0 auto 32px; font-size: 18px; }
a { display: inline-block; padding: 14px 28px; border-radius: 99px; background: #d9792b; color: #fff; text-decoration: none; font: 600 15px Bricolage, sans-serif; }
h2 { font-size: 28px; margin: 24px 0; }
.items { display: flex; gap: 24px; justify-content: center; padding: 0 24px 64px; flex-wrap: wrap; }
.item { width: 220px; padding: 28px 20px; border-radius: 16px; background: #fff; box-shadow: 0 2px 12px #3b2a1e14; }
.dot { width: 48px; height: 48px; margin: 0 auto 16px; border-radius: 50%; background: #f3d7b8; }
</style></head><body>
<section class="hero"><div class="eyebrow">BROTZEIT BAKERY</div><h1>Baked fresh.<br>Shared warm.</h1>
<p>Slow-fermented sourdough, buttery pastries and honest crumbs, from our oven to your table every morning.</p><a href="#">Visit us today</a></section>
<h2>Our bestsellers</h2>
<div class="items"><div class="item"><div class="dot"></div><b>Rye sourdough</b></div><div class="item"><div class="dot"></div><b>Butter croissant</b></div><div class="item"><div class="dot"></div><b>Laugenbrezel</b></div></div>
</body></html>`

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

async function until(fn, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timed out')
}

const brotzeit = path.join(TMP, 'brotzeit')
const portfolio = path.join(TMP, 'portfolio')
fs.mkdirSync(brotzeit)
fs.mkdirSync(portfolio)
fs.writeFileSync(path.join(brotzeit, 'index.html'), BAKERY)
// The demo page uses the landing page's font, so it looks the same on every machine.
const FONT = fs.readFileSync(path.join(ROOT, 'site/fonts/bricolage-grotesque-latin.woff2'))
const site = http
  .createServer((req, res) => (req.url === '/font.woff2' ? res.writeHead(200, { 'content-type': 'font/woff2' }).end(FONT) : res.writeHead(200, { 'content-type': 'text/html' }).end(BAKERY)))
  .listen(SITE_PORT, '127.0.0.1')

const port = await freePort()
const base = `http://127.0.0.1:${port}`
const missing = path.join(TMP, 'none')
const server = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.mjs')], {
  env: {
    ...process.env,
    TZ,
    SAVOR_HOME: path.join(TMP, 'home'),
    SAVOR_PORT: String(port),
    SAVOR_CLAUDE_BIN: path.join(ROOT, 'scripts/demo-claude.mjs'),
    SAVOR_CODEX_BIN: missing,
    SAVOR_OPENCODE_BIN: missing,
    SAVOR_GROK_BIN: missing,
    SAVOR_ANTIGRAVITY_BIN: missing,
    CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'),
    CODEX_HOME: path.join(TMP, 'codex'),
    SAVOR_ENJOY_DIR: path.join(TMP, 'enjoy'),
    DEMO_SITE_URL: `http://localhost:${SITE_PORT}/`,
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
const token = JSON.parse(fs.readFileSync(path.join(TMP, 'home/state.json'), 'utf8')).token
const api = async (method, p, body) => {
  const r = await fetch(`${base}/api${p}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${await r.text()}`)
  return r.json()
}

let browser
try {
  // The demo: two projects, a landing page with its preview, a checklist waiting for answers, two workflows.
  const project = await api('POST', '/projects', { path: brotzeit })
  await api('POST', '/projects', { path: portfolio })
  const p = `/projects/${project.id}`
  const read = (id) => api('GET', `${p}/threads/${id}`)
  // Waits until test(thread) holds; a timeout shows what the conversation got instead.
  const waitFor = (id, test) =>
    until(async () => test(await read(id))).catch(async () => {
      throw new Error(`timed out, messages: ${JSON.stringify((await read(id)).messages.map((m) => [m.kind, m.text]))}`)
    })
  const concluded = (text) => (t) => t.messages.some((m) => m.kind === 'conclusion' && m.text?.includes(text))
  const asking = (t) => t.decisions.find((d) => !d.resolved)

  const bakery = await api('POST', `${p}/threads`, {
    text: 'Build a warm, modern landing page for our bakery "Brotzeit" in index.html: hero with a tagline, three bestsellers and a map.',
    agent: { provider: 'claude', model: 'sonnet', reasoning: 'low' },
  })
  const decision = await waitFor(bakery.id, asking)
  await api('POST', `${p}/threads/${bakery.id}/decisions`, { answers: [{ id: decision.id, selected: 0 }] })
  await waitFor(bakery.id, concluded('is live at'))
  await api('POST', `${p}/threads/${bakery.id}/messages`, {
    text: 'Looks great. Make the hero headline a bit larger, reload the preview, and conclude with three short suggestions for next steps.',
  })
  await waitFor(bakery.id, concluded('headline is larger'))

  const checklist = await api('POST', `${p}/threads`, {
    text: 'Write a short launch checklist for the new website as a document (domain, SEO basics, Google Business Profile, photos) and ask me what you need to know.',
    agent: { provider: 'claude', model: 'sonnet', reasoning: 'low' },
  })
  await waitFor(checklist.id, asking)

  const workflow = (name, prompt, cron) => api('POST', `${p}/workflows`, { name, prompt, cron, timezone: TZ })
  await workflow('Weekly specials post', 'Write this week’s specials post for the website and Instagram from specials.md.', '0 9 * * 1')
  const check = await workflow(
    'Morning site check',
    'Open the website in the preview, check opening hours and prices against the Google Business profile and report anything that is out of date.',
    '0 7 * * *',
  )

  browser = await chromium.launch({ executablePath: process.env.SAVOR_CHROMIUM })
  const open = async (theme, options) => {
    const page = await browser.newPage({ locale: 'en-US', timezoneId: TZ, ...options })
    await page.addInitScript((t) => {
      localStorage.setItem('savor-theme', t)
      localStorage.setItem('savor-prefs', JSON.stringify({ chatWidth: 560 }))
    }, theme)
    await page.goto(`${base}/?token=${token}`)
    return page
  }
  const shoot = async (page, route, ready, file) => {
    await page.goto(`${base}/#${route}`)
    await page.waitForSelector(ready)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
    return page.screenshot({ path: path.join(DOCS, file) })
  }

  const desktop = { viewport: { width: 1600, height: 1000 } }
  let page = await open('dark', desktop)
  const conversation = await shoot(page, `/p/${project.id}/t/${bakery.id}`, '.stage .screen', 'conversation.png')
  page = await open('light', desktop)
  await shoot(page, `/p/${project.id}/t/${checklist.id}`, '.option', 'questions.png')
  await shoot(page, `/p/${project.id}/workflows/${check.id}/edit`, 'textarea', 'workflows.png')

  // The phone screenshot shows the conversation list and the conversation with its preview side by side.
  page = await open('dark', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const list = await shoot(page, `/p/${project.id}`, 'text=Website launch checklist', 'mobile.png')
  const chat = await shoot(page, `/p/${project.id}/t/${bakery.id}`, '.stage .screen', 'mobile.png')
  page = await browser.newPage({ viewport: { width: 1620, height: 1688 } })
  const src = (png) => `data:image/png;base64,${png.toString('base64')}`
  await page.setContent(`<body style="margin:0;display:flex;gap:60px;background:#fff"><img src="${src(list)}" width="780"><img src="${src(chat)}" width="780"></body>`)
  await page.screenshot({ path: path.join(DOCS, 'mobile.png') })

  // The landing page gets WebP in full and half width, and the conversation as its social preview image.
  fs.writeFileSync(path.join(SITE, 'og.png'), conversation)
  const webp = (file, width) =>
    page.evaluate(
      async ({ data, width }) => {
        const img = new Image()
        img.src = data
        await img.decode()
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = Math.round((img.height * width) / img.width)
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
        return canvas.toDataURL('image/webp', 0.85).split(',')[1]
      },
      { data: src(fs.readFileSync(path.join(DOCS, file))), width },
    )
  for (const [name, width] of [['conversation', 1600], ['questions', 1600], ['mobile', 1620]]) {
    fs.writeFileSync(path.join(SITE, `${name}.webp`), Buffer.from(await webp(`${name}.png`, width), 'base64'))
    fs.writeFileSync(path.join(SITE, `${name}-${width / 2}.webp`), Buffer.from(await webp(`${name}.png`, width / 2), 'base64'))
  }
} finally {
  await browser?.close()
  server.kill()
  site.close()
  // The daemon's preview browser outlives it for a moment and keeps writing its profile.
  await new Promise((r) => setTimeout(r, 1000))
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 })
}
