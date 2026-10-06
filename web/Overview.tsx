import { useState } from 'preact/hooks'
import { Clock, Pause, Play, SquareArrowOutUpRight, Trash2, TriangleAlert, X } from 'lucide-preact'
import { api, avatarStyle, formatStamp, go, initial, kindOf, RINGS, useApi, type Project, type Thread, type Workflow } from './api'
import { STATUS, schedule, when } from './Workflows'
import { setPrefs, usePrefs } from './prefs'

type Of<T> = T & { projectId: string }
interface Overview { threads: Of<Thread>[]; workflows: Of<Workflow>[] }
// Workflows that may do the same job twice: the same name, or prompts that share many words.
interface Group { key: string; workflows: Of<Workflow>[]; why: string; strong: boolean }

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])
// Share of the words in either prompt that are in both. Unrelated prompts in the same style stay under 0.2.
function overlap(a: string, b: string) {
  const [x, y] = [words(a), words(b)]
  const both = [...x].filter((w) => y.has(w)).length
  return both / (x.size + y.size - both || 1)
}

function duplicates(workflows: Of<Workflow>[]): Group[] {
  const groupKey = (list: Of<Workflow>[]) => list.map((w) => `${w.projectId}/${w.id}`).sort().join('+')
  const describe = (list: Of<Workflow>[], first: string) => {
    const crons = new Set(list.map((w) => w.cron ?? ''))
    const on = list.filter((w) => w.enabled).length
    return [first, crons.size === 1 && list[0].cron && `same schedule (${schedule(list[0])})`, `${on} of ${list.length} on`].filter(Boolean).join(' · ')
  }
  const byName = new Map<string, Of<Workflow>[]>()
  for (const w of workflows) byName.set(norm(w.name), [...(byName.get(norm(w.name)) ?? []), w])
  const groups: Group[] = [...byName.values()].filter((l) => l.length > 1).map((l) => ({ key: groupKey(l), workflows: l, why: describe(l, 'Same name'), strong: true }))
  workflows.forEach((a, i) =>
    workflows.slice(i + 1).forEach((b) => {
      const share = norm(a.name) !== norm(b.name) && overlap(a.prompt, b.prompt)
      if (share && share >= 0.2) groups.push({ key: groupKey([a, b]), workflows: [a, b], why: describe([a, b], `Similar prompt (${Math.round(share * 100)} % shared words)`), strong: false })
    }),
  )
  return groups
}

const Avatar = ({ project }: { project?: Project }) => (
  <span class="avatar small" style={avatarStyle(project?.tint ?? '#63636b')}>
    {initial(project?.name ?? '?')}
  </span>
)

// Routes: all[/conversations | /workflows]
export function AllProjects({ projects, section }: { projects: Project[]; section?: string }) {
  const [data] = useApi<Overview>('/overview', (e) => ['projects', 'thread', 'status', 'workflows'].includes(e.type))
  const byId = new Map(projects.map((p) => [p.id, p]))
  return <div class="page">{section === 'workflows' ? <AllWorkflows workflows={data?.workflows} byId={byId} /> : <AllConversations threads={data?.threads} byId={byId} />}</div>
}

type ThreadFilter = 'all' | 'you' | 'working' | 'workflows'

