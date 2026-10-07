import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const HOME = process.env.SAVOR_HOME ?? path.join(os.homedir(), '.savor')

export type Provider = 'claude' | 'codex' | 'opencode' | 'grok' | 'antigravity'
export interface AgentConfig { provider: Provider; model: string; reasoning: string; fast: boolean; permissionMode: string }
export interface Project {
  id: string
  name: string
  path: string
  tint: string
  agent: AgentConfig
  verbosity: 'low' | 'medium' | 'high'
  paused: boolean
  // Pinned projects are tabs; the others are reached through the Projects menu.
  pinned: boolean
  // A shell command that runs in each new worktree before its first turn, e.g. `npm install`.
  worktreeSetup: string
}
export interface Question { title: string; body: string; options: string[]; recommended?: number }
export type Origin = 'local' | 'remote'
export interface ApprovalOption { id: string; label: string; kind: 'allow' | 'deny' }
export interface Approval { title: string; detail: string; options: ApprovalOption[]; status: 'pending' | 'resolved'; choice?: string }
export interface Message {
  id: string
  ts: string
  // 'question' carries an agent's own clarifying questions (decisions) outside a conclusion.
  kind: 'user' | 'ack' | 'update' | 'conclusion' | 'error' | 'approval' | 'question'
  text?: string
  images?: string[]
  files?: string[]
  questions?: Question[]
  decisionIds?: string[]
  suggestions?: string[]
  commits?: string[]
  approval?: Approval
  modelInfo?: AgentConfig
  workTiming?: { startedAt: string; finishedAt: string }
  origin?: Origin
  device?: string
  // A message another conversation's agent sent with send_to_conversation; the label is kept as it was then.
  from?: { projectId: string; project: string; threadId: string; label: string }
  // Input that an agent message set off, directly or through conversations started from it: its turn sends no agent messages.
  chained?: boolean
  // User messages typed while the agent works wait here until the turn ends (or "Send now").
  delivered?: boolean
  // The idempotency key of an update, so that a retry is still recognized after a restart.
  key?: string
}
export interface Thread {
  id: string
  title: string
  label: { name: string; hue: number } | null
  // What the user's latest input asks for, in one sentence by the agent. The list shows it instead of the title.
  summary?: string | null
  createdAt: string
  updatedAt: string
  // When the latest input arrived. The list is ordered by it, so opening or finishing a conversation doesn't move it.
  inputAt?: string
  agent: AgentConfig
  agentSessions: { provider: Provider; sessionId: string }[]
  preview: string | null
  unread: boolean
  completed: boolean
  needsYou: boolean
  error: string | null
  // When the agent got the input it still owes work on. It is on disk so that a turn cut off by a
  // restart is found again.
  workingSince?: string | null
  // How much the agent's last request put into its model's context window, and how large that window
  // is, as far as the agent says.
  context?: { tokens: number; window: number | null } | null
  parentId?: string
  // Set for a fork of the conversation `parentId`: how many messages that one had, and the agent
  // session to branch off, when its agent had one and can copy it. Without one the agent gets the
  // visible history.
  fork?: { provider: Provider; sessionId: string | null; messages: number }
  // Set when the conversation works in its own git worktree instead of the project folder.
  worktree?: { branch: string; path: string } | null
  // Set for one of several conversations that got the same prompt to compare their results: the
  // fan-out they belong to and the commit their worktrees started from.
  fanout?: { id: string; base: string }
  // Set by the import from Enjoy: what the conversation looked like there when it was last brought over.
  imported?: { messages: number; completed: boolean; open: number }
  // Set for a run of a workflow: which one started the conversation and what set it off. A run that was
  // caught up carries the scheduled time it was due.
  workflow?: { id: string; name: string; trigger: 'scheduled' | 'manual' | 'caught'; due?: string }
}
export interface ActivityEvent { id: number; type: 'thinking' | 'command' | 'edit' | 'note'; label: string; time: string; finishedAt?: string }
export interface Decision {
  id: string
  groupId: string
  threadId: string
  title: string
  body: string
  options: string[]
  // Index of the option the agent recommends.
  recommended?: number
  selected: number | null
  answer: string | null
  resolved: boolean
  createdAt: string
}
export interface Doc { id: string; title: string; content: string; updatedAt: string }
export interface Workflow {
  id: string
  name: string
  prompt: string
  collection: string
  cron: string | null
  timezone: string
  scheduleLabel: string | null
  enabled: boolean
  // Whether a scheduled time that passed while Savor was not running is run once at the next start.
  catchUp: boolean
  next: string[]
  lastRunAt: string | null
  updatedAt: string
  // Every scheduled time up to here is dealt with: it ran, was skipped or does not count.
  settledAt: string
  // Scheduled times that did not run because the run in conversation `blockedBy` was still open.
  skipped: { at: string; blockedBy: string }[]
  origin: Origin
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
// Devices paired over the LAN get a cookie token (tokenHash), devices paired through the relay a public key.
export interface Device { id: string; name: string; tokenHash: string; publicKey?: string; push?: PushSubscription; createdAt: string; lastSeenAt: string | null }
// Where the device's browser receives Web Push (see push.ts).
export interface PushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
export interface Preset { id: string; name: string; agent: AgentConfig }

interface State {
  token: string
  mcpToken: string
  projects: { id: string; path: string }[]
  devices: Device[]
  presets: Preset[]
  providers: Record<string, { command: string[] }>
  relay: { url: string | null; enabled: boolean }
  // Where paired devices reach this computer directly (LAN or VPN), when that is not PUBLIC_URL.
  publicUrl?: string | null
  // The folder the last new project was created in.
  projectsDir?: string
  // Whether paired devices may open the terminal, a shell on this computer.
  terminalRemote?: boolean
  // The daemon's long-term X25519 key for the relay tunnel (base64url secret key).
  identity: string
  relayToken: string
  // The daemon's VAPID key for Web Push (P-256, private JWK), created on first use.
  vapid?: crypto.webcrypto.JsonWebKey
}

export const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16)
export const now = () => new Date().toISOString()
export const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

