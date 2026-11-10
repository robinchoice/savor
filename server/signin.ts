// Signs Claude Code, Codex and the GitHub CLI in from Savor instead of a terminal, with each tool's own
// login for computers without a browser: Claude Code shows a link whose page ends with a code to paste
// back, Codex and gh show a link and a one-time code to enter there and then wait on their own. This is
// how a customer signs in on a Savor Cloud instance, where there is no terminal they know of.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { BIN, command } from './config.js'
import { emit } from './events.js'
import { listAgents } from './providers.js'

export type Tool = 'claude' | 'codex' | 'gh'
export const TOOLS: Tool[] = ['claude', 'codex', 'gh']
export interface SignIn { state: 'idle' | 'waiting' | 'done' | 'failed'; url?: string; code?: string; paste?: boolean; error?: string }

const ARGS: Record<Tool, string[]> = {
  claude: ['auth', 'login'],
  codex: ['login', '--device-auth'],
  gh: ['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', 'github.com', '--skip-ssh-key'],
}
// A device code expires after 15 minutes, and so does a login left waiting.
const TIMEOUT_MS = 15 * 60_000

interface Login { child: ChildProcess; info: SignIn; out: string; ended: Promise<void> }
const logins = new Map<Tool, Login>()

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
// Claude Code's answer follows its prompt for the code on the same line.
const lastLine = (s: string) => plain(s).trim().split('\n').pop()?.replace(/^.*if prompted > /, '').trim() || 'The sign-in failed.'

export const status = (tool: Tool): SignIn => logins.get(tool)?.info ?? { state: 'idle' }

// Starts the tool's login, one per tool at a time, and answers once it shows its link.
export function start(tool: Tool): Promise<SignIn> {
  cancel(tool)
  // No browser opens on the computer: the link opens on the device the user signs in on.
  const child = spawn(...command(BIN[tool], ARGS[tool]), { env: { ...process.env, BROWSER: 'false' }, stdio: ['pipe', 'pipe', 'pipe'], timeout: TIMEOUT_MS })
  const login: Login = { child, info: { state: 'waiting' }, out: '', ended: Promise.resolve() }
  logins.set(tool, login)
  let shown: () => void = () => {}
  const linkShown = new Promise<void>((resolve) => (shown = resolve))
  const read = (d: Buffer) => {
    login.out += d
    const text = plain(login.out)
    const url = text.match(/https:\/\/\S+/g)?.find((u) => !u.includes('cli.github.com'))
    if (!url) return
    login.info.url = url
    if (tool === 'claude') login.info.paste = true
    else {
      const code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0]
      if (!code) return
      login.info.code = code
    }
    shown()
  }
  // A pasted code after the tool ended goes nowhere.
  child.stdin!.on('error', () => {})
  // A tool that shows no link it is known for fails instead of keeping the page waiting.
  const noLink = setTimeout(() => {
    if (login.info.url || logins.get(tool) !== login) return
    login.info = { state: 'failed', error: lastLine(login.out) }
    cancel(tool)
  }, 30_000)
  linkShown.then(() => clearTimeout(noLink))
  child.stdout!.on('data', read)
  child.stderr!.on('data', read)
  login.ended = new Promise((resolve) => {
    child.on('error', (err) => ((login.info = { state: 'failed', error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? `${BIN[tool]} is not installed.` : err.message }), shown(), resolve()))
    child.on('exit', async (code) => {
      // Cancelled, or replaced by a new start: its caller still gets an answer.
      if (logins.get(tool) !== login) {
        if (login.info.state === 'waiting') login.info = { state: 'idle' }
        return shown(), resolve()
      }
      if (code === 0) {
        // gh signs git in only when asked to.
        if (tool === 'gh') await new Promise((r) => execFile(...command(BIN.gh, ['auth', 'setup-git']), { timeout: 30_000 }, r))
        login.info = { state: 'done' }
        if (tool !== 'gh') await listAgents(true).catch(() => {})
        emit({ type: 'health' })
      } else if (login.info.state === 'waiting') login.info = { state: 'failed', error: lastLine(login.out) }
      shown()
      resolve()
    })
  })
  return linkShown.then(() => login.info)
}

// Claude Code's code from the end of its sign-in page; the answer comes once Claude Code took it.
export async function submit(tool: Tool, code: string): Promise<SignIn> {
  const login = logins.get(tool)
  if (!login || login.info.state !== 'waiting' || !login.info.paste) return status(tool)
  login.child.stdin!.write(code.trim() + '\n')
  let timer: NodeJS.Timeout | undefined
  await Promise.race([login.ended, new Promise((r) => (timer = setTimeout(r, 60_000)))])
  clearTimeout(timer)
  return login.info
}

export function cancel(tool: Tool) {
  const login = logins.get(tool)
  logins.delete(tool)
  login?.child.kill()
}

// The GitHub account gh is signed in to, for cloning: null without gh or a login.
export function github(): Promise<{ installed: boolean; account: string | null }> {
  return new Promise((resolve) =>
    execFile(...command(BIN.gh, ['api', 'user', '--jq', '.login']), { timeout: 15_000 }, (err, stdout) =>
      resolve({ installed: (err as NodeJS.ErrnoException | null)?.code !== 'ENOENT', account: err ? null : stdout.trim() || null }),
    ),
  )
}

export interface Repo { name: string; description: string; private: boolean; updated: string }
export function repos(): Promise<Repo[]> {
  return new Promise((resolve, reject) =>
    execFile(...command(BIN.gh, ['repo', 'list', '--limit', '200', '--json', 'nameWithOwner,description,isPrivate,pushedAt']), { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(lastLine(stderr || err.message)))
      const list = JSON.parse(stdout) as { nameWithOwner: string; description: string | null; isPrivate: boolean; pushedAt: string }[]
      resolve(list.map((r) => ({ name: r.nameWithOwner, description: r.description ?? '', private: r.isPrivate, updated: r.pushedAt })).sort((a, b) => b.updated.localeCompare(a.updated)))
    }),
  )
}

export function clone(repo: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(...command(BIN.gh, ['repo', 'clone', repo, dir]), { timeout: 10 * 60_000 }, (err, _, stderr) => (err ? reject(new Error(lastLine(stderr || err.message))) : resolve())),
  )
}
