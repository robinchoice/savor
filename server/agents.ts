// Turns, queues and sessions: one agent session per conversation, one turn at a time, input that
// arrives during a turn waits in the queue.
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import * as store from './store.js'
import type { AgentConfig, Message, Origin, Project, Provider, Question, Thread } from './store.js'
import { emit } from './events.js'
import { appUrl, BIN, command, mcpUrl } from './config.js'
import { Activity, configKey, forkOf, sessionIdOf, systemPrompt, type Answer, type ApprovalRequest, type Host, type Session, type TurnInput } from './session.js'
import { ClaudeSession } from './claude.js'
import { CodexSession } from './codex.js'
import { AcpSession } from './acp.js'
import * as push from './push.js'
import { setupOf } from './git.js'
import * as ci from './ci.js'

const IDLE_CLOSE_MS = 5 * 60_000
// A turn that stopped at a usage limit continues this long after the limit resets.
const LIMIT_MARGIN_MS = 60_000
const CI_POLL_MS = 20_000
// Runs show up seconds after a push. A commit without any after this has none to wait for.
const CI_APPEAR_MS = 3 * 60_000

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
const sessions = new Map<string, { session: Session; idleTimer?: NodeJS.Timeout }>()
const stopped = new Set<string>() // threads whose last turn the user stopped: don't pump the queue
const approvals = new Map<string, (choice: string) => void>() // approval message id → resolver
const questions = new Map<string, (answers: Answer[]) => void>() // decision group id → resolver
const preparing = new Map<string, { p: Project; activity: Activity }>() // threads whose turn waits for their new worktree's setup
const resumeTimers = new Map<string, NodeJS.Timeout>() // threads waiting for a usage limit to reset
const ciTimers = new Map<string, NodeJS.Timeout>() // threads whose next look at CI is due

export const isBusy = (tid: string) => busy.has(tid)
export const anyBusy = () => busy.size > 0
export const startedAt = (tid: string) => busy.get(tid)
// An agent that acknowledged and ended its turn without a conclusion waits for the background processes its conversation owns.
export function awaitsBackground(p: Project, tid: string) {
  if (busy.has(tid) || !store.listProcs(p).some((pr) => pr.threadId === tid)) return false
  const r = request(p, tid)
  return !!r.ack && !r.conclusion
}
export const markConcluded = (tid: string, messageId: string) => turnConclusion.set(tid, messageId)

// Where the input the agent is working on came from, and which device sent it. Both are read from the stored message, so they hold
// after a restart; a request without an input counts as remote.
export function originOf(p: Project, tid: string): Origin {
  const input = inputOf(p, tid)
  return input ? input.origin ?? 'local' : 'remote'
}
export const deviceOf = (p: Project, tid: string) => inputOf(p, tid)?.device
export const chainedOf = (p: Project, tid: string) => !!inputOf(p, tid)?.chained
const inputOf = (p: Project, tid: string) => store.readMessages(p, tid).find((m) => m.id === request(p, tid).inputId)

export const conclusionKey = (m: Pick<Message, 'text' | 'questions' | 'suggestions' | 'commits'>) => JSON.stringify([m.text, m.questions, m.suggestions, m.commits])

