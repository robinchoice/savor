import { useState } from 'preact/hooks'
import { ArrowLeft, Play, Plus, Clock, Link2, Pencil, Trash2, LayoutGrid, Sparkles } from 'lucide-preact'
import { api, duration, go, runTrigger, useApi, type Project, type Run, type SavorEvent, type Thread, type Workflow } from './api'
import { CATEGORIES, RECIPES, recipe, type Recipe } from './recipes'
import { describeCron } from './cron'

const SCHEDULES: [string, string][] = [
  ['', 'Manual: run it yourself'],
  ['0 9 * * 1-5', 'Every weekday at 9:00'],
  ['0 9 * * *', 'Every day at 9:00'],
  ['0 9 * * 1', 'Every Monday at 9:00'],
  ['0 * * * *', 'Every hour'],
]

const STATUS: Record<Run['status'], [ring: string, label: string]> = { working: ['busy', 'Working'], needs: ['needs', 'Your turn'], failed: ['error', 'Failed'], finished: ['done', 'Finished'], skipped: ['skipped', 'Skipped'] }
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const schedule = (w: Workflow) => (w.cron ? w.scheduleLabel || describeCron(w.cron) : 'Manual')
// A run changes with its conversation, so the runs follow the project's conversations too.
const runsChanged = (project: Project) => (e: SavorEvent) => (e.type === 'workflows' || e.type === 'thread' || e.type === 'status') && e.projectId === project.id

