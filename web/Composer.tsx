import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { ArrowUp, AtSign, CornerDownRight, Bookmark, Check, ChevronDown, FileText, FolderGit2, GitBranch, ListPlus, MessageSquare, Mic, Paperclip, Plus, ShieldAlert, Split, Square, Workflow as WorkflowIcon, X, Zap, Crosshair } from 'lucide-preact'
import { api, agentSummary, describeModel, effortLabel, modelName, PROVIDER_NAMES, readFileAsDataUrl, useAgents, useApi, type AgentConfig, type Attachment, type Doc, type Project, type ProviderInfo, type Preset, type Skill, type Workflow } from './api'
import { ProviderIcon } from './Conversations'
import { record, type Recording } from './voice'
import { useUsage } from './Usage'
import { reviewMessage, type ReviewComment } from './Changes'
import { fanoutBranches } from '../shared/fanout'

export interface Picked { selector: string; text: string; html: string; styles: Record<string, string>; url: string }

interface Props {
  project: Project
  agent: AgentConfig
  setAgent: (a: AgentConfig) => Promise<unknown> | void
  onSend: (text: string, attachments: Attachment[]) => Promise<void> | void
  // While the agent works: send into its running turn instead of queueing.
  onSteer?: (text: string, attachments: Attachment[]) => Promise<void>
  busy?: boolean
  // Set while there is an agent to stop: in a turn, or with background work between turns.
  onStop?: () => void
  placeholder: string
  draft?: string
  picked?: Picked[]
  clearPicked?: (i: number) => void // -1 clears all
  // Line comments from the changes view go along with the next message.
  review?: ReviewComment[]
  setReview?: (comments: ReviewComment[]) => void
  autoFocus?: boolean
  // Git runs in this conversation's worktree when it has one.
  threadId?: string
  // New conversations can ask for a worktree of a new branch.
  worktree?: string | null
  setWorktree?: (branch: string | null) => void
  // New conversations can send the prompt to several agents at once, each in a new worktree.
  fanout?: AgentConfig[] | null
  setFanout?: (agents: AgentConfig[] | null) => void
  // Beside the preview with the chat out of sight: just the text, what was picked, and send.
  compact?: boolean
  // Open questions in the conversation: the text goes along with the answers as a comment. A comment
  // can also be sent before every question is picked; the rest then count as not answered.
  answering?: { picked: number; total: number; send: (comment: string, attachments: Attachment[]) => Promise<unknown> }
}

const MAX_FILES = 8

const pickedContext = (picked: Picked[]) =>
  picked
    .map(
      (p) =>
        `\n\n[Selected element in the preview]\nURL: ${p.url}\nSelector: ${p.selector}\nText: ${p.text}\nStyles: ${JSON.stringify(p.styles)}\nHTML: ${p.html}`,
    )
    .join('')

// Text quoted from the context menu goes to the composer on screen, or waits until one shows.
let quoteInto: ((text: string) => void) | null = null
let queuedQuote: string | null = null
export function quoteInComposer(text: string, show: () => void) {
  if (quoteInto) return quoteInto(text)
  queuedQuote = text
  show()
}

