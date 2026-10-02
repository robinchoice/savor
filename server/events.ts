import type { ServerResponse } from 'node:http'

export interface SavorEvent {
  type: 'message' | 'thread' | 'status' | 'activity' | 'documents' | 'workflows' | 'processes' | 'projects' | 'browser' | 'devices' | 'notify' | 'presets'
  projectId?: string
  threadId?: string
  title?: string
  body?: string
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
  clients.add(res)
  res.on('close', () => clients.delete(res))
}

export function emit(e: SavorEvent) {
  const data = `data: ${JSON.stringify(e)}\n\n`
  for (const c of clients) c.write(data)
}
