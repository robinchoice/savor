import { useEffect, useRef, useState } from 'preact/hooks'
import { ArrowDown, ArrowUp, ArrowUpRight, Bot, Check, ChevronDown, ChevronRight, Laptop, MessageSquare, Mic, Plus, SlidersHorizontal, Smartphone, X } from 'lucide-preact'
import { api, cap, desktop, go, PROVIDER_NAMES, useAgents, useApi, type AgentConfig, type Fallback, type Me } from './api'
import { native } from './native'
import { AgentButton, AgentMenu } from './Composer'
import { AgentStatusRow, ModeCards } from './Setup'
import { useNotificationToggle } from './notify'
import { PleasanceFooter } from './PleasanceFooter'
import { setPrefs, usePrefs, type Density, type Prefs, type Theme } from './prefs'
import { qr, RELAY_LABEL, type DeviceRow, type RelayState } from './Settings'
import { forgetProfile, loadProfile, loadProfiles, switchProfile } from './transport'
import { megabytes, type VoiceModels } from './voice'
import { resetLayout } from './Layout'
import { langPref, plural, setLang, t, type LangPref } from './i18n'

const REPO = 'https://github.com/robinchoice/savor'

// Savor has no server of its own that could take feedback, so it becomes an issue on GitHub.
function openIssue(text: string, details: string) {
  window.open(`${REPO}/issues/new?${new URLSearchParams({ title: text.trim().split('\n')[0].slice(0, 80), body: `${text.trim()}\n\n---\n${details}` })}`, '_blank', 'noreferrer')
}

