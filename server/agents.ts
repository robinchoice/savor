// Turns, queues and sessions: one agent session per conversation, one turn at a time, input that
// arrives during a turn waits in the queue.
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import * as store from './store.js'
import type { AgentConfig, Message, Origin, Project, Provider, Question, Thread } from './store.js'
import { emit } from './events.js'
import { BIN, command, mcpUrl } from './config.js'
import { Activity, configKey, systemPrompt, type Answer, type ApprovalRequest, type Host, type Session, type TurnInput } from './session.js'
import { ClaudeSession } from './claude.js'
import { CodexSession } from './codex.js'
import { AcpSession } from './acp.js'
import * as push from './push.js'

const IDLE_CLOSE_MS = 5 * 60_000

// The current request of a thread is its latest user input plus what the agent already sent for it.
// MCP tools use it to allow one acknowledgement and one conclusion per input and idempotent updates.
export interface RequestState {
  inputId: string
  startedAt?: string
  ack?: { text: string; id: string }
  conclusion?: { key: string; id: string }
  updates: Map<string, { text: string; id: string }>
}

const requests = new Map<string, RequestState>()
const busy = new Map<string, string>() // threadId → turn start
const turnConclusion = new Map<string, string>()
const turnOrigin = new Map<string, Origin>()
const turnDevice = new Map<string, string | undefined>()
const sessions = new Map<string, { session: Session; idleTimer?: NodeJS.Timeout }>()
const stopped = new Set<string>() // threads whose last turn the user stopped: don't pump the queue
const approvals = new Map<string, (choice: string) => void>() // approval message id → resolver
const questions = new Map<string, (answers: Answer[]) => void>() // decision group id → resolver

export const isBusy = (tid: string) => busy.has(tid)
export const anyBusy = () => busy.size > 0
export const startedAt = (tid: string) => busy.get(tid)
// An agent that acknowledged and ended its turn without a conclusion waits for the background processes its conversation owns.
export function awaitsBackground(p: Project, tid: string) {
  const r = requests.get(tid)
  return !busy.has(tid) && !!r?.ack && !r.conclusion && store.listProcs(p).some((pr) => pr.threadId === tid)
}
export const markConcluded = (tid: string, messageId: string) => turnConclusion.set(tid, messageId)
export const originOf = (tid: string): Origin => turnOrigin.get(tid) ?? 'local'
export const deviceOf = (tid: string) => turnDevice.get(tid)

export function request(tid: string) {
  let r = requests.get(tid)
  if (!r) requests.set(tid, (r = { inputId: '', updates: new Map() }))
  return r
}

export function post(p: Project, tid: string, m: Omit<Message, 'id' | 'ts'>) {
  const msg = store.appendMessage(p, tid, { modelInfo: store.getThread(p, tid).agent, ...m })
  emit({ type: 'message', projectId: p.id, threadId: tid })
  return msg
}

// `status` is all a push carries: it passes through the browser's push service.
export function notify(p: Project, tid: string, body: string, status: string) {
  const t = store.getThread(p, tid)
  emit({ type: 'notify', projectId: p.id, threadId: tid, title: `${p.name} · ${t.label?.name ?? t.title}`.slice(0, 120), body: body.slice(0, 200) })
  push.send(p, tid, status)
}

// ---- input and the queue ----

export interface Input { text: string; images?: string[]; files?: string[]; origin: Origin; device?: string }

export function send(p: Project, tid: string, input: Input) {
  const thread = store.updateThread(p, tid, { completed: false })
  const queued = busy.has(tid)
  const msg = post(p, tid, { kind: 'user', text: input.text, images: input.images, files: input.files, modelInfo: thread.agent, origin: input.origin, device: input.device, delivered: !queued })
  stopped.delete(tid)
  if (!queued) deliver(p, tid, msg)
  else emit({ type: 'thread', projectId: p.id, threadId: tid })
  return msg
}

