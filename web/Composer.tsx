import { useEffect, useRef, useState } from 'preact/hooks'
import { ArrowUp, AtSign, Bookmark, ChevronDown, FileText, FolderGit2, GitBranch, ListPlus, Plus, Square, Trash2, Workflow as WorkflowIcon, X, Zap, Crosshair } from 'lucide-preact'
import { api, agentSummary, cap, PROVIDER_NAMES, readFileAsDataUrl, useAgents, useApi, type AgentConfig, type Attachment, type Project, type ProviderInfo, type Preset, type Workflow } from './api'
import { ProviderIcon } from './Conversations'

export interface Picked { selector: string; text: string; html: string; styles: Record<string, string>; url: string }

interface Props {
  project: Project
  agent: AgentConfig
  setAgent: (a: AgentConfig) => Promise<unknown> | void
  onSend: (text: string, attachments: Attachment[]) => Promise<void> | void
  busy?: boolean
  onStop?: () => void
  placeholder: string
  draft?: string
  picked?: Picked[]
  clearPicked?: (i: number) => void // -1 clears all
  autoFocus?: boolean
  // Git runs in this conversation's worktree when it has one.
  threadId?: string
  // New conversations can ask for a worktree of a new branch.
  worktree?: string | null
  setWorktree?: (branch: string | null) => void
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
  const [text, setText] = useState('')
  const [files, setFiles] = useState<(Attachment & { image: boolean })[]>([])
  const [error, setError] = useState('')
  const [popover, setPopover] = useState<'mention' | 'agent' | 'branch' | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const agents = useAgents()
  const info = agents?.find((a) => a.id === props.agent.provider)

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

  const canSend = !!(text.trim() || files.length)
  const submit = async () => {
    if (!canSend) return
    const full = text + pickedContext(props.picked ?? [])
    setText('')
    setFiles([])
    props.clearPicked?.(-1)
    try {
      await props.onSend(full, files.map(({ name, dataUrl }) => ({ name, dataUrl })))
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

  return (
    <div class="composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), addFiles(e.dataTransfer?.files ?? [], true))}>
      {(files.length > 0 || (props.picked?.length ?? 0) > 0) && (
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
            const pasted = [...(e.clipboardData?.files ?? [])]
            if (pasted.length) {
              e.preventDefault()
              addFiles(pasted)
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
        <button class="icon-btn" title="Attach files" onClick={() => fileRef.current?.click()}>
          <Plus size={18} />
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => (addFiles(e.currentTarget.files ?? []), (e.currentTarget.value = ''))} />
        <div class="menu-anchor">
          <button class="agent-btn" onClick={() => setPopover(popover === 'agent' ? null : 'agent')}>
            <ProviderIcon provider={props.agent.provider} />
            <span>
              <b>{PROVIDER_NAMES[props.agent.provider] ?? props.agent.provider}</b>
              <small>{agentSummary(props.agent, info)}</small>
            </span>
            <ChevronDown size={14} />
          </button>
          {popover === 'agent' && <AgentMenu agent={props.agent} agents={agents ?? []} setAgent={setAgent} close={() => setPopover(null)} />}
        </div>
        <BranchPicker project={props.project} threadId={props.threadId} worktree={props.worktree} setWorktree={props.setWorktree} open={popover === 'branch'} toggle={() => setPopover(popover === 'branch' ? null : 'branch')} />
        <div class="spacer" />
        {props.busy && props.onStop && (
          <button class="send stop" title="Stop" onClick={props.onStop}>
            <Square size={13} />
          </button>
        )}
        <button class="send" title={props.busy ? 'Queue (Enter): sent after the current turn' : 'Send'} disabled={!canSend} onClick={submit}>
          {props.busy ? <ListPlus size={16} /> : <ArrowUp size={16} />}
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

function AgentMenu({ agent, agents, setAgent, close }: { agent: AgentConfig; agents: ProviderInfo[]; setAgent: (a: AgentConfig) => void; close: () => void }) {
  const info = agents.find((a) => a.id === agent.provider)
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
    <div class="menu up agent-menu">
      <div class="menu-label">Agent</div>
      {(agents.length ? agents : Object.entries(PROVIDER_NAMES).map(([id, name]) => ({ id, name }) as ProviderInfo)).map((p) => (
        <button key={p.id} class={agent.provider === p.id ? 'selected' : ''} onClick={() => (p.modes ? choose(p) : set({ provider: p.id, model: '' }))}>
          <ProviderIcon provider={p.id} />
          <span>
            {p.name}
            {p.modes && <small class="status">{status(p)}</small>}
          </span>
        </button>
      ))}
      <div class="menu-label">Model</div>
      {info?.models.length ? (
        <select value={agent.model} onChange={(e) => set({ model: e.currentTarget.value })}>
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
