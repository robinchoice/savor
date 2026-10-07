import type { ServerResponse } from 'node:http'
import { VERSION } from './config.js'

export interface SavorEvent {
  type: 'connected' | 'message' | 'thread' | 'status' | 'activity' | 'documents' | 'workflows' | 'processes' | 'projects' | 'browser' | 'devices' | 'notify' | 'presets' | 'terminal' | 'review' | 'backlog'
  projectId?: string
  threadId?: string
  title?: string
  body?: string
  version?: string
}

export function openStream(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write(': connected\n\n')
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  res.on('close', () => clearInterval(ping))
}

const clients = new Set<ServerResponse>()

export function subscribe(res: ServerResponse) {
  openStream(res)
  // Sent on every (re)connect, so the UI refetches what it missed while the daemon was away, or
  // reloads when the daemon came back with another version.
  res.write(`data: ${JSON.stringify({ type: 'connected', version: VERSION })}\n\n`)
  clients.add(res)
  res.on('close', () => clients.delete(res))
}

export function emit(e: SavorEvent) {
  const data = `data: ${JSON.stringify(e)}\n\n`
  for (const c of clients) c.write(data)
}
