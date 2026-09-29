import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import * as store from './store.js'
import { emit, subscribe } from './events.js'
import { HOST, PORT, PUBLIC_URL } from './config.js'
import * as agents from './agents.js'
import * as browser from './browser.js'
import * as processes from './processes.js'
import * as devices from './devices.js'
import * as files from './files.js'
import * as awake from './awake.js'
import { pairingLink, relayStatus, startRelay } from './relay-client.js'
import { handleMcp, refreshNeedsYou, resolveApproval } from './mcp.js'
import { nextRun, runWorkflow, syncSchedules, validateCron } from './scheduler.js'

// dist/web next to the sources in development, ../web next to the bundled dist/server/index.mjs.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = [path.join(HERE, '..', 'dist', 'web'), path.join(HERE, '..', 'web')].find((d) => fs.existsSync(d)) ?? path.join(HERE, '..', 'dist', 'web')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
}

interface Ctx { res: ServerResponse; auth: devices.Auth; query: URLSearchParams }
type Params = Record<string, string>
type Handler = (params: Params, body: any, ctx: Ctx) => unknown
const routes: [string, RegExp, Handler][] = []
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp('^/api' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h])

class Forbidden extends Error {}
class BadRequest extends Error {}
const localOnly = (ctx: Ctx) => {
  if (ctx.auth.origin !== 'local') throw new Forbidden('Only available on this computer.')
}

const project = (params: Params) => store.getProject(params.pid)
const inputFrom = (b: any, ctx: Ctx, p: store.Project, tid: string) => ({
  text: String(b.text ?? ''),
  images: (b.images ?? []).map((dataUrl: string) => store.saveAttachment(p, tid, dataUrl)),
  origin: ctx.auth.origin,
  device: ctx.auth.device?.name,
})

// ---- session ----

