// Turns, queues and sessions: one agent session per conversation, one turn at a time, input that
// arrives during a turn waits in the queue.
import fs from 'node:fs'
import path from 'node:path'
import * as store from './store.js'
import type { AgentConfig, Message, NoticeType, Origin, Project, Provider, Question, Thread } from './store.js'
import { emit } from './events.js'
import { appUrl } from './config.js'
import { Activity, PlanTracker, configKey, forkOf, sessionIdOf, type Answer, type ApprovalRequest, type Host, type Session, type TurnInput } from './session.js'
import { ClaudeSession, creditEnv, idleCompaction } from './claude.js'
import { CodexSession } from './codex.js'
import { AcpSession } from './acp.js'
import { AntigravitySession } from './antigravity.js'
import * as push from './push.js'
import * as git from './git.js'
import * as terminal from './terminal.js'
import * as ci from './ci.js'
import { modelSeen, spent } from './scheduler.js'
import { attempt, saveStep } from './workflow-results.js'
import { listAgents, listUsage, mergeAgent, STATIC } from './providers.js'

const IDLE_CLOSE_MS = Number(process.env.SAVOR_IDLE_CLOSE_MS ?? 5 * 60_000)
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
  // The agents that stopped at a usage limit on this request, with when it resets (ms).
  limited?: Map<Provider, number>
  // Whether Claude Code went on with API credit on this request.
  credit?: boolean
}

const requests = new Map<string, RequestState>()
const busy = new Map<string, string>() // threadId → turn start
const turnConclusion = new Map<string, string>()
const sessions = new Map<string, { session: Session; idleTimer?: NodeJS.Timeout }>()
const stopped = new Set<string>() // threads whose last turn the user stopped: don't pump the queue
const approvals = new Map<string, (answer: { choice: string; content?: Record<string, unknown> }) => void>() // approval message id → resolver
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

// A notice is unread until it is seen. `status` is what a push says, besides a question it can answer.
// The conversation keeps the notice's type and who raised it: its agent, the workflow, CI or the
// project a message came from. A result of a workflow run counts as a run.
export function notify(p: Project, tid: string, type: NoticeType, body: string, status: string, actor?: string) {
  const t = store.getThread(p, tid)
  const kind = type === 'result' && t.workflow ? 'run' : type
  const notice = { type: kind, actor: actor ?? (kind === 'run' && t.workflow ? t.workflow.name : STATIC[t.agent.provider]?.name ?? t.agent.provider), at: store.now() }
  store.updateThread(p, tid, { unread: true, notice })
  emit({ type: 'notify', projectId: p.id, threadId: tid, title: `${p.name} · ${t.label?.name ?? t.title}`.slice(0, 120), body: body.slice(0, 200) })
  emit({ type: 'thread', projectId: p.id, threadId: tid })
  push.send(p, tid, status)
}

// ---- input and the queue ----

export interface Input { text: string; images?: string[]; files?: string[]; origin: Origin; device?: string; from?: Message['from']; chained?: boolean; workflowStart?: boolean }

export function send(p: Project, tid: string, input: Input) {
  if (!input.workflowStart && !input.from) attempt(p, tid, 'human')
  // New input replaces the turn that waits for a usage limit to reset; it may go to another agent.
  setResume(p, tid, null)
  const thread = store.updateThread(p, tid, { completed: false, inputAt: store.now() })
  const queued = busy.has(tid) || compacting.has(tid)
  const msg = post(p, tid, { kind: 'user', text: input.text, images: input.images, files: input.files, modelInfo: thread.agent, origin: input.origin, device: input.device, from: input.from, chained: input.chained || undefined, delivered: !queued })
  const step = thread.workflow?.steps?.find((s) => s.id === thread.workflow?.activeStep)
  if (!input.workflowStart && !input.from && step?.result?.status === 'waiting') saveStep(p, tid, { ...step, result: { ...step.result, status: 'partial', reason: 'User replied; the outcome needs verification.', evidence: [...step.result.evidence, msg.id].slice(-20) } })
  if (!input.from) skipAsked(p, tid)
  stopped.delete(tid)
  if (!queued) deliver(p, tid, msg)
  else emit({ type: 'thread', projectId: p.id, threadId: tid })
  return msg
}

// The user's new input passes over the questions of earlier conclusions: the chat no longer offers them, so they
// count as skipped and don't keep the conversation waiting. Questions an agent waits for stay open, and so do all
// when another agent writes: its input must not make the user's questions go unseen.
function skipAsked(p: Project, tid: string) {
  const waits = new Set(store.readMessages(p, tid).filter((m) => m.kind === 'question').map((m) => m.id))
  for (const d of store.listDecisions(p, tid)) if (!d.resolved && !waits.has(d.groupId)) store.saveDecision(p, { ...d, resolved: true })
}

