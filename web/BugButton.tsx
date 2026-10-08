import { useEffect, useRef, useState } from 'preact/hooks'
import { domToPng } from 'modern-screenshot'
import { ArrowUpRight, Bug, X } from 'lucide-preact'
import { readFileAsDataUrl, recentErrors, type Me } from './api'
import { openIssue } from './Account'
import { setPrefs, usePrefs } from './prefs'

const SIZE = 44
type Rect = { x: number; y: number; width: number; height: number }

// The CSP keeps modern-screenshot from reading the style sheets itself, so it gets the fonts as data URLs.
let fontCss: Promise<string> | undefined
const embedFonts = () =>
  (fontCss ??= Promise.all(
    [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .filter((rule) => rule instanceof CSSFontFaceRule)
      .map(async (rule) => {
        const url = rule.style.getPropertyValue('src').match(/url\("?([^")]+)"?\)/)![1]
        const data = await readFileAsDataUrl(await (await fetch(url)).blob())
        return rule.cssText.replace(url, data)
      }),
  ).then((rules) => rules.join('\n')))

// What is on screen right now, without anything marked data-feedback-ignore.
const takeScreenshot = async () =>
  domToPng(document.documentElement, {
    font: { cssText: await embedFonts() },
    width: innerWidth,
    height: innerHeight,
    scale: Math.min(devicePixelRatio, 2),
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    filter: (node) => !(node instanceof Element && node.hasAttribute('data-feedback-ignore')),
  })

// Draws the frame into the image, so the issue shows it too. The rect is relative to the image, from 0 to 1.
async function markScreenshot(dataUrl: string, rect: Rect) {
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(image, 0, 0)
  ctx.strokeStyle = '#F2545B'
  ctx.lineWidth = Math.max(3, canvas.width / 200)
  ctx.strokeRect(rect.x * canvas.width, rect.y * canvas.height, rect.width * canvas.width, rect.height * canvas.height)
  return canvas.toDataURL('image/png')
}

// Taken when the report opens, as the screen looked. The page without query, which may hold a token.
const reportContext = (me: Me) => [
  ['Page', location.hash.split('?')[0] || '/'],
  ['Version', `Savor ${me.version} · ${me.system}`],
  ['Device', navigator.userAgent.slice(0, 300)],
  ['Window', `${innerWidth}×${innerHeight} @${devicePixelRatio}x`],
  ['Language', navigator.language],
  ['Failed calls', recentErrors.join(', ') || '–'],
]

// GitHub takes no image through the issue link, so the screenshot goes to the clipboard, or else into a download.
async function handOver(shot: string) {
  const blob = new Blob([Uint8Array.from(atob(shot.split(',')[1]), (c) => c.charCodeAt(0))], { type: 'image/png' })
  const copied = await navigator.clipboard?.write([new ClipboardItem({ 'image/png': blob })]).then(() => true, () => false)
  if (copied) return 'copied'
  const a = document.createElement('a')
  a.href = shot
  a.download = 'savor-bug.png'
  a.click()
  return 'downloaded'
}

