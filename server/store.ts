import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const HOME = process.env.SAVOR_HOME ?? path.join(os.homedir(), '.savor')

export type Provider = 'claude' | 'codex' | 'opencode'
export interface AgentConfig { provider: Provider; model: string; permissionMode: string }
export interface Project { id: string; name: string; path: string; agent: AgentConfig }
export interface Question { title: string; body: string; options: string[] }
export interface Message {
  id: string
  ts: string
  kind: 'user' | 'ack' | 'update' | 'conclusion' | 'trace' | 'error' | 'approval'
  text?: string
  questions?: Question[]
  suggestions?: string[]
  commits?: string[]
  approval?: { tool: string; input: unknown; status: 'pending' | 'allowed' | 'denied' }
}
export interface Thread {
  id: string
  label: string | null
  createdAt: string
  sessionId: string | null
  preview: string | null
  unread: boolean
  parentId?: string
}
export interface Doc { id: string; title: string; content: string; updatedAt: string }
export interface Workflow {
  id: string
  name: string
  prompt: string
  cron: string | null
  timezone: string
  enabled: boolean
  lastRunAt: string | null
}
export interface Proc {
  pid: number
  name: string
  cwd: string
  command: string
  url: string | null
  log: string | null
  threadId: string
  startedAt: string
}

interface State { token: string; mcpToken: string; projects: { id: string; path: string }[] }

export const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16)
const now = () => new Date().toISOString()

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

// ---- global state ----

const stateFile = path.join(HOME, 'state.json')

export function state(): State {
  const s = readJson<State | null>(stateFile, null)
  if (s) return s
  const fresh = { token: crypto.randomBytes(24).toString('hex'), mcpToken: crypto.randomBytes(24).toString('hex'), projects: [] }
  writeJson(stateFile, fresh)
  return fresh
}

// ---- projects ----

const dataDir = (p: { path: string }) => path.join(p.path, '.savor')

export function listProjects(): Project[] {
  return state().projects.flatMap((ref) => {
    const p = readJson<Project | null>(path.join(ref.path, '.savor', 'project.json'), null)
    return p ? [{ ...p, path: ref.path }] : []
  })
}

export function getProject(id: string): Project {
  const p = listProjects().find((p) => p.id === id)
  if (!p) throw new NotFound(`project ${id}`)
  return p
}

export function addProject(dir: string, name?: string): Project {
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()))
  fs.mkdirSync(abs, { recursive: true })
  const existing = readJson<Project | null>(path.join(abs, '.savor', 'project.json'), null)
  const project: Project = existing ?? {
    id: newId(),
    name: name || path.basename(abs),
    path: abs,
    agent: { provider: 'claude', model: '', permissionMode: 'acceptEdits' },
  }
  writeJson(path.join(abs, '.savor', 'project.json'), project)
  const s = state()
  if (!s.projects.some((r) => r.id === project.id)) {
    s.projects.push({ id: project.id, path: abs })
    writeJson(stateFile, s)
  }
  return { ...project, path: abs }
}

export function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'agent'>>): Project {
  const p = { ...getProject(id), ...patch }
  writeJson(path.join(dataDir(p), 'project.json'), p)
  return p
}

export function removeProject(id: string) {
  const s = state()
  s.projects = s.projects.filter((r) => r.id !== id)
  writeJson(stateFile, s)
}

// ---- threads & messages ----

const threadDir = (p: Project, tid: string) => path.join(dataDir(p), 'threads', path.basename(tid))

