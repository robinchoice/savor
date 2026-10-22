import { useEffect, useRef, useState } from 'preact/hooks'
import { ArrowLeft, Play, Plus, Clock, Link2, Pencil, Trash2, LayoutGrid, Sparkles, MessageSquare } from 'lucide-preact'
import { api, duration, go, runTrigger, useApi, type Project, type Run, type SavorEvent, type Thread, type Workflow } from './api'
import { CATEGORIES, RECIPES, recipe, type Recipe } from './recipes'
import { describeCron } from './cron'
import { t, tx } from './i18n'

const SCHEDULES: [string, string][] = [
  ['', t('Manual: run it yourself')],
  ['0 9 * * 1-5', t('Every weekday at 9:00')],
  ['0 9 * * *', t('Every day at 9:00')],
  ['0 9 * * 1', t('Every Monday at 9:00')],
  ['0 * * * *', t('Every hour')],

]

export const STATUS: Record<Run['status'], [ring: string, label: string]> = { working: ['busy', t('Working')], needs: ['needs', t('Your turn')], stopped: ['', t('Stopped')], budget: ['error', t('Budget reached')], failed: ['error', t('Failed')], finished: ['done', t('Finished')], skipped: ['skipped', t('Skipped')] }
const OUTCOME = { successful: t('Successful'), partial: t('Partial'), blocked: t('Blocked'), skipped: t('Skipped'), waiting: t('Waiting for you'), failed: t('Failed'), unknown: t('Outcome unknown') }
export const resultLabel = (r: Run) => [r.modelStarted === false ? t('No agent started') : STATUS[r.status][1], r.outcome && OUTCOME[r.outcome]].filter(Boolean).join(' · ')
const resultRing = (r: Run) => r.status !== 'finished' || !r.outcome ? STATUS[r.status][0] : r.outcome === 'successful' ? 'done' : r.outcome === 'blocked' || r.outcome === 'failed' ? 'error' : r.outcome === 'waiting' ? 'needs' : r.outcome === 'skipped' ? 'skipped' : ''
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const cronLabel = (w: Workflow) => (w.cron ? w.scheduleLabel || describeCron(w.cron) : '')
export const schedule = (w: Workflow) => [cronLabel(w), w.onModelChange && t('On a model change')].filter(Boolean).join(' · ') || t('Manual')
// What runs used, as their agents report it: cost in USD, or tokens.
const usage = (u: { usd?: number; tokens?: number }) =>
  [u.usd != null && `$${u.usd.toFixed(2)}`, u.tokens && `${new Intl.NumberFormat(undefined, { notation: 'compact' }).format(u.tokens)} ${t('tokens')}`].filter(Boolean).join(' · ')
// A run changes with its conversation, so the runs follow the project's conversations too.
const runsChanged = (project: Project) => (e: SavorEvent) => (e.type === 'workflows' || e.type === 'thread' || e.type === 'status') && e.projectId === project.id

