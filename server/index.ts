import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'
import * as store from './store.js'
import { emit, subscribe } from './events.js'
import { HOST, PORT, PUBLIC_URL } from './config.js'
import * as agents from './agents.js'
import * as browser from './browser.js'
import * as processes from './processes.js'
import { handleMcp, resolveApproval } from './mcp.js'
import { runWorkflow, syncSchedules, validateCron } from './scheduler.js'

// Node 18 has no global WebCrypto, which the MCP SDK expects.
globalThis.crypto ??= webcrypto as Crypto

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'web')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

type Params = Record<string, string>
type Handler = (params: Params, body: any, res: ServerResponse) => unknown
const routes: [string, RegExp, Handler][] = []
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp('^/api' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h])

const project = (params: Params) => store.getProject(params.pid)

// ---- projects ----

route('GET', '/projects', () => store.listProjects())
route('POST', '/projects', (_, b) => {
  const p = store.addProject(b.path, b.name)
  emit({ type: 'projects' })
  return p
})
route('PATCH', '/projects/:pid', (params, b) => {
  const p = store.updateProject(params.pid, { ...(b.name && { name: b.name }), ...(b.agent && { agent: b.agent }) })
  emit({ type: 'projects' })
  return p
})
route('DELETE', '/projects/:pid', (params) => {
  store.removeProject(params.pid)
  emit({ type: 'projects' })
  return {}
})

// ---- threads ----

route('GET', '/projects/:pid/threads', (params) => store.listThreads(project(params)).map((t) => ({ ...t, busy: agents.isBusy(t.id) })))
route('POST', '/projects/:pid/threads', (params, b) => {
  const p = project(params)
  const t = store.createThread(p)
  emit({ type: 'thread', projectId: p.id, threadId: t.id })
  agents.send(p, t.id, b.text)
  return t
})
route('GET', '/projects/:pid/threads/:tid', (params) => {
  const p = project(params)
  let thread = store.getThread(p, params.tid)
  if (thread.unread) {
    thread = store.updateThread(p, thread.id, { unread: false })
    emit({ type: 'thread', projectId: p.id, threadId: thread.id })
  }
  return { thread, messages: store.readMessages(p, thread.id), busy: agents.isBusy(thread.id) }
})
route('POST', '/projects/:pid/threads/:tid/messages', (params, b) => {
  agents.send(project(params), store.getThread(project(params), params.tid).id, b.text)
  return {}
})
route('POST', '/projects/:pid/threads/:tid/stop', (params) => {
  agents.stop(params.tid)
  return {}
})
route('POST', '/projects/:pid/threads/:tid/approvals/:mid', (params, b) => {
  resolveApproval(project(params), params.tid, params.mid, !!b.allow)
  return {}
})
route('GET', '/projects/:pid/threads/:tid/screenshot', (params, _, res) => {
  const png = browser.lastShot(params.tid)
  if (!png) throw new store.NotFound('screenshot')
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(png)
})

// ---- documents ----

route('GET', '/projects/:pid/docs', (params) => store.listDocs(project(params)))
route('GET', '/projects/:pid/docs/:id', (params) => store.getDoc(project(params), params.id))
route('POST', '/projects/:pid/docs', (params, b) => {
  const doc = store.saveDoc(project(params), { title: b.title, content: b.content ?? '' })
  emit({ type: 'documents', projectId: params.pid })
  return doc
})
route('PUT', '/projects/:pid/docs/:id', (params, b) => {
  const doc = store.saveDoc(project(params), { id: params.id, title: b.title, content: b.content })
  emit({ type: 'documents', projectId: params.pid })
  return doc
})
route('DELETE', '/projects/:pid/docs/:id', (params) => {
  store.deleteDoc(project(params), params.id)
  emit({ type: 'documents', projectId: params.pid })
  return {}
})

// ---- workflows ----

route('GET', '/projects/:pid/workflows', (params) => store.listWorkflows(project(params)))
route('POST', '/projects/:pid/workflows', (params, b) => {
  if (b.cron) validateCron(b.cron, b.timezone)
  const wf = store.saveWorkflow(project(params), { ...b, id: undefined })
  syncSchedules()
  emit({ type: 'workflows', projectId: params.pid })
  return wf
})
route('PUT', '/projects/:pid/workflows/:id', (params, b) => {
  if (b.cron) validateCron(b.cron, b.timezone)
  const wf = store.saveWorkflow(project(params), { ...b, id: params.id })
  syncSchedules()
  emit({ type: 'workflows', projectId: params.pid })
  return wf
})
route('DELETE', '/projects/:pid/workflows/:id', (params) => {
  store.deleteWorkflow(project(params), params.id)
  syncSchedules()
  emit({ type: 'workflows', projectId: params.pid })
  return {}
})
route('POST', '/projects/:pid/workflows/:id/run', (params) => runWorkflow(params.pid, params.id))

// ---- processes ----

route('GET', '/projects/:pid/processes', (params) => store.listProcs(project(params)))
route('POST', '/projects/:pid/processes/:ospid/kill', (params) => {
  processes.kill(project(params), Number(params.ospid))
  return {}
})
route('GET', '/projects/:pid/processes/:ospid/log', (params, _, res) => {
  const p = project(params)
  const proc = store.listProcs(p).find((pr) => pr.pid === Number(params.ospid))
  if (!proc?.log) throw new store.NotFound('log')
  const file = path.join(p.path, proc.log)
  const size = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(Math.min(size, 20_000))
  fs.readSync(fd, buf, 0, buf.length, size - buf.length)
  fs.closeSync(fd)
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(buf)
})

// ---- http plumbing ----

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString()
  return raw ? JSON.parse(raw) : {}
}

const authed = (req: IncomingMessage) => (req.headers.cookie ?? '').split(/;\s*/).includes(`savor_token=${store.state().token}`)

function serveStatic(url: URL, res: ServerResponse) {
  const file = path.join(WEB, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''))
  const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(WEB, 'index.html')
  if (!fs.existsSync(target)) return res.writeHead(500).end('Web UI not built. Run `npm run build`.')
  res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' })
  fs.createReadStream(target).pipe(res)
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x')

  if (url.pathname.startsWith('/mcp/')) {
    if (url.pathname !== `/mcp/${store.state().mcpToken}`) return res.writeHead(401).end()
    return handleMcp(req, res, url, req.method === 'POST' ? await readBody(req) : undefined)
  }

  if (url.searchParams.get('token') === store.state().token) {
    res.writeHead(302, {
      'set-cookie': `savor_token=${store.state().token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
      location: '/',
    })
    return res.end()
  }

  if (!url.pathname.startsWith('/api/')) return serveStatic(url, res)
  if (!authed(req)) return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
  if (url.pathname === '/api/events') return subscribe(res)

  for (const [method, re, h] of routes) {
    const m = url.pathname.match(re)
    if (!m || method !== req.method) continue
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : undefined
    const out = await h(m.groups ?? {}, body, res)
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? {}))
    return
  }
  res.writeHead(404).end()
}

http
  .createServer((req, res) =>
    handle(req, res).catch((e) => {
      console.error(e)
      if (!res.headersSent) res.writeHead(e instanceof store.NotFound ? 404 : 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }),
  )
  .listen(PORT, HOST, () => {
    syncSchedules()
    processes.watchProcesses()
    console.log(`Savor running — open ${PUBLIC_URL}/?token=${store.state().token}`)
  })
