// Claude Code: one long-lived `claude -p --input-format stream-json` process per conversation and
// settings. Turns go in as user messages on stdin; permission prompts and clarifying questions come
// back as control requests on stdout and are answered on stdin.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as store from './store.js'
import type { ApprovalOption, PlanAgent, PlanStep, Thread } from './store.js'
import { BIN, command, mcpUrl } from './config.js'
import { budgetReached, configKey, forkOf, formFields, OPEN_PAGE, rememberSession, STOPPED, SUBMIT_FORM, sessionIdOf, summarize, systemPrompt, webUrl, type Host, type Session, type TurnInput } from './session.js'
import type { ModelInfo, SkillInfo } from './providers.js'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// Savor ends the process once nothing is pending, so Claude's own timers and notifications would
// never fire. They are switched off, and the prompt names what to use instead.
const UNAVAILABLE = ['ScheduleWakeup', 'CronCreate', 'PushNotification', 'RemoteTrigger']
const UNAVAILABLE_NOTE = `
- ${UNAVAILABLE.join(', ')} are switched off here: Savor closes your process once no background work is pending, so timers and session crons would never fire, and there is no terminal for notifications. To wait, wait inside the turn or run the wait as a background command. For anything later or recurring, save a workflow with create_workflow (cron and timezone); Savor's scheduler runs it and shows the result. To notify the user, send your conclusion.`

// In -p sessions Claude Code stops background shell commands at their timeout, so a dev server
// started that way would vanish from the preview after half an hour.
const BACKGROUND_NOTE = `
- Background shell commands (run_in_background) stop at their timeout here: 30 minutes by default, 2 hours at most. Start dev servers and watchers that should keep running detached instead (setsid or nohup, output to their log file), then register them.`

// A Claude Code older than the options Savor passes refuses to start.
const exitError = (code: number | null, stderr: string) =>
  /unknown option/.test(stderr) ? `Claude Code is too old for Savor (${stderr}). Update it with \`claude update\` and send your message again.` : `claude exited with ${code}: ${stderr}`

const pictures = (images: string[]) =>
  images.map((file) => ({
    type: 'image',
    source: { type: 'base64', media_type: `image/${path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg')}`, data: fs.readFileSync(file).toString('base64') },
  }))

// Claude's todo list: TaskCreate and TaskUpdate, or TodoWrite where Claude Code turns tasks off.
const STEP = { pending: 'pending', in_progress: 'active', completed: 'done' } as const
const step = (text: string, status: keyof typeof STEP, active?: string): PlanStep => ({ text, status: STEP[status] ?? 'pending', ...(active && { active }) })
const resultText = (content: unknown) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : '')
const TASK_END: Record<string, PlanAgent['status']> = { completed: 'done', failed: 'failed', killed: 'stopped', stopped: 'stopped' }