// Routes: workflows | workflows/gallery | workflows/new[/:recipe] | workflows/:id[/edit]
export function Workflows({ project, rest }: { project: Project; rest: string[] }) {
  const [workflowId, slug] = rest
  const base = `/projects/${project.id}/workflows`
  const [workflows] = useApi<Workflow[]>(base, runsChanged(project))
  const current = workflows?.find((w) => w.id === workflowId)

  const run = async (w: Workflow) => {
    const t = await api<Thread>('POST', `${base}/${w.id}/run`)
    go(`/p/${project.id}/t/${t.id}`)
  }
  const toggle = (w: Workflow) => api('PUT', `${base}/${w.id}`, { ...w, enabled: !w.enabled })
  // Workflows without a collection come first, then each collection under its name.
  const collections = [...new Set(workflows?.map((w) => w.collection))].sort((a, b) => a.localeCompare(b))

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
        {collections.flatMap((c) => [
          c && (
            <div key={`collection ${c}`} class="menu-label">
              {c}
            </div>
          ),
          ...workflows!
            .filter((w) => w.collection === c)
            .map((w) => (
              <a key={w.id} href={`#/p/${project.id}/workflows/${w.id}`} class={`card ${w.id === workflowId ? 'active' : ''}`}>
                <div class="card-title">{w.name}</div>
                <div class="card-meta">
                  <span>
                    <Clock size={12} /> {schedule(w)}
                    {w.next.length ? (
                      <>
                        {' '}
                        · <Link2 size={12} /> {w.next.length}
                      </>
                    ) : null}
                  </span>
                  <span class={w.enabled ? 'on-badge' : 'off-badge'}>{w.enabled ? 'On' : 'Off'}</span>
                </div>
                {w.lastRun && (
                  <div class={`last-run ${w.lastRun.status}`}>
                    <span class={`ring ${STATUS[w.lastRun.status][0]}`} /> {STATUS[w.lastRun.status][1]} · {when(w.lastRun.at)}
                  </div>
                )}
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
            )),
        ])}
        {workflows && !workflows.length && <p class="muted pad">Save repeatable work as a workflow. Give it a schedule and Savor runs it for you, or start from the gallery.</p>}
      </aside>
      <section class="detail">
        {workflowId === 'gallery' ? (
          <Gallery project={project} />
        ) : workflowId === 'new' || (current && slug === 'edit') ? (
          <WorkflowForm key={`${workflowId}/${slug ?? ''}`} base={base} projectId={project.id} workflow={current ?? null} recipe={current ? undefined : slug ? recipe(slug) : undefined} all={workflows ?? []} />
        ) : current ? (
          <Overview key={current.id} base={base} project={project} workflow={current} onRun={() => run(current)} />
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

// What the workflow did: its runs, newest first. Each opens its conversation; a skipped time opens the one that was in its way.
function Overview({ base, project, workflow: w, onRun }: { base: string; project: Project; workflow: Workflow; onRun: () => void }) {
  const [runs] = useApi<Run[]>(`${base}/${w.id}/runs`, runsChanged(project))
  const blocker = (r: Run) => runs?.find((x) => x.threadId === r.threadId && x.status !== 'skipped')
  return (
    <div class="wf-over">
      <div class="wf-head">
        <div>
          <h1>{w.name}</h1>
          <div class="wf-sub">
            <span>
              <Clock size={12} /> {schedule(w)}
            </span>
            {w.nextRunAt && <span>Next run {new Date(w.nextRunAt).toLocaleString()}</span>}
            <span class={w.enabled ? 'on-badge' : 'off-badge'}>{w.enabled ? 'On' : 'Off'}</span>
            {w.collection && <span>{w.collection}</span>}
          </div>
        </div>
        <div class="wf-actions">
          <button class="ghost" onClick={onRun}>
            <Play size={14} /> Run now
          </button>
          <a class="ghost" href={`#/p/${project.id}/workflows/${w.id}/edit`}>
            <Pencil size={14} /> Edit
          </a>
        </div>
      </div>
      <div class="runs">
        <div class="runs-head">Runs</div>
        {runs?.map((r) => (
          <a key={`${r.at} ${r.threadId}`} href={`#/p/${project.id}/t/${r.threadId}`} class={`run ${r.status}`}>
            <span class={`ring ${STATUS[r.status][0]}`} title={STATUS[r.status][1]} />
            <span class="when">
              <b>{when(r.at)}</b>
              <small>
                {STATUS[r.status][1]} · {runTrigger(r)}
              </small>
            </span>
            <span class="sum">{r.status === 'skipped' ? `The run from ${blocker(r) ? when(blocker(r)!.at) : 'before'} was still open.` : r.status === 'working' ? 'Working…' : r.summary}</span>
            <span class="dur">{r.workedMs ? duration(r.workedMs) : ''}</span>
          </a>
        ))}
        {runs && !runs.length && <p class="muted pad">No runs yet. {w.cron && w.enabled ? 'The first one starts on schedule.' : 'Start one with “Run now”.'}</p>}
      </div>
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
    collection: '',
    timezone: tz,
    enabled: true,
    catchUp: true,
    next: [] as string[],
    ...workflow,
    cron: workflow?.cron ?? recipe?.schedule ?? '',
  })
  const [custom, setCustom] = useState(() => !!draft.cron && !SCHEDULES.some(([c]) => c === draft.cron))
  const [error, setError] = useState('')
  const field = (k: 'name' | 'prompt' | 'collection' | 'cron' | 'timezone') => (e: Event) => setDraft({ ...draft, [k]: (e.currentTarget as HTMLInputElement).value })
  const others = all.filter((w) => w.id !== workflow?.id)
  const collections = [...new Set(all.map((w) => w.collection).filter(Boolean))].sort((a, b) => a.localeCompare(b))

  const save = async (e: Event) => {
    e.preventDefault()
    try {
      const w = await api<Workflow>(workflow ? 'PUT' : 'POST', workflow ? `${base}/${workflow.id}` : base, { ...draft, collection: draft.collection.trim(), cron: draft.cron.trim() || null })
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
      {workflow && (
        <a class="back-link" href={`#/p/${projectId}/workflows/${workflow.id}`}>
          <ArrowLeft size={14} /> Runs
        </a>
      )}
      <h1>{workflow ? workflow.name : recipe ? `New workflow from “${recipe.title}”` : 'New workflow'}</h1>
      <label>
        Name
        <input required value={draft.name} onInput={field('name')} />
      </label>
      <label>
        Collection <small class="muted">optional, groups the list</small>
        <input list="workflow-collections" value={draft.collection} onInput={field('collection')} />
        <datalist id="workflow-collections">
          {collections.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
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
      {draft.cron && (
        <label class="check with-hint">
          <input type="checkbox" checked={draft.catchUp} onChange={(e) => setDraft({ ...draft, catchUp: e.currentTarget.checked })} />
          <span>
            Catch up a missed run when Savor starts
            <small class="muted">If Savor was not running at the scheduled time, the workflow runs once at the next start.</small>
          </span>
        </label>
      )}
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