// Constant-time comparison of a secret from a request against the expected value.
export const sameHash = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
export const safeEqual = (given: unknown, expected: string) => typeof given === 'string' && sameHash(hash(given), hash(expected))

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

const readJsonl = <T>(file: string): T[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

// ---- global state ----

const stateFile = path.join(HOME, 'state.json')

export function state(): State {
  const s = readJson<Partial<State> | null>(stateFile, null)
  const full: State = {
    token: crypto.randomBytes(24).toString('hex'),
    mcpToken: crypto.randomBytes(24).toString('hex'),
    projects: [],
    devices: [],
    presets: [],
    providers: {},
    relay: { url: null, enabled: false },
    identity: Buffer.from(crypto.randomBytes(32)).toString('base64url'),
    relayToken: crypto.randomBytes(24).toString('hex'),
    ...s,
  }
  if (!s || !s.identity || !s.relayToken) saveState(full)
  return full
}

// state.json holds tokens and the daemon key: readable by the owner only.
export const saveState = (s: State) => writeJson(stateFile, s)

// ---- presets ----

export const listPresets = () => state().presets

export function savePreset(name: string, agent: AgentConfig): Preset {
  const s = state()
  const preset = { id: newId(), name: name.trim().slice(0, 60), agent }
  s.presets = [...s.presets.filter((x) => x.name !== preset.name), preset]
  saveState(s)
  return preset
}

export function deletePreset(id: string) {
  const s = state()
  s.presets = s.presets.filter((x) => x.id !== id)
  saveState(s)
}

// ---- projects ----

const TINTS = ['#b5654a', '#8b6bc7', '#3f9a78', '#c59a3d', '#c8577a', '#4a9bb8', '#7a8794']
export const dataDir = (p: { path: string }) => path.join(p.path, '.savor')
export const defaultAgent = (): AgentConfig => ({ provider: 'claude', model: '', reasoning: 'high', fast: false, permissionMode: 'acceptEdits' })

function loadProject(ref: { path: string }): Project | null {
  const p = readJson<(Partial<Project> & Pick<Project, 'id' | 'name'>) | null>(path.join(ref.path, '.savor', 'project.json'), null)
  return p && ({ tint: TINTS[0], verbosity: 'medium', paused: false, pinned: true, worktreeSetup: '', ...p, agent: { ...defaultAgent(), ...p.agent }, path: ref.path } as Project)
}

export const listProjects = (): Project[] => state().projects.flatMap((ref) => loadProject(ref) ?? [])

export function getProject(id: string): Project {
  const p = listProjects().find((p) => p.id === id)
  if (!p) throw new NotFound(`project ${id}`)
  return p
}

export const expand = (dir: string) => path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()))

