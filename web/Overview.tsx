import { Fragment, type JSX } from 'preact'
import { useState } from 'preact/hooks'
import { ArrowRight, Check, CheckCheck, ChevronDown, ListChecks, Plus, Clock, Pause, Play, Smartphone, SquareArrowOutUpRight, Trash2, TriangleAlert, X } from 'lucide-preact'
import { api, avatarStyle, formatStamp, go, initial, kindOf, noticeOf, NOTICES, RINGS, useApi, type NoticeType, type AgentConfig, type ApprovalOption, type Attachment, type Decision, type Project, type Thread, type Workflow } from './api'
import { Composer } from './Composer'
import { byUrgency, ContextActions, Elapsed, NextButton, plain, ThreadCard, ThreadView } from './Conversations'
import { Panel } from './Layout'
import { STATUS, schedule, when } from './Workflows'
import { setPrefs, usePrefs } from './prefs'
import { offerUndo, UndoToast } from './Swipe'

type Of<T> = T & { projectId: string }
// Conversations that need you also bring what to answer.
type Listed = Of<Thread> & { approval?: { messageId: string; options: ApprovalOption[] } | null; decisions?: Decision[] }
interface Overview { threads: Listed[]; workflows: Of<Workflow>[] }
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

// Routes: all[/inbox[/new | /:pid/:tid] | /board[/:pid] | /workflows]
export function AllProjects({ projects, section, rest, importText }: { projects: Project[]; section?: string; rest: string[]; importText?: string }) {
  const [data] = useApi<Overview>('/overview', (e) => ['projects', 'thread', 'status', 'workflows'].includes(e.type))
  const { boardProject } = usePrefs()
  const byId = new Map(projects.map((p) => [p.id, p]))
  if (section === 'inbox') return <AllInbox threads={data?.threads} projects={projects} byId={byId} rest={rest} />
  if (section === 'board')
    return (
      <div class="page">
        <AllBoard threads={data?.threads} projects={projects} byId={byId} only={byId.get(rest[0] ?? boardProject)} />
      </div>
    )
  return <div class="page">{section === 'workflows' ? <AllWorkflows workflows={data?.workflows} byId={byId} /> : <AllOverview data={data} projects={projects} byId={byId} importText={importText} />}</div>
}

const threadHref = (t: Of<Thread>) => `#/all/inbox/${t.projectId}/${t.id}`
const lastActive = (threads: Of<Thread>[], pid: string) => threads.filter((t) => t.projectId === pid).reduce((max, t) => (t.updatedAt > max ? t.updatedAt : max), '')
// Earlier conversations by how long ago they changed.
function dayOf(iso: string) {
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000)
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'This week' : 'Older'
}
const EARLIER = 12