export function listThreads(p: Project): Thread[] {
  const dir = path.join(dataDir(p), 'threads')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((tid) => readJson<Thread | null>(path.join(dir, tid, 'thread.json'), null))
    .filter((t): t is Thread => !!t)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getThread(p: Project, tid: string): Thread {
  const t = readJson<Thread | null>(path.join(threadDir(p, tid), 'thread.json'), null)
  if (!t) throw new NotFound(`thread ${tid}`)
  return t
}

export function createThread(p: Project, init: { label?: string | null; parentId?: string } = {}): Thread {
  const t: Thread = { id: newId(), label: init.label ?? null, createdAt: now(), sessionId: null, preview: null, unread: false }
  if (init.parentId) t.parentId = init.parentId
  writeJson(path.join(threadDir(p, t.id), 'thread.json'), t)
  return t
}

export function updateThread(p: Project, tid: string, patch: Partial<Thread>): Thread {
  const t = { ...getThread(p, tid), ...patch }
  writeJson(path.join(threadDir(p, tid), 'thread.json'), t)
  return t
}

export function readMessages(p: Project, tid: string): Message[] {
  const file = path.join(threadDir(p, tid), 'messages.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

export function appendMessage(p: Project, tid: string, m: Omit<Message, 'id' | 'ts'>): Message {
  const msg = { id: newId(), ts: now(), ...m }
  fs.appendFileSync(path.join(threadDir(p, tid), 'messages.jsonl'), JSON.stringify(msg) + '\n')
  return msg
}

export function updateMessage(p: Project, tid: string, id: string, patch: Partial<Message>): Message {
  const msgs = readMessages(p, tid).map((m) => (m.id === id ? { ...m, ...patch } : m))
  fs.writeFileSync(path.join(threadDir(p, tid), 'messages.jsonl'), msgs.map((m) => JSON.stringify(m) + '\n').join(''))
  return msgs.find((m) => m.id === id)!
}

// ---- documents (plain markdown files, first line is the title) ----

const docsDir = (p: Project) => path.join(dataDir(p), 'documents')

function readDoc(file: string): Doc {
  const raw = fs.readFileSync(file, 'utf8')
  const [first, ...rest] = raw.split('\n')
  return {
    id: path.basename(file, '.md'),
    title: first.replace(/^#\s*/, ''),
    content: rest.join('\n').replace(/^\n/, ''),
    updatedAt: fs.statSync(file).mtime.toISOString(),
  }
}

export function listDocs(p: Project): Doc[] {
  if (!fs.existsSync(docsDir(p))) return []
  return fs
    .readdirSync(docsDir(p))
    .filter((f) => f.endsWith('.md'))
    .map((f) => readDoc(path.join(docsDir(p), f)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function getDoc(p: Project, id: string): Doc {
  const file = path.join(docsDir(p), `${path.basename(id)}.md`)
  if (!fs.existsSync(file)) throw new NotFound(`document ${id}`)
  return readDoc(file)
}

export function saveDoc(p: Project, doc: { id?: string; title: string; content: string }): Doc {
  const id = doc.id ? path.basename(doc.id) : newId()
  fs.mkdirSync(docsDir(p), { recursive: true })
  const file = path.join(docsDir(p), `${id}.md`)
  fs.writeFileSync(file, `# ${doc.title}\n\n${doc.content}`)
  return readDoc(file)
}

export function deleteDoc(p: Project, id: string) {
  fs.rmSync(path.join(docsDir(p), `${path.basename(id)}.md`), { force: true })
}

// ---- workflows ----

const wfDir = (p: Project) => path.join(dataDir(p), 'workflows')

export function listWorkflows(p: Project): Workflow[] {
  if (!fs.existsSync(wfDir(p))) return []
  return fs
    .readdirSync(wfDir(p))
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<Workflow>(path.join(wfDir(p), f), null as never))
}

export function getWorkflow(p: Project, id: string): Workflow {
  const wf = readJson<Workflow | null>(path.join(wfDir(p), `${path.basename(id)}.json`), null)
  if (!wf) throw new NotFound(`workflow ${id}`)
  return wf
}

export function saveWorkflow(p: Project, wf: Partial<Workflow> & { name: string; prompt: string }): Workflow {
  const prev = wf.id ? getWorkflow(p, wf.id) : null
  const next: Workflow = {
    id: newId(),
    cron: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    enabled: true,
    lastRunAt: null,
    ...prev,
    ...wf,
  }
  writeJson(path.join(wfDir(p), `${next.id}.json`), next)
  return next
}

export function deleteWorkflow(p: Project, id: string) {
  fs.rmSync(path.join(wfDir(p), `${path.basename(id)}.json`), { force: true })
}

// ---- background processes ----

const procFile = (p: Project) => path.join(dataDir(p), 'processes.json')

export const listProcs = (p: Project): Proc[] => readJson(procFile(p), [])
export const saveProcs = (p: Project, procs: Proc[]) => writeJson(procFile(p), procs)

export class NotFound extends Error {}
