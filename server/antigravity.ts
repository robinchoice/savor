// Antigravity: one `agy --print` run per turn, its progress as stream-json on stdout. The next turn
// continues the conversation with --conversation. Headless agy cannot ask for approval, so whatever the
// mode does not allow is denied.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import * as store from './store.js'
import type { Thread } from './store.js'
import { BIN, command, mcpUrl } from './config.js'
import { configKey, rememberSession, sessionIdOf, summarize, systemPrompt, type Host, type Session, type TurnInput } from './session.js'
import type { ModelInfo, SkillInfo } from './providers.js'

const HOME = process.env.SAVOR_ANTIGRAVITY_HOME ?? path.join(os.homedir(), '.gemini')

// agy only reads MCP servers from the user's mcp_config.json, and the URL there cannot name a conversation.
// So "savor" is a stdio server that forwards each request to the conversation's URL in SAVOR_MCP_URL,
// which Savor sets for each run. Outside Savor it exits right away. The token goes to curl in a file of
// its own, never onto a command line.
const BRIDGE = `[ -n "$SAVOR_MCP_URL" ] || exit 0
h=$(mktemp) || exit 1
trap 'rm -f "$h"' EXIT
printf 'Authorization: Bearer %s\\n' "$SAVOR_MCP_TOKEN" > "$h"
while IFS= read -r line; do
  r=$(printf '%s\\n' "$line" | curl -sS -H @"$h" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data-binary @- "$SAVOR_MCP_URL")
  [ -n "$r" ] && printf '%s\\n' "$r"
done`

function update(file: string, change: (config: any) => boolean) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
  const config = text ? JSON.parse(text) : {}
  if (!change(config)) return
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

// Headless agy cannot ask before it calls an MCP tool either, so Savor's own tools are allowed in its settings.
const ALLOW = 'mcp(savor/*)'

function ensureMcp() {
  update(path.join(HOME, 'config', 'mcp_config.json'), (config) => {
    const savor = config.mcpServers?.savor
    if (savor?.command === 'sh' && savor.args?.[1] === BRIDGE && !savor.disabled) return false
    config.mcpServers = { ...config.mcpServers, savor: { command: 'sh', args: ['-c', BRIDGE] } }
    return true
  })
  update(path.join(HOME, 'antigravity-cli', 'settings.json'), (settings) => {
    const allow: string[] = settings.permissions?.allow ?? []
    if (allow.includes(ALLOW)) return false
    settings.permissions = { ...settings.permissions, allow: [...allow, ALLOW] }
    return true
  })
}

const env = (projectId: string, threadId: string) => ({ ...process.env, SAVOR_MCP_URL: mcpUrl(projectId, threadId), SAVOR_MCP_TOKEN: store.state().mcpToken })

const EDITS = ['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit']

function describe(tool: string, input: any) {
  if (tool === 'run_command') return input?.CommandLine ?? summarize(input)
  if (tool === 'call_mcp_tool') return `${input?.ToolName} · ${summarize(input?.Arguments)}`
  const file = input?.TargetFile ?? input?.AbsolutePath
  return `${tool} · ${file ?? summarize(input)}`
}

export class AntigravitySession implements Session {
  readonly config: string
  private child?: ChildProcess

  constructor(private host: Host, thread: Thread) {
    this.config = configKey(thread.agent)
  }

