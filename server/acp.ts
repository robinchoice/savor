// Agents that speak the Agent Client Protocol (OpenCode, Grok Build): one agent process per
// conversation, prompts via session/prompt, progress via session/update, approvals via
// session/request_permission.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as store from './store.js'
import type { Provider, Thread } from './store.js'
import { BIN, command, mcpUrl } from './config.js'
import { Rpc, RpcError } from './jsonrpc.js'
import { configKey, rememberSession, sessionIdOf, summarize, systemPrompt, type Host, type Session, type TurnInput } from './session.js'

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
  return { bin: BIN.grok, args: ['--no-auto-update', 'agent', '--no-leader', 'stdio'], env: {} }
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
      clientInfo: { name: 'savor', version: '0.5.4' },
    })
    const mcpServers = [{ type: 'http', name: 'savor', url: mcpUrl(p.id, tid), headers: [{ name: 'Authorization', value: `Bearer ${store.state().mcpToken}` }] }]
    const sid = sessionIdOf(this.thread, a.provider)
    let session: any = null
    if (sid && init.agentCapabilities?.loadSession) {
      this.loading = true
      session = await this.rpc.request('session/load', { sessionId: sid, cwd: this.host.cwd, mcpServers }).catch(() => null)
      this.loading = false
      if (session) session.sessionId = sid
    }
    if (!session) session = await this.rpc.request('session/new', { cwd: this.host.cwd, mcpServers })
    this.sessionId = session.sessionId
    rememberSession(p, tid, a.provider, this.sessionId)
    if (a.permissionMode && session.modes?.availableModes?.some((m: any) => m.id === a.permissionMode) && session.modes.currentModeId !== a.permissionMode)
      await this.rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: a.permissionMode }).catch(() => {})
    if (a.model) await this.rpc.request('session/set_model', { sessionId: this.sessionId, modelId: a.model }).catch(() => {})
  }

  start({ prompt, images }: TurnInput) {
    this.text = ''
    // ACP has no system prompt: the protocol goes in front of the first prompt of a session.
    const first = !sessionIdOf(this.thread, this.thread.agent.provider)
    const content = [
      { type: 'text', text: first ? `${systemPrompt(this.host.p, this.thread)}\n\n${prompt}` : prompt },
      ...images.map((file) => ({ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: MIME[path.extname(file).slice(1).toLowerCase()] ?? 'image/png' })),
    ]
    this.ready
      .then(() => this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt: content }))
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