function AllConversations({ threads, byId }: { threads?: Of<Thread>[]; byId: Map<string, Project> }) {
  const [filter, setFilter] = useState<ThreadFilter>('all')
  const [showCompleted, setShowCompleted] = useState(false)
  const all = (threads ?? []).filter((t) => showCompleted || !t.completed).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const test: Record<ThreadFilter, (t: Thread) => boolean> = { all: () => true, you: (t) => !!t.waitsFor, working: (t) => kindOf(t) === 'working', workflows: (t) => !!t.workflow }
  const tab = (id: ThreadFilter, label: string, ring?: string) => {
    const n = all.filter(test[id]).length
    return (
      <button class={`filter ${filter === id ? 'active' : ''} ${id === 'you' && n ? 'attention' : ''}`} onClick={() => setFilter(id)}>
        {ring && <span class={`ring ${ring}`} />} {label} <b>{n}</b>
      </button>
    )
  }
  const shown = all.filter(test[filter])
  return (
    <div class="overview">
      <h1>Conversations in all projects</h1>
      <div class="filters">
        {tab('all', 'All')}
        {tab('you', 'For you', 'needs')}
        {tab('working', 'Working', 'busy')}
        {tab('workflows', 'From workflows')}
        <label class="check small muted">
          <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.currentTarget.checked)} /> Show finished
        </label>
      </div>
      <div>
        {shown.map((t) => {
          return (
            <a key={t.id} class="ov-row" href={`#/p/${t.projectId}/t/${t.id}`}>
              <Avatar project={byId.get(t.projectId)} />
              <span class="ov-title">{t.summary ?? t.title}</span>
              {t.workflow && <span class="ov-tag">workflow</span>}
              <span class="ov-meta wide-only">{byId.get(t.projectId)?.name}</span>
              <span class={`ring ${RINGS[kindOf(t)]}`} />
              <span class="ov-meta">{formatStamp(t.updatedAt)}</span>
            </a>
          )
        })}
        {threads && !shown.length && <p class="muted center">No conversations{filter !== 'all' ? ' in this filter' : ''}.</p>}
      </div>
    </div>
  )
}

type WorkflowFilter = 'all' | 'on' | 'scheduled' | 'needs'

