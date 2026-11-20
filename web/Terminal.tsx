import { useEffect, useRef, useState } from 'preact/hooks'
import { lazy, Suspense } from 'preact/compat'
import { Folder, GitBranch, Lock, Maximize2, Minimize2, Plus, RotateCcw, SquareTerminal, X } from 'lucide-preact'
import '@xterm/xterm/css/xterm.css'
import { api, useApi, type Project } from './api'
import { setPrefs, usePrefs } from './prefs'
import { useShortcut } from './Shortcuts'
import { t } from './i18n'

// xterm.js adds <style> elements and has no option for a CSP nonce. Style elements made by script
// get the page's nonce: script is same-origin only, and the nonce is readable by it anyway.
const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? ''
const createElement = document.createElement
document.createElement = function (this: Document, tag: string, options?: ElementCreationOptions) {
  const el = createElement.call(this, tag, options)
  if (tag.toLowerCase() === 'style') el.nonce = nonce
  return el
} as typeof document.createElement

// xterm.js and its addons load with the first shell that is shown.
const Shell = lazy(() => import('./Shell'))

interface TerminalPlace { path: string; branch: string | null; threads: string[] }
export interface TerminalTab { id: string; path: string; running: boolean }
interface Terminals { places: TerminalPlace[]; terminals: TerminalTab[] }

// A shell takes the focus when it is opened on request, not when it comes back with its project.
let focusShell = false
export function setTerminalOpen(open: boolean) {
  focusShell = open
  setPrefs({ terminalOpen: open })
}

