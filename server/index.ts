import { captureException } from './monitoring.js'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from './store.js'
import { emit, subscribe } from './events.js'
import { BIN, HOST, PORT, PUBLIC_URL, VERSION } from './config.js'
import * as agents from './agents.js'
import * as browser from './browser.js'
import * as processes from './processes.js'
import * as devices from './devices.js'
import * as files from './files.js'
import * as awake from './awake.js'
import * as terminal from './terminal.js'
import { closeDevice, pairingLink, relayStatus, startRelay } from './relay-client.js'
import { startUsagePing, usageAvailable } from './usage.js'
import { newNonce, securityHeaders, withNonce } from '../shared/headers.js'
import { fanoutBranches } from '../shared/fanout.js'
import { handleMcp } from './mcp.js'
import { formContent } from './session.js'
import { claudeAside } from './claude.js'
import { codexAside } from './codex.js'
import { acpAside } from './acp.js'
import { antigravityAside } from './antigravity.js'
import { isUnsafe, listAgents, listSkills, listUsage, mergeAgent } from './providers.js'
import { month, nextRun, runEarly, runs, runWorkflow, syncSchedules, validateCron } from './scheduler.js'
import { preflightSchema } from './workflow-results.js'
import * as git from './git.js'
import * as ci from './ci.js'
import * as move from './move.js'
import { deleteSessions, importSessions, listSessions } from './import.js'
import * as voice from './voice.js'
import * as workspace from './workspace.js'
import * as push from './push.js'
import { listWarnings } from './health.js'

// dist/web next to the sources in development, ../web next to the bundled dist/server/index.mjs.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const projectRoles: Record<string, string> = Object.fromEntries(['academic-writing', 'kontor'].map((type) => {
  const raw = fs.readFileSync(path.join(HERE, '..', 'templates', `${type}.md`), 'utf8')
  return [type, raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim() + '\n']
}))
const WEB = [path.join(HERE, '..', 'dist', 'web'), path.join(HERE, '..', 'web')].find((d) => fs.existsSync(d)) ?? path.join(HERE, '..', 'dist', 'web')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
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
// Agent settings must name a known provider and one of its permission modes. Skipping approvals can
// only be switched on at this computer; devices keep it where it's already on.
function agentFrom(ctx: Ctx, current: store.AgentConfig, patch: Partial<store.AgentConfig>) {
  let next: store.AgentConfig
  try {
    next = mergeAgent(current, patch)
  } catch (e) {
    throw new BadRequest((e as Error).message)
  }
  if (isUnsafe(next.provider, next.permissionMode) && !(next.provider === current.provider && next.permissionMode === current.permissionMode)) localOnly(ctx)
  return next
}

const project = (params: Params) => store.getProject(params.pid)
function inputFrom(b: any, ctx: Ctx, p: store.Project, tid: string): agents.Input {
  const attachments = (b.attachments ?? []) as { name: string; dataUrl: string }[]
  if (attachments.length > 8) throw new BadRequest('Attach up to 8 files per message.')
  const saved = attachments.map((a) => store.saveAttachment(p, tid, a))
  return {
    text: String(b.text ?? ''),
    images: saved.filter((a) => a.image).map((a) => a.name),
    files: saved.filter((a) => !a.image).map((a) => a.name),
    origin: ctx.auth.origin,
    device: ctx.auth.device?.name,
  }
}

// ---- session ----

