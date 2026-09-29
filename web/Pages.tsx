import { useEffect, useState } from 'preact/hooks'
import { api, go, useApi, type Doc, type Proc, type Project, type Workflow } from './api'
import { Markdown } from './Thread'

// ---- documents ----

export function Documents({ project, docId }: { project: Project; docId?: string }) {
  const base = `/projects/${project.id}/docs`
  const [docs] = useApi<Doc[]>(base, (e) => e.type === 'documents' && e.projectId === project.id)
  const create = async () => {
    const d = await api<Doc>('POST', base, { title: 'Untitled', content: '' })
    go(`/p/${project.id}/docs/${d.id}?edit`)
  }
  return (
    <div class="split">
      <div class="list">
        <div class="list-head">
          <h2>Documents</h2>
          <button class="ghost" onClick={create}>
            + New
          </button>
        </div>
        {docs?.map((d) => (
          <a key={d.id} href={`#/p/${project.id}/docs/${d.id}`} class={d.id === docId?.replace('?edit', '') ? 'active' : ''}>
            {d.title}
            <small>{new Date(d.updatedAt).toLocaleString()}</small>
          </a>
        ))}
        {docs && !docs.length && <p class="muted">No documents yet. Agents create them with create_document.</p>}
      </div>
      {docId && <DocEditor key={docId} base={base} id={docId.replace('?edit', '')} startEditing={docId.endsWith('?edit')} projectId={project.id} />}
    </div>
  )
}

function DocEditor({ base, id, startEditing, projectId }: { base: string; id: string; startEditing: boolean; projectId: string }) {
  const [doc] = useApi<Doc>(`${base}/${id}`, (e) => e.type === 'documents' && e.projectId === projectId)
  const [editing, setEditing] = useState(startEditing)
  const [draft, setDraft] = useState({ title: '', content: '' })
  useEffect(() => {
    if (doc && (!editing || !draft.title)) setDraft({ title: doc.title, content: doc.content })
  }, [doc])

  if (!doc) return <div class="detail" />
  const save = async () => {
    await api('PUT', `${base}/${id}`, draft)
    setEditing(false)
  }
  const remove = async () => {
    if (!confirm(`Delete “${doc.title}”?`)) return
    await api('DELETE', `${base}/${id}`)
    go(`/p/${projectId}/docs`)
  }
  return (
    <article class="detail">
      {editing ? (
        <>
          <input class="title-input" value={draft.title} onInput={(e) => setDraft({ ...draft, title: e.currentTarget.value })} />
          <textarea class="doc-input" value={draft.content} onInput={(e) => setDraft({ ...draft, content: e.currentTarget.value })} />
          <div class="row">
            <button onClick={save}>Save</button>
            <button class="ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div class="row spread">
            <h1>{doc.title}</h1>
            <div class="row">
              <button class="ghost" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button class="ghost danger" onClick={remove}>
                Delete
              </button>
            </div>
          </div>
          <Markdown text={doc.content} />
        </>
      )}
    </article>
  )
}

// ---- workflows ----

const emptyWorkflow = { name: '', prompt: '', cron: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, enabled: true }

export function Workflows({ project, workflowId }: { project: Project; workflowId?: string }) {
  const base = `/projects/${project.id}/workflows`
  const [workflows] = useApi<Workflow[]>(base, (e) => e.type === 'workflows' && e.projectId === project.id)
  const current = workflowId === 'new' ? null : workflows?.find((w) => w.id === workflowId)

  const run = async (w: Workflow) => {
    const t = await api('POST', `${base}/${w.id}/run`)
    go(`/p/${project.id}/t/${t.id}`)
  }
  const toggle = (w: Workflow) => api('PUT', `${base}/${w.id}`, { ...w, enabled: !w.enabled })

  return (
    <div class="split">
      <div class="list">
        <div class="list-head">
          <h2>Workflows</h2>
          <a class="button ghost" href={`#/p/${project.id}/workflows/new`}>
            + New
          </a>
        </div>
        {workflows?.map((w) => (
          <div key={w.id} class={`card ${w.id === workflowId ? 'active' : ''}`}>
            <a href={`#/p/${project.id}/workflows/${w.id}`}>
              <strong>{w.name}</strong>
              <small>
                {w.cron ? `${w.cron} (${w.timezone})` : 'manual'} · {w.enabled ? 'enabled' : 'paused'}
                {w.lastRunAt && ` · last run ${new Date(w.lastRunAt).toLocaleString()}`}
              </small>
            </a>
            <div class="row">
              <button class="ghost" onClick={() => run(w)}>
                Run now
              </button>
              <button class="ghost" onClick={() => toggle(w)}>
                {w.enabled ? 'Pause' : 'Enable'}
              </button>
            </div>
          </div>
        ))}
        {workflows && !workflows.length && <p class="muted">Workflows are saved prompts. Give them a cron expression and Savor runs them on schedule.</p>}
      </div>
      {(workflowId === 'new' || current) && <WorkflowForm key={workflowId} base={base} projectId={project.id} workflow={current ?? null} />}
    </div>
  )
}