// Claude Code's idle compaction as its settings set it up: the context size it starts at, or null when
// `idleCompaction` is off. The project's settings override the user's, like in Claude Code.
export function idleCompaction(cwd: string) {
  let on = true
  let min = Number(process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS) || 200_000
  const user = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  for (const file of [path.join(user, 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')]) {
    let s: any
    try {
      s = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (typeof s?.idleCompaction === 'boolean') on = s.idleCompaction
    min = Number(s?.env?.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS) || min
  }
  return on ? min : null
}

const describe = (tool: string, input: any) =>
  tool === 'Bash' ? String(input?.command ?? '') : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) ? String(input?.file_path ?? '') : JSON.stringify(input, null, 2).slice(0, 1500)

// The API key for Claude Code on API credit (state.json `apiCredit`), read from its env file for each process that
// goes on with it: the key stays out of Savor's own environment and out of everything Savor stores or logs.
export function creditEnv(): Record<string, string> | null {
  const c = store.state().apiCredit
  if (!c?.envFile || !c.variable) return null
  let key = ''
  try {
    for (const line of fs.readFileSync(c.envFile.replace(/^~(?=\/)/, os.homedir()), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*)$/)
      if (m?.[1] === c.variable) key = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    }
  } catch {
    return null
  }
  return key ? { ANTHROPIC_API_KEY: key, ...(c.headers && { ANTHROPIC_CUSTOM_HEADERS: c.headers }) } : null
}

export class ClaudeSession implements Session {
  readonly config: string
  private child: ChildProcess
  private tasks = 0
  private stderr = ''
  private stopping = false
  // Claude Code ends an interrupted turn with an error result ("error_during_execution").
  private interrupted = false
  private tokens = 0
  private model = ''
  // When the usage limit Claude ran into resets (ms), while it holds.
  private limit: number | null = null
  // USD the conversation may cost, for a workflow run with a budget or on API credit.
  private budget = 0
  // The USD the takeover on API credit may spend, when that is the budget the session holds to.
  private credit = 0
  // The todo list by task id, and the tasks TaskCreate calls are about to create, by tool use id.
  private todos = new Map<string, PlanStep>()
  private creates = new Map<string, PlanStep>()
  // Tasks Claude starts by itself (watchers): no work the user asked for.
  private ambient = new Set<string>()
  constructor(private host: Host, thread: Thread) {
    const { p } = host
    const a = thread.agent
    this.config = configKey(a, !!thread.apiCredit)
    // The MCP config holds the token, so it goes into a file only this user can read.
    const mcpConfig = path.join(store.HOME, 'mcp', `${crypto.randomUUID()}.json`)
    fs.mkdirSync(path.dirname(mcpConfig), { recursive: true, mode: 0o700 })
    // Some Savor tools wait for the user's approval: no idle timeout cuts them off.
    const savor = { type: 'http', url: mcpUrl(p.id, thread.id), headers: { Authorization: `Bearer ${store.state().mcpToken}` }, timeout: 24 * 3600_000 }
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { savor } }), { mode: 0o600 })
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--append-system-prompt', systemPrompt(p, thread) + UNAVAILABLE_NOTE + BACKGROUND_NOTE,
      '--mcp-config', mcpConfig,
      '--allowedTools', 'mcp__savor',
      '--disallowed-tools', UNAVAILABLE.join(','),
      '--permission-mode', a.permissionMode || 'acceptEdits',
      '--permission-prompts', 'host',
      '--permission-prompt-tool', 'stdio',
      // The user's hooks run as in the terminal, e.g. guards that block a Bash command.
      '--settings', JSON.stringify({ fastMode: a.fast, ultracode: a.ultracode }),
      '--chrome',
    ]
    if (a.model) args.push('--model', a.model)
    if (EFFORTS.includes(a.reasoning)) args.push('--effort', a.reasoning)
    // Claude Code keeps a session's cost across resumes and forks, so the budget holds for the whole run, and
    // a takeover on API credit counts from what the session cost before it.
    const credit = thread.apiCredit
    const budget = Math.min(thread.workflow?.budgetUsd || Infinity, credit ? credit.fromUsd + credit.budgetUsd : Infinity)
    if (budget < Infinity) args.push('--max-budget-usd', String((this.budget = budget)))
    if (credit && budget === credit.fromUsd + credit.budgetUsd) this.credit = credit.budgetUsd
    const sid = sessionIdOf(thread, 'claude')
    const fork = forkOf(p, thread, 'claude')
    if (sid) args.push('--resume', sid)
    else if (fork) args.push('--resume', fork, '--fork-session', '--session-id', crypto.randomUUID())
    else args.push('--session-id', crypto.randomUUID())

    this.child = spawn(...command(BIN.claude, args), {
      cwd: host.cwd,
      // Claude Code keeps its todo tools for older models only; Savor shows the list as the agent's plan.
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 3600_000), CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', ...(credit && creditEnv()) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const removeConfig = () => fs.rmSync(mcpConfig, { force: true })
    this.child.on('exit', removeConfig).on('error', removeConfig)
    readline.createInterface({ input: this.child.stdout! }).on('line', (l) => {
      // An event Savor can't handle ends this session, never the daemon.
      try {
        this.onLine(l)
      } catch (e) {
        console.error(`Claude Code session of ${host.tid} failed on an event:`, e)
        host.closed(`Savor could not handle an event from Claude Code: ${(e as Error).message}`)
        this.kill()
      }
    })
    this.child.stderr!.on('data', (d) => (this.stderr = (this.stderr + d).slice(-4000)))
    this.child.on('error', (e) => host.closed(e.message))
    this.child.on('exit', (code, signal) => host.closed(this.stopping || signal === 'SIGTERM' ? STOPPED : exitError(code, this.stderr.trim())))
  }

  start({ context, input, images }: TurnInput) {
    this.interrupted = false
    // The task list lives as long as the session: what an earlier request finished is not part of this one's plan.
    for (const [id, t] of this.todos) if (t.status === 'done') this.todos.delete(id)
    const pics = pictures(images)
    // Claude Code runs a slash command only when the last text block starts with it. What stands in
    // front of that block still reaches the model.
    const content = input.startsWith('/') ? [...(context ? [{ type: 'text', text: context }] : []), ...pics, { type: 'text', text: input }] : [{ type: 'text', text: context + input }, ...pics]
    this.write({ type: 'user', message: { role: 'user', content } })
  }

  // A message written while a turn runs reaches Claude at its next step, within the same turn.
  async steer({ text, images }: { text: string; images: string[] }) {
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }, ...pictures(images)] } })
    return true
  }

  interrupt() {
    this.interrupted = true
    this.write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } })
  }

  end() {
    this.child.stdin?.end()
  }

  kill() {
    this.stopping = true
    this.child.kill('SIGTERM')
  }

  background() {
    return this.tasks > 0
  }

  stopTask(id: string) {
    this.write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'stop_task', task_id: id } })
  }

  private write(msg: unknown) {
    if (this.child.stdin?.writable) this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  // Busy state follows Claude's own events, so turns it starts by itself (e.g. when a background
  // task finishes) show up as working too.
  private onLine(line: string) {
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    const { p, tid, activity } = this.host
    // Claude names the background tasks that still run (shell commands, subagents) whenever that list changes.
    // Ambient ones (watchers it starts by itself) are no work the user could want to stop.
    if (ev.type === 'system' && ev.subtype === 'background_tasks_changed') {
      for (const t of ev.tasks ?? []) if (t.ambient) this.ambient.add(t.task_id)
      this.tasks = ev.tasks?.filter((t: { ambient?: boolean }) => !t.ambient).length ?? 0
      return this.host.backgroundChanged()
    }
    if (ev.type === 'system' && ev.subtype?.startsWith('task_')) this.task(ev)
    if (ev.type === 'assistant' || ev.type === 'user' || (ev.type === 'system' && ['init', 'task_notification'].includes(ev.subtype))) this.host.working()
    if (ev.type === 'rate_limit_event') {
      const info = ev.rate_limit_info ?? {}
      this.limit = info.status === 'rejected' && info.resetsAt && !info.isUsingOverage ? info.resetsAt * 1000 : null
      return
    }
    // After a compaction the context holds its summary.
    if (ev.type === 'system' && ev.subtype === 'compact_boundary' && ev.compact_metadata?.post_tokens) {
      this.tokens = ev.compact_metadata.post_tokens
      return this.host.context(this.tokens)
    }
    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      rememberSession(p, tid, 'claude', ev.session_id)
    } else if (ev.type === 'assistant') {
      if (ev.message?.usage && !ev.parent_tool_use_id) this.usage(ev.message)
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'thinking') activity.instant('thinking', 'Thinking')
        if (c.type === 'text' && c.text.trim()) activity.instant('note', c.text)
        if (c.type === 'tool_use') activity.tool(c.id, c.name, c.input)
        if (c.type === 'tool_use' && !ev.parent_tool_use_id) this.todo(c.id, c.name, c.input ?? {})
      }
    } else if (ev.type === 'user') {
      for (const c of ev.message?.content ?? []) if (c.type === 'tool_result') {
        activity.finish(c.tool_use_id)
        const created = this.creates.get(c.tool_use_id)
        const id = !c.is_error && resultText(c.content).match(/^Task #(\S+) created successfully/)?.[1]
        this.creates.delete(c.tool_use_id)
        if (!created || !id) continue
        this.todos.set(id, created)
        this.host.plan.steps([...this.todos.values()])
      }
    } else if (ev.type === 'control_request') {
      this.control(ev.request_id, ev.request).catch((e: Error) => this.respond(ev.request_id, undefined, e.message))
    } else if (ev.type === 'result') {
      const window = ev.modelUsage?.[this.model]?.contextWindow
      if (window) this.host.context(this.tokens, window)
      if (typeof ev.total_cost_usd === 'number') this.host.spent({ usd: ev.total_cost_usd })
      const interrupted = this.interrupted
      this.interrupted = false
      if (ev.subtype === 'error_max_budget_usd') return this.host.ended({ error: this.credit ? `Claude Code used the $${this.credit} of API credit it may spend on this takeover.` : budgetReached(this.budget) })
      this.host.ended(ev.is_error && !interrupted ? { error: ev.result || ev.subtype, resetsAt: this.limit } : { text: ev.is_error ? '' : ev.result ?? '' })
    }
  }

  private todo(useId: string, tool: string, input: any) {
    if (tool === 'TodoWrite') this.todos = new Map((input.todos ?? []).map((t: any, i: number) => [String(i), step(t.content, t.status, t.activeForm)]))
    else if (tool === 'TaskCreate') return this.creates.set(useId, step(input.subject, 'pending', input.activeForm))
    else if (tool === 'TaskUpdate') {
      const id = String(input.taskId)
      const t = this.todos.get(id)
      if (!t) return
      if (input.status === 'deleted') this.todos.delete(id)
      else this.todos.set(id, { ...t, text: input.subject ?? t.text, ...(input.status && { status: STEP[input.status as keyof typeof STEP] }), ...(input.activeForm && { active: input.activeForm }) })
    } else return
    this.host.plan.steps([...this.todos.values()])
  }

  // Subagents and background commands, as Claude Code reports their start, progress and end.
  private task(ev: any) {
    if (this.ambient.has(ev.task_id)) return
    const plan = this.host.plan
    if (ev.subtype === 'task_started') plan.agent(ev.task_id, { name: ev.description || 'Task', kind: ev.task_type === 'local_bash' ? 'command' : 'agent', type: ev.subagent_type, stoppable: true })
    else if (ev.subtype === 'task_progress') plan.agent(ev.task_id, { doing: ev.description })
    else if (TASK_END[ev.patch?.status ?? ev.status]) plan.agent(ev.task_id, { status: TASK_END[ev.patch?.status ?? ev.status] })
  }

  // What the request behind an answer carried is what the context holds now. Subagents have their own.
  private usage(message: any) {
    const u = message.usage
    const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    if (message.model !== this.model) this.host.model(message.model)
    this.model = message.model
    if (tokens === this.tokens) return
    this.tokens = tokens
    this.host.context(tokens)
  }

  private respond(requestId: string, result?: unknown, error?: string) {
    this.write({ type: 'control_response', response: error ? { subtype: 'error', request_id: requestId, error } : { subtype: 'success', request_id: requestId, response: result } })
  }

  private async control(requestId: string, req: any) {
    if (req.subtype === 'elicitation' && req.mode === 'url') {
      const url = webUrl(req.url)
      if (!url) throw new Error('Savor opens only http and https pages.')
      const choice = await this.host.approve({ title: req.title ?? `${req.mcp_server_name} asks you to open a page`, detail: req.message ?? '', url, options: OPEN_PAGE })
      return this.respond(requestId, { action: choice })
    }
    if (req.subtype === 'elicitation') {
      const fields = formFields(req.requested_schema)
      if (!fields) throw new Error('Savor does not answer this MCP elicitation form.')
      const { choice, content } = await this.host.form({ title: req.title ?? `${req.mcp_server_name} asks for details`, detail: req.message ?? '', fields, options: SUBMIT_FORM })
      return this.respond(requestId, { action: choice, ...(content && { content }) })
    }
    if (req.subtype !== 'can_use_tool') throw new Error(`Savor does not handle ${req.subtype} requests.`)
    const input = req.input ?? {}
    if (req.tool_name === 'AskUserQuestion') {
      const questions = (input.questions ?? []) as { question: string; options?: { label: string }[] }[]
      const answers = await this.host.ask(questions.map((q) => ({ title: q.question, body: '', options: q.options?.map((o) => o.label) ?? [] })))
      const map: Record<string, string> = {}
      questions.forEach((q, i) => {
        const a = answers[i]
        map[q.question] = a.selected != null ? q.options?.[a.selected]?.label ?? '' : a.answer ?? ''
      })
      return this.respond(requestId, { behavior: 'allow', updatedInput: { questions, answers: map } })
    }
    const persist = ((req.permission_suggestions ?? []) as { destination?: string }[]).filter((s) => s.destination === 'localSettings')
    const options: ApprovalOption[] = [
      { id: 'allow', label: 'Allow', kind: 'allow' },
      ...(persist.length ? [{ id: 'always', label: 'Always allow', kind: 'allow' as const }] : []),
      { id: 'deny', label: 'Deny', kind: 'deny' },
    ]
    const choice = await this.host.approve({ title: `Allow ${req.display_name ?? req.tool_name}?`, detail: describe(req.tool_name, input) || summarize(input), options })
    if (choice === 'deny') return this.respond(requestId, { behavior: 'deny', message: 'The user denied this action.' })
    this.respond(requestId, { behavior: 'allow', updatedInput: input, ...(choice === 'always' && { updatedPermissions: persist }) })
  }
}