const SYSTEM = `${({ linux: 'Linux', darwin: 'macOS', win32: 'Windows' } as Record<string, string>)[process.platform] ?? process.platform} ${process.arch}`
route('GET', '/me', (_, __, ctx) => ({
  origin: ctx.auth.origin,
  device: ctx.auth.device?.name ?? null,
  awake: awake.isAwake(),
  host: os.hostname(),
  version: VERSION,
  system: SYSTEM,
  projectsDir: store.projectsDir(),
  // First start on this computer: no projects yet and no default agent chosen, so the UI offers the setup.
  setup: ctx.auth.origin === 'local' && !store.state().agent && !store.state().projects.length,
}))
route('POST', '/awake', (_, b, ctx) => {
  localOnly(ctx)
  awake.setAwake(!!b.on)
  return { awake: awake.isAwake() }
})
// Bug reports go on to the Pleasance API, which files them as issues in a private repo. Savor keeps nothing.
const FEEDBACK_URL = process.env.SAVOR_FEEDBACK_URL ?? 'https://api.pleasance.org/savor/feedback'
// What the daemon adds to a report, shown before it is sent: no paths, project names or URLs.
route('GET', '/feedback/context', async () => {
  const installed = (await listAgents()).filter((a) => a.installed)
  const { agent } = store.state()
  const s = settings()
  const changed = [!s.autoUpdate && 'auto update off', !s.autoRestart && 'auto restart off', s.usagePing === false && 'usage ping off'].filter(Boolean)
  return [
    ['Agents', installed.map((a) => `${a.name} ${a.version ?? '?'}${a.signedIn === false ? ' (signed out)' : ''}`).join(', ') || 'none installed'],
    ['Default agent', agent ? `${agent.provider} ${agent.model}` : '–'],
    ['Relay', relayStatus().state],
    ['Changed settings', changed.join(', ') || '–'],
  ]
})
route('POST', '/feedback', async (_, b) => {
  if (typeof b.text !== 'string' || !b.text.trim()) throw new BadRequest('Describe what went wrong.')
  // The ID also goes into this daemon's log, so a report can be matched with what happened here around it.
  const id = `BUG-${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}-${randomBytes(3).toString('hex')}`
  const context = [...(Array.isArray(b.context) ? b.context : []), ['Report ID', id]]
  const r = await fetch(FEEDBACK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: b.text, context, screenshot: b.screenshot ?? null }),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null)
  if (r?.status === 429) throw new BadRequest('Too many reports from here. Try again in an hour.')
  if (!r?.ok) throw new BadRequest('The report could not be sent. Try again later.')
  console.log(`bug report ${id}`)
  return { ok: true, id }
})
route('GET', '/devices', (_, __, ctx) => (localOnly(ctx), devices.listDevices()))
route('POST', '/devices/token', (_, b, ctx) => {
  localOnly(ctx)
  if (typeof b.name !== 'string' || !b.name.trim()) throw new BadRequest('Give the shortcut a name.')
  const token = devices.addTokenDevice(b.name.trim())
  ctx.res.setHeader('cache-control', 'no-store')
  emit({ type: 'devices' })
  return { token }
})
route('POST', '/devices/pairing', (_, __, ctx) => {
  localOnly(ctx)
  const pairing = devices.createPairing()
  return { ...pairing, url: `${store.state().publicUrl ?? PUBLIC_URL}/#/pair/${pairing.code}`, relayUrl: pairingLink(pairing.code) }
})
// The address paired devices use without a relay, e.g. this computer's name in a VPN.
route('GET', '/devices/address', (_, __, ctx) => (localOnly(ctx), { url: store.state().publicUrl ?? null, fallback: PUBLIC_URL }))
route('PUT', '/devices/address', (_, b, ctx) => {
  localOnly(ctx)
  const url = typeof b.url === 'string' && b.url.trim() ? b.url.trim().replace(/\/$/, '') : null
  if (url && !/^https?:\/\//.test(url)) throw new BadRequest('The address must start with https:// or http://.')
  const s = store.state()
  s.publicUrl = url
  store.saveState(s)
  return { url, fallback: PUBLIC_URL }
})
route('GET', '/agents', async (_, __, ctx) => {
  if (!ctx.query.has('refresh')) return listAgents()
  const list = await listAgents(true)
  emit({ type: 'health' })
  return list
})
route('GET', '/usage', () => listUsage())
route('GET', '/ci', () => ci.liveRuns())
route('POST', '/ci/dismiss', (_, b) => (ci.dismiss(Number(b.id)), { ok: true }))
// The agent new projects start with.
route('GET', '/agent', () => store.state().agent ?? store.defaultAgent())
route('PUT', '/agent', (_, b, ctx) => {
  localOnly(ctx)
  const s = store.state()
  s.agent = agentFrom(ctx, s.agent ?? store.defaultAgent(), b)
  store.saveState(s)
  emit({ type: 'health' })
  return s.agent
})
// The agents every conversation goes on with at a usage limit, in their order (agents.ts).
route('GET', '/fallback', () => agents.fallbackSettings())
route('PUT', '/fallback', (_, b, ctx) => {
  localOnly(ctx)
  if (!Array.isArray(b.agents) || b.agents.length > 10) throw new BadRequest('Name up to 10 agents in their order.')
  const s = store.state()
  s.fallback = { on: b.on === true, agents: b.agents.map((a: Partial<store.AgentConfig>) => agentFrom(ctx, store.defaultAgent(), a)) }
  store.saveState(s)
  emit({ type: 'settings' })
  return agents.fallbackSettings()
})
route('GET', '/presets', () => store.listPresets())
route('POST', '/presets', (_, b, ctx) => {
  localOnly(ctx)
  if (typeof b.name !== 'string' || !b.name.trim()) throw new BadRequest('Give the preset a name.')
  const preset = store.savePreset(b.name, { ...store.defaultAgent(), ...b.agent })
  emit({ type: 'presets' })
  return preset
})
route('DELETE', '/presets/:id', (params, _, ctx) => {
  localOnly(ctx)
  store.deletePreset(params.id)
  emit({ type: 'presets' })
  return {}
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
route('GET', '/devices/requests', (_, __, ctx) => (localOnly(ctx), devices.pairingRequests()))
route('POST', '/devices/requests/:id', (params, b, ctx) => {
  localOnly(ctx)
  devices.decidePairing(params.id, b.approve === true)
  return {}
})
route('PATCH', '/devices/:id', (params, b, ctx) => {
  localOnly(ctx)
  const s = store.state()
  const device = s.devices.find((d) => d.id === params.id)
  if (!device) throw new store.NotFound('device')
  device.terminal = b.terminal === true
  store.saveState(s)
  if (!device.terminal) terminal.disconnectDevice(device.id)
  emit({ type: 'devices' })
  emit({ type: 'terminal' })
  return {}
})
route('DELETE', '/devices/:id', (params, _, ctx) => {
  localOnly(ctx)
  devices.revokeDevice(params.id)
  closeDevice(params.id)
  disconnectDevice(params.id)
  emit({ type: 'devices' })
  return {}
})

// ---- web push ----

// Only paired devices get pushes; this computer's browser notifies from the open page.
const deviceOnly = (ctx: Ctx) => {
  if (!ctx.auth.device) throw new Forbidden('Push notifications are for paired devices.')
  return ctx.auth.device
}
route('GET', '/push', (_, __, ctx) => ({ publicKey: ctx.auth.device ? push.publicKey() : null }))
route('PUT', '/push', (_, b, ctx) => {
  const device = deviceOnly(ctx)
  const ok = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 2000
  if (!ok(b.endpoint) || !/^https:\/\//.test(b.endpoint) || !ok(b.keys?.p256dh) || !ok(b.keys?.auth)) throw new BadRequest('Not a push subscription.')
  push.subscribe(device.id, { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } })
  return {}
})
route('DELETE', '/push', (_, __, ctx) => {
  push.subscribe(deviceOnly(ctx).id, null)
  return {}
})
// Every page says whether it shows Savor: a notice goes to the phones at once when none does.
route('POST', '/push/visible', (_, b, ctx) => {
  if (typeof b.page !== 'string' || b.page.length > 64) throw new BadRequest('Name the page.')
  push.setVisible(b.page, ctx.auth.device?.id ?? null, !!b.visible)
  return {}
})

// ---- voice input ----

route('POST', '/voice/prepare', () => voice.prepare())
route('POST', '/voice/transcribe', async (_, b) => {
  if (typeof b.audio !== 'string') throw new BadRequest('Audio is required.')
  const pcm = Buffer.from(b.audio, 'base64')
  if (!pcm.length || pcm.length % 2) throw new BadRequest('Audio must be 16-bit PCM.')
  return { text: await voice.transcribe(pcm) }
})
route('GET', '/voice/models', () => voice.models())
route('PUT', '/voice/model', (_, b, ctx) => {
  localOnly(ctx)
  voice.select(String(b.id))
  return voice.models()
})
// Devices may start a download too: the composer offers it when the model is missing.
route('POST', '/voice/models/:id/download', (params) => {
  voice.download(params.id)
  return voice.models()
})
route('DELETE', '/voice/models/:id', (params, _, ctx) => {
  localOnly(ctx)
  voice.remove(params.id)
  return voice.models()
})

// ---- projects ----

route('GET', '/projects', () =>
  store.listProjects().map((p) => {
    const threads = store.listThreads(p)
    // As in the conversation lists: waiting for background tasks, CI or a usage limit is working too.
    const working = (t: store.Thread) => !t.completed && !t.needsYou && (agents.isBusy(t.id) || agents.waiting(p, t))
    return {
      ...p,
      counts: {
        working: threads.filter(working).length,
        // Questions, approvals and errors block the agent; unread results only wait to be read.
        blocked: threads.filter((t) => !t.completed && (t.needsYou || failed(t))).length,
        // A conversation still working shows as working, even when a message from another one marked it unread.
        unread: threads.filter((t) => !t.completed && t.unread && !t.needsYou && !failed(t) && !working(t)).length,
        // Read but not finished yet.
        open: threads.filter((t) => !t.completed && !t.unread && !t.needsYou && !failed(t) && !working(t)).length,
      },
    }
  }),
)
route('POST', '/projects', (_, b, ctx) => {
  if (b.type !== undefined && (typeof b.type !== 'string' || !Object.hasOwn(projectRoles, b.type))) throw new BadRequest('Unknown project type.')
  let dir = b.path
  if (ctx.auth.origin !== 'local') {
    if (b.create !== true || b.path !== undefined || typeof b.folder !== 'string' || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(b.folder))
      throw new Forbidden('Remote devices can only create a new folder in the projects folder.')
    const root = store.expand(store.projectsDir())
    dir = path.join(root, b.folder)
    if (fs.lstatSync(dir, { throwIfNoEntry: false })) throw new BadRequest('That folder already exists. Choose another project name.')
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(dir)
  } else if (b.create && fs.existsSync(store.expand(String(dir)))) throw new BadRequest('That folder already exists. Open it with “Open any folder”.')
  let p = git.openProject(dir, b.name, !!b.create)
  if (b.create && b.type) {
    store.saveRole(p, projectRoles[b.type])
    p = store.updateProject(p.id, { type: b.type })
  }
  return p
})
route('PUT', '/projects/order', (_, b) => {
  store.fixProjects((b.ids ?? []).map(String))
  emit({ type: 'projects' })
  return {}
})
route('GET', '/projects/:pid/role', (params) => ({ role: store.readRole(project(params)) }))
route('PATCH', '/projects/:pid', (params, b, ctx) => {
  const p = project(params)
  // ROLE.md and the default agent apply to every conversation in the project, and the worktree setup
  // is a shell command on this computer, so devices can't change them.
  const agent = b.agent && agentFrom(ctx, p.agent, b.agent)
  const roleChanged = typeof b.role === 'string' && b.role !== store.readRole(p)
  const setupChanged = typeof b.worktreeSetup === 'string' && b.worktreeSetup !== p.worktreeSetup
  if (roleChanged || setupChanged || (agent && JSON.stringify(agent) !== JSON.stringify(p.agent))) localOnly(ctx)
  if (roleChanged) store.saveRole(p, b.role)
  const patch = Object.fromEntries(Object.entries(b).filter(([k]) => ['name', 'tint', 'agent', 'verbosity', 'paused', 'pinned', 'fixed', 'worktreeSetup', 'type'].includes(k)))
  if (agent) patch.agent = agent
  // A closed tab opens again among the others, by name.
  if (patch.pinned === false) patch.fixed = false
  const updated = store.updateProject(p.id, patch)
  emit({ type: 'projects' })
  return updated
})
// Moves or renames the project folder, or points the project at where it already is. `dryRun` only shows the plan.
route('POST', '/projects/:pid/move', (params, b, ctx) => {
  localOnly(ctx)
  const p = project(params)
  if (!/^(~\/|\/)/.test(String(b.path ?? ''))) throw new BadRequest('Give an absolute path or one starting with ~/.')
  if (b.dryRun) return move.planMove(p, b.path)
  try {
    return move.moveProject(p, b.path, { link: b.link !== false, force: !!b.force })
  } catch (e) {
    if (e instanceof move.MoveError) throw new BadRequest(e.message)
    throw e
  }
})
route('DELETE', '/projects/:pid', (params, _, ctx) => {
  localOnly(ctx)
  store.removeProject(params.pid)
  terminal.closeProject(params.pid)
  emit({ type: 'projects' })
  return {}
})

// ---- threads ----

const STOPPED = 'Turn stopped.'
// A turn that waits for a usage limit to reset counts as working, not as failed.
const failed = (t: store.Thread) => !!t.error && t.error !== STOPPED && !agents.isBusy(t.id) && !t.resumeAt

// What the conversation lists show beyond the thread: why it waits for the user and what it does while it works.
function listed(p: store.Project, t: store.Thread) {
  const messages = store.readMessages(p, t.id)
  const busy = agents.isBusy(t.id)
  const waiting = agents.waiting(p, t)
  const startedAt = busy ? agents.startedAt(t.id) : undefined
  return { ...t, busy, waiting, messageCount: messages.length, waitsFor: waitsFor(p, t, messages, busy || waiting), ...(startedAt && { startedAt, step: step(p, t, startedAt) }) }
}

// A read result keeps waiting until a follow-up or Finish, except a workflow run's; `since` is when it started to wait.
function waitsFor(p: store.Project, t: store.Thread, messages: store.Message[], working: boolean) {
  if (t.completed) return null
  const since = messages.at(-1)?.ts ?? t.updatedAt
  if (t.needsYou) {
    const approval = messages.filter((m) => m.approval?.status === 'pending').at(-1)?.approval
    if (approval) return { reason: 'approval', text: approval.title, since }
    const open = store.listDecisions(p, t.id).filter((d) => !d.resolved)
    return { reason: 'question', text: open[0]?.title ?? '', more: Math.max(0, open.length - 1), since }
  }
  if (working) return null
  if (failed(t)) return { reason: 'failed', text: t.error, since }
  const last = messages.at(-1)
  // Unread is also what someone marked as unread again, whatever came last.
  if (t.unread) return { reason: 'new', text: (last?.text ?? '').slice(0, 300), since }
  if (last?.kind === 'conclusion' && !t.workflow) return { reason: 'result', text: (last.text ?? '').slice(0, 300), since }
  return null
}

// The step of its plan the agent works on, else the tool it runs right now, or the last one of this turn.
function step(p: store.Project, t: store.Thread, startedAt: string) {
  const active = store.readPlans(p, t.id)[agents.request(p, t.id).inputId]?.steps.find((s) => s.status === 'active')
  if (active) return active.active ?? active.text
  const events = store.readActivity(p, t.id).filter((e) => e.time >= startedAt)
  const label = (events.filter((e) => !e.finishedAt).at(-1) ?? events.at(-1))?.label
  return label?.replaceAll(`${store.cwdOf(p, t)}/`, '') ?? null
}

route('GET', '/projects/:pid/threads', (params) => {
  const p = project(params)
  return store.listThreads(p).map((t) => listed(p, t))
})
route('POST', '/projects/:pid/threads', (params, b, ctx) => {
  const p = project(params)
  if (b.inbox === true && p.type !== 'kontor') throw new BadRequest('Automatic routing needs a Kontor project.')
  const agent = agentFrom(ctx, p.agent, b.agent ?? {})
  const worktree = typeof b.worktree === 'string' && b.worktree.trim() ? git.addWorktree(p, b.worktree.trim()) : null
  const t = store.createThread(p, { title: b.text || 'New conversation', agent, worktree, inbox: b.inbox === true })
  if (b.agent && ctx.auth.origin === 'local') store.updateProject(p.id, { agent })
  emit({ type: 'thread', projectId: p.id, threadId: t.id })
  agents.send(p, t.id, inputFrom(b, ctx, p, t.id))
  return t
})
// The same prompt to several agents, each in a new worktree of its own, to compare what they make of it.
route('POST', '/projects/:pid/fanout', (params, b, ctx) => {
  const p = project(params)
  if (!Array.isArray(b.agents) || b.agents.length < 2) throw new BadRequest('Pick at least two agents to compare.')
  const configs = b.agents.map((a: Partial<store.AgentConfig>) => agentFrom(ctx, p.agent, a))
  const fanout = { id: store.newId(), base: git.git(p.path, 'rev-parse', 'HEAD') }
  return fanoutBranches(String(b.text ?? ''), configs).map((name, i) => {
    let branch = name
    for (let n = 2; git.branchExists(p, branch); n++) branch = `${name}-${n}`
    const t = store.createThread(p, { title: b.text || 'New conversation', agent: configs[i], worktree: git.addWorktree(p, branch), fanout })
    emit({ type: 'thread', projectId: p.id, threadId: t.id })
    agents.send(p, t.id, inputFrom(b, ctx, p, t.id))
    return t
  })
})
// Each conversation of a fan-out with its answer and what its worktree changed.
route('GET', '/projects/:pid/fanout/:id', (params) => {
  const p = project(params)
  const threads = store.listThreads(p).filter((t) => t.fanout?.id === params.id)
  if (!threads.length) throw new store.NotFound('comparison')
  const worktrees = git.listWorktrees(p)
  return threads
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((t) => {
      const worktree = worktrees.find((w) => w.path === t.worktree?.path) ?? null
      const conclusion = store.readMessages(p, t.id).filter((m) => m.kind === 'conclusion').at(-1)
      return {
        thread: { ...t, busy: agents.isBusy(t.id), waiting: agents.waiting(p, t) },
        worktree,
        changes: worktree ? git.changes(worktree.path, t.fanout!.base).map(({ patch, ...c }) => c) : [],
        merged: !!worktree && git.isMerged(p, worktree.branch, t.fanout!.base),
        answer: conclusion?.text ?? null,
        workTiming: conclusion?.workTiming ?? null,
      }
    })
})
// Seen on one device means seen everywhere: the pushes about it go away on the others.
function markRead(p: store.Project, tid: string) {
  const t = store.getThread(p, tid)
  push.seen(tid)
  if (!t.unread) return t
  const read = store.updateThread(p, tid, { unread: false })
  emit({ type: 'thread', projectId: p.id, threadId: tid })
  return read
}

route('GET', '/projects/:pid/threads/:tid', (params, _, ctx) => {
  const p = project(params)
  const thread = ctx.query.has('hidden') ? store.getThread(p, params.tid) : markRead(p, params.tid)
  return {
    thread,
    busy: agents.isBusy(thread.id),
    waiting: agents.waiting(p, thread),
    background: agents.runsBackground(thread.id),
    startedAt: agents.startedAt(thread.id),
    messages: store.readMessages(p, thread.id),
    decisions: store.listDecisions(p, thread.id),
    processes: store.listProcs(p).filter((pr) => pr.threadId === thread.id),
  }
})
route('GET', '/projects/:pid/threads/:tid/activity', (params) => store.readActivity(project(params), params.tid))
route('GET', '/projects/:pid/threads/:tid/plans', (params) => agents.plansOf(project(params), params.tid))
route('POST', '/projects/:pid/threads/:tid/plans/agents/:aid/stop', (params) => {
  project(params)
  agents.stopTask(params.tid, params.aid)
  return {}
})
route('GET', '/projects/:pid/threads/:tid/links', (params) => {
  const p = project(params)
  const t = store.getThread(p, params.tid)
  const projects = store.listProjects()
  const sourceProject = projects.find((p) => p.id === t.routedFrom?.projectId)
  const sourceThread = sourceProject && store.listThreads(sourceProject).find((s) => s.id === t.routedFrom?.threadId)
  const link = (p: store.Project, t: store.Thread) => ({ project: { id: p.id, name: p.name, tint: p.tint }, thread: listed(p, t) })
  return {
    source: sourceProject && sourceThread ? link(sourceProject, sourceThread) : null,
    targets: projects.flatMap((target) => store.listThreads(target).filter((s) => s.routedFrom?.projectId === p.id && s.routedFrom.threadId === t.id).map((s) => link(target, s))),
  }
})
route('PATCH', '/projects/:pid/threads/:tid', (params, b, ctx) => {
  const p = project(params)
  const patch: Partial<store.Thread> = {}
  if (typeof b.completed === 'boolean') patch.completed = b.completed
  if (b.unread === true) patch.unread = true
  if (b.unread === false) markRead(p, params.tid)
  if (typeof b.title === 'string') patch.title = b.title
  if (typeof b.label === 'string') patch.label = b.label ? { name: b.label, hue: store.hueFor(b.label) } : null
  if (b.agent) {
    const current = store.getThread(p, params.tid).agent
    const agent = agentFrom(ctx, current, b.agent)
    patch.agent = agent
    // The user's choice: Savor no longer goes back to the agent it had before a usage limit.
    patch.preferred = null
    // Another model has another context window, and another agent starts with an empty one.
    if (agent.provider !== current.provider || agent.model !== current.model) patch.context = null
    if (ctx.auth.origin === 'local') store.updateProject(p.id, { agent })
  }
  let t = store.updateThread(p, params.tid, patch)
  emit({ type: 'thread', projectId: p.id, threadId: t.id })
  if (patch.completed) {
    agents.tidyWorktree(p, t.worktree?.path)
    t = store.getThread(p, t.id)
  }
  return t
})
// A fork continues from where the conversation stands, in a conversation of its own.
route('POST', '/projects/:pid/threads/:tid/fork', (params) => {
  const p = project(params)
  const parent = store.getThread(p, params.tid)
  if (agents.isBusy(parent.id)) throw new BadRequest('The agent is still working. Fork the conversation when it has finished.')
  const provider = parent.agent.provider
  const sessionId = (['claude', 'codex', 'opencode'].includes(provider) && parent.agentSessions.find((s) => s.provider === provider)?.sessionId) || null
  const fork = { provider, sessionId, messages: store.readMessages(p, parent.id).length }
  const t = store.createThread(p, { title: `Fork of ${parent.title}`, agent: parent.agent, parentId: parent.id, fork, worktree: parent.worktree })
  emit({ type: 'thread', projectId: p.id, threadId: t.id })
  return t
})
route('DELETE', '/projects/:pid/threads/:tid', (params) => {
  const p = project(params)
  const threads = store.listThreads(p)
  const thread = threads.find((t) => t.id === params.tid)
  // The agent's own transcripts go too, unless another conversation still resumes or forks from them.
  const shared = new Set(threads.filter((t) => t !== thread).flatMap((t) => [...t.agentSessions.map((s) => s.sessionId), t.fork?.sessionId]))
  agents.forget(params.tid)
  fs.rmSync(path.join(p.path, '.savor', 'threads', path.basename(params.tid)), { recursive: true, force: true })
  deleteSessions(thread?.agentSessions.filter((s) => !shared.has(s.sessionId)) ?? [])
  emit({ type: 'thread', projectId: p.id, threadId: params.tid })
  return {}
})
route('POST', '/projects/:pid/threads/:tid/messages', (params, b, ctx) => {
  const p = project(params)
  return agents.send(p, store.getThread(p, params.tid).id, inputFrom(b, ctx, p, params.tid))
})
route('GET', '/projects/:pid/threads/:tid/review', (params) => {
  const p = project(params)
  return store.readReview(p, store.getThread(p, params.tid).id)
})
route('PUT', '/projects/:pid/threads/:tid/review', (params, b) => {
  const p = project(params)
  if (!Array.isArray(b.comments)) throw new BadRequest('Send the comments as a list.')
  store.saveReview(p, store.getThread(p, params.tid).id, b.comments)
  emit({ type: 'review', projectId: p.id, threadId: params.tid })
  return b.comments
})
route('POST', '/projects/:pid/threads/:tid/send-now', (params) => {
  agents.sendNow(project(params), params.tid)
  return {}
})
route('POST', '/projects/:pid/threads/:tid/messages/:mid/steer', async (params) => ({ steered: await agents.steer(project(params), params.tid, params.mid) }))
route('DELETE', '/projects/:pid/threads/:tid/messages/:mid', (params) => {
  agents.removeQueued(project(params), params.tid, params.mid)
  return {}
})
route('POST', '/projects/:pid/threads/:tid/stop', (params) => {
  agents.stopAgent(project(params), params.tid)
  return {}
})
route('POST', '/projects/:pid/threads/:tid/approvals/:mid', (params, b) => {
  const p = project(params)
  const approval = store.readMessages(p, params.tid).find((m) => m.id === params.mid)?.approval
  if (!approval || approval.status !== 'pending') throw new store.NotFound(`approval ${params.mid}`)
  const option = approval.options.find((o) => o.id === b.choice)
  if (!option) throw new BadRequest('Choose one of the offered options.')
  let content
  try {
    if (approval.fields && option.kind === 'allow') content = formContent(approval.fields, b.content)
  } catch (e) {
    throw new BadRequest((e as Error).message)
  }
  agents.resolveApproval(p, params.tid, params.mid, b.choice, content)
  markRead(p, params.tid)
  return {}
})
route('POST', '/projects/:pid/threads/:tid/decisions', (params, b, ctx) => {
  const p = project(params)
  agents.answerDecisions(p, params.tid, b.answers ?? [], inputFrom({ text: b.comment, attachments: b.attachments }, ctx, p, params.tid))
  markRead(p, params.tid)
  return {}
})
// An answer from a notification or the inbox reaches the agent only after HOLD_MS, so it can still be taken back.
const HOLD_MS = 10_000
const held = new Map<string, NodeJS.Timeout>()
route('POST', '/projects/:pid/threads/:tid/held', (params, b, ctx) => {
  const p = project(params)
  const tid = params.tid
  let apply: () => void
  if (typeof b.approval === 'string') {
    const approval = store.readMessages(p, tid).find((m) => m.id === b.approval)?.approval
    if (!approval || approval.status !== 'pending' || approval.fields) throw new BadRequest('This approval is no longer open.')
    if (!approval.options.some((o) => o.id === b.choice)) throw new BadRequest('Choose one of the offered options.')
    apply = () => agents.resolveApproval(p, tid, b.approval, b.choice)
  } else {
    const d = store.listDecisions(p, tid).find((d) => d.id === b.decision && !d.resolved)
    if (!d) throw new BadRequest('This question was already answered.')
    if (!Number.isInteger(b.selected) || !d.options[b.selected]) throw new BadRequest('Choose one of the offered options.')
    const input = inputFrom({ text: '' }, ctx, p, tid)
    apply = () => agents.answerDecisions(p, tid, [{ id: d.id, selected: b.selected }], input)
  }
  markRead(p, tid)
  const id = store.newId()
  held.set(
    id,
    setTimeout(() => {
      held.delete(id)
      // Answered in the conversation meanwhile.
      try {
        apply()
      } catch {}
    }, HOLD_MS),
  )
  return { id, ms: HOLD_MS }
})
route('DELETE', '/held/:id', (params) => {
  clearTimeout(held.get(params.id))
  if (!held.delete(params.id)) throw new BadRequest('The answer already went to the agent.')
  return {}
})
// Several conversations marked read or unread at once, from the inbox.
route('POST', '/threads/read', (_, b) => {
  if (!Array.isArray(b.threads) || typeof b.unread !== 'boolean') throw new BadRequest('Name the conversations and whether they are unread.')
  for (const { projectId, threadId } of b.threads) {
    const p = store.listProjects().find((p) => p.id === projectId)
    if (!p || !store.listThreads(p).some((t) => t.id === threadId)) continue
    if (b.unread) {
      store.updateThread(p, threadId, { unread: true })
      emit({ type: 'thread', projectId: p.id, threadId })
    } else markRead(p, threadId)
  }
  return {}
})
route('GET', '/projects/:pid/threads/:tid/attachments/:name', (params, _, ctx) => {
  const name = path.basename(params.name)
  const file = path.join(store.attachmentDir(project(params), params.tid), name)
  if (!fs.existsSync(file)) throw new store.NotFound('attachment')
  // Only images are shown inline; everything else downloads, so an attached HTML file can't run as this origin.
  const image = store.isImage(name)
  ctx.res.writeHead(200, {
    'content-type': image ? MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' : 'application/octet-stream',
    'content-disposition': `${image ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name.replace(/^[0-9a-f]{16}-/, ''))}"`,
    'cache-control': 'max-age=31536000',
  })
  fs.createReadStream(file).pipe(ctx.res)
})

// ---- preview ----

route('GET', '/projects/:pid/threads/:tid/browser/stream', async (params, _, ctx) => {
  // After a daemon restart, reopen the thread's last preview on demand.
  const { preview } = store.getThread(project(params), params.tid)
  if (!browser.has(params.tid) && preview) await browser.open(params.pid, params.tid, preview).catch(() => {})
  return browser.watch(params.tid, ctx.res)
})
// The page as it is now, for a small picture of it.
route('GET', '/projects/:pid/threads/:tid/browser/frame', async (params, _, ctx) => {
  const { preview } = store.getThread(project(params), params.tid)
  if (!browser.has(params.tid) && preview) await browser.open(params.pid, params.tid, preview).catch(() => {})
  if (!browser.has(params.tid)) throw new store.NotFound('preview')
  ctx.res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
  ctx.res.end(Buffer.from(await browser.frame(params.tid), 'base64'))
})
route('POST', '/projects/:pid/threads/:tid/browser/open', async (params, b) => {
  if (!/^https?:\/\//.test(String(b.url ?? ''))) throw new BadRequest('Enter a full URL starting with http:// or https://.')
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
route('POST', '/projects/:pid/threads/:tid/browser/copy', async (params, b) => ({ text: await browser.copy(params.tid, !!b.cut) }))
route('POST', '/projects/:pid/threads/:tid/browser/viewport', async (params, b) => {
  await browser.resize(params.tid, b.width, b.height)
  return {}
})
route('POST', '/projects/:pid/threads/:tid/browser/hover', async (params, b) => ({ cursor: await browser.hover(params.tid, b.x, b.y) }))
route('POST', '/projects/:pid/threads/:tid/browser/pick', (params, b) => browser.pick(params.tid, b.x, b.y))

// ---- git ----

// Git routes take `thread` to work in that conversation's worktree instead of the project folder.
const cwdFor = (p: store.Project, thread: string | null | undefined) => (thread ? store.cwdOf(p, store.getThread(p, thread)) : p.path)

route('GET', '/projects/:pid/git', (params, _, ctx) => git.branches(cwdFor(project(params), ctx.query.get('thread'))))
route('POST', '/projects/:pid/git/switch', (params, b) => {
  git.git(cwdFor(project(params), b.thread), 'switch', String(b.branch))
  return {}
})
route('GET', '/projects/:pid/git/commits/:hash', (params, _, ctx) => git.showCommit(cwdFor(project(params), ctx.query.get('thread')), params.hash))
// Uncommitted changes, or with `against=base` everything a conversation's worktree changed since it branched off.
route('GET', '/projects/:pid/git/changes', (params, _, ctx) => {
  const p = project(params)
  const cwd = cwdFor(p, ctx.query.get('thread'))
  return git.changes(cwd, ctx.query.get('against') === 'base' ? git.baseOf(p, cwd) : 'HEAD')
})
route('GET', '/projects/:pid/worktrees', (params) => git.listWorktrees(project(params)))
route('POST', '/projects/:pid/worktrees/merge', (params, b) => {
  const p = project(params)
  const wt = git.listWorktrees(p).find((w) => w.path === b.path)
  if (!wt) throw new store.NotFound('worktree')
  git.mergeWorktree(p, wt.branch)
  emit({ type: 'thread', projectId: p.id })
  agents.tidyWorktree(p, wt.path)
  return git.branches(p.path)
})
route('DELETE', '/projects/:pid/worktrees', (params, _, ctx) => {
  localOnly(ctx)
  const p = project(params)
  const wt = git.listWorktrees(p).find((w) => w.path === ctx.query.get('path'))
  if (!wt) throw new store.NotFound('worktree')
  agents.removeWorktree(p, wt)
  return {}
})

// ---- terminal ----

// The terminal is a shell on this computer. A paired device only gets it once it was switched on for
// that device here.
const terminalAllowed = (ctx: Ctx) => {
  if (ctx.auth.origin !== 'local' && !ctx.auth.device?.terminal)
    throw new Forbidden('The terminal is off for this device. Turn it on at your computer under Devices & remote access.')
}
// Where a terminal can run: the project folder and its worktrees, each with the conversations in it.
function terminalPlaces(p: store.Project) {
  const threads = store.listThreads(p)
  return [{ path: p.path, branch: null as string | null }, ...git.listWorktrees(p).map((w) => ({ path: w.path, branch: w.branch }))].map((place) => ({
    ...place,
    threads: place.branch ? threads.filter((t) => t.worktree?.path === place.path).map((t) => t.id) : [],
  }))
}
function terminalOf(params: Params, id: unknown) {
  const p = project(params)
  const t = terminal.get(p.id, id)
  if (!t || !terminalPlaces(p).some((place) => place.path === t.cwd)) throw new store.NotFound('terminal')
  return t
}
route('GET', '/projects/:pid/terminal', (params, _, ctx) => {
  terminalAllowed(ctx)
  const p = project(params)
  const places = terminalPlaces(p)
  return { places, terminals: terminal.list(p.id, places.map((place) => place.path)) }
})
route('POST', '/projects/:pid/terminal', (params, b, ctx) => {
  terminalAllowed(ctx)
  const p = project(params)
  if (!terminalPlaces(p).some((place) => place.path === b.path)) throw new store.NotFound('terminal folder')
  return terminal.add(p.id, b.path)
})
// A side question (/btw) is answered by a copy of the agent session, also while the agent works. Neither
// the question nor the answer becomes part of the conversation.
route('POST', '/projects/:pid/threads/:tid/btw', async (params, b) => {
  const p = project(params)
  const t = store.getThread(p, params.tid)
  const question = String(b.text ?? '').trim()
  if (!question) throw new BadRequest('Write the question after /btw.')
  const { provider, model } = t.agent
  const sid = t.agentSessions.find((s) => s.provider === provider)?.sessionId
  const prompt = `The user asks a quick side question while you work on this conversation. Answer it briefly from what you already know. Don't use tools; this answer does not become part of the conversation.\n\nQuestion: ${question}`
  if (provider === 'claude') return { text: await claudeAside(store.cwdOf(p, t), sid, model, prompt) }
  if (provider === 'codex') return { text: await codexAside(store.cwdOf(p, t), sid, model, prompt) }
  if (provider === 'antigravity') {
    const history = store
      .readMessages(p, t.id)
      .filter((m) => m.text && m.kind !== 'error')
      .slice(-30)
      .map((m) => `[${m.kind === 'user' ? 'user' : 'agent'}] ${m.text!.slice(0, 2000)}`)
    return { text: await antigravityAside(store.cwdOf(p, t), model, history.length ? `The conversation so far:\n${history.join('\n\n')}\n\n` : '', prompt) }
  }
  return { text: await acpAside(provider, store.cwdOf(p, t), sid, model, prompt) }
})
// A conversation continues in the agent's own terminal UI, resuming its session there. Savor's process
// for it goes first, so the two don't write to one session; the next input here resumes what happened there.
route('POST', '/projects/:pid/threads/:tid/terminal', (params, _, ctx) => {
  terminalAllowed(ctx)
  const p = project(params)
  const t = store.getThread(p, params.tid)
  const provider = t.agent.provider
  const sid = t.agentSessions.find((s) => s.provider === provider)?.sessionId
  const resume = { claude: `${BIN.claude} --resume`, codex: `${BIN.codex} resume`, opencode: `${BIN.opencode} --session`, grok: `${BIN.grok} --resume`, antigravity: `${BIN.antigravity} --conversation` }[provider as string]
  if (!sid || !resume) throw new BadRequest('Only a Claude Code, Codex, OpenCode, Grok Build or Antigravity conversation that has started can continue in the terminal.')
  if (agents.isBusy(t.id)) throw new BadRequest('The agent is still working. Open it in the terminal when it has finished.')
  agents.stopAgent(p, t.id)
  return terminal.add(p.id, store.cwdOf(p, t), `${resume} ${sid}`)
})
route('DELETE', '/projects/:pid/terminal/:tid', (params, _, ctx) => {
  terminalAllowed(ctx)
  terminal.close(terminalOf(params, params.tid))
  return {}
})
route('GET', '/projects/:pid/terminal/stream', (params, _, ctx) => {
  terminalAllowed(ctx)
  terminal.watch(terminalOf(params, ctx.query.get('id')), ctx.res, ctx.auth.device?.id)
})
route('POST', '/projects/:pid/terminal/open', async (params, b, ctx) => {
  terminalAllowed(ctx)
  await terminal.start(terminalOf(params, b.id), b.cols, b.rows)
  return {}
})
route('POST', '/projects/:pid/terminal/restart', async (params, b, ctx) => {
  terminalAllowed(ctx)
  const t = terminalOf(params, b.id)
  terminal.stop(t)
  await terminal.start(t, b.cols, b.rows)
  return {}
})
route('POST', '/projects/:pid/terminal/input', (params, b, ctx) => {
  terminalAllowed(ctx)
  terminal.input(terminalOf(params, b.id), String(b.data ?? ''))
  return {}
})
route('POST', '/projects/:pid/terminal/resize', (params, b, ctx) => {
  terminalAllowed(ctx)
  terminal.resize(terminalOf(params, b.id), b.cols, b.rows)
  return {}
})

// ---- files & documents ----

route('GET', '/projects/:pid/files', (params, _, ctx) => files.list(project(params), ctx.query.get('path') ?? ''))
route('GET', '/projects/:pid/files/search', (params, _, ctx) => files.search(project(params), ctx.query.get('q') ?? ''))
route('GET', '/projects/:pid/skills', (params, _, ctx) => listSkills(ctx.query.get('provider') ?? '', project(params).path))
route('GET', '/projects/:pid/file', (params, _, ctx) => files.read(project(params), ctx.query.get('path') ?? ''))
route('PUT', '/projects/:pid/file', (params, b, ctx) => {
  const p = project(params)
  // Savor's own records change only through their routes, which check who is asking.
  if (files.internal(p, b.path)) throw new Forbidden("Savor's own files (.savor/) can't be edited here.")
  // Git's config and the agents' settings run commands without asking, so a paired device changes them
  // only where it may use the terminal too.
  if (ctx.auth.origin !== 'local' && !ctx.auth.device?.terminal && files.runs(p, b.path))
    throw new Forbidden("Git's and the agents' settings run commands on your computer. Allow the terminal for this device at your computer to edit them from here.")
  files.write(p, b.path, b.content)
  return {}
})

// ---- workspaces of the project types ----

const asBadRequest = async <T>(fn: () => T | Promise<T>) => {
  try {
    return await fn()
  } catch (e) {
    throw new BadRequest((e as Error).message)
  }
}
route('GET', '/projects/:pid/export', (params) => workspace.exportState(project(params)))
route('PATCH', '/projects/:pid/export', async (params, b) => {
  await asBadRequest(() => workspace.setExport(project(params), b))
  return workspace.exportState(project(params))
})
// pandoc.yaml can name filters and engines that run as programs, so a paired device exports only
// where it may use the terminal too.
route('POST', '/projects/:pid/export', (params, _, ctx) => {
  if (ctx.auth.origin !== 'local' && !ctx.auth.device?.terminal)
    throw new Forbidden('Exporting runs pandoc on your computer. Allow the terminal for this device at your computer to export from here.')
  return asBadRequest(() => workspace.runExport(project(params)))
})
route('GET', '/projects/:pid/export/:name', (params, _, ctx) => {
  const file = workspace.exportFile(project(params), params.name)
  ctx.res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${encodeURIComponent(path.basename(file))}"` })
  fs.createReadStream(file).pipe(ctx.res)
})
// The answers of the new-project form become the type's folders and files.
route('POST', '/projects/:pid/setup', async (params, b) => {
  const p = project(params)
  if (b.type === 'academic-writing') await asBadRequest(() => workspace.setUpAcademic(p, b.answers))
  else if (b.type === 'kontor') await asBadRequest(() => workspace.setUpKontor(p, b.answers))
  else throw new BadRequest(`Unknown project type ${b.type}`)
  return {}
})
route('GET', '/projects/:pid/today', (params) => workspace.today(project(params)))
route('PATCH', '/projects/:pid/today/tasks', (params, b) => asBadRequest(() => workspace.setTask(project(params), Number(b.line), String(b.raw), !!b.done)))
route('POST', '/projects/:pid/today/tasks', (params, b) => {
  if (!String(b.text ?? '').trim()) throw new BadRequest('A task needs a text.')
  workspace.addTask(project(params), String(b.text))
  return workspace.today(project(params))
})

// ---- import of existing agent sessions ----

route('GET', '/projects/:pid/import', (params, _, ctx) => (localOnly(ctx), listSessions(project(params))))
route('POST', '/projects/:pid/import', (params, b, ctx) => {
  localOnly(ctx)
  const p = project(params)
  const threads = importSessions(p, (b.sessions ?? []).filter((s: any) => ['claude', 'codex'].includes(s?.provider) && typeof s.id === 'string'))
  emit({ type: 'thread', projectId: p.id })
  return threads
})

route('GET', '/projects/:pid/docs', (params) => store.listDocs(project(params)))
route('GET', '/projects/:pid/docs/:id', (params) => store.getDoc(project(params), params.id))
route('POST', '/projects/:pid/docs', (params, b, ctx) => {
  const doc = store.saveDoc(project(params), { title: b.title, content: b.content ?? '' }, { origin: ctx.auth.origin })
  emit({ type: 'documents', projectId: params.pid })
  return doc
})
route('PUT', '/projects/:pid/docs/:id', (params, b, ctx) => {
  const doc = store.saveDoc(project(params), { id: params.id, title: b.title, content: b.content }, { origin: ctx.auth.origin })
  emit({ type: 'documents', projectId: params.pid })
  return doc
})
route('DELETE', '/projects/:pid/docs/:id', (params) => {
  store.deleteDoc(project(params), params.id)
  emit({ type: 'documents', projectId: params.pid })
  return {}
})

// ---- workflows ----

const saveWorkflowRoute = (params: Params, b: any, ctx: Ctx, id?: string) => {
  try {
    if (b.cron) validateCron(b.cron, b.timezone)
  } catch (e) {
    throw new BadRequest(`Invalid schedule: ${(e as Error).message}`)
  }
  const { name, prompt, collection, cron, timezone, scheduleLabel, enabled, catchUp, button, onModelChange, next, budgetUsd, monthlyBudgetUsd } = b
  const check = preflightSchema.optional().safeParse(b.preflight)
  if (!check.success) throw new BadRequest('Invalid workflow preflight configuration.')
  for (const usd of [budgetUsd, monthlyBudgetUsd]) if (usd != null && !(typeof usd === 'number' && usd > 0 && usd < Infinity)) throw new BadRequest('A budget is an amount in USD above 0, or none.')
  const fields = Object.fromEntries(Object.entries({ name, prompt, collection, cron, timezone, scheduleLabel, enabled, catchUp, button, onModelChange, next, budgetUsd, monthlyBudgetUsd, preflight: check.data }).filter(([, v]) => v !== undefined))
  const wf = store.saveWorkflow(project(params), { ...(fields as { name: string; prompt: string }), ...(id && { id }) }, ctx.auth.origin)
  syncSchedules()
  emit({ type: 'workflows', projectId: params.pid })
  return wf
}
// The list shows the latest run that started; a time skipped since then is in the workflow's runs.
// A workflow an agent saved names the conversation it came from while that still exists.
const listWorkflows = (p: store.Project, threads = store.listThreads(p)) =>
  store.listWorkflows(p).map((wf) => {
    const from = threads.find((t) => t.id === wf.threadId)
    return { ...wf, nextRunAt: nextRun(wf), lastRun: runs(p, { ...wf, skipped: [] }, threads, 1)[0] ?? null, month: month(p, wf, threads), thread: from ? { id: from.id, title: from.summary ?? from.title } : null }
  })
route('GET', '/projects/:pid/workflows', (params) => listWorkflows(project(params)))
route('GET', '/projects/:pid/workflows/:id/runs', (params) => runs(project(params), store.getWorkflow(project(params), params.id)))
route('POST', '/projects/:pid/workflows', (params, b, ctx) => saveWorkflowRoute(params, b, ctx))
route('PUT', '/projects/:pid/workflows/:id', (params, b, ctx) => saveWorkflowRoute(params, b, ctx, params.id))
route('DELETE', '/projects/:pid/workflows/:id', (params) => {
  store.deleteWorkflow(project(params), params.id)
  syncSchedules()
  emit({ type: 'workflows', projectId: params.pid })
  return {}
})
route('POST', '/projects/:pid/workflows/:id/run', (params, b, ctx) => (b?.early ? runEarly : runWorkflow)(params.pid, params.id, ctx.auth.origin))
// The workflows of all projects that have a button in the top bar.
route('GET', '/workflows/buttons', () =>
  store.listProjects().flatMap((p) => store.listWorkflows(p).filter((wf) => wf.button).map((wf) => ({ id: wf.id, name: wf.name, projectId: p.id, nextRunAt: nextRun(wf) }))),
)

// ---- all projects ----

// A pending approval and the open questions, so the overview can answer them in place.
function asks(p: store.Project, t: store.Thread) {
  const pending = store.readMessages(p, t.id).filter((m) => m.approval?.status === 'pending').at(-1)
  // A form is filled in in the conversation.
  return { approval: pending && !pending.approval!.fields ? { messageId: pending.id, options: pending.approval!.options } : null, decisions: store.listDecisions(p, t.id).filter((d) => !d.resolved) }
}

// Every project's conversations and workflows in one list, each with the project it belongs to.
route('GET', '/overview', () => {
  const threads = [], workflows = []
  for (const p of store.listProjects()) {
    const list = store.listThreads(p)
    threads.push(...list.map((t) => ({ ...listed(p, t), ...(t.needsYou && asks(p, t)), projectId: p.id })))
    workflows.push(...listWorkflows(p, list).map((wf) => ({ ...wf, projectId: p.id })))
  }
  return { threads, workflows }
})

// ---- backlog ----

route('GET', '/backlog', () => ({ items: store.listProjects().flatMap((p) => store.readBacklog(p).items.map((i) => ({ ...i, projectId: p.id }))) }))
route('POST', '/projects/:pid/backlog', (params, b, ctx) => {
  const p = project(params)
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!title) throw new BadRequest('Describe what to do.')
  const item = store.addBacklogItem(p, title, { origin: ctx.auth.origin })
  emit({ type: 'backlog', projectId: p.id })
  return item
})
route('DELETE', '/projects/:pid/backlog/:id', (params) => {
  const p = project(params)
  store.removeBacklogItem(p, params.id)
  emit({ type: 'backlog', projectId: p.id })
  return {}
})

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
  const file = path.resolve(proc.cwd, proc.log)
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

function serveStatic(url: URL, res: ServerResponse, nonce: string) {
  const file = path.join(WEB, path.normalize(url.pathname))
  const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(WEB, 'index.html')
  if (!fs.existsSync(target)) return res.writeHead(500).end('Web UI not built. Run `npm run build`.')
  res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' })
  if (target.endsWith('index.html')) return res.end(withNonce(fs.readFileSync(target, 'utf8'), nonce))
  fs.createReadStream(target).pipe(res)
}

// Open responses per device, so revoking a device also ends its live streams.
const deviceResponses = new Map<string, Set<ServerResponse>>()

function track(deviceId: string, res: ServerResponse) {
  const open = deviceResponses.get(deviceId) ?? new Set()
  deviceResponses.set(deviceId, open)
  open.add(res)
  res.on('close', () => open.delete(res))
}

function disconnectDevice(deviceId: string) {
  for (const res of deviceResponses.get(deviceId) ?? []) res.destroy()
  deviceResponses.delete(deviceId)
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x')
  const nonce = newNonce()
  for (const [k, v] of Object.entries(securityHeaders(req.headers.host, nonce))) res.setHeader(k, v)

  if (url.pathname === '/mcp') {
    if (!store.safeEqual(req.headers.authorization?.match(/^Bearer (.+)$/)?.[1], store.state().mcpToken)) return res.writeHead(401).end()
    return handleMcp(req, res, url, req.method === 'POST' ? await readBody(req) : undefined)
  }

  if (url.searchParams.has('token') && store.safeEqual(url.searchParams.get('token'), store.state().token)) {
    res.writeHead(302, { 'set-cookie': `savor_token=${store.state().token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, location: '/' })
    return res.end()
  }

  // Changes must be JSON: browsers send that cross-origin only after a CORS preflight, which this server
  // never allows, so pages on other ports of this host (the same site for cookies) can't use the login.
  if (url.pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method!) && !req.headers['content-type']?.startsWith('application/json'))
    return json(res, 415, { error: 'Send changes as application/json.' })

  if (url.pathname === '/api/pair' && req.method === 'POST') {
    const b = await readBody(req)
    const name = String(b.name ?? '')
    // The device makes up the check number it shows; this computer shows the same one when asking.
    if (!/^\d{6}$/.test(String(b.check))) return json(res, 400, { error: 'Missing check number.' })
    let request: ReturnType<typeof devices.requestApproval>
    try {
      request = devices.requestApproval(String(b.code ?? ''), name, 'lan', String(b.check))
    } catch (e) {
      return json(res, 400, { error: (e as Error).message })
    }
    res.on('close', request.cancel)
    if (!(await request.approved)) return json(res, 403, { error: 'Pairing was not allowed on your computer.' })
    const token = devices.addTokenDevice(name)
    emit({ type: 'devices' })
    res.writeHead(200, { 'set-cookie': `savor_device=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, 'content-type': 'application/json' })
    return res.end('{}')
  }

  if (!url.pathname.startsWith('/api/')) return serveStatic(url, res, nonce)
  const auth = devices.authenticate(req)
  if (!auth) return json(res, 401, { error: 'unauthorized' })
  if (auth.device) track(auth.device.id, res)
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

// Run as a service from an AppImage (desktop/main.cjs --daemon): once an update has replaced the
// AppImage, restart so the service manager starts the new version. Working agents get five minutes to
// finish; after that their turns are cut off and continue in the new version. The UI counts down to
// the restart, and with automatic restarts switched off it only offers one.
const UPDATE_GRACE = 5 * 60_000
const RESTART_COUNTDOWN = 30_000
const restart = { updated: false, at: null as number | null, timer: undefined as NodeJS.Timeout | undefined }

function scheduleRestart() {
  clearTimeout(restart.timer)
  restart.at = store.state().autoRestart === false ? null : Date.now() + RESTART_COUNTDOWN
  if (restart.at) restart.timer = setTimeout(restartNow, RESTART_COUNTDOWN)
  emit({ type: 'restart' })
}

function restartNow() {
  console.log('Savor was updated, exiting so the new version starts')
  // The same way out as a stop of the service: agents and preview browsers are shut down first.
  process.kill(process.pid, 'SIGTERM')
}

function exitOnUpdate(file: string) {
  const id = (s?: fs.Stats) => s && `${s.ino}:${s.mtimeMs}:${s.size}`
  const installed = id(fs.statSync(file))
  let last = installed
  let updatedAt = 0
  const check = setInterval(() => {
    const now = id(fs.statSync(file, { throwIfNoEntry: false }))
    // Wait until the new file stays the same between two checks, in case it is still being written.
    const settled = now && now !== installed && now === last
    last = now
    if (!settled) return
    updatedAt ||= Date.now()
    if (agents.anyBusy() && Date.now() - updatedAt < UPDATE_GRACE) return
    clearInterval(check)
    restart.updated = true
    scheduleRestart()
  }, 10_000)
}

// `left` instead of a time of day, so a device whose clock is off still counts down correctly.
route('GET', '/restart', () => ({ updated: restart.updated, left: restart.at && Math.max(0, restart.at - Date.now()) }))
route('GET', '/health', () => listWarnings(restart.updated && !restart.at))
route('POST', '/restart', () => {
  if (!restart.updated) throw new BadRequest('No update is waiting for a restart.')
  restartNow()
})
// `service`: the daemon restarts itself after updates, so the setting for that applies.
// `usagePing`: null where nothing is sent anyway, see usage.ts.
const settings = () => ({
  autoUpdate: store.state().autoUpdate !== false,
  autoRestart: store.state().autoRestart !== false,
  service: !!process.env.SAVOR_EXIT_ON_UPDATE,
  usagePing: usageAvailable() ? store.state().usagePing !== false : null,
  pushDelay: push.delay(),
})
route('GET', '/settings', () => settings())
route('PATCH', '/settings', (_, b, ctx) => {
  localOnly(ctx)
  const s = store.state()
  if (typeof b.autoUpdate === 'boolean') s.autoUpdate = b.autoUpdate
  if (typeof b.autoRestart === 'boolean') s.autoRestart = b.autoRestart
  if (typeof b.usagePing === 'boolean') s.usagePing = b.usagePing
  if (Number.isInteger(b.pushDelay) && b.pushDelay >= 0 && b.pushDelay <= 60) s.pushDelay = b.pushDelay
  store.saveState(s)
  emit({ type: 'settings' })
  if (restart.updated && typeof b.autoRestart === 'boolean') scheduleRestart()
  return settings()
})

http
  .createServer((req, res) =>
    handle(req, res).catch((e) => {
      if (!(e instanceof store.NotFound || e instanceof Forbidden || e instanceof BadRequest || e instanceof git.GitError)) {
        console.error(e)
        captureException(e)
      }
      if (!res.headersSent) json(res, e instanceof store.NotFound ? 404 : e instanceof Forbidden ? 403 : e instanceof BadRequest || e instanceof git.GitError ? 400 : 500, { error: e.message })
      else res.end()
    }),
  )
  .listen(PORT, HOST, () => {
    // Conversations are private: kept out of git and readable only by this user, also in projects added before.
    for (const p of store.listProjects()) {
      git.keepOutOfGit(p.path)
      fs.chmodSync(store.dataDir(p), 0o700)
    }
    syncSchedules()
    processes.watchProcesses()
    startRelay()
    startUsagePing()
    ci.startCiMonitor()
    if (process.env.SAVOR_EXIT_ON_UPDATE) exitOnUpdate(process.env.SAVOR_EXIT_ON_UPDATE)
    agents.resumeInterrupted()
    console.log(`Savor running — open ${PUBLIC_URL}/?token=${store.state().token}`)
  })

// The browser module exits once its browsers are closed.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => agents.shutdown())
