import { useState } from 'preact/hooks'
import { Play, Plus, Clock, Link2, Trash2 } from 'lucide-preact'
import { api, go, useApi, type Project, type Thread, type Workflow } from './api'

export function Workflows({ project, workflowId }: { project: Project; workflowId?: string }) {
  const base = `/projects/${project.id}/workflows`
  const [workflows] = useApi<Workflow[]>(base, (e) => e.type === 'workflows' && e.projectId === project.id)
  const current = workflows?.find((w) => w.id === workflowId)

  const run = async (w: Workflow) => {
    const t = await api<Thread>('POST', `${base}/${w.id}/run`)
    go(`/p/${project.id}/t/${t.id}`)
  }
  const toggle = (w: Workflow) => api('PUT', `${base}/${w.id}`, { ...w, enabled: !w.enabled })

  return (
    <div class="split-page">
      <aside class="side-list">
        <div class="side-head">
          <h2>Workflows</h2>
          <a class="new-btn" href={`#/p/${project.id}/workflows/new`} title="New workflow">
            <Plus size={18} />
          </a>
        </div>
        {project.paused && <div class="banner">Project paused — scheduled runs are skipped.</div>}
        {workflows?.map((w) => (
          <a key={w.id} href={`#/p/${project.id}/workflows/${w.id}`} class={`card ${w.id === workflowId ? 'active' : ''}`}>
            <div class="card-title">{w.name}</div>
            <div class="card-meta">
              <span>
                <Clock size={12} /> {w.cron ? `${w.cron}` : 'Manual'}
                {w.next.length ? (
                  <>
                    {' '}
                    · <Link2 size={12} /> {w.next.length}
                  </>
                ) : null}
              </span>
              <span class={w.enabled ? 'on-badge' : 'off-badge'}>{w.enabled ? 'On' : 'Off'}</span>
            </div>
            {w.nextRunAt && <small class="muted">Next run {new Date(w.nextRunAt).toLocaleString()}</small>}
            <div class="row" onClick={(e) => e.preventDefault()}>
              <button class="ghost small" onClick={() => run(w)}>
                <Play size={13} /> Run now
              </button>
              <button class="ghost small" onClick={() => toggle(w)}>
                {w.enabled ? 'Pause' : 'Enable'}
              </button>
            </div>
          </a>
        ))}
        {workflows && !workflows.length && <p class="muted pad">Save repeatable work as a workflow. Give it a schedule and Savor runs it for you.</p>}
      </aside>
      <section class="detail">
        {workflowId === 'new' || current ? (
          <WorkflowForm key={workflowId} base={base} projectId={project.id} workflow={current ?? null} all={workflows ?? []} />
        ) : (
          <div class="empty-state">
            <h2>Workflows</h2>
            <p class="muted">Pick a workflow or create a new one.</p>
          </div>
        )}
      </section>
    </div>
  )
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

function WorkflowForm({ base, projectId, workflow, all }: { base: string; projectId: string; workflow: Workflow | null; all: Workflow[] }) {
  const [draft, setDraft] = useState({ name: '', prompt: '', timezone: tz, enabled: true, next: [] as string[], ...workflow, cron: workflow?.cron ?? '' })
  const [error, setError] = useState('')
  const field = (k: 'name' | 'prompt' | 'cron' | 'timezone') => (e: Event) => setDraft({ ...draft, [k]: (e.currentTarget as HTMLInputElement).value })
  const others = all.filter((w) => w.id !== workflow?.id)

  const save = async (e: Event) => {
    e.preventDefault()
    try {
      const w = await api<Workflow>(workflow ? 'PUT' : 'POST', workflow ? `${base}/${workflow.id}` : base, { ...draft, cron: draft.cron.trim() || null })
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
    <form class="form" onSubmit={save}>
      <h1>{workflow ? workflow.name : 'New workflow'}</h1>
      <label>
        Name
        <input required value={draft.name} onInput={field('name')} />
      </label>
      <label>
        Instructions
        <textarea required rows={10} value={draft.prompt} onInput={field('prompt')} placeholder="What should the agent do each time this runs?" />
      </label>
      <div class="row wide">
        <label>
          Schedule <small class="muted">cron, empty = manual only</small>
          <input placeholder="0 9 * * 1-5" value={draft.cron} onInput={field('cron')} />
        </label>
        <label>
          Timezone
          <input value={draft.timezone} onInput={field('timezone')} />
        </label>
      </div>
      {others.length > 0 && (
        <fieldset class="chain">
          <legend>
            <Link2 size={14} /> Continue with (chain)
          </legend>
          {others.map((w) => (
            <label key={w.id} class="check">
              <input
                type="checkbox"
                checked={draft.next.includes(w.id)}
                onChange={(e) => setDraft({ ...draft, next: e.currentTarget.checked ? [...draft.next, w.id] : draft.next.filter((id) => id !== w.id) })}
              />
              {w.name}
            </label>
          ))}
        </fieldset>
      )}
      {error && <div class="error-text">{error}</div>}
      <div class="row">
        <button class="primary" type="submit">
          Save
        </button>
        {workflow && (
          <button type="button" class="ghost danger" onClick={remove}>
            <Trash2 size={14} /> Delete
          </button>
        )}
      </div>
    </form>
  )
}
