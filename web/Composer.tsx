import { useEffect, useRef, useState } from 'preact/hooks'
import { ArrowUp, AtSign, ChevronDown, FileText, GitBranch, Plus, Square, Workflow as WorkflowIcon, X, Zap, Crosshair } from 'lucide-preact'
import { api, agentSummary, cap, PROVIDERS, readFileAsDataUrl, type AgentConfig, type Project, type Workflow } from './api'
import { ProviderIcon } from './Conversations'

export interface Picked { selector: string; text: string; html: string; styles: Record<string, string>; url: string }

interface Props {
  project: Project
  agent: AgentConfig
  setAgent: (a: AgentConfig) => Promise<unknown> | void
  onSend: (text: string, images: string[]) => Promise<void> | void
  busy?: boolean
  onStop?: () => void
  placeholder: string
  draft?: string
  picked?: Picked[]
  clearPicked?: (i: number) => void // -1 clears all
  autoFocus?: boolean
}

const pickedContext = (picked: Picked[]) =>
  picked
    .map(
      (p) =>
        `\n\n[Selected element in the preview]\nURL: ${p.url}\nSelector: ${p.selector}\nText: ${p.text}\nStyles: ${JSON.stringify(p.styles)}\nHTML: ${p.html}`,
    )
    .join('')

export function Composer(props: Props) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [error, setError] = useState('')
  const [popover, setPopover] = useState<'mention' | 'agent' | 'branch' | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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

  const canSend = !!(text.trim() || images.length)
  const submit = async () => {
    if (!canSend) return
    const full = text + pickedContext(props.picked ?? [])
    setText('')
    setImages([])
    props.clearPicked?.(-1)
    try {
      await props.onSend(full, images)
      setError('')
    } catch (e) {
      // Give the input back when the server refuses it, e.g. a setting a paired device may not choose.
      setText(text)
      setImages(images)
      setError((e as Error).message)
    }
  }
  const setAgent = (a: AgentConfig) => Promise.resolve(props.setAgent(a)).then(() => setError(''), (e: Error) => setError(e.message))
  const addFiles = async (files: FileList | File[]) => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'))
    const urls = await Promise.all(imgs.map(readFileAsDataUrl))
    setImages((prev) => [...prev, ...urls])
  }
  const insert = (s: string) => {
    setText((t) => (t && !t.endsWith(' ') ? t + ' ' : t) + s + ' ')
    setPopover(null)
    ref.current?.focus()
  }

  return (
    <div class="composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), addFiles(e.dataTransfer?.files ?? []))}>
      {(images.length > 0 || (props.picked?.length ?? 0) > 0) && (
        <div class="attachments">
          {images.map((src, i) => (
            <span key={i} class="thumb">
              <img src={src} alt="" />
              <button onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="Remove">
                <X size={12} />
              </button>
            </span>
          ))}
          {props.picked?.map((p, i) => (
            <span key={i} class="chip-ctx" title={p.html}>
              <Crosshair size={13} /> {p.selector.split(' > ').slice(-1)[0]}
              <button onClick={() => props.clearPicked?.(i)} aria-label="Remove">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <div class="error-text pad">{error}</div>}
      <div class="composer-top">
        <textarea
          ref={ref}
          rows={1}
          autoFocus={props.autoFocus}
          value={text}
          placeholder={props.placeholder}
          onInput={(e) => setText(e.currentTarget.value)}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files ?? [])]
            if (files.length) {
              e.preventDefault()
              addFiles(files)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div class="menu-anchor">
          <button class="mention-btn" onClick={() => setPopover(popover === 'mention' ? null : 'mention')}>
            <AtSign size={13} /> Files and workflows
          </button>
          {popover === 'mention' && <MentionMenu project={props.project} onPick={insert} />}
        </div>
      </div>
      <div class="composer-bottom">
        <button class="icon-btn" title="Attach images" onClick={() => fileRef.current?.click()}>
          <Plus size={18} />
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.currentTarget.files ?? [])} />
        <div class="menu-anchor">
          <button class="agent-btn" onClick={() => setPopover(popover === 'agent' ? null : 'agent')}>
            <ProviderIcon provider={props.agent.provider} />
            <span>
              <b>{PROVIDERS[props.agent.provider]?.name ?? props.agent.provider}</b>
              <small>{agentSummary(props.agent)}</small>
            </span>
            <ChevronDown size={14} />
          </button>
          {popover === 'agent' && <AgentMenu agent={props.agent} setAgent={setAgent} close={() => setPopover(null)} />}
        </div>
        <BranchPicker project={props.project} open={popover === 'branch'} toggle={() => setPopover(popover === 'branch' ? null : 'branch')} />
        <div class="spacer" />
        {props.busy && props.onStop && (
          <button class="send stop" title="Stop" onClick={props.onStop}>
            <Square size={13} />
          </button>
        )}
        <button class="send" title="Send" disabled={!canSend} onClick={submit}>
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  )
}

