import { useEffect, useState, useCallback } from 'preact/hooks'

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

export type SavorEvent = { type: string; projectId?: string; threadId?: string; busy?: boolean }
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
export interface Thread { id: string; label: string | null; createdAt: string; preview: string | null; unread: boolean; busy?: boolean; parentId?: string }
export interface Project { id: string; name: string; path: string; agent: { provider: string; model: string; permissionMode: string } }
export interface Doc { id: string; title: string; content: string; updatedAt: string }
export interface Workflow { id: string; name: string; prompt: string; cron: string | null; timezone: string; enabled: boolean; lastRunAt: string | null }
export interface Proc { pid: number; name: string; cwd: string; command: string; url: string | null; log: string | null; threadId: string; startedAt: string }