// Where a new project goes: next to the last one created, else into the folder most projects are in.
export function projectsDir() {
  const s = state()
  const count = new Map<string, number>()
  for (const p of s.projects) count.set(path.dirname(p.path), (count.get(path.dirname(p.path)) ?? 0) + 1)
  const dir = s.projectsDir ?? [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? path.join(os.homedir(), 'Projects')
  const home = os.homedir() + '/'
  return dir.startsWith(home) ? '~/' + dir.slice(home.length) : dir
}

export function addProject(dir: string, name?: string): Project {
  const abs = expand(dir)
  fs.mkdirSync(abs, { recursive: true })
  const s = state()
  const project = loadProject({ path: abs }) ?? {
    id: newId(),
    name: name || path.basename(abs),
    path: abs,
    tint: TINTS[s.projects.length % TINTS.length],
    agent: defaultAgent(),
    verbosity: 'medium' as const,
    paused: false,
    pinned: true,
    worktreeSetup: '',
  }
  writeJson(path.join(abs, '.savor', 'project.json'), project)
  if (!s.projects.some((r) => r.id === project.id)) {
    s.projects.push({ id: project.id, path: abs })
    saveState(s)
  }
  return project
}

export function updateProject(id: string, patch: Partial<Omit<Project, 'id' | 'path'>>): Project {
  const p = { ...getProject(id), ...patch }
  writeJson(path.join(dataDir(p), 'project.json'), p)
  return p
}

// The order of the tabs and the projects menu: ids not in the list keep their place at the end.
export function reorderProjects(ids: string[]) {
  const s = state()
  const rank = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length)
  s.projects = [...s.projects].sort((a, b) => rank(a.id) - rank(b.id))
  saveState(s)
}

export function removeProject(id: string) {
  const s = state()
  s.projects = s.projects.filter((r) => r.id !== id)
  saveState(s)
}

export const readRole = (p: Project) => {
  const file = path.join(dataDir(p), 'ROLE.md')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}
export const saveRole = (p: Project, text: string) => fs.writeFileSync(path.join(dataDir(p), 'ROLE.md'), text)

// ---- threads, messages, activity ----

const threadDir = (p: Project, tid: string) => path.join(dataDir(p), 'threads', path.basename(tid))

export function listThreads(p: Project): Thread[] {
  const dir = path.join(dataDir(p), 'threads')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((tid) => readJson<Thread | null>(path.join(dir, tid, 'thread.json'), null))
    .filter((t): t is Thread => !!t)
    .sort((a, b) => (b.inputAt ?? b.createdAt).localeCompare(a.inputAt ?? a.createdAt))
}

export function getThread(p: Project, tid: string): Thread {
  const t = readJson<Thread | null>(path.join(threadDir(p, tid), 'thread.json'), null)
  if (!t) throw new NotFound(`thread ${tid}`)
  return t
}

export const cwdOf = (p: Project, t: Thread) => t.worktree?.path ?? p.path

