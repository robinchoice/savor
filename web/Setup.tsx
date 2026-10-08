import { useState } from 'preact/hooks'
import { Archive, Code, Folder, GraduationCap, Plus } from 'lucide-preact'
import { api, describeModel, desktop, effortLabel, go, modelName, useAgents, type AgentConfig, type Me, type Project, type ProviderInfo } from './api'
import { ProviderIcon } from './Conversations'
import { effortsOf } from './Composer'
import { recipe } from './recipes'
import { TEMPLATES, type Template } from './templates'

// The mode a provider works best in for most people; the others still show.
const RECOMMENDED: Record<string, string> = { claude: 'auto', codex: 'auto-review', gemini: 'autoEdit' }
// Plan modes are chosen per conversation, not as a default.
const HIDDEN_MODES = ['plan', 'dontAsk']

export const agentStatus = (a: ProviderInfo) => (!a.installed ? 'Not installed' : a.signedIn ? 'Signed in' : a.signedIn === false ? 'Signed out' : 'Installed')

// One agent CLI on this computer, with what to run when it is not signed in.
export function AgentStatusRow({ agent: a }: { agent: ProviderInfo }) {
  return (
    <div class="setting agent-status">
      <ProviderIcon provider={a.id} size={16} />
      <span>
        <b>{a.name}</b>
        <small class="muted">
          {a.installed && a.signedIn === false ? (
            <>
              Sign in: <code>{a.signIn}</code>
            </>
          ) : (
            [a.version, a.account].filter(Boolean).join(' · ')
          )}
        </small>
      </span>
      <span class={a.signedIn ? 'ok' : a.signedIn === false ? 'warn' : 'muted'}>{agentStatus(a)}</span>
    </div>
  )
}

// How much the agent may do on its own, as cards that weigh control against speed.
export function ModeCards({ agent, info, onPick }: { agent: AgentConfig; info: ProviderInfo; onPick: (mode: string) => void }) {
  const modes = info.modes.filter((m) => !HIDDEN_MODES.includes(m.id))
  if (modes.length < 2) return null
  return (
    <div class="mode-cards" role="radiogroup" aria-label="Permissions">
      {modes.map((m) => (
        <button key={m.id} role="radio" aria-checked={agent.permissionMode === m.id} class={`mode-card ${agent.permissionMode === m.id ? 'selected' : ''}`} onClick={() => onPick(m.id)}>
          {RECOMMENDED[info.id] === m.id && <span class="ap-tag">Recommended</span>}
          {m.unsafe && <span class="ap-tag unsafe">Isolated machines only</span>}
          <b>{m.label}</b>
          <small>{m.detail}</small>
        </button>
      ))}
    </div>
  )
}

const TYPE_ICONS: Record<string, typeof Folder> = { 'academic-writing': GraduationCap, kontor: Archive }