function MentionMenu({ project, onPick }: { project: Project; onPick: (s: string) => void }) {
  const [q, setQ] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  useEffect(() => void api<Workflow[]>('GET', `/projects/${project.id}/workflows`).then(setWorkflows), [])
  useEffect(() => {
    const t = setTimeout(() => api<string[]>('GET', `/projects/${project.id}/files/search?q=${encodeURIComponent(q)}`).then(setFiles), 120)
    return () => clearTimeout(t)
  }, [q])
  const wfs = workflows.filter((w) => w.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <div class="menu up mention">
      <input autoFocus placeholder="Search files and workflows…" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
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

const PERMISSION_MODES = [
  ['acceptEdits', 'Ask before commands'],
  ['auto', 'Auto'],
  ['manual', 'Ask for everything'],
  ['plan', 'Plan only'],
  ['bypassPermissions', 'Full access'],
]

function AgentMenu({ agent, setAgent, close }: { agent: AgentConfig; setAgent: (a: AgentConfig) => void; close: () => void }) {
  const info = PROVIDERS[agent.provider]
  const set = (patch: Partial<AgentConfig>) => setAgent({ ...agent, ...patch })
  return (
    <div class="menu up agent-menu">
      <div class="menu-label">Agent</div>
      {Object.entries(PROVIDERS).map(([id, p]) => (
        <button key={id} class={agent.provider === id ? 'selected' : ''} onClick={() => set({ provider: id, model: '', reasoning: p.reasoning.includes(agent.reasoning) ? agent.reasoning : p.reasoning.at(-2) ?? '' })}>
          <ProviderIcon provider={id} /> {p.name}
        </button>
      ))}
      <div class="menu-label">Model</div>
      <input list="savor-models" placeholder="Default" value={agent.model} onInput={(e) => set({ model: e.currentTarget.value })} />
      <datalist id="savor-models">
        {info?.models.filter(Boolean).map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {info?.reasoning.length ? (
        <>
          <div class="menu-label">Reasoning</div>
          <div class="segmented">
            {info.reasoning.map((r) => (
              <button key={r} class={agent.reasoning === r ? 'selected' : ''} onClick={() => set({ reasoning: r })}>
                {cap(r)}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {agent.provider === 'claude' && (
        <label class="toggle-row">
          <Zap size={14} /> Fast mode
          <input type="checkbox" checked={agent.fast} onChange={(e) => set({ fast: e.currentTarget.checked })} />
        </label>
      )}
      <div class="menu-label">Permissions</div>
      <select value={agent.permissionMode} onChange={(e) => set({ permissionMode: e.currentTarget.value })}>
        {PERMISSION_MODES.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <button class="primary done" onClick={close}>
        Done
      </button>
    </div>
  )
}

function BranchPicker({ project, open, toggle }: { project: Project; open: boolean; toggle: () => void }) {
  const [git, setGit] = useState<{ branch: string | null; branches: string[] }>({ branch: null, branches: [] })
  const [error, setError] = useState('')
  const load = () => api('GET', `/projects/${project.id}/git`).then(setGit)
  useEffect(() => void load(), [project.id, open])
  if (!git.branch) return null
  const change = async (branch: string) => {
    try {
      await api('POST', `/projects/${project.id}/git/switch`, { branch })
      setError('')
      toggle()
      load()
    } catch (e) {
      setError((e as Error).message)
    }
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
          {error && <div class="error-text">{error}</div>}
        </div>
      )}
    </div>
  )
}