export function Composer(props: Props) {
  // What was typed but not sent stays with its conversation.
  const draftKey = `savor-draft:${props.threadId ?? `new:${props.project.id}`}`
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? '')
  // Saved in the same tick as the keystroke: leaving the conversation right away must not lose it.
  useLayoutEffect(() => (text ? localStorage.setItem(draftKey, text) : localStorage.removeItem(draftKey)), [text])
  const [files, setFiles] = useState<(Attachment & { image: boolean })[]>([])
  const [error, setError] = useState('')
  // 'fan-add' adds an agent to a fan-out, `fan-<i>` changes its i-th agent.
  const [popover, setPopover] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const agents = useAgents()
  const info = agents?.find((a) => a.id === props.agent.provider)

  // The skills of the chosen agent are fetched up front, so "/" opens the list right away.
  const [skills, setSkills] = useState<Skill[]>()
  const [slashOpen, setSlashOpen] = useState(false)
  const [chosen, setChosen] = useState(0)
  useEffect(() => {
    let current = true
    setSkills(undefined)
    api<Skill[]>('GET', `/projects/${props.project.id}/skills?provider=${props.agent.provider}`).then((s) => current && setSkills(s))
    return () => void (current = false)
  }, [props.project.id, props.agent.provider])
  // Agents read a slash command only as the first word of a message: the list is open while that word is typed.
  const slash = slashOpen && !popover && /^\/\S*$/.test(text) ? text.slice(1).toLowerCase() : null
  const rank = (s: Skill) => (s.name.toLowerCase().startsWith(slash!) ? 0 : 1)
  // /btw asks about a conversation, so a new one doesn't offer it.
  const matches = slash === null ? [] : (skills ?? []).filter((s) => s.name.toLowerCase().includes(slash) && (props.threadId || s.name !== 'btw')).sort((a, b) => rank(a) - rank(b))
  const pickSkill = (s: Skill) => {
    setText(`/${s.name} `)
    ref.current?.focus()
  }

  // A layout effect, so Escape works from the first frame the popover shows.
  useLayoutEffect(() => {
    if (!popover) return
    const outside = (e: PointerEvent) => {
      if (!composerRef.current?.contains(e.target as Node)) setPopover(null)
    }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopover(null) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [popover])

  // Ready to type on arrival, except on touch screens where the keyboard would cover the conversation.
  useEffect(() => {
    if (props.autoFocus && matchMedia('(pointer: fine)').matches) ref.current?.focus()
  }, [])
  useEffect(() => {
    const into = (quote: string) => {
      setText((t) => (t.trim() ? `${t.trimEnd()}\n\n` : '') + quote.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n')
      // The caret goes below the quote once it is rendered.
      requestAnimationFrame(() => {
        const el = ref.current!
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
        el.scrollTop = el.scrollHeight
      })
    }
    quoteInto = into
    if (queuedQuote) into(queuedQuote)
    queuedQuote = null
    return () => void (quoteInto === into && (quoteInto = null))
  }, [])
  useEffect(() => {
    if (props.draft !== undefined) {
      setText(props.draft)
      ref.current?.focus()
    }
  }, [props.draft])
  useEffect(() => {
    const el = ref.current!
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 320) + 'px'
  }, [text])

  const review = props.review ?? []
  const fanout = props.fanout
  const setFanout = props.setFanout!
  const answers = props.answering
  const hasInput = !!(text.trim() || files.length || review.length)
  const allPicked = !!answers && answers.picked === answers.total
  const canSend = answers ? allPicked || hasInput : hasInput && (!fanout || fanout.length > 1)
  // A side question (/btw) is answered next to the conversation, also while the agent works, and stays out of it.
  const [aside, setAside] = useState<{ question: string; answer?: string; error?: string } | null>(null)
  const ask = (question: string) => {
    setText('')
    setAside({ question })
    const settle = (r: { answer?: string; error?: string }) => setAside((a) => (a?.question === question ? { question, ...r } : a))
    api<{ text: string }>('POST', `/projects/${props.project.id}/threads/${props.threadId}/btw`, { text: question }).then(
      (r) => settle({ answer: r.text }),
      (e: Error) => settle({ error: e.message }),
    )
  }
  const submit = async (steer = false) => {
    if (!canSend) return
    const btw = props.threadId && !answers && text.match(/^\/btw\s+(\S[\s\S]*)$/)?.[1].trim()
    if (btw) return ask(btw)
    const full = (text + pickedContext(props.picked ?? []) + reviewMessage(review)).trimStart()
    setText('')
    setFiles([])
    props.clearPicked?.(-1)
    try {
      const attachments = files.map(({ name, dataUrl }) => ({ name, dataUrl }))
      await (answers ? answers.send(full, attachments) : steer && props.onSteer ? props.onSteer(full, attachments) : props.onSend(full, attachments))
      // Kept until the message is accepted, so a refused one doesn't lose them.
      if (review.length) props.setReview?.([])
      setError('')
    } catch (e) {
      // Give the input back when the server refuses it, e.g. a setting a paired device may not choose.
      setText(text)
      setFiles(files)
      setError((e as Error).message)
    }
  }
  const setAgent = (a: AgentConfig) => Promise.resolve(props.setAgent(a)).then(() => setError(''), (e: Error) => setError(e.message))
  // Dropped files also get their name in the text, so the agent knows which attachment is meant.
  const addFiles = async (list: FileList | File[], mention = false) => {
    const picked = [...list].slice(0, MAX_FILES - files.length)
    if (picked.length < list.length) setError(`Attach up to ${MAX_FILES} files per message.`)
    const added = await Promise.all(picked.map(async (f) => ({ name: f.name, dataUrl: await readFileAsDataUrl(f), image: f.type.startsWith('image/') })))
    setFiles((prev) => [...prev, ...added])
    if (mention) setText((t) => (t && !/\s$/.test(t) ? t + ' ' : t) + added.map((f) => `[${f.name}]`).join(' ') + ' ')
  }
  const insert = (s: string) => {
    setText((t) => (t && !t.endsWith(' ') ? t + ' ' : t) + s + ' ')
    setPopover(null)
    ref.current?.focus()
  }

  const sendButtons = (
    <>
      {props.onStop && (
        <button class="send stop" title="Stop" onClick={props.onStop}>
          <Square size={13} />
        </button>
      )}
      {answers ? (
        <button class="send wide" title={allPicked ? 'Send your answers and the comment' : canSend ? 'Send the comment; open questions stay unanswered' : 'Pick an answer for each question or write a comment'} disabled={!canSend} onClick={() => submit()}>
          {allPicked || !hasInput ? 'Send answers' : 'Send comment'} <ArrowUp size={16} />
        </button>
      ) : (
        <>
          {props.busy && props.onSteer && (
            <button class="send" title="Add to this turn (Ctrl+Enter): the agent reads it at its next step" disabled={!canSend} onClick={() => submit(true)}>
              <CornerDownRight size={16} />
            </button>
          )}
          <button class={`send ${fanout ? 'wide' : ''}`} title={props.busy ? 'Queue (Enter): sent after the current turn' : fanout ? 'Start one conversation per agent' : 'Send'} disabled={!canSend} onClick={() => submit()}>
            {props.busy ? <ListPlus size={16} /> : <ArrowUp size={16} />}
            {fanout && `Start ${fanout.length}`}
          </button>
        </>
      )}
    </>
  )

  return (
    <div class={`composer ${props.compact ? 'compact' : ''} ${props.answering ? 'answering' : ''}`} ref={composerRef} onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), addFiles(e.dataTransfer?.files ?? [], true))}>
      {(files.length > 0 || (props.picked?.length ?? 0) > 0 || review.length > 0) && (
        <div class="attachments">
          {files.map((f, i) =>
            f.image ? (
              <span key={i} class="thumb" title={f.name}>
                <img src={f.dataUrl} alt="" />
                <button onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label="Remove">
                  <X size={12} />
                </button>
              </span>
            ) : (
              <span key={i} class="chip-ctx" title={f.name}>
                <FileText size={13} /> {f.name}
                <button onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label="Remove">
                  <X size={12} />
                </button>
              </span>
            ),
          )}
          {props.picked?.map((p, i) => (
            <span key={i} class="chip-ctx" title={p.html}>
              <Crosshair size={13} /> {p.selector.split(' > ').slice(-1)[0]}
              <button onClick={() => props.clearPicked?.(i)} aria-label="Remove">
                <X size={12} />
              </button>
            </span>
          ))}
          {review.map((c) => (
            <span key={c.id} class="chip-ctx" title={c.text}>
              <MessageSquare size={13} /> {c.path.split('/').pop()}:{c.lines.replace(' (removed)', '')}
              <button onClick={() => props.setReview?.(review.filter((x) => x.id !== c.id))} aria-label="Remove">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <div class="error-text pad">{error}</div>}
      {slash !== null && (!skills || matches.length > 0) && (
        <div class="menu up slash">
          {!skills && <div class="menu-label">Loading commands…</div>}
          {matches.map((s, i) => (
            <button
              key={s.name}
              class={i === chosen ? 'selected' : ''}
              title={s.description}
              ref={(el) => {
                if (i === chosen) el?.scrollIntoView({ block: 'nearest' })
              }}
              // The textarea keeps the focus.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickSkill(s)}
            >
              <b>/{s.name}</b>
              <small>{s.description}</small>
            </button>
          ))}
        </div>
      )}
      {aside && (
        <div class="aside">
          <div class="aside-head">
            <b>/btw</b> <span>{aside.question}</span>
            <button class="icon-btn" aria-label="Close" onClick={() => setAside(null)}>
              <X size={13} />
            </button>
          </div>
          {aside.error ? <div class="error-text">{aside.error}</div> : <div class="aside-answer">{aside.answer ?? 'Thinking…'}</div>}
        </div>
      )}
      {props.answering && (
        <div class="answering-row">
          Answering {props.answering.total === 1 ? 'the question' : `${props.answering.total} questions`}{' '}
          <span>
            · {props.answering.picked}/{props.answering.total} picked
          </span>
        </div>
      )}
      <div class="composer-top">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={props.answering ? 'Add a comment (optional)…' : props.placeholder}
          onInput={(e) => {
            setText(e.currentTarget.value)
            setSlashOpen(true)
            setChosen(0)
          }}
          onBlur={() => setSlashOpen(false)}
          onPaste={(e) => {
            const pasted = [...(e.clipboardData?.files ?? [])]
            if (pasted.length) {
              e.preventDefault()
              addFiles(pasted)
            }
          }}
          onKeyDown={(e) => {
            if (e.isComposing) return
            const pick = matches[chosen]
            if (pick && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              setChosen((chosen + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
            } else if (pick && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && text !== `/${pick.name}`))) {
              // Enter completes the name; once it is written out, Enter sends.
              e.preventDefault()
              pickSkill(pick)
            } else if (slash !== null && e.key === 'Escape') {
              setSlashOpen(false)
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit(e.ctrlKey || e.metaKey)
            }
          }}
        />
        {props.compact && sendButtons}
      </div>
      {fanout && (
        <div class="fan-row">
          <div class="fan-label">
            <Split size={13} />
            {fanout.length > 1 ? (
              <span>
                Same prompt, one new worktree each: <span class="mono">{fanoutBranches(text, fanout).join(', ')}</span>
              </span>
            ) : (
              'Add a second agent to compare.'
            )}
          </div>
          {fanout.map((a, i) => (
            <div class="menu-anchor" key={i}>
              <span class="fan-chip">
                <button title="Change agent, model and effort" onClick={() => setPopover(popover === `fan-${i}` ? null : `fan-${i}`)}>
                  <ProviderIcon provider={a.provider} size={15} /> {PROVIDER_NAMES[a.provider] ?? a.provider} <small>{agentSummary(a, agents?.find((x) => x.id === a.provider))}</small>
                </button>
                {fanout.length > 1 && (
                  <button class="icon-btn" title="Remove" onClick={() => setFanout(fanout.filter((_, j) => j !== i))}>
                    <X size={13} />
                  </button>
                )}
              </span>
              {popover === `fan-${i}` && <AgentMenu agent={a} agents={agents ?? []} setAgent={(next) => setFanout(fanout.map((x, j) => (j === i ? next : x)))} close={() => setPopover(null)} />}
            </div>
          ))}
          <div class="menu-anchor">
            <button class="branch-btn" onClick={() => setPopover(popover === 'fan-add' ? null : 'fan-add')}>
              <Plus size={14} /> Add agent
            </button>
            {popover === 'fan-add' && (
              <AddAgentMenu
                agents={agents ?? []}
                onPick={(a) => {
                  setFanout([...fanout, a])
                  setPopover(null)
                }}
              />
            )}
          </div>
        </div>
      )}
      {!props.compact && (
        <div class="composer-bottom">
          <div class="menu-anchor">
            <button class={`icon-btn ${popover === 'plus' ? 'on' : ''}`} title="Attach, mention or compare agents" onClick={() => setPopover(popover === 'plus' ? null : 'plus')}>
              <Plus size={18} />
            </button>
            {popover === 'plus' && (
              <div class="menu up plus-menu">
                <button onClick={() => (setPopover(null), fileRef.current?.click())}>
                  <Paperclip size={15} /> <span>Attach files</span>
                </button>
                <button onClick={() => setPopover('mention')}>
                  <AtSign size={15} />
                  <span>
                    Mention
                    <small>Documents, workflows and files</small>
                  </span>
                </button>
                {props.setFanout && (
                  <button class={fanout ? 'selected' : ''} onClick={() => (setFanout(fanout ? null : [props.agent]), setPopover(null))}>
                    <Split size={15} />
                    <span>
                      Compare agents
                      <small>The same prompt, one new worktree each</small>
                    </span>
                    {fanout && <Check size={15} />}
                  </button>
                )}
              </div>
            )}
            {popover === 'mention' && <MentionMenu project={props.project} onPick={insert} />}
          </div>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => (addFiles(e.currentTarget.files ?? []), (e.currentTarget.value = ''))} />
          {!fanout && (
            <div class="menu-anchor">
              <AgentButton agent={props.agent} info={info} open={popover === 'agent'} toggle={() => setPopover(popover === 'agent' ? null : 'agent')} />
              {popover === 'agent' && <AgentMenu agent={props.agent} agents={agents ?? []} setAgent={setAgent} close={() => setPopover(null)} />}
            </div>
          )}
          {!fanout && <BranchPicker project={props.project} threadId={props.threadId} worktree={props.worktree} setWorktree={props.setWorktree} open={popover === 'branch'} toggle={() => setPopover(popover === 'branch' ? null : 'branch')} />}
          <div class="spacer" />
          <VoiceButton onText={insert} onError={setError} />
          {sendButtons}
        </div>
      )}
    </div>
  )
}

function VoiceButton({ onText, onError }: { onText: (s: string) => void; onError: (e: string) => void }) {
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle')
  const [seconds, setSeconds] = useState(0)
  const rec = useRef<Recording | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
    rec.current?.cancel()
  }, [])
  useEffect(() => {
    if (state !== 'recording') return
    setSeconds(0)
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [state])

  const start = async () => {
    setState('starting')
    try {
      const recording = await record()
      if (!mounted.current) {
        recording.cancel()
        return
      }
      rec.current = recording
      onError('')
      setState('recording')
    } catch (e) {
      if (!mounted.current) return
      onError((e as Error).message)
      setState('idle')
    }
  }
  const stop = async () => {
    setState('transcribing')
    try {
      const text = await rec.current!.stop()
      if (text && mounted.current) onText(text)
    } catch (e) {
      if (mounted.current) onError((e as Error).message)
    }
    rec.current = null
    setState('idle')
  }
  const cancel = () => {
    rec.current?.cancel()
    rec.current = null
    setState('idle')
  }

  return (
    <span class="voice">
      {state === 'recording' && (
        <>
          <span class="voice-time">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </span>
          <button class="icon-btn" title="Discard the recording" onClick={cancel}>
            <X size={15} />
          </button>
        </>
      )}
      {state === 'transcribing' && <small>{rec.current?.downloading ? 'Downloading the speech model…' : 'Transcribing…'}</small>}
      <button class={`icon-btn${state === 'recording' ? ' recording' : ''}`} title={state === 'recording' ? 'Stop and insert the text' : 'Voice input'} disabled={state === 'starting' || state === 'transcribing'} onClick={state === 'recording' ? stop : start}>
        {state === 'transcribing' ? <span class="spinner small" /> : <Mic size={17} />}
      </button>
    </span>
  )
}

