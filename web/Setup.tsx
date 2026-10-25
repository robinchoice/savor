import { useState } from 'preact/hooks'
import { Archive, Check, Code, Copy, Folder, GraduationCap, Plus, RefreshCw } from 'lucide-preact'
import { api, describeModel, desktop, effortLabel, fetchAgents, go, modelName, useAgents, type AgentConfig, type Me, type Project, type ProviderInfo } from './api'
import { ProviderIcon } from './Conversations'
import { effortsOf } from './Composer'
import { recipe } from './recipes'
import { setPrefs, usePrefs } from './prefs'
import { STANDARD } from './Shortcuts'
import { CODE, TEMPLATES } from './templates'
import { lang, t } from './i18n'
import { FORMATS, STYLES } from './Workspace'

// The mode a provider works best in for most people; the others still show.
const RECOMMENDED: Record<string, string> = { claude: 'auto', codex: 'auto-review', antigravity: 'accept-edits' }
// Plan modes are chosen per conversation, not as a default.
const HIDDEN_MODES = ['plan', 'dontAsk']

export const agentStatus = (a: ProviderInfo) => (!a.installed ? t('Not installed') : a.signedIn ? t('Signed in') : a.signedIn === false ? t('Signed out') : t('Installed'))

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
              {t('Sign in:')} <code>{a.signIn}</code>
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

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard.writeText(text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))
  return (
    <div class="copy-line">
      <code>{text}</code>
      <button class="icon-btn" title={t('Copy')} aria-label={t('Copy')} onClick={copy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  )
}

// Without a signed-in agent: how to get Claude Code on this system, then a look again without a restart.
function InstallHelp({ system, claude, onCheck }: { system: string; claude?: ProviderInfo; onCheck: () => Promise<void> }) {
  const [checking, setChecking] = useState(false)
  const win = system.startsWith('Windows')
  const check = async () => (setChecking(true), await onCheck(), setChecking(false))
  return (
    <div class="box install-help">
      <b>{t('Get Claude Code')}</b>
      <small class="muted">
        {t('It needs a Claude Pro or Max plan; the free plan does not include it. You use the terminal only for these two steps.')}
      </small>
      {!claude?.installed && (
        <>
          <span>{t('1. Open {app} and run:', { app: win ? 'PowerShell' : 'Terminal' })}</span>
          <CopyLine text={win ? 'winget install Anthropic.ClaudeCode' : 'curl -fsSL https://claude.ai/install.sh | bash'} />
        </>
      )}
      <span>{claude?.installed ? t('Sign in in a terminal. Your browser opens for the login:') : t('2. Then sign in, in a new {app} window. Your browser opens for the login:', { app: win ? 'PowerShell' : 'Terminal' })}</span>
      <CopyLine text={!win && !claude?.installed ? '~/.local/bin/claude auth login' : (claude?.signIn ?? 'claude auth login')} />
      <div class="row">
        <button class="ghost" disabled={checking} onClick={check}>
          <RefreshCw size={14} /> {checking ? t('Looking…') : t('Check again')}
        </button>
        <span class="spacer" />
        <a class="small" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">
          {t('Other ways to install')}
        </a>
      </div>
    </div>
  )
}

// How much the agent may do on its own, as cards that weigh control against speed.
export function ModeCards({ agent, info, onPick }: { agent: AgentConfig; info: ProviderInfo; onPick: (mode: string) => void }) {
  const modes = info.modes.filter((m) => !HIDDEN_MODES.includes(m.id))
  if (modes.length < 2) return null
  return (
    <div class="mode-cards" role="radiogroup" aria-label={t('Permissions')}>
      {modes.map((m) => (
        <button key={m.id} role="radio" aria-checked={agent.permissionMode === m.id} class={`mode-card ${agent.permissionMode === m.id ? 'selected' : ''}`} onClick={() => onPick(m.id)}>
          {RECOMMENDED[info.id] === m.id && <span class="ap-tag">{t('Recommended')}</span>}
          {m.unsafe && <span class="ap-tag unsafe">{t('Isolated machines only')}</span>}
          <b>{t(m.label)}</b>
          <small>{t(m.detail)}</small>
        </button>
      ))}
    </div>
  )
}

