import { useEffect, useRef, useState } from 'preact/hooks'
import { ArrowUpRight, Bot, Check, ChevronDown, ChevronRight, Laptop, MessageSquare, Mic, Plus, SlidersHorizontal, Smartphone, X } from 'lucide-preact'
import { api, cap, desktop, useAgents, useApi, type AgentConfig, type Me } from './api'
import { AgentButton, AgentMenu } from './Composer'
import { AgentStatusRow, ModeCards } from './Setup'
import { useNotificationToggle } from './notify'
import { PleasanceFooter } from './PleasanceFooter'
import { setPrefs, usePrefs, type Density, type Prefs, type Theme } from './prefs'
import { qr, RELAY_LABEL, type DeviceRow, type RelayState } from './Settings'
import { forgetProfile, loadProfile } from './transport'
import { megabytes, type VoiceModels } from './voice'

const REPO = 'https://github.com/robinchoice/savor'

// Savor has no server of its own that could take feedback, so it becomes an issue on GitHub.
export function openIssue(text: string, details: string) {
  window.open(`${REPO}/issues/new?${new URLSearchParams({ title: text.trim().split('\n')[0].slice(0, 80), body: `${text.trim()}\n\n---\n${details}` })}`, '_blank', 'noreferrer')
}

const THEMES: [Theme, string][] = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]
const SHOWN: [keyof Prefs['show'], string][] = [['label', 'Label'], ['agent', 'Agent'], ['date', 'Date'], ['count', 'Message count']]

function DensityPicker({ name, value, onChange }: { name: string; value: Density; onChange: (d: Density) => void }) {
  return (
    <div class="density">
      {(['normal', 'compact'] as const).map((d) => (
        <label key={d} class={value === d ? 'selected' : ''}>
          <span class={`bars ${d}`}>
            <i />
            <i />
            <i />
          </span>
          <span>
            {cap(d)} <input type="radio" name={name} checked={value === d} onChange={() => onChange(d)} />
          </span>
        </label>
      ))}
    </div>
  )
}

export function AppearanceMenu({ close }: { close: () => void }) {
  const prefs = usePrefs()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const on = (e: MouseEvent) => !e.composedPath().includes(ref.current!) && close()
    setTimeout(() => addEventListener('click', on))
    return () => removeEventListener('click', on)
  }, [])
  return (
    <div class="menu right appearance" ref={ref}>
      <div class="panel-head">
        <b>Appearance</b>
        <button class="icon-btn" title="Close" onClick={close}>
          <X size={16} />
        </button>
      </div>
      {THEMES.map(([id, label]) => (
        <button key={id} class={prefs.theme === id ? 'selected' : ''} onClick={() => setPrefs({ theme: id })}>
          <span class={`theme-swatch ${id}`} />
          <span>{label}</span>
          {prefs.theme === id && <Check size={15} />}
        </button>
      ))}
      <div class="menu-label">Conversations</div>
      <DensityPicker name="conversations" value={prefs.conversations} onChange={(conversations) => setPrefs({ conversations })} />
      <details>
        <summary>Choose what to show</summary>
        {SHOWN.map(([key, label]) => (
          <label key={key} class="check">
            <input type="checkbox" checked={prefs.show[key]} onChange={(e) => setPrefs({ show: { ...prefs.show, [key]: e.currentTarget.checked } })} /> {label}
          </label>
        ))}
      </details>
      <div class="menu-label">Messages</div>
      <DensityPicker name="messages" value={prefs.messages} onChange={(messages) => setPrefs({ messages })} />
    </div>
  )
}