function MentionMenu({ project, onPick }: { project: Project; onPick: (s: string) => void }) {
  const [q, setQ] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [docs, setDocs] = useState<Doc[]>([])
  useEffect(() => void api<Workflow[]>('GET', `/projects/${project.id}/workflows`).then(setWorkflows), [])
  useEffect(() => void api<Doc[]>('GET', `/projects/${project.id}/docs`).then(setDocs), [])
  useEffect(() => {
    const t = setTimeout(() => api<string[]>('GET', `/projects/${project.id}/files/search?q=${encodeURIComponent(q)}`).then(setFiles), 120)
    return () => clearTimeout(t)
  }, [q])
  const wfs = workflows.filter((w) => w.name.toLowerCase().includes(q.toLowerCase()))
  const matching = docs.filter((d) => d.title.toLowerCase().includes(q.toLowerCase()))
  return (
    <div class="menu up mention">
      <input autoFocus placeholder="Search documents, workflows and files…" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      {matching.length > 0 && <div class="menu-label">Documents</div>}
      {matching.slice(0, 8).map((d) => (
        <button key={d.id} onClick={() => onPick(`@document:"${d.title}" (id ${d.id})`)}>
          <FileText size={14} /> {d.title}
        </button>
      ))}
      {wfs.length > 0 && <div class="menu-label">Workflows</div>}
      {wfs.map((w) => (
        <button key={w.id} onClick={() => onPick(`@workflow:"${w.name}" (id ${w.id})`)}>
          <WorkflowIcon size={14} /> {w.name}
        </button>
      ))}
      <div class="menu-label">Files</div>
      {files.slice(0, 12).map((f) => (
        <button key={f} onClick={() => onPick(`@${f}`)}>
          <FileText size={14} /> <span class="mono">{f}</span>
        </button>
      ))}
    </div>
  )
}

