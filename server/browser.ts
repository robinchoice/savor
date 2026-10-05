import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core'
import { openStream } from './events.js'
import { HOME } from './store.js'

// One headless page per thread inside a persistent browser profile per project, so logins in the
// preview survive restarts. Agent and user share the page: the agent drives it through MCP tools,
// the UI shows its screencast and forwards the user's clicks and keystrokes.

interface Session { page: Page; cdp: CDPSession; errors: string[]; frame: string | null; viewers: Set<ServerResponse> }

const profiles = new Map<string, Promise<BrowserContext>>()
const sessions = new Map<string, Session>()
export const VIEWPORT = { width: 1280, height: 800 }
// The UI asks for the size of the space it has for the page, within these bounds.
const SMALLEST = { width: 320, height: 240 }
const LARGEST = { width: 3840, height: 2160 }

function executable() {
  const candidates = [
    process.env.SAVOR_CHROMIUM,
    chromium.executablePath(),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  return candidates.find((c) => c && fs.existsSync(c))
}

// Installers ship without a browser: download Playwright's Chromium on first use.
function installChromium() {
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js')
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(chromium.executablePath()) : reject(new Error('Installing Chromium for the preview failed.'))))
  })
}

function profile(projectId: string) {
  let ctx = profiles.get(projectId)
  if (!ctx) {
    ctx = (async () => {
      const exe = executable() ?? (await installChromium())
      // Snap-confined Chromium can't write to hidden folders like ~/.savor.
      const root = exe.startsWith('/snap/') ? path.join(os.homedir(), 'snap', 'chromium', 'common', 'savor-profiles') : path.join(HOME, 'browser')
      return chromium.launchPersistentContext(path.join(root, path.basename(projectId)), {
        executablePath: exe,
        headless: true,
        viewport: VIEWPORT,
        // The daemon closes the browsers itself when it stops (see below).
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      })
    })()
    ctx.catch(() => profiles.delete(projectId))
    profiles.set(projectId, ctx)
  }
  return ctx
}

// Close the browsers before the daemon exits, so Chromium is done writing its profiles. A second
// Ctrl+C stops the daemon right away.
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    await Promise.allSettled([...profiles.values()].map((ctx) => ctx.then((c) => c.close())))
    process.exit(0)
  })

function session(tid: string) {
  const s = sessions.get(tid)
  if (!s) throw new Error('No preview open. Call open_browser first.')
  return s
}

const broadcast = (s: Session, data: string) => s.viewers.forEach((v) => v.write(`data: ${data}\n\n`))

export async function open(projectId: string, tid: string, url: string) {
  let s = sessions.get(tid)
  if (!s) {
    const page = await (await profile(projectId)).newPage()
    const cdp = await page.context().newCDPSession(page)
    const created: Session = { page, cdp, errors: [], frame: null, viewers: new Set() }
    page.on('console', (m) => m.type() === 'error' && created.errors.push(m.text()))
    page.on('pageerror', (e) => created.errors.push(e.message))
    page.on('close', () => sessions.get(tid) === created && sessions.delete(tid))
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      created.frame = data
      broadcast(created, data)
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    })
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: LARGEST.width, maxHeight: LARGEST.height })
    sessions.set(tid, (s = created))
  }
  await s.page.goto(url, { waitUntil: 'domcontentloaded' })
}

// Server-sent stream of base64 JPEG frames for the UI.
export async function watch(tid: string, res: ServerResponse) {
  openStream(res)
  const s = sessions.get(tid)
  if (!s) return
  s.viewers.add(res)
  res.on('close', () => s.viewers.delete(res))
  const first = s.frame ?? (await s.page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64')
  res.write(`data: ${first}\n\n`)
}

export const has = (tid: string) => sessions.has(tid)

// Agent and user share the page, so the size the user's space gives it is the size the agent sees too.
export async function resize(tid: string, width: number, height: number) {
  const within = (n: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, Number(n) || min)))
  const s = session(tid)
  await s.page.setViewportSize({ width: within(width, SMALLEST.width, LARGEST.width), height: within(height, SMALLEST.height, LARGEST.height) })
  s.frame = (await s.page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64')
  broadcast(s, s.frame)
}
export const screenshot = (tid: string) => session(tid).page.screenshot({ type: 'png' })

