// OpenCode over the Agent Client Protocol: one agent process per
// conversation, prompts via session/prompt, progress via session/update, approvals via
// session/request_permission.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import * as store from './store.js'
import type { PlanStep, Thread } from './store.js'
import { BIN, command, mcpUrl, VERSION } from './config.js'
import { Rpc, RpcError } from './jsonrpc.js'
import { configKey, forkOf, rememberSession, sessionIdOf, STOPPED, summarize, systemPrompt, type Host, type Session, type TurnInput } from './session.js'
import type { SkillInfo } from './providers.js'

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

// OpenCode's ACP adapter drops its session todo list: it never emits the plan sessionUpdate (anomalyco/opencode
// #40745), and a todowrite call arrives only as a raw tool call. The call's input is the whole list, so Savor
// reads it from there. Once OpenCode emits plan updates, the plan case in onNotification takes over.
export function todoSteps(rawInput: unknown): PlanStep[] | null {
  let input = rawInput
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input)
    } catch {
      return null
    }
  }
  const todos = (input as any)?.todos
  if (!Array.isArray(todos) || !todos.length || !todos.every((t: any) => t && typeof t.content === 'string')) return null
  return todos.map((t: any) => ({ text: t.content, status: t.status === 'in_progress' ? 'active' : t.status === 'completed' ? 'done' : 'pending' }))
}

// OpenCode takes the protocol as an instructions file in its system prompt; every prompt carries a reminder.
const REMINDER =
  'Savor reminder: the user sees only the savor MCP tools — acknowledge, then end the turn with send_conclusion_message (summary, text, questions, suggestions), and keep your todo list current.\n\n'

// OpenCode has no auto mode of its own: the plugin opencode-auto-permissions (MIT, hueyexe) lets the session's
// model review what is set to ask. Pinned, since OpenCode loads it from npm; check a newer version before bumping it.
// OpenCode applies the last matching rule, so the broad allow comes first.
const AUTO = {
  plugin: ['opencode-auto-permissions@0.2.15'],
  permission: {
    bash: { '*': 'allow', 'rm *': 'ask', 'sudo *': 'ask', 'git push*': 'ask', 'git reset --hard*': 'ask', 'git clean -f*': 'ask', 'curl * | *sh*': 'ask', 'wget * | *sh*': 'ask' },
    external_directory: 'ask',
  },
}

// `instructions` is a file OpenCode adds to its system prompt.
export function acpCommand(projectId: string, threadId: string, mode = '', instructions?: string) {
  const savor = { url: mcpUrl(projectId, threadId), headers: { Authorization: `Bearer ${store.state().mcpToken}` } }
  // Full access is OpenCode's build agent with every permission allowed, files outside the project included.
  // Auto is its build agent with the risky commands set to ask, and those asks answered by a reviewer model.
  const permission = mode === 'full-access' ? { permission: 'allow' } : mode === 'auto' ? AUTO : {}
  return {
    bin: BIN.opencode,
    // OpenCode 1.x logs an error of the model's API without answering the prompt; Savor reads it from the log (stuck).
    args: ['acp', '--print-logs', '--log-level', 'ERROR'],
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: 'disabled', ...(instructions && { instructions: [instructions] }), ...permission, mcp: { savor: { type: 'remote', ...savor, enabled: true } } }) },
  }
}

export class AcpSession implements Session {
  readonly config: string
  private rpc: Rpc
  private ready: Promise<void>
  private sessionId = ''
  private loading = false
  private text = ''
  private thinking = false
  private stopping = false
  // In OpenCode's Auto mode the plugin answers OpenCode's permission asks, which OpenCode still sends here too.
  private readonly reviewer: boolean
  // The asks waiting for the plugin, by tool call.
  private reviews = new Map<string, () => void>()
  // Fails the running prompt when OpenCode logs that the model's API stopped it at a usage limit.
  private stuck: (error: string) => void = () => {}
  // OpenCode's file with Savor's protocol for its system prompt, while its process runs.
  private readonly instructions: string