// "Send now": interrupt the running turn; the queue then delivers in order.
export function sendNow(p: Project, tid: string) {
  stopped.delete(tid)
  if (busy.has(tid)) current(tid)?.interrupt()
  else pump(p, tid)
}

export function removeQueued(p: Project, tid: string, mid: string) {
  const msg = store.readMessages(p, tid).find((m) => m.id === mid)
  if (!msg || msg.kind !== 'user' || msg.delivered !== false) throw new store.NotFound(`queued message ${mid}`)
  store.removeMessage(p, tid, mid)
  emit({ type: 'message', projectId: p.id, threadId: tid })
}

function deliver(p: Project, tid: string, msg: Message) {
  const thread = store.updateThread(p, tid, { needsYou: false })
  store.updateMessage(p, tid, msg.id, { delivered: true })
  requests.set(tid, { inputId: msg.id, startedAt: store.now(), updates: new Map() })
  turnOrigin.set(tid, msg.origin ?? 'local')
  turnDevice.set(tid, msg.device)
  const session = sessionFor(p, thread)
  beginTurn(p, tid)
  session.start(turnInput(p, thread, msg))
}

function pump(p: Project, tid: string) {
  if (busy.has(tid) || stopped.has(tid)) return
  const next = store.readMessages(p, tid).find((m) => m.kind === 'user' && m.delivered === false)
  if (next) deliver(p, tid, next)
}

export function stop(tid: string) {
  stopped.add(tid)
  current(tid)?.kill()
}

// The conversation was deleted: end its session, and nothing it still reports touches the removed records.
export function forget(tid: string) {
  const s = sessions.get(tid)
  sessions.delete(tid)
  clearTimeout(s?.idleTimer)
  s?.session.kill()
  for (const state of [busy, requests, turnConclusion, turnOrigin, turnDevice]) state.delete(tid)
  stopped.delete(tid)
}

const current = (tid: string) => sessions.get(tid)?.session

// Background work inside the agent's own process (shell commands, subagents). It ends with the process.
export const runsBackground = (tid: string) => !!current(tid)?.background?.()

// Between turns with a conclusion still owed: the agent waits for a process it registered or for
// background work of its own. A stop or a failure ends that.
export function waiting(p: Project, t: Thread) {
  const r = requests.get(t.id)
  return !t.error && (awaitsBackground(p, t.id) || (!busy.has(t.id) && !!r?.ack && !r.conclusion && runsBackground(t.id)))
}

// The user's Stop. A running turn ends with its process. Between turns the process goes right away,
// with what it runs in the background, so the next input starts a fresh one. An agent that waited
// there still owed a conclusion: that request ends the way a stopped turn does.
export function stopAgent(p: Project, tid: string) {
  if (busy.has(tid)) return stop(tid)
  const thread = store.getThread(p, tid)
  const waited = waiting(p, thread)
  const s = sessions.get(tid)
  sessions.delete(tid)
  clearTimeout(s?.idleTimer)
  s?.session.kill()
  stopped.add(tid)
  if (waited) {
    beginTurn(p, tid)
    endTurn(p, tid, { error: 'Turn stopped.' }, thread.agent)
  } else emit({ type: 'status', projectId: p.id, threadId: tid })
}

// Close idle sessions unless the conversation still has background work.
export function maybeClose(p: Project, tid: string) {
  const s = sessions.get(tid)
  if (!s || busy.has(tid)) return
  clearTimeout(s.idleTimer)
  const owns = store.listProcs(p).some((pr) => pr.threadId === tid)
  if (!owns && !runsBackground(tid)) s.idleTimer = setTimeout(() => s.session.end(), IDLE_CLOSE_MS)
}

function beginTurn(p: Project, tid: string) {
  if (busy.has(tid)) return
  busy.set(tid, store.now())
  turnConclusion.delete(tid)
  emit({ type: 'status', projectId: p.id, threadId: tid })
}