// "Send now": interrupt the running turn; the queue then delivers in order.
export function sendNow(p: Project, tid: string) {
  stopped.delete(tid)
  if (busy.has(tid)) current(tid)?.interrupt()
  else {
    compacting.get(tid)?.kill()
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

// A worktree removed outside Savor (by an agent or by hand): the conversation continues in the project
// folder with a fresh agent session, as after removing the worktree in Savor.
function leaveRemovedWorktree(p: Project, tid: string) {
  const t = store.getThread(p, tid)
  if (!t.worktree || fs.existsSync(t.worktree.path)) return
  const s = sessions.get(tid)
  sessions.delete(tid)
  clearTimeout(s?.idleTimer)
  s?.session.kill()
  store.updateThread(p, tid, { worktree: null, agentSessions: [], ...(t.fork && { fork: { ...t.fork, sessionId: null } }) })
  post(p, tid, { kind: 'update', text: `The worktree of branch ${t.worktree.branch} no longer exists. This conversation continues in the project folder.` })
}

// Removes the worktree and its branch. Its conversations stay, finished, and continue in the project
// folder with a fresh agent session that gets the visible history handed over.
export function removeWorktree(p: Project, wt: { branch: string; path: string }) {
  for (const t of store.listThreads(p).filter((t) => t.worktree?.path === wt.path)) {
    stop(t.id)
    // A fork that has not started yet loses the session it would have branched off, like the others lose theirs.
    store.updateThread(p, t.id, { worktree: null, agentSessions: [], completed: true, ...(t.fork && { fork: { ...t.fork, sessionId: null } }) })
  }
  terminal.closeFolder(wt.path)
  git.removeWorktree(p, wt.path)
  git.deleteBranch(p, wt.branch)
  emit({ type: 'thread', projectId: p.id })
}

// The project folder moves: idle agent processes end, and the next input starts them in the new place.
export function endSessions(p: Project) {
  for (const t of store.listThreads(p)) {
    const s = sessions.get(t.id)
    if (!s || busy.has(t.id)) continue
    sessions.delete(t.id)
    clearTimeout(s.idleTimer)
    s.session.kill()
  }
}

// A worktree whose conversations are all finished and whose work is merged has done its job, and goes.
export function tidyWorktree(p: Project, dir: string | undefined) {
  const wt = dir && git.listWorktrees(p).find((w) => w.path === dir)
  if (!wt || !git.isSpent(p, wt)) return
  if (store.listThreads(p).some((t) => t.worktree?.path === dir && (!t.completed || busy.has(t.id) || waiting(p, t)))) return
  removeWorktree(p, wt)
}

function deliver(p: Project, tid: string, msg: Message) {
  const startedAt = store.now()
  leaveRemovedWorktree(p, tid)
  // A new request starts on the subscription again.
  const thread = store.updateThread(p, tid, { needsYou: false, workingSince: startedAt, apiCredit: null })
  store.updateMessage(p, tid, msg.id, { delivered: true })
  requests.set(tid, { inputId: msg.id, startedAt, updates: new Map() })
  const setup = git.setupOf(thread.worktree?.path)
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
  if (busy.has(tid) || compacting.has(tid) || stopped.has(tid) || store.getThread(p, tid).resumeAt) return
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
  clearTimeout(compactTimers.get(tid))
  compacting.get(tid)?.kill()
  for (const state of [busy, requests, turnConclusion, preparing, resumeTimers, ciTimers, compactTimers, compacting]) state.delete(tid)
  stopped.delete(tid)
}

const current = (tid: string) => sessions.get(tid)?.session

// Background work inside the agent's own process (shell commands, subagents). It ends with the process.
export const runsBackground = (tid: string) => !!current(tid)?.background?.()

// The plans of a conversation's requests. Subagents of a process that has ended no longer run, whatever they last reported.
export function plansOf(p: Project, tid: string) {
  const plans = store.readPlans(p, tid)
  if (current(tid)) return plans
  return Object.fromEntries(Object.entries(plans).map(([k, plan]) => [k, { ...plan, agents: plan.agents.map((a) => (a.status === 'running' ? { ...a, status: 'stopped' as const, stoppable: false } : a)) }]))
}

export function stopTask(tid: string, id: string) {
  current(tid)?.stopTask?.(id)
}

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
    const thread = store.getThread(p, tid)
    const credit = thread.apiCredit
    if (resumeAt && unattended(thread)) void fallBack(p, tid, agent.provider, result.resetsAt!, result.error)
    // Whatever stops Claude Code on API credit (no credit left, its budget, the key) hands the request on.
    else if (credit && unattended(thread) && result.error !== 'Turn stopped.' && !request(p, tid).conclusion) void fallBack(p, tid, 'claude', credit.resetsAt, result.error)
    else if (resumeAt) notify(p, tid, 'error', result.error, 'Waits for a usage limit')
    else if (result.error !== 'Turn stopped.') notify(p, tid, 'error', result.error, 'Stopped with an error')
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
      notify(p, tid, 'result', result.text, 'Finished')
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
function handover(p: Project, thread: Thread, input: Message) {
  const provider = thread.agent.provider
  if (sessionIdOf(thread, provider) || forkOf(p, thread, provider)) return ''
  const earlier = thread.fork && thread.parentId ? store.readMessages(p, thread.parentId).slice(0, thread.fork.messages) : []
  const history = [...earlier, ...store.readMessages(p, thread.id)]
    .filter((m) => m.id !== input.id && m.text && m.kind !== 'error')
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
    ...(thread.routedFrom && { inboxSource: { ...thread.routedFrom, url: appUrl(`/all/inbox/${thread.routedFrom.projectId}/${thread.routedFrom.threadId}`) } }),
    ...(thread.inbox && { routedConversations: store.listProjects().flatMap((target) => store.listThreads(target).filter((t) => t.routedFrom?.projectId === p.id && t.routedFrom.threadId === thread.id).map((t) => ({ projectId: target.id, project: target.name, threadId: t.id, title: t.title, url: appUrl(`/all/inbox/${target.id}/${t.id}`) }))) }),
  }
  const files = (msg.files ?? []).map((f) => path.join(dir, f))
  const attached = files.length ? `\n\nAttached files:\n${files.join('\n')}` : ''
  const routing = thread.inbox ? `This conversation is a shared inbox. Use list_projects to identify the right repositories. Route clearly scoped work through start_conversation with the target project and a concise, self-contained task; use a separate worktree for code changes. Split independent tasks across projects. Check the conversation history before delegating again. Handle notes and general questions here; ask the user when the project or intent is unclear. Do not change repository code in this inbox. Link every started conversation in your conclusion. Preserve the user's requested scope and permissions.\n\n` : ''
  return { context: `${handover(p, thread, msg)}Savor context:\n${JSON.stringify(context)}\n\n${routing}${note}New input:\n`, input: `${msg.text}${attached}`, images: (msg.images ?? []).map((f) => path.join(dir, f)) }
}

// ---- sessions ----

function sessionFor(p: Project, thread: Thread): Session {
  const tid = thread.id
  let s = sessions.get(tid)
  // New agent, model, effort or permission settings need a fresh process.
  if (s && s.session.config !== configKey(thread.agent, !!thread.apiCredit)) {
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
    : new AntigravitySession(host, thread)
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
    plan: new PlanTracker(p, tid, () => request(p, tid).inputId, mine),
    working: () => mine() && beginTurn(p, tid),
    context: (tokens, window) => {
      if (!mine()) return
      const t = store.getThread(p, tid)
      // Saved as it is: this is no change to the conversation, so its place in the list stays.
      store.saveThread(p, { ...t, context: { tokens, window: window ?? t.context?.window ?? null } })
    },
    // Only a conversation on the project's default agent tells which model the project runs on.
    model: (id) => {
      if (!mine()) return
      const d = store.listProjects().find((project) => project.id === p.id)?.agent
      if (d && thread.agent.provider === d.provider && thread.agent.model === d.model) modelSeen(p.id, id)
    },
    spent: (usage) => mine() && spent(p, tid, thread.agent.provider, usage),
    approve: (req) => askApproval(p, tid, req).then((a) => a.choice),
    form: (req) => askApproval(p, tid, req),
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
      else scheduleCompact(p, tid)
    },
  }
}

