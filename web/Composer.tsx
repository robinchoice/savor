import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { ArrowUp, AtSign, Bookmark, ChevronDown, FileText, FolderGit2, GitBranch, ListPlus, MessageSquare, Mic, Plus, Split, Square, Trash2, Workflow as WorkflowIcon, X, Zap, Crosshair } from 'lucide-preact'
import { api, agentSummary, cap, PROVIDER_NAMES, readFileAsDataUrl, useAgents, useApi, type AgentConfig, type Attachment, type Doc, type Project, type ProviderInfo, type Preset, type Skill, type Workflow } from './api'
import { ProviderIcon } from './Conversations'
import { record, type Recording } from './voice'
import { UsageLeft, useUsage } from './Usage'
import { reviewMessage, type ReviewComment } from './Changes'
import { fanoutBranches } from '../shared/fanout'

export interface Picked { selector: string; text: string; html: string; styles: Record<string, string>; url: string }

interface Props {
  project: Project
  agent: AgentConfig
  setAgent: (a: AgentConfig) => Promise<unknown> | void
  onSend: (text: string, attachments: Attachment[]) => Promise<void> | void
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
}

const MAX_FILES = 8

const pickedContext = (picked: Picked[]) =>
  picked
    .map(
      (p) =>
        `\n\n[Selected element in the preview]\nURL: ${p.url}\nSelector: ${p.selector}\nText: ${p.text}\nStyles: ${JSON.stringify(p.styles)}\nHTML: ${p.html}`,
    )
    .join('')

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
  const efforts = info?.models.find((m) => m.id === props.agent.model)?.efforts ?? info?.efforts ?? []

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
  const matches = slash === null ? [] : (skills ?? []).filter((s) => s.name.toLowerCase().includes(slash)).sort((a, b) => rank(a) - rank(b))
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
  const canSend = !!(text.trim() || files.length || review.length) && (!fanout || fanout.length > 1)
  const submit = async () => {
    if (!canSend) return
    const full = (text + pickedContext(props.picked ?? []) + reviewMessage(review)).trimStart()
    setText('')
    setFiles([])
    props.clearPicked?.(-1)
    try {
      await props.onSend(full, files.map(({ name, dataUrl }) => ({ name, dataUrl })))
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
      <button class={`send ${fanout ? 'wide' : ''}`} title={props.busy ? 'Queue (Enter): sent after the current turn' : fanout ? 'Start one conversation per agent' : 'Send'} disabled={!canSend} onClick={submit}>
        {props.busy ? <ListPlus size={16} /> : <ArrowUp size={16} />}
        {fanout && `Start ${fanout.length}`}
      </button>
    </>
  )

  return (
    <div class={`composer ${props.compact ? 'compact' : ''}`} ref={composerRef} onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), addFiles(e.dataTransfer?.files ?? [], true))}>
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
          {!skills && <div class="menu-label">Loading skills…</div>}
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
      <div class="composer-top">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={props.placeholder}
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
              submit()
            }
          }}
        />
        {props.compact ? (
          sendButtons
        ) : (
          <div class="menu-anchor">
            <button class="mention-btn" onClick={() => setPopover(popover === 'mention' ? null : 'mention')}>
              <AtSign size={13} /> Docs, workflows and files
            </button>
            {popover === 'mention' && <MentionMenu project={props.project} onPick={insert} />}
          </div>
        )}
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
          <button class="icon-btn" title="Attach files" onClick={() => fileRef.current?.click()}>
            <Plus size={18} />
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => (addFiles(e.currentTarget.files ?? []), (e.currentTarget.value = ''))} />
          {!fanout && (<div class="menu-anchor">
            <button class="agent-btn" onClick={() => setPopover(popover === 'agent' ? null : 'agent')}>
              <ProviderIcon provider={props.agent.provider} />
              <span>
                <b>{PROVIDER_NAMES[props.agent.provider] ?? props.agent.provider}</b>
                <small>{agentSummary(props.agent, info)}</small>
              </span>
              <ChevronDown size={14} />
            </button>
            {popover === 'agent' && <AgentMenu agent={props.agent} agents={agents ?? []} setAgent={setAgent} close={() => setPopover(null)} />}
          </div>)}
          {!fanout && efforts.length > 0 && (
            <div class="segmented quick-effort" aria-label="Reasoning effort">
              {efforts.map((effort) => (
                <button key={effort} type="button" class={props.agent.reasoning === effort ? 'selected' : ''} aria-pressed={props.agent.reasoning === effort} onClick={() => setAgent({ ...props.agent, reasoning: effort })}>
                  {cap(effort)}
                </button>
              ))}
            </div>
          )}
          {props.setFanout && (
            <button class={`branch-btn ${fanout ? 'on' : ''}`} title="Send the prompt to several agents, each in a new worktree, and compare the results" onClick={() => setFanout(fanout ? null : [props.agent])}>
              <Split size={14} /> Compare agents
            </button>
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

function AgentMenu({ agent, agents, setAgent, close }: { agent: AgentConfig; agents: ProviderInfo[]; setAgent: (a: AgentConfig) => void; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const place = () => {
      const menu = ref.current!
      const anchor = menu.parentElement!.getBoundingClientRect()
      menu.style.maxHeight = `${innerHeight - 24}px`
      menu.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - menu.offsetWidth - 12))}px`
      const below = innerHeight - anchor.bottom - 8
      const top = below >= menu.offsetHeight ? anchor.bottom + 8 : anchor.top - menu.offsetHeight - 8
      menu.style.top = `${Math.max(12, Math.min(top, innerHeight - menu.offsetHeight - 12))}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(ref.current!)
    addEventListener('resize', place)
    return () => { observer.disconnect(); removeEventListener('resize', place) }
  }, [])
  const info = agents.find((a) => a.id === agent.provider)
  const usage = useUsage().find((u) => u.provider === agent.provider)
  const [presets] = useApi<Preset[]>('/presets', (e) => e.type === 'presets')
  const [presetName, setPresetName] = useState('')
  const [error, setError] = useState('')
  const set = (patch: Partial<AgentConfig>) => setAgent({ ...agent, ...patch })
  const choose = (p: ProviderInfo) => set({ provider: p.id, model: '', reasoning: p.defaultEffort, fast: false, permissionMode: p.defaultMode })
  const efforts = info?.models.find((m) => m.id === agent.model)?.efforts ?? info?.efforts ?? []
  const savePreset = async () => {
    try {
      await api('POST', '/presets', { name: presetName, agent })
      setPresetName('')
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const status = (p: ProviderInfo) => (!p.installed ? 'not installed' : p.signedIn === false ? `sign in: ${p.signIn}` : p.account ?? p.version ?? '')

  return (
    <div class="menu agent-menu" ref={ref}>
      <div class="menu-label">Agent</div>
      {(agents.length ? agents : Object.entries(PROVIDER_NAMES).map(([id, name]) => ({ id, name }) as ProviderInfo)).map((p) => (
        <button key={p.id} class={agent.provider === p.id ? 'selected' : ''} onClick={() => (p.modes ? choose(p) : set({ provider: p.id, model: '' }))}>
          <ProviderIcon provider={p.id} />
          <span title={status(p)}>
            {p.name}
            {p.modes && <small class="status">{status(p)}</small>}
          </span>
        </button>
      ))}
      {usage && <UsageLeft usage={usage} />}
      <div class="menu-label">Model</div>
      {info?.models.length ? (
        <select value={agent.model} onChange={(e) => set({ model: e.currentTarget.value })}>
          {!info.models.some((m) => m.id === '') && <option value="">Default</option>}
          {!info.models.some((m) => m.id === agent.model) && agent.model && <option value={agent.model}>{agent.model}</option>}
          {info.models.map((m) => (
            <option key={m.id} value={m.id} title={m.detail}>
              {m.label}
            </option>
          ))}
        </select>
      ) : (
        <input placeholder="Default" value={agent.model} onInput={(e) => set({ model: e.currentTarget.value })} />
      )}
      {efforts.length ? (
        <>
          <div class="menu-label">Effort</div>
          <div class="segmented">
            {efforts.map((r) => (
              <button key={r} class={agent.reasoning === r ? 'selected' : ''} onClick={() => set({ reasoning: r })}>
                {cap(r)}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {info?.fast && (
        <label class="toggle-row">
          <Zap size={14} /> Fast mode
          <input type="checkbox" checked={agent.fast} onChange={(e) => set({ fast: e.currentTarget.checked })} />
        </label>
      )}
      {info?.modes.length ? (
        <>
          <div class="menu-label">Permissions</div>
          <select value={agent.permissionMode} onChange={(e) => set({ permissionMode: e.currentTarget.value })} title={info.modes.find((m) => m.id === agent.permissionMode)?.detail}>
            {info.modes.map((m) => (
              <option key={m.id} value={m.id} title={m.detail}>
                {m.label}
                {m.unsafe ? ' ⚠' : ''}
              </option>
            ))}
          </select>
          <small class="status pad">{info.modes.find((m) => m.id === agent.permissionMode)?.detail}</small>
        </>
      ) : null}
      <div class="menu-label">Presets</div>
      {presets?.map((p) => (
        <div class="preset-row" key={p.id}>
          <button class={JSON.stringify(p.agent) === JSON.stringify(agent) ? 'selected' : ''} onClick={() => setAgent(p.agent)}>
            <Bookmark size={14} />
            <span>
              {p.name}
              <small>
                {PROVIDER_NAMES[p.agent.provider] ?? p.agent.provider} · {agentSummary(p.agent, agents.find((a) => a.id === p.agent.provider))}
              </small>
            </span>
          </button>
          <button class="icon-btn" title="Remove preset" onClick={() => api('DELETE', `/presets/${p.id}`).catch((e: Error) => setError(e.message))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <form
        class="menu-form"
        onSubmit={(e) => {
          e.preventDefault()
          savePreset()
        }}
      >
        <input placeholder="Save as preset…" value={presetName} onInput={(e) => setPresetName(e.currentTarget.value)} />
        <button class="primary" disabled={!presetName.trim()}>
          Save
        </button>
      </form>
      {error && <div class="error-text pad">{error}</div>}
      <button class="primary done" onClick={close}>
        Done
      </button>
    </div>
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