function endTurn(p: Project, tid: string, result: { text?: string; error?: string }, agent: AgentConfig) {
  const startedAt = busy.get(tid)
  if (!startedAt) return
  if (result.error) {
    store.updateThread(p, tid, { error: result.error })
    post(p, tid, { kind: 'error', text: result.error, modelInfo: agent })
    if (result.error !== 'Turn stopped.') notify(p, tid, result.error, 'Stopped with an error')
  } else {
    store.updateThread(p, tid, { error: null })
    // Fallback for agents that ignore the message protocol: surface their final text. An agent that
    // acknowledged and ended its turn without a conclusion is waiting for background work.
    const r = request(tid)
    if (!r.ack && !r.conclusion && !r.updates.size && result.text?.trim()) {
      const msg = post(p, tid, { kind: 'conclusion', text: result.text, modelInfo: agent })
      r.conclusion = { key: '', id: msg.id }
      markConcluded(tid, msg.id)
      store.updateThread(p, tid, { unread: true })
      notify(p, tid, result.text, 'Finished')
    }
  }
  const mid = turnConclusion.get(tid)
  // Work time counts from the input, including time spent waiting for background tasks.
  if (mid) store.updateMessage(p, tid, mid, { workTiming: { startedAt: request(tid).startedAt ?? startedAt, finishedAt: store.now() } })
  busy.delete(tid)
  emit({ type: 'status', projectId: p.id, threadId: tid })
  emit({ type: 'message', projectId: p.id, threadId: tid })
  maybeClose(p, tid)
  pump(p, tid)
}

// ---- prompts ----

// When the thread switches to an agent that has not seen it yet, hand over the visible history.
function handover(p: Project, thread: Thread) {
  if (thread.agentSessions.some((s) => s.provider === thread.agent.provider)) return ''
  const history = store
    .readMessages(p, thread.id)
    .slice(0, -1)
    .filter((m) => m.text && m.kind !== 'error')
    .slice(-30)
    .map((m) => `[${m.kind === 'user' ? 'user' : 'agent'}] ${m.text!.slice(0, 2000)}`)
  return history.length ? `Earlier in this conversation (handled by another agent):\n${history.join('\n\n')}\n\n` : ''
}

function turnInput(p: Project, thread: Thread, msg: Message): TurnInput {
  const dir = store.attachmentDir(p, thread.id)
  const context = {
    requestOrigin: msg.origin ?? 'local',
    threadLabel: thread.label?.name ?? null,
    productPreview: thread.preview,
    backgroundProcesses: store.listProcs(p).filter((pr) => pr.threadId === thread.id),
    decisions: store.listDecisions(p, thread.id).slice(-20),
    cwd: store.cwdOf(p, thread),
    worktree: thread.worktree?.branch ?? null,
  }
  const files = (msg.files ?? []).map((f) => path.join(dir, f))
  const attached = files.length ? `\n\nAttached files:\n${files.join('\n')}` : ''
  return { context: `${handover(p, thread)}Savor context:\n${JSON.stringify(context)}\n\nNew input:\n`, input: `${msg.text}${attached}`, images: (msg.images ?? []).map((f) => path.join(dir, f)) }
}

// ---- sessions ----

function sessionFor(p: Project, thread: Thread): Session {
  const tid = thread.id
  let s = sessions.get(tid)
  // New agent, model, effort or permission settings need a fresh process.
  if (s && s.session.config !== configKey(thread.agent)) {
    sessions.delete(tid)
    clearTimeout(s.idleTimer)
    s.session.end()
    s = undefined
  }
  if (s) {
    clearTimeout(s.idleTimer)
    return s.session
  }
  const holder: { session?: Session } = {}
  const host = hostFor(p, thread, holder)
  const provider = thread.agent.provider
  const session =
    provider === 'claude' ? new ClaudeSession(host, thread)
    : provider === 'codex' ? new CodexSession(host, thread)
    : provider === 'opencode' || provider === 'grok' ? new AcpSession(host, thread)
    : new CommandSession(host, thread)
  holder.session = session
  sessions.set(tid, { session })
  return session
}

