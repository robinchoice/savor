import { useCallback, useEffect, useState } from 'preact/hooks'
import { transport } from './transport'

export class Unauthorized extends Error {}

export const go = (path: string) => (location.hash = path)

// The last failed calls, sent along with a bug report.
export const recentErrors: string[] = []

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await transport.request(method, '/api' + path, body === undefined ? undefined : JSON.stringify(body))
  if (r.status >= 400) {
    recentErrors.unshift(`${method} /api${path} → ${r.status}`)
    recentErrors.length = Math.min(recentErrors.length, 5)
  }
  if (r.status === 401) throw new Unauthorized()
  let data: any = {}
  try {
    data = JSON.parse(r.body)
  } catch {}
  if (r.status >= 400) throw new Error(data.error ?? `Request failed (${r.status})`)
  return data
}

export type SavorEvent = { type: string; projectId?: string; threadId?: string; title?: string; body?: string; version?: string }
type Listener = (e: SavorEvent) => void
const listeners = new Set<Listener>()

export function connectEvents() {
  let version: string | undefined
  transport.stream('/api/events', (data) => {
    const e = JSON.parse(data)
    // The first connect needs no refetch, every later one follows a daemon restart or a lost connection.
    // A daemon that came back updated serves a new UI, so that one loads.
    if (e.type === 'connected' && !version) return void (version = e.version)
    if (e.type === 'connected' && e.version !== version) return location.reload()
    listeners.forEach((l) => l(e))
  })
}

export function useEvent(fn: Listener, deps: unknown[]) {
  useEffect(() => {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  }, deps)
}

// Fetch `path` and refetch whenever a matching server event arrives.
export function useApi<T>(path: string | null, refetchOn: (e: SavorEvent) => boolean): [T | undefined, () => Promise<void>, Error | undefined] {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error>()
  const load = useCallback(async () => {
    if (path) await api<T>('GET', path).then((next) => {
      setData(next)
      setError(undefined)
    }, setError)
  }, [path])
  useEffect(() => {
    setData(undefined)
    setError(undefined)
    load()
  }, [load])
  useEvent((e) => (e.type === 'connected' || refetchOn(e)) && load(), [load])
  return [data, load, error]
}

export const readFileAsDataUrl = (f: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(f)
  })

export interface AgentConfig { provider: string; model: string; reasoning: string; fast: boolean; ultracode: boolean; permissionMode: string }
export interface Question { title: string; body: string; options: string[]; recommended?: number }
export interface ApprovalOption { id: string; label: string; kind: 'allow' | 'deny' }
export interface Approval { title: string; detail: string; url?: string; options: ApprovalOption[]; status: 'pending' | 'resolved'; choice?: string }
export interface Message {
  id: string
  ts: string
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
  origin?: 'local' | 'remote'
  device?: string
  from?: { projectId: string; project: string; threadId: string; label: string }
  delivered?: boolean
}
export interface Attachment { name: string; dataUrl: string }
export interface ModeInfo { id: string; label: string; detail: string; unsafe?: boolean }
export interface ModelInfo { id: string; label: string; detail?: string; efforts?: string[]; ultracode?: boolean }
export interface ProviderInfo {
  id: string
  name: string
  installed: boolean
  version: string | null
  signedIn: boolean | null
  account: string | null
  models: ModelInfo[]
  efforts: string[]
  defaultEffort: string
  modes: ModeInfo[]
  defaultMode: string
  fast: boolean
  ultracode: boolean
  signIn: string
}
export interface Skill { name: string; description: string }
export interface Preset { id: string; name: string; agent: AgentConfig }
export interface Thread {
  id: string
  title: string
  label: { name: string; hue: number } | null
  summary?: string | null
  createdAt: string
  updatedAt: string
  agent: AgentConfig
  preview: string | null
  unread: boolean
  completed: boolean
  needsYou: boolean
  error: string | null
  resumeAt?: string | null
  ciWatch?: { sha: string } | null
  context?: { tokens: number; window: number | null } | null
  parentId?: string
  fork?: { provider: string; sessionId: string | null }
  agentSessions: { provider: string; sessionId: string }[]
  worktree?: { branch: string; path: string } | null
  fanout?: { id: string; base: string }
  workflow?: { id: string; name: string; trigger: Run['trigger']; due?: string }
  busy?: boolean
  waiting?: boolean
  messageCount?: number
  waitsFor?: { reason: Reason; text: string; more?: number; since: string } | null
  startedAt?: string
  step?: string | null
}
// Why a conversation waits for the user: the first three block the agent, results only wait to be read.
export type Reason = 'approval' | 'question' | 'failed' | 'new' | 'result'
// How a conversation shows in the lists.
export type ThreadKind = 'blocked' | 'failed' | 'new' | 'seen' | 'working' | 'idle' | 'done'
const KINDS: Record<Reason, ThreadKind> = { approval: 'blocked', question: 'blocked', failed: 'failed', new: 'new', result: 'seen' }
export const kindOf = (t: Thread): ThreadKind => (t.waitsFor ? KINDS[t.waitsFor.reason] : t.busy || t.waiting ? 'working' : t.completed ? 'done' : 'idle')
export const RINGS: Record<ThreadKind, string> = { blocked: 'needs', failed: 'error', new: 'unread', seen: '', working: 'busy', idle: '', done: 'done' }
export interface Worktree { branch: string; path: string; ahead: number; dirty: boolean }
export interface Change { path: string; additions: number | null; deletions: number | null }
// One conversation of a fan-out, as the comparison shows it.
export interface FanoutRun { thread: Thread; worktree: Worktree | null; changes: Change[]; merged: boolean; answer: string | null; workTiming: { startedAt: string; finishedAt: string } | null }
export interface CommitFile { path: string; additions: number | null; deletions: number | null; patch: string }
export interface Commit { hash: string; subject: string; body: string; author: string; date: string; files: CommitFile[] }
export interface ImportableSession { provider: 'claude' | 'codex'; id: string; title: string; startedAt: string; messages: number; imported: boolean }
export interface Decision { id: string; groupId: string; title: string; body: string; options: string[]; recommended?: number; selected: number | null; answer: string | null; resolved: boolean }
export interface ActivityEvent { id: number; type: 'thinking' | 'command' | 'edit' | 'note'; label: string; time: string; finishedAt?: string }
export interface Project {
  id: string
  name: string
  path: string
  tint: string
  agent: AgentConfig
  verbosity: 'low' | 'medium' | 'high'
  paused: boolean
  pinned: boolean
  worktreeSetup: string
  type?: string
  counts: { working: number; blocked: number; unread: number }
}
export interface Doc { id: string; title: string; content: string; updatedAt: string }
export interface Workflow { id: string; name: string; prompt: string; collection: string; cron: string | null; timezone: string; scheduleLabel: string | null; enabled: boolean; catchUp: boolean; button: boolean; next: string[]; lastRunAt: string | null; nextRunAt?: string | null; lastRun?: Run | null }
// A run of a workflow. A skipped one has no conversation of its own: threadId is the conversation that was in its way.
export interface Run { at: string; trigger: 'scheduled' | 'manual' | 'caught' | 'early'; due?: string; status: 'working' | 'needs' | 'stopped' | 'failed' | 'finished' | 'skipped'; threadId: string; summary: string; workedMs: number }
export interface Proc { pid: number; name: string; cwd: string; command: string; url: string | null; log: string | null; threadId: string; startedAt: string }
export interface Usage { provider: string; name: string; windows: { label: string; percent: number; resets: string | null }[]; stale: boolean }
export interface Me { origin: 'local' | 'remote'; device: string | null; awake: boolean; host: string; version: string; system: string; projectsDir: string; setup: boolean }