const THEMES: [Theme, string][] = [['system', t('System')], ['light', t('Light')], ['dark', t('Dark')]]
const LANGS: [LangPref, string][] = [['system', t('System')], ['en', 'English'], ['de', 'Deutsch']]
const SHOWN: [keyof Prefs['show'], string][] = [['label', t('Label')], ['agent', t('Agent')], ['date', t('Date')], ['count', t('Message count')]]

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
            {t(cap(d))} <input type="radio" name={name} checked={value === d} onChange={() => onChange(d)} />
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
        <b>{t('Appearance')}</b>
        <button class="icon-btn" title={t('Close')} onClick={close}>
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
      <div class="menu-label">{t('Language')}</div>
      <div class="segmented">
        {LANGS.map(([id, label]) => (
          <button key={id} class={langPref === id ? 'selected' : ''} onClick={() => langPref !== id && setLang(id)}>
            {label}
          </button>
        ))}
      </div>
      <div class="menu-label">{t('Conversations')}</div>
      <DensityPicker name="conversations" value={prefs.conversations} onChange={(conversations) => setPrefs({ conversations })} />
      <details>
        <summary>{t('Choose what to show')}</summary>
        {SHOWN.map(([key, label]) => (
          <label key={key} class="check">
            <input type="checkbox" checked={prefs.show[key]} onChange={(e) => setPrefs({ show: { ...prefs.show, [key]: e.currentTarget.checked } })} /> {label}

          </label>
        ))}
      </details>
      <div class="menu-label">{t('Messages')}</div>
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
            <b>{t('Send feedback')}</b>
          </div>
          <button class="icon-btn" title={t('Close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {opened ? (
          <p class="dialog-body">{t('The issue form is open in your browser with your text filled in. Add screenshots there and submit.')}</p>
        ) : (
          <div class="dialog-body form">
            <label>
              {t('Your feedback')}
              <textarea rows={6} maxLength={4000} autoFocus placeholder={t('What could be better?')} value={text} onInput={(e) => setText(e.currentTarget.value)} />
            </label>
            <span class="muted small">
              {t('Opens a GitHub issue in your browser. Savor {version} · {system} is added to the text.', { version: me.version, system: me.system })}
            </span>
          </div>
        )}
        <footer class="dialog-foot">
          <span />
          {opened ? (
            <button class="primary" onClick={onClose}>
              {t('Done')}
            </button>
          ) : (
            <button class="primary" disabled={!text.trim()} onClick={open}>
              {t('Continue on GitHub')} <ArrowUpRight size={15} />
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
  const revoke = (d: DeviceRow) => confirm(t('Revoke access for {name}?', { name: d.name })) && api('DELETE', `/devices/${d.id}`)
  const link = pairing?.relayUrl ?? pairing?.url
  return (
    <section>
      <h2>{t('My devices')}</h2>
      <div class="box">
        <div class="row-item">
          <span class="tile">
            <Laptop size={17} />
          </span>
          <div>
            <b>{me.host}</b>
            <small class="muted">
              {t('This computer')} · {plural(projects, '{n} project', '{n} projects')}
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
                {d.via === 'relay' ? t('Via relay') : t('Direct')} · {t('last seen {when}', { when: d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : t('never') })}
              </small>
            </div>
            <button class="ghost small danger" onClick={() => revoke(d)}>
              {t('Revoke')}
            </button>
          </div>
        ))}
        <button class="row-item" onClick={async () => setPairing(pairing ? null : await api('POST', '/devices/pairing'))}>
          <span class="tile">
            <Plus size={17} />
          </span>
          <div>
            <b>{t('Connect a personal device')}</b>
            <small class="muted">{t('Your phone or a web browser')}</small>
          </div>
          {pairing ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        {pairing && link && (
          <div class="pairing">
            <div class="qr" dangerouslySetInnerHTML={{ __html: qr(link) }} />
            <div>
              <p>{t('Scan the code, or open this link on the device:')}</p>
              <p class="mono">{link}</p>
              <p>
                {t('Code:')} <b class="mono">{pairing.code}</b> · {t('valid until {time}', { time: new Date(pairing.expiresAt).toLocaleTimeString() })}
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
        {t('Agents')} <ChevronDown size={16} class="chev" />
      </summary>
      <div class="box-body" ref={ref}>
        {agent && info && (
          <>
            <div class="setting">
              <span>
                {t('New projects start with')}
                <small class={error ? 'error-text' : 'muted'}>{error || t('Then each project keeps the agent it last used')}</small>
              </span>
              <AgentButton agent={agent} info={info} open={menu} toggle={() => setMenu(!menu)} />
            </div>
            <ModeCards agent={agent} info={info} onPick={(permissionMode) => setAgent({ ...agent, permissionMode })} />
          </>
        )}
        {menu && agent && info && <AgentMenu agent={agent} agents={agents ?? []} setAgent={setAgent} close={() => setMenu(false)} />}
        <FallbackList />
        {agents?.map((a) => (
          <AgentStatusRow key={a.id} agent={a} />
        ))}
      </div>
    </details>
  )
}

// The agents every conversation goes on with when one reaches its usage limit, from the top, each with its own
// model, effort and permissions. Changes apply right away.
function FallbackList() {
  const agents = useAgents()
  const [fallback, reload] = useApi<Fallback>('/fallback', (e) => e.type === 'settings')
  const [menu, setMenu] = useState<number | null>(null)
  const [error, setError] = useState('')
  if (!fallback) return null
  const { on, agents: list, limited } = fallback
  const save = (next: Partial<Fallback>) =>
    api('PUT', '/fallback', { on, agents: list, ...next }).then(
      () => (setError(''), reload()),
      (e) => setError((e as Error).message),
    )
  const swap = (i: number, j: number) => {
    const next = [...list]
    ;[next[i], next[j]] = [next[j], next[i]]
    setMenu(null)
    save({ agents: next })
  }
  // A new entry starts with an installed agent that is not in the list yet, with its defaults.
  const add = () => {
    const p = agents?.find((a) => a.installed && !list.some((x) => x.provider === a.id)) ?? agents?.[0]
    if (p) save({ agents: [...list, { provider: p.id, model: '', reasoning: p.defaultEffort, fast: false, ultracode: false, permissionMode: p.defaultMode }] }).then(() => setMenu(list.length))
  }
  const first = list.find((a) => !limited.includes(a.provider))
  return (
    <div class={`fallback ${on ? '' : 'off'}`}>
      <div class="setting">
        <span>
          {t('Switch agents at usage limits')}
          <small class={error ? 'error-text' : 'muted'}>{error || t('For open and new conversations in all projects on this computer')}</small>
        </span>
        <button class={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={t('Switch agents at usage limits')} onClick={() => save({ on: !on })}>
          <i />
        </button>
      </div>
      <ol class="fallback-list">
        {list.map((a, i) => {
          const info = agents?.find((x) => x.id === a.provider)
          const mode = info?.modes.find((m) => m.id === a.permissionMode)
          const name = PROVIDER_NAMES[a.provider] ?? a.provider
          return (
            <li key={i}>
              <span class="fallback-rank">{i + 1}</span>
              <span class="fallback-name">
                <b>
                  {name} {i === 0 && <span class="ap-tag">{t('Preferred')}</span>}
                </b>
                {mode && <small class="muted">{t(mode.label)}</small>}
                <small class={limited.includes(a.provider) ? 'warn' : 'ok'}>{limited.includes(a.provider) ? t('At its usage limit') : on && i > 0 && a === first ? t('Takes over now') : t('Available')}</small>
              </span>
              <span class="fallback-tools">
                <AgentButton agent={a} info={info} open={menu === i} toggle={() => setMenu(menu === i ? null : i)} />
                <button class="icon-btn" title={t('Move {name} up', { name })} disabled={i === 0} onClick={() => swap(i, i - 1)}>
                  <ArrowUp size={15} />
                </button>
                <button class="icon-btn" title={t('Move {name} down', { name })} disabled={i === list.length - 1} onClick={() => swap(i, i + 1)}>
                  <ArrowDown size={15} />
                </button>
                <button class="icon-btn" title={t('Remove {name}', { name })} onClick={() => (setMenu(null), save({ agents: list.filter((_, j) => j !== i) }))}>
                  <X size={15} />
                </button>
              </span>
              {menu === i && <AgentMenu agent={a} agents={agents ?? []} setAgent={(next) => save({ agents: list.map((x, j) => (j === i ? next : x)) })} close={() => setMenu(null)} />}
            </li>
          )
        })}
      </ol>
      {list.length < 10 && (
        <button class="ghost small fallback-add" onClick={add}>
          <Plus size={14} /> {t('Add an agent')}
        </button>
      )}
      <small class="muted">{t('Agents at a known limit are skipped, also before a new conversation starts. Once the limit of the agent a conversation had resets, its next request goes back to it. When all are at their limit, the conversation waits for the earliest reset.')}</small>
    </div>
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
        {t('Voice input')} <ChevronDown size={16} class="chev" />
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
                {t('Remove')}
              </button>
            ) : (
              <button class="ghost small" onClick={() => api('POST', `/voice/models/${m.id}/download`)}>
                {t('Download')}
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
        {t('Devices & remote access')}
        <small class="muted">{t('Relay:')} {relay ? t(RELAY_LABEL[relay.state]) : '…'}</small>
      </span>
      <ChevronRight size={15} />
    </a>
  )
}

// Updates of the desktop app, and the restart of the daemon (as a service) into an installed update.
function UpdateSettings() {
  const [settings] = useApi<{ autoUpdate: boolean; autoRestart: boolean; service: boolean; usagePing: boolean | null }>('/settings', (e) => e.type === 'settings')
  if (!settings) return null
  const toggle = (key: 'autoUpdate' | 'autoRestart' | 'usagePing') => api('PATCH', '/settings', { [key]: !settings[key] })
  return (
    <>
      {desktop && (
        <div class="setting">
          <span>{t('Download and install updates automatically')}</span>
          <button class={`switch ${settings.autoUpdate ? 'on' : ''}`} role="switch" aria-checked={settings.autoUpdate} onClick={() => toggle('autoUpdate')}>
            <i />
          </button>
        </div>
      )}
      {settings.service && (
        <div class="setting">
          <span>
            {t('Restart automatically after updates')}
            <small class="muted">{t('Otherwise Savor asks before it restarts')}</small>
          </span>
          <button class={`switch ${settings.autoRestart ? 'on' : ''}`} role="switch" aria-checked={settings.autoRestart} onClick={() => toggle('autoRestart')}>
            <i />
          </button>
        </div>
      )}
      {settings.usagePing !== null && (
        <div class="setting">
          <span>
            {t('Count this installation')}
            <small class="muted">{t('Once a day, a random ID, the version and the platform, so we know how many people use Savor')}</small>
          </span>
          <button class={`switch ${settings.usagePing ? 'on' : ''}`} role="switch" aria-checked={settings.usagePing} onClick={() => toggle('usagePing')}>
            <i />
          </button>
        </div>
      )}
    </>
  )
}

// How long a notice waits for being seen on this computer or another device before it goes to the phones.
function PushDelay() {
  const [settings] = useApi<{ pushDelay: number }>('/settings', (e) => e.type === 'settings')
  if (!settings) return null
  return (
    <div class="setting wrap">
      <span>
        {t('Phones get a notice after')}
        <small class="muted">{t('Unless it was seen on another device first. Questions come after a minute at most, and at once when Savor is open nowhere.')}</small>
      </span>
      <div class="segmented">
        {[0, 1, 3, 5, 15].map((m) => (
          <button key={m} class={settings.pushDelay === m ? 'selected' : ''} onClick={() => api('PATCH', '/settings', { pushDelay: m })}>
            {m ? `${m} min` : t('At once')}
          </button>
        ))}
      </div>
    </div>
  )
}

// The computers this device is paired with through the relay; Savor talks to one of them at a time.
function Computers() {
  const active = loadProfile()!
  return (
    <details class="box" open>
      <summary>
        <span class="tile">
          <Laptop size={16} />
        </span>
        {t('Computers')} <ChevronDown size={16} class="chev" />
      </summary>
      <div class="box-body">
        {loadProfiles().map((p) =>
          p.daemonPk === active.daemonPk ? (
            <div key={p.daemonPk} class="setting">
              <span>{p.host ?? t('This computer')}</span>
              <span class="muted">{t('Connected')}</span>
            </div>
          ) : (
            <button key={p.daemonPk} class="setting" onClick={() => switchProfile(p)}>
              <span>{p.host ?? t('Your other computer')}</span>
              <span class="muted">{t('Switch')}</span>
              <ChevronRight size={15} />
            </button>
          ),
        )}
        {native ? (
          <button class="setting" onClick={() => go('/scan')}>
            <span>{t('Pair another computer')}</span>
            <ChevronRight size={15} />
          </button>
        ) : (
          <small class="muted">{t('To add a computer, scan the pairing QR code in Savor on it.')}</small>
        )}
      </div>
    </details>
  )
}

// Savor has no accounts: this is the computer it runs on, or on a paired device, that device.
export function AccountDialog({ me, projects, toggleAwake, open, onClose }: { me: Me; projects: number; toggleAwake: () => void; open: (what: 'feedback' | 'appearance' | 'shortcuts') => void; onClose: () => void }) {
  const local = me.origin === 'local'
  const prefs = usePrefs()
  const [canNotify, notifyOn, toggleNotify] = useNotificationToggle(!local)
  const [update, setUpdate] = useState('')
  const [available, setAvailable] = useState(false)
  const checkUpdate = async () => {
    setUpdate(t('checking…'))
    const version = await desktop!.checkForUpdates().catch(() => undefined)
    setUpdate(version ? t('{version} is available', { version }) : version === null ? t('up to date') : t('could not check for updates'))
    setAvailable(!!version)
  }
  const installUpdate = () => {
    setUpdate(t('installing, Savor restarts…'))
    desktop!.installUpdate().catch(() => setUpdate(t('could not install the update')))
  }
  const forget = () => confirm(t('Forget this computer on this device? You will need to pair again.')) && forgetProfile().then(() => location.replace('/'))
  return (
    <div class="overlay" onClick={onClose}>
      <div class="dialog account-dialog" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          {local ? <Laptop size={18} /> : <Smartphone size={18} />}
          <div class="dialog-title">
            <b>{local ? t('This computer') : t('This device')}</b>
          </div>
          <button class="icon-btn" title={t('Close')} onClick={onClose}>
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
                  {available ? t('Install and restart') : t('Check for updates')}
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
                  {t('Remote device · connected to {host}', { host: me.host })}
                  {loadProfile() ? ` ${t('via relay')}` : ''}
                </small>
              </div>
            </div>
          )}
          {!local && loadProfile() && <Computers />}
          {local && <MyDevices me={me} projects={projects} />}
          {local && <Agents />}
          {local && <VoiceInput />}
          <details class="box">
            <summary>
              <span class="tile">
                <SlidersHorizontal size={16} />
              </span>
              {t('App settings')} <ChevronDown size={16} class="chev" />
            </summary>
            <div class="box-body">
              {local && (
                <div class="setting">
                  <span>{t('Keep this computer awake')}</span>
                  <button class={`switch ${me.awake ? 'on' : ''}`} role="switch" aria-checked={me.awake} onClick={toggleAwake}>
                    <i />
                  </button>
                </div>
              )}
              {local && <UpdateSettings />}
              {canNotify && (
                <div class="setting">
                  <span>{t('Notifications')}</span>
                  <button class={`switch ${notifyOn ? 'on' : ''}`} role="switch" aria-checked={notifyOn} onClick={toggleNotify}>
                    <i />
                  </button>
                </div>
              )}
              {local && <PushDelay />}
              <div class="setting">
                <span>
                  {t('Bug button')}
                  <small class="muted">{t('Reports a bug with a screenshot of the screen')}</small>
                </span>
                <button class={`switch ${prefs.bugButton ? 'on' : ''}`} role="switch" aria-checked={prefs.bugButton} onClick={() => setPrefs({ bugButton: !prefs.bugButton })}>
                  <i />
                </button>
              </div>
              <div class="setting wide-only">
                <span>
                  {t('Free windows')}
                  <small class="muted">{t('Expert mode: move and resize panels anywhere, they may overlap')}</small>
                </span>
                <button class={`switch ${prefs.freeWindows ? 'on' : ''}`} role="switch" aria-checked={prefs.freeWindows} onClick={() => setPrefs({ freeWindows: !prefs.freeWindows })}>
                  <i />
                </button>
              </div>
              <div class="setting wide-only">
                <span>
                  {t('Layout')}
                  <small class="muted">{t('Puts every panel back in its place and size')}</small>
                </span>
                <button class="ghost" disabled={!prefs.layout && !prefs.windows} onClick={resetLayout}>
                  {t('Reset')}
                </button>
              </div>
              <button class="setting" onClick={() => open('appearance')}>
                <span>{t('Appearance')}</span>
                <span class="muted">{THEMES.find(([id]) => id === prefs.theme)?.[1]}</span>
                <ChevronRight size={15} />
              </button>
              <button class="setting wide-only" onClick={() => open('shortcuts')}>
                <span>{t('Keyboard shortcuts')}</span>
                <span class="muted">{Object.keys(prefs.shortcuts).length ? t('{n} set', { n: Object.keys(prefs.shortcuts).length }) : t('None set')}</span>
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
              {t('Community')} <ChevronDown size={16} class="chev" />
            </summary>
            <div class="box-body">
              <button class="ghost wide" onClick={() => open('feedback')}>
                <MessageSquare size={15} /> {t('Send feedback')}
              </button>
              <label class="check wide-only">
                <input type="checkbox" checked={prefs.feedbackButton} onChange={(e) => setPrefs({ feedbackButton: e.currentTarget.checked })} /> {t('Show feedback in toolbar')}
              </label>
              <div class="row">
                <a class="ghost" href={REPO} target="_blank" rel="noreferrer">
                  {t('GitHub')} <ArrowUpRight size={14} />
                </a>
                <a class="ghost" href={`${REPO}/issues`} target="_blank" rel="noreferrer">
                  {t('Report an issue')} <ArrowUpRight size={14} />
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
                {t('Forget this computer')}
              </button>
            )}
            <button class="primary" onClick={onClose}>
              {t('Done')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