// First what waits for you, then what runs and what is new, then the rest as a quieter archive.
function AllOverview({ data, projects, byId, importText }: { data?: Overview; projects: Project[]; byId: Map<string, Project>; importText?: string }) {
  const [only, setOnly] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const threads = data?.threads ?? []
  const shown = threads.filter((t) => !only || t.projectId === only)
  const open = shown.filter((t) => !t.completed)
  const blocking = (t: Thread) => ['approval', 'question', 'failed'].includes(t.waitsFor?.reason ?? '')
  const waiting = open.filter(blocking).sort((a, b) => a.waitsFor!.since.localeCompare(b.waitsFor!.since))
  const working = open.filter((t) => !t.waitsFor && (t.busy || t.waiting))
  const results = open.filter((t) => t.waitsFor?.reason === 'new').sort((a, b) => b.waitsFor!.since.localeCompare(a.waitsFor!.since))
  const listed = new Set([...waiting, ...working, ...results])
  const earlier = shown.filter((t) => !listed.has(t)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const visible = more ? earlier : earlier.slice(0, EARLIER)
  const runs = (data?.workflows ?? []).filter((w) => w.enabled && w.nextRunAt && (!only || w.projectId === only)).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!)).slice(0, 5)
  const avatar = (t: Of<Thread>) => !only && <Avatar project={byId.get(t.projectId)} />
  const pick = (pid: string | null) => setOnly(pid === only ? null : pid)

  return (
    <div class="all-overview">
      <div class="all-main">
        <div class="all-head">
          <h1>{only ? byId.get(only)?.name : 'Across your projects'}</h1>
          {only ? (
            <button class="muted" onClick={() => setOnly(null)}>← All projects</button>
          ) : (
            <p class="muted">
              <b>{waiting.length}</b> wait for you · <b>{working.length}</b> working · <b>{results.length}</b> new result{results.length === 1 ? '' : 's'}
            </p>
          )}
        </div>
        <div class="project-chips">
          <button class={`project-chip ${only ? '' : 'on'}`} onClick={() => setOnly(null)}>All</button>
          {projects.map((p) => (
            <button key={p.id} class={`project-chip ${only === p.id ? 'on' : ''}`} onClick={() => pick(p.id)}>
              <Avatar project={p} /> {p.name}
              {p.counts.blocked > 0 && <span class="ring needs" />}
            </button>
          ))}
        </div>
        <StartAnywhere projects={projects} initial={only} importText={importText} />

        {data && (
          <>
            <div class={`all-sec ${waiting.length ? 'attn' : ''}`}>
              {waiting.length ? <>Waiting for you <span>{waiting.length}</span></> : 'Nothing waits for you'}
            </div>
            {waiting.map((t) => <WaitCard key={t.id} t={t} project={byId.get(t.projectId)} />)}

            {working.length > 0 && <div class="all-sec">Working <span>{working.length}</span></div>}
            {working.map((t) => (
              <a key={t.id} class="all-row" href={threadHref(t)}>
                <span class="ring busy" />
                <span class="all-row-text">
                  <span class="all-row-title">{t.summary ?? t.title}</span>
                  <span class="all-row-sub">{t.waiting && !t.busy ? 'Waiting for background work' : t.step ?? 'Working'}{t.workflow && ' · workflow'}</span>
                </span>
                {avatar(t)}
                <span class="ov-meta">{t.startedAt && <Elapsed since={t.startedAt} />}</span>
              </a>
            ))}

            {results.length > 0 && <div class="all-sec">New results <span>{results.length}</span></div>}
            {results.map((t) => (
              <a key={t.id} class="all-row" href={threadHref(t)}>
                <span class="ring unread" />
                <span class="all-row-text">
                  <span class="all-row-title">{t.summary ?? t.title}</span>
                  <span class="all-row-sub">{plain(t.waitsFor!.text)}</span>
                </span>
                {avatar(t)}
                <span class="ov-meta">{formatStamp(t.waitsFor!.since)}</span>
              </a>
            ))}

            {earlier.length > 0 && <div class="all-sec">Earlier</div>}
            {visible.map((t, i) => (
              <Fragment key={t.id}>
                {dayOf(t.updatedAt) !== dayOf(visible[i - 1]?.updatedAt ?? '') && <div class="all-day">{dayOf(t.updatedAt)}</div>}
                <a class="ov-row quiet" href={threadHref(t)}>
                  <span class={`ring ${RINGS[kindOf(t)]}`} />
                  <span class="ov-title">{t.summary ?? t.title}</span>
                  {t.workflow && <span class="ov-tag">workflow</span>}
                  {avatar(t)}
                  <span class="ov-meta">{formatStamp(t.updatedAt)}</span>
                </a>
              </Fragment>
            ))}
            {earlier.length > EARLIER && !more && (
              <button class="all-more" onClick={() => setMore(true)}>
                Show {earlier.length - EARLIER} older conversation{earlier.length - EARLIER === 1 ? '' : 's'}
              </button>
            )}
            {!threads.length && <p class="muted center">No conversations yet.</p>}
          </>
        )}
      </div>

      <aside class="all-rail">
        <div class="all-sec">Projects</div>
        <div class="rail-box">
          {projects.map((p) => (
            <button key={p.id} class={`rail-project ${only === p.id ? 'on' : ''}`} onClick={() => pick(p.id)}>
              <Avatar project={p} />
              <span class="rail-name">{p.name}</span>
              {p.counts.blocked > 0 && <span class="dot-count">◉ {p.counts.blocked}</span>}
              {p.counts.working > 0 && <span class="ring busy" />}
              <span class="ov-meta">{lastActive(threads, p.id) && formatStamp(lastActive(threads, p.id))}</span>
            </button>
          ))}
        </div>
        {runs.length > 0 && (
          <>
            <div class="all-sec">Next runs</div>
            <div class="rail-box">
              {runs.map((w) => (
                <a key={`${w.projectId}/${w.id}`} class="rail-run" href={`#/p/${w.projectId}/workflows/${w.id}`}>
                  <Avatar project={byId.get(w.projectId)} />
                  <span class="rail-name">{w.name}</span>
                  <span class="ov-meta">{formatStamp(w.nextRunAt!)}</span>
                </a>
              ))}
            </div>
          </>
        )}
      </aside>
      <UndoToast />
    </div>
  )
}

