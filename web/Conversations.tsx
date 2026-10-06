import { Fragment } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  Asterisk, Hexagon, Code2, Sparkles, Orbit, Plus, Search, MessageSquare, Check, MoreHorizontal, PanelLeft, PanelRight, FileText, Globe,
  CircleAlert, ArrowUp, ArrowLeft, Pencil, Brain, Terminal, Wrench, ArrowRight, Smartphone, Monitor, ShieldQuestion, X, ChevronUp, ChevronDown, ChevronRight, Paperclip, GitBranch, GitFork, GitMerge, Trash2, Copy, FileDiff, Split, Workflow as WorkflowIcon,
} from 'lucide-preact'
import {
  api, cap, duration, formatStamp, formatTime, go, PROVIDER_NAMES, runTrigger, useApi, type ActivityEvent, type AgentConfig, type Attachment, type Decision, type Message, type Proc, type Project, type Thread, type Worktree,
} from './api'
import { Composer, type Picked } from './Composer'
import { transport } from './transport'
import { Preview } from './Preview'
import { Changes, type ReviewComment, type Source } from './Changes'
import { Fanout } from './Fanout'
import { setPrefs, usePrefs } from './prefs'

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text])
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />
}

const PROVIDER_ICONS: Record<string, [any, string]> = {
  claude: [Asterisk, '#d97757'],
  codex: [Hexagon, '#9aa4b2'],
  opencode: [Code2, '#7fb069'],
  grok: [Sparkles, '#c9c9c9'],
  antigravity: [Orbit, '#5b8def'],
}

export function ProviderIcon({ provider, size = 18 }: { provider: string; size?: number }) {
  const [Icon, color] = PROVIDER_ICONS[provider] ?? [Sparkles, '#999']
  return <Icon size={size} color={color} strokeWidth={2.4} class="provider-icon" />
}

export const Label = ({ label }: { label: Thread['label'] }) =>
  label && (
    <span class="label-pill" style={{ '--hue': label.hue }}>
      {label.name}
    </span>
  )

type Filter = 'all' | 'needs' | 'working' | 'unread'

export function Conversations({ project, threadId, fanoutId, isNew }: { project: Project; threadId?: string; fanoutId?: string; isNew?: boolean }) {
  const [threads] = useApi<Thread[]>(`/projects/${project.id}/threads`, (e) => e.projectId === project.id && ['thread', 'status', 'message', 'processes'].includes(e.type))
  const [worktrees] = useApi<Worktree[]>(`/projects/${project.id}/worktrees`, (e) => e.projectId === project.id && e.type === 'thread')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [showCompleted, setShowCompleted] = useState(() => localStorage.getItem('savor-show-completed') === 'true')
  useEffect(() => localStorage.setItem('savor-show-completed', String(showCompleted)), [showCompleted])

  const all = (threads ?? []).filter((t) => showCompleted || !t.completed)
  const counts = {
    all: all.length,
    needs: all.filter((t) => t.needsYou).length,
    working: all.filter((t) => t.busy || t.waiting).length,
    unread: all.filter((t) => t.unread).length,
  }
  const q = query.toLowerCase()
  const visible = all
    .filter((t) => filter === 'all' || (filter === 'needs' ? t.needsYou : filter === 'working' ? t.busy || t.waiting : t.unread))
    .filter((t) => !q || t.title.toLowerCase().includes(q) || t.summary?.toLowerCase().includes(q) || t.label?.name.toLowerCase().includes(q))

  // The conversations of a fan-out are listed together, each under its worktree.
  const fanouts = new Map<string, Thread[]>()
  for (const t of visible) if (t.fanout) (fanouts.get(t.fanout.id) ?? fanouts.set(t.fanout.id, []).get(t.fanout.id)!).push(t)
  const fanoutPaths = new Set((threads ?? []).flatMap((t) => (t.fanout && t.worktree ? [t.worktree.path] : [])))
  // Conversations in a worktree are listed under it, worktrees without conversations too.
  const groups = new Map<string, { branch: string; path: string; threads: Thread[] }>()
  for (const w of worktrees ?? []) if (!fanoutPaths.has(w.path)) groups.set(w.path, { branch: w.branch, path: w.path, threads: [] })
  for (const t of visible) if (t.worktree && !t.fanout) (groups.get(t.worktree.path) ?? groups.set(t.worktree.path, { ...t.worktree, threads: [] }).get(t.worktree.path)!).threads.push(t)
  const plain = visible.filter((t) => !t.worktree && !t.fanout)

  const filterTab = (id: Filter, label: string, ring?: string) => (
    <button class={`filter ${filter === id ? 'active' : ''} ${id === 'needs' && counts.needs ? 'attention' : ''}`} onClick={() => setFilter(id)}>
      {ring && <span class={`ring ${ring}`} />} {label} <b>{counts[id]}</b>
    </button>
  )

  return (
    <div class={`conversations ${threadId || fanoutId || isNew ? 'has-detail' : ''}`}>
      <aside class="conv-list">
        <div class="conv-head">
          <h2>Conversations</h2>
          <a class="new-btn" href={`#/p/${project.id}/new`} title="New conversation">
            <Plus size={18} />
          </a>
        </div>
        <label class="search">
          <Search size={15} />
          <input placeholder="Search conversations..." value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
        <div class="filters">
          {filterTab('all', 'All')}
          {filterTab('needs', 'Your turn', 'needs')}
          {filterTab('working', 'Working', 'busy')}
          {filterTab('unread', 'Unread', 'unread')}
        </div>
        <div class="cards">
          {plain.map((t) => (
            <ThreadCard key={t.id} project={project} thread={t} active={t.id === threadId} />
          ))}
          {[...fanouts].map(([id, list]) => (
            <div class="wt-group" key={id}>
              <a class={`fan-head ${id === fanoutId ? 'active' : ''}`} href={`#/p/${project.id}/fan/${id}`} title="Compare the results">
                <Split size={14} />
                <span class="fan-title">{list[0].title}</span>
                <span class="muted small">{list.some((t) => t.busy || t.waiting) ? `${list.filter((t) => !t.busy && !t.waiting).length} of ${list.length} finished` : 'Compare'}</span>
              </a>
              {[...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((t) => (
                <Fragment key={t.id}>
                  {t.worktree && <WorktreeHead project={project} branch={t.worktree.branch} path={t.worktree.path} info={worktrees?.find((w) => w.path === t.worktree!.path)} />}
                  <ThreadCard project={project} thread={t} active={t.id === threadId} />
                </Fragment>
              ))}
            </div>
          ))}
          {[...groups.values()].map((g) => (
            <div class="wt-group" key={g.path}>
              <WorktreeHead project={project} branch={g.branch} path={g.path} info={worktrees?.find((w) => w.path === g.path)} />
              {g.threads.map((t) => (
                <ThreadCard key={t.id} project={project} thread={t} active={t.id === threadId} />
              ))}
            </div>
          ))}
          {threads && !visible.length && !groups.size && <p class="muted center">No conversations{filter !== 'all' ? ' in this filter' : ' yet'}.</p>}
        </div>
        <footer class="conv-foot">
          <span>
            {all.length} conversation{all.length === 1 ? '' : 's'}
          </span>
          <label>
            <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.currentTarget.checked)} /> Show finished
          </label>
        </footer>
      </aside>
      {threadId ? <ThreadView key={threadId} project={project} threadId={threadId} /> : fanoutId ? <Fanout key={fanoutId} project={project} id={fanoutId} /> : <NewConversation project={project} />}
    </div>
  )
}

