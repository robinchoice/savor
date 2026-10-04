import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  Asterisk, Hexagon, Code2, Sparkles, Orbit, Plus, Search, Layers, MessageSquare, Check, MoreHorizontal, PanelLeft, PanelRight, FileText, Flag, Globe,
  CircleAlert, ArrowUp, ArrowLeft, Pencil, Brain, Terminal, Wrench, ArrowRight, MessageSquareMore, Smartphone, Monitor, ShieldQuestion, CircleCheck, X, ChevronUp, ChevronDown, ChevronRight, Paperclip, GitBranch, GitMerge, Trash2, Copy,
} from 'lucide-preact'
import {
  api, cap, duration, formatDay, formatTime, go, PROVIDER_NAMES, useApi, type ActivityEvent, type AgentConfig, type Attachment, type Decision, type Message, type Proc, type Project, type Thread, type Worktree,
} from './api'
import { Composer, type Picked } from './Composer'
import { transport } from './transport'
import { Preview } from './Preview'
import { CommitDialog } from './Commit'
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

export function Conversations({ project, threadId, isNew }: { project: Project; threadId?: string; isNew?: boolean }) {
  const [threads] = useApi<Thread[]>(`/projects/${project.id}/threads`, (e) => e.projectId === project.id && ['thread', 'status', 'message'].includes(e.type))
  const [worktrees] = useApi<Worktree[]>(`/projects/${project.id}/worktrees`, (e) => e.projectId === project.id && e.type === 'thread')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [showCompleted, setShowCompleted] = useState(() => localStorage.getItem('savor-show-completed') === 'true')
  useEffect(() => localStorage.setItem('savor-show-completed', String(showCompleted)), [showCompleted])

  const all = (threads ?? []).filter((t) => showCompleted || !t.completed || t.id === threadId)
  const counts = {
    all: all.length,
    needs: all.filter((t) => t.needsYou).length,
    working: all.filter((t) => t.busy).length,
    unread: all.filter((t) => t.unread).length,
  }
  const q = query.toLowerCase()
  const visible = all
    .filter((t) => filter === 'all' || (filter === 'needs' ? t.needsYou : filter === 'working' ? t.busy : t.unread))
    .filter((t) => !q || t.title.toLowerCase().includes(q) || t.label?.name.toLowerCase().includes(q))

  // Conversations in a worktree are listed under it, worktrees without conversations too.
  const groups = new Map<string, { branch: string; path: string; threads: Thread[] }>()
  for (const w of worktrees ?? []) groups.set(w.path, { branch: w.branch, path: w.path, threads: [] })
  for (const t of visible) if (t.worktree) (groups.get(t.worktree.path) ?? groups.set(t.worktree.path, { ...t.worktree, threads: [] }).get(t.worktree.path)!).threads.push(t)
  const plain = visible.filter((t) => !t.worktree)

  const filterTab = (id: Filter, label: string, Icon?: any) => (
    <button class={`filter ${filter === id ? 'active' : ''} ${id === 'needs' && counts.needs ? 'attention' : ''}`} onClick={() => setFilter(id)}>
      {Icon && <Icon size={13} />} {label} <b>{counts[id]}</b>
    </button>
  )

  return (
    <div class={`conversations ${threadId || isNew ? 'has-detail' : ''}`}>
      <aside class="conv-list">
        <div class="conv-head">
          <MessageSquareMore size={26} class="conv-head-icon" />
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
          {filterTab('needs', 'Needs you')}
          {filterTab('working', 'Working', Layers)}
          {filterTab('unread', 'Unread', MessageSquare)}
        </div>
        <div class="cards">
          {plain.map((t) => (
            <ThreadCard key={t.id} project={project} thread={t} active={t.id === threadId} />
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
            <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.currentTarget.checked)} /> Show completed
          </label>
        </footer>
      </aside>
      {threadId ? <ThreadView key={threadId} project={project} threadId={threadId} /> : <NewConversation project={project} />}
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
  // Compact: one line with the title, what the conversation is waiting for as a dot.
  if (conversations === 'compact')
    return (
      <a href={href} class={`card compact ${active ? 'active' : ''} ${t.unread ? 'unread' : ''}`}>
        <div class="card-title">{t.title}</div>
        <span class="card-meta">
          {t.busy && <span class="working-dot" title="Working" />}
          {t.needsYou && <span class="working-dot needs" title="Needs you" />}
          {t.error && !t.busy && <span class="working-dot error" title="Error" />}
          {show.count && (
            <span>
              <MessageSquare size={13} /> {t.messageCount}
            </span>
          )}
          {show.date && formatDay(t.updatedAt)}
        </span>
      </a>
    )
  return (
    <a href={href} class={`card ${active ? 'active' : ''} ${t.unread ? 'unread' : ''}`}>
      {((show.label && t.label) || t.busy || show.count) && (
        <div class="card-top">
          {show.label && <Label label={t.label} />}
          {t.busy && <span class="working-dot" title="Working" />}
          {show.count && (
            <span class="count">
              <MessageSquare size={14} /> {t.messageCount}
            </span>
          )}
        </div>
      )}
      <div class="card-title">{t.title}</div>
      <div class="card-meta">
        <span>{[show.agent && (PROVIDER_NAMES[t.agent.provider] ?? t.agent.provider), show.date && formatDay(t.updatedAt)].filter(Boolean).join(' · ')}</span>
        {t.completed && (
          <span class="completed-badge">
            <Check size={12} /> Completed
          </span>
        )}
        {t.error && !t.busy && (
          <span class="error-badge">
            <CircleAlert size={12} /> Error
          </span>
        )}
      </div>
      {t.needsYou && firstOpen && (
        <div class="needs-row">
          <b>Needs you</b> <span>{firstOpen}</span>
          <span class="respond">
            Respond <ArrowRight size={13} />
          </span>
        </div>
      )}
    </a>
  )
}

function NewConversation({ project }: { project: Project }) {
  const [agent, setAgent] = useState<AgentConfig>(project.agent)
  const [worktree, setWorktree] = useState<string | null>(null)
  const send = async (text: string, attachments: Attachment[]) => {
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
      <Composer project={project} agent={agent} setAgent={setAgent} onSend={send} placeholder="Describe what you want…" worktree={worktree} setWorktree={setWorktree} autoFocus />
    </section>
  )
}

interface ThreadData { thread: Thread; busy: boolean; startedAt?: string; messages: Message[]; decisions: Decision[]; processes: Proc[] }

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
  const [data, reload, loadError] = useApi<ThreadData>(base, (e) => e.threadId === threadId && ['message', 'thread', 'status'].includes(e.type))
  const [activity] = useApi<ActivityEvent[]>(`${base}/activity`, (e) => e.threadId === threadId && (e.type === 'activity' || e.type === 'status'))
  // Chat or browser: the first preview of a conversation opens the browser, after that the last choice stands.
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
  const setView = (v: 'chat' | 'browser') => {
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
  const [commit, setCommit] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const [clock, setClock] = useState(Date.now())
  useEffect(() => {
    if (!data?.busy) return
    setClock(Date.now())
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [data?.busy])

  const browserMode = (view ?? (data?.thread.preview ? 'browser' : 'chat')) === 'browser'
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
  const { thread, messages, decisions, busy } = data
  let messageAgent = messages.find((m) => m.modelInfo)?.modelInfo ?? thread.agent
  const attributedMessages = messages.map((m) => {
    messageAgent = m.modelInfo ?? messageAgent
    return { ...m, modelInfo: messageAgent }
  })
  const elapsed = data.startedAt ? duration(Math.max(0, clock - Date.parse(data.startedAt))) : ''
  const send = (text: string, attachments: Attachment[] = []) => api('POST', `${base}/messages`, { text, attachments })
  const setAgent = (agent: AgentConfig) => api('PATCH', base, { agent })
  const patch = (b: object) => api('PATCH', base, b)

  const lastUser = messages.map((m) => m.kind).lastIndexOf('user')
  const last = messages[messages.length - 1]
  const openDecisions = decisions.some((d) => !d.resolved)
  const lastConclusion = [...messages].reverse().find((m) => m.kind === 'conclusion')
  const showNext = !busy && last?.kind === 'conclusion' && !openDecisions && last.suggestions?.length
  const canComplete = !busy && !thread.completed && last?.kind === 'conclusion' && !openDecisions
  const queued = messages.filter((m) => m.kind === 'user' && m.delivered === false).length
  const status = busy
    ? { icon: <Layers size={13} />, text: 'Working', cls: 'working' }
    : thread.needsYou
      ? { icon: <Flag size={13} />, text: 'Needs input', cls: 'needs' }
      : thread.error
        ? { icon: <CircleAlert size={13} />, text: 'Error', cls: 'error' }
        : thread.completed
          ? { icon: <CircleCheck size={13} />, text: 'Completed', cls: 'done' }
          : { icon: <MessageSquare size={13} />, text: 'Ready', cls: '' }
  const running = activity?.filter((a) => !a.finishedAt && (!data.startedAt || a.time >= data.startedAt)).at(-1)
  const workingLabel = running ? { thinking: 'Thinking', command: 'Running a command', edit: 'Editing files', note: 'Working' }[running.type] : 'Working'

  const rename = () => {
    const name = prompt('Label', thread.label?.name ?? '')
    if (name !== null) patch({ label: name })
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
  const said = thread.needsYou ? 'Needs your input' : last && last.kind !== 'user' && messages.length > seen ? last.text : ''
  const bubble = busy ? (
    <button class="bubble" title="Show the conversation" onClick={showChat}>
      <span class="spinner" /> {workingLabel}
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
      onStop={() => api('POST', `${base}/stop`)}
      placeholder={floating ? 'Tell the agent what to change…' : busy ? 'Add a follow-up (queued until the agent is done)…' : 'Add a follow-up...'}
      draft={draft}
      picked={picked}
      clearPicked={(i) => setPicked(i < 0 ? [] : picked.filter((_, j) => j !== i))}
      compact={floating}
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
              <h1 title={thread.title}>{thread.title}</h1>
              <div class="thread-sub">
                <span class={`status ${status.cls}`}>
                  {status.icon} {status.text}{busy && elapsed ? ` · ${elapsed}` : ''}
                </span>
                {busy && <button class="status stop-work" onClick={() => api('POST', `${base}/stop`)}>Stop</button>}
                {queued > 0 && <span class="status">{queued} queued</span>}
                {thread.worktree && (
                  <span class="status worktree" title={thread.worktree.path}>
                    <GitBranch size={12} /> {thread.worktree.branch}
                  </span>
                )}
              </div>
            </div>
            <div class="head-actions">
              {!compactHead && (
                <button class={`square ${thread.completed ? 'on' : ''}`} title={thread.completed ? 'Reopen' : 'Mark as completed'} onClick={() => patch({ completed: !thread.completed })}>
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
                      {compactHead && <button onClick={() => patch({ completed: !thread.completed })}>{thread.completed ? 'Reopen' : 'Mark as completed'}</button>}
                      {compactHead && <button onClick={openFind}>Find in conversation</button>}
                      {compactHead && <button onClick={showActivity}>Show activity</button>}
                      <button onClick={rename}>Rename label</button>
                      <button onClick={() => navigator.clipboard.writeText(`${project.path}/.savor/threads/${thread.id}/messages.jsonl`)}>Copy file path</button>
                      {busy && <button onClick={() => api('POST', `${base}/stop`)}>Stop agent</button>}
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
                <button class={browserMode ? '' : 'on'} aria-pressed={!browserMode} title="Chat" onClick={() => setView('chat')}>
                  <MessageSquare size={15} /> <span>Chat</span>
                </button>
                <button class={browserMode ? 'on' : ''} aria-pressed={browserMode} title="Browser" onClick={() => setView('browser')}>
                  <Globe size={15} /> <span>Browser</span>
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
                    decisions={decisions.filter((d) => m.decisionIds?.includes(d.id))}
                    active={i > lastUser || m.kind === 'question'}
                    base={base}
                    highlight={find.open ? find.q.trim() : ''}
                    match={matches.includes(m.id) ? (m.id === currentMatch ? 'current' : 'match') : ''}
                    onCommit={setCommit}
                    preview={!browserMode && m.id === lastConclusion?.id && thread.preview}
                    onPreview={() => setView('browser')}
                  />
                ))}
                {busy && (
                  <button class="working-row" title="Show activity" onClick={showActivity}>
                    <span class="spinner" /> {workingLabel}{elapsed && <span class="muted"> · {elapsed}</span>} <ChevronRight size={13} />
                  </button>
                )}
                {showNext && lastConclusion ? (
                  <div class="next-actions">
                    <div class="next-head">
                      <Sparkles size={14} /> Potential next actions
                    </div>
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
                  Mark as completed
                </button>
              )}

              {composer}
            </>
          )}
        </section>
      )}
      {commit && <CommitDialog project={project} hash={commit} threadId={threadId} onClose={() => setCommit(null)} />}
      {browserMode && !chatHidden && <div class="split-handle" onPointerDown={resize} />}
      {browserMode && (
        <section class="stage">
          <Preview base={base} threadId={threadId} url={thread.preview} onPick={(p) => setPicked([...picked, p])} narrow={narrow} chatHidden={chatHidden} onToggleChat={toggleChat} />
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

function MessageItem({ m, thread, decisions, active, base, highlight, match, onCommit, preview, onPreview }: { m: Message; thread: Thread; decisions: Decision[]; active: boolean; base: string; highlight: string; match: string; onCommit: (hash: string) => void; preview?: string | false | null; onPreview?: () => void }) {
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
        {m.kind === 'question' && <span class="muted">Needs your input</span>}
        {m.modelInfo?.model && <span class="muted">{m.modelInfo.model}{m.modelInfo.reasoning && ` · ${cap(m.modelInfo.reasoning)} effort`}</span>}
        {m.text && <button class="icon-btn copy-message" title={copyState || 'Copy message'} aria-label={copyState || 'Copy message'} onClick={copy}>{copyState === 'Copied' ? <Check size={13} /> : <Copy size={13} />}</button>}
        {copyState && <span class="muted" role="status">{copyState}</span>}
      </div>
      {(m.text || m.images?.length || m.files?.length) && (
        <div class={`msg-card ${m.kind}`}>
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
      {decisions.length > 0 && <Questions decisions={decisions} active={active} base={base} />}
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

function Questions({ decisions, active, base }: { decisions: Decision[]; active: boolean; base: string }) {
  const [answers, setAnswers] = useState<{ selected?: number; answer?: string }[]>(() => decisions.map(() => ({})))
  const [sending, setSending] = useState(false)
  const open = active && decisions.some((d) => !d.resolved)
  const set = (i: number, v: { selected?: number; answer?: string }) => setAnswers(answers.map((a, j) => (j === i ? v : a)))
  const complete = answers.every((a) => a.selected !== undefined || a.answer?.trim())
  const submit = async () => {
    setSending(true)
    await api('POST', `${base}/decisions`, { answers: decisions.map((d, i) => ({ id: d.id, ...answers[i] })) }).finally(() => setSending(false))
  }
  const n = decisions.length

  return (
    <div class="msg-card questions">
      <div class="q-head">
        <span class="q-icon">
          <MessageSquare size={17} />
        </span>
        <div>
          <b>{n === 1 ? 'One thing before I continue' : 'A few things before I continue'}</b>
          <small>
            {n} question{n === 1 ? '' : 's'} · One reply
          </small>
        </div>
      </div>
      {decisions.map((d, i) => (
        <div class="question" key={d.id}>
          <div class="q-title">
            <span class="q-num">{i + 1}</span> {d.title}
          </div>
          {d.body && <Markdown text={d.body} />}
          {open ? (
            <>
              {d.options.map((o, oi) => (
                <label key={oi} class={`option ${answers[i].selected === oi ? 'selected' : ''}`}>
                  <input type="radio" name={d.id} checked={answers[i].selected === oi} onChange={() => set(i, { selected: oi })} />
                  {o}
                </label>
              ))}
              <div class="own-label">{d.options.length ? 'Or write your own answer' : 'Your answer'}</div>
              <textarea placeholder="Type your answer..." value={answers[i].answer ?? ''} onInput={(e) => set(i, { answer: e.currentTarget.value })} />
            </>
          ) : (
            <div class="answered">
              {d.resolved ? (
                <>
                  <Check size={14} /> {d.selected != null ? d.options[d.selected] : d.answer}
                </>
              ) : (
                <span class="muted">Not answered</span>
              )}
            </div>
          )}
        </div>
      ))}
      {open && (
        <div class="q-actions">
          <button class="primary" disabled={!complete || sending} onClick={submit}>
            Send reply <ArrowUp size={14} />
          </button>
        </div>
      )}
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
