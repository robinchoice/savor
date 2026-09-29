import fs from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'

// One headless page per thread. The agent drives it; the UI shows its screenshots
// next to a live iframe of the same URL.

let browser: Promise<Browser> | null = null
const pages = new Map<string, { page: Page; errors: string[]; shot: Buffer | null }>()

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
  const found = candidates.find((c) => c && fs.existsSync(c))
  if (!found) throw new Error('No Chromium found. Set SAVOR_CHROMIUM or run `npx playwright-core install chromium`.')
  return found
}

async function session(tid: string) {
  const s = pages.get(tid)
  if (!s) throw new Error('No preview open. Call open_browser first.')
  return s
}

export async function open(tid: string, url: string) {
  let s = pages.get(tid)
  if (!s) {
    browser ??= chromium.launch({ executablePath: executable() })
    const page = await (await browser).newPage({ viewport: { width: 1280, height: 800 } })
    s = { page, errors: [], shot: null }
    const errors = s.errors
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(e.message))
    pages.set(tid, s)
  }
  await s.page.goto(url, { waitUntil: 'domcontentloaded' })
  await snapshot(tid)
}

export async function snapshot(tid: string) {
  const s = await session(tid)
  s.shot = await s.page.screenshot({ type: 'png' })
  return s.shot
}

export const lastShot = (tid: string) => pages.get(tid)?.shot ?? null

export async function inspect(tid: string) {
  const s = await session(tid)
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
  const s = await session(tid)
  await fn(s.page)
  await s.page.waitForLoadState('domcontentloaded').catch(() => {})
  await snapshot(tid)
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