function WorkflowForm({ base, projectId, workflow }: { base: string; projectId: string; workflow: Workflow | null }) {
  const [draft, setDraft] = useState({ ...emptyWorkflow, ...workflow, cron: workflow?.cron ?? '' })
  const [error, setError] = useState('')
  const field = (k: keyof typeof draft) => (e: Event) => setDraft({ ...draft, [k]: (e.currentTarget as HTMLInputElement).value })

  const save = async (e: Event) => {
    e.preventDefault()
    try {
      const body = { ...draft, cron: draft.cron.trim() || null }
      const w = await api<Workflow>(workflow ? 'PUT' : 'POST', workflow ? `${base}/${workflow.id}` : base, body)
      setError('')
      go(`/p/${projectId}/workflows/${w.id}`)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  const remove = async () => {
    if (!workflow || !confirm(`Delete “${workflow.name}”?`)) return
    await api('DELETE', `${base}/${workflow.id}`)
    go(`/p/${projectId}/workflows`)
  }
  return (
    <form class="detail form" onSubmit={save}>
      <label>
        Name
        <input required value={draft.name} onInput={field('name')} />
      </label>
      <label>
        Prompt
        <textarea required rows={8} value={draft.prompt} onInput={field('prompt')} />
      </label>
      <div class="row">
        <label>
          Cron <small class="muted">empty = manual</small>
          <input placeholder="0 8 * * 1-5" value={draft.cron} onInput={field('cron')} />
        </label>
        <label>
          Timezone
          <input value={draft.timezone} onInput={field('timezone')} />
        </label>
      </div>
      {error && <div class="msg error">{error}</div>}
      <div class="row">
        <button type="submit">Save</button>
        {workflow && (
          <button type="button" class="ghost danger" onClick={remove}>
            Delete
          </button>
        )}
      </div>
    </form>
  )
}

// ---- processes ----

export function Processes({ project }: { project: Project }) {
  const base = `/projects/${project.id}/processes`
  const [procs] = useApi<Proc[]>(base, (e) => e.type === 'processes' && e.projectId === project.id)
  const [log, setLog] = useState<{ pid: number; text: string } | null>(null)

  const showLog = async (pid: number) => setLog({ pid, text: await (await fetch(`/api${base}/${pid}/log`)).text() })
  const kill = (p: Proc) => confirm(`Stop ${p.name} (PID ${p.pid})?`) && api('POST', `${base}/${p.pid}/kill`)

  return (
    <div class="page">
      <h2>Background processes</h2>
      {procs && !procs.length && <p class="muted">Nothing running. Agents register dev servers and watchers here.</p>}
      {procs?.map((p) => (
        <div key={p.pid} class="card">
          <div>
            <strong>{p.name}</strong> <small class="muted">PID {p.pid}</small>
            <div class="mono">{p.command}</div>
            <small class="muted">
              {p.url && (
                <>
                  <a href={p.url} target="_blank" rel="noreferrer">
                    {p.url}
                  </a>{' '}
                  ·{' '}
                </>
              )}
              <a href={`#/p/${project.id}/t/${p.threadId}`}>conversation</a> · since {new Date(p.startedAt).toLocaleString()}
            </small>
          </div>
          <div class="row">
            {p.log && (
              <button class="ghost" onClick={() => showLog(p.pid)}>
                Log
              </button>
            )}
            <button class="ghost danger" onClick={() => kill(p)}>
              Stop
            </button>
          </div>
        </div>
      ))}
      {log && (
        <div class="log">
          <div class="row spread">
            <strong>Log · PID {log.pid}</strong>
            <button class="ghost" onClick={() => setLog(null)}>
              ✕
            </button>
          </div>
          <pre>{log.text}</pre>
        </div>
      )}
    </div>
  )
}

// ---- settings ----

const MODES = ['acceptEdits', 'manual', 'auto', 'plan', 'bypassPermissions']

export function Settings({ project }: { project: Project }) {
  const [draft, setDraft] = useState({ name: project.name, ...project.agent })
  const [saved, setSaved] = useState(false)
  const set = (k: keyof typeof draft) => (e: Event) => {
    setSaved(false)
    setDraft({ ...draft, [k]: (e.currentTarget as HTMLInputElement).value })
  }

  const save = async (e: Event) => {
    e.preventDefault()
    const { name, ...agent } = draft
    await api('PATCH', `/projects/${project.id}`, { name, agent })
    setSaved(true)
  }
  const remove = async () => {
    if (!confirm(`Remove ${project.name} from Savor? Files stay on disk.`)) return
    await api('DELETE', `/projects/${project.id}`)
    go('/')
  }
  return (
    <form class="page form" onSubmit={save}>
      <h2>Project settings</h2>
      <p class="muted mono">{project.path}</p>
      <label>
        Name
        <input value={draft.name} onInput={set('name')} />
      </label>
      <label>
        Agent
        <select value={draft.provider} onChange={set('provider')}>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex (experimental)</option>
          <option value="opencode">OpenCode (experimental)</option>
        </select>
      </label>
      <label>
        Model <small class="muted">empty = agent default</small>
        <input value={draft.model} onInput={set('model')} />
      </label>
      {draft.provider === 'claude' && (
        <label>
          Permission mode <small class="muted">anything that still needs approval shows up in the conversation</small>
          <select value={draft.permissionMode} onChange={set('permissionMode')}>
            {MODES.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
      )}
      <div class="row">
        <button type="submit">Save</button>
        {saved && <span class="muted">Saved — applies to new agent sessions.</span>}
        <button type="button" class="ghost danger" onClick={remove}>
          Remove project
        </button>
      </div>
    </form>
  )
}
