// Moving or renaming a project's folder, or pointing the project at the folder it already moved to.
// Conversations, git worktrees and Claude Code sessions follow it.
import fs from 'node:fs'
import path from 'node:path'
import * as store from './store.js'
import type { Project } from './store.js'
import * as agents from './agents.js'
import * as terminal from './terminal.js'
import { listWorktrees } from './git.js'
import { claudeDir } from './import.js'
import { tree } from './processes.js'
import { emit } from './events.js'

export interface MovePlan {
  from: string
  to: string
  // `move` renames the folder; `relink` points the project at a folder that already is this one,
  // reached through a symlink or moved by hand.
  mode: 'move' | 'relink'
  // What stops the move.
  blockers: string[]
  // Processes outside Savor that work in the folder: the move can go ahead anyway.
  processes: { pid: number; command: string }[]
  // The old path is a symlink to the new one, which can stay or go.
  symlink: boolean
  // Claude Code sessions that move to the folder's new name under ~/.claude/projects.
  claudeSessions: number
  worktrees: number
  // The folder leaves its parent folder or goes into one of its `_` folders: the project leaves Savor's list.
  leaves: boolean
}

export class MoveError extends Error {}

const real = (dir: string) => {
  try {
    return fs.realpathSync(dir)
  } catch {
    return null
  }
}
const isSymlink = (dir: string) => fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
const within = (dir: string, root: string) => dir === root || dir.startsWith(root + path.sep)
// Claude Code keeps a folder's sessions in ~/.claude/projects under its real path with every other character as "-".
const claudeProject = (dir: string) => path.join(claudeDir(), 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'))
const projectIdIn = (dir: string) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.savor', 'project.json'), 'utf8')).id as string
  } catch {
    return null
  }
}

// Out of the parent folder, or into a folder below it starting with `_` such as `_archive` or `_paused`. Back out of
// such a folder only another `_` folder counts. A rename next to the old place stays.
function leavesList(from: string, to: string) {
  const rel = path.relative(path.dirname(from), path.dirname(to))
  const outside = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)
  const stored = path.basename(path.dirname(from)).startsWith('_')
  return rel.split(path.sep).some((d) => d.startsWith('_')) || (outside && !stored)
}

// Where archiving puts a project: `_archive` next to its folder.
export const archivePath = (p: Project) => path.join(path.dirname(p.path), '_archive', path.basename(p.path))

// The Claude Code session folders of the old path, as written and resolved, that are not the new one.
function claudeSources(from: string, to: string) {
  const dest = claudeProject(real(to) ?? to)
  return [...new Set([from, real(from) ?? from].map(claudeProject))].filter((d) => d !== dest && fs.existsSync(d))
}

// Processes outside Savor whose working directory lies in the folder. Savor's own (agents, terminals) end with the move.
function foreignProcesses(dir: string) {
  if (process.platform !== 'linux') return []
  const own = new Set(tree(process.pid))
  const found: MovePlan['processes'] = []
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || own.has(Number(d))) continue
    try {
      if (!within(fs.readlinkSync(`/proc/${d}/cwd`), dir)) continue
      found.push({ pid: Number(d), command: fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ').trim().slice(0, 160) })
    } catch {}
  }
  return found
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function planMove(p: Project, target: string): MovePlan {
  const from = p.path
  const to = store.expand(target)
  const fromReal = real(from)
  const toReal = real(to)
  const blockers: string[] = []
  let mode: MovePlan['mode'] = 'move'
  const taken = store.listProjects().find((q) => q.id !== p.id && (q.path === to || (toReal && real(q.path) === toReal)))
  if (to === from) blockers.push('The project is already at this path.')
  else if (taken) blockers.push(`${to} is the folder of the project ${taken.name}.`)
  else if (toReal) {
    if (toReal === fromReal || projectIdIn(to) === p.id) mode = 'relink'
    else blockers.push(`${to} already exists and is another folder.`)
  } else if (!fromReal) blockers.push(`${from} no longer exists. Give the place the folder moved to.`)
  else if (isSymlink(from)) blockers.push(`${from} is a symlink to ${fromReal}. Point the project at ${fromReal} first.`)
  else if (within(to, fromReal)) blockers.push('The new place lies inside the project folder.')
  else {
    let parent = path.dirname(to)
    while (!fs.existsSync(parent)) parent = path.dirname(parent)
    if (fs.statSync(parent).dev !== fs.statSync(fromReal).dev) blockers.push(`${to} is on another file system. Savor only moves folders within one: move it yourself, then point the project at the new place.`)
  }

  const working = store.listThreads(p).filter((t) => agents.isBusy(t.id) || agents.waiting(p, t))
  if (working.length) blockers.push(`Still at work: ${working.map((t) => `“${t.title}”`).join(', ')}. Wait for ${working.length === 1 ? 'it' : 'them'} or stop ${working.length === 1 ? 'it' : 'them'}.`)
  const procs = store.listProcs(p).filter((pr) => alive(pr.pid))
  if (procs.length) blockers.push(`Registered processes still run: ${procs.map((pr) => `${pr.name} (${pr.pid})`).join(', ')}. Stop them first.`)

  return {
    from,
    to,
    mode,
    blockers,
    processes: fromReal ? foreignProcesses(fromReal) : [],
    symlink: mode === 'relink' && isSymlink(from) && real(from) === toReal,
    claudeSessions: claudeSources(from, to).reduce((n, d) => n + fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).length, 0),
    worktrees: listWorktrees(p).length,
    leaves: leavesList(from, to),
  }
}