  constructor(private host: Host, private thread: Thread) {
    this.reviewer = thread.agent.permissionMode === 'auto'
    const { p } = host
    this.config = configKey(thread.agent)
    // One per process: the next process of the conversation may start before this one has ended.
    this.instructions = path.join(store.HOME, 'prompts', `${thread.id}-${Date.now()}.md`)
    fs.mkdirSync(path.dirname(this.instructions), { recursive: true })
    fs.writeFileSync(this.instructions, systemPrompt(p, thread))
    const cmd = acpCommand(p.id, thread.id, thread.agent.permissionMode, this.instructions)
    const child = spawn(...command(cmd.bin, cmd.args), { cwd: host.cwd, env: { ...process.env, ...cmd.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.rpc = new Rpc(child, { notification: (m, params) => this.onNotification(m, params), request: (m, params) => this.onRequest(m, params) })
    readline.createInterface({ input: child.stderr! }).on('line', (l) => {
      const error = stuckOn(l, this.sessionId)
      if (error) this.stuck(error)
    })
    this.rpc.exited.then(({ code, signal }) => {
      fs.rmSync(this.instructions, { force: true })
      host.closed(this.stopping || signal === 'SIGTERM' ? STOPPED : `${cmd.bin} exited with ${code}: ${this.rpc.stderrTail}`)
    })
    this.ready = this.init()
  }

  private async init() {
    const { p, tid } = this.host
    const a = this.thread.agent
    const init = await this.rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'savor', version: VERSION },
    })
    const mcpServers = [{ type: 'http', name: 'savor', url: mcpUrl(p.id, tid), headers: [{ name: 'Authorization', value: `Bearer ${store.state().mcpToken}` }] }]
    const sid = sessionIdOf(store.getThread(p, tid), a.provider)
    const fork = forkOf(p, store.getThread(p, tid), a.provider)
    let session: any = null
    if (sid && init.agentCapabilities?.loadSession) {
      this.loading = true
      session = await this.rpc.request('session/load', { sessionId: sid, cwd: this.host.cwd, mcpServers }).catch(() => null)
      this.loading = false
      if (session) session.sessionId = sid
    } else if (fork && init.agentCapabilities?.sessionCapabilities?.fork) {
      session = await this.rpc.request('session/fork', { sessionId: fork, cwd: this.host.cwd, mcpServers }).catch(() => null)
    }
    if (!session) session = await this.rpc.request('session/new', { cwd: this.host.cwd, mcpServers })
    this.sessionId = session.sessionId
    rememberSession(p, tid, a.provider, this.sessionId)
    const modes = session.modes
    if (a.permissionMode && (!modes || (modes.currentModeId !== a.permissionMode && modes.availableModes?.some((m: any) => m.id === a.permissionMode))))
      await this.rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: a.permissionMode }).catch(() => {})
    const model = withEffort(a.model || (a.reasoning ? session.models?.currentModelId : ''), a.reasoning)
    if (model) await this.rpc.request('session/set_model', { sessionId: this.sessionId, modelId: model }).catch(() => {})
    if (a.model || session.models?.currentModelId) this.host.model(a.model || session.models.currentModelId)
  }

  start({ context, input, images }: TurnInput) {
    this.text = ''
    const images64 = images.map((file) => ({ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: MIME[path.extname(file).slice(1).toLowerCase()] ?? 'image/png' }))
    this.ready
      .then(() => {
        const text = input.startsWith('/') ? input : REMINDER + context + input
        const stuck = new Promise<never>((_, reject) => (this.stuck = (error) => (this.interrupt(), reject(new Error(error)))))
        return Promise.race([this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }, ...images64] }), stuck])
      })
      .finally(() => ((this.stuck = () => {}), this.reviews.forEach((done) => done())))
      .then((r) => this.host.ended(r.stopReason === 'refusal' ? { error: 'The agent refused this request.' } : { text: r.stopReason === 'cancelled' ? '' : this.text }))
      .catch((e: Error) => {
        if (e instanceof RpcError && e.code === -32000 && /auth/i.test(e.message)) return this.host.ended({ error: `${e.message} Sign in with the agent's CLI first.` })
        const error = e instanceof RpcError && typeof e.data === 'string' ? `${e.message}: ${e.data}` : e.message
        // OpenCode does not tell when a usage limit resets.
        this.host.ended({ error, resetsAt: OPENCODE_LIMIT.test(error) ? Date.now() + GUESS_MS : null })
      })
  }

  interrupt() {
    if (this.sessionId) this.rpc.notify('session/cancel', { sessionId: this.sessionId })
  }

  end() {
    this.stopping = true
    this.rpc.end()
  }

  kill() {
    this.stopping = true
    this.rpc.kill()
  }

  private onNotification(method: string, params: any) {
    if (method !== 'session/update' || this.loading || params?.sessionId !== this.sessionId) return
    const u = params.update
    const { activity } = this.host
    const kind = u.sessionUpdate
    if (kind === 'agent_message_chunk') {
      if (u.content?.type === 'text') this.text += u.content.text
      this.thinking = false
    } else if (kind === 'agent_thought_chunk') {
      if (!this.thinking) activity.instant('thinking', 'Thinking')
      this.thinking = true
    } else if (kind === 'tool_call') {
      activity.start(u.toolCallId, u.kind === 'execute' ? 'command' : u.kind === 'edit' ? 'edit' : 'note', u.title ?? summarize(u.rawInput))
      const steps = todoSteps(u.rawInput)
      if (steps) this.host.plan.steps(steps)
      if (['completed', 'failed', 'cancelled'].includes(u.status)) activity.finish(u.toolCallId)
    } else if (kind === 'tool_call_update') {
      this.reviews.get(u.toolCallId)?.()
      const steps = todoSteps(u.rawInput)
      if (steps) this.host.plan.steps(steps)
      if (['completed', 'failed', 'cancelled'].includes(u.status)) activity.finish(u.toolCallId)
    } else if (kind === 'usage_update') {
      if (u.used) this.host.context(u.used, u.size)
      // The session's cost so far.
      if (u.cost?.currency === 'USD') this.host.spent({ usd: u.cost.amount })
    } else if (kind === 'plan') {
      this.host.plan.steps((u.entries ?? []).map((e: any) => ({ text: e.content, status: e.status === 'in_progress' ? 'active' : e.status === 'completed' ? 'done' : 'pending' })))
    }
  }

  private async onRequest(method: string, params: any): Promise<unknown> {
    if (method === 'session/request_permission') {
      const options = (params.options ?? []).map((o: any) => ({ id: o.optionId, label: o.name, kind: String(o.kind).startsWith('allow') ? 'allow' : 'deny' }))
      const call = params.toolCall ?? {}
      if (this.reviewer && (await this.reviewed(call.toolCallId))) return { outcome: { outcome: 'cancelled' } }
      const choice = await this.host.approve({ title: call.title ?? 'Allow this action?', detail: summarize(call.rawInput ?? call.content ?? ''), options })
      return { outcome: { outcome: 'selected', optionId: choice } }
    }
    throw new RpcError(`Savor does not provide ${method}.`, -32601)
  }

  // Whether the plugin has answered: the tool call it was asked for goes on or fails. OpenCode then ignores this
  // answer. Without one in REVIEW_MS (the plugin gives a review up to a minute) the user decides.
  private reviewed(id: string) {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => done(false), REVIEW_MS)
      const done = (ok: boolean) => {
        clearTimeout(timer)
        this.reviews.delete(id)
        resolve(ok)
      }
      this.reviews.set(id, () => done(true))
    })
  }
}