// A request that is not in memory is read back from the thread's messages, so after a restart an
// input still gets only one acknowledgement and one conclusion, and a repeated update is recognized.
export function request(p: Project, tid: string) {
  let r = requests.get(tid)
  if (r) return r
  const msgs = store.readMessages(p, tid)
  let i = msgs.length - 1
  while (i >= 0 && !(msgs[i].kind === 'user' && msgs[i].delivered !== false)) i--
  const sent = i < 0 ? [] : msgs.slice(i + 1)
  const ack = sent.find((m) => m.kind === 'ack')
  const conclusion = sent.find((m) => m.kind === 'conclusion')
  r = {
    inputId: msgs[i]?.id ?? '',
    ack: ack && { text: ack.text ?? '', id: ack.id },
    conclusion: conclusion && { key: conclusionKey(conclusion), id: conclusion.id },
    updates: new Map(sent.filter((m) => m.kind === 'update' && m.key).map((m) => [m.key!, { text: m.text ?? '', id: m.id }])),
  }
  requests.set(tid, r)
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

export interface Input { text: string; images?: string[]; files?: string[]; origin: Origin; device?: string; from?: Message['from']; chained?: boolean }

export function send(p: Project, tid: string, input: Input) {
  // New input replaces the turn that waits for a usage limit to reset; it may go to another agent.
  setResume(p, tid, null)
  const thread = store.updateThread(p, tid, { completed: false, inputAt: store.now() })
  const queued = busy.has(tid)
  const msg = post(p, tid, { kind: 'user', text: input.text, images: input.images, files: input.files, modelInfo: thread.agent, origin: input.origin, device: input.device, from: input.from, chained: input.chained || undefined, delivered: !queued })
  stopped.delete(tid)
  if (!queued) deliver(p, tid, msg)
  else emit({ type: 'thread', projectId: p.id, threadId: tid })
  return msg
}

// "Send now": interrupt the running turn; the queue then delivers in order.
export function sendNow(p: Project, tid: string) {
  stopped.delete(tid)
  if (busy.has(tid)) current(tid)?.interrupt()
  else {
    setResume(p, tid, null)
    pump(p, tid)
  }
}

// "Add to this turn": a queued input reaches the agent while it works, at its next step, without stopping
// it, and becomes part of the running request. Input the agent can't take in now stays queued.
export async function steer(p: Project, tid: string, mid: string) {
  const msg = store.readMessages(p, tid).find((m) => m.id === mid)
  const session = current(tid)
  if (msg?.kind !== 'user' || msg.delivered !== false || !busy.has(tid) || !session?.steer) return false
  const dir = store.attachmentDir(p, tid)
  const files = (msg.files ?? []).map((f) => path.join(dir, f))
  const text = `The user adds this to the current request while you work:\n${msg.text}${files.length ? `\n\nAttached files:\n${files.join('\n')}` : ''}`
  if (!(await session.steer({ text, images: (msg.images ?? []).map((f) => path.join(dir, f)) }))) return false
  store.updateMessage(p, tid, mid, { delivered: true })
  emit({ type: 'message', projectId: p.id, threadId: tid })
  return true
}

export function removeQueued(p: Project, tid: string, mid: string) {
  const msg = store.readMessages(p, tid).find((m) => m.id === mid)
  if (!msg || msg.kind !== 'user' || msg.delivered !== false) throw new store.NotFound(`queued message ${mid}`)
  store.removeMessage(p, tid, mid)
  emit({ type: 'message', projectId: p.id, threadId: tid })
}

function deliver(p: Project, tid: string, msg: Message) {
  const startedAt = store.now()
  const thread = store.updateThread(p, tid, { needsYou: false, workingSince: startedAt })
  store.updateMessage(p, tid, msg.id, { delivered: true })
  requests.set(tid, { inputId: msg.id, startedAt, updates: new Map() })
  const setup = setupOf(thread.worktree?.path)
  if (!setup) {
    const session = sessionFor(p, thread)
    beginTurn(p, tid)
    return session.start(turnInput(p, thread, msg))
  }
  // The first turn in a new worktree starts once the project's setup command is done, and the agent
  // is told how it went.
  beginTurn(p, tid)
  const activity = new Activity(p, tid, () => true)
  activity.start('setup', 'command', `Worktree setup · ${p.worktreeSetup}`)
  preparing.set(tid, { p, activity })
  setup.then((note) => {
    if (!preparing.delete(tid)) return
    activity.finish('setup')
    const now = store.getThread(p, tid)
    sessionFor(p, now).start(turnInput(p, now, msg, note))
  })
}

function pump(p: Project, tid: string) {
  if (busy.has(tid) || stopped.has(tid) || store.getThread(p, tid).resumeAt) return
  const next = store.readMessages(p, tid).find((m) => m.kind === 'user' && m.delivered === false)
  if (next) deliver(p, tid, next)
}

export function stop(tid: string) {
  stopped.add(tid)
  const setup = preparing.get(tid)
  if (!setup) return current(tid)?.kill()
  preparing.delete(tid)
  setup.activity.finish('setup')
  endTurn(setup.p, tid, { error: 'Turn stopped.' }, store.getThread(setup.p, tid).agent)
}

// The conversation was deleted: end its session, and nothing it still reports touches the removed records.
export function forget(tid: string) {
  const s = sessions.get(tid)
  sessions.delete(tid)
  clearTimeout(s?.idleTimer)
  s?.session.kill()
  clearTimeout(resumeTimers.get(tid))
  clearTimeout(ciTimers.get(tid))
  for (const state of [busy, requests, turnConclusion, preparing, resumeTimers, ciTimers]) state.delete(tid)
  stopped.delete(tid)
}

const current = (tid: string) => sessions.get(tid)?.session

// Background work inside the agent's own process (shell commands, subagents). It ends with the process.
export const runsBackground = (tid: string) => !!current(tid)?.background?.()

// Between turns with a conclusion still owed: the agent waits for a process it registered, for
// background work of its own, for CI or for a usage limit to reset. A stop or a failure ends that.
export function waiting(p: Project, t: Thread) {
  const r = requests.get(t.id)
  return !!t.resumeAt || waitsForCi(p, t) || (!t.error && (awaitsBackground(p, t.id) || (!busy.has(t.id) && !!r?.ack && !r.conclusion && runsBackground(t.id))))
}

const waitsForCi = (p: Project, t: Thread) => {
  if (!t.ciWatch || busy.has(t.id)) return false
  const r = request(p, t.id)
  return r.inputId === t.ciWatch.inputId && !r.conclusion
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

function endTurn(p: Project, tid: string, result: { text?: string; error?: string; resetsAt?: number | null }, agent: AgentConfig) {
  const startedAt = busy.get(tid)
  if (!startedAt) return
  if (result.error) {
    // A reset that is already well past can't explain the error: no second try then.
    const resumeAt = result.resetsAt && result.resetsAt + LIMIT_MARGIN_MS > Date.now() ? new Date(result.resetsAt + LIMIT_MARGIN_MS).toISOString() : null
    store.updateThread(p, tid, { error: result.error })
    setResume(p, tid, resumeAt)
    setCi(p, tid, null)
    post(p, tid, { kind: 'error', text: result.error, modelInfo: agent })
    if (resumeAt) notify(p, tid, result.error, 'Waits for a usage limit')
    else if (result.error !== 'Turn stopped.') notify(p, tid, result.error, 'Stopped with an error')
  } else {
    store.updateThread(p, tid, { error: null })
    // Fallback for agents that ignore the message protocol: surface their final text. An agent that
    // acknowledged and ended its turn without a conclusion is waiting for background work.
    const r = request(p, tid)
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
  if (mid) store.updateMessage(p, tid, mid, { workTiming: { startedAt: request(p, tid).startedAt ?? startedAt, finishedAt: store.now() } })
  busy.delete(tid)
  // An agent that waits for background work still owes its conclusion: the mark stays, so a restart
  // picks the request up again.
  if (result.error || !awaitsBackground(p, tid)) store.updateThread(p, tid, { workingSince: null })
  emit({ type: 'status', projectId: p.id, threadId: tid })
  emit({ type: 'message', projectId: p.id, threadId: tid })
  maybeClose(p, tid)
  pump(p, tid)
}

// ---- prompts ----

// An agent that has not seen the thread yet gets the visible history handed over: after a switch
// of agents, and in a fork whose agent has no session to branch off. The excerpt names where the
// whole of it can be read.
function handover(p: Project, thread: Thread) {
  const provider = thread.agent.provider
  if (sessionIdOf(thread, provider) || forkOf(p, thread, provider)) return ''
  const earlier = thread.fork && thread.parentId ? store.readMessages(p, thread.parentId).slice(0, thread.fork.messages) : []
  const history = [...earlier, ...store.readMessages(p, thread.id).slice(0, -1)]
    .filter((m) => m.text && m.kind !== 'error')
    .slice(-30)
    .map((m) => `[${m.from ? `agent message from “${m.from.label}” (${m.from.project})` : m.kind === 'user' ? 'user' : 'agent'}] ${m.text!.slice(0, 2000)}`)
  if (!history.length) return ''
  return `Earlier in this conversation (handled by another agent):\n${history.join('\n\n')}\n\nThis is an excerpt: read_conversation with the id ${earlier.length ? thread.parentId : thread.id} returns all of it.\n\n`
}

function turnInput(p: Project, thread: Thread, msg: Message, note = ''): TurnInput {
  const dir = store.attachmentDir(p, thread.id)
  const context = {
    requestOrigin: msg.from ? 'agent' : msg.origin ?? 'local',
    ...(msg.from && {
      fromThread: { project: msg.from.projectId, projectName: msg.from.project, id: msg.from.threadId, label: msg.from.label, url: appUrl(`/p/${msg.from.projectId}/t/${msg.from.threadId}`), origin: msg.origin ?? 'local' },
    }),
    threadLabel: thread.label?.name ?? null,
    productPreview: thread.preview,
    backgroundProcesses: store.listProcs(p).filter((pr) => pr.threadId === thread.id),
    decisions: store.listDecisions(p, thread.id).slice(-20),
    cwd: store.cwdOf(p, thread),
    worktree: thread.worktree?.branch ?? null,
  }
  const files = (msg.files ?? []).map((f) => path.join(dir, f))
  const attached = files.length ? `\n\nAttached files:\n${files.join('\n')}` : ''
  return { context: `${handover(p, thread)}Savor context:\n${JSON.stringify(context)}\n\n${note}New input:\n`, input: `${msg.text}${attached}`, images: (msg.images ?? []).map((f) => path.join(dir, f)) }
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
    : provider === 'opencode' || provider === 'grok' || provider === 'gemini' ? new AcpSession(host, thread)
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
    context: (tokens, window) => {
      if (!mine()) return
      const t = store.getThread(p, tid)
      // Saved as it is: this is no change to the conversation, so its place in the list stays.
      store.saveThread(p, { ...t, context: { tokens, window: window ?? t.context?.window ?? null } })
    },
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
// A comment on the answers goes along with them: in the same input, or as the next one when the
// agent took the answers directly. A question sent without an answer counts as not answered.
export function answerDecisions(p: Project, tid: string, answers: { id: string; selected?: number; answer?: string }[], comment: Input) {
  const all = store.listDecisions(p, tid)
  const lines: string[] = []
  const groups = new Set<string>()
  for (const a of answers) {
    const d = all.find((d) => d.id === a.id)
    if (!d || d.resolved) continue
    d.resolved = true
    d.selected = a.selected ?? null
    d.answer = a.selected == null ? a.answer?.trim() || null : null
    store.saveDecision(p, d)
    lines.push(`Decision: ${d.title}\n${d.selected != null ? `Selected: ${d.options[d.selected]}` : d.answer != null ? `Answer: ${d.answer}` : 'Not answered'}`)
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
  const commented = !!(comment.text.trim() || comment.images?.length || comment.files?.length)
  if (lines.length && !delivered) send(p, tid, { ...comment, text: [...lines, ...(comment.text.trim() ? [`Comment: ${comment.text.trim()}`] : [])].join('\n\n') })
  else if (commented) send(p, tid, comment)
}

// "Your turn" = open questions or pending approvals in the thread.
export function refreshNeedsYou(p: Project, tid: string) {
  const needsYou = store.listDecisions(p, tid).some((d) => !d.resolved) || store.readMessages(p, tid).some((m) => m.approval?.status === 'pending')
  store.updateThread(p, tid, { needsYou })
  emit({ type: 'thread', projectId: p.id, threadId: tid })
}

function cancelPending(p: Project, tid: string) {
  for (const m of store.readMessages(p, tid)) {
    if (m.approval?.status === 'pending') {
      store.updateMessage(p, tid, m.id, { approval: { ...m.approval, status: 'resolved', choice: m.approval.options.find((o) => o.kind === 'deny')?.id } })
      approvals.delete(m.id)
    }
    if (m.kind === 'question' && questions.has(m.id)) questions.delete(m.id)
  }
  refreshNeedsYou(p, tid)
}

// ---- continuing a request ----

// The agent resumes its own session on the input it still owes a conclusion for, and is told why.
function continueRequest(p: Project, thread: Thread, input: Message, note: string) {
  const r = request(p, thread.id)
  r.startedAt ??= thread.workingSince ?? store.now()
  store.updateThread(p, thread.id, { workingSince: r.startedAt })
  const session = sessionFor(p, thread)
  beginTurn(p, thread.id)
  session.start(turnInput(p, thread, input, note))
}

// ---- usage limits ----

const LIMITED = `You stopped at a usage limit while working on the input below, and the limit has reset since. Check what is already done before you repeat anything, then finish the work. This is still the same request: do not acknowledge it again.\n\n`

// `at` is when the turn continues, or null for no longer. What is queued waits until then.
function setResume(p: Project, tid: string, at: string | null) {
  clearTimeout(resumeTimers.get(tid))
  resumeTimers.delete(tid)
  if (store.getThread(p, tid).resumeAt !== at) store.updateThread(p, tid, { resumeAt: at })
  if (at) resumeTimers.set(tid, setTimeout(() => resumeAfterLimit(p, tid), Math.max(0, Date.parse(at) - Date.now())))
}

function resumeAfterLimit(p: Project, tid: string) {
  setResume(p, tid, null)
  const thread = store.getThread(p, tid)
  const r = request(p, tid)
  const input = store.readMessages(p, tid).find((m) => m.id === r.inputId)
  if (input && !r.conclusion && !busy.has(tid)) continueRequest(p, thread, input, LIMITED)
  else pump(p, tid)
}

// ---- waiting for CI ----

// The agent pushed and ended its turn: Savor looks at the commit's runs until they have all finished
// and continues the request with their result. A failure after the agent concluded goes to the user.
export function watchCi(p: Project, tid: string, sha: string) {
  setCi(p, tid, { sha, since: store.now(), inputId: request(p, tid).inputId })
  emit({ type: 'status', projectId: p.id, threadId: tid })
}

function setCi(p: Project, tid: string, watch: Thread['ciWatch'], delay = CI_POLL_MS) {
  clearTimeout(ciTimers.get(tid))
  ciTimers.delete(tid)
  if (store.getThread(p, tid).ciWatch?.since !== watch?.since) store.updateThread(p, tid, { ciWatch: watch })
  if (watch) ciTimers.set(tid, setTimeout(() => checkCi(p, tid, watch), delay))
}

async function checkCi(p: Project, tid: string, watch: NonNullable<Thread['ciWatch']>) {
  const short = watch.sha.slice(0, 7)
  let runs: ci.Run[] | null = null
  let failure = ''
  try {
    runs = await ci.runsOf(store.cwdOf(p, store.getThread(p, tid)), watch.sha)
  } catch (e) {
    failure = (e as Error).message
  }
  // A stop or a new watch while gh was asked.
  if (store.getThread(p, tid).ciWatch?.since !== watch.since) return
  if (!runs) return ciDone(p, tid, watch, `Savor could not read the CI runs of ${short}: ${failure}`, true)
  if (!runs.length && Date.now() - Date.parse(watch.since) > CI_APPEAR_MS) return ciDone(p, tid, watch, `No GitHub Actions runs showed up for ${short} within ${CI_APPEAR_MS / 60_000} minutes.`, true)
  if (!ci.finished(runs) || busy.has(tid)) return setCi(p, tid, watch)
  ciDone(p, tid, watch, ci.report(watch.sha, runs), ci.failed(runs).length > 0)
}

function ciDone(p: Project, tid: string, watch: NonNullable<Thread['ciWatch']>, result: string, bad: boolean) {
  setCi(p, tid, null)
  const thread = store.getThread(p, tid)
  const r = request(p, tid)
  const input = store.readMessages(p, tid).find((m) => m.id === r.inputId)
  if (input && r.inputId === watch.inputId && !r.conclusion && !busy.has(tid))
    return continueRequest(p, thread, input, `The CI runs you asked Savor to watch have finished.\n${result}\n\nThis is still the same request: do not acknowledge it again.\n\n`)
  if (bad) {
    post(p, tid, { kind: 'error', text: result })
    store.updateThread(p, tid, { unread: true })
    notify(p, tid, result, 'CI failed')
  }
  emit({ type: 'status', projectId: p.id, threadId: tid })
}

// ---- restarts ----

const INTERRUPTED = `Savor was restarted while you were working on the input below. Your process was cut off, and so was whatever command or tool call was running. Check what is already done before you repeat anything, then finish the work. This is still the same request: do not acknowledge it again.\n\n`

// A turn that the end of the daemon cut off continues at the next start. The agent resumes its own
// session and is told what happened, so it decides what to redo; Savor repeats nothing by itself.
// A turn that waits for a usage limit continues when it resets, also if that was while Savor was down.
export function resumeInterrupted() {
  for (const p of store.listProjects())
    for (const thread of store.listThreads(p)) {
      if (thread.resumeAt) setResume(p, thread.id, thread.resumeAt)
      if (thread.ciWatch) setCi(p, thread.id, thread.ciWatch, 0)
      if (!thread.workingSince) continue
      const tid = thread.id
      // Whoever asked for these approvals is gone; the agent asks again when it gets there.
      cancelPending(p, tid)
      const r = request(p, tid)
      const input = store.readMessages(p, tid).find((m) => m.id === r.inputId)
      const waitsForYou = store.getThread(p, tid).needsYou
      if (input && !r.conclusion && !waitsForYou) {
        continueRequest(p, thread, input, INTERRUPTED)
        continue
      }
      store.updateThread(p, tid, { workingSince: null })
      // An open question restarts the work with its answer, and what is queued follows that.
      if (!waitsForYou) pump(p, tid)
    }
}

// The daemon is going down: its agents go with it, and their turns continue at the next start. The
// sessions are let go first, so their ends don't close the turns.
export function shutdown() {
  const all = [...sessions.values()]
  sessions.clear()
  for (const { session } of all) session.kill()
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
