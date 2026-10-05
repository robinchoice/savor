import os from 'node:os'
import type { ServerResponse } from 'node:http'
import type { IPty } from 'node-pty'
import { emit, openStream } from './events.js'

// One shell per project folder or worktree, shared by every window that shows it. Shells live as
// long as the daemon does; their recent output is kept so a window that opens later sees it.

const SCROLLBACK = 200_000

interface Session { projectId: string; pty: IPty; output: string }
interface Viewer { res: ServerResponse; remote: boolean }

const sessions = new Map<string, Session>()
const viewers = new Map<string, Set<Viewer>>()

const send = (cwd: string, data: object) => viewers.get(cwd)?.forEach((v) => v.res.write(`data: ${JSON.stringify(data)}\n\n`))
const within = (n: unknown, min: number, max: number) => Math.round(Math.min(max, Math.max(min, Number(n) || min)))

function shell() {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || os.userInfo().shell || '/bin/sh'
}

export const running = (cwd: string) => sessions.has(cwd)

export async function start(projectId: string, cwd: string, cols: number, rows: number) {
  if (sessions.has(cwd)) return resize(projectId, cwd, cols, rows)
  // Loaded on first use: it is a native module, and the daemon runs without it.
  const pty = await import('node-pty')
  // The desktop app runs the daemon as Node inside Electron; programs started in the shell must not.
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env
  const s: Session = {
    projectId,
    output: '',
    pty: pty.spawn(shell(), [], { name: 'xterm-256color', cwd, cols: within(cols, 10, 500), rows: within(rows, 2, 200), env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } }),
  }
  sessions.set(cwd, s)
  s.pty.onData((o) => {
    s.output = (s.output + o).slice(-SCROLLBACK)
    send(cwd, { o })
  })
  // A shell ended by stop() is already gone from the map, and its viewers were told.
  s.pty.onExit(({ exitCode }) => {
    if (sessions.get(cwd) !== s) return
    sessions.delete(cwd)
    send(cwd, { exit: exitCode })
    emit({ type: 'terminal', projectId })
  })
  send(cwd, { reset: true, o: '', running: true })
  emit({ type: 'terminal', projectId })
}

function session(projectId: string, cwd: string) {
  const s = sessions.get(cwd)
  return s?.projectId === projectId ? s : undefined
}

export const input = (projectId: string, cwd: string, data: string) => session(projectId, cwd)?.pty.write(data)

export function resize(projectId: string, cwd: string, cols: number, rows: number) {
  session(projectId, cwd)?.pty.resize(within(cols, 10, 500), within(rows, 2, 200))
}

export function stop(cwd: string) {
  const s = sessions.get(cwd)
  if (!s) return
  sessions.delete(cwd)
  s.pty.kill()
  send(cwd, { exit: null })
  emit({ type: 'terminal', projectId: s.projectId })
}

export function stopProject(projectId: string) {
  for (const [cwd, s] of sessions) if (s.projectId === projectId) stop(cwd)
}

export function watch(cwd: string, res: ServerResponse, remote: boolean) {
  openStream(res)
  const open = viewers.get(cwd) ?? new Set()
  viewers.set(cwd, open)
  const v = { res, remote }
  open.add(v)
  res.on('close', () => open.delete(v))
  res.write(`data: ${JSON.stringify({ reset: true, o: sessions.get(cwd)?.output ?? '', running: sessions.has(cwd) })}\n\n`)
}

// When the terminal is switched off for paired devices, the ones watching lose it right away.
export function disconnectRemote() {
  for (const open of viewers.values()) for (const v of open) if (v.remote) v.res.destroy()
}
