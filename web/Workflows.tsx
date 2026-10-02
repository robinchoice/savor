import { useState } from 'preact/hooks'
import { Play, Plus, Clock, Link2, Trash2, LayoutGrid, Sparkles } from 'lucide-preact'
import { api, go, useApi, type Project, type Thread, type Workflow } from './api'
import { CATEGORIES, RECIPES, recipe, type Recipe } from './recipes'
import { describeCron } from './cron'

const SCHEDULES: [string, string][] = [
  ['', 'Manual: run it yourself'],
  ['0 9 * * 1-5', 'Every weekday at 9:00'],
  ['0 9 * * *', 'Every day at 9:00'],
  ['0 9 * * 1', 'Every Monday at 9:00'],
  ['0 * * * *', 'Every hour'],
]

// Routes: workflows | workflows/gallery | workflows/new[/:recipe] | workflows/:id
export function Workflows({ project, rest }: { project: Project; rest: string[] }) {
  const [workflowId, slug] = rest
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
        <a href={`#/p/${project.id}/workflows/gallery`} class={`gallery-link ${workflowId === 'gallery' ? 'active' : ''}`}>
          <LayoutGrid size={15} /> Gallery <small class="muted">{RECIPES.length} ready-made workflows</small>
        </a>
        {project.paused && <div class="banner">Project paused — scheduled runs are skipped.</div>}
        {workflows?.map((w) => (
          <a key={w.id} href={`#/p/${project.id}/workflows/${w.id}`} class={`card ${w.id === workflowId ? 'active' : ''}`}>
            <div class="card-title">{w.name}</div>
            <div class="card-meta">
              <span>
                <Clock size={12} /> {w.cron ? describeCron(w.cron) : 'Manual'}
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
        {workflows && !workflows.length && <p class="muted pad">Save repeatable work as a workflow. Give it a schedule and Savor runs it for you, or start from the gallery.</p>}
      </aside>
      <section class="detail">
        {workflowId === 'gallery' ? (
          <Gallery project={project} />
        ) : workflowId === 'new' || current ? (
          <WorkflowForm key={`${workflowId}/${slug ?? ''}`} base={base} projectId={project.id} workflow={current ?? null} recipe={slug ? recipe(slug) : undefined} all={workflows ?? []} />
        ) : (
          <div class="empty-state">
            <h2>Workflows</h2>
            <p class="muted">Pick a workflow, create a new one, or start from the gallery.</p>
          </div>
        )}
      </section>
    </div>
  )
}

function Gallery({ project }: { project: Project }) {
  return (
    <div class="gallery">
      <div class="gallery-head">
        <h1>
          <Sparkles size={20} /> Workflow gallery
        </h1>
        <p class="muted">Ready-made workflows. Pick one, adjust the instructions and schedule, and save it to this project.</p>
      </div>
      {CATEGORIES.map((cat) => (
        <section key={cat}>
          <h2>{cat}</h2>
          <div class="recipe-grid">
            {RECIPES.filter((r) => r.category === cat).map((r) => (
              <a key={r.slug} class="recipe" href={`#/p/${project.id}/workflows/new/${r.slug}`}>
                <b>{r.title}</b>
                <span>{r.blurb}</span>
                <small class="muted">
                  <Clock size={11} /> {r.schedule ? describeCron(r.schedule) : 'Manual'}
                </small>
              </a>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

function WorkflowForm({ base, projectId, workflow, recipe, all }: { base: string; projectId: string; workflow: Workflow | null; recipe?: Recipe; all: Workflow[] }) {
  const [draft, setDraft] = useState({
    name: recipe?.title ?? '',
    prompt: recipe?.prompt ?? '',
    timezone: tz,
    enabled: true,
    next: [] as string[],
    ...workflow,
    cron: workflow?.cron ?? recipe?.schedule ?? '',
  })
  const [custom, setCustom] = useState(() => !!draft.cron && !SCHEDULES.some(([c]) => c === draft.cron))
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
      <h1>{workflow ? workflow.name : recipe ? `New workflow from “${recipe.title}”` : 'New workflow'}</h1>
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
          Schedule
          <select
            value={custom ? 'custom' : draft.cron}
            onChange={(e) => {
              const v = e.currentTarget.value
              setCustom(v === 'custom')
              if (v !== 'custom') setDraft({ ...draft, cron: v })
            }}
          >
            {SCHEDULES.map(([c, label]) => (
              <option key={c} value={c}>
                {label}
              </option>
            ))}
            <option value="custom">Custom cron…</option>
          </select>
        </label>
        {custom && (
          <label>
            Cron expression <small class="muted">minute hour day month weekday</small>
            <input placeholder="0 9 * * 1-5" value={draft.cron} onInput={field('cron')} />
          </label>
        )}
        {(custom || draft.cron) && (
          <label>
            Timezone
            <input value={draft.timezone} onInput={field('timezone')} />
          </label>
        )}
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