const REVIEW_MS = 120_000

// The limits of OpenCode's own models (the free ones, Go, Zen) and of the providers behind it, not their rate limits,
// which OpenCode retries itself. It says only "Free usage limit reached" so far, and no reset.
const OPENCODE_LIMIT = /usage limit|quota|credits|\b402\b|insufficient (balance|funds)/i
const GUESS_MS = 60 * 60_000

// The error OpenCode logs when the model's API failed a prompt of this session at a usage limit, e.g.
// message="stream error" … session.id=ses_… error.error="AI_APICallError: Free usage limit reached. …"
export function stuckOn(line: string, sessionId: string) {
  if (!sessionId || !line.includes('message="stream error"') || !line.split(' ').includes(`session.id=${sessionId}`)) return null
  const error = line.match(/error\.error="((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, '$1').replace(/^AI_\w+: /, '')
  return error && OPENCODE_LIMIT.test(error) ? error : null
}

// OpenCode names a model's reasoning effort as a variant of it: "opencode/big-pickle/high".
const withEffort = (model: string, effort: string) => (model && effort ? `${model}/${effort}` : model)

// A short agent process for a question outside a conversation. `ask` passes `onUpdate` a handler for its session/update notifications.
async function oneShot<T>(cwd: string, ask: (rpc: Rpc, init: any, onUpdate: (fn: (u: any) => void) => void) => Promise<T>, timeout = 180_000) {
  const cmd = acpCommand('', '')
  const child = spawn(...command(cmd.bin, cmd.args), { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let update = (_: any) => {}
  const rpc = new Rpc(child, { notification: (m, params) => m === 'session/update' && update(params.update), request: async () => ({ outcome: { outcome: 'cancelled' } }) })
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${cmd.bin} did not answer in time.`)), timeout)))
  try {
    const init = rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'savor', version: VERSION } })
    return await Promise.race([init.then((r) => ask(rpc, r, (fn) => (update = fn))), late])
  } finally {
    clearTimeout(timer)
    rpc.end()
  }
}

// Sessions Savor only opened to ask something are removed again, so they don't show up in OpenCode's list.
const discard = (sessionId: string) => execFile(...command(BIN.opencode, ['session', 'delete', sessionId]), () => {})

// The commands and skills an agent offers in a folder, as it announces them to a new session.
export function acpSkills(cwd: string) {
  return oneShot<SkillInfo[]>(
    cwd,
    async (rpc, _, onUpdate) => {
      const announced = new Promise<any[]>((resolve) => {
        onUpdate((u) => u.sessionUpdate === 'available_commands_update' && resolve(u.availableCommands ?? []))
        setTimeout(() => resolve([]), 5000)
      })
      const { sessionId } = await rpc.request('session/new', { cwd, mcpServers: [] })
      const commands = await announced
      discard(sessionId)
      return commands.map((c) => ({ name: c.name, description: c.description ?? '' }))
    },
    30_000,
  )
}

// A side question (/btw) goes to a fork of the conversation's session in plan mode, which is removed afterwards.
export function acpAside(cwd: string, sid: string | undefined, model: string, prompt: string) {
  return oneShot(cwd, async (rpc, init, onUpdate) => {
    let text = ''
    onUpdate((u) => u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && (text += u.content.text))
    const forked = sid && init.agentCapabilities?.sessionCapabilities?.fork
    const session = forked ? await rpc.request('session/fork', { sessionId: sid, cwd, mcpServers: [] }) : await rpc.request('session/new', { cwd, mcpServers: [] })
    try {
      if (!session.modes || session.modes.availableModes?.some((m: any) => m.id === 'plan')) await rpc.request('session/set_mode', { sessionId: session.sessionId, modeId: 'plan' }).catch(() => {})
      if (model) await rpc.request('session/set_model', { sessionId: session.sessionId, modelId: model }).catch(() => {})
      // A fork replays the history it copied; only the answer counts.
      text = ''
      await rpc.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] })
      if (!text.trim()) throw new Error('The agent gave no answer.')
      return text.trim()
    } finally {
      discard(session.sessionId)
    }
  })
}
