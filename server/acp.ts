// Agents that speak the Agent Client Protocol (OpenCode, Grok Build): one agent process per
// conversation, prompts via session/prompt, progress via session/update, approvals via
// session/request_permission.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as store from './store.js'
import type { ApprovalOption, Provider, Thread } from './store.js'
import { BIN, command, mcpUrl, VERSION } from './config.js'
import { Rpc, RpcError } from './jsonrpc.js'
import { configKey, forkOf, rememberSession, sessionIdOf, STOPPED, summarize, systemPrompt, type Host, type Session, type TurnInput } from './session.js'
import type { SkillInfo } from './providers.js'

const PLAN_DECISION: ApprovalOption[] = [
  { id: 'approved', label: 'Approve', kind: 'allow' },
  { id: 'changes_requested', label: 'Keep planning', kind: 'deny' },
]

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

export function acpCommand(provider: Provider, projectId: string, threadId: string, mode = '') {
  const savor = { url: mcpUrl(projectId, threadId), headers: { Authorization: `Bearer ${store.state().mcpToken}` } }
  if (provider === 'opencode') {
    return {
      bin: BIN.opencode,
      args: ['acp'],
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: 'disabled', mcp: { savor: { type: 'remote', ...savor, enabled: true } } }) },
    }
  }
  // Grok Build takes only plan as a mode over ACP; approving everything is a flag of the agent process.
  return { bin: BIN.grok, args: ['--no-auto-update', 'agent', ...(mode === 'always-approve' ? ['--always-approve'] : []), '--no-leader', 'stdio'], env: {} }
}

export class AcpSession implements Session {
  readonly config: string
  private rpc: Rpc
  private ready: Promise<void>
  private sessionId = ''
  // Whether the session is new, so the first prompt carries Savor's protocol.
  private fresh = true
  private loading = false
  private text = ''
  private thinking = false
  private stopping = false

  constructor(private host: Host, private thread: Thread) {
    const { p } = host
    this.config = configKey(thread.agent)
    const cmd = acpCommand(thread.agent.provider, p.id, thread.id, thread.agent.permissionMode)
    const child = spawn(...command(cmd.bin, cmd.args), { cwd: host.cwd, env: { ...process.env, ...cmd.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.rpc = new Rpc(child, { notification: (m, params) => this.onNotification(m, params), request: (m, params) => this.onRequest(m, params) })
    this.rpc.exited.then(({ code, signal }) => host.closed(this.stopping || signal === 'SIGTERM' ? STOPPED : `${cmd.bin} exited with ${code}: ${this.rpc.stderrTail}`))
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
    this.fresh = !session
    if (!session) session = await this.rpc.request('session/new', { cwd: this.host.cwd, mcpServers })
    this.sessionId = session.sessionId
    rememberSession(p, tid, a.provider, this.sessionId)
    // Grok Build takes a mode without announcing its modes.
    const modes = session.modes
    if (a.permissionMode && (!modes || (modes.currentModeId !== a.permissionMode && modes.availableModes?.some((m: any) => m.id === a.permissionMode))))
      await this.rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: a.permissionMode }).catch(() => {})
    const model = withEffort(a.provider, a.model || (a.reasoning ? session.models?.currentModelId : ''), a.reasoning)
    if (model) await this.rpc.request('session/set_model', { sessionId: this.sessionId, modelId: model }).catch(() => {})
    // Grok Build takes the effort as a config option of the session.
    const effort = session.configOptions?.find((o: any) => o.category === 'thought_level')
    if (a.reasoning && effort?.currentValue !== a.reasoning && effort?.options?.some((o: any) => o.value === a.reasoning))
      await this.rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: effort.id, value: a.reasoning }).catch(() => {})
    if (a.model || session.models?.currentModelId) this.host.model(a.model || session.models.currentModelId)
  }

  start({ context, input, images }: TurnInput) {
    this.text = ''
    const images64 = images.map((file) => ({ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: MIME[path.extname(file).slice(1).toLowerCase()] ?? 'image/png' }))
    this.ready
      .then(() => {
        // ACP has no system prompt: the protocol goes in front of the first prompt of a session. Later a slash
        // command goes alone, since the agent runs one only at the very start of a prompt.
        const text = this.fresh ? `${systemPrompt(this.host.p, store.getThread(this.host.p, this.host.tid))}\n\n${context}${input}` : input.startsWith('/') ? input : context + input
        this.fresh = false
        return this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }, ...images64] })
      })
      .then((r) => this.host.ended(r.stopReason === 'refusal' ? { error: 'The agent refused this request.' } : { text: r.stopReason === 'cancelled' ? '' : this.text }))
      .catch(async (e: Error) => {
        if (e instanceof RpcError && e.code === -32000 && /auth/i.test(e.message)) return this.host.ended({ error: `${e.message} Sign in with the agent's CLI first.` })
        // Grok Build answers "Internal error" and puts what went wrong in the error's data.
        const error = e instanceof RpcError && typeof e.data === 'string' ? `${e.message}: ${e.data}` : e.message
        // Grok Build reports the usage period its limit belongs to on _x.ai/billing; other agents don't have it,
        // and an agent that has exited never answers.
        const billing = LIMIT.test(error) ? await Promise.race([this.rpc.request('_x.ai/billing', {}), new Promise((r) => setTimeout(r, 10_000))]).catch(() => null) : null
        this.host.ended({ error, resetsAt: acpResets(billing) })
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
      // Grok Build titles a call with its tool's name; the kind and the command or MCP tool come in its _meta and input.
      const grok = u._meta?.['x.ai/tool']
      if (grok) activity.tool(u.toolCallId, grok.kind === 'execute' ? 'command' : grok.kind === 'edit' ? 'edit' : String(u.rawInput?.tool_name ?? grok.name).replace(/^savor__/, ''), u.rawInput?.tool_input ?? u.rawInput)
      else activity.start(u.toolCallId, u.kind === 'execute' ? 'command' : u.kind === 'edit' ? 'edit' : 'note', u.title ?? summarize(u.rawInput))
      if (['completed', 'failed', 'cancelled'].includes(u.status)) activity.finish(u.toolCallId)
    } else if (kind === 'tool_call_update') {
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
      // Grok Build asks before every MCP tool, Savor's own included; those never need the user.
      const once = (params.options ?? []).find((o: any) => o.kind === 'allow_once')
      if (once && call.rawInput?.variant === 'UseTool' && String(call.rawInput.tool_name).startsWith('savor__')) return { outcome: { outcome: 'selected', optionId: once.optionId } }
      const choice = await this.host.approve({ title: call.title ?? 'Allow this action?', detail: summarize(call.rawInput ?? call.content ?? ''), options })
      return { outcome: { outcome: 'selected', optionId: choice } }
    }
    // Grok Build ends a plan with this. An outcome other than approved or abandoned asks for changes; Grok then asks the user what to change.
    if (method === '_x.ai/exit_plan_mode') {
      const choice = await this.host.approve({ title: 'Approve this plan?', detail: String(params.planContent ?? ''), options: PLAN_DECISION })
      return { outcome: choice }
    }
    throw new RpcError(`Savor does not provide ${method}.`, -32601)
  }
}