// One approval or one question with options, answered in place. The answer reaches the agent only
// after a few seconds, so it can be taken back; "Why?" shows the agent's reasoning.
function QuickAnswer({ t, children }: { t: Listed; children?: JSX.Element }) {
  const [sent, setSent] = useState(false)
  const [why, setWhy] = useState(false)
  const decision = t.decisions?.length === 1 && t.decisions[0].options.length ? t.decisions[0] : null
  if (!t.approval && !decision) return children ? <div class="wait-actions">{children}</div> : null
  const base = `/projects/${t.projectId}/threads/${t.id}`
  const stop = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
  }
  const hold = (label: string, body: object) => (e: Event) => {
    stop(e)
    setSent(true)
    api<{ id: string; ms: number }>('POST', `${base}/held`, body)
      .then(({ id, ms }) => offerUndo(`Answered: ${label}`, () => api('DELETE', `/held/${id}`).then(() => setSent(false)), ms))
      .catch(() => setSent(false))
  }
  if (sent)
    return (
      <div class="wait-actions">
        <span class="muted small">Answered</span>
        {children}
      </div>
    )
  return (
    <div class="quick-answer" onClick={stop}>
      <div class="wait-actions">
        {t.approval
          ? t.approval.options.map((o, i) => (
              <button key={o.id} class={i === 0 ? 'primary small' : 'ghost small'} onClick={hold(o.label, { approval: t.approval!.messageId, choice: o.id })}>
                {o.label}
              </button>
            ))
          : decision!.options.map((o, i) => (
              <button key={o} class={i === decision!.recommended ? 'primary small' : 'ghost small'} onClick={hold(o, { decision: decision!.id, selected: i })}>
                {o}
              </button>
            ))}
        {decision?.body && (
          <button class="why-btn" onClick={(e) => (stop(e), setWhy(!why))}>
            {why ? 'Hide why' : 'Why?'}
          </button>
        )}
        {children}
      </div>
      {why && decision && <div class="why-text">{decision.body}</div>}
    </div>
  )
}

const REASONS: Record<string, string> = { approval: 'Approval', question: 'Question', failed: 'Failed' }

// The question itself, answerable in place when it is one approval or one question.
function WaitCard({ t, project }: { t: Listed; project?: Project }) {
  const w = t.waitsFor!
  const decision = t.decisions?.length === 1 ? t.decisions[0] : null
  return (
    <div class={`wait-card ${w.reason}`}>
      <div class="wait-top">
        <Avatar project={project} /> {project?.name}
        {t.worktree && <span class="ov-tag">{t.worktree.branch}</span>}
        {t.workflow && <span class="ov-tag">workflow</span>}
        <span class="ov-meta">{formatStamp(w.since)}</span>
      </div>
      <a class="wait-title" href={threadHref(t)}>{t.summary ?? t.title}</a>
      <div class="wait-ask">
        <span class="wait-reason">{w.reason === 'question' && w.more ? `${w.more + 1} questions` : REASONS[w.reason]}</span>
        {w.reason === 'failed' ? plain(w.text) : w.text}
      </div>
      <QuickAnswer t={t}>
        <a class="wait-open" href={threadHref(t)}>
          {w.reason === 'question' && !decision ? 'Answer' : 'Open conversation'} <ArrowRight size={13} />
        </a>
      </QuickAnswer>
    </div>
  )
}