export function FeedbackDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const [text, setText] = useState('')
  const [opened, setOpened] = useState(false)
  const open = () => {
    openIssue(text, `Savor ${me.version} · ${me.system}`)
    setOpened(true)
  }
  return (
    <div class="overlay" onClick={onClose}>
      <div class="dialog feedback-dialog" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          <MessageSquare size={18} />
          <div class="dialog-title">
            <b>Send feedback</b>
          </div>
          <button class="icon-btn" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {opened ? (
          <p class="dialog-body">The issue form is open in your browser with your text filled in. Add screenshots there and submit.</p>
        ) : (
          <div class="dialog-body form">
            <label>
              Your feedback
              <textarea rows={6} maxLength={4000} autoFocus placeholder="What could be better?" value={text} onInput={(e) => setText(e.currentTarget.value)} />
            </label>
            <span class="muted small">
              Opens a GitHub issue in your browser. Savor {me.version} · {me.system} is added to the text.
            </span>
          </div>
        )}
        <footer class="dialog-foot">
          <span />
          {opened ? (
            <button class="primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <button class="primary" disabled={!text.trim()} onClick={open}>
              Continue on GitHub <ArrowUpRight size={15} />
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

interface Pairing { code: string; url: string; relayUrl: string | null; expiresAt: string }

function MyDevices({ me, projects }: { me: Me; projects: number }) {
  const [devices] = useApi<DeviceRow[]>('/devices', (e) => e.type === 'devices')
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const revoke = (d: DeviceRow) => confirm(`Revoke access for ${d.name}?`) && api('DELETE', `/devices/${d.id}`)
  const link = pairing?.relayUrl ?? pairing?.url
  return (
    <section>
      <h2>My devices</h2>
      <div class="box">
        <div class="row-item">
          <span class="tile">
            <Laptop size={17} />
          </span>
          <div>
            <b>{me.host}</b>
            <small class="muted">
              This computer · {projects} project{projects === 1 ? '' : 's'}
            </small>
          </div>
        </div>
        {devices?.map((d) => (
          <div key={d.id} class="row-item">
            <span class="tile">
              <Smartphone size={17} />
            </span>
            <div>
              <b>{d.name}</b>
              <small class="muted">
                {d.via === 'relay' ? 'Via relay' : 'Direct'} · last seen {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'never'}
              </small>
            </div>
            <button class="ghost small danger" onClick={() => revoke(d)}>
              Revoke
            </button>
          </div>
        ))}
        <button class="row-item" onClick={async () => setPairing(pairing ? null : await api('POST', '/devices/pairing'))}>
          <span class="tile">
            <Plus size={17} />
          </span>
          <div>
            <b>Connect a personal device</b>
            <small class="muted">Your phone or a web browser</small>
          </div>
          {pairing ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        {pairing && link && (
          <div class="pairing">
            <div class="qr" dangerouslySetInnerHTML={{ __html: qr(link) }} />
            <div>
              <p>Scan the code, or open this link on the device:</p>
              <p class="mono">{link}</p>
              <p>
                Code: <b class="mono">{pairing.code}</b> · valid until {new Date(pairing.expiresAt).toLocaleTimeString()}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

// Which agent CLIs are installed on this computer and signed in, and the agent new projects start with.
function Agents() {
  const agents = useAgents()
  const [agent, reload] = useApi<AgentConfig>('/agent', () => false)
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setMenu(false)
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menu])
  const info = agent && agents?.find((a) => a.id === agent.provider)
  const setAgent = (next: AgentConfig) =>
    api('PUT', '/agent', next).then(
      () => (setError(''), reload()),
      (e) => setError((e as Error).message),
    )
  return (
    <details class="box">
      <summary>
        <span class="tile">
          <Bot size={16} />
        </span>
        Agents <ChevronDown size={16} class="chev" />
      </summary>
      <div class="box-body" ref={ref}>
        {agent && info && (
          <>
            <div class="setting">
              <span>
                New projects start with
                <small class={error ? 'error-text' : 'muted'}>{error || 'Then each project keeps the agent it last used'}</small>
              </span>
              <AgentButton agent={agent} info={info} open={menu} toggle={() => setMenu(!menu)} />
            </div>
            <ModeCards agent={agent} info={info} onPick={(permissionMode) => setAgent({ ...agent, permissionMode })} />
          </>
        )}
        {menu && agent && info && <AgentMenu agent={agent} agents={agents ?? []} setAgent={setAgent} close={() => setMenu(false)} />}
        {agents?.map((a) => (
          <AgentStatusRow key={a.id} agent={a} />
        ))}
      </div>
    </details>
  )
}

// The speech models voice input can use on this computer: which one it uses, and which are downloaded.
function VoiceInput() {
  const [voice] = useApi<VoiceModels>('/voice/models', (e) => e.type === 'voice')
  return (
    <details class="box">
      <summary>
        <span class="tile">
          <Mic size={16} />
        </span>
        Voice input <ChevronDown size={16} class="chev" />
      </summary>
      <div class="box-body">
        {voice?.models.map((m) => (
          <label key={m.id} class="setting voice-model">
            <input type="radio" name="voice-model" checked={voice.selected === m.id} onChange={() => api('PUT', '/voice/model', { id: m.id })} />
            <span>
              <b>{m.name}</b>
              <small class="muted">
                {m.detail} {megabytes(m.size)} · {m.license}
              </small>
              {m.error && <small class="error-text">{m.error}</small>}
            </span>
            {m.downloaded !== null ? (
              <small class="muted">{Math.floor((m.downloaded / m.size) * 100)} %</small>
            ) : m.installed ? (
              <button class="ghost small" onClick={() => api('DELETE', `/voice/models/${m.id}`)}>
                Remove
              </button>
            ) : (
              <button class="ghost small" onClick={() => api('POST', `/voice/models/${m.id}/download`)}>
                Download
              </button>
            )}
          </label>
        ))}
      </div>
    </details>
  )
}

function RelayRow({ onClose }: { onClose: () => void }) {
  const [relay] = useApi<RelayState>('/relay', (e) => e.type === 'devices')
  return (
    <a class="setting" href="#/devices" onClick={onClose}>
      <span>
        Devices & remote access
        <small class="muted">Relay: {relay ? RELAY_LABEL[relay.state] : '…'}</small>
      </span>
      <ChevronRight size={15} />
    </a>
  )
}

// Updates of the desktop app, and the restart of the daemon (as a service) into an installed update.
function UpdateSettings() {
  const [settings] = useApi<{ autoUpdate: boolean; autoRestart: boolean; service: boolean }>('/settings', (e) => e.type === 'settings')
  if (!settings) return null
  const toggle = (key: 'autoUpdate' | 'autoRestart') => api('PATCH', '/settings', { [key]: !settings[key] })
  return (
    <>
      {desktop && (
        <div class="setting">
          <span>Download and install updates automatically</span>
          <button class={`switch ${settings.autoUpdate ? 'on' : ''}`} role="switch" aria-checked={settings.autoUpdate} onClick={() => toggle('autoUpdate')}>
            <i />
          </button>
        </div>
      )}
      {settings.service && (
        <div class="setting">
          <span>
            Restart automatically after updates
            <small class="muted">Otherwise Savor asks before it restarts</small>
          </span>
          <button class={`switch ${settings.autoRestart ? 'on' : ''}`} role="switch" aria-checked={settings.autoRestart} onClick={() => toggle('autoRestart')}>
            <i />
          </button>
        </div>
      )}
    </>
  )
}

// Savor has no accounts: this is the computer it runs on, or on a paired device, that device.
export function AccountDialog({ me, projects, toggleAwake, open, onClose }: { me: Me; projects: number; toggleAwake: () => void; open: (what: 'feedback' | 'appearance') => void; onClose: () => void }) {
  const local = me.origin === 'local'
  const prefs = usePrefs()
  const [canNotify, notifyOn, toggleNotify] = useNotificationToggle(!local)
  const [update, setUpdate] = useState('')
  const [available, setAvailable] = useState(false)
  const checkUpdate = async () => {
    setUpdate('checking…')
    const version = await desktop!.checkForUpdates().catch(() => undefined)
    setUpdate(version ? `${version} is available` : version === null ? 'up to date' : 'could not check for updates')
    setAvailable(!!version)
  }
  const installUpdate = () => {
    setUpdate('installing, Savor restarts…')
    desktop!.installUpdate().catch(() => setUpdate('could not install the update'))
  }
  const forget = () => confirm('Forget this computer on this device? You will need to pair again.') && forgetProfile().then(() => location.reload())
  return (
    <div class="overlay" onClick={onClose}>
      <div class="dialog account-dialog" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          {local ? <Laptop size={18} /> : <Smartphone size={18} />}
          <div class="dialog-title">
            <b>{local ? 'This computer' : 'This device'}</b>
          </div>
          <button class="icon-btn" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div class="dialog-body">
          {local ? (
            <div class="box row-item">
              <span class="account">S</span>
              <div>
                <b>{me.host}</b>
                <small class="muted">
                  Savor {me.version}
                  {update && ` · ${update}`}
                </small>
              </div>
              {desktop && (
                <button class="ghost small" onClick={available ? installUpdate : checkUpdate}>
                  {available ? 'Install and restart' : 'Check for updates'}
                </button>
              )}
            </div>
          ) : (
            <div class="box row-item">
              <span class="tile">
                <Smartphone size={17} />
              </span>
              <div>
                <b>{me.device}</b>
                <small class="muted">
                  Remote device · connected to {me.host}
                  {loadProfile() ? ' via relay' : ''}
                </small>
              </div>
            </div>
          )}
          {local && <MyDevices me={me} projects={projects} />}
          {local && <Agents />}
          {local && <VoiceInput />}
          <details class="box">
            <summary>
              <span class="tile">
                <SlidersHorizontal size={16} />
              </span>
              App settings <ChevronDown size={16} class="chev" />
            </summary>
            <div class="box-body">
              {local && (
                <div class="setting">
                  <span>Keep this computer awake</span>
                  <button class={`switch ${me.awake ? 'on' : ''}`} role="switch" aria-checked={me.awake} onClick={toggleAwake}>
                    <i />
                  </button>
                </div>
              )}
              {local && <UpdateSettings />}
              {canNotify && (
                <div class="setting">
                  <span>Notifications</span>
                  <button class={`switch ${notifyOn ? 'on' : ''}`} role="switch" aria-checked={notifyOn} onClick={toggleNotify}>
                    <i />
                  </button>
                </div>
              )}
              <div class="setting">
                <span>
                  Bug button
                  <small class="muted">Reports a bug with a screenshot of the screen</small>
                </span>
                <button class={`switch ${prefs.bugButton ? 'on' : ''}`} role="switch" aria-checked={prefs.bugButton} onClick={() => setPrefs({ bugButton: !prefs.bugButton })}>
                  <i />
                </button>
              </div>
              <button class="setting" onClick={() => open('appearance')}>
                <span>Appearance</span>
                <span class="muted">{cap(prefs.theme)}</span>
                <ChevronRight size={15} />
              </button>
              {local && <RelayRow onClose={onClose} />}
            </div>
          </details>
          <details class="box" open>
            <summary>
              <span class="tile">
                <MessageSquare size={16} />
              </span>
              Community <ChevronDown size={16} class="chev" />
            </summary>
            <div class="box-body">
              <button class="ghost wide" onClick={() => open('feedback')}>
                <MessageSquare size={15} /> Send feedback
              </button>
              <label class="check wide-only">
                <input type="checkbox" checked={prefs.feedbackButton} onChange={(e) => setPrefs({ feedbackButton: e.currentTarget.checked })} /> Show feedback in toolbar
              </label>
              <div class="row">
                <a class="ghost" href={REPO} target="_blank" rel="noreferrer">
                  GitHub <ArrowUpRight size={14} />
                </a>
                <a class="ghost" href={`${REPO}/issues`} target="_blank" rel="noreferrer">
                  Report an issue <ArrowUpRight size={14} />
                </a>
              </div>
            </div>
          </details>
        </div>
        <footer class="dialog-foot">
          <PleasanceFooter />
          <div class="row">
            {loadProfile() && (
              <button class="ghost danger" onClick={forget}>
                Forget this computer
              </button>
            )}
            <button class="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