function AllWorkflows({ workflows, byId }: { workflows?: Of<Workflow>[]; byId: Map<string, Project> }) {
  const { notDuplicates } = usePrefs()
  const [filter, setFilter] = useState<WorkflowFilter>('all')
  const [comparing, setComparing] = useState<string | null>(null)
  const all = workflows ?? []
  const groups = duplicates(all).filter((g) => !notDuplicates.includes(g.key))
  const flag = (w: Of<Workflow>) => groups.find((g) => g.workflows.includes(w))
  const test: Record<WorkflowFilter, (w: Workflow) => boolean> = { all: () => true, on: (w) => w.enabled, scheduled: (w) => !!w.cron, needs: (w) => w.lastRun?.status === 'needs' }
  const tab = (id: WorkflowFilter, label: string) => (
    <button class={`filter ${filter === id ? 'active' : ''}`} onClick={() => setFilter(id)}>
      {label} <b>{all.filter(test[id]).length}</b>
    </button>
  )
  const shown = all.filter(test[filter])
  const projectIds = [...new Set(shown.map((w) => w.projectId))].sort((a, b) => (byId.get(a)?.name ?? '').localeCompare(byId.get(b)?.name ?? ''))
  const compared = groups.find((g) => g.key === comparing)

  return (
    <div class="overview">
      <h1>Workflows in all projects</h1>
      {groups.length > 0 && (
        <div class="dup-box">
          <div class="dup-head">
            <TriangleAlert size={15} /> {groups.length} possible duplicate{groups.length === 1 ? '' : 's'}
          </div>
          {groups.map((g) => (
            <div key={g.key} class={`dup ${g.strong ? '' : 'soft'}`}>
              {g.workflows.map((w, i) => (
                <span key={w.id} class="dup-item">
                  {i > 0 && <span class="muted">{g.strong ? '+' : '≈'}</span>}
                  {(!g.strong || i === 0) && <b>{w.name}</b>}
                  <Avatar project={byId.get(w.projectId)} /> {byId.get(w.projectId)?.name}
                </span>
              ))}
              <span class="muted small">{g.why}</span>
              <span class="dup-actions">
                <button class="ghost small" onClick={() => setComparing(g.key)}>
                  Compare
                </button>
                <button class="ghost small" onClick={() => setPrefs({ notDuplicates: [...notDuplicates, g.key] })}>
                  Not a duplicate
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div class="filters">
        {tab('all', 'All')}
        {tab('on', 'On')}
        {tab('scheduled', 'Scheduled')}
        {tab('needs', 'Your turn')}
      </div>
      <div>
        {projectIds.map((pid) => (
          <div key={pid}>
            <div class="menu-label ov-group">
              <Avatar project={byId.get(pid)} /> {byId.get(pid)?.name}
            </div>
            {shown
              .filter((w) => w.projectId === pid)
              .map((w) => {
                const g = flag(w)
                return (
                  <a key={w.id} class="ov-row" href={`#/p/${pid}/workflows/${w.id}`}>
                    <span class="ov-title">{w.name}</span>
                    {g && <span class={`ov-flag ${g.strong ? '' : 'soft'}`}>{g.strong ? 'duplicate' : 'similar'}</span>}
                    <span class="ov-meta wide-only">
                      <Clock size={12} /> {schedule(w)}
                    </span>
                    <span class="ov-meta wide-only">{w.lastRun ? `${STATUS[w.lastRun.status][1]} · ${when(w.lastRun.at)}` : 'Never ran'}</span>
                    <span class={w.enabled ? 'on-badge' : 'off-badge'}>{w.enabled ? 'On' : 'Off'}</span>
                  </a>
                )
              })}
          </div>
        ))}
        {workflows && !shown.length && <p class="muted center">No workflows{filter !== 'all' ? ' in this filter' : ' in any project yet'}.</p>}
      </div>
      {compared && <Compare group={compared} byId={byId} onClose={() => setComparing(null)} />}
    </div>
  )
}

// The copies side by side. Words a prompt shares with every other copy are marked.
function Compare({ group, byId, onClose }: { group: Group; byId: Map<string, Project>; onClose: () => void }) {
  const base = (w: Of<Workflow>) => `/projects/${w.projectId}/workflows/${w.id}`
  const toggle = (w: Of<Workflow>) => api('PUT', base(w), { ...w, enabled: !w.enabled })
  const remove = (w: Of<Workflow>) => {
    // Once a pair loses a copy it is no longer a group, and the dialog closes by itself.
    if (confirm(`Delete “${w.name}” in ${byId.get(w.projectId)?.name}?`)) api('DELETE', base(w))
  }
  const marked = (w: Of<Workflow>) => {
    const others = group.workflows.filter((o) => o !== w).map((o) => words(o.prompt))
    return w.prompt.split(/([\p{L}\p{N}]{4,})/gu).map((part, i) => (i % 2 && others.every((o) => o.has(part.toLowerCase())) ? <mark key={i}>{part}</mark> : part))
  }
  return (
    <div class="overlay" onClick={onClose}>
      <div class="dialog compare-dialog" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          <TriangleAlert size={18} />
          <div class="dialog-title">
            <b>{group.workflows.map((w) => w.name).filter((n, i, l) => l.indexOf(n) === i).join(' ≈ ')}</b>
            <small class="muted">{group.why}</small>
          </div>
          <button class="icon-btn" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div class="compare">
          {group.workflows.map((w) => (
            <div key={`${w.projectId}/${w.id}`} class="compare-side">
              <div class="row">
                <Avatar project={byId.get(w.projectId)} /> <b>{byId.get(w.projectId)?.name}</b>
                <span class={w.enabled ? 'on-badge' : 'off-badge'}>{w.enabled ? 'On' : 'Off'}</span>
              </div>
              <small class="muted">
                {schedule(w)} · {w.lastRun ? `last run ${when(w.lastRun.at)}` : 'never ran'}
              </small>
              <pre class="compare-prompt">{marked(w)}</pre>
              <div class="row">
                <button class="ghost small" onClick={() => go(`/p/${w.projectId}/workflows/${w.id}`)}>
                  <SquareArrowOutUpRight size={13} /> Open
                </button>
                <button class="ghost small" onClick={() => toggle(w)}>
                  {w.enabled ? <Pause size={13} /> : <Play size={13} />} {w.enabled ? 'Pause' : 'Enable'}
                </button>
                <button class="ghost small danger" onClick={() => remove(w)}>
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