// The workflows of all projects with a button in the top bar, behind one menu so they leave the tabs their room.
export function WorkflowButtons() {
  const [buttons] = useApi<{ id: string; name: string; projectId: string; nextRunAt: string | null }[]>('/workflows/buttons', (e) => e.type === 'workflows' || e.type === 'projects')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const on = (e: MouseEvent) => !e.composedPath().includes(ref.current!) && setOpen(false)
    setTimeout(() => addEventListener('click', on))
    return () => removeEventListener('click', on)
  }, [open])
  if (!buttons?.length) return null
  const run = async (b: (typeof buttons)[number]) => {
    setOpen(false)
    const t = await api<Thread>('POST', `/projects/${b.projectId}/workflows/${b.id}/run`, { early: true })
    go(`/p/${b.projectId}/t/${t.id}`)
  }
  const replaces = (b: (typeof buttons)[number]) => b.nextRunAt && Date.parse(b.nextRunAt) - Date.now() < 12 * 3600_000
  return (
    <div class="menu-anchor" ref={ref}>
      <button class={`icon-btn wf-menu-btn ${open ? 'on' : ''}`} title={t('Run a workflow now')} onClick={() => setOpen(!open)}>
        <Play size={17} />
      </button>
      {open && (
        <div class="menu right workflows">
          <div class="menu-label">{t('Run now')}</div>
          {buttons.map((b) => (
            <button key={b.id} class="wf-button" onClick={() => run(b)}>
              <Play size={14} />
              <span>
                {b.name}
                {replaces(b) && <small>{t('In place of the run at {when}', { when: when(b.nextRunAt!) })}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

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
          <h2>{t('Workflows')}</h2>
          <a class="new-btn" href={`#/p/${project.id}/workflows/new`} title={t('New workflow')}>
            <Plus size={18} />
          </a>
        </div>
        <a href={`#/p/${project.id}/workflows/gallery`} class={`gallery-link ${workflowId === 'gallery' ? 'active' : ''}`}>
          <LayoutGrid size={15} /> {t('Gallery')} <small class="muted">{t('{n} ready-made workflows', { n: RECIPES.length })}</small>
        </a>
        {project.paused && <div class="banner">{t('Project paused — scheduled runs are skipped.')}</div>}
        {collections.flatMap((c) => [
          c && (
            <div key={`collection ${c}`} class="menu-label">
              {t(c)}
            </div>
          ),
          ...workflows!
            .filter((w) => w.collection === c)
            .map((w) => (
              <a key={w.id} href={`#/p/${project.id}/workflows/${w.id}`} class={`card ${w.id === workflowId ? 'active' : ''}`}>
                <div class="card-title">{t(w.name)}</div>
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
                  <span class={w.enabled ? 'on-badge' : 'off-badge'}>{w.enabled ? t('On') : t('Off')}</span>
                </div>
                {w.lastRun && (
                  <div class={`last-run ${w.lastRun.status}`}>
                    <span class={`ring ${resultRing(w.lastRun)}`} /> {resultLabel(w.lastRun)} · {when(w.lastRun.at)}
                  </div>
                )}
                {w.nextRunAt && <small class="muted">{t('Next run {when}', { when: when(w.nextRunAt) })}</small>}
                <div class="row" onClick={(e) => e.preventDefault()}>
                  <button class="ghost small" onClick={() => run(w)}>
                    <Play size={13} /> {t('Run now')}
                  </button>
                  <button class="ghost small" onClick={() => toggle(w)}>
                    {w.enabled ? t('Pause') : t('Enable')}
                  </button>
                </div>
              </a>
            )),
        ])}
        {workflows && !workflows.length && <p class="muted pad">{t('Save repeatable work as a workflow. Give it a schedule and Savor runs it for you, or start from the gallery.')}</p>}
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
            <h2>{t('Workflows')}</h2>
            <p class="muted">{t('Pick a workflow, create a new one, or start from the gallery.')}</p>
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
  const remove = async () => {
    if (!confirm(t('Delete “{name}”?', { name: w.name }))) return
    await api('DELETE', `${base}/${w.id}`)
    go(`/p/${project.id}/workflows`)
  }
  return (
    <div class="wf-over">
      <div class="wf-head">
        <div>
          <h1>{t(w.name)}</h1>
          <div class="wf-sub">
            <span>
              <Clock size={12} /> {schedule(w)}
            </span>
            {w.nextRunAt && <span>{t('Next run {when}', { when: when(w.nextRunAt) })}</span>}
            <span class={w.enabled ? 'on-badge' : 'off-badge'}>{w.enabled ? t('On') : t('Off')}</span>
            {w.collection && <span>{t(w.collection)}</span>}
            {w.lastRun && usage(w.lastRun) && <span>{t('Last run {usage}', { usage: usage(w.lastRun) })}</span>}
            {w.month && (w.month.usd || w.month.tokens || w.monthlyBudgetUsd) ? (
              <span class={w.monthlyBudgetUsd && w.month.usd != null && w.month.usd >= w.monthlyBudgetUsd ? 'danger' : ''}>
                {t('This month {usage}', { usage: usage(w.month) || t('Usage unknown') })}
                {w.monthlyBudgetUsd ? ` ${t('of')} $${w.monthlyBudgetUsd}` : ''}
              </span>
            ) : null}
            {w.thread && (
              <a href={`#/p/${project.id}/t/${w.thread.id}`}>
                <MessageSquare size={12} /> {t('Saved in “{title}”', { title: w.thread.title })}
              </a>
            )}
          </div>
        </div>
        <div class="wf-actions">
          <button class="ghost" onClick={onRun}>
            <Play size={14} /> {t('Run now')}
          </button>
          <a class="ghost" href={`#/p/${project.id}/workflows/${w.id}/edit`}>
            <Pencil size={14} /> {t('Edit')}
          </a>
          <button class="ghost danger" onClick={remove}>
            <Trash2 size={14} /> {t('Delete')}
          </button>
        </div>
      </div>
      <div class="runs">
        <div class="runs-head">{t('Runs')}</div>
        {runs?.map((r) => (
          <a key={`${r.at} ${r.threadId}`} href={`#/p/${project.id}/t/${r.threadId}`} class={`run ${r.status}`}>
            <span class={`ring ${resultRing(r)}`} title={resultLabel(r)} />
            <span class="when">
              <b>{when(r.at)}</b>
              <small>
                {resultLabel(r)} · {runTrigger(r)}
              </small>
            </span>
            <span class="sum" title={r.steps?.flatMap((s) => s.result ? [s.name, ...s.result.evidence, ...s.result.followUp] : []).join('\n')}>{r.steps?.some((s) => s.result) ? r.steps.filter((s) => s.result).map((s) => `${s.name}: ${tx(s.result!.reason)}${s.result!.followUp.length ? ` · ${s.result!.followUp.map(tx).join(' · ')}` : ''}`).join(' · ') : r.status === 'skipped' ? (blocker(r) ? t('The run from {when} was still open.', { when: when(blocker(r)!.at) }) : t('The run before was still open.')) : r.status === 'working' ? t('Working…') : r.summary}</span>
            <span class="dur">{[r.workedMs ? duration(r.workedMs) : '', usage(r)].filter(Boolean).join(' · ')}</span>
          </a>
        ))}
        {runs && !runs.length && <p class="muted pad">{t('No runs yet.')} {w.cron && w.enabled ? t('The first one starts on schedule.') : t('Start one with “Run now”.')}</p>}
      </div>
    </div>
  )
}

function Gallery({ project }: { project: Project }) {
  return (
    <div class="gallery">
      <div class="gallery-head">
        <h1>
          <Sparkles size={20} /> {t('Workflow gallery')}
        </h1>
        <p class="muted">{t('Ready-made workflows. Pick one, adjust the instructions and schedule, and save it to this project.')}</p>
      </div>
      {CATEGORIES.map((cat) => (
        <section key={cat}>
          <h2>{t(cat)}</h2>
          <div class="recipe-grid">
            {RECIPES.filter((r) => r.category === cat).map((r) => (
              <a key={r.slug} class="recipe" href={`#/p/${project.id}/workflows/new/${r.slug}`}>
                <b>{t(r.title)}</b>
                <span>{t(r.blurb)}</span>
                <small class="muted">
                  <Clock size={11} /> {[r.schedule && describeCron(r.schedule), r.onModelChange && t('On a model change')].filter(Boolean).join(' · ') || t('Manual')}
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
    name: recipe ? t(recipe.title) : '',
    prompt: recipe?.prompt ?? '',
    collection: '',
    timezone: tz,
    enabled: true,
    catchUp: true,
    button: false,
    onModelChange: recipe?.onModelChange ?? false,
    next: [] as string[],
    budgetUsd: null as number | null,
    monthlyBudgetUsd: null as number | null,
    ...workflow,
    cron: workflow?.cron ?? recipe?.schedule ?? '',
  })
  const [custom, setCustom] = useState(() => !!draft.cron && !SCHEDULES.some(([c]) => c === draft.cron))
  const [error, setError] = useState('')
  const field = (k: 'name' | 'prompt' | 'collection' | 'cron' | 'timezone') => (e: Event) => setDraft({ ...draft, [k]: (e.currentTarget as HTMLInputElement).value })
  const usd = (k: 'budgetUsd' | 'monthlyBudgetUsd') => (e: Event) => setDraft({ ...draft, [k]: Number((e.currentTarget as HTMLInputElement).value) || null })
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
    if (!workflow || !confirm(t('Delete “{name}”?', { name: workflow.name }))) return
    await api('DELETE', `${base}/${workflow.id}`)
    go(`/p/${projectId}/workflows`)
  }
  return (
    <form class="form" onSubmit={save}>
      {workflow && (
        <a class="back-link" href={`#/p/${projectId}/workflows/${workflow.id}`}>
          <ArrowLeft size={14} /> {t('Runs')}
        </a>
      )}
      <h1>{workflow ? workflow.name : recipe ? t('New workflow from “{title}”', { title: t(recipe.title) }) : t('New workflow')}</h1>
      <label>
        {t('Name')}
        <input required value={draft.name} onInput={field('name')} />
      </label>
      <label>
        {t('Collection')} <small class="muted">{t('optional, groups the list')}</small>
        <input list="workflow-collections" value={draft.collection} onInput={field('collection')} />
        <datalist id="workflow-collections">
          {collections.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      <label>
        {t('Instructions')}
        <textarea required rows={10} value={draft.prompt} onInput={field('prompt')} placeholder={t('What should the agent do each time this runs?')} />
      </label>
      <div class="row wide">
        <label>
          {t('Schedule')}
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
            <option value="custom">{t('Custom cron…')}</option>
          </select>
        </label>
        {custom && (
          <label>
            {t('Cron expression')} <small class="muted">{t('minute hour day month weekday')}</small>
            <input placeholder="0 9 * * 1-5" value={draft.cron} onInput={field('cron')} />
          </label>
        )}
        {(custom || draft.cron) && (
          <label>
            {t('Timezone')}
            <input value={draft.timezone} onInput={field('timezone')} />
          </label>
        )}
      </div>
      {draft.cron && (
        <label class="check with-hint">
          <input type="checkbox" checked={draft.catchUp} onChange={(e) => setDraft({ ...draft, catchUp: e.currentTarget.checked })} />
          <span>
            {t('Catch up a missed run when Savor starts')}
            <small class="muted">{t('If Savor was not running at the scheduled time, the workflow runs once at the next start.')}</small>
          </span>
        </label>
      )}
      <label class="check with-hint">
        <input type="checkbox" checked={draft.onModelChange} onChange={(e) => setDraft({ ...draft, onModelChange: e.currentTarget.checked })} />
        <span>
          {t('Run when the model changes')}
          <small class="muted">{t('Runs once each time the project’s agent runs on a new model, then waits for the next one. Setting it only notes the current model.')}</small>
        </span>
      </label>
      <label class="check with-hint">
        <input type="checkbox" checked={draft.button} onChange={(e) => setDraft({ ...draft, button: e.currentTarget.checked })} />
        <span>
          {t('Show a button in the top bar')}
          <small class="muted">{t('One click runs the workflow now. When it is scheduled within the next 12 hours, this run takes the place of that one.')}</small>
        </span>
      </label>
      <div class="row wide">
        <label>
          {t('Budget per run')} <small class="muted">{t('USD, optional')}</small>
          <input type="number" min="0.01" step="0.01" value={draft.budgetUsd ?? ''} onInput={usd('budgetUsd')} />
          <small class="muted">{t('Claude Code stops the run there. Other agents have no budget.')}</small>
        </label>
        <label>
          {t('Monthly budget')} <small
 class="muted">{t('USD, optional')}</small>
          <input type="number" min="0.01" step="0.01" value={draft.monthlyBudgetUsd ?? ''} onInput={usd('monthlyBudgetUsd')} />
          <small class="muted">{t('Warns at 80 % and pauses the workflow at 100 % of what its runs cost this month.')}</small>
        </label>
      </div>
      {others.length > 0 && (
        <fieldset class="chain">
          <legend>
            <Link2 size={14} /> {t('Continue with (chain)')}
          </legend>
          {others.map((w) => (
            <label key={w.id} class="check">
              <input
                type="checkbox"
                checked={draft.next.includes(w.id)}
                onChange={(e) => setDraft({ ...draft, next: e.currentTarget.checked ? [...draft.next, w.id] : draft.next.filter((id) => id !== w.id) })}
              />
              {t(w.name)}
            </label>
          ))}
        </fieldset>
      )}
      {error && <div class="error-text">{error}</div>}
      <div class="row">
        <button class="primary" type="submit">
          {t('Save')}
        </button>
        {workflow && (
          <button type="button" class="ghost danger" onClick={remove}>
            <Trash2 size={14} /> {t('Delete')}
          </button>
        )}
      </div>
    </form>
  )
}