export async function inspect(tid: string) {
  const s = session(tid)
  const outline = await s.page.evaluate(() => {
    document.querySelectorAll('[data-savor-ref]').forEach((e) => e.removeAttribute('data-savor-ref'))
    const sel = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=tab],[contenteditable=true],h1,h2,h3'
    const lines: string[] = []
    let n = 0
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue
      const tag = el.tagName.toLowerCase()
      const field = el as HTMLInputElement
      const name = (el.getAttribute('aria-label') || el.innerText || field.value || field.placeholder || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 80)
      if (/^h[1-3]$/.test(tag)) {
        lines.push(`${tag}: ${name}`)
        continue
      }
      const ref = `e${++n}`
      el.setAttribute('data-savor-ref', ref)
      const type = el.getAttribute('type')
      lines.push(`[${ref}] ${el.getAttribute('role') || tag}${type ? `[${type}]` : ''} "${name}"${field.disabled ? ' (disabled)' : ''}`)
    }
    return `Title: ${document.title}\nURL: ${location.href}\n\nControls:\n${lines.join('\n')}\n\nText:\n${document.body.innerText.slice(0, 4000)}`
  })
  const errors = s.errors.splice(0)
  return errors.length ? `${outline}\n\nConsole errors:\n${errors.join('\n')}` : outline
}

const target = (ref: string) => `[data-savor-ref="${ref.replace(/[^a-z0-9]/gi, '')}"]`

async function act(tid: string, fn: (page: Page) => Promise<unknown>) {
  const { page } = session(tid)
  await fn(page)
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  return 'ok — call browser_inspect to see the result'
}

export const click = (tid: string, ref: string) => act(tid, (p) => p.click(target(ref), { timeout: 5000 }))
export const fill = (tid: string, ref: string, value: string) =>
  act(tid, async (p) => {
    const el = p.locator(target(ref))
    if ((await el.evaluate((e) => e.tagName)) === 'SELECT') await el.selectOption(value)
    else await el.fill(value, { timeout: 5000 })
  })
export const press = (tid: string, key: string) => act(tid, (p) => p.keyboard.press(key))
export const scroll = (tid: string, dy: number) => act(tid, (p) => p.mouse.wheel(0, dy))
export const navigate = (tid: string, url: string) => act(tid, (p) => p.goto(url, { waitUntil: 'domcontentloaded' }))

// Real keystrokes, optionally into a control first (fill replaces the value instead).
export const type = (tid: string, text: string, ref?: string) =>
  act(tid, async (p) => {
    if (ref) await p.click(target(ref), { timeout: 5000 })
    await p.keyboard.type(text, { delay: 10 })
  })

// Coordinate-based mouse input for canvases, drag handles and other things without a ref.
export const pointer = (tid: string, action: 'click' | 'dblclick' | 'move' | 'down' | 'up', x: number, y: number) =>
  act(tid, async (p) => {
    if (action === 'click') await p.mouse.click(x, y)
    if (action === 'dblclick') await p.mouse.dblclick(x, y)
    if (action === 'move') await p.mouse.move(x, y)
    if (action === 'down' || action === 'up') {
      await p.mouse.move(x, y)
      await p.mouse[action]()
    }
  })

// ---- user input from the UI (coordinates in page CSS pixels) ----

export type UserInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll'; dy: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'back' | 'forward' | 'reload' }

export async function userInput(tid: string, e: UserInput) {
  const { page } = session(tid)
  if (e.type === 'click') await page.mouse.click(e.x, e.y)
  if (e.type === 'scroll') await page.mouse.wheel(0, e.dy)
  if (e.type === 'type') await page.keyboard.type(e.text)
  if (e.type === 'key') await page.keyboard.press(e.key)
  if (e.type === 'back') await page.goBack()
  if (e.type === 'forward') await page.goForward()
  if (e.type === 'reload') await page.reload()
}

// Describe the element under a point so the user can point the agent at it ("make this bigger").
export function pick(tid: string, x: number, y: number) {
  return session(tid).page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      if (!el) return null
      const path: string[] = []
      for (let e: HTMLElement | null = el; e && e !== document.body; e = e.parentElement) {
        const cls = [...e.classList].slice(0, 2).map((c) => `.${c}`).join('')
        path.unshift(e.id ? `#${e.id}` : `${e.tagName.toLowerCase()}${cls}`)
        if (e.id) break
      }
      const cs = getComputedStyle(el)
      return {
        selector: path.join(' > '),
        text: el.innerText?.trim().slice(0, 200) ?? '',
        html: el.outerHTML.slice(0, 600),
        styles: { font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, color: cs.color, background: cs.backgroundColor, margin: cs.margin, padding: cs.padding },
        url: location.href,
      }
    },
    { x, y },
  )
}
