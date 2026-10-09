// What each agent can do (models, effort levels, permission modes) and whether it is installed and signed in.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { upgradeAgent, type AgentConfig, type Provider } from './store.js'
import { BIN, command } from './config.js'
import { codexSkills, codexUsage, probeCodex } from './codex.js'
import { probeClaude } from './claude.js'
import { antigravitySkills, antigravityUsage, probeAntigravity } from './antigravity.js'
import { acpSkills } from './acp.js'

export interface ModeInfo { id: string; label: string; detail: string; unsafe?: boolean }
export interface ModelInfo { id: string; label: string; detail?: string; efforts?: string[]; ultracode?: boolean }
export interface SkillInfo { name: string; description: string }
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
  ultracode: boolean
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
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
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
    ultracode: true,
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
    ultracode: false,
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
    ultracode: false,
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
    ultracode: false,
    signIn: 'grok login',
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    models: [],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: '',
    // Headless agy cannot ask for approval: what a mode does not allow is denied.
    modes: [
      { id: 'default', label: 'Default', detail: "Commands and edits run as agy's settings allow; Antigravity cannot ask here, so the rest is denied." },
      { id: 'accept-edits', label: 'Accept edits', detail: "File edits run without asking. Commands run only with an allow rule in agy's settings." },
      { id: 'plan', label: 'Plan', detail: 'Explore and plan without changing files.' },
      { id: 'bypass', label: 'Bypass permissions', detail: 'Run every action without asking, commands included. Use only in an isolated environment you trust.', unsafe: true },
    ],
    defaultMode: 'default',
    fast: false,
    ultracode: false,
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
    if (patch.ultracode === undefined) next.ultracode = false
  }
  if (!info.modes.some((m) => m.id === next.permissionMode)) throw new Error(`${info.name} has no permission mode ${next.permissionMode}.`)
  return upgradeAgent(next)
}