// ---- approvals and clarifying questions ----

export function askApproval(p: Project, tid: string, req: ApprovalRequest) {
  const msg = post(p, tid, { kind: 'approval', approval: { ...req, status: 'pending' } })
  store.updateThread(p, tid, { unread: true, needsYou: true })
  emit({ type: 'thread', projectId: p.id, threadId: tid })
  notify(p, tid, 'ask', req.title, 'Needs your approval')
  return new Promise<{ choice: string; content?: Record<string, unknown> }>((resolve) => approvals.set(msg.id, resolve))
}

export function resolveApproval(p: Project, tid: string, mid: string, choice: string, content?: Record<string, unknown>) {
  const msg = store.readMessages(p, tid).find((m) => m.id === mid)
  const a = msg?.approval
  if (!a || a.status !== 'pending') throw new store.NotFound(`approval ${mid}`)
  store.updateMessage(p, tid, mid, { approval: { ...a, status: 'resolved', choice } })
  emit({ type: 'message', projectId: p.id, threadId: tid })
  approvals.get(mid)?.({ choice, content })
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
  notify(p, tid, 'ask', `Your turn: ${qs[0]?.title ?? ''}`, 'Has a question')
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
    d.origin = comment.origin
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
      store.updateMessage(p, tid, m.id, { approval: { ...m.approval, status: 'resolved', choice: m.approval.options.find((o) => o.kind === 'deny')?.id, expired: true } })
      approvals.delete(m.id)
    }
    if (m.kind === 'question' && questions.has(m.id)) questions.delete(m.id)
  }
  refreshNeedsYou(p, tid)
}

