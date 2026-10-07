// Claude Code: one long-lived `claude -p --input-format stream-json` process per conversation and
// settings. Turns go in as user messages on stdin; permission prompts and clarifying questions come
// back as control requests on stdout and are answered on stdin.
import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as store from './store.js'
import type { ApprovalOption, Thread } from './store.js'
import { BIN, command, mcpUrl } from './config.js'
import { configKey, forkOf, OPEN_PAGE, rememberSession, sessionIdOf, summarize, systemPrompt, webUrl, type Host, type Session, type TurnInput } from './session.js'
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

const describe = (tool: string, input: any) =>
  tool === 'Bash' ? String(input?.command ?? '') : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) ? String(input?.file_path ?? '') : JSON.stringify(input, null, 2).slice(0, 1500)

export class ClaudeSession implements Session {
  readonly config: string
  private child: ChildProcess
  private tasks = 0
  private stderr = ''
  private stopping = false
  private tokens = 0
  private model = ''
  // When the usage limit Claude ran into resets (ms), while it holds.
  private limit: number | null = null

  constructor(private host: Host, thread: Thread) {
    const { p } = host
    const a = thread.agent
    this.config = configKey(a)
    // The MCP config holds the token, so it goes into a file only this user can read.
    const mcpConfig = path.join(store.HOME, 'mcp', `${crypto.randomUUID()}.json`)
    fs.mkdirSync(path.dirname(mcpConfig), { recursive: true, mode: 0o700 })
    const savor = { type: 'http', url: mcpUrl(p.id, thread.id), headers: { Authorization: `Bearer ${store.state().mcpToken}` } }
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
      // Hooks expect a terminal session; here they would run unseen in every conversation.
      '--settings', JSON.stringify({ disableAllHooks: true, fastMode: a.fast, ultracode: a.reasoning === 'ultracode' }),
      '--chrome',
    ]
    if (a.model) args.push('--model', a.model)
    // Ultracode is a setting on top of the highest regular effort.
    const effort = a.reasoning === 'ultracode' ? 'xhigh' : a.reasoning
    if (EFFORTS.includes(effort)) args.push('--effort', effort)
    const sid = sessionIdOf(thread, 'claude')
    const fork = forkOf(p, thread, 'claude')
    if (sid) args.push('--resume', sid)
    else if (fork) args.push('--resume', fork, '--fork-session', '--session-id', crypto.randomUUID())
    else args.push('--session-id', crypto.randomUUID())

    this.child = spawn(...command(BIN.claude, args), {
      cwd: host.cwd,
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 3600_000) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const removeConfig = () => fs.rmSync(mcpConfig, { force: true })
    this.child.on('exit', removeConfig).on('error', removeConfig)
    readline.createInterface({ input: this.child.stdout! }).on('line', (l) => this.onLine(l))
    this.child.stderr!.on('data', (d) => (this.stderr = (this.stderr + d).slice(-4000)))
    this.child.on('error', (e) => host.closed(e.message))
    this.child.on('exit', (code, signal) => host.closed(this.stopping || signal === 'SIGTERM' ? 'Turn stopped.' : exitError(code, this.stderr.trim())))
  }

  start({ context, input, images }: TurnInput) {
    const pictures = images.map((file) => ({
      type: 'image',
      source: { type: 'base64', media_type: `image/${path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg')}`, data: fs.readFileSync(file).toString('base64') },
    }))
    // Claude Code runs a slash command only when the last text block starts with it. What stands in
    // front of that block still reaches the model.
    const content = input.startsWith('/') ? [{ type: 'text', text: context }, ...pictures, { type: 'text', text: input }] : [{ type: 'text', text: context + input }, ...pictures]
    this.write({ type: 'user', message: { role: 'user', content } })
  }

