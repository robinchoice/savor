// Import from Enjoy (enjoy.dev): its projects with their conversations, decisions, documents and
// workflows become Savor records. Agent sessions carry over, so a conversation continues with the
// agent session it had there. Importing again brings in what changed in Enjoy since, and leaves
// alone what was continued in Savor.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import * as store from './store.js'
import type { ActivityEvent, AgentConfig, Decision, Message, Project, Provider, Thread, Workflow } from './store.js'
import { STATIC } from './providers.js'
import { git } from './git.js'

const enjoyDir = () =>
  process.env.SAVOR_ENJOY_DIR ??
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'app.enjoy.desktop')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? os.homedir(), 'app.enjoy.desktop')
      : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'app.enjoy.desktop'))

interface Source { path: string; dir: string }

// Enjoy keeps one folder per project and an index from project path to folder.
function sources(): Source[] {
  const root = path.join(enjoyDir(), 'projects')
  let index: Record<string, string>
  try {
    index = JSON.parse(fs.readFileSync(path.join(root, 'projects.json'), 'utf8')).projects ?? {}
  } catch {
    return []
  }
  // The projects worked on last come first, which is the order they get as tabs.
  const touched = (dir: string) => Math.max(0, ...names(path.join(dir, 'threads')).map((t) => fs.statSync(path.join(dir, 'threads', t)).mtimeMs))
  return Object.entries(index)
    .map(([p, dir]) => ({ path: p, dir: path.join(root, dir) }))
    .filter((s) => fs.existsSync(path.join(s.dir, 'config.yml')))
    .sort((a, b) => touched(b.dir) - touched(a.dir))
}

const names = (dir: string, ext = '') => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(ext)) : [])
const yaml = (file: string) => YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}

// Records with a body are markdown with YAML front matter.
function frontMatter(file: string): [any, string] {
  const m = fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  return m ? [YAML.parse(m[1]) ?? {}, m[2].trim()] : [{}, '']
}

function agentFrom(a: any): AgentConfig {
  const provider: Provider = a?.provider in STATIC ? a.provider : 'claude'
  const info = STATIC[provider]
  return {
    provider,
    model: !a?.model || a.model === 'default' ? '' : String(a.model),
    reasoning: !a?.reasoning || a.reasoning === 'default' ? info.defaultEffort : String(a.reasoning),
    fast: !!a?.fast,
    permissionMode: info.modes.some((m) => m.id === a?.permissionMode) ? a.permissionMode : info.defaultMode,
  }
}

export interface EnjoyProject { path: string; name: string; missing: boolean; projectId: string | null; conversations: number; added: number; documents: number; workflows: number }

export function listEnjoy(): EnjoyProject[] {
  const known = store.listProjects()
  return sources().map((s) => {
    const project = known.find((p) => p.path === s.path)
    const threads = names(path.join(s.dir, 'threads'))
    const mine = new Set(project ? store.listThreads(project).map((t) => t.id) : [])
    return {
      path: s.path,
      name: String(yaml(path.join(s.dir, 'config.yml')).name ?? path.basename(s.path)),
      missing: !fs.existsSync(s.path),
      projectId: project?.id ?? null,
      conversations: threads.length,
      added: threads.filter((t) => mine.has(t)).length,
      documents: names(path.join(s.dir, 'docs'), '.md').length,
      workflows: names(path.join(s.dir, 'recipes'), '.md').length,
    }
  })
}

