import os from 'node:os'
import type { ServerResponse } from 'node:http'
import type { IPty } from 'node-pty'
import { emit, openStream } from './events.js'
import { newId } from './store.js'

// Terminals of a project, each a shell in the project folder or a worktree, shared by every window
// that shows it. Every folder starts with one, more can be added and any closed. They live as long as
// the daemon does; their recent output is kept so a window that opens later sees it.

const SCROLLBACK = 200_000

// `command` runs in the shell once it starts, e.g. an agent's terminal UI.
interface Term { id: string; projectId: string; cwd: string; pty: IPty | null; output: string; command?: string }
interface Viewer { res: ServerResponse; remote: boolean }

const terms = new Map<string, Term>()
const viewers = new Map<string, Set<Viewer>>()
// Folders that got their first terminal, so one closed there stays closed.
const seeded = new Set<string>()

const send = (id: string, data: object) => viewers.get(id)?.forEach((v) => v.res.write(`data: ${JSON.stringify(data)}\n\n`))
const within = (n: unknown, min: number, max: number) => Math.round(Math.min(max, Math.max(min, Number(n) || min)))

function shell() {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || os.userInfo().shell || '/bin/sh'
}

export function add(projectId: string, cwd: string, command?: string) {
  const t: Term = { id: newId(), projectId, cwd, pty: null, output: '', command }
  terms.set(t.id, t)
  emit({ type: 'terminal', projectId })
  return { id: t.id, path: cwd, running: false }
}

// The terminals in `folders`, in their order, each folder seen for the first time getting one.
export function list(projectId: string, folders: string[]) {
  for (const cwd of folders) if (!seeded.has(cwd)) seeded.add(cwd), add(projectId, cwd)
  return [...terms.values()]
    .filter((t) => t.projectId === projectId && folders.includes(t.cwd))
    .sort((a, b) => folders.indexOf(a.cwd) - folders.indexOf(b.cwd))
    .map((t) => ({ id: t.id, path: t.cwd, running: !!t.pty }))
}

export const get = (projectId: string, id: unknown) => {
  const t = terms.get(String(id))
  return t?.projectId === projectId ? t : undefined
}

export async function start(t: Term, cols: number, rows: number) {
  // Loaded on first use: it is a native module, and the daemon runs without it. Loading it before the
  // check keeps two calls at once from starting two shells.
  const pty = await import('node-pty')
  if (t.pty) return resize(t, cols, rows)
  // The desktop app runs the daemon as Node inside Electron; programs started in the shell must not.
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env
  const p = pty.spawn(shell(), [], { name: 'xterm-256color', cwd: t.cwd, cols: within(cols, 10, 500), rows: within(rows, 2, 200), env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
  t.pty = p
  t.output = ''
  p.onData((o) => {
    t.output = (t.output + o).slice(-SCROLLBACK)
    send(t.id, { o })
  })
  // A shell ended by stop() is already detached, and its viewers were told.
  p.onExit(({ exitCode }) => {
    if (t.pty !== p) return
    t.pty = null
    send(t.id, { exit: exitCode })
    emit({ type: 'terminal', projectId: t.projectId })
  })
  // Only the first start runs it; a restart gets a plain shell.
  if (t.command) p.write(t.command + '\r')
  t.command = undefined
  send(t.id, { reset: true, o: '', running: true })
  emit({ type: 'terminal', projectId: t.projectId })
}

export const input = (t: Term, data: string) => t.pty?.write(data)

export function resize(t: Term, cols: number, rows: number) {
  t.pty?.resize(within(cols, 10, 500), within(rows, 2, 200))
}

export function stop(t: Term) {
  const p = t.pty
  if (!p) return
  t.pty = null
  p.kill()
  send(t.id, { exit: null })
  emit({ type: 'terminal', projectId: t.projectId })
}

export function close(t: Term) {
  stop(t)
  terms.delete(t.id)
  viewers.delete(t.id)
  emit({ type: 'terminal', projectId: t.projectId })
}

// A removed worktree takes its terminals along; one made again at the same path starts with a fresh one.
export function closeFolder(cwd: string) {
  for (const t of terms.values()) if (t.cwd === cwd) close(t)
  seeded.delete(cwd)
}

export function closeProject(projectId: string) {
  for (const t of terms.values()) if (t.projectId === projectId) closeFolder(t.cwd)
}

export function watch(t: Term, res: ServerResponse, remote: boolean) {
  openStream(res)
  const open = viewers.get(t.id) ?? new Set()
  viewers.set(t.id, open)
  const v = { res, remote }
  open.add(v)
  res.on('close', () => open.delete(v))
  res.write(`data: ${JSON.stringify({ reset: true, o: t.output, running: !!t.pty })}\n\n`)
}

// When the terminal is switched off for paired devices, the ones watching lose it right away.
export function disconnectRemote() {
  for (const open of viewers.values()) for (const v of open) if (v.remote) v.res.destroy()
}