// The usage limits Grok Build stops at, as its own UI tells them apart: 402, credits, the weekly or free usage
// limit, the spending cap. A rate limit (429) passes within a minute and is no reason to wait for the period.
const LIMIT = /\b402\b|credits|usage (limit|balance)|weekly limit|spending (limit|cap)/i

// When the usage period of a _x.ai/billing answer ends, unless it still has credit left.
export function acpResets(billing: any, now = Date.now()) {
  const c = billing?.config
  if (c?.creditUsagePercent < 100) return null
  const end = Date.parse(c?.currentPeriod?.end ?? c?.billingPeriodEnd ?? '')
  return end > now ? end : null
}

// OpenCode names a model's reasoning effort as a variant of it: "opencode/big-pickle/high".
const withEffort = (provider: Provider, model: string, effort: string) => (model && effort && provider === 'opencode' ? `${model}/${effort}` : model)

// A short agent process for a question outside a conversation. `ask` passes `onUpdate` a handler for its session/update notifications.
async function oneShot<T>(provider: Provider, cwd: string, ask: (rpc: Rpc, init: any, onUpdate: (fn: (u: any) => void) => void) => Promise<T>, timeout = 180_000) {
  const cmd = acpCommand(provider, '', '')
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
const discard = (provider: Provider, sessionId: string) => provider === 'opencode' && execFile(...command(BIN.opencode, ['session', 'delete', sessionId]), () => {})

// The commands and skills an agent offers in a folder, as it announces them to a new session.
export function acpSkills(provider: Provider, cwd: string) {
  return oneShot<SkillInfo[]>(
    provider,
    cwd,
    async (rpc, _, onUpdate) => {
      const announced = new Promise<any[]>((resolve) => {
        onUpdate((u) => u.sessionUpdate === 'available_commands_update' && resolve(u.availableCommands ?? []))
        setTimeout(() => resolve([]), 5000)
      })
      const { sessionId } = await rpc.request('session/new', { cwd, mcpServers: [] })
      const commands = await announced
      discard(provider, sessionId)
      return commands.map((c) => ({ name: c.name, description: c.description ?? '' }))
    },
    30_000,
  )
}

// A side question (/btw) goes to a fork of the conversation's session in plan mode, which is removed afterwards.
export function acpAside(provider: Provider, cwd: string, sid: string | undefined, model: string, prompt: string) {
  return oneShot(provider, cwd, async (rpc, init, onUpdate) => {
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
      discard(provider, session.sessionId)
    }
  })
}