// Conversations are private. Unless the repository already ignores .savor/, it is excluded locally
// (.git/info/exclude), so they don't end up in a commit.
export function keepOutOfGit(dir: string) {
  try {
    git(dir, 'check-ignore', '-q', '.savor/')
    return
  } catch {}
  try {
    const file = path.resolve(dir, git(dir, 'rev-parse', '--git-path', 'info/exclude'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, '\n.savor/\n.savor-logs/\n')
  } catch {} // not a git repository
}

function projectFor(s: Source): Project {
  const existing = store.listProjects().find((p) => p.path === s.path)
  if (existing) return existing
  const fresh = !fs.existsSync(path.join(s.path, '.savor', 'project.json'))
  const p = store.addProject(s.path)
  keepOutOfGit(s.path)
  if (!fresh) return p
  const cfg = yaml(path.join(s.dir, 'config.yml'))
  const role = path.join(s.dir, 'ROLE.md')
  if (fs.existsSync(role) && fs.readFileSync(role, 'utf8').trim()) store.saveRole(p, fs.readFileSync(role, 'utf8'))
  return store.updateProject(p.id, {
    name: String(cfg.name ?? p.name),
    tint: typeof cfg.tint === 'string' ? cfg.tint : p.tint,
    verbosity: ['low', 'medium', 'high'].includes(cfg.verbosity) ? cfg.verbosity : p.verbosity,
    paused: !!cfg.paused,
    agent: agentFrom(cfg.lastAgentConfig ?? cfg),
  })
}

function decisionsOf(s: Source): Decision[] {
  const dir = path.join(s.dir, 'decisions')
  return names(dir, '.md').flatMap((f) => {
    const [d, body] = frontMatter(path.join(dir, f))
    // Approvals are settled permission prompts, not questions.
    if (!d.id || !d.groupId || !d.threadId) return []
    return [{ id: String(d.id), groupId: String(d.groupId), threadId: String(d.threadId), title: String(d.title ?? ''), body, options: (d.options ?? []).map(String), selected: d.selected ?? null, answer: d.answer ?? null, resolved: !!d.resolved, createdAt: String(d.createdAt ?? '') }]
  })
}

function messagesOf(th: any, decisions: Decision[]): Message[] {
  const messages: Message[] = (th.messages ?? []).map((m: any): Message => {
    const base = { id: String(m.id), ts: String(m.createdAt), ...(m.modelInfo && { modelInfo: agentFrom(m.modelInfo) }) }
    // What was still waiting in Enjoy's queue is history here, not something to send again.
    // Enjoy keeps the instructions of a workflow run on the conversation and leaves the message that starts it empty.
    if (m.role === 'user') return { ...base, kind: 'user', text: m.text || (m.automated && th.recipeRun?.instructions) || '', images: (m.images ?? []).map((i: string) => path.basename(i)), origin: m.inputSource === 'remote' ? 'remote' : 'local', delivered: true }
    const kind = base.id.endsWith('-acknowledgement') ? 'ack' : base.id.endsWith('-conclusion') ? 'conclusion' : 'update'
    const ids = decisions.filter((d) => d.groupId === base.id).map((d) => d.id).sort()
    return { ...base, kind, text: m.text ?? '', ...(m.suggestions?.length && { suggestions: m.suggestions }), ...(m.commits?.length && { commits: m.commits }), ...(m.workTiming && { workTiming: m.workTiming }), ...(ids.length > 0 && { decisionIds: ids }) }
  })
  for (const r of th.requests ?? []) if (r.error && r.failedAt) messages.push({ id: `${r.id}-error`, ts: String(r.failedAt), kind: 'error', text: String(r.error) })
  return messages.sort((a, b) => a.ts.localeCompare(b.ts))
}

// Claude Code resumes a session from its transcript, which it keeps per working directory.
const claudeTranscript = (dir: string, sessionId: string) =>
  path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)

function threadOf(s: Source, th: any, messages: Message[], decisions: Decision[]): Thread {
  const completed = th.status === 'completed'
  // The session of each agent that worked on the conversation; the current agent's is th.sessionId.
  const sessions = new Map<Provider, string>((th.agentSessions ?? []).map((x: any) => [x.provider, String(x.sessionId)]))
  if (th.sessionId && th.provider in STATIC) sessions.set(th.provider, String(th.sessionId))
  // Without its transcript a Claude session can't continue: the conversation then starts a new one and hands over the visible history.
  const claude = sessions.get('claude')
  if (claude && !fs.existsSync(claudeTranscript(s.path, claude))) sessions.delete('claude')
  const last = messages[messages.length - 1]
  return {
    id: path.basename(String(th.id)),
    title: String(th.title ?? 'Conversation').slice(0, 300),
    label: th.label?.name ? { name: String(th.label.name), hue: typeof th.label.hue === 'number' ? th.label.hue : store.hueFor(String(th.label.name)) } : null,
    createdAt: String(th.createdAt),
    updatedAt: last?.ts ?? String(th.createdAt),
    agent: agentFrom(th),
    agentSessions: [...sessions].map(([provider, sessionId]) => ({ provider, sessionId })),
    // A finished conversation's preview usually points at a dev server that is long gone.
    preview: completed ? null : th.productPreview?.url ?? null,
    unread: (th.messages ?? []).some((m: any) => m.role !== 'user' && m.read === false),
    completed,
    needsYou: !completed && decisions.some((d) => !d.resolved && d.groupId === last?.id),
    error: null,
    imported: { messages: messages.length, completed, open: decisions.filter((d) => !d.resolved).length },
    // A run of a workflow keeps its place in the workflow's runs.
    ...(th.recipeRun?.recipeId && { workflow: { id: path.basename(String(th.recipeRun.recipeId)), name: String(th.title ?? 'Workflow'), trigger: th.recipeRun.trigger === 'scheduled' ? ('scheduled' as const) : ('manual' as const) } }),
  }
}

function activityOf(file: string): ActivityEvent[] {
  if (!fs.existsSync(file)) return []
  const types: Record<string, ActivityEvent['type']> = { thinking: 'thinking', command: 'command', files: 'edit' }
  return (yaml(file).events ?? []).map((e: any, i: number) => ({
    id: i + 1,
    type: types[e.type] ?? 'note',
    label: `${e.agentName && e.agentName !== 'Agent' ? `${e.agentName} · ` : ''}${e.label ?? e.name ?? ''}`.slice(0, 300),
    time: String(e.time),
    finishedAt: String(e.finishedAt ?? e.time),
  }))
}