const EFFORT_DETAIL: Record<string, string> = {
  low: 'Quick answers with little thinking',
  medium: 'Balanced speed and depth',
  high: 'Thorough, for most changes',
  xhigh: 'Extra thinking for tricky changes',
  max: 'Longest thinking, uses the limits fastest',
  ultracode: 'X-High with Claude Code’s ultracode mode',
  ultra: 'The deepest reasoning Codex offers',
}

const effortsOf = (agent: AgentConfig, info?: ProviderInfo) => info?.models.find((m) => m.id === agent.model)?.efforts ?? info?.efforts ?? []

// Rising bars, filled up to the chosen effort.
function EffortMeter({ effort, efforts }: { effort: string; efforts: string[] }) {
  const n = efforts.indexOf(effort) + 1
  return (
    <span class="effort-meter" aria-hidden="true">
      {efforts.map((_, i) => (
        <i key={i} class={i < n ? 'on' : ''} style={{ height: `${4 + (i * 8) / Math.max(1, efforts.length - 1)}px` }} />
      ))}
    </span>
  )
}

function AgentButton({ agent, info, open, toggle }: { agent: AgentConfig; info?: ProviderInfo; open: boolean; toggle: () => void }) {
  const efforts = effortsOf(agent, info)
  const mode = info?.modes.find((m) => m.id === agent.permissionMode)
  return (
    <button class={`agent-btn ${open ? 'on' : ''}`} title={`${PROVIDER_NAMES[agent.provider] ?? agent.provider}: change the model, effort and permissions`} onClick={toggle}>
      <ProviderIcon provider={agent.provider} size={16} />
      <b>{modelName(agent, info)}</b>
      {efforts.includes(agent.reasoning) && (
        <span class="agent-effort">
          <EffortMeter effort={agent.reasoning} efforts={efforts} /> {effortLabel(agent.reasoning)}
        </span>
      )}
      {agent.fast && <Zap size={13} class="agent-fast" />}
      {mode?.unsafe && <ShieldAlert size={14} class="agent-unsafe" />}
      <ChevronDown size={14} class="chevron" />
    </button>
  )
}