// A side question (/btw): a copy of the session answers once, without tools, and the copy is not kept.
// The conversation itself, also a turn that is running, stays as it is.
export function claudeAside(cwd: string, sid: string | undefined, model: string, prompt: string) {
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--settings', JSON.stringify({ disableAllHooks: true }), '--tools', '']
  if (sid) args.push('--resume', sid, '--fork-session')
  if (model) args.push('--model', model)
  return new Promise<string>((resolve, reject) => {
    const child = execFile(...command(BIN.claude, args), { cwd, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      let r: any
      try {
        r = JSON.parse(stdout)
      } catch {
        return reject(new Error(stderr.trim() || err?.message || 'Claude Code did not answer.'))
      }
      if (r.is_error) reject(new Error(r.result || 'Claude Code did not answer.'))
      else resolve(r.result ?? '')
    })
    // The prompt goes in on stdin: as an argument, the list after --tools would take it.
    child.stdin!.end(prompt)
  })
}

// Built-in commands that only steer the terminal UI, or change what Savor sets itself (model, effort,
// fast mode, the session), stay out of the "/" list. All others run in Savor as in the terminal.
const HIDDEN_COMMANDS = new Set(['clear', 'color', 'config', 'doctor', 'effort', 'fast', 'focus', 'heapdump', 'model', 'reload-plugins', 'rename', 'workflow-launch-exec'])

