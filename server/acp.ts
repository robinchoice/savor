// Agents that speak the Agent Client Protocol (OpenCode, Grok Build, Gemini CLI): one agent process per
// conversation, prompts via session/prompt, progress via session/update, approvals via
// session/request_permission.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as store from './store.js'
import type { Provider, Thread } from './store.js'
import { BIN, command, mcpUrl, VERSION } from './config.js'
import { Rpc, RpcError } from './jsonrpc.js'
import { configKey, forkOf, rememberSession, sessionIdOf, summarize, systemPrompt, type Host, type Session, type TurnInput } from './session.js'
import type { SkillInfo } from './providers.js'

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

export function acpCommand(provider: Provider, projectId: string, threadId: string) {
  const savor = { url: mcpUrl(projectId, threadId), headers: { Authorization: `Bearer ${store.state().mcpToken}` } }
  if (provider === 'opencode') {
    return {
      bin: BIN.opencode,
      args: ['acp'],
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: 'disabled', mcp: { savor: { type: 'remote', ...savor, enabled: true } } }) },
    }
  }
  if (provider === 'gemini') return { bin: BIN.gemini, args: ['--acp'], env: {} }
  return { bin: BIN.grok, args: ['--no-auto-update', 'agent', '--no-leader', 'stdio'], env: {} }
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
    const cmd = acpCommand(thread.agent.provider, p.id, thread.id)
    const child = spawn(...command(cmd.bin, cmd.args), { cwd: host.cwd, env: { ...process.env, ...cmd.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.rpc = new Rpc(child, { notification: (m, params) => this.onNotification(m, params), request: (m, params) => this.onRequest(m, params) })
    this.rpc.exited.then(({ code, signal }) => host.closed(this.stopping || signal === 'SIGTERM' ? 'Turn stopped.' : `${cmd.bin} exited with ${code}: ${this.rpc.stderrTail}`))
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
    if (a.permissionMode && session.modes?.availableModes?.some((m: any) => m.id === a.permissionMode) && session.modes.currentModeId !== a.permissionMode)
      await this.rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: a.permissionMode }).catch(() => {})
    const model = withEffort(a.provider, a.model || (a.reasoning ? session.models?.currentModelId : ''), a.reasoning)
    if (model) await this.rpc.request('session/set_model', { sessionId: this.sessionId, modelId: model }).catch(() => {})
  }

  start({ context, input, images }: TurnInput) {
    this.text = ''
    const images64 = images.map((file) => ({ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: MIME[path.extname(file).slice(1).toLowerCase()] ?? 'image/png' }))
    this.ready
      .then(() => {
        // ACP has no system prompt: the protocol goes in front of the first prompt of a session.
        const text = this.fresh ? `${systemPrompt(this.host.p, store.getThread(this.host.p, this.host.tid))}\n\n${context}${input}` : context + input
        this.fresh = false
        return this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }, ...images64] })
      })
      .then((r) => this.host.ended(r.stopReason === 'refusal' ? { error: 'The agent refused this request.' } : { text: r.stopReason === 'cancelled' ? '' : this.text }))
      .catch((e: Error) => this.host.ended({ error: e instanceof RpcError && e.code === -32000 && /auth/i.test(e.message) ? `${e.message} Sign in with the agent's CLI first.` : e.message }))
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
      const type = u.kind === 'execute' ? 'command' : u.kind === 'edit' ? 'edit' : 'note'
      activity.start(u.toolCallId, type, u.title ?? summarize(u.rawInput))
      if (['completed', 'failed', 'cancelled'].includes(u.status)) activity.finish(u.toolCallId)
    } else if (kind === 'tool_call_update') {
      if (['completed', 'failed', 'cancelled'].includes(u.status)) activity.finish(u.toolCallId)
    } else if (kind === 'usage_update') {
      if (u.used) this.host.context(u.used, u.size)
    } else if (kind === 'plan') {
      activity.instant('note', `Plan · ${(u.entries ?? []).map((e: any) => e.content).join(' · ')}`)
    }
  }

  private async onRequest(method: string, params: any): Promise<unknown> {
    if (method === 'session/request_permission') {
      const options = (params.options ?? []).map((o: any) => ({ id: o.optionId, label: o.name, kind: String(o.kind).startsWith('allow') ? 'allow' : 'deny' }))
      const call = params.toolCall ?? {}
      const choice = await this.host.approve({ title: call.title ?? 'Allow this action?', detail: summarize(call.rawInput ?? call.content ?? ''), options })
      return { outcome: { outcome: 'selected', optionId: choice } }
    }
    throw new RpcError(`Savor does not provide ${method}.`, -32601)
  }
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
      if (session.modes?.availableModes?.some((m: any) => m.id === 'plan')) await rpc.request('session/set_mode', { sessionId: session.sessionId, modeId: 'plan' }).catch(() => {})
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
