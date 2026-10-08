import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import type { Project } from './store.js'

// The workspaces of the project types: the export page of academic writing and the Kontor's Today.
// Both read and write the project's own files, so agents and the page see the same state.

const read = (p: Project, rel: string) => {
  const file = path.join(p.path, rel)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}
const files = (p: Project, dir: string) => {
  const abs = path.join(p.path, dir)
  if (!fs.existsSync(abs)) return []
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name), mtime: fs.statSync(path.join(abs, e.name)).mtimeMs }))
}

// ---- export ----

// pandoc.yaml is the agent's and the page's shared export setup. The page reads and writes only the
// top-level scalar keys it shows, line by line, so everything else in the file stays as it is.
const yamlGet = (text: string, key: string) => text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1].trim().replace(/^(["'])(.*)\1$/, '$2') || null
function yamlSet(text: string, key: string, value: string | null) {
  const line = new RegExp(`^${key}:.*\\n?`, 'm')
  if (value === null) return text.replace(line, '')
  if (line.test(text)) return text.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${value}`)
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${key}: ${value}\n`
}

export const FORMATS: Record<string, { to: string; engine: string | null }> = {
  docx: { to: 'docx', engine: null },
  latex: { to: 'latex', engine: 'xelatex' },
  typst: { to: 'typst', engine: 'typst' },
}
// Styles from the official CSL repository (github.com/citation-style-language/styles).
export const STYLES: Record<string, string> = {
  apa: 'APA 7',
  'iso690-author-date-de': 'DIN ISO 690',
  'harvard-cite-them-right': 'Harvard',
  ieee: 'IEEE',
  'chicago-author-date': 'Chicago',
}

const ext = (to: string) => (to === 'latex' || to === 'typst' ? 'pdf' : to.replace(/^markdown.*/, 'md'))
const installed = (bin: string) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0
const pandocBin = () => process.env.SAVOR_PANDOC_BIN ?? 'pandoc'

const chapters = (p: Project) => files(p, 'manuscript').filter((f) => f.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name))

// Pandoc citation keys: [@key], [@key, p. 12], [-@key] and @key in running text, but not e-mail
// addresses and not pandoc-crossref labels such as @fig:map.
const CITE = /(?<![\p{L}\p{N}_@])-?@([\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&+?<>~/-]*[\p{L}\p{N}_])?)/gu
const CROSSREF = /^(fig|tbl|sec|eq|lst):/

function bibKeys(p: Project, bib: string) {
  const text = read(p, bib)
  if (bib.endsWith('.json')) {
    try {
      return new Set<string>((JSON.parse(text) as { id: string }[]).map((e) => String(e.id)))
    } catch {
      return new Set<string>()
    }
  }
  return new Set([...text.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1]))
}

