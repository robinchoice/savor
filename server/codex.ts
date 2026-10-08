// Codex: one `codex app-server` (JSON-RPC over stdio) per conversation. Turns are started with
// turn/start; approvals and clarifying questions arrive as server requests.
import { spawn } from 'node:child_process'
import * as store from './store.js'
import type { ApprovalOption, Thread } from './store.js'
import { BIN, command, mcpUrl, VERSION } from './config.js'
import { Rpc } from './jsonrpc.js'
import { configKey, forkOf, OPEN_PAGE, rememberSession, sessionIdOf, summarize, systemPrompt, webUrl, type Host, type Session, type TurnInput } from './session.js'
import type { ModelInfo, SkillInfo } from './providers.js'

const MODES: Record<string, { sandbox: string; approvalPolicy: string; approvalsReviewer: string }> = {
  'read-only': { sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  default: { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  'auto-review': { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
  'full-access': { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' },
}

const CLIENT = { name: 'savor', title: 'Savor', version: VERSION }
const CAPABILITIES = { experimentalApi: true, requestAttestation: false }

function spawnAppServer(projectId?: string, threadId?: string) {
  const args = ['app-server']
  if (projectId && threadId) args.push('-c', `mcp_servers.savor.url=${JSON.stringify(mcpUrl(projectId, threadId))}`, '-c', 'mcp_servers.savor.bearer_token_env_var="SAVOR_MCP_TOKEN"')
  return spawn(...command(BIN.codex, args), { env: { ...process.env, SAVOR_MCP_TOKEN: store.state().mcpToken }, stdio: ['pipe', 'pipe', 'pipe'] })
}

// The skills Codex finds for a folder: its own, the user's and the repository's.
const skillsIn = async (rpc: Rpc, cwd: string) =>
  (((await rpc.request('skills/list', { cwds: [cwd] })).data[0]?.skills ?? []) as { name: string; description: string; path: string; enabled: boolean }[]).filter((s) => s.enabled)

// Codex's own commands, as its TUI offers them. Savor runs them through the app-server methods behind them.
const COMMANDS: SkillInfo[] = [
  { name: 'review', description: 'Review the uncommitted changes, or what the text after the command asks for' },
  { name: 'compact', description: 'Summarize the conversation so far to free up context' },
  { name: 'goal', description: 'Work on a goal across turns until it is met; /goal alone shows it, /goal clear drops it' },
]

const ALLOW_SESSION_DENY: ApprovalOption[] = [
  { id: 'accept', label: 'Allow', kind: 'allow' },
  { id: 'acceptForSession', label: 'Allow for this session', kind: 'allow' },
  { id: 'decline', label: 'Deny', kind: 'deny' },
]

export class CodexSession implements Session {
  readonly config: string
  private rpc: Rpc
  private ready: Promise<void>
  // The current input's way to its turn: input added right at the start waits for the turn to exist.
  private starting: Promise<unknown> = Promise.resolve()
  private threadId = ''
  private turnId: string | null = null
  private lastText = ''
  private failure: string | null = null
  private limited = false
  private stopping = false
  // Codex works on an active goal turn after turn by itself; the request ends once the goal does.
  private goal = false

  constructor(private host: Host, private thread: Thread) {
    const { p } = host
    this.config = configKey(thread.agent)
    const child = spawnAppServer(p.id, thread.id)
    this.rpc = new Rpc(child, { notification: (m, params) => this.onNotification(m, params), request: (m, params) => this.onRequest(m, params) })
    this.rpc.exited.then(({ code, signal }) => host.closed(this.stopping || signal === 'SIGTERM' ? 'Turn stopped.' : `codex exited with ${code}: ${this.rpc.stderrTail}`))
    this.ready = this.init()
  }

  private async init() {
    const { p, tid } = this.host
    const a = this.thread.agent
    await this.rpc.request('initialize', { clientInfo: CLIENT, capabilities: CAPABILITIES })
    this.rpc.notify('initialized', {})
    const mode = MODES[a.permissionMode] ?? MODES.default
    const settings = { cwd: this.host.cwd, ...mode, model: a.model || null, developerInstructions: systemPrompt(p, this.thread) }
    const sid = sessionIdOf(this.thread, 'codex')
    const fork = forkOf(p, this.thread, 'codex')
    const r = sid
      ? await this.rpc.request('thread/resume', { threadId: sid, ...settings }).catch(() => this.rpc.request('thread/start', settings))
      : await this.rpc.request(fork ? 'thread/fork' : 'thread/start', { ...(fork && { threadId: fork }), ...settings })
    this.threadId = r.thread.id
    rememberSession(p, tid, 'codex', this.threadId)
  }

  start({ context, input, images }: TurnInput) {
    this.lastText = ''
    this.failure = null
    this.limited = false
    const items: unknown[] = [{ type: 'text', text: context + input, text_elements: [] }, ...images.map((path) => ({ type: 'localImage', path }))]
    const [, name, arg = ''] = input.match(/^\/(\S+)\s*([\s\S]*)$/) ?? []
    const effort = this.thread.agent.reasoning || null
    this.starting = this.ready
      .then(async () => {
        if (input.startsWith('!')) return void (await this.rpc.request('thread/shellCommand', { threadId: this.threadId, command: input.slice(1).trim() }))
        if (name === 'review') return void (await this.rpc.request('review/start', { threadId: this.threadId, target: arg.trim() ? { type: 'custom', instructions: arg.trim() } : { type: 'uncommittedChanges' } }))
        if (name === 'compact') return void (await this.rpc.request('thread/compact/start', { threadId: this.threadId }))
        if (name === 'goal') return this.goalCommand(arg.trim())
        // A slash command that names a skill hands Codex the skill itself, as a $mention does in its own UI.
        const skill = name && (await skillsIn(this.rpc, this.host.cwd)).find((s) => s.name === name)
        if (skill) items.push({ type: 'skill', name: skill.name, path: skill.path })
        const r = await this.rpc.request('turn/start', { threadId: this.threadId, input: items, ...(effort && { effort }) })
        this.turnId = r.turn.id
      })
      .catch((e: Error) => this.host.ended({ error: e.message }))
  }

  async steer({ text, images }: { text: string; images: string[] }) {
    await this.starting
    if (!this.turnId) return false
    const input = [{ type: 'text', text, text_elements: [] }, ...images.map((path) => ({ type: 'localImage', path }))]
    return this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input }).then(
      () => true,
      () => false,
    )
  }

  // "/goal <objective>" sets a goal Codex starts on by itself; "/goal" shows it and "/goal clear" drops it,
  // which take no turn. Codex passes goal edits on to the model as the user's only with the origin "user".
  private async goalCommand(arg: string) {
    if (arg && arg !== 'clear') return void (await this.rpc.request('thread/goal/set', { threadId: this.threadId, objective: arg, status: 'active', origin: 'user' }))
    if (arg === 'clear') {
      await this.rpc.request('thread/goal/clear', { threadId: this.threadId, origin: 'user' })
      return this.host.ended({ text: 'Goal cleared.' })
    }
    const { goal } = await this.rpc.request('thread/goal/get', { threadId: this.threadId })
    this.host.ended({ text: goal ? `Goal (${goal.status}): ${goal.objective}` : 'No goal set.' })
  }

  interrupt() {
    if (this.goal) this.rpc.request('thread/goal/set', { threadId: this.threadId, status: 'paused', origin: 'user' }).catch(() => {})
    if (this.turnId) this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
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
    const { activity } = this.host
    if (params?.threadId && params.threadId !== this.threadId) return
    if (method === 'turn/started') {
      // Commands and goals start their turns themselves.
      this.turnId = params.turn.id
      this.host.working()
    } else if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') {
      const was = this.goal
      this.goal = params.goal?.status === 'active'
      if (was && !this.goal && !this.turnId) this.host.ended({ text: this.lastText })
    }
    else if (method === 'thread/tokenUsage/updated') this.host.context(params.tokenUsage.last.totalTokens, params.tokenUsage.modelContextWindow)
    else if (method === 'item/started') {
      const item = params.item
      if (item.type === 'commandExecution') activity.start(item.id, 'command', item.command)
      else if (item.type === 'mcpToolCall') activity.start(item.id, 'note', `${item.tool} · ${summarize(item.arguments)}`)
      else if (item.type === 'dynamicToolCall') activity.start(item.id, 'note', `${item.tool} · ${summarize(item.arguments)}`)
      else if (item.type === 'webSearch') activity.start(item.id, 'note', `Web search · ${item.query ?? ''}`)
      else if (item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall') activity.start(item.id, 'note', `Subagent · ${item.kind ?? item.tool ?? ''}`)
    } else if (method === 'item/completed') {
      const item = params.item
      activity.finish(item.id)
      if (item.type === 'mcpToolCall' && item.error) activity.instant('note', `${item.tool} failed · ${summarize(item.error.message ?? item.error)}`)
      if (item.type === 'agentMessage' && item.text?.trim()) activity.instant('note', (this.lastText = item.text))
      else if (item.type === 'exitedReviewMode' && item.review?.trim()) this.lastText = item.review
      else if (item.type === 'contextCompaction') this.lastText = 'Context compacted.'
      else if (item.type === 'commandExecution' && item.source === 'userShell') this.lastText = `\`\`\`\n$ ${item.command}\n${(item.aggregatedOutput ?? '').trimEnd()}\n\`\`\``
      else if (item.type === 'reasoning') activity.instant('thinking', 'Thinking')
      else if (item.type === 'fileChange') activity.instant('edit', `edit · ${(item.changes ?? []).map((c: any) => c.path).join(', ')}`)
    } else if (method === 'error') {
      if (!params.willRetry) this.failure = params.error?.message ?? 'Codex reported an error.'
      this.limited ||= usageLimit(params.error)
    } else if (method === 'turn/completed') {
      const turn = params.turn
      this.turnId = null
      if (turn.status === 'completed' && this.goal) return
      if (turn.status !== 'failed') return this.host.ended({ text: turn.status === 'interrupted' ? '' : this.lastText })
      const error = turn.error?.message ?? this.failure ?? 'Codex turn failed.'
      if (!this.limited && !usageLimit(turn.error)) return this.host.ended({ error })
      // The error names the reset only in words; the account's rate limits have it as a time.
      codexUsage()
        .then((limits) => resetOf(limits))
        .catch(() => null)
        .then((resetsAt) => this.host.ended({ error, resetsAt }))
    }
  }

  private async onRequest(method: string, params: any): Promise<unknown> {
    if (method === 'item/commandExecution/requestApproval') {
      const detail = [params.command, params.cwd && `in ${params.cwd}`, params.reason].filter(Boolean).join('\n')
      const decision = await this.host.approve({ title: 'Run this command?', detail, options: ALLOW_SESSION_DENY })
      return { decision }
    }
    if (method === 'item/fileChange/requestApproval') {
      const detail = [params.reason, params.grantRoot && `Write access to ${params.grantRoot}`].filter(Boolean).join('\n') || 'Codex wants to change files.'
      const decision = await this.host.approve({ title: 'Allow these file changes?', detail, options: ALLOW_SESSION_DENY })
      return { decision }
    }
    if (method === 'item/permissions/requestApproval') {
      const options: ApprovalOption[] = [
        { id: 'turn', label: 'Allow for this turn', kind: 'allow' },
        { id: 'session', label: 'Allow for this session', kind: 'allow' },
        { id: 'decline', label: 'Deny', kind: 'deny' },
      ]
      const choice = await this.host.approve({ title: 'Allow additional access?', detail: params.reason ?? JSON.stringify(params.permissions), options })
      if (choice === 'decline') return { permissions: {}, scope: 'turn' }
      const granted: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(params.permissions ?? {})) if (v != null) granted[k] = v
      return { permissions: granted, scope: choice }
    }
    if (method === 'mcpServer/elicitation/request' && params.mode === 'url') {
      const url = webUrl(params.url)
      if (!url) throw new Error('Savor opens only http and https pages.')
      const choice = await this.host.approve({ title: `${params.serverName} asks you to open a page`, detail: params.message ?? '', url, options: OPEN_PAGE })
      return { action: choice, content: null, _meta: null }
    }
    if (method === 'mcpServer/elicitation/request') {
      const meta = params._meta ?? {}
      if (meta.codex_approval_kind !== 'mcp_tool_call') throw new Error('Savor does not answer MCP elicitation forms.')
      // Savor's own tools (messages, documents, workflows, preview) never need a prompt.
      if (params.serverName === 'savor') return { action: 'accept', content: {}, _meta: { persist: 'session' } }
      const persist: string[] = Array.isArray(meta.persist) ? meta.persist : []
      const options: ApprovalOption[] = [
        { id: 'accept', label: 'Allow', kind: 'allow' },
        ...(persist.includes('session') ? [{ id: 'session', label: 'Allow for this session', kind: 'allow' as const }] : []),
        ...(persist.includes('always') ? [{ id: 'always', label: 'Always allow', kind: 'allow' as const }] : []),
        { id: 'decline', label: 'Deny', kind: 'deny' },
      ]
      const tool = meta.tool_params_display ? `${params.serverName}: ${meta.tool_description ?? ''}` : params.serverName
      const choice = await this.host.approve({ title: params.message ?? `Allow the ${params.serverName} MCP server to run a tool?`, detail: `${tool}\n${JSON.stringify(meta.tool_params ?? {}, null, 2).slice(0, 1200)}`, options })
      if (choice === 'decline') return { action: 'decline', content: null, _meta: null }
      return { action: 'accept', content: {}, _meta: choice === 'accept' ? null : { persist: choice } }
    }
    if (method === 'item/tool/requestUserInput') {
      const qs = (params.questions ?? []) as { id: string; header: string; question: string; options: { label: string }[] | null }[]
      const answers = await this.host.ask(qs.map((q) => ({ title: q.question, body: '', options: q.options?.map((o) => o.label) ?? [] })))
      const out: Record<string, { answers: string[] }> = {}
      qs.forEach((q, i) => {
        const a = answers[i]
        out[q.id] = { answers: [a.selected != null ? q.options?.[a.selected]?.label ?? '' : a.answer ?? ''] }
      })
      return { answers: out }
    }
    throw new Error(`Savor does not handle ${method}.`)
  }
}

// A side question (/btw): an ephemeral fork of the session answers once in a read-only sandbox. The
// conversation itself, also a turn that is running, stays as it is.
export async function codexAside(cwd: string, sid: string | undefined, model: string, prompt: string) {
  let text = ''
  let settle: { resolve: (t: string) => void; reject: (e: Error) => void }
  const answered = new Promise<string>((resolve, reject) => (settle = { resolve, reject }))
  const rpc = new Rpc(spawnAppServer(), {
    notification: (method, params) => {
      if (method === 'item/completed' && params.item?.type === 'agentMessage') text = params.item.text
      if (method === 'turn/completed') params.turn.status === 'completed' ? settle.resolve(text) : settle.reject(new Error(params.turn.error?.message ?? 'Codex did not answer.'))
    },
    request: async () => ({ decision: 'decline', action: 'decline' }),
  })
  const timer = setTimeout(() => settle.reject(new Error('Codex did not answer in time.')), 180_000)
  try {
    await rpc.request('initialize', { clientInfo: CLIENT, capabilities: CAPABILITIES })
    rpc.notify('initialized', {})
    const settings = { cwd, sandbox: 'read-only', approvalPolicy: 'never', model: model || null, ephemeral: true }
    const r = sid ? await rpc.request('thread/fork', { threadId: sid, ...settings }) : await rpc.request('thread/start', settings)
    await rpc.request('turn/start', { threadId: r.thread.id, input: [{ type: 'text', text: prompt, text_elements: [] }] })
    return await answered
  } finally {
    clearTimeout(timer)
    rpc.end()
  }
}

// A short app-server run to ask Codex something outside a conversation.
async function probe<T>(ask: (rpc: Rpc) => Promise<T>) {
  const child = spawnAppServer()
  const rpc = new Rpc(child, { notification: () => {}, request: async () => ({}) })
  const timer = setTimeout(() => child.kill('SIGTERM'), 15_000)
  try {
    await rpc.request('initialize', { clientInfo: CLIENT, capabilities: CAPABILITIES })
    rpc.notify('initialized', {})
    return await ask(rpc)
  } finally {
    clearTimeout(timer)
    rpc.end()
  }
}

// Whether Codex is signed in and which models it offers.
export const probeCodex = () =>
  probe<{ signedIn: boolean; account: string | null; models: ModelInfo[] }>(async (rpc) => {
    const account = await rpc.request('account/read', { refreshToken: false })
    const models = account.account ? await rpc.request('model/list', { limit: 100 }) : { data: [] }
    return {
      signedIn: !!account.account,
      account: account.account?.email ?? (account.account ? account.account.type : null),
      models: (models.data as any[])
        .filter((m) => !m.hidden)
        .map((m) => ({ id: m.model, label: m.displayName ?? m.model, detail: m.description, efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort) })),
    }
  })

// The account's rate limits: how much of each window is used and when it resets.
export const codexUsage = () => probe(async (rpc) => (await rpc.request('account/rateLimits/read', {})).rateLimits)

const usageLimit = (error: any) => JSON.stringify(error?.codexErrorInfo ?? '').includes('usageLimitExceeded')

// When every used-up window has reset again (ms), or null when none is used up.
function resetOf(limits: any) {
  const spent = [limits?.primary, limits?.secondary].filter((w) => w && w.usedPercent >= 100 && w.resetsAt)
  return spent.length ? Math.max(...spent.map((w) => w.resetsAt * 1000)) : null
}

export const codexSkills = (cwd: string) => probe<SkillInfo[]>(async (rpc) => [...(await skillsIn(rpc, cwd)).map((s) => ({ name: s.name, description: s.description })), ...COMMANDS])