// The desktop shell's bridge (desktop/preload.cjs). A browser has none.
export const desktop = (window as { savorDesktop?: { pickFolder(): Promise<string | null>; checkForUpdates(): Promise<string | null>; installUpdate(): Promise<void>; onUpdateReady(cb: (version: string) => void): void; setContextActions?(root: string | null, cb: ((action: string, value: any) => void) | null): void; notify?(options: { title: string; body: string; hash: string; tag: string }): void; onOpen?(cb: (hash: string) => void): void } }).savorDesktop

export const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', grok: 'Grok Build', gemini: 'Gemini CLI', antigravity: 'Antigravity' }

// Installed agents, their models and modes: fetched once and shared by every picker.
let agentsCache: Promise<ProviderInfo[]> | null = null
export const fetchAgents = (refresh = false) => (agentsCache = !refresh && agentsCache ? agentsCache : api<ProviderInfo[]>('GET', refresh ? '/agents?refresh=1' : '/agents'))

export function useAgents() {
  const [agents, setAgents] = useState<ProviderInfo[]>()
  useEffect(() => void fetchAgents().then(setAgents, () => setAgents([])), [])
  return agents
}

// Claude Code describes its models as "Opus 5.5 · Best for …": the name with its version, then what it is for.
export const describeModel = (m: ModelInfo) => {
  const [, name, detail] = m.detail?.match(/^([^·]+?) · (.+)$/) ?? []
  return { name: name ?? m.label, detail: detail ?? m.detail ?? '' }
}

// The model by name, also for the default: "Opus 5.5" rather than "Default".
export const modelName = (a: AgentConfig, info?: ProviderInfo) => {
  const m = info?.models.find((m) => m.id === a.model)
  return m ? describeModel(m).name : a.model || 'Default'
}

export const effortLabel = (e: string) => (e === 'xhigh' ? 'X-High' : cap(e))

export const agentSummary = (a: AgentConfig, info?: ProviderInfo) =>
  [modelName(a, info), a.reasoning && effortLabel(a.reasoning), a.fast && 'Fast', a.ultracode && 'Ultracode'].filter(Boolean).join(' · ')

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const initial = (name: string) => (name.trim()[0] ?? '?').toLowerCase()

// Text on a project color: dark on light tints, white on the others.
export function inkOn(tint: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(tint.slice(i, i + 2), 16))
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#1b1c1f' : '#fff'
}
export const avatarStyle = (tint: string) => ({ background: tint, color: inkOn(tint) })

export const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
export const formatTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
// Only the time for today, the day before it otherwise.
export const formatStamp = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? formatTime(iso) : `${formatDay(iso)}, ${formatTime(iso)}`)
// What set a workflow run off. A run that was caught up says when it had been due.
const dueAt = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
export const runTrigger = (r: { trigger: Run['trigger']; due?: string }) =>
  r.trigger === 'caught' ? `Caught up, was due ${dueAt(r.due!)}` : r.trigger === 'early' ? `Early, in place of ${dueAt(r.due!)}` : r.trigger === 'manual' ? 'Manual' : 'Scheduled'
export function duration(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`
  const h = Math.floor(m / 60)
  return `${h} hour${h === 1 ? '' : 's'} ${m % 60} min`
}
