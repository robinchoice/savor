// What each agent can do (models, effort levels, permission modes) and whether it is installed and signed in.
import { execFile } from 'node:child_process'
import type { AgentConfig, Provider } from './store.js'
import { BIN, command } from './config.js'
import { probeCodex } from './codex.js'
import { probeClaude } from './claude.js'

export interface ModeInfo { id: string; label: string; detail: string; unsafe?: boolean }
export interface ModelInfo { id: string; label: string; detail?: string; efforts?: string[] }
export interface ProviderInfo {
  id: Provider
  name: string
  installed: boolean
  version: string | null
  signedIn: boolean | null
  account: string | null
  models: ModelInfo[]
  efforts: string[]
  defaultEffort: string
  modes: ModeInfo[]
  defaultMode: string
  fast: boolean
  signIn: string
}

type Static = Omit<ProviderInfo, 'installed' | 'version' | 'signedIn' | 'account'>

export const STATIC: Record<Provider, Static> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    models: [
      { id: '', label: 'Default' },
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    defaultEffort: 'high',
    modes: [
      { id: 'acceptEdits', label: 'Accept edits', detail: 'File edits run without asking. Commands and other actions ask first.' },
      { id: 'auto', label: 'Auto', detail: 'Claude reviews actions itself. Availability depends on your model and account.' },
      { id: 'manual', label: 'Ask for everything', detail: 'Ask before file edits and commands that are not already allowed.' },
      { id: 'plan', label: 'Plan', detail: 'Explore and propose a plan before changing your source files.' },
      { id: 'dontAsk', label: "Don't ask", detail: 'Run only pre-approved tools. Deny anything that would need permission.' },
      { id: 'bypassPermissions', label: 'Bypass permissions', detail: 'Skip permission checks. Use only in an isolated environment you trust.', unsafe: true },
    ],
    defaultMode: 'acceptEdits',
    fast: true,
    signIn: 'claude auth login',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    models: [],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    modes: [
      { id: 'read-only', label: 'Read-only', detail: 'Explore files without changing them. Ask before actions outside the read-only sandbox.' },
      { id: 'default', label: 'Ask for approval', detail: 'Work within the project. Ask before network access or actions outside the workspace.' },
      { id: 'auto-review', label: 'Approve for me', detail: 'Work within the project. Codex reviews requests for additional access itself.' },
      { id: 'full-access', label: 'Full access', detail: 'Run commands and edit files anywhere, with network access and no approval prompts.', unsafe: true },
    ],
    defaultMode: 'default',
    fast: false,
    signIn: 'codex login',
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    models: [],
    efforts: [],
    defaultEffort: '',
    modes: [
      { id: 'build', label: 'Build', detail: 'Make changes using your configured OpenCode permissions.' },
      { id: 'plan', label: 'Plan', detail: 'Explore and plan using OpenCode’s plan mode.' },
    ],
    defaultMode: 'build',
    fast: false,
    signIn: 'opencode auth login',
  },
  grok: {
    id: 'grok',
    name: 'Grok Build',
    models: [],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
    modes: [
      { id: 'default', label: 'Default', detail: 'Grok asks when an action needs approval.' },
      { id: 'plan', label: 'Plan', detail: 'Explore and plan without changing files.' },
    ],
    defaultMode: 'default',
    fast: false,
    signIn: 'grok login',
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    models: [],
    efforts: [],
    defaultEffort: '',
    modes: [{ id: 'default', label: 'Configured permissions', detail: 'Runs the configured command; permissions come from your CLI settings.' }],
    defaultMode: 'default',
    fast: false,
    signIn: 'agy',
  },
}

export const isUnsafe = (provider: string, mode: string) => !!STATIC[provider as Provider]?.modes.find((m) => m.id === mode)?.unsafe

