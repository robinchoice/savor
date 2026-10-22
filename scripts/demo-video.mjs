// Records the demo video for the README and the launch (docs/demo.mp4, docs/demo.gif): a real daemon with
// scripts/demo-claude.mjs as Claude Code, made-up projects, and headless Chromium playing the user from a
// task through the agent's question to the result in the live preview. Run by hand, not on release:
// npm run build && node scripts/demo-video.mjs. Needs Chromium (npx playwright-core install chromium) and ffmpeg.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = path.join(ROOT, 'docs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-video-'))
const SITE_PORT = 8793
const TZ = 'Europe/Berlin'
const SIZE = { width: 1280, height: 800 }

// The screenshots' bakery page, with the smaller headline the agent enlarges in the video.
const BAKERY = fs.readFileSync(path.join(ROOT, 'scripts/demo-bakery.html'), 'utf8').replace('clamp(3rem, 7vw, 6rem)', 'clamp(2.5rem, 4.5vw, 4.5rem)')

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
fs.mkdirSync(brotzeit)
fs.mkdirSync(path.join(TMP, 'portfolio'))
fs.writeFileSync(path.join(brotzeit, 'index.html'), BAKERY)
const FONT = fs.readFileSync(path.join(ROOT, 'site/fonts/bricolage-grotesque-latin.woff2'))
// Serves index.html fresh on every request, so the preview shows the agent's change after it reloads.
const site = http
  .createServer((req, res) =>
    req.url === '/font.woff2'
      ? res.writeHead(200, { 'content-type': 'font/woff2' }).end(FONT)
      : res.writeHead(200, { 'content-type': 'text/html' }).end(fs.readFileSync(path.join(brotzeit, 'index.html'))),
  )
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
    DEMO_SITE_URL: `http://localhost:${SITE_PORT}/`,
    DEMO_PAUSE_MS: '1800',
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
  // Before the video starts: two projects, a checklist conversation waiting for answers, a workflow.
  const project = await api('POST', '/projects', { path: brotzeit, name: 'Brotzeit' })
  await api('POST', '/projects', { path: path.join(TMP, 'portfolio'), name: 'Portfolio' })
  const p = `/projects/${project.id}`
  const checklist = await api('POST', `${p}/threads`, {
    text: 'Write a short launch checklist for the new website as a document (domain, SEO basics, Google Business Profile, photos) and ask me what you need to know.',
    agent: { provider: 'claude', model: 'sonnet', reasoning: 'low' },
  })
  await until(async () => (await api('GET', `${p}/threads/${checklist.id}`)).decisions.length)
  await api('POST', `${p}/workflows`, { name: 'Morning site check', prompt: 'Open the website in the preview and report anything out of date.', cron: '0 7 * * *', timezone: TZ })

  browser = await chromium.launch({ executablePath: process.env.SAVOR_CHROMIUM })
  const context = await browser.newContext({ viewport: SIZE, locale: 'en-US', timezoneId: TZ, recordVideo: { dir: TMP, size: SIZE } })
  await context.addInitScript(() => {
    localStorage.setItem('savor-theme', 'dark')
    localStorage.setItem('savor-prefs', JSON.stringify({ layout: { dir: 'col', sizes: [0, 300], children: [{ dir: 'row', sizes: [280, 480, 0], children: ['list', 'main', 'stage'] }, 'terminal'] } }))
    // Headless Chromium draws no mouse pointer, so the video gets one that follows the mouse.
    addEventListener('DOMContentLoaded', () => {
      const cursor = document.createElement('div')
      cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 10-7 1.5L9.5 21z" fill="#fff" stroke="#000" stroke-width="1.5"/></svg>'
      cursor.style.cssText = 'position:fixed;left:-40px;top:0;z-index:2147483647;pointer-events:none;transition:transform .08s'
      document.body.append(cursor)
      addEventListener('mousemove', (e) => Object.assign(cursor.style, { left: `${e.clientX - 4}px`, top: `${e.clientY - 2}px` }), true)
      addEventListener('mousedown', () => (cursor.style.transform = 'scale(.8)'), true)
      addEventListener('mouseup', () => (cursor.style.transform = ''), true)
    })
  })
  const page = await context.newPage()
  const started = Date.now()
  const wait = (ms) => page.waitForTimeout(ms)
  const click = async (selector) => {
    const target = page.locator(selector).first()
    await target.waitFor()
    const box = await target.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 })
    await wait(300)
    await target.click()
  }
  const type = async (text) => {
    await click('.composer textarea')
    await page.locator('.composer textarea').pressSequentially(text, { delay: 28 })
    await wait(600)
    await page.keyboard.press('Enter')
  }

  await page.goto(`${base}/?token=${token}`)
  await page.goto(`${base}/#/p/${project.id}`)
  await page.waitForSelector('text=Website launch checklist')
  await page.evaluate(() => document.fonts.ready)
  // Everything before this point is cut from the video.
  const cut = (Date.now() - started) / 1000
  await page.mouse.move(700, 450)
  await wait(1500)

  await click('.new-btn')
  await page.waitForSelector('text=What do you want to build?')
  await wait(800)
  await type('Build a warm, modern landing page for our bakery "Brotzeit" in index.html: hero with a tagline, three bestsellers and a map.')
  await page.waitForSelector('.option:has-text("Warm orange")', { timeout: 30_000 })
  await wait(2500)
  await click('.option:has-text("Warm orange")')
  await wait(700)
  await click('.composer button:has-text("Send answers")')
  await page.waitForSelector('.messages :text("is live at")', { timeout: 30_000 })
  await wait(4500)
  await type('Looks great. Make the hero headline a bit larger and reload the preview.')
  await page.waitForSelector('.messages :text("headline is larger")', { timeout: 30_000 })
  await wait(1500)
  await page.mouse.move(SIZE.width - 300, 300, { steps: 25 })
  await wait(5000)

  await context.close()
  const webm = path.join(TMP, fs.readdirSync(TMP).find((f) => f.endsWith('.webm')))
  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(cut), '-i', webm, ...args])
  ffmpeg('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', '-preset', 'slow', '-movflags', '+faststart', path.join(DOCS, 'demo.mp4'))
  ffmpeg('-vf', 'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle', path.join(DOCS, 'demo.gif'))
} finally {
  await browser?.close()
  server.kill()
  site.close()
  // The daemon's preview browser outlives it for a moment and keeps writing its profile.
  await new Promise((r) => setTimeout(r, 1000))
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 })
}