// Events from a session that was already replaced (new settings) or closed are ignored.
function hostFor(p: Project, thread: Thread, holder: { session?: Session }): Host {
  const tid = thread.id
  const mine = () => !!holder.session && sessions.get(tid)?.session === holder.session
  return {
    p,
    tid,
    cwd: store.cwdOf(p, thread),
    activity: new Activity(p, tid, mine),
    working: () => mine() && beginTurn(p, tid),
    approve: (req) => askApproval(p, tid, req),
    ask: (qs) => askQuestions(p, tid, qs),
    backgroundChanged: () => {
      if (!mine()) return
      emit({ type: 'status', projectId: p.id, threadId: tid })
      maybeClose(p, tid)
    },
    ended: (result) => mine() && endTurn(p, tid, result, thread.agent),
    closed: (error) => {
      if (!mine()) return
      sessions.delete(tid)
      cancelPending(p, tid)
      if (busy.has(tid)) endTurn(p, tid, { error }, thread.agent)
    },
  }
}

// ---- approvals and clarifying questions ----

function askApproval(p: Project, tid: string, req: ApprovalRequest) {
  const msg = post(p, tid, { kind: 'approval', approval: { ...req, status: 'pending' } })
  store.updateThread(p, tid, { unread: true, needsYou: true })
  emit({ type: 'thread', projectId: p.id, threadId: tid })
  notify(p, tid, req.title, 'Needs your approval')
  return new Promise<string>((resolve) => approvals.set(msg.id, resolve))
}

export function resolveApproval(p: Project, tid: string, mid: string, choice: string) {
  const msg = store.readMessages(p, tid).find((m) => m.id === mid)
  const a = msg?.approval
  if (!a || a.status !== 'pending') throw new store.NotFound(`approval ${mid}`)
  store.updateMessage(p, tid, mid, { approval: { ...a, status: 'resolved', choice } })
  emit({ type: 'message', projectId: p.id, threadId: tid })
  approvals.get(mid)?.(choice)
  approvals.delete(mid)
  refreshNeedsYou(p, tid)
}

function askQuestions(p: Project, tid: string, qs: Question[]) {
  const msg = post(p, tid, { kind: 'question', modelInfo: store.getThread(p, tid).agent })
  const decisions = qs.map((q, i) => ({ id: `${msg.id}-q${i}`, groupId: msg.id, threadId: tid, ...q, selected: null, answer: null, resolved: false, createdAt: msg.ts }))
  decisions.forEach((d) => store.saveDecision(p, d))
  store.updateMessage(p, tid, msg.id, { decisionIds: decisions.map((d) => d.id) })
  store.updateThread(p, tid, { unread: true, needsYou: true })
  emit({ type: 'thread', projectId: p.id, threadId: tid })
  notify(p, tid, `Your turn: ${qs[0]?.title ?? ''}`, 'Has a question')
  return new Promise<Answer[]>((resolve) => questions.set(msg.id, resolve))
}

// Answers to a group of decisions: an agent waiting for them gets them directly, otherwise they
// go to the agent as the next input.
export function answerDecisions(p: Project, tid: string, answers: { id: string; selected?: number; answer?: string }[], origin: Origin, device?: string) {
  const all = store.listDecisions(p, tid)
  const lines: string[] = []
  const groups = new Set<string>()
  for (const a of answers) {
    const d = all.find((d) => d.id === a.id)
    if (!d || d.resolved) continue
    d.resolved = true
    d.selected = a.selected ?? null
    d.answer = a.selected == null ? a.answer ?? '' : null
    store.saveDecision(p, d)
    lines.push(`Decision: ${d.title}\n${d.selected != null ? `Selected: ${d.options[d.selected]}` : `Answer: ${d.answer}`}`)
    groups.add(d.groupId)
  }
  refreshNeedsYou(p, tid)
  let delivered = false
  for (const groupId of groups) {
    const waiting = questions.get(groupId)
    if (!waiting) continue
    questions.delete(groupId)
    waiting(all.filter((d) => d.groupId === groupId).map((d) => ({ selected: d.selected, answer: d.answer })))
    delivered = true
  }
  if (lines.length && !delivered) send(p, tid, { text: lines.join('\n\n'), origin, device })
}

