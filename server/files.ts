import fs from 'node:fs'
import path from 'node:path'
import type { Project } from './store.js'

const HIDDEN = new Set(['.git', 'node_modules', '.savor', '.next', '.venv', '__pycache__', '.cache'])
const MAX_READ = 512 * 1024

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
  const size = fs.statSync(file).size
  const buf = fs.readFileSync(file).subarray(0, MAX_READ)
  const binary = buf.subarray(0, 8000).includes(0)
  return { path: rel, size, binary, truncated: size > MAX_READ, content: binary ? '' : buf.toString('utf8') }
}

export const write = (p: Project, rel: string, content: string) => fs.writeFileSync(resolve(p, rel), content)

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
