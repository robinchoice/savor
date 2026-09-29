import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { api, go, useApi, useEvent, type Message, type Project, type Question, type Thread } from './api'

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text])
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />
}

function Composer(props: { text: string; setText: (t: string) => void; onSend: () => void; busy?: boolean; onStop?: () => void; placeholder: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current!
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 280) + 'px'
  }, [props.text])
  const submit = () => props.text.trim() && props.onSend()
  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={props.text}
        placeholder={props.placeholder}
        onInput={(e) => props.setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      {props.busy && props.onStop && (
        <button type="button" class="ghost" onClick={props.onStop}>
          Stop
        </button>
      )}
      <button type="submit" disabled={!props.text.trim()}>
        Send
      </button>
    </form>
  )
}

export function NewThread({ project }: { project: Project }) {
  const [text, setText] = useState('')
  const send = async () => {
    const t = await api<Thread>('POST', `/projects/${project.id}/threads`, { text })
    go(`/p/${project.id}/t/${t.id}`)
  }
  return (
    <div class="thread new">
      <div class="hero">
        <h2>What are we making in {project.name}?</h2>
        <p class="muted">
          {project.agent.provider}
          {project.agent.model && ` · ${project.agent.model}`} · {project.path}
        </p>
      </div>
      <Composer text={text} setText={setText} onSend={send} placeholder="Describe what you want…" />
    </div>
  )
}

type Group = { trace: Message[] } | Message

function group(messages: Message[]): Group[] {
  const out: Group[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (m.kind !== 'trace') out.push(m)
    else if (last && 'trace' in last) last.trace.push(m)
    else out.push({ trace: [m] })
  }
  return out
}

export function ThreadView({ project, threadId }: { project: Project; threadId: string }) {
  const base = `/projects/${project.id}/threads/${threadId}`
  const [data] = useApi<{ thread: Thread; messages: Message[]; busy: boolean }>(base, (e) => e.threadId === threadId && ['message', 'thread', 'status'].includes(e.type))
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [data?.messages.length, data?.busy])

  if (!data) return <div class="thread" />
  const { thread, messages, busy } = data
  const send = async (t = text) => {
    setText('')
    await api('POST', `${base}/messages`, { text: t })
  }
  const lastUser = messages.map((m) => m.kind).lastIndexOf('user')

  return (
    <div class="thread-layout">
      <section class="thread">
        <header>
          <h2>{thread.label ?? 'New conversation'}</h2>
          {busy && <span class="status"><span class="pulse" /> working</span>}
        </header>
        <div class="messages" ref={listRef}>
          {group(messages).map((g, i) =>
            'trace' in g ? (
              <details key={g.trace[0].id} class="trace">
                <summary>{g.trace.length} agent step{g.trace.length === 1 ? "" : "s"}</summary>
                {g.trace.map((m) => (
                  <pre key={m.id}>{m.text}</pre>
                ))}
              </details>
            ) : (
              <MessageView key={g.id} m={g} active={messages.indexOf(g) > lastUser} base={base} onAnswer={send} />
            ),
          )}
          {busy && messages[messages.length - 1]?.kind === 'user' && <div class="msg ack muted">Waiting for the agent…</div>}
        </div>
        <Composer text={text} setText={setText} onSend={() => send()} busy={busy} onStop={() => api('POST', `${base}/stop`)} placeholder="Reply…" />
      </section>
      {thread.preview && <Preview url={thread.preview} base={base} threadId={threadId} />}
    </div>
  )
}

function MessageView({ m, active, base, onAnswer }: { m: Message; active: boolean; base: string; onAnswer: (text: string) => void }) {
  if (m.kind === 'user') return <div class="msg user">{m.text}</div>
  if (m.kind === 'error') return <div class="msg error">{m.text}</div>
  if (m.kind === 'approval') {
    const a = m.approval!
    return (
      <div class="msg approval">
        <div>
          Allow <code>{a.tool}</code>?
        </div>
        <pre>{JSON.stringify(a.input, null, 2).slice(0, 1500)}</pre>
        {a.status === 'pending' ? (
          <div class="row">
            <button onClick={() => api('POST', `${base}/approvals/${m.id}`, { allow: true })}>Allow</button>
            <button class="ghost" onClick={() => api('POST', `${base}/approvals/${m.id}`, { allow: false })}>
              Deny
            </button>
          </div>
        ) : (
          <div class="muted">{a.status}</div>
        )}
      </div>
    )
  }
  return (
    <div class={`msg agent ${m.kind}`}>
      {m.text && <Markdown text={m.text} />}
      {m.questions?.length ? <Questions questions={m.questions} active={active} onSubmit={onAnswer} /> : null}
      {m.commits?.length ? (
        <div class="commits">
          {m.commits.map((c) => (
            <code key={c} title={c}>
              {c.slice(0, 8)}
            </code>
          ))}
        </div>
      ) : null}
      {active && m.suggestions?.length ? (
        <div class="suggestions">
          {m.suggestions.map((s) => (
            <button key={s} class="chip" onClick={() => onAnswer(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Questions({ questions, active, onSubmit }: { questions: Question[]; active: boolean; onSubmit: (text: string) => void }) {
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ''))
  const set = (i: number, v: string) => setAnswers(answers.map((a, j) => (j === i ? v : a)))
  const done = answers.every((a) => a.trim())
  const submit = () =>
    onSubmit(questions.map((q, i) => `Decision: ${q.title}\n${q.options.includes(answers[i]) ? 'Selected' : 'Answer'}: ${answers[i]}`).join('\n\n'))

  return (
    <div class="questions">
      {questions.map((q, i) => (
        <fieldset key={i} disabled={!active}>
          <legend>{q.title}</legend>
          {q.body && <Markdown text={q.body} />}
          <div class="options">
            {q.options.map((o) => (
              <button type="button" key={o} class={`chip ${answers[i] === o ? 'selected' : ''}`} onClick={() => set(i, o)}>
                {o}
              </button>
            ))}
          </div>
          {active && (
            <input
              placeholder={q.options.length ? 'Or type your own answer' : 'Your answer'}
              value={q.options.includes(answers[i]) ? '' : answers[i]}
              onInput={(e) => set(i, e.currentTarget.value)}
            />
          )}
        </fieldset>
      ))}
      {active && (
        <button disabled={!done} onClick={submit}>
          Send answers
        </button>
      )}
    </div>
  )
}

function Preview({ url, base, threadId }: { url: string; base: string; threadId: string }) {
  const [tab, setTab] = useState<'live' | 'agent'>('live')
  const [shot, setShot] = useState(0)
  const [open, setOpen] = useState(true)
  useEvent((e) => e.type === 'browser' && e.threadId === threadId && setShot((n) => n + 1), [threadId])

  if (!open)
    return (
      <button class="preview-reopen ghost" onClick={() => setOpen(true)}>
        Preview
      </button>
    )
  return (
    <aside class="preview">
      <div class="preview-bar">
        <button class={`ghost ${tab === 'live' ? 'selected' : ''}`} onClick={() => setTab('live')}>
          Live
        </button>
        <button class={`ghost ${tab === 'agent' ? 'selected' : ''}`} onClick={() => setTab('agent')}>
          Agent view
        </button>
        <a href={url} target="_blank" rel="noreferrer" class="url">
          {url}
        </a>
        <button class="ghost" onClick={() => setOpen(false)} aria-label="Close preview">
          ✕
        </button>
      </div>
      {tab === 'live' ? <iframe key={url} src={url} /> : <img src={`/api${base}/screenshot?${shot}`} alt="What the agent sees" />}
    </aside>
  )
}