// Applies a partial change to agent settings. A switch to another provider starts from that
// provider's defaults for whatever the change leaves out, since modes and efforts differ per provider.
export function mergeAgent(current: AgentConfig, patch: Partial<AgentConfig>): AgentConfig {
  const next = { ...current, ...patch }
  const info = STATIC[next.provider]
  if (!info) throw new Error(`Unknown agent ${next.provider}.`)
  if (patch.provider && patch.provider !== current.provider) {
    if (patch.permissionMode === undefined) next.permissionMode = info.defaultMode
    if (patch.reasoning === undefined) next.reasoning = info.defaultEffort
    if (patch.model === undefined) next.model = ''
    if (patch.fast === undefined) next.fast = false
  }
  if (!info.modes.some((m) => m.id === next.permissionMode)) throw new Error(`${info.name} has no permission mode ${next.permissionMode}.`)
  return next
}

function run(bin: string, args: string[], env?: NodeJS.ProcessEnv) {
  return new Promise<{ ok: boolean; missing: boolean; out: string }>((resolve) => {
    execFile(...command(bin, args), { timeout: 10_000, env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const missing = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      resolve({ ok: !err, missing, out: `${stdout}${stderr}`.trim() })
    })
  })
}

const version = (out: string) => out.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? null

type Probe = Pick<ProviderInfo, 'installed' | 'version' | 'signedIn' | 'account'> & { models?: ModelInfo[] }

const probes: Record<Provider, () => Promise<Probe>> = {
  async claude() {
    const v = await run(BIN.claude, ['--version'])
    if (v.missing) return { installed: false, version: null, signedIn: null, account: null }
    const [status, models] = await Promise.all([run(BIN.claude, ['auth', 'status']), probeClaude()])
    let auth: any = null
    try {
      auth = JSON.parse(status.out.slice(status.out.indexOf('{')))
    } catch {}
    return { installed: true, version: version(v.out), signedIn: auth ? !!auth.loggedIn : false, account: auth?.email ?? null, models }
  },
  async codex() {
    const v = await run(BIN.codex, ['--version'])
    if (v.missing) return { installed: false, version: null, signedIn: null, account: null }
    const probe = await probeCodex().catch(() => null)
    return { installed: true, version: version(v.out), signedIn: probe ? probe.signedIn : false, account: probe?.account ?? null, models: probe?.models ?? [] }
  },
  async opencode() {
    const v = await run(BIN.opencode, ['--version'])
    if (v.missing) return { installed: false, version: null, signedIn: null, account: null }
    const models = await run(BIN.opencode, ['models'])
    const ids = models.ok ? models.out.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)) : []
    return { installed: true, version: version(v.out), signedIn: ids.length > 0, account: null, models: ids.map((id) => ({ id, label: id })) }
  },
  async grok() {
    const v = await run(BIN.grok, ['--version'])
    if (v.missing) return { installed: false, version: null, signedIn: null, account: null }
    const status = await run(BIN.grok, ['--no-auto-update', 'models'])
    const signedIn = status.ok && /You are (using|logged in|authenticated)|^Model '/m.test(status.out)
    return { installed: true, version: version(v.out), signedIn, account: status.out.match(/logged in with (\S+)/)?.[1] ?? null }
  },
  async antigravity() {
    const v = await run(BIN.antigravity, ['--version'])
    return { installed: !v.missing, version: v.missing ? null : version(v.out), signedIn: null, account: null }
  },
}

const CACHE_MS = 5 * 60_000
let cache: { at: number; list: Promise<ProviderInfo[]> } | null = null

export function listAgents(refresh = false): Promise<ProviderInfo[]> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.list
  const list = Promise.all(
    (Object.keys(STATIC) as Provider[]).map(async (id) => {
      const probe = await probes[id]().catch((): Probe => ({ installed: false, version: null, signedIn: null, account: null }))
      const { models, ...rest } = probe
      return { ...STATIC[id], ...rest, models: models?.length ? models : STATIC[id].models }
    }),
  )
  cache = { at: Date.now(), list }
  return list
}
