import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Folder, GitBranch, Lock, Maximize2, Minimize2, RotateCcw, SquareTerminal, X } from 'lucide-preact'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, useApi, type Project } from './api'
import { transport } from './transport'
import { setPrefs, usePrefs } from './prefs'

// xterm.js adds <style> elements and has no option for a CSP nonce. Style elements made by script
// get the page's nonce: script is same-origin only, and the nonce is readable by it anyway.
const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? ''
const createElement = document.createElement
document.createElement = function (this: Document, tag: string, options?: ElementCreationOptions) {
  const el = createElement.call(this, tag, options)
  if (tag.toLowerCase() === 'style') el.nonce = nonce
  return el
} as typeof document.createElement

export interface TerminalPlace { path: string; branch: string | null; running: boolean; threads: string[] }

const THEME = { background: '#0a0a0c', foreground: '#d7d7dc', cursor: '#d7d7dc', selectionBackground: '#3a3a42' }
const FONT = "'Geist Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace"

// Shells per project folder and worktree, in a panel below every view of the project.
export function TerminalPanel({ project, threadId }: { project: Project; threadId?: string }) {
  const { terminalHeight, terminalMax } = usePrefs()
  const [places, , error] = useApi<TerminalPlace[]>(`/projects/${project.id}/terminal`, (e) => (e.type === 'terminal' || e.type === 'thread') && (!e.projectId || e.projectId === project.id))
  const [cwd, setCwd] = useState<string | null>(null)
  const [height, setHeight] = useState(terminalHeight)
  const restart = useRef<() => void>(() => {})
  // The panel follows the open conversation into its worktree.
  useEffect(() => {
    if (places) setCwd((places.find((p) => threadId && p.threads.includes(threadId)) ?? places[0]).path)
  }, [threadId, !!places])
  // A worktree deleted meanwhile falls back to the project folder.
  const current = cwd === null ? undefined : (places?.find((p) => p.path === cwd) ?? places?.[0])

  const drag = (e: PointerEvent) => {
    const move = (m: PointerEvent) => setHeight(Math.round(Math.min(innerHeight - 160, Math.max(120, innerHeight - m.clientY))))
    const up = (u: PointerEvent) => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      setPrefs({ terminalHeight: Math.round(Math.min(innerHeight - 160, Math.max(120, innerHeight - u.clientY))) })
    }
    e.preventDefault()
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  return (
    <div class={`terminal-panel ${terminalMax ? 'max' : ''}`} style={{ height }}>
      <div class="terminal-grip" onPointerDown={drag} />
      <div class="terminal-bar">
        <span class="terminal-title">
          <SquareTerminal size={15} /> <span>Terminal</span>
        </span>
        <div class="terminal-places">
          {!error &&
            places?.map((p) => (
              <button key={p.path} class={`terminal-place ${p.path === current?.path ? 'on' : ''}`} title={p.path} onClick={() => setCwd(p.path)}>
                {p.branch ? <GitBranch size={13} /> : <Folder size={13} />}
                {p.branch ?? project.name}
                <i class={p.running ? 'running' : ''} />
              </button>
            ))}
        </div>
        {!error && (
          <button class="icon-btn" title="Restart shell" onClick={() => restart.current()}>
            <RotateCcw size={14} />
          </button>
        )}
        <button class="icon-btn" title={terminalMax ? 'Restore' : 'Maximize'} onClick={() => setPrefs({ terminalMax: !terminalMax })}>
          {terminalMax ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button class="icon-btn" title="Close (Ctrl+`)" onClick={() => setPrefs({ terminalOpen: false })}>
          <X size={15} />
        </button>
      </div>
      {error ? (
        <div class="terminal-locked">
          <Lock size={20} />
          <p>{error.message}</p>
        </div>
      ) : (
        current && <Shell key={current.path} project={project} path={current.path} restart={restart} />
      )}
    </div>
  )
}

const KEYS: [string, string][] = [
  ['esc', '\x1b'],
  ['tab', '\t'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['|', '|'],
  ['~', '~'],
  ['/', '/'],
  ['-', '-'],
]

function Shell({ project, path, restart }: { project: Project; path: string; restart: { current: () => void } }) {
  const ref = useRef<HTMLDivElement>(null)
  // Phone keyboards lack these keys, so touch screens get a row of them.
  const touch = useMemo(() => matchMedia('(pointer: coarse)').matches, [])
  const [ctrl, setCtrl] = useState(false)
  const ctrlRef = useRef(false)
  ctrlRef.current = ctrl
  const send = useRef<(data: string) => void>(() => {})

  useEffect(() => {
    const base = `/projects/${project.id}/terminal`
    const term = new XTerm({ fontFamily: FONT, fontSize: 13, cursorBlink: true, scrollback: 5000, theme: THEME })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const size = () => ({ path, cols: term.cols, rows: term.rows })
    const open = () => api('POST', `${base}/open`, size()).catch((e: Error) => term.write(`\r\n${e.message}\r\n`))
    restart.current = () => api('POST', `${base}/restart`, size()).catch((e: Error) => term.write(`\r\n${e.message}\r\n`))

    // Keystrokes go out one request at a time, so they arrive in order.
    let running = false
    let pending = ''
    let sending = false
    const flush = async () => {
      if (sending || !pending) return
      sending = true
      const data = pending
      pending = ''
      await api('POST', `${base}/input`, { path, data }).catch(() => {})
      sending = false
      flush()
    }
    send.current = (data) => {
      if (!running) return void open()
      pending += data
      flush()
    }
    term.onData((data) => {
      if (ctrlRef.current && data.length === 1) {
        data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31)
        setCtrl(false)
      }
      send.current(data)
    })
    // Ctrl+Shift+C copies the selection, as in other terminals on Linux and Windows.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey || e.code !== 'KeyC' || !term.hasSelection()) return true
      navigator.clipboard.writeText(term.getSelection())
      e.preventDefault()
      return false
    })
    let resizing: ReturnType<typeof setTimeout>
    term.onResize(() => {
      clearTimeout(resizing)
      resizing = setTimeout(() => running && api('POST', `${base}/resize`, size()).catch(() => {}), 100)
    })

    const onData = (raw: string) => {
      const m = JSON.parse(raw)
      if (m.reset) term.reset()
      if (m.o) term.write(m.o)
      if ('running' in m) running = m.running
      if ('exit' in m) {
        running = false
        term.write('\r\n\x1b[2m[Shell exited. Press any key to start a new one.]\x1b[0m\r\n')
      }
    }
    const observer = new ResizeObserver(() => fit.fit())
    let closed = false
    let stop = () => {}
    // The cell size is measured on open, so the font has to be there first.
    document.fonts.load(`13px ${FONT}`).finally(() => {
      if (closed) return
      term.open(ref.current!)
      fit.fit()
      observer.observe(ref.current!)
      term.focus()
      stop = transport.stream(`/api${base}/stream?path=${encodeURIComponent(path)}`, onData)
      open()
    })
    return () => {
      closed = true
      stop()
      observer.disconnect()
      clearTimeout(resizing)
      term.dispose()
    }
  }, [project.id, path])

  return (
    <>
      <div class="terminal-screen" ref={ref} />
      {touch && (
        <div class="terminal-keys">
          <button class={ctrl ? 'on' : ''} onClick={() => setCtrl(!ctrl)}>
            ctrl
          </button>
          {KEYS.map(([label, data]) => (
            <button key={label} onClick={() => send.current(data)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

// The button that opens the panel, with a dot while a shell of the project runs. Ctrl+` works too.
export function TerminalButton({ project }: { project: Project }) {
  const { terminalOpen } = usePrefs()
  const [places] = useApi<TerminalPlace[]>(`/projects/${project.id}/terminal`, (e) => e.type === 'terminal' && (!e.projectId || e.projectId === project.id))
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== '`') return
      e.preventDefault()
      e.stopPropagation()
      setPrefs({ terminalOpen: !terminalOpen })
    }
    addEventListener('keydown', on, true)
    return () => removeEventListener('keydown', on, true)
  }, [terminalOpen])
  return (
    <button class={`icon-btn ${terminalOpen ? 'on' : ''}`} title="Terminal (Ctrl+`)" onClick={() => setPrefs({ terminalOpen: !terminalOpen })}>
      <SquareTerminal size={16} />
      {places?.some((p) => p.running) && <i class="terminal-running" />}
    </button>
  )
}