const prose = (text: string) =>
  text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/\[[^\]]*@[^\]]*\]/g, '')
    .replace(/^#+ .*$/gm, '')
export const words = (text: string) => prose(text).match(/\p{L}[\p{L}\p{N}'’-]*/gu)?.length ?? 0

export interface Check { level: 'ok' | 'error' | 'warn' | 'info'; text: string; file?: string; line?: number }

export function exportState(p: Project) {
  const yaml = read(p, 'pandoc.yaml')
  const to = yamlGet(yaml, 'to') ?? 'docx'
  const engine = yamlGet(yaml, 'pdf-engine') ?? FORMATS[to]?.engine ?? null
  const csl = yamlGet(yaml, 'csl')
  const bibliography = yamlGet(yaml, 'bibliography') ?? 'references.bib'
  const chaps = chapters(p)
  const keys = bibKeys(p, bibliography)

  const checks: Check[] = []
  const cited = new Set<string>()
  const missing = new Map<string, { file: string; line: number }>()
  let total = 0
  for (const c of chaps) {
    const text = read(p, c.path)
    text.split('\n').forEach((l, i) => {
      for (const [, key] of l.matchAll(CITE)) {
        if (CROSSREF.test(key)) continue
        cited.add(key)
        if (!keys.has(key) && !missing.has(key)) missing.set(key, { file: c.path, line: i + 1 })
      }
    })
    const n = words(text)
    total += n
    if (!n) checks.push({ level: 'warn', text: `${c.name} is empty`, file: c.path })
  }
  if (!chaps.length) checks.push({ level: 'error', text: 'No chapters in manuscript/' })
  if (cited.size) checks.unshift({ level: missing.size ? 'info' : 'ok', text: `${cited.size - missing.size} of ${cited.size} cited sources are in ${bibliography}` })
  for (const [key, at] of missing) checks.push({ level: 'error', text: `[@${key}] has no entry in ${bibliography}`, ...at })
  const target = Number(read(p, 'PROJECT.md').match(/target length:\D*([\d.,]+)\s*words/i)?.[1].replace(/[.,]/g, '') ?? 0)
  const n = (x: number) => x.toLocaleString('en')
  checks.push({ level: 'info', text: target ? `${n(total)} of ${n(target)} words (${Math.round((total / target) * 100)} %)` : `${n(total)} words` })

  const tools = [pandocBin(), ...(ext(to) === 'pdf' && engine ? [engine] : [])].filter((t) => !installed(t))
  return {
    format: to,
    style: csl ? path.basename(csl, '.csl') : null,
    template: yamlGet(yaml, 'reference-doc') ?? yamlGet(yaml, 'template'),
    chapters: chaps.map((c) => c.path),
    checks,
    missingTools: tools.map((t) => (t === pandocBin() ? 'pandoc' : t)),
    exports: files(p, 'export')
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10)
      .map((f) => ({ path: f.path, at: new Date(f.mtime).toISOString() })),
  }
}

// Switching the format or the citation style writes pandoc.yaml. A style comes from the CSL repository
// into styles/ the first time it is used.
export async function setExport(p: Project, b: { format?: string; style?: string }) {
  let yaml = read(p, 'pandoc.yaml')
  if (b.format) {
    const f = FORMATS[b.format]
    if (!f) throw new Error(`Unknown format ${b.format}`)
    yaml = yamlSet(yamlSet(yaml, 'to', f.to), 'pdf-engine', f.engine)
  }
  if (b.style) {
    if (!STYLES[b.style]) throw new Error(`Unknown style ${b.style}`)
    const rel = `styles/${b.style}.csl`
    if (!fs.existsSync(path.join(p.path, rel))) {
      const res = await fetch(`https://raw.githubusercontent.com/citation-style-language/styles/master/${b.style}.csl`)
      if (!res.ok) throw new Error(`Could not fetch the ${STYLES[b.style]} style (${res.status}).`)
      fs.mkdirSync(path.join(p.path, 'styles'), { recursive: true })
      fs.writeFileSync(path.join(p.path, rel), await res.text())
    }
    yaml = yamlSet(yaml, 'csl', rel)
  }
  fs.writeFileSync(path.join(p.path, 'pandoc.yaml'), yaml)
}

// Runs pandoc with pandoc.yaml on the chapters, into export/ with today's date in the name.
export function runExport(p: Project): Promise<{ path: string; words: number; warnings: string }> {
  const yaml = read(p, 'pandoc.yaml')
  const to = yamlGet(yaml, 'to') ?? 'docx'
  const out = `export/${path.basename(p.path)}-${new Date().toISOString().slice(0, 10)}.${ext(to)}`
  const args = [
    ...(yaml ? ['--defaults', 'pandoc.yaml'] : ['--to', to]),
    ...(/^input-files:/m.test(yaml) ? [] : chapters(p).map((c) => c.path)),
    ...(/^citeproc:/m.test(yaml) || !fs.existsSync(path.join(p.path, yamlGet(yaml, 'bibliography') ?? 'references.bib')) ? [] : ['--citeproc']),
    ...(yamlGet(yaml, 'bibliography') || !fs.existsSync(path.join(p.path, 'references.bib')) ? [] : ['--bibliography', 'references.bib']),
    '-o',
    out,
  ]
  fs.mkdirSync(path.join(p.path, 'export'), { recursive: true })
  return new Promise((resolve, reject) =>
    execFile(pandocBin(), args, { cwd: p.path, timeout: 180_000 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message))
      resolve({ path: out, words: chapters(p).reduce((n, c) => n + words(read(p, c.path)), 0), warnings: stderr.trim() })
    }),
  )
}

export function exportFile(p: Project, name: string) {
  const file = path.join(p.path, 'export', path.basename(name))
  if (!fs.existsSync(file)) throw new Error('No such export.')
  return file
}

// ---- today ----

// tasks.md is the Kontor's one list: `- [ ] YYYY-MM-DD what` with an optional date.
const TASK = /^\s*[-*] \[( |x|X)\] (?:(\d{4}-\d{2}-\d{2})\s+)?(.*)$/

export function today(p: Project, now = new Date()) {
  const soon = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
  const tasks = read(p, 'tasks.md')
    .split('\n')
    .flatMap((l, i) => {
      const m = l.match(TASK)
      return m && m[1] === ' ' ? [{ line: i + 1, raw: l, due: m[2] ?? null, text: m[3] }] : []
    })
  const day = 86_400_000
  return {
    due: tasks.filter((t) => t.due && t.due <= soon).sort((a, b) => a.due!.localeCompare(b.due!)),
    open: tasks.filter((t) => !t.due || t.due > soon),
    inbox: files(p, 'inbox')
      .sort((a, b) => b.mtime - a.mtime)
      .map((f) => ({ path: f.path, isNew: now.getTime() - f.mtime < day })),
  }
}

// Ticking a task rewrites only its line, and only if the line is still what the page showed.
export function setTask(p: Project, line: number, raw: string, done: boolean) {
  const file = path.join(p.path, 'tasks.md')
  const lines = read(p, 'tasks.md').split('\n')
  if (lines[line - 1] !== raw) throw new Error('tasks.md changed in the meantime. Reload.')
  lines[line - 1] = raw.replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]')
  fs.writeFileSync(file, lines.join('\n'))
  return { raw: lines[line - 1] }
}

export function addTask(p: Project, text: string) {
  const current = read(p, 'tasks.md')
  fs.writeFileSync(path.join(p.path, 'tasks.md'), `${current}${current && !current.endsWith('\n') ? '\n' : ''}- [ ] ${text.trim()}\n`)
}
