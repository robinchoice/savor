import { useState } from 'preact/hooks'
import { Check, Download, Plus, X } from 'lucide-preact'
import { api, go, useApi, type Project, type Workflow } from './api'

// The workspaces of the project types: Export for academic writing, Today for a Kontor. What they show
// is computed from the project's files; only the briefing comes from an agent.

interface Check { level: 'ok' | 'error' | 'warn' | 'info'; text: string; file?: string; line?: number }
interface ExportState { format: string; style: string | null; template: string | null; chapters: string[]; checks: Check[]; missingTools: string[]; exports: { path: string; at: string }[] }

const FORMATS: [string, string][] = [
  ['docx', 'DOCX'],
  ['latex', 'PDF (LaTeX)'],
  ['typst', 'PDF (Typst)'],
]
const STYLES: [string, string][] = [
  ['apa', 'APA 7'],
  ['iso690-author-date-de', 'DIN ISO 690'],
  ['harvard-cite-them-right', 'Harvard'],
  ['ieee', 'IEEE'],
  ['chicago-author-date', 'Chicago'],
]
const MARK = { ok: '✓', error: '✗', warn: '!', info: '·' }

const useWorkflow = (project: Project, name: string) => {
  const [workflows] = useApi<Workflow[]>(`/projects/${project.id}/workflows`, (e) => e.type === 'workflows' && e.projectId === project.id)
  return workflows?.find((w) => w.name === name)
}
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function ExportView({ project }: { project: Project }) {
  const base = `/projects/${project.id}/export`
  const [state, reload] = useApi<ExportState>(base, (e) => e.type === 'connected')
  const check = useWorkflow(project, 'Check citations')
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ path: string; words: number; warnings: string } | null>(null)
  const [error, setError] = useState('')
  const set = async (body: { format?: string; style?: string }) => {
    setBusy(body.format ?? body.style!)
    setError('')
    try {
      await api('PATCH', base, body)
      await reload()
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(null)
  }
  const run = async () => {
    setBusy('export')
    setError('')
    setResult(null)
    try {
      setResult(await api('POST', base))
      await reload()
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(null)
  }
  // The agent gets the findings as they are, and the conversation opens.
  const fix = async () => {
    const problems = state!.checks.filter((c) => c.level === 'error' || c.level === 'warn')
    const text = `Fix what keeps the manuscript from a clean export:\n\n${problems.map((c) => `- ${c.text}${c.file ? ` (${c.file}${c.line ? `:${c.line}` : ''})` : ''}`).join('\n')}\n\nDo not invent sources: if a citation has no entry, find the work and check its DOI, or tell me what is missing.`
    const t = await api<{ id: string }>('POST', `/projects/${project.id}/threads`, { text })
    go(`/p/${project.id}/t/${t.id}`)
  }
  if (!state) return <div class="page" />
  const problems = state.checks.some((c) => c.level === 'error' || c.level === 'warn')
  const label = (FORMATS.find(([id]) => id === state.format) ?? [state.format, state.format])[1]
  return (
    <div class="page">
      <div class="workspace">
        <div class="workspace-grid">
          <section class="ws-card">
            <h3>
              Settings <small class="muted mono">pandoc.yaml</small>
            </h3>
            <div class="field-label">Format</div>
            <div class="ws-chips">
              {FORMATS.map(([id, l]) => (
                <button key={id} class={`ws-chip ${state.format === id ? 'on' : ''}`} disabled={!!busy} onClick={() => set({ format: id })}>
                  {l}
                </button>
              ))}
            </div>
            <div class="field-label">Citation style</div>
            <div class="ws-chips">
              {STYLES.map(([id, l]) => (
                <button key={id} class={`ws-chip ${state.style === id ? 'on' : ''}`} disabled={!!busy} onClick={() => set({ style: id })}>
                  {busy === id ? 'Fetching…' : l}
                </button>
              ))}
              {state.style && !STYLES.some(([id]) => id === state.style) && <span class="ws-chip on">{state.style}</span>}
            </div>
            {state.template && (
              <>
                <div class="field-label">Template</div>
                <span class="mono small">{state.template}</span>
              </>
            )}
            <div class="field-label">Chapters</div>
            <span class="mono small muted">{state.chapters.length ? `${state.chapters.length} files in manuscript/, in name order` : 'none yet'}</span>
          </section>
          <section class="ws-card">
            <h3>Before export</h3>
            {state.checks.map((c, i) => (
              <div key={i} class={`ws-check lvl-${c.level}`}>
                <i>{MARK[c.level]}</i>
                <span>
                  {c.text}
                  {c.file && (
                    <>
                      {' · '}
                      <a href={`#/p/${project.id}/files/f/${encodeURIComponent(c.file)}${c.line ? `/${c.line}` : ''}`}>
                        {c.file}
                        {c.line ? `:${c.line}` : ''}
                      </a>
                    </>
                  )}
                </span>
              </div>
            ))}
            {check?.lastRun && (
              <div class="ws-check lvl-info">
                <i>·</i>
                <span>
                  Check citations, {when(check.lastRun.at)}: <a href={`#/p/${project.id}/t/${check.lastRun.threadId}`}>{check.lastRun.summary || 'open the result'}</a>
                </span>
              </div>
            )}
            {problems && (
              <button class="ghost" onClick={fix}>
                Let the agent fix it
              </button>
            )}
          </section>
        </div>
        {state.missingTools.length > 0 && (
          <div class="ws-card missing">
            <b>{state.missingTools.join(' and ')} {state.missingTools.length > 1 ? 'are' : 'is'} not installed.</b>
            <span class="muted">The export needs {state.missingTools.join(' and ')} on this computer. Ask an agent to install {state.missingTools.length > 1 ? 'them' : 'it'}, or install {state.missingTools.length > 1 ? 'them' : 'it'} yourself.</span>
          </div>
        )}
        <div class="row">
          <button class="primary" disabled={!!busy || state.missingTools.length > 0 || !state.chapters.length} onClick={run}>
            <Download size={15} /> {busy === 'export' ? 'Exporting…' : `Export ${label}`}
          </button>
          <small class="muted">pandoc with pandoc.yaml → export/</small>
        </div>
        {error && <div class="error-text">{error}</div>}
        {result && (
          <div class="ws-card done">
            <div class="row">
              <Check size={15} /> <b>Exported</b> <span class="mono small">{result.path}</span> <span class="muted small">{result.words} words</span>
              <span class="spacer" />
              <a class="ghost" href={`/api${base}/${encodeURIComponent(result.path.replace(/^export\//, ''))}`} download>
                Download
              </a>
            </div>
            {result.warnings && <pre class="ws-warnings">{result.warnings}</pre>}
          </div>
        )}
        {state.exports.length > 0 && (
          <section class="ws-card">
            <h3>Earlier exports</h3>
            {state.exports.map((e) => (
              <a key={e.path} class="ws-file" href={`/api${base}/${encodeURIComponent(e.path.replace(/^export\//, ''))}`} download>
                <span class="mono small">{e.path}</span>
                <span class="muted small">{when(e.at)}</span>
              </a>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}

interface Task { line: number; raw: string; due: string | null; text: string }
interface Today { due: Task[]; open: Task[]; inbox: { path: string; isNew: boolean }[] }

export function TodayView({ project }: { project: Project }) {
  const base = `/projects/${project.id}/today`
  const [today, reload] = useApi<Today>(base, (e) => e.type === 'connected')
  const briefing = useWorkflow(project, 'Kontor briefing')
  const triage = useWorkflow(project, 'Inbox triage')
  // Ticked tasks stay in view, crossed out, until the next visit.
  const [done, setDone] = useState<Record<number, string>>({})
  const [adding, setAdding] = useState('')
  const [error, setError] = useState('')
  const tick = async (t: Task) => {
    const raw = done[t.line] ?? t.raw
    try {
      const next = await api<{ raw: string }>('PATCH', `${base}/tasks`, { line: t.line, raw, done: !(t.line in done) })
      const copy = { ...done }
      if (t.line in done) delete copy[t.line]
      else copy[t.line] = next.raw
      setDone(copy)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  const add = async (e: Event) => {
    e.preventDefault()
    if (!adding.trim()) return
    await api('POST', `${base}/tasks`, { text: adding })
    setAdding('')
    reload()
  }
  const runTriage = async () => {
    const t = await api<{ id: string }>('POST', `/projects/${project.id}/workflows/${triage!.id}/run`)
    go(`/p/${project.id}/t/${t.id}`)
  }
  if (!today) return <div class="page" />
  const now = new Date().toISOString().slice(0, 10)
  const task = (t: Task) => (
    <label key={t.line} class={`ws-task ${t.line in done ? 'done' : ''}`}>
      <input type="checkbox" checked={t.line in done} onChange={() => tick(t)} />
      {t.due && <span class={`ws-date ${t.due < now ? 'late' : 'soon'}`}>{new Date(t.due).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>}
      <span class="ws-task-text">{t.text}</span>
    </label>
  )
  const fresh = today.inbox.filter((f) => f.isNew).length
  return (
    <div class="page">
      <div class="workspace">
        <h2>{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
        <div class="workspace-grid">
          <div class="ws-col">
            <section class="ws-card">
              <h3>
                Due in the next 14 days <small class="muted">tasks.md</small>
              </h3>
              {today.due.length ? today.due.map(task) : <span class="muted small">Nothing due.</span>}
            </section>
            <section class="ws-card">
              <h3>Open tasks</h3>
              {today.open.map(task)}
              <form class="ws-add" onSubmit={add}>
                <Plus size={14} />
                <input placeholder="Add a task, e.g. 2026-10-30 Cancel the car insurance" value={adding} onInput={(e) => setAdding(e.currentTarget.value)} />
              </form>
            </section>
          </div>
          <div class="ws-col">
            <section class="ws-card">
              <h3>
                Briefing {briefing?.lastRun && <small class="muted">{when(briefing.lastRun.at)}</small>}
              </h3>
              {briefing?.lastRun ? (
                <>
                  <p class="ws-text">{briefing.lastRun.summary}</p>
                  <a href={`#/p/${project.id}/t/${briefing.lastRun.threadId}`}>Open the conversation →</a>
                </>
              ) : (
                <span class="muted small">{briefing ? 'The Kontor briefing has not run yet.' : 'There is no workflow named “Kontor briefing” in this project.'}</span>
              )}
            </section>
            <section class="ws-card">
              <h3>
                inbox/ <small class="muted">{fresh ? `${fresh} new since yesterday` : `${today.inbox.length} files`}</small>
              </h3>
              {today.inbox.map((f) => (
                <a key={f.path} class="ws-file" href={`#/p/${project.id}/files/f/${encodeURIComponent(f.path)}`}>
                  <span class="mono small">{f.path.replace(/^inbox\//, '')}</span>
                  {f.isNew && <span class="chip new">new</span>}
                </a>
              ))}
              {!today.inbox.length && <span class="muted small">Empty.</span>}
              {triage && today.inbox.length > 0 && (
                <button class="ghost" onClick={runTriage}>
                  Triage now
                </button>
              )}
            </section>
          </div>
        </div>
        {error && (
          <div class="error-text">
            {error}{' '}
            <button class="icon-btn" title="Dismiss" onClick={() => (setError(''), setDone({}), reload())}>
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