  start({ context, input, images }: TurnInput) {
    const { p, tid, activity } = this.host
    const thread = store.getThread(p, tid)
    const a = thread.agent
    // Conversations from before Savor resumed Antigravity stored "command" here.
    const sid = sessionIdOf(thread, 'antigravity')
    const resume = sid && sid !== 'command' ? sid : undefined
    const attached = images.length ? `\n\nAttached images (open them with view_file):\n${images.join('\n')}` : ''
    const prompt = `${resume ? '' : `${systemPrompt(p, thread)}\n\n`}${context}${input}${attached}`
    const args = ['--output-format', 'stream-json']
    if (resume) args.push('--conversation', resume)
    if (a.model) args.push('--model', a.model)
    if (a.reasoning) args.push('--effort', a.reasoning)
    if (a.permissionMode === 'accept-edits' || a.permissionMode === 'plan') args.push('--mode', a.permissionMode)
    if (a.permissionMode === 'bypass') args.push('--dangerously-skip-permissions')
    args.push('--print', prompt)
    try {
      ensureMcp()
    } catch (e) {
      return this.host.ended({ error: `Savor could not add its MCP server to agy's settings in ${HOME}: ${(e as Error).message}` })
    }

    let result: any = null
    let stderr = ''
    const child = spawn(...command(BIN.antigravity, args), { cwd: this.host.cwd, env: env(p.id, tid), stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.event === 'init' && ev.conversation_id) rememberSession(p, tid, 'antigravity', ev.conversation_id)
      else if (ev.event === 'result') result = ev.result
      else if (ev.event === 'step_update') {
        const s = ev.step_update
        if (s.step_type === 'tool') {
          const key = `step${s.step_index}`
          if (s.state === 'ACTIVE') activity.start(key, s.tool_name === 'run_command' ? 'command' : EDITS.includes(s.tool_name) ? 'edit' : 'note', describe(s.tool_name, s.tool_info?.parameters))
          else activity.finish(key)
        } else if (s.step_type === 'agent_response' && s.state === 'DONE' && s.usage) {
          if (s.usage.thinking_tokens) activity.instant('thinking', 'Thinking')
          this.host.context(s.usage.input_tokens + (s.usage.cache_read_tokens ?? 0))
        }
      }
    })
    child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-4000)))
    child.on('error', (e) => this.host.ended({ error: e.message }))
    child.on('close', async (code, signal) => {
      this.child = undefined
      const denied = (result?.denied_actions ?? []).map((d: any) => d.display_name ?? d.action)
      if (denied.length) activity.instant('note', `Denied: ${denied.join(', ')}. Antigravity cannot ask for approval here; allow it in agy's settings or pick another mode.`)
      if (signal) return this.host.ended({ error: 'Turn stopped.' })
      if (result?.status === 'SUCCESS') return this.host.ended({ text: result.response ?? '' })
      const error = result?.error || stderr.trim() || `${BIN.antigravity} exited with ${code}.`
      this.host.ended({ error, resetsAt: /quota|limit|credits/i.test(error) ? await antigravityResets().catch(() => null) : null })
    })
  }

  interrupt() {
    this.child?.kill('SIGTERM')
  }

  end() {
    this.child?.kill('SIGTERM')
  }

  kill() {
    this.child?.kill('SIGTERM')
  }
}

function run(args: string[], cwd?: string) {
  return new Promise<string>((resolve, reject) =>
    execFile(...command(BIN.antigravity, args), { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  )
}

// A slash command run in print mode answers right away, without a model turn.
const slash = async (name: string, cwd?: string) => JSON.parse(await run(['--output-format', 'json', '--print', `/${name}`], cwd)).command?.data

// Lines like "gemini-3.1-pro-high\tGemini 3.1 Pro (High)". A signed-out agy fails here.
export async function probeAntigravity(): Promise<{ signedIn: boolean; account: string | null; models: ModelInfo[] }> {
  const out = await run(['models']).catch(() => null)
  let account: string | null = null
  try {
    account = JSON.parse(fs.readFileSync(path.join(HOME, 'google_accounts.json'), 'utf8')).active ?? null
  } catch {}
  const models = (out ?? '').split('\n').flatMap((l) => {
    const [id, label] = l.split('\t')
    return label ? [{ id: id.trim(), label: label.trim() }] : []
  })
  return { signedIn: models.length > 0, account, models: models.length ? [{ id: '', label: 'Default' }, ...models] : [] }
}

export const antigravitySkills = async (cwd: string): Promise<SkillInfo[]> => ((await slash('skills', cwd))?.skills ?? []).map((s: any) => ({ name: s.name, description: s.description ?? '' }))

// Weekly limits per group of models, e.g. "Gemini Models" and "Claude and GPT models".
export async function antigravityUsage(): Promise<{ label: string; percent: number; resetsAt: number | null }[]> {
  return ((await slash('usage'))?.groups ?? []).flatMap((g: any) =>
    (g.buckets ?? []).map((b: any) => ({
      label: `${b.window === 'weekly' ? 'Weekly' : b.name} · ${g.name}`,
      percent: Math.round((1 - b.remaining_fraction) * 100),
      resetsAt: b.reset_time ? Date.parse(b.reset_time) : null,
    })),
  )
}

async function antigravityResets() {
  const spent = (await antigravityUsage()).filter((w) => w.percent >= 100 && w.resetsAt)
  return spent.length ? Math.max(...spent.map((w) => w.resetsAt!)) : null
}

// A side question goes to a fresh run in plan mode: agy cannot fork a conversation from the command line,
// so the run gets the visible history instead.
export async function antigravityAside(cwd: string, model: string, history: string, prompt: string) {
  const args = ['--output-format', 'json', '--mode', 'plan', '--disable-slash-commands']
  if (model) args.push('--model', model)
  args.push('--print', `${history}${prompt}`)
  const r = JSON.parse(await run(args, cwd))
  if (r.status !== 'SUCCESS') throw new Error(r.error || 'Antigravity did not answer.')
  return String(r.response ?? '').trim()
}