const TYPE_ICONS: Record<string, typeof Folder> = { code: Code, 'academic-writing': GraduationCap, kontor: Archive }
const KINDS: [string, string][] = [
  ['term-paper', 'Term paper'],
  ['bachelor', "Bachelor's thesis"],
  ['master', "Master's thesis"],
  ['article', 'Article'],
  ['other', 'Other'],
]
const COVERS: [string, string][] = [
  ['household', 'Private household'],
  ['business', 'My business'],
  ['club', 'A club or association'],
  ['other', 'Something else'],
]
const AREAS: [string, string][] = [
  ['contacts', 'Contacts'],
  ['finance', 'Finance'],
  ['contracts', 'Contracts'],
  ['insurance', 'Insurance'],
  ['health', 'Health'],
  ['car', 'Car'],
  ['projects', 'Projects'],
]

// Start a new project or open a folder: in the Projects menu and in the last step of the setup.
export function AddProject({ me, setMe, onAdded }: { me: Me; setMe: (m: Me) => void; onAdded: () => void }) {
  const [step, setStep] = useState<'new' | 'details' | 'open' | null>(null)
  const [template, setTemplate] = useState(CODE)
  const [academic, setAcademic] = useState({ author: '', question: '', kind: 'term-paper', language: lang, style: 'apa', format: 'docx', length: '', deadline: '' })
  const [kontor, setKontor] = useState({ covers: 'household', areas: ['finance', 'contracts', 'insurance'], briefing: true })
  const [name, setName] = useState('')
  const [dir, setDir] = useState(me.projectsDir)
  const [editDir, setEditDir] = useState(false)
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const add = async (body: { path?: string; folder?: string; name?: string; create?: boolean; type?: string }) => {
    try {
      const p = await api<Project>('POST', '/projects', body)
      if (body.create) setMe({ ...me, projectsDir: dir })
      // A project type brings its ROLE.md and workflows. Code starts with a conversation, the other types
      // get their folders from the answers in the form and open on their own tab.
      if (body.create) {
        for (const r of template.workflows.map((slug) => recipe(slug)!)) {
          const enabled = r.slug === 'kontor-briefing' ? kontor.briefing : !template.paused
          await api('POST', `/projects/${p.id}/workflows`, { name: r.title, prompt: r.prompt, collection: template.title, cron: r.schedule || null, onModelChange: r.onModelChange, enabled })
        }
        if (!template.setup) {
          const answers = template.slug === 'kontor' ? { ...kontor, language: lang } : { ...academic, title: body.name }
          await api('POST', `/projects/${p.id}/setup`, { type: template.slug, answers })
          onAdded()
          return go(`/p/${p.id}${template.slug === 'kontor' ? '/today' : ''}`)
        }
        // The prompt shows as the first message: in German when Savor is, otherwise in English with a note
        // that the agent talks in the computer's language.
        const text = lang === 'de' && template.setupDe ? template.setupDe : `${template.setup}\n\nTalk to me in the language of this computer (${navigator.language}) unless I write in another one.`
        const t = await api<{ id: string }>('POST', `/projects/${p.id}/threads`, { text })
        onAdded()
        return go(`/p/${p.id}/t/${t.id}`)
      }
      onAdded()
      go(`/p/${p.id}`)
    } catch (err) {
      setError((err as Error).message)
      // Such as a folder that exists: the name to change is on the first step.
      if (body.create) setStep('new')
    }
  }
  // A new project's folder is its name in lower case, the words joined by hyphens.
  const folder = name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
  const create = (e: Event) => {
    e.preventDefault()
    if (step === 'new' && !template.setup) return setStep('details')
    if (folder) add({ ...(me.origin === 'local' ? { path: `${dir.replace(/\/$/, '')}/${folder}` } : { folder }), name: name.trim(), create: true, ...(template !== CODE && { type: template.slug }) })
  }
  const setA = (patch: Partial<typeof academic>) => setAcademic({ ...academic, ...patch })
  const toggleArea = (id: string) => setKontor({ ...kontor, areas: kontor.areas.includes(id) ? kontor.areas.filter((a) => a !== id) : [...kontor.areas, id] })
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
            {[CODE, ...TEMPLATES].map((tpl) => {
              const Icon = TYPE_ICONS[tpl.slug] ?? Folder
              return (
                <button type="button" key={tpl.slug} class={`project-type ${tpl === template ? 'active' : ''}`} onClick={() => setTemplate(tpl)}>
                  <Icon size={16} />
                  <b>{t(tpl.title)}</b>
                  <small>{t(tpl.blurb)}</small>
                </button>
              )
            })}
          </div>
          <small class="muted">{t(template.creates)}</small>
          <input autoFocus placeholder={t('Name of the new project')} value={name} onInput={(e) => setName(e.currentTarget.value)} />
          {editDir ? (
            <input placeholder={t('Folder for new projects')} value={dir} onInput={(e) => setDir(e.currentTarget.value)} />
          ) : (
            <small>
              {t('Creates')}{' '}
              <b class="mono">
                {dir}/{folder || '…'}
              </b>{' '}
              {me.origin === 'local' && <>{' '}·{' '}
                <button type="button" class="link" onClick={changeDir}>
                  {t('Change folder')}
                </button>
              </>}
            </small>
          )}
          <div class="row">
            <span class="spacer" />
            <button type="button" class="ghost" onClick={() => setStep(null)}>
              {t('Cancel')}
            </button>
            <button class="primary" disabled={!folder || !dir.trim()}>
              {template.setup ? t('Create project') : t('Next')}
            </button>
          </div>
        </form>
      ) : step === 'details' ? (
        // Enter in a field moves on instead of creating the project with the rest unanswered.
        <form class="type-form" onSubmit={create} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && e.preventDefault()}>
          <b>{name.trim()}</b>
          {template.slug === 'kontor' ? (
            <>
              <label>
                {t('What is this Kontor for?')}
                <select value={kontor.covers} onChange={(e) => setKontor({ ...kontor, covers: e.currentTarget.value })}>
                  {COVERS.map(([id, l]) => (
                    <option key={id} value={id}>
                      {t(l)}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <div class="field-label">{t('Areas with their own folder')}</div>
                <div class="ws-chips">
                  {AREAS.map(([id, l]) => (
                    <button type="button" key={id} class={`ws-chip ${kontor.areas.includes(id) ? 'on' : ''}`} onClick={() => toggleArea(id)}>
                      {t(l)}
                    </button>
                  ))}
                </div>
              </div>
              <label class="check">
                <input type="checkbox" checked={kontor.briefing} onChange={(e) => setKontor({ ...kontor, briefing: e.currentTarget.checked })} /> {t('Deadlines in a briefing on weekday mornings')}
              </label>
            </>
          ) : (
            <>
              <label>
                {t('Kind of work')}
                <select value={academic.kind} onChange={(e) => setA({ kind: e.currentTarget.value })}>
                  {KINDS.map(([id, l]) => (
                    <option key={id} value={id}>
                      {t(l)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('Research question')}
                <textarea rows={2} placeholder={t('optional, you can add it later')} value={academic.question} onInput={(e) => setA({ question: e.currentTarget.value })} />
              </label>
              <label>
                {t('Your name')}
                <input placeholder={t('for the title page')} value={academic.author} onInput={(e) => setA({ author: e.currentTarget.value })} />
              </label>
              <div class="row wide">
                <label>
                  {t('Language of the work')}
                  <select value={academic.language} onChange={(e) => setA({ language: e.currentTarget.value as typeof lang })}>
                    <option value="de">{t('German')}</option>
                    <option value="en">{t('English')}</option>
                  </select>
                </label>
                <label>
                  {t('Citation style')}
                  <select value={academic.style} onChange={(e) => setA({ style: e.currentTarget.value })}>
                    {STYLES.map(([id, l]) => (
                      <option key={id} value={id}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                {t('Hand in as')}
                <select value={academic.format} onChange={(e) => setA({ format: e.currentTarget.value })}>
                  {FORMATS.map(([id, l]) => (
                    <option key={id} value={id}>
                      {id === 'docx' ? t('DOCX (recommended: opens in Word, which also saves it as PDF)') : l}
                    </option>
                  ))}
                </select>
              </label>
              <div class="row wide">
                <label>
                  {t('Target length in words')}
                  <input inputMode="numeric" placeholder={t('optional')} value={academic.length} onInput={(e) => setA({ length: e.currentTarget.value })} />
                </label>
                <label>
                  {t('Deadline')}
                  <input type="date" value={academic.deadline} onInput={(e) => setA({ deadline: e.currentTarget.value })} />
                </label>
              </div>
              <small class="muted">{t('You can change format and citation style later in the Export tab. Using Zotero? Let Better BibTeX keep references.bib in this folder up to date. Using Citavi? Export the project as BibTeX to references.bib and again after changes; an export template makes that one click.')}{' '}
                {t('Still choosing? We recommend Zotero: free, on every system, and Better BibTeX keeps references.bib current on its own.')}{' '}
                <a href="https://www.zotero.org/support/kb/import_from_citavi" target="_blank" rel="noreferrer">
                  {t('Switch from Citavi to Zotero')}
                </a>
              </small>
            </>
          )}
          <div class="row">
            <span class="spacer" />
            <button type="button" class="ghost" onClick={() => setStep('new')}>
              {t('Back')}
            </button>
            <button class="primary">{t('Create project')}</button>
          </div>
        </form>
      ) : step === 'open' ? (
        <form class="menu-form" onSubmit={(e) => (e.preventDefault(), add({ path }))}>
          <input autoFocus placeholder="/path/to/project" value={path} onInput={(e) => setPath(e.currentTarget.value)} />
          <button class="primary" disabled={!path.trim()}>
            <Plus size={15} /> {t('Add')}
          </button>
        </form>
      ) : (
        <>
          <button class="ghost wide" onClick={() => setStep('new')}>
            <Plus size={16} /> {t('Start new project')}
          </button>
          {me.origin === 'local' && <button class="ghost wide" onClick={openFolder}>
            <Folder size={16} /> {t('Open any folder')}
          </button>}
        </>
      )}
      {error && <div class="error-text">{error}</div>}
    </>
  )
}

const STEPS = [t('Agents'), t('Default agent'), t('Permissions'), t('Shortcuts'), t('First project')]

// First start on this computer: finds the agents, then asks which one new projects start with, how much
// it may do alone, whether to start with keyboard shortcuts, and where to begin. Skipping keeps Savor's
// defaults; This computer → Agents changes them later.
export function SetupWizard({ me, setMe }: { me: Me; setMe: (m: Me) => void }) {
  const found = useAgents()
  const [rechecked, setRechecked] = useState<ProviderInfo[]>()
  const agents = rechecked ?? found
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<AgentConfig | null>(null)
  const [error, setError] = useState('')
  const installed = agents?.filter((a) => a.installed) ?? []
  // Until something is picked: the first signed-in agent, in its recommended mode.
  const first = installed.find((a) => a.signedIn) ?? installed[0] ?? agents?.[0]
  const fresh = (a: ProviderInfo): AgentConfig => ({ provider: a.id, model: '', reasoning: a.defaultEffort, fast: false, ultracode: false, permissionMode: RECOMMENDED[a.id] ?? a.defaultMode })
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
  const suggested = Object.keys(usePrefs().shortcuts).length > 0

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
            {t('Step {n} of {total}', { n: step + 1, total: STEPS.length })} · {STEPS[step]}
          </div>
          {step === 0 && (
            <>
              <h2>{t('Welcome to Savor')}</h2>
              <p class="muted">{t('Savor runs the coding agents already on this computer. This is what it found:')}</p>
              {!agents && <p class="muted">{t('Looking for agents…')}</p>}
              <div class="setup-list">
                {[...installed, ...(agents ?? []).filter((a) => !a.installed)].map((a) => (
                  <AgentStatusRow key={a.id} agent={a} />
                ))}
              </div>
              {agents && !installed.some((a) => a.signedIn) && (
                <InstallHelp system={me.system} claude={agents.find((a) => a.id === 'claude')} onCheck={async () => setRechecked(await fetchAgents(true))} />
              )}
            </>
          )}
          {step === 1 && agent && info && (
            <>
              <h2>{t('Which agent should start?')}</h2>
              <p class="muted">{t('New projects start with it. You can switch in any conversation.')}</p>
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
                  <span>{t('Model')}</span>
                  <select value={agent.model} onChange={(e) => set({ model: e.currentTarget.value })}>
                    {!info.models.some((m) => m.id === '') && <option value="">{t('Default')}</option>}
                    {info.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id ? describeModel(m).name : t(m.label)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {efforts.length > 0 && (
                <div class="setting">
                  <span>
                    {t('Effort')}
                    <small class="muted">{t('Higher thinks longer and uses your limits faster')}</small>
                  </span>
                  <div class="ap-effort" role="radiogroup" aria-label={t('Reasoning effort')}>
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
              <h2>{t('How much may the agent do on its own?')}</h2>
              <p class="muted">{t('Fewer questions mean faster work, but less control. Each conversation can still switch.')}</p>
              {info.modes.filter((m) => !HIDDEN_MODES.includes(m.id)).length < 2 ? (
                <p class="muted">{t('{name} takes its permissions from its own settings.', { name: info.name })}</p>
              ) : (
                <ModeCards agent={agent} info={info} onPick={(permissionMode) => set({ permissionMode })} />
              )}
            </>
          )}
          {step === 3 && (
            <>
              <h2>{t('Keyboard shortcuts?')}</h2>
              <p class="muted">{t('Savor starts without any, so you can choose your own. This computer › App settings › Keyboard shortcuts changes them any time.')}</p>
              <div class="mode-cards" role="radiogroup" aria-label={t('Keyboard shortcuts')}>
                <button role="radio" aria-checked={!suggested} class={`mode-card ${suggested ? '' : 'selected'}`} onClick={() => setPrefs({ shortcuts: {} })}>
                  <b>{t('Start without')}</b>
                  <small>{t('Set the keys you want yourself.')}</small>
                </button>
                <button role="radio" aria-checked={suggested} class={`mode-card ${suggested ? 'selected' : ''}`} onClick={() => setPrefs({ shortcuts: STANDARD })}>
                  <b>{t('Use Savor\'s suggestions')}</b>
                  <small>{t('J and K for next and back, C for a new conversation, / for the composer, ? shows them all.')}</small>
                </button>
              </div>
            </>
          )}
          {step === 4 && agent && info && (
            <>
              <h2>{t('Where do you want to start?')}</h2>
              <p class="muted">
                {t('A project is a folder. Conversations, documents and workflows live in its .savor/ directory.')}
              </p>
              <div class="setup-project">
                <AddProject me={me} setMe={setMe} onAdded={() => setMe({ ...me, setup: false })} />
              </div>
              <div class="box setup-summary">
                <div class="setting">
                  <span class="muted">{t('Agent')}</span>
                  <b>
                    {info.name} · {modelName(agent, info)}
                    {agent.reasoning && ` · ${effortLabel(agent.reasoning)}`}
                  </b>
                </div>
                <div class="setting">
                  <span class="muted">{t('Permissions')}</span>
                  <b>{t(info.modes.find((m) => m.id === agent.permissionMode)?.label ?? "")}</b>
                </div>
              </div>
            </>
          )}
          {error && <p class="error-text">{error}</p>}
        </div>
        <div class="dialog-foot">
          <button class="ghost" onClick={step === 4 ? () => setMe({ ...me, setup: false }) : skip}>
            {step === 4 ? t('Later') : t('Skip setup')}

          </button>
          <span class="spacer" />
          {step > 0 && (
            <button class="ghost" onClick={() => setStep(step - 1)}>
              {t('Back')}
            </button>
          )}
          {step < 4 && (
            <button class="primary" disabled={!agent || !installed.length} onClick={next}>
              {t('Continue')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
