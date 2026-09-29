import { useEffect, useRef, useState } from 'preact/hooks'
import { ArrowLeft, ArrowRight, Crosshair, ExternalLink, RotateCw } from 'lucide-preact'
import { api, useEvent } from './api'
import type { Picked } from './Composer'

const VIEWPORT = { width: 1280, height: 800 }
const KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

// Shows the same headless page the agent drives. Clicks, keys and scrolling are forwarded to it.
export function Preview({ base, threadId, url, onPick }: { base: string; threadId: string; url: string | null; onPick: (p: Picked) => void }) {
  const [frame, setFrame] = useState<string | null>(null)
  const [address, setAddress] = useState(url ?? '')
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const [stream, setStream] = useState(0)
  const img = useRef<HTMLImageElement>(null)

  useEffect(() => setAddress(url ?? ''), [url])
  useEffect(() => {
    if (!url) return
    const es = new EventSource(`/api${base}/browser/stream`)
    es.onmessage = (m) => setFrame(m.data)
    return () => es.close()
  }, [base, url, stream])
  // Reconnect when the agent (re)opens the preview, e.g. after a daemon restart.
  useEvent((e) => e.type === 'browser' && e.threadId === threadId && setStream((n) => n + 1), [threadId])

  const input = (body: object) => api('POST', `${base}/browser/input`, body).catch((e) => setError(e.message))
  const point = (e: MouseEvent) => {
    const r = img.current!.getBoundingClientRect()
    return { x: Math.round(((e.clientX - r.left) / r.width) * VIEWPORT.width), y: Math.round(((e.clientY - r.top) / r.height) * VIEWPORT.height) }
  }
  const click = async (e: MouseEvent) => {
    img.current?.focus()
    if (!picking) return input({ type: 'click', ...point(e) })
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
      {url && frame ? (
        <img
          ref={img}
          class={`screen ${picking ? 'picking' : ''}`}
          src={`data:image/jpeg;base64,${frame}`}
          alt="Preview"
          tabIndex={0}
          draggable={false}
          onClick={click}
          onWheel={(e) => (e.preventDefault(), input({ type: 'scroll', dy: e.deltaY }))}
          onKeyDown={(e) => {
            if (e.metaKey || e.ctrlKey) return
            e.preventDefault()
            if (KEYS.has(e.key)) input({ type: 'key', key: e.key })
            else if (e.key.length === 1) input({ type: 'type', text: e.key })
          }}
        />
      ) : (
        <p class="muted center">{url ? 'Connecting…' : 'Enter a URL, or let the agent open the app it built.'}</p>
      )}
    </div>
  )
}
