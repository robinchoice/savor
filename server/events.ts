import type { ServerResponse } from 'node:http'

export type SavorEvent =
  | { type: 'message'; projectId: string; threadId: string }
  | { type: 'thread'; projectId: string; threadId: string }
  | { type: 'status'; projectId: string; threadId: string; busy: boolean }
  | { type: 'documents' | 'workflows' | 'processes' | 'projects'; projectId?: string }
  | { type: 'browser'; projectId: string; threadId: string }

const clients = new Set<ServerResponse>()

export function subscribe(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write(': connected\n\n')
  clients.add(res)
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  res.on('close', () => {
    clearInterval(ping)
    clients.delete(res)
  })
}

export function emit(e: SavorEvent) {
  const data = `data: ${JSON.stringify(e)}\n\n`
  for (const c of clients) c.write(data)
}