// ---- continuing a request ----

// The agent resumes its own session on the input it still owes a conclusion for, and is told why.
function continueRequest(p: Project, thread: Thread, input: Message, note: string) {
  attempt(p, thread.id, note === INTERRUPTED ? 'restart' : 'resume')
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

// Workflow runs and the conversations they start have no one who waits for a usage limit: they go on with
// the next of these agents. Each runs in a mode that doesn't stop for approvals, or as the project sets it up.
const FALLBACK: [Provider, string][] = [['claude', 'auto'], ['codex', 'auto-review'], ['antigravity', 'default'], ['opencode', 'build']]

export const unattended = (t: Thread) => !!t.workflow || !!t.unattended

const takeOver = (from: string) => `${from} stopped at a usage limit while working on the input below, and you take over. Check what is already done before you repeat anything, then finish the work. This is still the same request: do not acknowledge it again.\n\n`
const ON_CREDIT = `You stopped at a usage limit while working on the input below, and go on with API credit now. Check what is already done before you repeat anything, then finish the work. This is still the same request: do not acknowledge it again.\n\n`

// Claude Code first goes on with API credit, once per request and where Savor has a key for it (state.json `apiCredit`).
// After that, the next agent is installed, signed in, has not stopped at a limit on this request yet and is not at 100 %
// of any window. With none left, the request waits for the earliest reset; if that is another agent's, the current one
// stops at its limit again then, and the switch follows.
async function fallBack(p: Project, tid: string, provider: Provider, resetsAt: number, error: string) {
  const r = request(p, tid)
  const limited = (r.limited ??= new Map())
  limited.set(provider, resetsAt)
  for (const [id, at] of limited) if (at + LIMIT_MARGIN_MS < Date.now()) limited.delete(id)
  const waits = store.getThread(p, tid).resumeAt
  const [installed, usage] = await Promise.all([listAgents(), listUsage(true)])
  const thread = store.getThread(p, tid)
  const input = inputOf(p, tid)
  // New input or a stop while the agents were asked.
  if (thread.resumeAt !== waits || requests.get(tid) !== r || busy.has(tid) || !input) return
  const credit = thread.apiCredit
  const budgetUsd = store.state().apiCredit?.budgetUsd ?? 15
  if (provider === 'claude' && !credit && !r.credit && budgetUsd > 0 && creditEnv()) {
    r.credit = true
    const fromUsd = thread.spent?.find((s) => s.provider === 'claude')?.usd ?? 0
    setResume(p, tid, null)
    store.updateThread(p, tid, { apiCredit: { resetsAt, fromUsd, budgetUsd } })
    post(p, tid, { kind: 'update', text: `Claude Code reached its usage limit and goes on through the API credit, up to $${budgetUsd}.` })
    return continueRequest(p, store.getThread(p, tid), input, ON_CREDIT)
  }
  if (credit) store.updateThread(p, tid, { apiCredit: null })
  const full = (id: Provider) =>
    limited.has(id) || !installed.some((a) => a.id === id && a.installed && a.signedIn) || usage.some((u) => u.provider === id && u.windows.some((w) => w.percent >= 100))
  const i = FALLBACK.findIndex(([id]) => id === provider)
  const next = [...FALLBACK.slice(i + 1), ...FALLBACK.slice(0, i + 1)].find(([id]) => !full(id))
  if (!next) {
    setResume(p, tid, new Date(Math.min(...limited.values()) + LIMIT_MARGIN_MS).toISOString())
    return notify(p, tid, 'error', error, 'Waits for a usage limit')
  }
  const [to, permissionMode] = next
  const agent = to === p.agent.provider ? p.agent : mergeAgent(thread.agent, { provider: to, permissionMode })
  setResume(p, tid, null)
  store.updateThread(p, tid, { agent })
  // The switch shows in the conversation, so it is clear which agent did what.
  const why = credit ? `${STATIC[provider].name} stopped on the API credit too.` : `${STATIC[provider].name} reached its usage limit.`
  post(p, tid, { kind: 'update', text: `${why} ${STATIC[to].name} takes over.`, modelInfo: agent })
  continueRequest(p, store.getThread(p, tid), input, takeOver(STATIC[provider].name))
}

// ---- waiting for CI ----

// The agent pushed and ended its turn: Savor looks at the commit's runs until they have all finished
// and continues the request with their result. A failure after the agent concluded goes to the user.
export function watchCi(p: Project, tid: string, sha: string) {
  setCi(p, tid, { sha, since: store.now(), inputId: request(p, tid).inputId })
  ci.wake(p.id)
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
    notify(p, tid, 'ci', result, 'CI failed', 'CI')
  }
  emit({ type: 'status', projectId: p.id, threadId: tid })
}