type InboxFilter = 'all' | NoticeType | 'working'

// The open conversations of every project in one list, the chosen one beside it. Filters by the type
// of the latest notice; several conversations or a whole filter can be marked read at once.
function AllInbox({ threads, projects, byId, rest }: { threads?: Listed[]; projects: Project[]; byId: Map<string, Project>; rest: string[] }) {
  const [filter, setFilter] = useState<InboxFilter>('all')
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [pid, tid] = rest
  const project = byId.get(pid)
  // Newest input or notice first: reading a conversation doesn't move it.
  const at = (t: Thread) => [t.inputAt ?? '', t.notice?.at ?? ''].sort().at(-1) || t.updatedAt
  const open = (threads ?? []).filter((t) => !t.completed && byId.has(t.projectId)).sort((a, b) => at(b).localeCompare(at(a)))
  const test = (f: InboxFilter) => (t: Thread) => (f === 'all' ? true : f === 'working' ? kindOf(t) === 'working' : noticeOf(t) === f)
  // Questions, approvals and errors stay until they are dealt with; read only takes the rest off the counts.
  const blocking = (t: Thread) => ['approval', 'question', 'failed'].includes(t.waitsFor?.reason ?? '')
  const fresh = (t: Thread) => t.unread || blocking(t)
  const readable = (t: Listed) => t.unread && !blocking(t)
  const shown = open.filter(test(filter))
  const forYou = byUrgency(open.filter((t) => !!t.waitsFor))
  const nextPaths = forYou.map((t) => `/all/inbox/${t.projectId}/${t.id}`)
  const tab = (id: InboxFilter, label: string) => {
    const n = open.filter(test(id)).filter(id === 'working' ? () => true : fresh).length
    return (
      <button class={`filter ${filter === id ? 'active' : ''} ${id === 'ask' && n ? 'attention' : ''}`} onClick={() => setFilter(id)}>
        {id !== 'all' && id !== 'working' && <span class={`notice notice-dot n-${id}`} />}
        {label} {n > 0 && <b>{n}</b>}
      </button>
    )
  }
  const key = (t: Listed) => `${t.projectId}/${t.id}`
  const markRead = (list: Listed[]) => {
    const unread = list.filter(readable).map((t) => ({ projectId: t.projectId, threadId: t.id }))
    setPicked(null)
    if (!unread.length) return
    api('POST', '/threads/read', { threads: unread, unread: false }).then(() =>
      offerUndo(`${unread.length} marked read`, () => api('POST', '/threads/read', { threads: unread, unread: true })),
    )
  }
  const toggle = (t: Listed) => (e: Event) => {
    e.preventDefault()
    const next = new Set(picked)
    if (!next.delete(key(t))) next.add(key(t))
    setPicked(next)
  }
  return (
    <div class={`conversations all-inbox ${tid || pid === 'new' ? 'has-detail' : ''}`}>
      <Panel id="list" title="Inbox">
        <aside class="conv-list">
          <div class="conv-head">
            <h2>Inbox</h2>
            {picked ? (
              <button class="ghost small" onClick={() => setPicked(null)}>Cancel</button>
            ) : (
              <>
                <button class="icon-btn" title="Select several" onClick={() => setPicked(new Set())}>
                  <ListChecks size={17} />
                </button>
                <button class="icon-btn" title={`Mark everything in ${filter === 'all' ? 'the inbox' : 'this filter'} read`} disabled={!shown.some(readable)} onClick={() => markRead(shown)}>
                  <CheckCheck size={17} />
                </button>
                <NextButton paths={nextPaths} />
                <a class="new-btn" href="#/all/inbox/new" title="New conversation">
                  <Plus size={18} />
                </a>
              </>
            )}
          </div>
          <div class="filters wrap">
            {tab('all', 'All')}
            {(Object.keys(NOTICES) as NoticeType[]).map((type) => tab(type, NOTICES[type].plural))}
            {tab('working', 'Working')}
          </div>
          <div class="cards">
            {shown.map((t, i) => (
              <Fragment key={t.id}>
                {dayOf(at(t)) !== dayOf(shown[i - 1] ? at(shown[i - 1]) : '') && <div class="all-day">{dayOf(at(t))}</div>}
                {picked ? (
                  <div class="pick-row" onClickCapture={toggle(t)}>
                    <span class={`pick ${picked.has(key(t)) ? 'on' : ''}`}>{picked.has(key(t)) && <Check size={12} />}</span>
                    <ThreadCard project={byId.get(t.projectId)!} thread={t} active={false} href={threadHref(t)} badge />
                  </div>
                ) : (
                  <ThreadCard project={byId.get(t.projectId)!} thread={t} active={t.id === tid} href={threadHref(t)} badge>
                    {t.needsYou ? <QuickAnswer t={t} /> : null}
                  </ThreadCard>
                )}
              </Fragment>
            ))}
            {threads && !shown.length && <p class="muted center">No open conversations{filter !== 'all' ? ' in this filter' : ''}.</p>}
          </div>
          {picked && (
            <div class="pick-bar">
              <span>{picked.size} selected</span>
              {picked.size < shown.length ? (
                <button class="ghost small" onClick={() => setPicked(new Set(shown.map(key)))}>Select all {shown.length}</button>
              ) : (
                <button class="ghost small" onClick={() => setPicked(new Set())}>Select none</button>
              )}
              <button class="primary small" disabled={!picked.size} onClick={() => markRead(shown.filter((t) => picked.has(key(t))))}>
                Mark read
              </button>
            </div>
          )}
        </aside>
      </Panel>
      <UndoToast />
      {project && tid ? (
        <>
          <ThreadView key={tid} project={project} threadId={tid} back="/all/inbox" next={nextPaths} />
          <ContextActions project={project} projects={projects} threadId={tid} inbox />
        </>
      ) : (
        <Panel id="main" title="New conversation">
          <section class="thread new-thread">
            <div class="new-hero">
              <h1>What do you want to build?</h1>
              <p class="muted">Start a conversation in any project, or pick one from the list.</p>
            </div>
            <StartAnywhere projects={projects} initial={null} autoFocus />
          </section>
        </Panel>
      )}
    </div>
  )
}