// Agents on the left, the chosen agent's model, effort and permissions on the right. Changes apply right away.
function AgentMenu({ agent, agents, setAgent, close }: { agent: AgentConfig; agents: ProviderInfo[]; setAgent: (a: AgentConfig) => void; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // As wide as the composer above or below it. Narrow screens get a bottom sheet from the stylesheet.
    const place = () => {
      const menu = ref.current!
      if (matchMedia('(max-width: 600px)').matches) return menu.removeAttribute('style')
      const anchor = (menu.closest('.composer') ?? menu.parentElement!).getBoundingClientRect()
      const width = Math.min(680, anchor.width, innerWidth - 24)
      menu.style.width = `${width}px`
      menu.style.maxHeight = `${Math.min(560, innerHeight - 24)}px`
      menu.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - width - 12))}px`
      const top = anchor.top - menu.offsetHeight - 8 >= 12 ? anchor.top - menu.offsetHeight - 8 : anchor.bottom + 8
      menu.style.top = `${Math.max(12, Math.min(top, innerHeight - menu.offsetHeight - 12))}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(ref.current!)
    addEventListener('resize', place)
    return () => { observer.disconnect(); removeEventListener('resize', place) }
  }, [])
  const info = agents.find((a) => a.id === agent.provider)
  const usage = useUsage()
  const [presets] = useApi<Preset[]>('/presets', (e) => e.type === 'presets')
  const [presetName, setPresetName] = useState<string | null>(null)
  const [error, setError] = useState('')
  const set = (patch: Partial<AgentConfig>) => setAgent({ ...agent, ...patch })
  const choose = (p: ProviderInfo) => set({ provider: p.id, model: '', reasoning: p.defaultEffort, fast: false, permissionMode: p.defaultMode })
  const efforts = effortsOf(agent, info)
  const models = info?.models ?? []
  const listed = [...(models.some((m) => m.id === '') ? [] : [{ id: '', label: 'Default', detail: `${info?.name ?? 'The agent'}’s own default` }]), ...(agent.model && !models.some((m) => m.id === agent.model) ? [{ id: agent.model, label: agent.model }] : []), ...models]
  const savePreset = async () => {
    try {
      await api('POST', '/presets', { name: presetName, agent })
      setPresetName(null)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const status = (p: ProviderInfo) => (!p.installed ? 'Not installed' : p.signedIn === false ? `Sign in: ${p.signIn}` : p.account ?? p.version ?? '')
  // The weekly limit says the most about what is left, the others show in the tooltip.
  const limit = (id: string) => {
    const u = usage.find((u) => u.provider === id)
    const w = u?.windows.find((w) => w.label === 'Weekly') ?? u?.windows[0]
    return w && { left: Math.max(0, 100 - w.percent), label: w.label, all: u!.windows.map((w) => `${w.label}: ${Math.max(0, 100 - w.percent)}% left${w.resets ? `, resets ${w.resets}` : ''}`).join('\n') }
  }

  return (
    <>
      <div class="sheet-scrim" onClick={close} />
      <div class="menu agent-menu" ref={ref}>
        <div class="ap-rail">
          {(agents.length ? agents : Object.entries(PROVIDER_NAMES).map(([id, name]) => ({ id, name }) as ProviderInfo)).map((p) => {
            const l = limit(p.id)
            return (
              <button key={p.id} class={`ap-agent ${agent.provider === p.id ? 'selected' : ''} ${p.modes && (!p.installed || p.signedIn === false) ? 'off' : ''}`} title={l?.all ?? status(p)} onClick={() => agent.provider !== p.id && (p.modes ? choose(p) : set({ provider: p.id, model: '' }))}>
                <ProviderIcon provider={p.id} size={16} />
                <span>
                  {p.name}
                  {l ? <small>{l.left}% left · {l.label}</small> : p.modes && <small>{status(p)}</small>}
                  {l && (
                    <span class={`ap-limit ${l.left <= 10 ? 'low' : ''}`}>
                      <i style={{ width: `${l.left}%` }} />
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
        <div class="ap-pane">
          <div class="menu-label">Model</div>
          {models.length ? (
            <div class="ap-models">
              {listed.map((m) => {
                const { name, detail } = describeModel(m)
                return (
                  <button key={m.id} class={`ap-model ${agent.model === m.id ? 'selected' : ''}`} onClick={() => set({ model: m.id })}>
                    <b>
                      {m.id === '' ? 'Default' : name}
                      {m.id === '' && name !== m.label && <span class="ap-tag">{name}</span>}
                      {m.id.includes('[1m]') && <span class="ap-tag">1M context</span>}
                    </b>
                    {detail && <small>{detail}</small>}
                  </button>
                )
              })}
            </div>
          ) : (
            <input placeholder="Default" value={agent.model} onInput={(e) => set({ model: e.currentTarget.value })} />
          )}
          {efforts.length > 0 && (
            <>
              <div class="menu-label">
                Effort <span>{EFFORT_DETAIL[agent.reasoning]}</span>
              </div>
              <div class="ap-effort" role="radiogroup" aria-label="Reasoning effort">
                {efforts.map((e) => (
                  <button key={e} role="radio" aria-checked={agent.reasoning === e} class={agent.reasoning === e ? 'selected' : ''} title={EFFORT_DETAIL[e]} onClick={() => set({ reasoning: e })}>
                    {effortLabel(e)}
                  </button>
                ))}
              </div>
            </>
          )}
          {info?.fast && (
            <button class="ap-row" role="switch" aria-checked={agent.fast} onClick={() => set({ fast: !agent.fast })}>
              <Zap size={15} class="agent-fast" />
              <span>
                Fast mode
                <small>Faster output from the same model, uses the limits faster</small>
              </span>
              <span class={`switch ${agent.fast ? 'on' : ''}`}>
                <i />
              </span>
            </button>
          )}
          {info?.modes.length ? (
            <>
              <div class="menu-label">Permissions</div>
              <div role="radiogroup" aria-label="Permissions">
                {info.modes.map((m) => (
                  <button key={m.id} role="radio" aria-checked={agent.permissionMode === m.id} class={`ap-row ${agent.permissionMode === m.id ? 'selected' : ''} ${m.unsafe ? 'unsafe' : ''}`} onClick={() => set({ permissionMode: m.id })}>
                    <span class="ap-radio" />
                    <span>
                      {m.label}
                      <small>{m.detail}</small>
                    </span>
                    {m.unsafe && <ShieldAlert size={15} />}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <div class="ap-foot">
          {presets?.map((p) => (
            <span key={p.id} class={`ap-preset ${JSON.stringify(p.agent) === JSON.stringify(agent) ? 'selected' : ''}`}>
              <button title={`${PROVIDER_NAMES[p.agent.provider] ?? p.agent.provider} · ${agentSummary(p.agent, agents.find((a) => a.id === p.agent.provider))}`} onClick={() => setAgent(p.agent)}>
                <Bookmark size={13} /> {p.name}
              </button>
              <button class="ap-remove" title="Remove preset" onClick={() => api('DELETE', `/presets/${p.id}`).catch((e: Error) => setError(e.message))}>
                <X size={12} />
              </button>
            </span>
          ))}
          <span class="spacer" />
          {presetName === null ? (
            <button class="ap-preset ghost" onClick={() => setPresetName('')}>
              <Plus size={13} /> Save as preset
            </button>
          ) : (
            <form
              class="ap-save"
              onSubmit={(e) => {
                e.preventDefault()
                savePreset()
              }}
            >
              <input autoFocus placeholder="Preset name" value={presetName} onInput={(e) => setPresetName(e.currentTarget.value)} />
              <button class="primary small" disabled={!presetName.trim()}>
                Save
              </button>
            </form>
          )}
          {error && <div class="error-text">{error}</div>}
        </div>
      </div>
    </>
  )
}

// What a fan-out can add: a saved preset or an installed agent with its defaults.
function AddAgentMenu({ agents, onPick }: { agents: ProviderInfo[]; onPick: (a: AgentConfig) => void }) {
  const [presets] = useApi<Preset[]>('/presets', (e) => e.type === 'presets')
  return (
    <div class="menu up">
      {!!presets?.length && <div class="menu-label">Presets</div>}
      {presets?.map((p) => (
        <button key={p.id} onClick={() => onPick(p.agent)}>
          <Bookmark size={14} />
          <span>
            {p.name}
            <small>
              {PROVIDER_NAMES[p.agent.provider] ?? p.agent.provider} · {agentSummary(p.agent, agents.find((a) => a.id === p.agent.provider))}
            </small>
          </span>
        </button>
      ))}
      <div class="menu-label">Agents</div>
      {agents
        .filter((a) => a.installed)
        .map((p) => (
          <button key={p.id} onClick={() => onPick({ provider: p.id, model: '', reasoning: p.defaultEffort, fast: false, permissionMode: p.defaultMode })}>
            <ProviderIcon provider={p.id} /> {p.name}
          </button>
        ))}
    </div>
  )
}

function BranchPicker({ project, threadId, worktree, setWorktree, open, toggle }: { project: Project; threadId?: string; worktree?: string | null; setWorktree?: (b: string | null) => void; open: boolean; toggle: () => void }) {
  const [git, setGit] = useState<{ branch: string | null; branches: string[] }>({ branch: null, branches: [] })
  const [error, setError] = useState('')
  const load = () => api('GET', `/projects/${project.id}/git${threadId ? `?thread=${threadId}` : ''}`).then(setGit)
  useEffect(() => void load(), [project.id, threadId, open])
  if (!git.branch) return null
  if (worktree)
    return (
      <span class="branch-btn worktree" title="This conversation will work in its own git worktree of this branch">
        <FolderGit2 size={14} /> {worktree} <small>new worktree</small>
        <button class="icon-btn" title="Work in the project folder instead" onClick={() => setWorktree?.(null)}>
          <X size={13} />
        </button>
      </span>
    )
  const change = async (branch: string) => {
    try {
      await api('POST', `/projects/${project.id}/git/switch`, { branch, thread: threadId })
      setError('')
      toggle()
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const newWorktree = () => {
    const name = prompt('Branch name for the new worktree', '')?.trim()
    if (!name) return
    setWorktree?.(name)
    toggle()
  }
  return (
    <div class="menu-anchor">
      <button class="branch-btn" onClick={toggle}>
        <GitBranch size={14} /> {git.branch} <ChevronDown size={13} />
      </button>
      {open && (
        <div class="menu up">
          <div class="menu-label">Switch branch</div>
          {git.branches.map((b) => (
            <button key={b} class={b === git.branch ? 'selected' : ''} onClick={() => change(b)}>
              <GitBranch size={14} /> {b}
            </button>
          ))}
          {setWorktree && (
            <button onClick={newWorktree}>
              <FolderGit2 size={14} /> New worktree…
            </button>
          )}
          {error && <div class="error-text">{error}</div>}
        </div>
      )}
    </div>
  )
}