export interface EnjoyResult { path: string; projectId: string; added: number; updated: number; kept: number; documents: number; workflows: number }

function importProject(s: Source): EnjoyResult {
  const p = projectFor(s)
  const result: EnjoyResult = { path: s.path, projectId: p.id, added: 0, updated: 0, kept: 0, documents: 0, workflows: 0 }
  const data = store.dataDir(p)
  const decisions = decisionsOf(s)
  const existing = new Map(store.listThreads(p).map((t) => [t.id, t]))

  for (const tid of names(path.join(s.dir, 'threads'))) {
    const dir = path.join(s.dir, 'threads', tid)
    if (!fs.existsSync(path.join(dir, 'messages.md'))) continue
    const th = yaml(path.join(dir, 'messages.md'))
    const own = decisions.filter((d) => d.threadId === th.id)
    const messages = messagesOf(th, own)
    const thread = threadOf(s, th, messages, own)
    const before = existing.get(thread.id)
    if (before) {
      // Nothing new in Enjoy since the last import, or continued in Savor: Savor's copy stays as it is,
      // with whatever was changed here (completed, label, agent).
      const ids = new Set(messages.map((m) => m.id))
      if (JSON.stringify(before.imported) === JSON.stringify(thread.imported) || store.readMessages(p, thread.id).some((m) => !ids.has(m.id))) {
        result.kept++
        continue
      }
    }
    store.saveThread(p, thread)
    store.writeMessages(p, thread.id, messages)
    fs.writeFileSync(path.join(data, 'threads', thread.id, 'activity.jsonl'), activityOf(path.join(dir, 'activity.md')).map((e) => JSON.stringify(e) + '\n').join(''))
    own.forEach((d) => store.saveDecision(p, d))
    for (const image of messages.flatMap((m) => m.images ?? [])) {
      const from = path.join(s.dir, 'attachments', image)
      if (!fs.existsSync(from)) continue
      fs.mkdirSync(store.attachmentDir(p, thread.id), { recursive: true })
      fs.copyFileSync(from, path.join(store.attachmentDir(p, thread.id), image))
    }
    before ? result.updated++ : result.added++
  }

  // Documents keep Enjoy's time of the last change; a document edited in Savor since then is newer and stays.
  for (const f of names(path.join(s.dir, 'docs'), '.md')) {
    const [meta, body] = frontMatter(path.join(s.dir, 'docs', f))
    if (!meta.id || !meta.title) continue
    const file = path.join(data, 'documents', `${path.basename(String(meta.id))}.md`)
    const updatedAt = new Date(meta.updatedAt ?? meta.createdAt ?? Date.now())
    if (fs.existsSync(file) && fs.statSync(file).mtime >= updatedAt) continue
    const heading = `# ${meta.title}`
    store.saveDoc(p, { id: String(meta.id), title: String(meta.title), content: body.startsWith(heading + '\n') ? body.slice(heading.length).trimStart() : body })
    fs.utimesSync(file, updatedAt, updatedAt)
    result.documents++
  }

  // A workflow changed in Enjoy after its last edit in Savor comes in again. Whether it is paused, its chain
  // and its last run are Savor's and stay.
  for (const f of names(path.join(s.dir, 'recipes'), '.md')) {
    const [meta, body] = frontMatter(path.join(s.dir, 'recipes', f))
    if (!meta.id || !meta.name || !body) continue
    const id = path.basename(String(meta.id))
    const file = path.join(data, 'workflows', `${id}.json`)
    const updatedAt = new Date(meta.updatedAt ?? meta.createdAt ?? Date.now()).toISOString()
    const mine = fs.existsSync(file) ? store.getWorkflow(p, id) : null
    // A workflow imported before Savor kept the time of the last edit has its file's time instead.
    if (mine && (mine.updatedAt || fs.statSync(file).mtime.toISOString()) >= updatedAt) continue
    const wf: Workflow = {
      enabled: true,
      catchUp: true,
      next: [],
      lastRunAt: null,
      skipped: [],
      origin: 'local',
      ...mine,
      // Enjoy ran the schedule so far: nothing from before the import is caught up.
      settledAt: store.now(),
      id,
      name: String(meta.name),
      prompt: body,
      collection: String(meta.collection ?? ''),
      cron: meta.cron ? String(meta.cron) : null,
      timezone: String(meta.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
      scheduleLabel: meta.scheduleLabel ? String(meta.scheduleLabel) : null,
      updatedAt,
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(wf, null, 2))
    result.workflows++
  }
  return result
}

// Projects whose folder is gone are skipped: there is nowhere to put their records.
export const importEnjoy = (paths: string[]) =>
  sources()
    .filter((s) => paths.includes(s.path) && fs.existsSync(s.path))
    .map(importProject)
