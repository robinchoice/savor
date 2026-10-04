import { useCallback, useEffect, useState } from 'preact/hooks'
import { transport } from './transport'

export class Unauthorized extends Error {}

export const go = (path: string) => (location.hash = path)

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await transport.request(method, '/api' + path, body === undefined ? undefined : JSON.stringify(body))
  if (r.status === 401) throw new Unauthorized()
  let data: any = {}
  try {
    data = JSON.parse(r.body)
  } catch {}
  if (r.status >= 400) throw new Error(data.error ?? `Request failed (${r.status})`)
  return data
}

export type SavorEvent = { type: string; projectId?: string; threadId?: string; title?: string; body?: string }
type Listener = (e: SavorEvent) => void
const listeners = new Set<Listener>()

export function connectEvents() {
  transport.stream('/api/events', (data) => {
    const e = JSON.parse(data)
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
export function useApi<T>(path: string | null, refetchOn: (e: SavorEvent) => boolean): [T | undefined, () => void, Error | undefined] {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error>()
  const load = useCallback(() => {
    if (path) api<T>('GET', path).then((next) => {
      setData(next)
      setError(undefined)
    }, setError)
  }, [path])
  useEffect(() => {
    setData(undefined)
    setError(undefined)
    load()
  }, [load])
  useEvent((e) => refetchOn(e) && load(), [load])
  return [data, load, error]
}

export const readFileAsDataUrl = (f: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(f)
  })

export interface AgentConfig { provider: string; model: string; reasoning: string; fast: boolean; permissionMode: string }
export interface Question { title: string; body: string; options: string[] }
export interface ApprovalOption { id: string; label: string; kind: 'allow' | 'deny' }
export interface Approval { title: string; detail: string; options: ApprovalOption[]; status: 'pending' | 'resolved'; choice?: string }
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
  delivered?: boolean
}
export interface Attachment { name: string; dataUrl: string }
export interface ModeInfo { id: string; label: string; detail: string; unsafe?: boolean }
export interface ModelInfo { id: string; label: string; detail?: string; efforts?: string[] }
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
  signIn: string
}
export interface Preset { id: string; name: string; agent: AgentConfig }
export interface Thread {
  id: string
  title: string
  label: { name: string; hue: number } | null
  createdAt: string
  updatedAt: string
  agent: AgentConfig
  preview: string | null
  unread: boolean
  completed: boolean
  needsYou: boolean
  error: string | null
  worktree?: { branch: string; path: string } | null
  busy?: boolean
  messageCount?: number
}
export interface Worktree { branch: string; path: string; ahead: number; dirty: boolean }
export interface CommitFile { path: string; additions: number | null; deletions: number | null; patch: string }
export interface Commit { hash: string; subject: string; body: string; author: string; date: string; files: CommitFile[] }
export interface EnjoyProject { path: string; name: string; missing: boolean; projectId: string | null; conversations: number; added: number; documents: number; workflows: number }
export interface EnjoyResult { path: string; projectId: string; added: number; updated: number; kept: number; documents: number; workflows: number }
export interface ImportableSession { provider: 'claude' | 'codex'; id: string; title: string; startedAt: string; messages: number; imported: boolean }
export interface Decision { id: string; groupId: string; title: string; body: string; options: string[]; selected: number | null; answer: string | null; resolved: boolean }
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
  counts: { working: number; unread: number; needsYou: number }
}
export interface Doc { id: string; title: string; content: string; updatedAt: string }
export interface Workflow { id: string; name: string; prompt: string; cron: string | null; timezone: string; enabled: boolean; next: string[]; lastRunAt: string | null; nextRunAt?: string | null }
export interface Proc { pid: number; name: string; cwd: string; command: string; url: string | null; log: string | null; threadId: string; startedAt: string }
export interface Me { origin: 'local' | 'remote'; device: string | null; awake: boolean; host: string; version: string; system: string; projectsDir: string }

// The desktop shell's bridge (desktop/preload.cjs). A browser has none.
export const desktop = (window as { savorDesktop?: { pickFolder(): Promise<string | null>; checkForUpdates(): Promise<string | null> } }).savorDesktop

export const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', grok: 'Grok Build', antigravity: 'Antigravity' }

// Installed agents, their models and modes: fetched once and shared by every picker.
let agentsCache: Promise<ProviderInfo[]> | null = null
export const fetchAgents = (refresh = false) => (agentsCache = !refresh && agentsCache ? agentsCache : api<ProviderInfo[]>('GET', refresh ? '/agents?refresh=1' : '/agents'))

export function useAgents() {
  const [agents, setAgents] = useState<ProviderInfo[]>()
  useEffect(() => void fetchAgents().then(setAgents, () => setAgents([])), [])
  return agents
}

export const agentSummary = (a: AgentConfig, info?: ProviderInfo) =>
  [info?.models.find((m) => m.id === a.model)?.label ?? (a.model || 'Default'), a.reasoning && cap(a.reasoning), a.fast && 'Fast'].filter(Boolean).join(' · ')

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
export const formatTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
export function duration(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`
  const h = Math.floor(m / 60)
  return `${h} hour${h === 1 ? '' : 's'} ${m % 60} min`
}