// A short run to learn which models and commands Claude Code offers in a folder: the answer to its
// initialize request. No prompt is sent.
export function probeClaude(cwd?: string) {
  return new Promise<{ models: ModelInfo[]; skills: SkillInfo[] }>((resolve) => {
    const child = spawn(...command(BIN.claude, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', JSON.stringify({ disableAllHooks: true })]), { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    const done = (models: ModelInfo[] = [], skills: SkillInfo[] = []) => {
      clearTimeout(timer)
      child.kill('SIGTERM')
      resolve({ models, skills })
    }
    const timer = setTimeout(() => done(), 15_000)
    child.on('error', () => done()).on('exit', () => done())
    let offer: any
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.type !== 'control_response' || offer) return
      offer = ev.response?.response ?? {}
      const models = (offer.models ?? []) as { value: string; displayName?: string; description?: string; supportedEffortLevels?: string[] }[]
      const commands = (offer.commands ?? []) as { name: string; description?: string; builtin?: boolean }[]
      done(
        models.map((m) => ({
          id: m.value === 'default' ? '' : m.value,
          label: m.displayName ?? m.value,
          detail: m.description,
          efforts: m.supportedEffortLevels ?? [],
          // Claude Code offers Ultracode only on models that can run X-High.
          ultracode: !!m.supportedEffortLevels?.includes('xhigh'),
        })),
        commands.filter((c) => !c.builtin || !(HIDDEN_COMMANDS.has(c.name) || c.name.startsWith('_'))).map((c) => ({ name: c.name, description: c.description ?? '' })),
      )
    })
    child.stdin!.write(JSON.stringify({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'initialize' } }) + '\n')
  })
}

// The subscription limits, from a short run's answer to a get_usage request. No prompt is sent, and
// skip_behaviors spares it the scan of the last week's transcripts. It runs on the login, not on a token
// from `claude setup-token`: with that, get_usage reports no limits.
export function claudeUsage() {
  type Limit = { group: string; percent: number; resets_at: string | null; scope?: { model?: { display_name?: string } } | null }
  return new Promise<Limit[]>((resolve) => {
    const child = spawn(...command(BIN.claude, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', JSON.stringify({ disableAllHooks: true })]), { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: undefined }, stdio: ['pipe', 'pipe', 'ignore'] })
    const done = (limits: Limit[] = []) => {
      clearTimeout(timer)
      child.kill('SIGTERM')
      resolve(limits)
    }
    const timer = setTimeout(() => done(), 15_000)
    child.on('error', () => done()).on('exit', () => done())
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.type === 'control_response') done(ev.response?.response?.rate_limits?.limits ?? [])
    })
    child.stdin!.write(JSON.stringify({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n')
  })
}