function WorktreeHead({ project, branch, path, info }: { project: Project; branch: string; path: string; info?: Worktree }) {
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    try {
      await fn()
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const merge = () => run('Merging…', () => api('POST', `/projects/${project.id}/worktrees/merge`, { path }))
  const remove = () => {
    if (!confirm(`Delete the worktree and branch “${branch}”? Unmerged changes are lost. Its conversations stay and continue in the project folder.`)) return
    run('Deleting…', () => api('DELETE', `/projects/${project.id}/worktrees?path=${encodeURIComponent(path)}`))
  }
  return (
    <div class="wt-head">
      <GitBranch size={14} />
      <span class="wt-name" title={path}>
        {branch}
      </span>
      <span class="muted small">{busy || (info ? `${info.ahead ? `${info.ahead} commit${info.ahead === 1 ? '' : 's'} ahead` : 'nothing to merge'}${info.dirty ? ' · uncommitted changes' : ''}` : 'removed')}</span>
      {info && (
        <div class="menu-anchor">
          <button class="icon-btn" title="Worktree actions" onClick={() => setMenu(!menu)}>
            <MoreHorizontal size={15} />
          </button>
          {menu && (
            <div class="menu right" onClick={() => setMenu(false)}>
              <button disabled={!info.ahead} onClick={merge}>
                <GitMerge size={14} /> Merge into the project
              </button>
              <button class="danger" onClick={remove}>
                <Trash2 size={14} /> Delete worktree and branch
              </button>
            </div>
          )}
        </div>
      )}
      {error && <div class="error-text small">{error}</div>}
    </div>
  )
}

function ThreadCard({ project, thread: t, active }: { project: Project; thread: Thread; active: boolean }) {
  const [firstOpen, setFirstOpen] = useState<string | null>(null)
  useEffect(() => {
    if (t.needsYou) api<{ decisions: Decision[]; messages: Message[] }>('GET', `/projects/${project.id}/threads/${t.id}`).then((d) => {
      const pendingApproval = d.messages.find((m) => m.approval?.status === 'pending')
      setFirstOpen(d.decisions.find((x) => !x.resolved)?.title ?? pendingApproval?.approval?.title ?? null)
    })
  }, [t.needsYou, t.updatedAt])
  const { conversations, show } = usePrefs()
  const href = `#/p/${project.id}/t/${t.id}`
  // The ring from the logo says what the conversation is waiting for.
  const state = t.needsYou ? 'needs' : t.busy || t.waiting ? 'busy' : t.error === STOPPED ? 'stopped' : t.error ? 'error' : t.unread ? 'unread' : t.completed ? 'done' : ''
  const ring = <span class={`ring ${state}`} title={{ busy: 'Working', needs: 'Your turn', stopped: 'Stopped', error: 'Error', unread: 'Unread', done: 'Finished', '': 'Ready' }[state]} />
  // Compact: one line with the title, what the conversation is waiting for as a dot.
  if (conversations === 'compact')
    return (
      <a href={href} class={`card compact ${active ? 'active' : ''} ${t.unread ? 'unread' : ''}`}>
        <div class="card-title" title={t.title}>{t.summary ?? t.title}</div>
        <span class="card-meta">
          {ring}
          {show.count && (
            <span>
              <MessageSquare size={13} /> {t.messageCount}
            </span>
          )}
          {show.date && formatStamp(t.updatedAt)}
        </span>
      </a>
    )
  return (
    <a href={href} class={`card ${active ? 'active' : ''} ${t.unread ? 'unread' : ''}`}>
      <div class="card-top">
        {show.label && <Label label={t.label} />}
        <span class="card-state">
          {state === 'needs' && 'Your turn'}
          {ring}
        </span>
        {show.count && (
          <span class="count">
            <MessageSquare size={14} /> {t.messageCount}
          </span>
        )}
      </div>
      <div class="card-title" title={t.title}>{t.summary ?? t.title}</div>
      <div class="card-meta">
        <span>{[show.agent && (PROVIDER_NAMES[t.agent.provider] ?? t.agent.provider), show.date && formatStamp(t.updatedAt)].filter(Boolean).join(' · ')}</span>
        {t.completed && (
          <span class="completed-badge">
            <Check size={12} /> Finished
          </span>
        )}
        {t.error && t.error !== STOPPED && !t.busy && (
          <span class="error-badge">
            <CircleAlert size={12} /> Error
          </span>
        )}
      </div>
      {t.needsYou && firstOpen && (
        <div class="needs-row">
          <span>{firstOpen}</span>
          <span class="respond">Answer</span>
        </div>
      )}
    </a>
  )
}

function NewConversation({ project }: { project: Project }) {
  const [agent, setAgent] = useState<AgentConfig>(project.agent)
  const [worktree, setWorktree] = useState<string | null>(null)
  const [fanout, setFanout] = useState<AgentConfig[] | null>(null)
  const send = async (text: string, attachments: Attachment[]) => {
    if (fanout) {
      const [first] = await api<Thread[]>('POST', `/projects/${project.id}/fanout`, { text, attachments, agents: fanout })
      go(`/p/${project.id}/fan/${first.fanout!.id}`)
      return
    }
    const t = await api<Thread>('POST', `/projects/${project.id}/threads`, { text, attachments, agent, worktree })
    go(`/p/${project.id}/t/${t.id}`)
  }
  return (
    <section class="thread new-thread">
      <div class="new-hero">
        <h1>What do you want to build?</h1>
        <p class="muted">
          Start a conversation in <b>{project.name}</b>. Each conversation gets its own agent session.
        </p>
      </div>
      <Composer project={project} agent={agent} setAgent={setAgent} onSend={send} placeholder="Describe what you want…" worktree={worktree} setWorktree={setWorktree} fanout={fanout} setFanout={setFanout} autoFocus />
    </section>
  )
}

// Between turns: the agent ended its turn without a conclusion and continues when its background work is done.
const WAITING = 'Waiting for background work'
// What the daemon records as the error of a turn the user stopped. That is not a failure.
const STOPPED = 'Turn stopped.'

interface ThreadData { thread: Thread; busy: boolean; waiting: boolean; background: boolean; startedAt?: string; messages: Message[]; decisions: Decision[]; processes: Proc[] }

// How full the agent's context window is: a share of it once the agent has named its size, the tokens until then.
function ContextUse({ context: c }: { context: NonNullable<Thread['context']> }) {
  const share = c.window ? c.tokens / c.window : 0
  return (
    <span class={`status context${share >= 0.8 ? ' full' : ''}`} title={`${c.tokens.toLocaleString()}${c.window ? ` of ${c.window.toLocaleString()}` : ''} tokens in the agent's context window`}>
      Context {c.window ? `${Math.round(share * 100)}%` : `${Math.round(c.tokens / 1000)}k`}
    </span>
  )
}

// Phones and narrow windows, where chat and page do not fit side by side.
function useNarrow() {
  const query = useMemo(() => matchMedia('(max-width: 860px)'), [])
  const [narrow, setNarrow] = useState(query.matches)
  useEffect(() => {
    const change = () => setNarrow(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  return narrow
}

function ThreadView({ project, threadId }: { project: Project; threadId: string }) {
  const base = `/projects/${project.id}/threads/${threadId}`
  const [data, reload, loadError] = useApi<ThreadData>(base, (e) => (e.threadId === threadId && ['message', 'thread', 'status'].includes(e.type)) || (e.projectId === project.id && e.type === 'processes'))
  const [activity] = useApi<ActivityEvent[]>(`${base}/activity`, (e) => e.threadId === threadId && (e.type === 'activity' || e.type === 'status'))
  // Chat, browser or changes: the first preview of a conversation opens the browser, after that the last choice stands.
  const viewKey = `savor-view:${threadId}`
  const [view, setViewState] = useState(() => localStorage.getItem(viewKey))
  const [chatHidden, setChatHidden] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  // What the agent says while the chat is out of sight shows above the small composer.
  const [seen, setSeen] = useState(0)
  const narrow = useNarrow()
  const { chatWidth } = usePrefs()
  const layoutRef = useRef<HTMLDivElement>(null)
  // Moving the composer between chat and page starts it fresh, so a suggestion taken up earlier must not come back.
  const setView = (v: 'chat' | 'browser' | 'changes') => {
    localStorage.setItem(viewKey, v)
    setViewState(v)
    setDraft(undefined)
  }
  // On a phone the page takes the whole view, so finding leads back to the chat.
  const openFind = () => {
    if (narrow) setView('chat')
    setChatHidden(false)
    setFind((f) => ({ ...f, open: true }))
  }
  const [draft, setDraft] = useState<string>()
  const [picked, setPicked] = useState<Picked[]>([])
  const [menu, setMenu] = useState(false)
  const [find, setFind] = useState<{ open: boolean; q: string; at: number }>({ open: false, q: '', at: 0 })
  // The changes shown: the worktree since it branched off, uncommitted changes, or a commit.
  const [source, setSource] = useState<Source | null>(null)
  const [review] = useApi<ReviewComment[]>(`${base}/review`, (e) => e.threadId === threadId && e.type === 'review')
  const saveReview = (comments: ReviewComment[]) => api('PUT', `${base}/review`, { comments })
  const [titleOpen, setTitleOpen] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, Pick>>({})
  const listRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const [clock, setClock] = useState(Date.now())
  useEffect(() => {
    if (!data?.busy) return
    setClock(Date.now())
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [data?.busy])

  const mode = view ?? (data?.thread.preview ? 'browser' : 'chat')
  // Browser and changes both sit beside the chat.
  const browserMode = mode !== 'chat'
  const floating = browserMode && (chatHidden || narrow)
  useEffect(() => setSeen(data?.messages.length ?? 0), [floating, !data])
  useEffect(() => {
    const el = listRef.current
    if (el && !find.open) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight))
  }, [data?.messages.length, data?.busy, browserMode, floating, activityOpen])
  // Ctrl/⌘F searches the conversation instead of the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
        e.preventDefault()
        openFind()
        setTimeout(() => findRef.current?.select())
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [narrow])

  const matches = useMemo(() => {
    const q = find.q.trim().toLowerCase()
    if (!find.open || !q || !data) return []
    return data.messages.filter((m) => (m.text ?? '').toLowerCase().includes(q) || m.approval?.title.toLowerCase().includes(q)).map((m) => m.id)
  }, [find.open, find.q, data?.messages])
  const currentMatch = matches.length ? matches[((find.at % matches.length) + matches.length) % matches.length] : null
  useEffect(() => {
    if (currentMatch) document.getElementById(`msg-${currentMatch}`)?.scrollIntoView({ block: 'center' })
  }, [currentMatch])

  if (!data) return (
    <section class="thread">
      <div class="empty-state" role="status">
        <p>{loadError ? `Could not load this conversation: ${loadError.message}` : 'Loading conversation…'}</p>
        {loadError && <button class="ghost" onClick={reload}>Try again</button>}
      </div>
    </section>
  )
  const { thread, messages, decisions, busy, waiting } = data
  // An agent can be stopped while it works, waits, or still runs background work after its conclusion.
  const stoppable = busy || waiting || data.background
  let messageAgent = messages.find((m) => m.modelInfo)?.modelInfo ?? thread.agent
  const attributedMessages = messages.map((m) => {
    messageAgent = m.modelInfo ?? messageAgent
    return { ...m, modelInfo: messageAgent }
  })
  const elapsed = data.startedAt ? duration(Math.max(0, clock - Date.parse(data.startedAt))) : ''
  const send = (text: string, attachments: Attachment[] = []) => api('POST', `${base}/messages`, { text, attachments })
  const setAgent = (agent: AgentConfig) => api('PATCH', base, { agent })
  const patch = (b: object) => api('PATCH', base, b)
  const stop = () => api('POST', `${base}/stop`)

  const lastUser = messages.map((m) => m.kind).lastIndexOf('user')
  const last = messages[messages.length - 1]
  const openDecisions = decisions.some((d) => !d.resolved)
  const askedIds = new Set(messages.flatMap((m, i) => (i > lastUser || m.kind === 'question' ? m.decisionIds ?? [] : [])))
  const asked = decisions.filter((d) => !d.resolved && askedIds.has(d.id))
  const answering = asked.length
    ? {
        picked: asked.filter((d) => hasAnswer(answers[d.id])).length,
        total: asked.length,
        send: (comment: string, attachments: Attachment[]) => api('POST', `${base}/decisions`, { answers: asked.map((d) => ({ id: d.id, ...answers[d.id] })), comment, attachments }),
      }
    : undefined
  const lastConclusion = [...messages].reverse().find((m) => m.kind === 'conclusion')
  const showNext = !busy && last?.kind === 'conclusion' && !openDecisions && last.suggestions?.length
  const canComplete = !busy && !thread.completed && last?.kind === 'conclusion' && !openDecisions
  const queued = messages.filter((m) => m.kind === 'user' && m.delivered === false).length
  const status = busy || waiting
    ? { icon: <span class="ring busy" />, text: busy ? 'Working' : WAITING, cls: 'working' }
    : thread.needsYou
      ? { icon: <span class="ring needs" />, text: 'Your turn', cls: 'needs' }
      : thread.error === STOPPED
        ? { icon: <span class="ring" />, text: 'Stopped', cls: '' }
      : thread.error
        ? { icon: <CircleAlert size={13} />, text: 'Error', cls: 'error' }
        : thread.completed
          ? { icon: <span class="ring done" />, text: 'Finished', cls: 'done' }
          : { icon: <span class="ring" />, text: 'Ready', cls: '' }
  const running = activity?.filter((a) => !a.finishedAt && (!data.startedAt || a.time >= data.startedAt)).at(-1)
  const workingLabel = running ? { thinking: 'Thinking', command: 'Running a command', edit: 'Editing files', note: 'Working' }[running.type] : 'Working'

  const rename = () => {
    const name = prompt('Label', thread.label?.name ?? '')
    if (name !== null) patch({ label: name })
  }
  const fork = async () => {
    const t = await api<Thread>('POST', `${base}/fork`)
    go(`/p/${project.id}/t/${t.id}`)
  }
  const remove = async () => {
    if (!confirm('Delete this conversation and its history?')) return
    await api('DELETE', base)
    go(`/p/${project.id}`)
  }
  const step = (dir: 1 | -1) => setFind((f) => ({ ...f, at: f.at + dir }))

  const toggleChat = () => {
    setChatHidden(!chatHidden)
    setDraft(undefined)
  }
  const showChat = () => (narrow ? setView('chat') : setChatHidden(false))
  const showActivity = () => {
    if (browserMode) setView('chat')
    setActivityOpen(true)
  }
  // Dragging the divider moves the border between chat and page; the width stays for next time.
  const resize = (e: PointerEvent) => {
    e.preventDefault()
    const handle = e.currentTarget as HTMLElement
    const layout = layoutRef.current!
    const from = e.clientX - layout.querySelector<HTMLElement>('.thread')!.offsetWidth
    let width = chatWidth
    const move = (ev: PointerEvent) => {
      width = Math.round(Math.max(300, Math.min(layout.clientWidth - 420, ev.clientX - from)))
      layout.style.setProperty('--chat', `${width}px`)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      setPrefs({ chatWidth: width })
    }
    handle.setPointerCapture(e.pointerId)
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  // On a phone and beside the preview, the header keeps only the menu and the switch.
  const compactHead = browserMode || narrow
  const said = thread.needsYou ? 'Your turn' : last && last.kind !== 'user' && messages.length > seen ? last.text : ''
  const bubble = busy || waiting ? (
    <button class="bubble" title="Show the conversation" onClick={showChat}>
      <span class="spinner" /> {busy ? workingLabel : WAITING}
      {elapsed && <span class="muted"> · {elapsed}</span>}
    </button>
  ) : said ? (
    <button class="bubble" title="Show the conversation" onClick={showChat}>
      <ProviderIcon provider={last?.modelInfo?.provider ?? thread.agent.provider} size={15} /> <span>{said}</span>
    </button>
  ) : null
  const composer = (
    <Composer
      project={project}
      threadId={threadId}
      agent={thread.agent}
      setAgent={setAgent}
      onSend={send}
      busy={busy}
      onStop={stoppable ? stop : undefined}
      placeholder={floating ? 'Tell the agent what to change…' : busy ? 'Add a follow-up (queued until the agent is done)…' : 'Add a follow-up...'}
      draft={draft}
      picked={picked}
      clearPicked={(i) => setPicked(i < 0 ? [] : picked.filter((_, j) => j !== i))}
      review={review}
      setReview={saveReview}
      compact={floating}
      answering={answering}
      autoFocus
    />
  )

  return (
    <div class={`thread-layout ${browserMode ? 'browser' : ''}`} ref={layoutRef} style={browserMode ? { '--chat': `${chatWidth}px` } : undefined}>
      {!(browserMode && chatHidden && !narrow) && (
        <section class="thread">
          <header class="thread-head">
            <a class="square back" href={`#/p/${project.id}`} title="All conversations">
              <ArrowLeft size={17} />
            </a>
            {browserMode && (
              <button class="square list" title="Show conversations" onClick={() => setView('chat')}>
                <PanelLeft size={17} />
              </button>
            )}
            <div class="thread-head-text">
              <h1 class={titleOpen === threadId ? 'open' : ''} title={titleOpen === threadId ? 'Collapse' : 'Show the whole prompt'} onClick={() => setTitleOpen(titleOpen === threadId ? null : threadId)}>
                {thread.title}
              </h1>
              <div class="thread-sub">
                <Label label={thread.label} />
                <span class={`status ${status.cls}`}>
                  {status.icon} {status.text}{busy && elapsed ? ` · ${elapsed}` : ''}
                </span>
                {data.background && !busy && !waiting && <span class="status">Background work running</span>}
                {stoppable && <button class="status stop-work" onClick={stop}>Stop</button>}
                {queued > 0 && <span class="status">{queued} queued</span>}
                {thread.worktree && (
                  <span class="status worktree" title={thread.worktree.path}>
                    <GitBranch size={12} /> {thread.worktree.branch}
                  </span>
                )}
                {thread.fanout && (
                  <a class="status" href={`#/p/${project.id}/fan/${thread.fanout.id}`} title="Compare with the other agents">
                    <Split size={12} /> Comparison
                  </a>
                )}
                {thread.fork && (
                  <a class="status fork" href={`#/p/${project.id}/t/${thread.parentId}`} title="Open the conversation this one branches off">
                    <GitFork size={12} /> Fork
                  </a>
                )}
                {thread.context && <ContextUse context={thread.context} />}
              </div>
            </div>
            <div class="head-actions">
              {!compactHead && (
                <button class={`square ${thread.completed ? 'on' : ''}`} title={thread.completed ? 'Reopen' : 'Finish'} onClick={() => patch({ completed: !thread.completed })}>
                  <Check size={17} />
                </button>
              )}
              <div class="group">
                {!compactHead && (
                  <button class={`square ${find.open ? 'on' : ''}`} title="Find in conversation (Ctrl+F)" onClick={() => setFind({ ...find, open: !find.open })}>
                    <Search size={17} />
                  </button>
                )}
                <div class="menu-anchor">
                  <button class="square" title="More" onClick={() => setMenu(!menu)}>
                    <MoreHorizontal size={17} />
                  </button>
                  {menu && (
                    <div class="menu right" onClick={() => setMenu(false)}>
                      {compactHead && <button onClick={() => patch({ completed: !thread.completed })}>{thread.completed ? 'Reopen' : 'Finish'}</button>}
                      {compactHead && <button onClick={openFind}>Find in conversation</button>}
                      {compactHead && <button onClick={showActivity}>Show activity</button>}
                      <button onClick={rename}>Rename label</button>
                      {!busy && <button onClick={fork}>Fork conversation</button>}
                      <button onClick={() => navigator.clipboard.writeText(`${project.path}/.savor/threads/${thread.id}/messages.jsonl`)}>Copy file path</button>
                      {stoppable && <button onClick={stop}>Stop agent</button>}
                      <button class="danger" onClick={remove}>
                        Delete conversation
                      </button>
                    </div>
                  )}
                </div>
                {!compactHead && (
                  <button class={`square ${activityOpen ? 'on' : ''}`} title="Activity" onClick={() => setActivityOpen(!activityOpen)}>
                    <PanelRight size={17} />
                  </button>
                )}
              </div>
              <div class="modes">
                <button class={mode === 'chat' ? 'on' : ''} aria-pressed={mode === 'chat'} title="Chat" onClick={() => setView('chat')}>
                  <MessageSquare size={15} /> <span>Chat</span>
                </button>
                <button class={mode === 'browser' ? 'on' : ''} aria-pressed={mode === 'browser'} title="Browser" onClick={() => setView('browser')}>
                  <Globe size={15} /> <span>Browser</span>
                </button>
                <button class={mode === 'changes' ? 'on' : ''} aria-pressed={mode === 'changes'} title="Changes" onClick={() => setView('changes')}>
                  <FileDiff size={15} /> <span>Changes</span>
                  {review?.length ? <i class="mode-count">{review.length}</i> : null}
                </button>
              </div>
            </div>
          </header>
          {!(browserMode && narrow) && (
            <>
              {find.open && (
                <div class="find-bar">
                  <Search size={14} />
                  <input
                    ref={findRef}
                    autoFocus
                    placeholder="Find in conversation…"
                    value={find.q}
                    onInput={(e) => setFind({ open: true, q: e.currentTarget.value, at: 0 })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
                      if (e.key === 'Escape') setFind({ open: false, q: '', at: 0 })
                    }}
                  />
                  <span class="count">{find.q.trim() ? (matches.length ? `${matches.indexOf(currentMatch!) + 1} of ${matches.length}` : 'No matches') : ''}</span>
                  <button class="icon-btn" title="Older match (Shift+Enter)" disabled={!matches.length} onClick={() => step(-1)}>
                    <ChevronUp size={16} />
                  </button>
                  <button class="icon-btn" title="Newer match (Enter)" disabled={!matches.length} onClick={() => step(1)}>
                    <ChevronDown size={16} />
                  </button>
                  <button class="icon-btn" title="Close (Esc)" onClick={() => setFind({ open: false, q: '', at: 0 })}>
                    <X size={16} />
                  </button>
                </div>
              )}

              <div class="messages" ref={listRef}>
                {attributedMessages.map((m, i) => (
                  <MessageItem
                    key={m.id}
                    m={m}
                    thread={thread}
                    workflow={i === 0 && thread.workflow ? { ...thread.workflow, href: `#/p/${project.id}/workflows/${thread.workflow.id}` } : undefined}
                    decisions={decisions.filter((d) => m.decisionIds?.includes(d.id))}
                    active={i > lastUser || m.kind === 'question'}
                    answers={answers}
                    setAnswer={(id, a) => setAnswers({ ...answers, [id]: a })}
                    base={base}
                    highlight={find.open ? find.q.trim() : ''}
                    match={matches.includes(m.id) ? (m.id === currentMatch ? 'current' : 'match') : ''}
                    onCommit={(hash) => {
                      setSource(hash)
                      setView('changes')
                    }}
                    preview={!browserMode && m.id === lastConclusion?.id && thread.preview}
                    onPreview={() => setView('browser')}
                  />
                ))}
                {(busy || waiting) && (
                  <button class="working-row" title="Show activity" onClick={showActivity}>
                    <span class="spinner" /> {busy ? workingLabel : WAITING}{elapsed && <span class="muted"> · {elapsed}</span>} <ChevronRight size={13} />
                  </button>
                )}
                {showNext && lastConclusion ? (
                  <div class="next-actions">
                    <div class="next-head">Next steps</div>
                    {lastConclusion.suggestions!.map((s) => (
                      <div class="next-row" key={s}>
                        <button class="next-text" onClick={() => send(s)}>
                          <span>{s}</span>
                          <span class="next-send">
                            <ArrowUp size={14} />
                          </span>
                        </button>
                        <button class="next-edit" title="Edit before sending" onClick={() => setDraft(s)}>
                          <Pencil size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {canComplete && (
                <button class="mark-complete" onClick={() => patch({ completed: true })}>
                  <span>
                    <Check size={16} />
                  </span>
                  Finish
                </button>
              )}

              {composer}
            </>
          )}
        </section>
      )}
      {browserMode && !chatHidden && <div class="split-handle" onPointerDown={resize} />}
      {browserMode && (
        <section class="stage">
          {mode === 'changes' ? (
            <Changes
              project={project}
              thread={thread}
              commits={[...messages].reverse().flatMap((m) => m.commits ?? [])}
              source={source ?? (thread.worktree ? 'base' : 'uncommitted')}
              setSource={setSource}
              comments={review ?? []}
              saveComments={saveReview}
              narrow={narrow}
              chatHidden={chatHidden}
              onToggleChat={toggleChat}
            />
          ) : (
            <Preview base={base} threadId={threadId} url={thread.preview} onPick={(p) => setPicked([...picked, p])} narrow={narrow} chatHidden={chatHidden} onToggleChat={toggleChat} />
          )}
          {floating && (
            <div class="float">
              {bubble}
              {composer}
            </div>
          )}
        </section>
      )}
      {!browserMode && activityOpen && (
        <aside class="side-panel">
          <div class="panel-title">
            Activity
            <button class="icon-btn" title="Close" onClick={() => setActivityOpen(false)}>
              <X size={15} />
            </button>
          </div>
          <ActivityLog events={activity ?? []} />
        </aside>
      )}
    </div>
  )
}

function Avatar({ m, thread }: { m: Message; thread: Thread }) {
  if (m.kind === 'user') return <span class="msg-avatar user">{m.origin === 'remote' ? <Smartphone size={14} /> : <Monitor size={14} />}</span>
  return (
    <span class="msg-avatar">
      <ProviderIcon provider={m.modelInfo?.provider ?? thread.agent.provider} />
    </span>
  )
}

// Plain text with the find query highlighted.
function Highlighted({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return <>{parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>
}

const attachmentLabel = (name: string) => name.replace(/^[0-9a-f]{16}-/, '')

function MessageItem({ m, thread, workflow, decisions, active, answers, setAnswer, base, highlight, match, onCommit, preview, onPreview }: { m: Message; thread: Thread; workflow?: NonNullable<Thread['workflow']> & { href: string }; decisions: Decision[]; active: boolean; answers: Record<string, Pick>; setAnswer: (id: string, a: Pick) => void; base: string; highlight: string; match: string; onCommit: (hash: string) => void; preview?: string | false | null; onPreview?: () => void }) {
  const [copyState, setCopyState] = useState('')
  useEffect(() => {
    if (!copyState) return
    const timer = setTimeout(() => setCopyState(''), 2000)
    return () => clearTimeout(timer)
  }, [copyState])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.text ?? '')
      setCopyState('Copied')
    } catch {
      setCopyState('Could not copy')
    }
  }
  const who = m.kind === 'user' ? (m.origin === 'remote' ? `You · ${m.device ?? 'remote device'}` : 'You') : PROVIDER_NAMES[m.modelInfo?.provider ?? thread.agent.provider]
  const worked = m.workTiming && Date.parse(m.workTiming.finishedAt) - Date.parse(m.workTiming.startedAt)
  const queued = m.kind === 'user' && m.delivered === false
  const [open, setOpen] = useState(false)

  // The message that starts a workflow run is the workflow, not something the user typed: its instructions fold away.
  if (workflow && m.kind === 'user') {
    return (
      <div class={`msg wf-start ${match}`} id={`msg-${m.id}`}>
        <button class="wf-chip" aria-expanded={open || !!match} onClick={() => setOpen(!open)}>
          <WorkflowIcon size={15} /> <b>{workflow.name}</b>
          <span>
            {runTrigger(workflow)} · {formatTime(m.ts)}
          </span>
          <ChevronRight size={14} />
        </button>
        {(open || match) && (
          <div class="wf-chip-body">
            <div class="plain"><Highlighted text={m.text ?? ''} q={highlight} /></div>
            <a href={workflow.href}>
              <WorkflowIcon size={14} /> Open workflow
            </a>
          </div>
        )}
      </div>
    )
  }

  if (m.kind === 'approval') {
    const a = m.approval!
    return (
      <div class={`msg ${match}`} id={`msg-${m.id}`}>
        <div class="msg-head">
          <Avatar m={m} thread={thread} /> <b>{who}</b> <span class="muted">{formatTime(m.ts)}</span>
        </div>
        <div class="msg-card approval">
          <div class="approval-title">
            <ShieldQuestion size={16} /> {a.title ?? 'Permission request'}
          </div>
          {a.detail && <pre>{a.detail.slice(0, 1500)}</pre>}
          {a.status === 'pending' && a.options?.length ? (
            <div class="row">
              {a.options.map((o) => (
                <button key={o.id} class={o.kind === 'allow' ? 'primary' : 'ghost'} onClick={() => api('POST', `${base}/approvals/${m.id}`, { choice: o.id })}>
                  {o.label}
                </button>
              ))}
            </div>
          ) : (
            <div class="muted">{a.options?.find((o) => o.id === a.choice)?.label ?? cap(a.status)}</div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div class={`msg ${m.kind} ${queued ? 'queued' : ''} ${match}`} id={`msg-${m.id}`}>
      <div class="msg-head">
        <Avatar m={m} thread={thread} /> <b>{who}</b> <span class="muted">{formatTime(m.ts)}</span>
        {worked ? <span class="muted">Worked for {duration(worked)}</span> : null}
        {m.kind === 'question' && <span class="muted">Your turn</span>}
        {m.modelInfo?.model && <span class="muted">{m.modelInfo.model}{m.modelInfo.reasoning && ` · ${cap(m.modelInfo.reasoning)} effort`}</span>}
        {m.text && <button class="icon-btn copy-message" title={copyState || 'Copy message'} aria-label={copyState || 'Copy message'} onClick={copy}>{copyState === 'Copied' ? <Check size={13} /> : <Copy size={13} />}</button>}
        {copyState && <span class="muted" role="status">{copyState}</span>}
      </div>
      {(m.text || m.images?.length || m.files?.length) && (
        <div class={`msg-card ${m.kind}${m.kind === 'error' && m.text === STOPPED ? ' stopped' : ''}`}>
          {m.images?.length ? (
            <div class="msg-images">
              {m.images.map((img) => (
                <AttachmentImage key={img} path={`/api${base}/attachments/${img}`} />
              ))}
            </div>
          ) : null}
          {m.files?.length ? (
            <div class="msg-files">
              {m.files.map((f) => (
                <a key={f} href={`/api${base}/attachments/${f}`} download={attachmentLabel(f)}>
                  <Paperclip size={12} /> {attachmentLabel(f)}
                </a>
              ))}
            </div>
          ) : null}
          {m.text && (m.kind === 'user' ? <div class="plain"><Highlighted text={m.text} q={highlight} /></div> : <Markdown text={m.text} />)}
          {m.commits?.length ? (
            <div class="commits">
              {m.commits.map((c) => (
                <button key={c} class="commit" title={`Show what ${c} changed`} onClick={() => onCommit(c)}>
                  <GitBranch size={12} /> {c.slice(0, 7)}
                </button>
              ))}
            </div>
          ) : null}
          {preview && (
            <button class="preview-card" onClick={onPreview}>
              <span class="tile">
                <Globe size={16} />
              </span>
              <span>
                <b>Preview</b>
                <small>{preview.replace(/^https?:\/\//, '')}</small>
              </span>
              <span class="preview-open">
                Open browser <ArrowRight size={14} />
              </span>
            </button>
          )}
        </div>
      )}
      {queued && (
        <div class="queued-row">
          <b>Queued</b> <span>Sent after the current turn</span>
          <button onClick={() => api('POST', `${base}/send-now`)}>Stop work and send now</button>
          <button class="danger" onClick={() => api('DELETE', `${base}/messages/${m.id}`)}>
            Remove
          </button>
        </div>
      )}
      {decisions.length > 0 && <Questions decisions={decisions} active={active} answers={answers} setAnswer={setAnswer} />}
    </div>
  )
}

function AttachmentImage({ path }: { path: string }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let url = ''
    transport.imageUrl(path).then((u) => setSrc((url = u)))
    return () => url.startsWith('blob:') && URL.revokeObjectURL(url)
  }, [path])
  return src ? (
    <a href={src} target="_blank" rel="noreferrer">
      <img src={src} alt="" />
    </a>
  ) : null
}

type Pick = { selected?: number; answer?: string }
const hasAnswer = (a?: Pick) => a?.selected !== undefined || !!a?.answer?.trim()

// The answers are picked here and sent from the composer, together with an optional comment.
function Questions({ decisions, active, answers, setAnswer }: { decisions: Decision[]; active: boolean; answers: Record<string, Pick>; setAnswer: (id: string, a: Pick) => void }) {
  const open = active && decisions.some((d) => !d.resolved)
  const n = decisions.length

  return (
    <div class="questions">
      {decisions.map((d, i) => {
        const a = answers[d.id] ?? {}
        const other = a.selected === undefined && !!a.answer?.trim()
        return (
          <div class="question" key={d.id}>
            <div class="q-title">
              {n > 1 && <span class="q-num">{i + 1}</span>} {d.title}
            </div>
            {d.body && <Markdown text={d.body} />}
            {open ? (
              <div class="options">
                {d.options
                  .map((o, oi) => ({ o, oi }))
                  .sort((x, y) => Number(y.oi === d.recommended) - Number(x.oi === d.recommended))
                  .map(({ o, oi }) => (
                    <label key={oi} class={`option ${oi === d.recommended ? 'recommended' : ''} ${a.selected === oi ? 'selected' : ''}`}>
                      <input type="radio" name={d.id} checked={a.selected === oi} onChange={() => setAnswer(d.id, { ...a, selected: oi })} />
                      <span>{o}</span>
                      {oi === d.recommended && <span class="recommended-pill">Recommended</span>}
                    </label>
                  ))}
                <label class={`option other ${other ? 'selected' : ''}`}>
                  <input type="radio" name={d.id} checked={other} onChange={(e) => (e.currentTarget.nextElementSibling as HTMLInputElement).focus()} />
                  <input
                    class="other-answer"
                    placeholder={d.options.length ? 'Something else…' : 'Your answer…'}
                    value={a.answer ?? ''}
                    onFocus={() => a.answer?.trim() && setAnswer(d.id, { answer: a.answer })}
                    onInput={(e) => setAnswer(d.id, { answer: e.currentTarget.value })}
                  />
                </label>
              </div>
            ) : (
              <div class="answered">
                {d.resolved && (d.selected != null || d.answer != null) ? (
                  <>
                    <Check size={14} /> {d.selected != null ? d.options[d.selected] : d.answer}
                  </>
                ) : d.resolved ? (
                  <span class="muted">Skipped</span>
                ) : (
                  <span class="muted">Not answered</span>
                )}
              </div>
            )}
          </div>
        )
      })}
      {open && <div class="q-hint">Pick an answer {n === 1 ? '' : 'for each question '}and send from the box below. You can add a comment there.</div>}
    </div>
  )
}

const ACTIVITY_ICONS = { thinking: Brain, command: Terminal, edit: Pencil, note: Wrench }

function ActivityLog({ events }: { events: ActivityEvent[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.scrollTo({ top: ref.current.scrollHeight }), [events.length])
  if (!events.length) return <p class="muted center">No activity yet.</p>
  return (
    <div class="activity" ref={ref}>
      {events.map((e) => {
        const Icon = ACTIVITY_ICONS[e.type]
        const ms = e.finishedAt ? Date.parse(e.finishedAt) - Date.parse(e.time) : null
        return (
          <div key={e.id} class={`activity-row ${e.type} ${e.finishedAt ? '' : 'running'}`}>
            <Icon size={14} />
            <span class="activity-label" title={e.label}>
              {e.label}
            </span>
            <span class="muted small">{ms === null ? <span class="spinner small" /> : ms >= 1000 ? duration(ms) : ''}</span>
          </div>
        )
      })}
    </div>
  )
}