export function createThread(p: Project, init: { title: string; label?: string | null; agent?: AgentConfig; parentId?: string; fork?: Thread['fork']; worktree?: { branch: string; path: string } | null; workflow?: Thread['workflow']; fanout?: Thread['fanout'] }): Thread {
  const t: Thread = {
    id: newId(),
    title: init.title.slice(0, 300),
    label: init.label ? { name: init.label, hue: hueFor(init.label) } : null,
    createdAt: now(),
    updatedAt: now(),
    agent: init.agent ?? p.agent,
    agentSessions: [],
    preview: null,
    unread: false,
    completed: false,
    needsYou: false,
    error: null,
  }
  if (init.parentId) t.parentId = init.parentId
  if (init.fork) t.fork = init.fork
  if (init.worktree) t.worktree = init.worktree
  if (init.workflow) t.workflow = init.workflow
  if (init.fanout) t.fanout = init.fanout
  saveThread(p, t)
  return t
}

export const saveThread = (p: Project, t: Thread) => writeJson(path.join(threadDir(p, t.id), 'thread.json'), t)

export const hueFor = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)

export function updateThread(p: Project, tid: string, patch: Partial<Thread>): Thread {
  const t = { ...getThread(p, tid), ...patch, updatedAt: now() }
  saveThread(p, t)
  return t
}

// Line comments on a conversation's changes, kept until they are sent to the agent. The web app owns their shape.
export const readReview = (p: Project, tid: string): unknown[] => readJson(path.join(threadDir(p, tid), 'review.json'), [])
export const saveReview = (p: Project, tid: string, comments: unknown[]) => writeJson(path.join(threadDir(p, tid), 'review.json'), comments)

export const readMessages = (p: Project, tid: string) => readJsonl<Message>(path.join(threadDir(p, tid), 'messages.jsonl'))

export function appendMessage(p: Project, tid: string, m: Omit<Message, 'id' | 'ts'>): Message {
  const msg = { id: newId(), ts: now(), ...m }
  fs.appendFileSync(path.join(threadDir(p, tid), 'messages.jsonl'), JSON.stringify(msg) + '\n', { mode: 0o600 })
  return msg
}

export const writeMessages = (p: Project, tid: string, msgs: Message[]) =>
  fs.writeFileSync(path.join(threadDir(p, tid), 'messages.jsonl'), msgs.map((m) => JSON.stringify(m) + '\n').join(''), { mode: 0o600 })

export function updateMessage(p: Project, tid: string, id: string, patch: Partial<Message>): Message {
  const msgs = readMessages(p, tid).map((m) => (m.id === id ? { ...m, ...patch } : m))
  writeMessages(p, tid, msgs)
  return msgs.find((m) => m.id === id)!
}

export const removeMessage = (p: Project, tid: string, id: string) =>
  writeMessages(
    p,
    tid,
    readMessages(p, tid).filter((m) => m.id !== id),
  )

// Activity is append-only: a start line per event, then a {id, finishedAt} line when it ends.
export function readActivity(p: Project, tid: string): ActivityEvent[] {
  const events = new Map<number, ActivityEvent>()
  for (const e of readJsonl<Partial<ActivityEvent> & { id: number }>(path.join(threadDir(p, tid), 'activity.jsonl')))
    events.set(e.id, { ...events.get(e.id), ...e } as ActivityEvent)
  return [...events.values()]
}

export const appendActivity = (p: Project, tid: string, e: Partial<ActivityEvent> & { id: number }) =>
  fs.appendFileSync(path.join(threadDir(p, tid), 'activity.jsonl'), JSON.stringify(e) + '\n', { mode: 0o600 })

export const attachmentDir = (p: Project, tid: string) => path.join(threadDir(p, tid), 'attachments')

export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
export const isImage = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name)

