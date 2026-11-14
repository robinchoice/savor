// Takes the screenshots for the README (docs/screenshots/*.png) and the landing page (site/img/*.webp):
// a real daemon with scripts/demo-claude.mjs as Claude Code plays the demo conversations, headless
// Chromium photographs them. Needs a build (npm run build) and Chromium (npx playwright-core install chromium).
// The demo is Savor at work on its own landing page (site/, served as the preview) and on two more of
// our projects, all in the dark theme the landing page uses.
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

const dirs = Object.fromEntries(['savor', 'songgate', 'pleasance'].map((name) => [name, path.join(TMP, name)]))
for (const dir of Object.values(dirs)) fs.mkdirSync(dir)
// The preview shows the landing page as it is in this checkout.
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' }
const site = http
  .createServer((req, res) => {
    let file = path.join(ROOT, 'site', path.normalize(decodeURIComponent(req.url.split('?')[0])))
    if (file.endsWith(path.sep)) file = path.join(file, 'index.html')
    if (!file.startsWith(path.join(ROOT, 'site')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file))
  })
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
    CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'),
    CODEX_HOME: path.join(TMP, 'codex'),
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
  // The demo: three projects, the landing page with its preview, a plan waiting for answers, a finished task, two workflows.
  const savor = await api('POST', '/projects', { path: dirs.savor })
  const songgate = await api('POST', '/projects', { path: dirs.songgate })
  const pleasance = await api('POST', '/projects', { path: dirs.pleasance })
  const in_ = (project) => `/projects/${project.id}`
  const read = (project, id) => api('GET', `${in_(project)}/threads/${id}`)
  // Waits until test(thread) holds; a timeout shows what the conversation got instead.
  const waitFor = (project, id, test) =>
    until(async () => test(await read(project, id))).catch(async () => {
      throw new Error(`timed out, messages: ${JSON.stringify((await read(project, id)).messages.map((m) => [m.kind, m.text]))}`)
    })
  const concluded = (text) => (t) => t.messages.some((m) => m.kind === 'conclusion' && m.text?.includes(text))
  const asking = (t) => t.decisions.find((d) => !d.resolved)
  const agent = { provider: 'claude', model: 'sonnet', reasoning: 'low' }

  const address = await api('POST', `${in_(pleasance)}/threads`, { text: 'Put our new office address into the imprint and privacy pages.', agent })
  await waitFor(pleasance, address.id, concluded('new address'))

  const landing = await api('POST', `${in_(savor)}/threads`, {
    text: 'Rework the landing page in site/: dark, one accent, a huge two-line headline, the real app as the stage and numbered steps.',
    agent,
  })
  const decision = await waitFor(savor, landing.id, asking)
  await api('POST', `${in_(savor)}/threads/${landing.id}/decisions`, { answers: [{ id: decision.id, selected: 0 }] })
  await waitFor(savor, landing.id, concluded('is live at'))
  await api('POST', `${in_(savor)}/threads/${landing.id}/messages`, {
    text: 'Looks great. Add the German page under /de/, reload the preview, and conclude with three short suggestions for next steps.',
  })
  await waitFor(savor, landing.id, concluded('German page'))

  const tips = await api('POST', `${in_(songgate)}/threads`, {
    text: "Let listeners tip the artist over Lightning on every song page, with the L402 checkout from starter. Ask me what you need to know.",
    agent,
  })
  await waitFor(songgate, tips.id, asking)

  const workflow = (name, prompt, cron) => api('POST', `${in_(savor)}/workflows`, { name, prompt, cron, timezone: TZ })
  await workflow('Nightly dependency check', 'Run npm outdated and start a conversation for each major update, with what changed and what it breaks.', '0 3 * * *')
  const check = await workflow(
    'Upstream check',
    'Run node scripts/upstream-check.mjs against the newest Claude Code, Codex and OpenCode and report anything that broke, with the failing step.',
    '0 5 * * 1',
  )

  browser = await chromium.launch({ executablePath: process.env.SAVOR_CHROMIUM })
  const open = async (options) => {
    const page = await browser.newPage({ locale: 'en-US', timezoneId: TZ, ...options })
    await page.addInitScript(() => {
      localStorage.setItem('savor-theme', 'dark')
      localStorage.setItem('savor-prefs', JSON.stringify({ layout: { dir: 'col', sizes: [0, 300], children: [{ dir: 'row', sizes: [330, 560, 0], children: ['list', 'main', 'stage'] }, 'terminal'] } }))
    })
    await page.goto(`${base}/?token=${token}`)
    return page
  }
  const go = async (page, route, ready) => {
    await page.goto(`${base}/#${route}`)
    await page.waitForSelector(ready)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
  }
  const shoot = async (page, route, ready, file) => {
    await go(page, route, ready)
    return page.screenshot({ path: path.join(DOCS, file) })
  }
  // A part of the window for the landing page's steps: the element's box.
  const part = async (page, selector, file) => {
    const clip = await page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }, selector)
    return page.screenshot({ clip, path: path.join(DOCS, file) })
  }

  const desktop = { viewport: { width: 1600, height: 1000 } }
  let page = await open(desktop)
  await shoot(page, `/p/${savor.id}/t/${landing.id}`, '.stage .screen', 'conversation.png')
  await shoot(page, `/p/${songgate.id}/t/${tips.id}`, '.option', 'questions.png')
  await shoot(page, `/p/${savor.id}/workflows/${check.id}/edit`, 'textarea', 'workflows.png')

  // The steps of the landing page show parts of the window, sharp at twice the pixels.
  page = await open({ ...desktop, deviceScaleFactor: 2 })
  await go(page, `/p/${savor.id}/t/${landing.id}`, '.complete-actions')
  await part(page, '.stage', 'step-preview.png')
  // The end of the landing page conversation: the last request, the result and the next steps. It is also
  // the social preview's picture, enlarged so the UI stays readable at the few hundred pixels a link gets.
  const clip = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect()
    const list = box(document.querySelector('.messages'))
    const top = box([...document.querySelectorAll('.messages .msg')].at(-2)).top
    return { x: list.left, y: top - 8, width: list.width, height: box(document.querySelector('.complete-actions')).bottom - top + 12 }
  })
  const ending = await page.screenshot({ clip, path: path.join(DOCS, 'step-task.png') })
  // Without a preview the conversation takes the whole width, so these come from a narrower window.
  page = await open({ viewport: { width: 1120, height: 780 }, deviceScaleFactor: 2 })
  await go(page, `/p/${songgate.id}/t/${tips.id}`, '.option')
  await part(page, '.messages', 'step-questions.png')
  await go(page, '/all', '.all-overview')
  await part(page, '.all-overview', 'step-projects.png')

  // The phone screenshot shows the conversation list and the conversation with its preview side by side.
  page = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const list = await shoot(page, `/p/${songgate.id}`, 'text=Lightning tips for artists', 'mobile.png')
  const chat = await shoot(page, `/p/${savor.id}/t/${landing.id}`, '.stage .screen', 'mobile.png')
  fs.writeFileSync(path.join(DOCS, 'step-phone.png'), list)
  // On phones the landing page's hero shows Savor on a phone instead of the desktop window.
  fs.writeFileSync(path.join(DOCS, 'hero-phone.png'), chat)
  page = await browser.newPage({ viewport: { width: 1620, height: 1688 }, locale: 'en-US' })
  const src = (png) => `data:image/png;base64,${png.toString('base64')}`
  await page.setContent(`<body style="margin:0;display:flex;gap:60px;background:#0b0a10"><img src="${src(list)}" width="780"><img src="${src(chat)}" width="780"></body>`)
  await page.screenshot({ path: path.join(DOCS, 'mobile.png') })

  // The social preview: the headline next to the end of the landing page conversation.
  const FONT = fs.readFileSync(path.join(ROOT, 'site/fonts/bricolage-grotesque-latin.woff2'))
  page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
  await page.setContent(`<style>
@font-face { font-family: Bricolage; src: url(data:font/woff2;base64,${FONT.toString('base64')}) format('woff2'); font-weight: 200 800; font-stretch: 75% 100%; }
body { margin: 0; width: 1200px; height: 630px; overflow: hidden; display: flex; align-items: center; justify-content: space-between; gap: 44px; padding: 0 56px; box-sizing: border-box; background: radial-gradient(600px 400px at 85% 50%, rgb(140 147 247 / 0.22), transparent), #0b0a10; color: #f2f0ea; font-family: Bricolage, sans-serif; }
.brand { display: flex; align-items: center; gap: 14px; font-size: 36px; font-weight: 700; }
h1 { margin: 40px 0 0; font-size: 60px; white-space: nowrap; line-height: 0.9; font-weight: 800; font-stretch: 75%; letter-spacing: -0.03em; }
h1 span { display: block; color: #5d5b68; }
p { margin: 24px 0 0; font: 500 17px ui-monospace, monospace; letter-spacing: 0.1em; text-transform: uppercase; white-space: nowrap; color: #8c93f7; }
img.ui { width: 560px; flex: none; border-radius: 20px; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.12), 0 24px 60px rgb(0 0 0 / 0.5); }
</style><div><div class="brand">${fs.readFileSync(path.join(SITE, 'savor-tile.svg'), 'utf8').replace('<svg', '<svg width="56" height="56"')}Savor</div>
<h1>Your coding agents.<span>On your own machine.</span></h1><p>Open source · runs locally</p></div><img class="ui" src="${src(ending)}">`)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: path.join(SITE, 'og.png') })

  // The landing page gets WebP: the big screenshots in full and half width, the steps as taken.
  const webp = (file, width) =>
    page.evaluate(
      async ({ data, width }) => {
        const img = new Image()
        img.src = data
        await img.decode()
        const canvas = document.createElement('canvas')
        canvas.width = width ?? img.width
        canvas.height = Math.round((img.height * canvas.width) / img.width)
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
        return canvas.toDataURL('image/webp', 0.85).split(',')[1]
      },
      { data: src(fs.readFileSync(path.join(DOCS, file))), width },
    )
  const write = async (name, width, file = name) => fs.writeFileSync(path.join(SITE, `${file}.webp`), Buffer.from(await webp(`${name}.png`, width), 'base64'))
  for (const [name, width] of [['conversation', 1600], ['mobile', 1620]]) {
    await write(name, width)
    await write(name, width / 2, `${name}-${width / 2}`)
  }
  for (const name of ['step-projects', 'step-task', 'step-questions', 'step-preview', 'step-phone', 'hero-phone']) await write(name)
  for (const name of ['step-projects', 'step-task', 'step-questions', 'step-preview', 'step-phone', 'hero-phone']) fs.rmSync(path.join(DOCS, `${name}.png`))
} finally {
  await browser?.close()
  server.kill()
  site.close()
  // The daemon's preview browser outlives it for a moment and keeps writing its profile.
  await new Promise((r) => setTimeout(r, 1000))
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 })
}