// Terminals in the project folder and its worktrees, in a panel below every view of the project.
export function TerminalPanel({ project, threadId }: { project: Project; threadId?: string }) {
  const { terminalMax } = usePrefs()
  const base = `/projects/${project.id}/terminal`
  const [data, reload, error] = useApi<Terminals>(base, (e) => (e.type === 'terminal' || e.type === 'thread') && (!e.projectId || e.projectId === project.id))
  const [pick, setPick] = useState<{ threadId?: string; id: string | null }>({ id: null })
  const [adding, setAdding] = useState(false)
  const restart = useRef<() => void>(() => {})
  const addRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!adding) return
    const on = (e: MouseEvent) => !e.composedPath().includes(addRef.current!) && setAdding(false)
    setTimeout(() => addEventListener('click', on))
    return () => removeEventListener('click', on)
  }, [adding])
  const places = data?.places ?? []
  const terminals = data?.terminals ?? []
  // The panel follows the open conversation into its worktree, until a terminal is picked there. One
  // closed meanwhile, here or elsewhere, falls back to the first.
  const setSelected = (id: string | null) => setPick({ threadId, id })
  useEffect(() => {
    selector = (id) => {
      wanted = null
      reload().then(() => setSelected(id))
    }
    if (wanted) selector(wanted)
    return () => void (selector = null)
  }, [threadId])
  const place = places.find((p) => threadId && p.threads.includes(threadId)) ?? places[0]
  const current = terminals.find((t) => pick.threadId === threadId && t.id === pick.id) ?? terminals.find((t) => t.path === place?.path) ?? terminals[0]
  const label = (t: TerminalTab) => {
    const n = terminals.filter((o) => o.path === t.path).indexOf(t)
    return (places.find((p) => p.path === t.path)?.branch ?? project.name) + (n ? ` ${n + 1}` : '')
  }

  const add = async (path: string) => {
    setAdding(false)
    focusShell = true
    const t = await api<TerminalTab>('POST', base, { path })
    await reload()
    setSelected(t.id)
  }
  const close = (t: TerminalTab) => {
    if (t.id === current?.id) {
      const rest = terminals.filter((o) => o !== t)
      setSelected((rest[terminals.indexOf(t)] ?? rest[rest.length - 1])?.id ?? null)
    }
    api('DELETE', `${base}/${t.id}`).catch(() => {})
  }

  return (
    <div class={`terminal-panel ${terminalMax ? 'max' : ''}`}>
      <div class="terminal-bar">
        <span class="terminal-title">
          <SquareTerminal size={15} /> <span>{t('Terminal')}</span>
        </span>
        <div class="terminal-places">
          {!error &&
            terminals.map((th) => (
              <div key={th.id} class={`terminal-place ${th.id === current?.id ? 'on' : ''}`} title={th.path}>
                <button onClick={() => ((focusShell = true), setSelected(th.id))}>
                  {places.find((p) => p.path === th.path)?.branch ? <GitBranch size={13} /> : <Folder size={13} />}
                  {label(th)}
                  <i class={th.running ? 'running' : ''} />
                </button>
                <button class="terminal-close" title={t('Close terminal')} onClick={() => close(th)}>
                  <X size={12} />
                </button>
              </div>
            ))}
        </div>
        {data && !error && (
          <div class="menu-anchor" ref={addRef}>
            <button class="icon-btn" title={t('New terminal')} onClick={() => (places.length > 1 ? setAdding(!adding) : add(places[0].path))}>
              <Plus size={15} />
            </button>
            {adding && (
              <div class="menu right">
                <div class="menu-label">{t('New terminal in')}</div>
                {places.map((p) => (
                  <button key={p.path} title={p.path} onClick={() => add(p.path)}>
                    {p.branch ? <GitBranch size={13} /> : <Folder size={13} />}
                    <span>{p.branch ?? project.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {current && !error && (
          <button class="icon-btn" title={t('Restart shell')} onClick={() => restart.current()}>
            <RotateCcw size={14} />
          </button>
        )}
        <button class="icon-btn" title={terminalMax ? t('Restore') : t('Maximize')} onClick={() => setPrefs({ terminalMax: !terminalMax })}>
          {terminalMax ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button class="icon-btn" title={t('Close')} onClick={() => setPrefs({ terminalOpen: false })}>
          <X size={15} />
        </button>
      </div>
      {error ? (
        <div class="terminal-locked">
          <Lock size={20} />
          <p>{error.message}</p>
        </div>
      ) : current ? (
        <Suspense fallback={<div class="terminal-screen" />}>
          <Shell key={current.id} project={project} id={current.id} restart={restart} host={host} />
        </Suspense>
      ) : (
        data && (
          <div class="terminal-locked">
            <p>{t('No terminal open.')}</p>
            <button class="pill" onClick={() => add(places[0].path)}>
              <Plus size={14} /> {t('New terminal')}
            </button>
          </div>
        )
      )}
    </div>
  )
}

// A command from the context menu goes to the shell on screen, or waits until the opened panel shows one.
// Where no panel can open, as in the inbox, `home` goes to the project that has one.
let runner: ((command: string) => void) | null = null
let queued: string | null = null
let home: (() => void) | null = null
export const setTerminalHome = (show: (() => void) | null) => void (home = show)
export function runInTerminal(command: string) {
  if (runner) return runner(command)
  queued = command
  setPrefs({ terminalOpen: true })
  home?.()
}

// What the shell on screen takes from here: the focus when it was opened on request, and the commands, with the one
// that waited for it.
export interface ShellHost { focus: () => boolean; attach: (run: (command: string) => void) => string | null; detach: (run: (command: string) => void) => void }
const host: ShellHost = {
  focus() {
    const wanted = focusShell
    focusShell = false
    return wanted
  },
  attach(run) {
    runner = run
    const command = queued
    queued = null
    return command
  },
  detach: (run) => void (runner === run && (runner = null)),
}

// A terminal made elsewhere (e.g. a conversation opened in the agent's terminal UI) is shown, also when
// the panel opens only now.
let selector: ((id: string) => void) | null = null
let wanted: string | null = null
export function showTerminal(id: string) {
  wanted = id
  selector?.(id)
  setTerminalOpen(true)
}

// The button that opens the panel, with a dot while a shell of the project runs.
export function TerminalButton({ project }: { project: Project }) {
  const { terminalOpen } = usePrefs()
  const [data] = useApi<Terminals>(`/projects/${project.id}/terminal`, (e) => e.type === 'terminal' && (!e.projectId || e.projectId === project.id))
  useShortcut('terminal', () => setTerminalOpen(!terminalOpen))
  return (
    <button class={`icon-btn ${terminalOpen ? 'on' : ''}`} title={t('Terminal')} onClick={() => setTerminalOpen(!terminalOpen)}>
      <SquareTerminal size={16} />
      {data?.terminals.some((t) => t.running) && <i class="terminal-running" />}
    </button>
  )
}