// ---- idle compaction ----

// Claude Code compacts a large conversation left idle shortly before its one-hour prompt cache expires, so
// the next message doesn't send all of it again uncached. It does that only in its terminal UI, and Savor
// ends the agent process minutes after a turn: Savor compacts open Claude conversations itself, as Claude's
// settings say. The time counts from the last message, so a restart keeps it.
const IDLE_COMPACT_MS = Number(process.env.SAVOR_IDLE_COMPACT_MS ?? 54 * 60_000)
const CACHE_MS = 60 * 60_000
const compactTimers = new Map<string, NodeJS.Timeout>()
const compacting = new Map<string, Session>()

function compactable(p: Project, t: Thread) {
  const min = t.agent.provider === 'claude' && !t.completed && !!sessionIdOf(t, 'claude') && idleCompaction(store.cwdOf(p, t))
  return !!min && (t.context?.tokens ?? 0) >= min
}

function scheduleCompact(p: Project, tid: string) {
  clearTimeout(compactTimers.get(tid))
  compactTimers.delete(tid)
  if (!compactable(p, store.getThread(p, tid))) return
  const idle = Date.now() - Date.parse(store.readMessages(p, tid).at(-1)?.ts ?? '')
  if (idle < CACHE_MS) compactTimers.set(tid, setTimeout(() => compact(p, tid), Math.max(0, IDLE_COMPACT_MS - idle)))
}

// The agent resumes its session for /compact alone, outside of any request. Input that arrives meanwhile
// waits in the queue; "Send now" ends the compaction.
function compact(p: Project, tid: string) {
  compactTimers.delete(tid)
  const t = store.getThread(p, tid)
  const last = store.readMessages(p, tid).at(-1)
  if (!last || !compactable(p, t) || busy.has(tid) || sessions.has(tid) || waiting(p, t)) return
  const from = t.context!.tokens
  const holder: { session?: Session } = {}
  const mine = () => !!holder.session && compacting.get(tid) === holder.session
  const refuse = () => Promise.reject(new Error('Savor is compacting this conversation.'))
  const host: Host = {
    p,
    tid,
    cwd: store.cwdOf(p, t),
    activity: new Activity(p, tid, () => false),
    plan: new PlanTracker(p, tid, () => '', () => false),
    backgroundChanged: () => {},
    working: () => {},
    model: () => {},
    // What the context holds after the compaction. The conversation shows it below the message it followed.
    context: (to) => {
      if (!mine()) return
      store.saveThread(p, { ...store.getThread(p, tid), context: { tokens: to, window: t.context!.window } })
      store.updateMessage(p, tid, last.id, { compacted: { from, to } })
      emit({ type: 'message', projectId: p.id, threadId: tid })
    },
    spent: (usage) => mine() && spent(p, tid, 'claude', usage),
    approve: refuse,
    form: refuse,
    ask: refuse,
    ended: () => holder.session?.end(),
    closed: () => {
      if (!mine()) return
      compacting.delete(tid)
      pump(p, tid)
    },
  }
  holder.session = new ClaudeSession(host, t)
  compacting.set(tid, holder.session)
  holder.session.start({ context: '', input: '/compact', images: [] })
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
      if (!thread.workingSince) {
        scheduleCompact(p, thread.id)
        continue
      }
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
  const all = [...sessions.values()].map((s) => s.session).concat([...compacting.values()])
  sessions.clear()
  compacting.clear()
  for (const session of all) session.kill()
}