  interrupt() {
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
    if (ev.type === 'system' && ev.subtype === 'background_tasks_changed') {
      this.tasks = ev.tasks?.length ?? 0
      return this.host.backgroundChanged()
    }
    if (ev.type === 'assistant' || ev.type === 'user' || (ev.type === 'system' && ['init', 'task_notification'].includes(ev.subtype))) this.host.working()
    if (ev.type === 'rate_limit_event') {
      const info = ev.rate_limit_info ?? {}
      this.limit = info.status === 'rejected' && info.resetsAt && !info.isUsingOverage ? info.resetsAt * 1000 : null
      return
    }
    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      rememberSession(p, tid, 'claude', ev.session_id)
    } else if (ev.type === 'assistant') {
      if (ev.message?.usage && !ev.parent_tool_use_id) this.usage(ev.message)
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'thinking') activity.instant('thinking', 'Thinking')
        if (c.type === 'text' && c.text.trim()) activity.instant('note', c.text)
        if (c.type === 'tool_use') activity.tool(c.id, c.name, c.input)
      }
    } else if (ev.type === 'user') {
      for (const c of ev.message?.content ?? []) if (c.type === 'tool_result') activity.finish(c.tool_use_id)
    } else if (ev.type === 'control_request') {
      this.control(ev.request_id, ev.request).catch((e: Error) => this.respond(ev.request_id, undefined, e.message))
    } else if (ev.type === 'result') {
      const window = ev.modelUsage?.[this.model]?.contextWindow
      if (window) this.host.context(this.tokens, window)
      this.host.ended(ev.is_error && !/interrupt/i.test(ev.subtype ?? '') ? { error: ev.result || ev.subtype, resetsAt: this.limit } : { text: ev.is_error ? '' : ev.result ?? '' })
    }
  }

  // What the request behind an answer carried is what the context holds now. Subagents have their own.
  private usage(message: any) {
    const u = message.usage
    const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    if (tokens === this.tokens) return
    this.tokens = tokens
    this.model = message.model
    this.host.context(tokens)
  }

  private respond(requestId: string, result?: unknown, error?: string) {
    this.write({ type: 'control_response', response: error ? { subtype: 'error', request_id: requestId, error } : { subtype: 'success', request_id: requestId, response: result } })
  }

  private async control(requestId: string, req: any) {
    if (req.subtype === 'elicitation') {
      const url = req.mode === 'url' && webUrl(req.url)
      if (!url) throw new Error('Savor does not answer MCP elicitation forms.')
      const choice = await this.host.approve({ title: req.title ?? `${req.mcp_server_name} asks you to open a page`, detail: req.message ?? '', url, options: OPEN_PAGE })
      return this.respond(requestId, { action: choice })
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

// A short run to learn which models and skills Claude Code offers in a folder: the answers to its
// initialize and context usage requests. No prompt is sent.
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
    const ask = (subtype: string) => child.stdin!.write(JSON.stringify({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype } }) + '\n')
    let offer: any
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.type !== 'control_response') return
      if (!offer) {
        offer = ev.response?.response ?? {}
        return ask('get_context_usage')
      }
      const models = (offer.models ?? []) as { value: string; displayName?: string; description?: string; supportedEffortLevels?: string[] }[]
      const commands = (offer.commands ?? []) as { name: string; description?: string; builtin?: boolean }[]
      // Most built-in commands steer the terminal UI (/color, /focus, /config). Of those, only the ones
      // Claude Code keeps among its skills (/code-review, /init) are listed.
      const builtinSkills = new Set(((ev.response?.response?.skills?.skillFrontmatter ?? []) as { name: string }[]).map((s) => s.name))
      done(
        models.map((m) => ({
          id: m.value === 'default' ? '' : m.value,
          label: m.displayName ?? m.value,
          detail: m.description,
          efforts: m.supportedEffortLevels?.length ? [...m.supportedEffortLevels, 'ultracode'] : [],
        })),
        commands.filter((c) => !c.builtin || builtinSkills.has(c.name)).map((c) => ({ name: c.name, description: c.description ?? '' })),
      )
    })
    ask('initialize')
  })
}