route('GET', '/me', (_, __, ctx) => ({ origin: ctx.auth.origin, device: ctx.auth.device?.name ?? null, awake: awake.isAwake() }))
route('POST', '/awake', (_, b, ctx) => {
  localOnly(ctx)
  awake.setAwake(!!b.on)
  return { awake: awake.isAwake() }
})
route('GET', '/devices', (_, __, ctx) => (localOnly(ctx), devices.listDevices()))
route('POST', '/devices/pairing', (_, __, ctx) => {
  localOnly(ctx)
  const pairing = devices.createPairing()
  return { ...pairing, url: `${PUBLIC_URL}/#/pair/${pairing.code}`, relayUrl: pairingLink(pairing.code) }
})
route('GET', '/relay', (_, __, ctx) => (localOnly(ctx), relayStatus()))
route('PUT', '/relay', (_, b, ctx) => {
  localOnly(ctx)
  const url = typeof b.url === 'string' && b.url.trim() ? b.url.trim().replace(/\/$/, '') : null
  if (url && !/^https?:\/\//.test(url)) throw new BadRequest('The relay URL must start with https:// (or http:// for local testing).')
  const s = store.state()
  s.relay = { url, enabled: !!b.enabled && !!url }
  store.saveState(s)
  startRelay()
  return relayStatus()
})
route('DELETE', '/devices/:id', (params, _, ctx) => {
  localOnly(ctx)
  devices.revokeDevice(params.id)
  emit({ type: 'devices' })
  return {}
})

// ---- projects ----

route('GET', '/projects', () =>
  store.listProjects().map((p) => {
    const threads = store.listThreads(p)
    return {
      ...p,
      counts: {
        working: threads.filter((t) => agents.isBusy(t.id)).length,
        unread: threads.filter((t) => t.unread).length,
        needsYou: threads.filter((t) => t.needsYou).length,
      },
    }
  }),
)
route('POST', '/projects', (_, b, ctx) => {
  localOnly(ctx)
  const p = store.addProject(b.path, b.name)
  emit({ type: 'projects' })
  return p
})
route('GET', '/projects/:pid/role', (params) => ({ role: store.readRole(project(params)) }))
route('PATCH', '/projects/:pid', (params, b) => {
  const p = project(params)
  if (typeof b.role === 'string') store.saveRole(p, b.role)
  const patch = Object.fromEntries(Object.entries(b).filter(([k]) => ['name', 'tint', 'agent', 'verbosity', 'paused'].includes(k)))
  const updated = store.updateProject(p.id, patch)
  emit({ type: 'projects' })
  return updated
})
route('DELETE', '/projects/:pid', (params, _, ctx) => {
  localOnly(ctx)
  store.removeProject(params.pid)
  emit({ type: 'projects' })
  return {}
})

// ---- threads ----

route('GET', '/projects/:pid/threads', (params) => {
  const p = project(params)
  return store.listThreads(p).map((t) => ({ ...t, busy: agents.isBusy(t.id), messageCount: store.readMessages(p, t.id).length }))
})
route('POST', '/projects/:pid/threads', (params, b, ctx) => {
  const p = project(params)
  const t = store.createThread(p, { title: b.text || 'New conversation', agent: { ...p.agent, ...b.agent } })
  if (b.agent) store.updateProject(p.id, { agent: { ...p.agent, ...b.agent } })
  emit({ type: 'thread', projectId: p.id, threadId: t.id })
  agents.send(p, t.id, inputFrom(b, ctx, p, t.id))
  return t
})
route('GET', '/projects/:pid/threads/:tid', (params) => {
  const p = project(params)
  let thread = store.getThread(p, params.tid)
  if (thread.unread) {
    thread = store.updateThread(p, thread.id, { unread: false })
    emit({ type: 'thread', projectId: p.id, threadId: thread.id })
  }
  return {
    thread,
    busy: agents.isBusy(thread.id),
    messages: store.readMessages(p, thread.id),
    decisions: store.listDecisions(p, thread.id),
    processes: store.listProcs(p).filter((pr) => pr.threadId === thread.id),
  }
})
route('GET', '/projects/:pid/threads/:tid/activity', (params) => store.readActivity(project(params), params.tid))
route('PATCH', '/projects/:pid/threads/:tid', (params, b) => {
  const p = project(params)
  const patch: Partial<store.Thread> = {}
  if (typeof b.completed === 'boolean') patch.completed = b.completed
  if (typeof b.title === 'string') patch.title = b.title
  if (typeof b.label === 'string') patch.label = b.label ? { name: b.label, hue: store.hueFor(b.label) } : null
  if (b.agent) {
    patch.agent = { ...store.getThread(p, params.tid).agent, ...b.agent }
    store.updateProject(p.id, { agent: patch.agent! })
  }
  const t = store.updateThread(p, params.tid, patch)
  emit({ type: 'thread', projectId: p.id, threadId: t.id })
  return t
})
route('DELETE', '/projects/:pid/threads/:tid', (params) => {
  const p = project(params)
  agents.stop(params.tid)
  fs.rmSync(path.join(p.path, '.savor', 'threads', path.basename(params.tid)), { recursive: true, force: true })
  emit({ type: 'thread', projectId: p.id, threadId: params.tid })
  return {}
})
route('POST', '/projects/:pid/threads/:tid/messages', (params, b, ctx) => {
  const p = project(params)
  agents.send(p, store.getThread(p, params.tid).id, inputFrom(b, ctx, p, params.tid))
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
route('POST', '/projects/:pid/threads/:tid/decisions', (params, b, ctx) => {
  const p = project(params)
  const all = store.listDecisions(p, params.tid)
  const lines: string[] = []
  for (const a of b.answers as { id: string; selected?: number; answer?: string }[]) {
    const d = all.find((d) => d.id === a.id)
    if (!d || d.resolved) continue
    const resolved = { ...d, resolved: true, selected: a.selected ?? null, answer: a.selected == null ? a.answer ?? '' : null }
    store.saveDecision(p, resolved)
    lines.push(`Decision: ${d.title}\n${a.selected != null ? `Selected: ${d.options[a.selected]}` : `Answer: ${a.answer}`}`)
  }
  refreshNeedsYou(p, params.tid)
  if (lines.length) agents.send(p, params.tid, { text: lines.join('\n\n'), origin: ctx.auth.origin, device: ctx.auth.device?.name })
  return {}
})
route('GET', '/projects/:pid/threads/:tid/attachments/:name', (params, _, ctx) => {
  const file = path.join(store.attachmentDir(project(params), params.tid), path.basename(params.name))
  if (!fs.existsSync(file)) throw new store.NotFound('attachment')
  ctx.res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=31536000' })
  fs.createReadStream(file).pipe(ctx.res)
})

// ---- preview ----

route('GET', '/projects/:pid/threads/:tid/browser/stream', async (params, _, ctx) => {
  // After a daemon restart, reopen the thread's last preview on demand.
  const { preview } = store.getThread(project(params), params.tid)
  if (!browser.has(params.tid) && preview) await browser.open(params.pid, params.tid, preview).catch(() => {})
  return browser.watch(params.tid, ctx.res)
})
route('POST', '/projects/:pid/threads/:tid/browser/open', async (params, b) => {
  const p = project(params)
  await browser.open(p.id, params.tid, b.url)
  store.updateThread(p, params.tid, { preview: b.url })
  emit({ type: 'thread', projectId: p.id, threadId: params.tid })
  emit({ type: 'browser', projectId: p.id, threadId: params.tid })
  return {}
})
route('POST', '/projects/:pid/threads/:tid/browser/input', async (params, b) => {
  await browser.userInput(params.tid, b)
  return {}
})
route('POST', '/projects/:pid/threads/:tid/browser/pick', (params, b) => browser.pick(params.tid, b.x, b.y))

// ---- git ----

const git = (p: store.Project, ...args: string[]) => execFileSync('git', args, { cwd: p.path, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

route('GET', '/projects/:pid/git', (params) => {
  const p = project(params)
  try {
    return { branch: git(p, 'rev-parse', '--abbrev-ref', 'HEAD'), branches: git(p, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean) }
  } catch {
    return { branch: null, branches: [] }
  }
})
route('POST', '/projects/:pid/git/switch', (params, b) => {
  try {
    git(project(params), 'switch', String(b.branch))
  } catch (e) {
    throw new Error(String((e as { stderr?: Buffer }).stderr ?? e).trim())
  }
  return {}
})

// ---- files & documents ----

route('GET', '/projects/:pid/files', (params, _, ctx) => files.list(project(params), ctx.query.get('path') ?? ''))
route('GET', '/projects/:pid/files/search', (params, _, ctx) => files.search(project(params), ctx.query.get('q') ?? ''))
route('GET', '/projects/:pid/file', (params, _, ctx) => files.read(project(params), ctx.query.get('path') ?? ''))
route('PUT', '/projects/:pid/file', (params, b) => {
  files.write(project(params), b.path, b.content)
  return {}
})

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

const saveWorkflowRoute = (params: Params, b: any, id?: string) => {
  try {
    if (b.cron) validateCron(b.cron, b.timezone)
  } catch (e) {
    throw new BadRequest(`Invalid schedule: ${(e as Error).message}`)
  }
  const { name, prompt, cron, timezone, enabled, next } = b
  const fields = Object.fromEntries(Object.entries({ name, prompt, cron, timezone, enabled, next }).filter(([, v]) => v !== undefined))
  const wf = store.saveWorkflow(project(params), { ...(fields as { name: string; prompt: string }), ...(id && { id }) })
  syncSchedules()
  emit({ type: 'workflows', projectId: params.pid })
  return wf
}
route('GET', '/projects/:pid/workflows', (params) => store.listWorkflows(project(params)).map((wf) => ({ ...wf, nextRunAt: nextRun(wf) })))
route('POST', '/projects/:pid/workflows', (params, b) => saveWorkflowRoute(params, b))
route('PUT', '/projects/:pid/workflows/:id', (params, b) => saveWorkflowRoute(params, b, params.id))
route('DELETE', '/projects/:pid/workflows/:id', (params) => {
  store.deleteWorkflow(project(params), params.id)
  syncSchedules()
  emit({ type: 'workflows', projectId: params.pid })
  return {}
})
route('POST', '/projects/:pid/workflows/:id/run', (params, _, ctx) => runWorkflow(params.pid, params.id, ctx.auth.origin))

// ---- processes ----

route('GET', '/projects/:pid/processes', (params) => store.listProcs(project(params)))
route('POST', '/projects/:pid/processes/:ospid/kill', (params) => {
  processes.kill(project(params), Number(params.ospid))
  return {}
})
route('GET', '/projects/:pid/processes/:ospid/log', (params, _, ctx) => {
  const p = project(params)
  const proc = store.listProcs(p).find((pr) => pr.pid === Number(params.ospid))
  if (!proc?.log) throw new store.NotFound('log')
  const file = path.join(p.path, proc.log)
  const size = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(Math.min(size, 20_000))
  fs.readSync(fd, buf, 0, buf.length, size - buf.length)
  fs.closeSync(fd)
  ctx.res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(buf)
})

// ---- http plumbing ----

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > 30 * 1024 * 1024) throw new Error('Request too large.')
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString()
  return raw ? JSON.parse(raw) : {}
}

const json = (res: ServerResponse, status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data))

function serveStatic(url: URL, res: ServerResponse) {
  const file = path.join(WEB, path.normalize(url.pathname))
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
    res.writeHead(302, { 'set-cookie': `savor_token=${store.state().token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, location: '/' })
    return res.end()
  }

  if (url.pathname === '/api/pair' && req.method === 'POST') {
    const b = await readBody(req)
    let token: string
    try {
      token = devices.redeem(String(b.code ?? ''), String(b.name ?? ''))
    } catch (e) {
      return json(res, 400, { error: (e as Error).message })
    }
    emit({ type: 'devices' })
    res.writeHead(200, { 'set-cookie': `savor_device=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, 'content-type': 'application/json' })
    return res.end('{}')
  }

  if (!url.pathname.startsWith('/api/')) return serveStatic(url, res)
  const auth = devices.authenticate(req)
  if (!auth) return json(res, 401, { error: 'unauthorized' })
  if (url.pathname === '/api/events') return subscribe(res)

  for (const [method, re, h] of routes) {
    const m = url.pathname.match(re)
    if (!m || method !== req.method) continue
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : undefined
    const out = await h(m.groups ?? {}, body, { res, auth, query: url.searchParams })
    if (!res.headersSent) json(res, 200, out ?? {})
    return
  }
  res.writeHead(404).end()
}

http
  .createServer((req, res) =>
    handle(req, res).catch((e) => {
      if (!(e instanceof store.NotFound || e instanceof Forbidden || e instanceof BadRequest)) console.error(e)
      if (!res.headersSent) json(res, e instanceof store.NotFound ? 404 : e instanceof Forbidden ? 403 : e instanceof BadRequest ? 400 : 500, { error: e.message })
      else res.end()
    }),
  )
  .listen(PORT, HOST, () => {
    syncSchedules()
    processes.watchProcesses()
    startRelay()
    console.log(`Savor running — open ${PUBLIC_URL}/?token=${store.state().token}`)
  })
