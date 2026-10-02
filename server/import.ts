// Import of existing agent sessions: Claude Code transcripts (~/.claude/projects) and Codex rollouts
// (~/.codex/sessions) for a project become conversations that resume the agent's own session.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as store from './store.js'
import type { Message, Project } from './store.js'
import { mergeAgent } from './providers.js'

export interface ImportableSession { provider: 'claude' | 'codex'; id: string; title: string; startedAt: string; messages: number; imported: boolean }
interface Parsed { id: string; title: string; startedAt: string; updatedAt: string; messages: Omit<Message, 'id'>[] }

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
const codexDir = () => process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')

// Savor's and Enjoy's turn envelopes wrap the user's text; only the input is shown.
function unwrap(text: string) {
  const i = text.indexOf('New input:\n')
  return (i >= 0 && /^(Savor|Enjoy) context:/.test(text) ? text.slice(i + 'New input:\n'.length) : text).trim()
}

// Transcripts get big; only lines that can matter are parsed.
const lines = (file: string, keep: (line: string) => boolean = () => true) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(keep)
    .flatMap((l) => {
      try {
        return l ? [JSON.parse(l)] : []
      } catch {
        return []
      }
    })

// Consecutive agent texts of one turn become one conclusion.
function collect(turns: { role: 'user' | 'agent'; text: string; ts: string }[], provider: 'claude' | 'codex'): Omit<Message, 'id'>[] {
  const modelInfo = { ...store.defaultAgent(), provider }
  const out: Omit<Message, 'id'>[] = []
  for (const t of turns) {
    const last = out[out.length - 1]
    if (t.role === 'agent' && last?.kind === 'conclusion') last.text += `\n\n${t.text}`
    else out.push(t.role === 'user' ? { ts: t.ts, kind: 'user', text: t.text, origin: 'local', delivered: true } : { ts: t.ts, kind: 'conclusion', text: t.text, modelInfo })
  }
  return out
}

function parseClaude(file: string): Parsed | null {
  const turns: { role: 'user' | 'agent'; text: string; ts: string }[] = []
  let first = ''
  for (const r of lines(file, (l) => l.includes('"type":"user"') || l.includes('"type":"assistant"'))) {
    if (r.isSidechain || r.isMeta || !r.timestamp) continue
    const content = r.message?.content
    if (r.type === 'user') {
      const text = typeof content === 'string' ? content : (content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      // Tool results, slash commands and task notifications are not the user's words.
      if (!text.trim() || text.startsWith('<')) continue
      first ||= r.timestamp
      turns.push({ role: 'user', text: unwrap(text), ts: r.timestamp })
    } else if (r.type === 'assistant') {
      const text = (content ?? []).filter((c: any) => c.type === 'text' && c.text?.trim()).map((c: any) => c.text).join('\n\n')
      if (text) turns.push({ role: 'agent', text, ts: r.timestamp })
    }
  }
  const user = turns.find((t) => t.role === 'user')
  if (!user) return null
  return { id: path.basename(file, '.jsonl'), title: user.text.split('\n')[0].slice(0, 300), startedAt: first, updatedAt: turns[turns.length - 1].ts, messages: collect(turns, 'claude') }
}

function parseCodex(file: string, cwd: string): Parsed | null {
  const all = lines(file, (l) => l.includes('"session_meta"') || l.includes('"response_item"'))
  const meta = all.find((r) => r.type === 'session_meta')?.payload
  if (!meta || meta.cwd !== cwd) return null
  const turns: { role: 'user' | 'agent'; text: string; ts: string }[] = []
  for (const r of all) {
    if (r.type !== 'response_item' || r.payload?.type !== 'message') continue
    const role = r.payload.role === 'user' ? 'user' : r.payload.role === 'assistant' ? 'agent' : null
    if (!role) continue
    // Codex puts AGENTS.md and the environment description into user items of their own.
    const text = (r.payload.content ?? [])
      .filter((c: any) => (c.type === 'input_text' || c.type === 'output_text') && c.text?.trim() && !c.text.startsWith('<') && !c.text.startsWith('# AGENTS.md'))
      .map((c: any) => c.text)
      .join('\n')
    if (text) turns.push({ role, text: role === 'user' ? unwrap(text) : text, ts: r.timestamp ?? meta.timestamp })
  }
  const user = turns.find((t) => t.role === 'user')
  if (!user) return null
  return { id: meta.id, title: user.text.split('\n')[0].slice(0, 300), startedAt: meta.timestamp, updatedAt: turns[turns.length - 1].ts, messages: collect(turns, 'codex') }
}

function claudeFiles(p: Project) {
  const dir = path.join(claudeDir(), 'projects', p.path.replace(/[^a-zA-Z0-9]/g, '-'))
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
}

function codexFiles() {
  const root = path.join(codexDir(), 'sessions')
  if (!fs.existsSync(root)) return []
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name))
      else if (e.name.endsWith('.jsonl')) files.push(path.join(dir, e.name))
    }
  }
  walk(root)
  return files
}

const sessionsOf = (p: Project) => new Set(store.listThreads(p).flatMap((t) => t.agentSessions.map((s) => s.sessionId)))

// Codex rollouts of other projects are skipped by their cwd, so only the first lines are read.
function codexCwd(file: string) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(4096)
  const n = fs.readSync(fd, buf, 0, buf.length, 0)
  fs.closeSync(fd)
  try {
    return JSON.parse(buf.toString('utf8', 0, n).split('\n')[0]).payload?.cwd
  } catch {
    return null
  }
}

export function listSessions(p: Project): ImportableSession[] {
  const imported = sessionsOf(p)
  const found: ImportableSession[] = []
  for (const file of claudeFiles(p)) {
    const s = parseClaude(file)
    if (s) found.push({ provider: 'claude', id: s.id, title: s.title, startedAt: s.startedAt, messages: s.messages.length, imported: imported.has(s.id) })
  }
  for (const file of codexFiles()) {
    if (codexCwd(file) !== p.path) continue
    const s = parseCodex(file, p.path)
    if (s) found.push({ provider: 'codex', id: s.id, title: s.title, startedAt: s.startedAt, messages: s.messages.length, imported: imported.has(s.id) })
  }
  return found.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function importSessions(p: Project, wanted: { provider: 'claude' | 'codex'; id: string }[]) {
  const imported = sessionsOf(p)
  const threads: store.Thread[] = []
  for (const w of wanted) {
    if (imported.has(w.id)) continue
    const parsed =
      w.provider === 'claude'
        ? claudeFiles(p)
            .filter((f) => path.basename(f, '.jsonl') === w.id)
            .map(parseClaude)[0]
        : codexFiles()
            .filter((f) => f.includes(w.id))
            .map((f) => parseCodex(f, p.path))[0]
    if (!parsed) continue
    const t = store.createThread(p, { title: parsed.title, agent: mergeAgent(p.agent, { provider: w.provider }) })
    store.writeMessages(p, t.id, parsed.messages.map((m) => ({ id: store.newId(), ...m })))
    const thread = { ...t, createdAt: parsed.startedAt, updatedAt: parsed.updatedAt, agentSessions: [{ provider: w.provider, sessionId: parsed.id }] }
    store.saveThread(p, thread)
    imported.add(parsed.id)
    threads.push(thread)
  }
  return threads
}
