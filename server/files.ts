import fs from 'node:fs'
import path from 'node:path'
import type { Project } from './store.js'

const HIDDEN = new Set(['.git', 'node_modules', '.savor', '.next', '.venv', '__pycache__', '.cache'])
const MAX_READ = 512 * 1024
// The relay tunnel carries a response in one message of at most 32 MB, base64 inside base64.
const MAX_RAW = 16 * 1024 * 1024

function resolve(p: Project, rel: string) {
  const abs = path.resolve(p.path, rel || '.')
  if (abs !== p.path && !abs.startsWith(p.path + path.sep)) throw new Error('Path outside the project.')
  return abs
}

export function list(p: Project, rel: string) {
  const dir = resolve(p, rel)
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !HIDDEN.has(e.name))
    .map((e) => ({ name: e.name, path: path.relative(p.path, path.join(dir, e.name)), dir: e.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
}

export function read(p: Project, rel: string) {
  const file = resolve(p, rel)
  const stat = fs.statSync(file)
  if (stat.isDirectory()) return { path: rel, dir: true }
  const size = stat.size
  const buf = fs.readFileSync(file).subarray(0, MAX_READ)
  const binary = buf.subarray(0, 8000).includes(0)
  return { path: rel, size, binary, truncated: size > MAX_READ, content: binary ? '' : buf.toString('utf8') }
}

// A file for the previews of PDFs, Word and Excel files, or null when it's too big to send.
export function raw(p: Project, rel: string) {
  const file = resolve(p, rel)
  const stat = fs.statSync(file)
  if (stat.isDirectory()) throw new Error('A folder has no preview.')
  return stat.size > MAX_RAW ? null : file
}

export const write = (p: Project, rel: string, content: string) => fs.writeFileSync(resolve(p, rel), content)

// Where a write to `rel` lands, relative to the real project folder and following symlinks, or null for a
// dangling symlink, which would create its target wherever it points.
function landing(p: Project, rel: string) {
  const file = resolve(p, rel)
  let target: string
  try {
    target = fs.realpathSync(file)
  } catch {
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return null
    let dir = path.dirname(file)
    const rest = [path.basename(file)]
    while (!fs.existsSync(dir)) {
      rest.unshift(path.basename(dir))
      dir = path.dirname(dir)
    }
    target = path.join(fs.realpathSync(dir), ...rest)
  }
  return path.relative(fs.realpathSync(p.path), target)
}

// Whether a write to `rel` would land in Savor's own records (.savor/).
export function internal(p: Project, rel: string) {
  const real = landing(p, rel)
  return real === null || real.split(path.sep)[0].toLowerCase() === '.savor'
}

// What Savor's own git calls and the agents load and act on without asking: git's config and hooks
// (core.fsmonitor runs on every git status), the agents' project settings with their hooks, allowed
// commands, MCP servers and plugins.
const RUNS = new Set(['.git', '.claude', '.codex', '.gemini', '.grok', '.opencode', '.mcp.json', 'opencode.json', 'opencode.jsonc'])

// Whether a write to `rel` could make something run, or lands outside the project through a symlink.
export function runs(p: Project, rel: string) {
  const real = landing(p, rel)
  if (real === null || real === '..' || real.startsWith('..' + path.sep) || path.isAbsolute(real)) return true
  return real.split(path.sep).some((part) => RUNS.has(part.toLowerCase()))
}

// Name search for @-mentions; walks at most a few thousand entries.
export function search(p: Project, q: string) {
  const needle = q.toLowerCase()
  const hits: string[] = []
  const queue = ['']
  let seen = 0
  while (queue.length && hits.length < 30 && seen < 5000) {
    const rel = queue.shift()!
    for (const e of list(p, rel)) {
      seen++
      if (e.name.toLowerCase().includes(needle)) hits.push(e.dir ? e.path + '/' : e.path)
      if (e.dir) queue.push(e.path)
    }
  }
  return hits
}
