import { useEffect, useRef, useState } from 'preact/hooks'
import { ArrowLeft, ArrowRight, Crosshair, ExternalLink, Monitor, PanelLeftClose, PanelLeftOpen, RotateCw, Scan, Smartphone } from 'lucide-preact'
import { api, useEvent } from './api'
import { transport } from './transport'
import { setPrefs, usePrefs, type Device } from './prefs'
import type { Picked } from './Composer'

// Shortcuts with Ctrl or Cmd that edit the page; the rest stay with Savor and the browser.
const EDITING = new Set(['a', 'z', 'y'])
const KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])
const DEVICES: [Device, typeof Scan, string, string][] = [
  ['fit', Scan, 'Fit', 'Draw the page in the size of this space'],
  ['desktop', Monitor, '1280', 'Desktop layout, scaled down where the space is narrower'],
  ['phone', Smartphone, '390', 'Phone layout'],
]

// Shows the same headless page the agent drives, drawn in the size of the space it gets here.
// Mouse, keys, scrolling and the clipboard are forwarded to it.
export function Preview({ base, threadId, url, onPick, narrow, chatHidden, onToggleChat }: { base: string; threadId: string; url: string | null; onPick: (p: Picked) => void; narrow: boolean; chatHidden: boolean; onToggleChat: () => void }) {
  const [frame, setFrame] = useState<string | null>(null)
  const [address, setAddress] = useState(url ?? '')
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const [stream, setStream] = useState(0)
  // The cursor the page shows under the mouse, e.g. a hand over links.
  const [cursor, setCursor] = useState('default')
  // The space for the page here, and the size of the frames that arrive.
  const [space, setSpace] = useState({ width: 0, height: 0 })
  const [shown, setShown] = useState({ width: 0, height: 0 })
  const asked = useRef('')
  // One hover request at a time; moves in between only keep the latest point.
  const hovering = useRef<{ x: number; y: number } | null | false>(false)
  const wrap = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const prefs = usePrefs()
  const device = narrow ? 'fit' : prefs.previewDevice

  useEffect(() => {
    if (url) setAddress(url)
  }, [url])
  useEffect(() => {
    if (!url) return
    return transport.stream(`/api${base}/browser/stream`, setFrame)
  }, [base, url, stream])
  // Reconnect when the agent (re)opens the preview, e.g. after a daemon restart.
  useEvent((e) => e.type === 'browser' && e.threadId === threadId && setStream((n) => n + 1), [threadId])
  useEffect(() => {
    const el = wrap.current!
    // Measured right away too: a window that is not being drawn holds resize notifications back.
    const measure = () => setSpace({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const wanted =
    device === 'desktop'
      ? { width: 1280, height: Math.round(space.height / Math.min(1, space.width / 1280)) }
      : device === 'phone'
        ? { width: Math.min(390, space.width - 24), height: Math.min(844, space.height - 28) }
        : space
  // Ask for the size that fits whenever frames arrive in another one. Once per combination, so two
  // devices watching the same preview settle instead of taking turns.
  useEffect(() => {
    if (!space.width || !shown.width || (shown.width === wanted.width && shown.height === wanted.height)) return
    const key = `${wanted.width}x${wanted.height} for ${shown.width}x${shown.height}`
    if (asked.current === key) return
    const timer = setTimeout(() => {
      asked.current = key
      api('POST', `${base}/browser/viewport`, wanted).catch((e) => setError(e.message))
    }, 150)
    return () => clearTimeout(timer)
  }, [wanted.width, wanted.height, shown.width, shown.height])

  const scale = shown.width ? Math.min(1, space.width / shown.width, space.height / shown.height) : 1
  // One request after the other, so a release never overtakes its press.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const send = (fn: () => Promise<unknown>) => (queue.current = queue.current.then(fn).catch((e) => setError(e.message)))
  const input = (body: object) => send(() => api('POST', `${base}/browser/input`, body))
  const copy = (cut: boolean) =>
    send(async () => {
      const { text } = await api<{ text: string }>('POST', `${base}/browser/copy`, { cut })
      if (text) await navigator.clipboard.writeText(text)
    })
  const point = (e: MouseEvent) => {
    const el = img.current!
    const r = el.getBoundingClientRect()
    return { x: Math.round(((e.clientX - r.left) / r.width) * el.naturalWidth), y: Math.round(((e.clientY - r.top) / r.height) * el.naturalHeight) }
  }
  const hover = async (p: { x: number; y: number }) => {
    if (hovering.current !== false) return void (hovering.current = p)
    hovering.current = null
    const r = await api<{ cursor: string }>('POST', `${base}/browser/hover`, p).catch(() => null)
    if (r) setCursor(r.cursor === 'auto' ? 'default' : r.cursor)
    const next = hovering.current
    hovering.current = false
    if (next) hover(next)
  }
  const mouse = (e: MouseEvent, type: 'down' | 'up') => {
    if (picking || e.button !== 0) return
    if (type === 'down') {
      e.preventDefault()
      img.current?.focus()
    }
    input({ type, ...point(e), clicks: e.detail })
  }
  const pick = async (e: MouseEvent) => {
    if (!picking) return
    setPicking(false)
    const picked = await api<Picked | null>('POST', `${base}/browser/pick`, point(e))
    if (picked) onPick(picked)
  }
  const open = async (e: Event) => {
    e.preventDefault()
    try {
      await api('POST', `${base}/browser/open`, { url: address })
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div class="preview">
      <form class="preview-bar" onSubmit={open}>
        {!narrow && (
          <button type="button" class="icon-btn" title={chatHidden ? 'Show chat' : 'Hide chat'} onClick={onToggleChat}>
            {chatHidden ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        )}
        <button type="button" class="icon-btn" title="Back" onClick={() => input({ type: 'back' })}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" class="icon-btn" title="Forward" onClick={() => input({ type: 'forward' })}>
          <ArrowRight size={15} />
        </button>
        <button type="button" class="icon-btn" title="Reload" onClick={() => input({ type: 'reload' })}>
          <RotateCw size={15} />
        </button>
        <input value={address} placeholder="http://localhost:3000" onInput={(e) => setAddress(e.currentTarget.value)} />
        {!narrow && (
          <>
            {frame && shown.width > 0 && <span class="size">{scale < 1 ? `${shown.width} px · ${Math.round(scale * 100)} %` : `${shown.width} × ${shown.height}`}</span>}
            <div class="devices">
              {DEVICES.map(([id, Icon, label, title]) => (
                <button key={id} type="button" class={device === id ? 'on' : ''} aria-pressed={device === id} title={title} onClick={() => setPrefs({ previewDevice: id })}>
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
          </>
        )}
        <button type="button" class={`icon-btn ${picking ? 'on' : ''}`} title="Select an element to point the agent at" disabled={!frame} onClick={() => setPicking(!picking)}>
          <Crosshair size={15} />
        </button>
        {url && (
          <a class="icon-btn" href={url} target="_blank" rel="noreferrer" title="Open in browser">
            <ExternalLink size={15} />
          </a>
        )}
      </form>
      {error && <div class="error-text pad">{error}</div>}
      <div class="screen-wrap" ref={wrap}>
        {url && frame ? (
          <img
            ref={img}
            class={`screen ${picking ? 'picking' : ''} ${device === 'phone' ? 'phone' : ''}`}
            style={{ ...(shown.width && { width: shown.width * scale, height: shown.height * scale }), ...(!picking && { cursor }) }}
            src={`data:image/jpeg;base64,${frame}`}
            alt="Preview"
            tabIndex={0}
            draggable={false}
            onLoad={(e) => {
              const { naturalWidth: width, naturalHeight: height } = e.currentTarget
              if (width !== shown.width || height !== shown.height) setShown({ width, height })
            }}
            // Captured, so a drag that leaves the picture still ends in the page.
            onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
            onMouseDown={(e) => mouse(e, 'down')}
            onMouseUp={(e) => mouse(e, 'up')}
            onClick={pick}
            onMouseMove={(e) => hover(point(e))}
            onWheel={(e) => (e.preventDefault(), input({ type: 'scroll', dy: e.deltaY }))}
            onKeyDown={(e) => {
              // AltGr comes as Ctrl+Alt on Windows and types a character.
              const mod = (e.ctrlKey || e.metaKey) && !e.altKey
              const k = e.key.toLowerCase()
              // Pasting arrives as a paste event, with the clipboard's text.
              if (mod && !(k === 'c' || k === 'x' || EDITING.has(k) || KEYS.has(e.key))) return
              e.preventDefault()
              if (mod && (k === 'c' || k === 'x')) return copy(k === 'x')
              const combo = `${mod ? 'ControlOrMeta+' : ''}${e.altKey && !e.ctrlKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key}`
              if (mod || KEYS.has(e.key)) input({ type: 'key', key: combo })
              else if (e.key.length === 1) input({ type: 'type', text: e.key })
            }}
            onPaste={(e) => {
              e.preventDefault()
              const text = e.clipboardData?.getData('text/plain')
              if (text) input({ type: 'paste', text })
            }}
          />
        ) : (
          <p class="muted center">{url ? 'Connecting…' : 'Enter a URL, or let the agent open the app it built.'}</p>
        )}
      </div>
    </div>
  )
}