// "Your turn" = open questions or pending approvals in the thread.
export function refreshNeedsYou(p: Project, tid: string) {
  const needsYou = store.listDecisions(p, tid).some((d) => !d.resolved) || store.readMessages(p, tid).some((m) => m.approval?.status === 'pending')
  store.updateThread(p, tid, { needsYou })
  emit({ type: 'thread', projectId: p.id, threadId: tid })
}

function cancelPending(p: Project, tid: string) {
  for (const m of store.readMessages(p, tid)) {
    if (m.approval?.status === 'pending' && approvals.has(m.id)) {
      store.updateMessage(p, tid, m.id, { approval: { ...m.approval, status: 'resolved', choice: m.approval.options.find((o) => o.kind === 'deny')?.id } })
      approvals.delete(m.id)
    }
    if (m.kind === 'question' && questions.has(m.id)) questions.delete(m.id)
  }
  refreshNeedsYou(p, tid)
}

// ---- agents without a stable headless protocol (Antigravity) ----

// They run a configurable command once per turn (state.json → providers.<name>.command, "{prompt}" is
// replaced), and their stdout becomes the conclusion. SAVOR_MCP_URL and the bearer token
// SAVOR_MCP_TOKEN point them at Savor's MCP server.
const DEFAULT_COMMANDS: Record<string, string[]> = { antigravity: [BIN.antigravity, '-p', '{prompt}'] }

class CommandSession implements Session {
  readonly config: string
  private child?: ChildProcess
  private provider: Provider

  constructor(private host: Host, thread: Thread) {
    this.config = configKey(thread.agent)
    this.provider = thread.agent.provider
  }

  start({ context, input }: TurnInput) {
    const { p, tid, activity } = this.host
    const [bin, ...args] = store.state().providers[this.provider]?.command ?? DEFAULT_COMMANDS[this.provider] ?? [BIN.antigravity, '-p', '{prompt}']
    const thread = store.getThread(p, tid)
    const first = !thread.agentSessions.length
    const full = first ? `${systemPrompt(p, thread)}\n\n${context}${input}` : context + input
    const out: string[] = []
    let stderr = ''
    activity.start('run', 'command', `${bin} (${this.provider})`)
    const child = spawn(...command(bin, args.map((a) => a.replace('{prompt}', full))), {
      cwd: this.host.cwd,
      env: { ...process.env, SAVOR_MCP_URL: mcpUrl(p.id, tid), SAVOR_MCP_TOKEN: store.state().mcpToken },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout!.on('data', (d) => out.push(String(d)))
    child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-4000)))
    child.on('error', (e) => this.host.ended({ error: e.message }))
    child.on('exit', (code, signal) => {
      activity.finish('run')
      this.child = undefined
      if (code === 0) this.host.ended({ text: out.join('') })
      else this.host.ended({ error: signal === 'SIGTERM' ? 'Turn stopped.' : `${bin} exited with ${code}: ${stderr.trim()}` })
    })
    if (first) store.updateThread(p, tid, { agentSessions: [{ provider: this.provider, sessionId: 'command' }] })
  }

  interrupt() {
    this.child?.kill('SIGTERM')
  }

  end() {
    this.child?.kill('SIGTERM')
    sessions.delete(this.host.tid)
  }

  kill() {
    this.end()
  }
}
