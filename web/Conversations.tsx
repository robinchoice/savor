import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  Asterisk, Hexagon, Code2, Sparkles, Orbit, Plus, Search, Layers, MessageSquare, Check, MoreHorizontal, PanelRight, FileText, Flag,
  CircleAlert, ArrowUp, ArrowLeft, Pencil, Brain, Terminal, Wrench, ArrowRight, MessageSquareMore, Smartphone, Monitor, ShieldQuestion, CircleCheck,
} from 'lucide-preact'
import {
  api, duration, formatDay, formatTime, go, PROVIDERS, useApi, type ActivityEvent, type AgentConfig, type Decision, type Message, type Proc, type Project, type Thread,
} from './api'
import { Composer, type Picked } from './Composer'
import { Preview } from './Preview'

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
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [showCompleted, setShowCompleted] = useState(() => localStorage.getItem('savor-show-completed') !== 'false')
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
          {visible.map((t) => (
            <ThreadCard key={t.id} project={project} thread={t} active={t.id === threadId} />
          ))}
          {threads && !visible.length && <p class="muted center">No conversations{filter !== 'all' ? ' in this filter' : ' yet'}.</p>}
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

function ThreadCard({ project, thread: t, active }: { project: Project; thread: Thread; active: boolean }) {
  const [firstOpen, setFirstOpen] = useState<string | null>(null)
  useEffect(() => {
    if (t.needsYou) api<{ decisions: Decision[]; messages: Message[] }>('GET', `/projects/${project.id}/threads/${t.id}`).then((d) => {
      const pendingApproval = d.messages.find((m) => m.approval?.status === 'pending')
      setFirstOpen(d.decisions.find((x) => !x.resolved)?.title ?? (pendingApproval ? `Allow ${pendingApproval.approval!.tool}?` : null))
    })
  }, [t.needsYou, t.updatedAt])
  const href = `#/p/${project.id}/t/${t.id}`
  return (
    <a href={href} class={`card ${active ? 'active' : ''} ${t.unread ? 'unread' : ''}`}>
      <div class="card-top">
        <Label label={t.label} />
        {t.busy && <span class="working-dot" title="Working" />}
        <span class="count">
          <MessageSquare size={14} /> {t.messageCount}
        </span>
      </div>
      <div class="card-title">{t.title}</div>
      <div class="card-meta">
        <span>
          {PROVIDERS[t.agent.provider]?.name} · {formatDay(t.updatedAt)}
        </span>
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
  const send = async (text: string, images: string[]) => {
    const t = await api<Thread>('POST', `/projects/${project.id}/threads`, { text, images, agent })
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
      <Composer project={project} agent={agent} setAgent={setAgent} onSend={send} placeholder="Describe what you want…" autoFocus />
    </section>
  )
}

interface ThreadData { thread: Thread; busy: boolean; messages: Message[]; decisions: Decision[]; processes: Proc[] }

function ThreadView({ project, threadId }: { project: Project; threadId: string }) {
  const base = `/projects/${project.id}/threads/${threadId}`
  const [data] = useApi<ThreadData>(base, (e) => e.threadId === threadId && ['message', 'thread', 'status'].includes(e.type))
  const [activity] = useApi<ActivityEvent[]>(`${base}/activity`, (e) => e.threadId === threadId && (e.type === 'activity' || e.type === 'status'))
  const [panel, setPanel] = useState<'activity' | 'preview' | null>(null)
  const [draft, setDraft] = useState<string>()
  const [picked, setPicked] = useState<Picked[]>([])
  const [menu, setMenu] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (data?.thread.preview && panel === null) setPanel('preview')
  }, [data?.thread.preview])
  useEffect(() => {
    const el = listRef.current
    if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight))
  }, [data?.messages.length, data?.busy, panel])

  if (!data) return <section class="thread" />
  const { thread, messages, decisions, busy } = data
  const send = (text: string, images: string[] = []) => api('POST', `${base}/messages`, { text, images })
  const setAgent = (agent: AgentConfig) => api('PATCH', base, { agent })
  const patch = (b: object) => api('PATCH', base, b)

  const lastUser = messages.map((m) => m.kind).lastIndexOf('user')
  const last = messages[messages.length - 1]
  const openDecisions = decisions.some((d) => !d.resolved)
  const lastConclusion = [...messages].reverse().find((m) => m.kind === 'conclusion')
  const showNext = !busy && last?.kind === 'conclusion' && !openDecisions && last.suggestions?.length
  const canComplete = !busy && !thread.completed && last?.kind === 'conclusion' && !openDecisions
  const status = busy
    ? { icon: <Layers size={13} />, text: 'Working', cls: 'working' }
    : thread.needsYou
      ? { icon: <Flag size={13} />, text: 'Needs input', cls: 'needs' }
      : thread.error
        ? { icon: <CircleAlert size={13} />, text: 'Error', cls: 'error' }
        : thread.completed
          ? { icon: <CircleCheck size={13} />, text: 'Completed', cls: 'done' }
          : { icon: <MessageSquare size={13} />, text: 'Ready', cls: '' }
  const running = activity?.filter((a) => !a.finishedAt).at(-1) ?? activity?.at(-1)

  const rename = () => {
    const name = prompt('Label', thread.label?.name ?? '')
    if (name !== null) patch({ label: name })
  }
  const remove = async () => {
    if (!confirm('Delete this conversation and its history?')) return
    await api('DELETE', base)
    go(`/p/${project.id}`)
  }

  return (
    <div class="thread-layout">
      <section class="thread">
        <header class="thread-head">
          <a class="square back" href={`#/p/${project.id}`} title="All conversations">
            <ArrowLeft size={17} />
          </a>
          <div class="thread-head-text">
            <h1 title={thread.title}>{thread.title}</h1>
            <div class="thread-sub">
              <span class={`status ${status.cls}`}>
                {status.icon} {status.text}
              </span>
              <span class="path">
                <FileText size={12} /> .savor/threads/{thread.id}/messages.jsonl
              </span>
            </div>
          </div>
          <div class="head-actions">
            <button class={`square ${thread.completed ? 'on' : ''}`} title={thread.completed ? 'Reopen' : 'Mark as completed'} onClick={() => patch({ completed: !thread.completed })}>
              <Check size={17} />
            </button>
            <div class="group">
              <div class="menu-anchor">
                <button class="square" title="More" onClick={() => setMenu(!menu)}>
                  <MoreHorizontal size={17} />
                </button>
                {menu && (
                  <div class="menu right" onClick={() => setMenu(false)}>
                    <button onClick={rename}>Rename label</button>
                    <button onClick={() => navigator.clipboard.writeText(`${project.path}/.savor/threads/${thread.id}/messages.jsonl`)}>Copy file path</button>
                    {busy && <button onClick={() => api('POST', `${base}/stop`)}>Stop agent</button>}
                    <button class="danger" onClick={remove}>
                      Delete conversation
                    </button>
                  </div>
                )}
              </div>
              <button class={`square ${panel ? 'on' : ''}`} title="Side panel" onClick={() => setPanel(panel ? null : thread.preview ? 'preview' : 'activity')}>
                <PanelRight size={17} />
              </button>
            </div>
          </div>
        </header>

        <div class="messages" ref={listRef}>
          {messages.map((m, i) => (
            <MessageItem
              key={m.id}
              m={m}
              thread={thread}
              decisions={decisions.filter((d) => m.decisionIds?.includes(d.id))}
              active={i > lastUser}
              base={base}
            />
          ))}
          {busy && (
            <div class="working-row">
              <span class="spinner" /> Working{running ? <span class="muted"> · {running.label.slice(0, 120)}</span> : null}
            </div>
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

        <Composer
          project={project}
          agent={thread.agent}
          setAgent={setAgent}
          onSend={send}
          busy={busy}
          onStop={() => api('POST', `${base}/stop`)}
          placeholder="Add a follow-up..."
          draft={draft}
          picked={picked}
          clearPicked={(i) => setPicked(i < 0 ? [] : picked.filter((_, j) => j !== i))}
        />
      </section>
      {panel && (
        <aside class="side-panel">
          <div class="panel-tabs">
            <button class={panel === 'preview' ? 'active' : ''} onClick={() => setPanel('preview')}>
              Preview
            </button>
            <button class={panel === 'activity' ? 'active' : ''} onClick={() => setPanel('activity')}>
              Activity
            </button>
          </div>
          {panel === 'preview' ? (
            <Preview base={base} threadId={threadId} url={thread.preview} onPick={(p) => setPicked([...picked, p])} />
          ) : (
            <ActivityLog events={activity ?? []} />
          )}
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

function MessageItem({ m, thread, decisions, active, base }: { m: Message; thread: Thread; decisions: Decision[]; active: boolean; base: string }) {
  const who = m.kind === 'user' ? (m.origin === 'remote' ? `You · ${m.device ?? 'remote device'}` : 'You') : PROVIDERS[m.modelInfo?.provider ?? thread.agent.provider]?.name
  const worked = m.workTiming && Date.parse(m.workTiming.finishedAt) - Date.parse(m.workTiming.startedAt)

  if (m.kind === 'approval') {
    const a = m.approval!
    return (
      <div class="msg">
        <div class="msg-head">
          <Avatar m={m} thread={thread} /> <b>{who}</b> <span class="muted">{formatTime(m.ts)}</span>
        </div>
        <div class="msg-card approval">
          <div class="approval-title">
            <ShieldQuestion size={16} /> Allow <code>{a.tool}</code>?
          </div>
          <pre>{JSON.stringify(a.input, null, 2).slice(0, 1500)}</pre>
          {a.status === 'pending' ? (
            <div class="row">
              <button class="primary" onClick={() => api('POST', `${base}/approvals/${m.id}`, { allow: true })}>
                Allow
              </button>
              <button class="ghost" onClick={() => api('POST', `${base}/approvals/${m.id}`, { allow: false })}>
                Deny
              </button>
            </div>
          ) : (
            <div class="muted">{a.status === 'allowed' ? 'Allowed' : 'Denied'}</div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div class={`msg ${m.kind}`}>
      <div class="msg-head">
        <Avatar m={m} thread={thread} /> <b>{who}</b> <span class="muted">{formatTime(m.ts)}</span>
        {worked ? <span class="muted">Worked for {duration(worked)}</span> : null}
      </div>
      {(m.text || m.images?.length) && (
        <div class={`msg-card ${m.kind}`}>
          {m.images?.length ? (
            <div class="msg-images">
              {m.images.map((img) => (
                <a key={img} href={`/api${base}/attachments/${img}`} target="_blank" rel="noreferrer">
                  <img src={`/api${base}/attachments/${img}`} alt="" />
                </a>
              ))}
            </div>
          ) : null}
          {m.text && (m.kind === 'user' ? <div class="plain">{m.text}</div> : <Markdown text={m.text} />)}
          {m.commits?.length ? (
            <div class="commits">
              {m.commits.map((c) => (
                <code key={c} title={c}>
                  {c.slice(0, 7)}
                </code>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {decisions.length > 0 && <Questions decisions={decisions} active={active} base={base} />}
    </div>
  )
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