interface BacklogItem { id: string; title: string; createdAt: string; projectId: string; origin?: 'local' | 'remote' }

// What to start next and what agents work on now. Questions and results stay in Overview and Inbox.
function AllBoard({ threads, projects, byId, only }: { threads?: Listed[]; projects: Project[]; byId: Map<string, Project>; only?: Project }) {
  const [backlog] = useApi<{ items: BacklogItem[] }>('/backlog', (e) => ['backlog', 'projects'].includes(e.type))
  const [byProject, setByProject] = useState(false)
  const [dragged, setDragged] = useState<BacklogItem | null>(null)
  const [over, setOver] = useState(false)
  const [menu, setMenu] = useState(false)
  const choose = (pid: string | null) => {
    setPrefs({ boardProject: pid })
    setMenu(false)
    go(pid ? `/all/board/${pid}` : '/all/board')
  }
  const shown = (pid: string) => (only ? pid === only.id : byId.has(pid))
  const doing = (threads ?? []).filter((t) => shown(t.projectId) && !t.completed && !t.waitsFor && (t.busy || t.waiting))
  const items = (backlog?.items ?? []).filter((i) => shown(i.projectId))
  // One project needs neither groups nor a name on every card.
  const named = !byProject && !only
  const remove = (item: BacklogItem) => api('DELETE', `/projects/${item.projectId}/backlog/${item.id}`)
  const start = async (item: BacklogItem) => {
    await api('POST', `/projects/${item.projectId}/threads`, { text: item.title })
    await remove(item)
  }
  // By project, each project's cards follow its name in the order of the tabs.
  const grouped = <T extends { projectId: string }>(list: T[], render: (x: T) => preact.JSX.Element) =>
    byProject && !only
      ? projects
          .filter((p) => list.some((x) => x.projectId === p.id))
          .map((p) => (
            <Fragment key={p.id}>
              <div class="board-group">
                <Avatar project={p} /> {p.name}
              </div>
              {list.filter((x) => x.projectId === p.id).map(render)}
            </Fragment>
          ))
      : list.map(render)
  const backlogCard = (item: BacklogItem) => (
    <div key={item.id} class="board-card" draggable onDragStart={(e) => (e.dataTransfer!.setData('text/plain', item.title), setDragged(item))} onDragEnd={() => (setDragged(null), setOver(false))}>
      <div class="board-card-top">
        {named && (
          <>
            <Avatar project={byId.get(item.projectId)} /> {byId.get(item.projectId)?.name}
          </>
        )}
        <span class="ov-meta">
          {item.origin === 'remote' && <span title="Added from a paired device"><Smartphone size={12} /></span>} {formatStamp(item.createdAt)}
        </span>
      </div>
      <div class="board-title">{item.title}</div>
      <div class="board-actions">
        <button class="ghost small" onClick={() => start(item)}>
          <Play size={12} /> Start
        </button>
        <button class="ghost small" onClick={() => remove(item)}>
          Delete
        </button>
      </div>
    </div>
  )
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (dragged) start(dragged)
    setDragged(null)
  }
  return (
    <div class="board">
      <div class="board-head">
        <h1>Board</h1>
        <span class="muted small wide-only">What to start next and what runs now.</span>
        <div class="menu-anchor">
          <button class="pill" onClick={() => setMenu(!menu)}>
            {only ? (
              <>
                <Avatar project={only} /> {only.name}
              </>
            ) : (
              'All projects'
            )}{' '}
            <ChevronDown size={14} />
          </button>
          {menu && (
            <div class="menu right">
              <button onClick={() => choose(null)}>All projects</button>
              {projects.map((p) => (
                <button key={p.id} onClick={() => choose(p.id)}>
                  <Avatar project={p} /> {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {!only && (
          <div class="filters">
            <button class={`filter ${byProject ? '' : 'active'}`} onClick={() => setByProject(false)}>Flat</button>
            <button class={`filter ${byProject ? 'active' : ''}`} onClick={() => setByProject(true)}>By project</button>
          </div>
        )}
      </div>
      <div class="board-cols">
        <section class="board-col">
          <div class="board-col-head">
            Backlog <span>{items.length}</span>
          </div>
          <div class="board-col-body">
            <AddToBacklog key={only?.id} projects={projects} initial={only?.id ?? null} />
            {grouped(items, backlogCard)}
          </div>
        </section>
        <section class={`board-col ${over ? 'over' : ''}`} onDragOver={(e) => dragged && (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={drop}>
          <div class="board-col-head">
            <span class="ring busy" /> Doing <span>{doing.length}</span>
          </div>
          <div class="board-col-body">
            {grouped(doing, (t) => (
              <a key={t.id} class="board-card" href={threadHref(t)}>
                <div class="board-card-top">
                  {named && (
                    <>
                      <Avatar project={byId.get(t.projectId)} /> {byId.get(t.projectId)?.name}
                    </>
                  )}
                  {t.workflow && <span class="ov-tag">workflow</span>}
                  <span class="ov-meta">{t.startedAt && <Elapsed since={t.startedAt} />}</span>
                </div>
                <div class="board-title">{t.summary ?? t.title}</div>
                <div class="all-row-sub">{t.waiting && !t.busy ? 'Waiting for background work' : t.step ?? 'Working'}</div>
              </a>
            ))}
            <p class="muted small center">{dragged ? 'Drop here to start it' : doing.length ? '' : 'No agent works right now. Start something from the backlog.'}</p>
          </div>
        </section>
      </div>
    </div>
  )
}

// A line to do later, or to start right away, in any project.
function AddToBacklog({ projects, initial }: { projects: Project[]; initial: string | null }) {
  const [text, setText] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const project = projects.find((p) => p.id === (chosen ?? initial)) ?? projects.find((p) => p.pinned) ?? projects[0]
  if (!project) return null
  const add = async (now: boolean) => {
    const title = text.trim()
    if (!title) return
    setText('')
    await (now ? api('POST', `/projects/${project.id}/threads`, { text: title }) : api('POST', `/projects/${project.id}/backlog`, { title }))
  }
  return (
    <div class="board-add">
      <textarea
        rows={2}
        placeholder="Add something to do later…"
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), add(false))}
      />
      <div class="board-add-row">
        <div class="menu-anchor">
          <button class="pill" onClick={() => setMenu(!menu)}>
            <Avatar project={project} /> {project.name} <ChevronDown size={14} />
          </button>
          {menu && (
            <div class="menu">
              {projects.map((p) => (
                <button key={p.id} onClick={() => (setChosen(p.id), setMenu(false))}>
                  <Avatar project={p} /> {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <span class="spacer" />
        <button class="ghost small" disabled={!text.trim()} onClick={() => add(false)}>
          Add
        </button>
        <button class="primary small" disabled={!text.trim()} title="Start a conversation with it now" onClick={() => add(true)}>
          Start now
        </button>
      </div>
    </div>
  )
}

// A new conversation in any project, without opening it first.
function StartAnywhere({ projects, initial, autoFocus, importText }: { projects: Project[]; initial: string | null; autoFocus?: boolean; importText?: string }) {
  const [chosen, setChosen] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const kontor = projects.find((p) => p.type === 'kontor')
  const automatic = !!kontor && (importText !== undefined || (chosen ?? initial ?? 'auto') === 'auto')
  const project = automatic ? kontor : projects.find((p) => p.id === (chosen ?? initial)) ?? projects.find((p) => p.pinned) ?? projects[0]
  const [agent, setAgent] = useState<AgentConfig | null>(null)
  const [imported, setImported] = useState(false)
  if (!project) return null
  const consumeImport = () => {
    setChosen(automatic ? 'auto' : project.id)
    setAgent(null)
    setImported(true)
    const [route, query] = location.hash.split('?')
    const params = new URLSearchParams(query)
    params.delete('text')
    history.replaceState(null, '', `${location.pathname}${location.search}${route}${params.size ? `?${params}` : ''}`)
    dispatchEvent(new HashChangeEvent('hashchange'))
  }
  const send = async (text: string, attachments: Attachment[]) => {
    const t = await api<Thread>('POST', `/projects/${project.id}/threads`, { text, attachments, agent: agent ?? project.agent, inbox: automatic })
    go(`/all/inbox/${project.id}/${t.id}`)
  }
  const choose = (pid: string) => {
    setChosen(pid)
    setAgent(null)
    setMenu(false)
  }
  return (
    <div class="start-anywhere">
      <div class="menu-anchor">
        <button class="pill" onClick={() => setMenu(!menu)}>
          Start in {automatic ? `Automatic · via ${project.name}` : <><Avatar project={project} /> {project.name}</>} <ChevronDown size={14} />
        </button>
        {menu && (
          <div class="menu">
            {kontor && <button onClick={() => choose('auto')}>Automatic · via {kontor.name}</button>}
            {projects.map((p) => (
              <button key={p.id} onClick={() => choose(p.id)}>
                <Avatar project={p} /> {p.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {imported && <p class="muted">From your shortcut · review and send</p>}
      <Composer key={project.id} project={project} agent={agent ?? project.agent} setAgent={setAgent} onSend={send} placeholder={automatic ? 'What needs doing? Projects are chosen automatically…' : `Start a conversation in ${project.name}…`} autoFocus={autoFocus} importText={importText} onImport={consumeImport} />
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