function run(bin: string, args: string[], timeout = 10_000) {
  return new Promise<{ ok: boolean; missing: boolean; out: string }>((resolve) => {
    execFile(...command(bin, args), { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
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
    const [status, { models }] = await Promise.all([run(BIN.claude, ['auth', 'status']), probeClaude()])
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
    // Each model's id on a line of its own, then its details as JSON; the variants are its effort levels.
    const out = await run(BIN.opencode, ['models', '--verbose'], 30_000)
    const parts = out.ok ? out.out.split(/^([\w.-]+\/\S+)$/m) : []
    const models: ModelInfo[] = []
    for (let i = 1; i < parts.length; i += 2) {
      let info: any = {}
      try {
        info = JSON.parse(parts[i + 1])
      } catch {}
      models.push({ id: parts[i], label: info.name ? `${info.name} · ${parts[i].split('/')[0]}` : parts[i], efforts: Object.keys(info.variants ?? {}) })
    }
    return { installed: true, version: version(v.out), signedIn: models.length > 0, account: null, models }
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
    if (v.missing) return { installed: false, version: null, signedIn: null, account: null }
    return { installed: true, version: version(v.out), ...(await probeAntigravity()) }
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

// The skills an agent offers in a folder, as the agent itself reports them: its own, the user's, the
// project's and those of its plugins.
const skillProbes: Record<string, (cwd: string) => Promise<SkillInfo[]>> = {
  claude: (cwd) => probeClaude(cwd).then((r) => r.skills),
  codex: (cwd) => codexSkills(cwd).catch(() => []),
  opencode: (cwd) => acpSkills('opencode', cwd).catch(() => []),
  antigravity: (cwd) => antigravitySkills(cwd).catch(() => []),
}
const skillCache = new Map<string, { at: number; list: Promise<SkillInfo[]> }>()

// Savor answers /btw itself, for every agent.
const BTW: SkillInfo = { name: 'btw', description: 'Ask a side question, also while the agent works; the answer stays out of the conversation' }

export async function listSkills(provider: string, cwd: string): Promise<SkillInfo[]> {
  const probe = skillProbes[provider]
  if (!probe || !(await listAgents()).find((a) => a.id === provider)?.installed) return []
  const key = `${provider} ${cwd}`
  const hit = skillCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list
  const list = probe(cwd).then((l) => [...l, BTW])
  skillCache.set(key, { at: Date.now(), list })
  return list
}

// How much of each subscription limit is used, as the agents report it: Claude Code's /usage, Codex's
// rate limits and Antigravity's /usage. OpenCode has no subscription of its own. An agent without a
// subscription, or one that does not answer, is left out.
export interface UsageWindow { label: string; percent: number; resets: string | null }
export interface Usage { provider: Provider; name: string; windows: UsageWindow[] }

const USAGE_MS = 60_000
// The last known usage is served right away; asking the agents takes several seconds. Values older
// than two refresh intervals are marked stale while the new ones are being asked for.
let usage: Usage[] = []
let usageAt = 0
let usageDone = 0
let usageRefresh: Promise<Usage[]> | null = null

const windowLabel = (mins: number) => (mins === 10080 ? 'Weekly' : mins % 1440 === 0 ? `${mins / 1440} days` : mins % 60 === 0 ? `${mins / 60} hours` : `${mins} minutes`)
const resetTime = (s: number) => new Date(s * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(/\u202f?\s?([AP]M)$/, (_, m) => m.toLowerCase())

const usageProbes: Partial<Record<Provider, () => Promise<UsageWindow[]>>> = {
  // Lines like "Current week (all models): 50% used · resets Oct 11, 3:59am (Europe/Berlin)".
  async claude() {
    const { out } = await run(BIN.claude, ['-p', '/usage'], 30_000)
    return [...out.matchAll(/^Current ([^:]+): (\d+)% used(?: · resets (.+))?$/gm)].map(([, label, percent, resets]) => ({
      label: label === 'session' ? '5 hours' : label === 'week (all models)' ? 'Weekly' : label.replace(/^week \((.+)\)$/, 'Weekly · $1'),
      percent: Number(percent),
      resets: resets?.replace(/ \([^)]*\)$/, '') ?? null,
    }))
  },
  async codex() {
    const limits = await codexUsage()
    return [limits?.primary, limits?.secondary]
      .filter((w): w is { usedPercent: number; windowDurationMins: number; resetsAt: number | null } => !!w)
      .map((w) => ({ label: windowLabel(w.windowDurationMins), percent: w.usedPercent, resets: w.resetsAt ? resetTime(w.resetsAt) : null }))
  },
  async antigravity() {
    return (await antigravityUsage()).map((w) => ({ label: w.label, percent: w.percent, resets: w.resetsAt ? resetTime(w.resetsAt / 1000) : null }))
  },
}

export function listUsage(): Promise<(Usage & { stale: boolean })[]> {
  if (!usageRefresh && Date.now() - usageAt >= USAGE_MS) {
    usageAt = Date.now()
    usageRefresh = listAgents()
      .then(async (agents) =>
        (
          await Promise.all(
            agents
              .filter((a) => a.installed && a.signedIn && usageProbes[a.id])
              .map(async (a) => {
                const windows = await usageProbes[a.id]!().catch(() => [])
                // An agent that does not answer this time keeps its last known values.
                return { provider: a.id, name: a.name, windows: windows.length ? windows : (usage.find((u) => u.provider === a.id)?.windows ?? []) }
              }),
          )
        ).filter((u) => u.windows.length),
      )
      .then((list) => (usage = list), () => usage)
      .finally(() => ((usageRefresh = null), (usageDone = Date.now())))
  }
  if (!usage.length && usageRefresh) return usageRefresh.then((list) => list.map((u) => ({ ...u, stale: false })))
  const stale = !!usageRefresh && Date.now() - usageDone > 2 * USAGE_MS
  return Promise.resolve(usage.map((u) => ({ ...u, stale })))
}