// Stores an attachment as <id>-<original name> and says whether it is an image the agent can look at.
export function saveAttachment(p: Project, tid: string, file: { name: string; dataUrl: string }): { name: string; image: boolean } {
  const m = String(file.dataUrl).match(/^data:([\w.+-]+\/[\w.+-]+)?(?:;[^,]*)?;base64,(.+)$/)
  if (!m) throw new Error('Attachments must be sent as base64 data URLs.')
  const data = Buffer.from(m[2], 'base64')
  if (data.length > 20 * 1024 * 1024) throw new Error('Attachments are limited to 20 MB.')
  const ext = IMAGE_TYPES[m[1] ?? '']
  const base = path.basename(String(file.name || 'file')).replace(/[^\w.+-]+/g, '_').slice(0, 80) || 'file'
  const name = `${newId()}-${ext && !isImage(base) ? `${base}.${ext}` : base}`
  fs.mkdirSync(attachmentDir(p, tid), { recursive: true })
  fs.writeFileSync(path.join(attachmentDir(p, tid), name), data, { mode: 0o600 })
  return { name, image: !!ext || isImage(base) }
}

// ---- decisions ----

const decisionsDir = (p: Project) => path.join(dataDir(p), 'decisions')

export function listDecisions(p: Project, threadId?: string): Decision[] {
  if (!fs.existsSync(decisionsDir(p))) return []
  return fs
    .readdirSync(decisionsDir(p))
    .map((f) => readJson<Decision>(path.join(decisionsDir(p), f), null as never))
    .filter((d) => d && (!threadId || d.threadId === threadId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

export const saveDecision = (p: Project, d: Decision) => writeJson(path.join(decisionsDir(p), `${path.basename(d.id)}.json`), d)

// ---- documents (plain markdown files, first line is the title) ----

const docsDir = (p: Project) => path.join(dataDir(p), 'documents')

function readDoc(file: string): Doc {
  const [first, ...rest] = fs.readFileSync(file, 'utf8').split('\n')
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
// What workflows saved by earlier versions don't have yet.
const wfDefaults = { next: [], collection: '', scheduleLabel: null, updatedAt: '', catchUp: true, settledAt: '', skipped: [] }

export function listWorkflows(p: Project): Workflow[] {
  if (!fs.existsSync(wfDir(p))) return []
  return fs
    .readdirSync(wfDir(p))
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ ...wfDefaults, ...readJson<Partial<Workflow>>(path.join(wfDir(p), f), null as never) }) as Workflow)
}

export function getWorkflow(p: Project, id: string): Workflow {
  const wf = readJson<Partial<Workflow> | null>(path.join(wfDir(p), `${path.basename(id)}.json`), null)
  if (!wf) throw new NotFound(`workflow ${id}`)
  return { ...wfDefaults, ...wf } as Workflow
}

// `by` is where the request came from. Whoever writes the instructions (prompt or chain) decides
// whether runs count as local or remote.
export function saveWorkflow(p: Project, wf: Partial<Workflow> & { name: string; prompt: string }, by?: Origin): Workflow {
  const prev = wf.id ? getWorkflow(p, wf.id) : null
  const next: Workflow = {
    id: newId(),
    collection: '',
    cron: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    scheduleLabel: null,
    enabled: true,
    catchUp: true,
    next: [],
    lastRunAt: null,
    updatedAt: now(),
    settledAt: now(),
    skipped: [],
    origin: 'local',
    ...prev,
    ...wf,
  }
  if (by && (!prev || next.prompt !== prev.prompt || String(next.next) !== String(prev.next))) next.origin = by
  // A label describes one schedule, so it goes when the schedule changes without it.
  if (prev && next.cron !== prev.cron && next.scheduleLabel === prev.scheduleLabel) next.scheduleLabel = null
  // A run only records its time; anything else is an edit.
  const edited = (['name', 'prompt', 'collection', 'cron', 'timezone', 'scheduleLabel', 'enabled', 'catchUp'] as const).some((k) => next[k] !== prev?.[k])
  if (prev && (edited || String(next.next) !== String(prev.next))) next.updatedAt = now()
  // A changed or re-enabled schedule counts from now: what it would have run before is not caught up.
  if (prev && (next.cron !== prev.cron || next.timezone !== prev.timezone || next.enabled !== prev.enabled)) next.settledAt = now()
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
