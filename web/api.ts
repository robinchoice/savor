import { useCallback, useEffect, useState } from 'preact/hooks'

export class Unauthorized extends Error {}

export const go = (path: string) => (location.hash = path)

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch('/api' + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (r.status === 401) throw new Unauthorized()
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error ?? r.statusText)
  return data
}

export type SavorEvent = { type: string; projectId?: string; threadId?: string; title?: string; body?: string }
type Listener = (e: SavorEvent) => void
const listeners = new Set<Listener>()

export function connectEvents() {
  const es = new EventSource('/api/events')
  es.onmessage = (m) => {
    const e = JSON.parse(m.data)
    listeners.forEach((l) => l(e))
  }
}

export function useEvent(fn: Listener, deps: unknown[]) {
  useEffect(() => {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  }, deps)
}

// Fetch `path` and refetch whenever a matching server event arrives.
export function useApi<T>(path: string | null, refetchOn: (e: SavorEvent) => boolean): [T | undefined, () => void] {
  const [data, setData] = useState<T>()
  const load = useCallback(() => {
    if (path) api<T>('GET', path).then(setData, () => setData(undefined))
  }, [path])
  useEffect(() => {
    setData(undefined)
    load()
  }, [load])
  useEvent((e) => refetchOn(e) && load(), [load])
  return [data, load]
}

export const readFileAsDataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(f)
  })

export interface AgentConfig { provider: string; model: string; reasoning: string; fast: boolean; permissionMode: string }
export interface Question { title: string; body: string; options: string[] }
export interface Message {
  id: string
  ts: string
  kind: 'user' | 'ack' | 'update' | 'conclusion' | 'error' | 'approval'
  text?: string
  images?: string[]
  questions?: Question[]
  decisionIds?: string[]
  suggestions?: string[]
  commits?: string[]
  approval?: { tool: string; input: unknown; status: 'pending' | 'allowed' | 'denied' }
  modelInfo?: AgentConfig
  workTiming?: { startedAt: string; finishedAt: string }
  origin?: 'local' | 'remote'
  device?: string
}
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
  busy?: boolean
  messageCount?: number
}
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
  counts: { working: number; unread: number; needsYou: number }
}
export interface Doc { id: string; title: string; content: string; updatedAt: string }
export interface Workflow { id: string; name: string; prompt: string; cron: string | null; timezone: string; enabled: boolean; next: string[]; lastRunAt: string | null; nextRunAt?: string | null }
export interface Proc { pid: number; name: string; cwd: string; command: string; url: string | null; log: string | null; threadId: string; startedAt: string }
export interface Me { origin: 'local' | 'remote'; device: string | null; awake: boolean }

export const PROVIDERS: Record<string, { name: string; models: string[]; reasoning: string[] }> = {
  claude: { name: 'Claude Code', models: ['', 'opus', 'sonnet', 'haiku'], reasoning: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex: { name: 'Codex', models: ['', 'gpt-5-codex', 'gpt-5'], reasoning: ['minimal', 'low', 'medium', 'high'] },
  opencode: { name: 'OpenCode', models: [''], reasoning: [] },
  grok: { name: 'Grok Build', models: [''], reasoning: [] },
  antigravity: { name: 'Antigravity', models: [''], reasoning: [] },
}

export const agentSummary = (a: AgentConfig) =>
  [a.model || 'Default', a.reasoning && PROVIDERS[a.provider]?.reasoning.includes(a.reasoning) && cap(a.reasoning), a.fast && 'Fast'].filter(Boolean).join(' ')

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