// Moves what `src` holds into `dest`. Of two files with the same name the newer one stays.
function merge(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true })
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f)
    const d = path.join(dest, f)
    const [a, b] = [fs.statSync(s), fs.statSync(d, { throwIfNoEntry: false })]
    if (!b || (a.isFile() && b.isFile() && a.mtimeMs > b.mtimeMs)) fs.renameSync(s, d)
    else if (a.isDirectory() && b.isDirectory()) merge(s, d)
  }
  if (!fs.readdirSync(src).length) fs.rmdirSync(src)
}

// Each linked worktree's .git file names the main checkout's .git, maybe through the old path or a
// symlink that may go later: it gets the real new one. `git worktree repair` leaves links alone that
// still resolve. A .git file that names another checkout's .git belongs to someone else and stays.
function relinkWorktrees(to: string, olds: string[]) {
  const admin = path.join(to, '.git', 'worktrees')
  if (!fs.existsSync(admin)) return
  for (const name of fs.readdirSync(admin)) {
    const pointer = path.join(admin, name, 'gitdir')
    if (!fs.existsSync(pointer)) continue
    const gitfile = fs.readFileSync(pointer, 'utf8').trim()
    const named = fs.existsSync(gitfile) && fs.readFileSync(gitfile, 'utf8').match(/^gitdir: (.+)$/m)?.[1]
    if (named && [to, ...olds].some((root) => path.resolve(path.dirname(gitfile), named) === path.join(root, '.git', 'worktrees', name)))
      fs.writeFileSync(gitfile, `gitdir: ${path.join(fs.realpathSync(to), '.git', 'worktrees', name)}\n`)
  }
}

// The Claude Code sessions and worktrees of the folder follow it to `to`.
function follow(from: string, fromReal: string | null, to: string, sources: string[]) {
  for (const src of sources) merge(src, claudeProject(real(to) ?? to))
  relinkWorktrees(to, [from, ...(fromReal ? [fromReal] : [])])
}

// `link` leaves a symlink at the old path, or keeps the one there; `force` goes ahead despite processes outside Savor.
export function moveProject(p: Project, target: string, opts: { link: boolean; force: boolean }): Project {
  const plan = planMove(p, target)
  if (plan.blockers.length) throw new MoveError(plan.blockers.join(' '))
  if (plan.processes.length && !opts.force) throw new MoveError(`Processes outside Savor work in ${plan.from}: ${plan.processes.map((pr) => `${pr.command} (${pr.pid})`).join(', ')}. Move anyway to go ahead.`)
  const { from, to } = plan
  const fromReal = real(from)
  const sources = claudeSources(from, to)
  agents.endSessions(p)
  terminal.closeProject(p.id)
  if (plan.mode === 'move') {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    try {
      fs.renameSync(from, to)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EXDEV') throw new MoveError(`${to} is on another file system. Savor only moves folders within one.`)
      throw e
    }
  }
  // The registration follows first, so the project stays reachable whatever fails after.
  const moved = store.setProjectPath(p.id, to)
  // Its folder keeps the project and its conversations, so adding it again brings them back.
  if (plan.leaves) store.removeProject(p.id)
  emit({ type: 'projects' })
  if (plan.mode === 'move' && opts.link) fs.symlinkSync(to, from)
  if (plan.symlink && !opts.link) fs.unlinkSync(from)
  follow(from, fromReal, to, sources)
  return moved
}

// A project folder moved outside Savor and opened again at its new place, its old path gone: the
// project follows it, as after a move in Savor. Whether it did.
export function followMovedFolder(dir: string) {
  const to = store.expand(dir)
  const id = projectIdIn(to)
  const ref = id && store.state().projects.find((r) => r.id === id)
  if (!ref || ref.path === to || projectIdIn(ref.path) === id) return false
  const sources = claudeSources(ref.path, to)
  store.setProjectPath(id, to)
  follow(ref.path, null, to, sources)
  return true
}
