// Git for projects: worktrees per conversation, merging them back, and diffs of commits and changes.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as store from './store.js'
import type { Project } from './store.js'

export class GitError extends Error {}

export function git(cwd: string, ...args: string[]) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).toString().trim()
  } catch (e) {
    throw new GitError(String((e as { stderr?: Buffer }).stderr ?? e).trim() || 'git failed')
  }
}

export function branches(cwd: string) {
  try {
    return { branch: git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), branches: git(cwd, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean) }
  } catch {
    return { branch: null, branches: [] }
  }
}

// ---- worktrees ----

export interface Worktree { branch: string; path: string; ahead: number; dirty: boolean }

// Savor keeps a project's worktrees outside the project folder, so the main checkout, its git
// status and its build tools never see them.
export const worktreesDir = (p: Project) => path.join(store.HOME, 'worktrees', p.id)

export function listWorktrees(p: Project): Worktree[] {
  let out: string
  try {
    out = git(p.path, 'worktree', 'list', '--porcelain')
  } catch {
    return []
  }
  const root = worktreesDir(p) + path.sep
  const list: Worktree[] = []
  for (const block of out.split('\n\n')) {
    // Git prints forward slashes on Windows too.
    const dir = path.normalize(block.match(/^worktree (.+)$/m)?.[1] ?? '')
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]
    if (!dir || !branch || !dir.startsWith(root)) continue
    let ahead = 0
    let dirty = false
    try {
      ahead = Number(git(p.path, 'rev-list', '--count', `HEAD..${branch}`))
      dirty = git(dir, 'status', '--porcelain') !== ''
    } catch {}
    list.push({ branch, path: dir, ahead, dirty })
  }
  return list
}

// A worktree for `branch`, created on demand. The branch is created from the project's HEAD when it
// does not exist yet. Conversations can share a worktree.
export function addWorktree(p: Project, branch: string): { branch: string; path: string } {
  git(p.path, 'check-ref-format', '--branch', branch)
  const existing = listWorktrees(p).find((w) => w.branch === branch)
  if (existing) return { branch, path: existing.path }
  const dir = path.join(worktreesDir(p), branch.replace(/[^\w.-]+/g, '-'))
  if (fs.existsSync(dir)) throw new GitError(`${dir} already exists.`)
  fs.mkdirSync(worktreesDir(p), { recursive: true })
  git(p.path, 'worktree', 'add', ...(branchExists(p, branch) ? [dir, branch] : ['-b', branch, dir]))
  return { branch, path: dir }
}

export function mergeWorktree(p: Project, branch: string) {
  try {
    git(p.path, 'merge', '--no-edit', branch)
  } catch (e) {
    try {
      git(p.path, 'merge', '--abort')
    } catch {}
    throw e
  }
}

export const branchExists = (p: Project, branch: string) => git(p.path, 'branch', '--list', branch) !== ''

// Whether `branch` has commits beyond `base` that are in the project's HEAD.
export function isMerged(p: Project, branch: string, base: string) {
  try {
    git(p.path, 'merge-base', '--is-ancestor', branch, 'HEAD')
    return git(p.path, 'rev-parse', branch) !== base
  } catch {
    return false
  }
}

export function removeWorktree(p: Project, dir: string) {
  git(p.path, 'worktree', 'remove', '--force', dir)
}

export function deleteBranch(p: Project, branch: string) {
  git(p.path, 'branch', '-D', branch)
}

// ---- commits and changes ----

export interface CommitFile { path: string; additions: number | null; deletions: number | null; patch: string }
export interface Commit { hash: string; subject: string; body: string; author: string; date: string; files: CommitFile[] }

const MAX_PATCH = 200_000

// The files of a patch as `git diff` or `git show -p` print it, each with its hunks.
function patchFiles(out: string): CommitFile[] {
  const files: CommitFile[] = []
  for (const chunk of out.split(/^(?=diff --git )/m)) {
    const file = chunk.match(/^diff --git a\/.* b\/(.+)$/m)?.[1]
    if (!file) continue
    const at = chunk.search(/^@@/m)
    const body = at >= 0 ? chunk.slice(at) : ''
    const lines = body.split('\n')
    const count = (sign: string) => (/^Binary files /m.test(chunk) ? null : lines.filter((l) => l[0] === sign).length)
    files.push({ path: file, additions: count('+'), deletions: count('-'), patch: body.length > MAX_PATCH ? body.slice(0, MAX_PATCH) + '\n… (truncated)' : body })
  }
  return files
}

export function showCommit(cwd: string, hash: string): Commit {
  if (!/^[0-9a-f]{7,64}$/.test(hash)) throw new GitError('Not a commit hash.')
  const [full, author, date, subject, body] = git(cwd, 'show', '-s', '--format=%H%x00%an%x00%aI%x00%s%x00%b', hash).split('\0')
  return { hash: full, subject, body: (body ?? '').trim(), author, date, files: patchFiles(git(cwd, 'show', '--format=', '--no-color', '-p', hash)) }
}

// Everything in `cwd` that differs from `base`, committed or not, new files included.
export function changes(cwd: string, base = 'HEAD'): CommitFile[] {
  // `git diff --no-index` exits with 1 when the files differ, which a new file always does.
  const added = git(cwd, 'ls-files', '--others', '--exclude-standard', '-z')
    .split('\0')
    .filter(Boolean)
    .map((file) => spawnSync('git', ['diff', '--no-index', '--no-color', '--', '/dev/null', file], { cwd, maxBuffer: 32 * 1024 * 1024 }).stdout.toString().trim())
  return patchFiles([git(cwd, 'diff', '--no-color', base), ...added].join('\n'))
}

// Where a worktree's branch left the project's current branch.
export const baseOf = (p: Project, cwd: string) => git(cwd, 'merge-base', 'HEAD', git(p.path, 'rev-parse', 'HEAD'))