// Start a new project or open a folder: in the Projects menu and in the last step of the setup.
export function AddProject({ me, setMe, onAdded }: { me: Me; setMe: (m: Me) => void; onAdded: () => void }) {
  const [step, setStep] = useState<'new' | 'open' | null>(null)
  const [template, setTemplate] = useState<Template>()
  const [name, setName] = useState('')
  const [dir, setDir] = useState(me.projectsDir)
  const [editDir, setEditDir] = useState(false)
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const add = async (body: { path: string; name?: string; create?: boolean }) => {
    try {
      const p = await api<Project>('POST', '/projects', body)
      if (body.create) setMe({ ...me, projectsDir: dir })
      // A project type brings its ROLE.md and workflows, and a first conversation that sets the project up.
      if (body.create && template) {
        await api('PATCH', `/projects/${p.id}`, { role: template.role, type: template.slug })
        for (const r of template.workflows.map((slug) => recipe(slug)!)) await api('POST', `/projects/${p.id}/workflows`, { name: r.title, prompt: r.prompt, collection: template.title, cron: r.schedule || null })
        const t = await api<{ id: string }>('POST', `/projects/${p.id}/threads`, { text: template.setup })
        onAdded()
        return go(`/p/${p.id}/t/${t.id}`)
      }
      onAdded()
      go(`/p/${p.id}${body.create ? '/new' : ''}`)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  // A new project's folder is its name in lower case, the words joined by hyphens.
  const folder = name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
  const create = (e: Event) => {
    e.preventDefault()
    if (folder) add({ path: `${dir.replace(/\/$/, '')}/${folder}`, name: name.trim(), create: true })
  }
  // The desktop app has the system's folder dialog; a browser asks for the path.
  const openFolder = async () => {
    if (!desktop) return setStep('open')
    const picked = await desktop.pickFolder()
    if (picked) add({ path: picked })
  }
  const changeDir = async () => {
    if (!desktop) return setEditDir(true)
    const picked = await desktop.pickFolder()
    if (picked) setDir(picked)
  }
  return (
    <>
      {step === 'new' ? (
        <form onSubmit={create}>
          <div class="project-types">
            {[undefined, ...TEMPLATES].map((t) => {
              const Icon = t ? (TYPE_ICONS[t.slug] ?? Folder) : Code
              return (
                <button type="button" key={t?.slug ?? ''} class={`project-type ${t === template ? 'active' : ''}`} onClick={() => setTemplate(t)}>
                  <Icon size={16} />
                  <b>{t?.title ?? 'Code'}</b>
                  <small>{t?.blurb ?? 'App, site or tool.'}</small>
                </button>
              )
            })}
          </div>
          {template && <small class="muted">{template.creates}</small>}
          <input autoFocus placeholder="Name of the new project" value={name} onInput={(e) => setName(e.currentTarget.value)} />
          {editDir ? (
            <input placeholder="Folder for new projects" value={dir} onInput={(e) => setDir(e.currentTarget.value)} />
          ) : (
            <small>
              Creates{' '}
              <b class="mono">
                {dir}/{folder || '…'}
              </b>{' '}
              ·{' '}
              <button type="button" class="link" onClick={changeDir}>
                Change folder
              </button>
            </small>
          )}
          <div class="row">
            <span class="spacer" />
            <button type="button" class="ghost" onClick={() => setStep(null)}>
              Cancel
            </button>
            <button class="primary" disabled={!folder || !dir.trim()}>
              Create project
            </button>
          </div>
        </form>
      ) : step === 'open' ? (
        <form class="menu-form" onSubmit={(e) => (e.preventDefault(), add({ path }))}>
          <input autoFocus placeholder="/path/to/project" value={path} onInput={(e) => setPath(e.currentTarget.value)} />
          <button class="primary" disabled={!path.trim()}>
            <Plus size={15} /> Add
          </button>
        </form>
      ) : (
        <>
          <button class="ghost wide" onClick={() => setStep('new')}>
            <Plus size={16} /> Start new project
          </button>
          <button class="ghost wide" onClick={openFolder}>
            <Folder size={16} /> Open any folder
          </button>
        </>
      )}
      {error && <div class="error-text">{error}</div>}
    </>
  )
}

const STEPS = ['Agents', 'Default agent', 'Permissions', 'First project']

// First start on this computer: finds the agents, then asks which one new projects start with, how much
// it may do alone, and where to begin. Skipping keeps Savor's defaults; This computer → Agents changes them later.
export function SetupWizard({ me, setMe }: { me: Me; setMe: (m: Me) => void }) {
  const agents = useAgents()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<AgentConfig | null>(null)
  const [error, setError] = useState('')
  const installed = agents?.filter((a) => a.installed) ?? []
  // Until something is picked: the first signed-in agent, in its recommended mode.
  const first = installed.find((a) => a.signedIn) ?? installed[0] ?? agents?.[0]
  const fresh = (a: ProviderInfo): AgentConfig => ({ provider: a.id, model: '', reasoning: a.defaultEffort, fast: false, permissionMode: RECOMMENDED[a.id] ?? a.defaultMode })
  const agent = draft ?? (first && fresh(first))
  const info = agents?.find((a) => a.id === agent?.provider)
  const set = (patch: Partial<AgentConfig>) => agent && setDraft({ ...agent, ...patch })
  const save = (body: Partial<AgentConfig>) =>
    api<AgentConfig>('PUT', '/agent', body).then(
      () => (setError(''), true),
      (e) => (setError((e as Error).message), false),
    )
  const skip = async () => (await save({})) && setMe({ ...me, setup: false })
  const next = async () => {
    if (step === 2 && !(agent && (await save(agent)))) return
    setStep(step + 1)
  }
  const efforts = agent ? effortsOf(agent, info) : []

  return (
    <div class="overlay">
      <div class="dialog setup-dialog">
        <div class="dialog-body">
          <div class="setup-steps">
            {STEPS.map((s, i) => (
              <i key={s} class={i <= step ? 'on' : ''} />
            ))}
          </div>
          <div class="setup-eyebrow">
            Step {step + 1} of {STEPS.length} · {STEPS[step]}
          </div>
          {step === 0 && (
            <>
              <h2>Welcome to Savor</h2>
              <p class="muted">Savor runs the coding agents already on this computer. This is what it found:</p>
              {!agents && <p class="muted">Looking for agents…</p>}
              <div class="setup-list">
                {[...installed, ...(agents ?? []).filter((a) => !a.installed)].map((a) => (
                  <AgentStatusRow key={a.id} agent={a} />
                ))}
              </div>
              {agents && !installed.length && <p class="error-text">No agent is installed yet. Install Claude Code or Codex, sign in, then reopen Savor.</p>}
            </>
          )}
          {step === 1 && agent && info && (
            <>
              <h2>Which agent should start?</h2>
              <p class="muted">New projects start with it. You can switch in any conversation.</p>
              <div class="setup-list">
                {installed.map((a) => (
                  <button key={a.id} class={`setting agent-status pick ${agent.provider === a.id ? 'selected' : ''}`} onClick={() => a.id !== agent.provider && setDraft(fresh(a))}>
                    <ProviderIcon provider={a.id} size={16} />
                    <span>
                      <b>{a.name}</b>
                      <small class="muted">{[a.version, a.account].filter(Boolean).join(' · ')}</small>
                    </span>
                    <span class={a.signedIn ? 'ok' : a.signedIn === false ? 'warn' : 'muted'}>{agentStatus(a)}</span>
                  </button>
                ))}
              </div>
              {info.models.length > 0 && (
                <label class="setting">
                  <span>Model</span>
                  <select value={agent.model} onChange={(e) => set({ model: e.currentTarget.value })}>
                    {!info.models.some((m) => m.id === '') && <option value="">Default</option>}
                    {info.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id ? describeModel(m).name : m.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {efforts.length > 0 && (
                <div class="setting">
                  <span>
                    Effort
                    <small class="muted">Higher thinks longer and uses your limits faster</small>
                  </span>
                  <div class="ap-effort" role="radiogroup" aria-label="Reasoning effort">
                    {efforts.map((e) => (
                      <button key={e} role="radio" aria-checked={agent.reasoning === e} class={agent.reasoning === e ? 'selected' : ''} onClick={() => set({ reasoning: e })}>
                        {effortLabel(e)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {step === 2 && agent && info && (
            <>
              <h2>How much may the agent do on its own?</h2>
              <p class="muted">Fewer questions mean faster work, but less control. Each conversation can still switch.</p>
              {info.modes.filter((m) => !HIDDEN_MODES.includes(m.id)).length < 2 ? (
                <p class="muted">{info.name} takes its permissions from its own settings.</p>
              ) : (
                <ModeCards agent={agent} info={info} onPick={(permissionMode) => set({ permissionMode })} />
              )}
            </>
          )}
          {step === 3 && agent && info && (
            <>
              <h2>Where do you want to start?</h2>
              <p class="muted">
                A project is a folder. Conversations, documents and workflows live in its <code>.savor/</code> directory.
              </p>
              <div class="setup-project">
                <AddProject me={me} setMe={setMe} onAdded={() => setMe({ ...me, setup: false })} />
              </div>
              <div class="box setup-summary">
                <div class="setting">
                  <span class="muted">Agent</span>
                  <b>
                    {info.name} · {modelName(agent, info)}
                    {agent.reasoning && ` · ${effortLabel(agent.reasoning)}`}
                  </b>
                </div>
                <div class="setting">
                  <span class="muted">Permissions</span>
                  <b>{info.modes.find((m) => m.id === agent.permissionMode)?.label}</b>
                </div>
              </div>
            </>
          )}
          {error && <p class="error-text">{error}</p>}
        </div>
        <div class="dialog-foot">
          <button class="ghost" onClick={step === 3 ? () => setMe({ ...me, setup: false }) : skip}>
            {step === 3 ? 'Later' : 'Skip setup'}
          </button>
          <span class="spacer" />
          {step > 0 && (
            <button class="ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {step < 3 && (
            <button class="primary" disabled={!agent || !installed.length} onClick={next}>
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