export function BugButton({ me }: { me: Me }) {
  const { bugAt } = usePrefs()
  const [size, setSize] = useState({ width: innerWidth, height: innerHeight })
  const [at, setAt] = useState(bugAt)
  const [capturing, setCapturing] = useState(false)
  const [flash, setFlash] = useState(false)
  const [report, setReport] = useState<{ shot: string | null; context: string[][] } | null>(null)
  useEffect(() => {
    embedFonts()
    const resize = () => setSize({ width: innerWidth, height: innerHeight })
    addEventListener('resize', resize)
    return () => removeEventListener('resize', resize)
  }, [])

  // Stays on screen when the window shrinks.
  const x = Math.min(Math.max(0, at?.x ?? size.width - SIZE - 16), size.width - SIZE)
  const y = Math.min(Math.max(0, at?.y ?? size.height * 0.62), size.height - SIZE)
  const drag = useRef<{ startX: number; startY: number; x: number; y: number; moved: boolean } | null>(null)
  const down = (e: PointerEvent) => {
    drag.current = { startX: e.clientX, startY: e.clientY, x, y, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
    if (d.moved) setAt({ x: d.x + dx, y: d.y + dy })
  }
  const up = () => {
    if (drag.current?.moved) setPrefs({ bugAt: { x, y } })
    else if (drag.current) open()
    drag.current = null
  }

  // The screenshot is taken before the report opens, so it shows the problem.
  const open = async () => {
    setCapturing(true)
    const context = reportContext(me)
    const shot = await takeScreenshot().catch(() => null)
    setFlash(true)
    setTimeout(() => setFlash(false), 350)
    setReport({ shot, context })
    setCapturing(false)
  }

  return (
    <>
      {!report && !capturing && (
        <button class="bug-button" data-feedback-ignore style={{ left: x, top: y }} title="Report a bug" aria-label="Report a bug" onPointerDown={down} onPointerMove={move} onPointerUp={up}>
          <Bug size={22} />
        </button>
      )}
      {flash && <div class="bug-flash" data-feedback-ignore />}
      {report && <BugReport report={report} setShot={(shot) => setReport({ ...report, shot })} onClose={() => setReport(null)} />}
    </>
  )
}

function BugReport({ report, setShot, onClose }: { report: { shot: string | null; context: string[][] }; setShot: (shot: string | null) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [marking, setMarking] = useState(false)
  const [sent, setSent] = useState<'copied' | 'downloaded' | 'none' | null>(null)
  const send = async () => {
    const handed = report.shot ? handOver(report.shot) : Promise.resolve('none' as const)
    openIssue(text, report.context.map(([label, value]) => `${label}: ${value}`).join('\n'))
    setSent(await handed)
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (marking ? setMarking(false) : onClose())
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [marking])

  return (
    <div class="overlay" data-feedback-ignore onClick={onClose}>
      <div class="dialog feedback-dialog" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          <Bug size={18} />
          <div class="dialog-title">
            <b>Report a bug</b>
          </div>
          <button class="icon-btn" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {sent ? (
          <p class="dialog-body">
            The issue form is open in your browser with your text filled in.
            {sent === 'copied' && ' The screenshot is in your clipboard: paste it into the issue with Ctrl+V or ⌘V, then submit.'}
            {sent === 'downloaded' && ' The screenshot was downloaded as savor-bug.png: drag it into the issue, then submit.'}
            {sent === 'none' && ' Submit it there.'}
          </p>
        ) : (
          <div class="dialog-body form">
            <label>
              What went wrong?
              <textarea rows={5} maxLength={4000} autoFocus placeholder="What did you do, what happened, what did you expect?" value={text} onInput={(e) => setText(e.currentTarget.value)} />
            </label>
            {report.shot && (
              <>
                <img class="bug-shot" src={report.shot} alt="Screenshot" />
                <div class="row small">
                  <button class="link" onClick={() => setShot(null)}>
                    Remove screenshot
                  </button>
                  <span class="muted">·</span>
                  <button class="link" onClick={() => setMarking(true)}>
                    Mark the spot
                  </button>
                </div>
              </>
            )}
            <details class="bug-context">
              <summary>Sent along</summary>
              <dl>
                {report.context.flatMap(([label, value]) => [<dt key={`${label}-t`}>{label}</dt>, <dd key={label}>{value}</dd>])}
              </dl>
            </details>
            <span class="muted small">Opens a GitHub issue in your browser.{report.shot && ' The screenshot goes to your clipboard to paste it there.'}</span>
          </div>
        )}
        <footer class="dialog-foot">
          <span />
          {sent ? (
            <button class="primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <button class="primary" disabled={!text.trim()} onClick={send}>
              Continue on GitHub <ArrowUpRight size={15} />
            </button>
          )}
        </footer>
      </div>
      {marking && report.shot && (
        <MarkSpot
          shot={report.shot}
          onCancel={() => setMarking(false)}
          onDone={async (rect) => {
            setShot(await markScreenshot(report.shot!, rect))
            setMarking(false)
          }}
        />
      )}
    </div>
  )
}

// A frame dragged over the screenshot, relative to the image.
function MarkSpot({ shot, onCancel, onDone }: { shot: string; onCancel: () => void; onDone: (rect: Rect) => void }) {
  const [rect, setRect] = useState<Rect | null>(null)
  const image = useRef<HTMLImageElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const relative = (e: PointerEvent) => {
    const box = image.current!.getBoundingClientRect()
    return { x: Math.min(Math.max(0, (e.clientX - box.left) / box.width), 1), y: Math.min(Math.max(0, (e.clientY - box.top) / box.height), 1) }
  }
  const down = (e: PointerEvent) => {
    start.current = relative(e)
    setRect(null)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    const s = start.current
    if (!s) return
    const p = relative(e)
    setRect({ x: Math.min(p.x, s.x), y: Math.min(p.y, s.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y) })
  }
  const up = () => {
    start.current = null
    if (rect && (rect.width < 0.01 || rect.height < 0.01)) setRect(null)
  }
  const img = image.current
  return (
    <div class="bug-mark" onClick={(e) => e.stopPropagation()}>
      <div class="bug-mark-bar">
        <span>Drag a frame around the spot</span>
        <button class="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button class="primary" disabled={!rect} onClick={() => onDone(rect!)}>
          Done
        </button>
      </div>
      <div class="bug-mark-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up}>
        <img ref={image} src={shot} alt="Screenshot" draggable={false} />
        {rect && img && (
          <div
            class="bug-mark-frame"
            style={{ left: img.offsetLeft + rect.x * img.width, top: img.offsetTop + rect.y * img.height, width: rect.width * img.width, height: rect.height * img.height }}
          />
        )}
      </div>
    </div>
  )
}
