import { useEffect, useState } from 'preact/hooks'
import qrcode from 'qrcode-generator'
import { Download, Smartphone, Trash2, X } from 'lucide-preact'
import { api, formatDay, go, PROVIDER_NAMES, useApi, useAgents, type ImportableSession, type Project, type Thread } from './api'
import { pairThroughRelay } from './transport'
import { parsePairingLink, scanQrCode } from './native'
import { TEMPLATES } from './templates'
import { plural, t } from './i18n'

const TINTS = ['#b5654a', '#8b6bc7', '#3f9a78', '#c59a3d', '#c8577a', '#4a9bb8', '#7a8794']

export function Settings({ project }: { project: Project }) {
  const [draft, setDraft] = useState({ name: project.name, tint: project.tint, verbosity: project.verbosity, paused: project.paused, agent: project.agent, worktreeSetup: project.worktreeSetup, type: project.type ?? '' })
  const [role, setRole] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const agents = useAgents()
  useEffect(() => void api<{ role: string }>('GET', `/projects/${project.id}/role`).then((r) => setRole(r.role)), [project.id])
  const set = (patch: Partial<typeof draft>) => {
    setSaved(false)
    setDraft({ ...draft, ...patch })
  }

  const save = async (e: Event) => {
    e.preventDefault()
    try {
      await api('PATCH', `/projects/${project.id}`, { ...draft, role })
      setError('')
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  const remove = async () => {
    if (!confirm(t('Remove {name} from Savor? Files stay on disk.', { name: project.name }))) return
    await api('DELETE', `/projects/${project.id}`)
    go('/')
  }

  return (
    <div class="page">
      <form class="form" onSubmit={save}>
        <h1>{t('Project settings')}</h1>
        <p class="muted mono">{project.path}</p>
        <label>
          {t('Name')}
          <input value={draft.name} onInput={(e) => set({ name: e.currentTarget.value })} />
        </label>
        <div>
          <div class="field-label">{t('Color')}</div>
          <div class="swatches">
            {TINTS.map((t) => (
              <button type="button" key={t} class={`swatch ${draft.tint === t ? 'selected' : ''}`} style={{ background: t }} onClick={() => set({ tint: t })} aria-label={t} />
            ))}
          </div>
        </div>
        <label>
          {t('Type')} <small class="muted">{t('adds the type\'s own tab: Export for academic writing, Today for a Kontor')}</small>
          <select value={draft.type} onChange={(e) => set({ type: e.currentTarget.value })}>
            <option value="">{t('Code')}</option>
            {TEMPLATES.map((tpl) => (
              <option key={tpl.slug} value={tpl.slug}>
                {t(tpl.title)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Role & instructions')} <small class="muted">{t('ROLE.md — every agent in this project gets this')}</small>
          <textarea rows={8} value={role ?? ''} placeholder={t('e.g. You are the engineer for a small bakery\'s ordering app. Keep the UI in German.')} onInput={(e) => (setSaved(false), setRole(e.currentTarget.value))} />
        </label>
        <label>
          {t('Worktree setup')} <small class="muted">{t('runs in every new worktree before the agent starts; gitignored files named in .worktreeinclude, such as .env, are copied over first')}</small>
          <textarea class="mono" rows={2} value={draft.worktreeSetup} placeholder={t('e.g. npm install')} onInput={(e) => set({ worktreeSetup: e.currentTarget.value })} />
        </label>
        <div class="row wide">
          <label>
            {t('Agent verbosity')}
            <select value={draft.verbosity} onChange={(e) => set({ verbosity: e.currentTarget.value as Project['verbosity'] })}>
              <option value="low">{t('Low — just results')}</option>
              <option value="medium">{t('Medium')}</option>
              <option value="high">{t('High — explain everything')}</option>
            </select>
          </label>
          <label>
            {t('Default agent')}
            <select
              value={draft.agent.provider}
              onChange={(e) => {
                const info = agents?.find((a) => a.id === e.currentTarget.value)
                set({ agent: { ...draft.agent, provider: e.currentTarget.value, model: '', reasoning: info?.defaultEffort ?? '', permissionMode: info?.defaultMode ?? 'default' } })
              }}
            >
              {Object.entries(PROVIDER_NAMES).map(([id, name]) => {
                const info = agents?.find((a) => a.id === id)
                return (
                  <option key={id} value={id}>
                    {name}
                    {info && !info.installed ? t(' (not installed)') : ''}
                  </option>
                )
              })}
            </select>
          </label>
        </div>
        <label class="check">
          <input type="checkbox" checked={draft.paused} onChange={(e) => set({ paused: e.currentTarget.checked })} /> {t('Pause project — scheduled workflows don\'t run')}
        </label>
        <div class="row">
          <button class="primary" type="submit">
            {t('Save')}
          </button>
          {saved && <span class="muted">{t('Saved.')}</span>}
          {error && <span class="error-text">{error}</span>}
          <span class="spacer" />
          <button type="button" class="ghost danger" onClick={remove}>
            {t('Remove project')}
          </button>
        </div>
      </form>
      <MoveSection project={project} />
      <ImportSection project={project} />
    </div>
  )
}

interface MovePlan { from: string; to: string; mode: 'move' | 'relink'; blockers: string[]; processes: { pid: number; command: string }[]; symlink: boolean; claudeSessions: number; worktrees: number }


// Renaming or moving the folder, archiving it, or pointing the project at the place it already moved to.
function MoveSection({ project }: { project: Project }) {
  const [target, setTarget] = useState(project.path)
  const [plan, setPlan] = useState<MovePlan | null>(null)
  const [link, setLink] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const parent = project.path.slice(0, project.path.lastIndexOf('/'))
  const archived = parent.endsWith('/_archive')
  const check = async (to: string) => {
    setTarget(to)
    setDone('')
    setError('')
    try {
      setPlan(await api<MovePlan>('POST', `/projects/${project.id}/move`, { path: to, dryRun: true }))
    } catch (e) {
      setPlan(null)
      setError((e as Error).message)
    }
  }
  const run = async () => {
    setBusy(true)
    try {
      const moved = await api<Project>('POST', `/projects/${project.id}/move`, { path: plan!.to, link, force: plan!.processes.length > 0 })
      setDone(t('The project is now at {path}.', { path: moved.path }))
      setTarget(moved.path)
      setPlan(null)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="form move-section">
      <h2>{t('Move folder')}</h2>
      <p class="muted">{t('Rename or move the project folder, or point the project at the place it already moved to. Conversations, worktrees and Claude Code sessions come along.')}</p>
      <form class="row" onSubmit={(e) => (e.preventDefault(), check(target))}>
        <input class="mono" value={target} onInput={(e) => (setPlan(null), setTarget(e.currentTarget.value))} aria-label={t('New path')} />
        <button type="submit" class="ghost" disabled={!target.trim() || target === project.path}>
          {t('Check')}
        </button>
        {!archived && (
          <button type="button" class="ghost" onClick={() => check(`${parent}/_archive/${project.path.slice(parent.length + 1)}`)}>
            {t('Archive')}
          </button>
        )}
      </form>
      {error && <p class="error-text">{error}</p>}
      {done && <p class="muted">{done}</p>}
      {plan && (
        <div class="move-plan">
          <p>
            {plan.mode === 'move' ? t('Moves the folder to {path}.', { path: plan.to }) : t('{path} already is this folder: the project points there.', { path: plan.to })}
            {plan.claudeSessions > 0 && ` ${plural(plan.claudeSessions, '{n} Claude Code session moves along.', '{n} Claude Code sessions move along.')}`}
            {plan.worktrees > 0 && ` ${plural(plan.worktrees, '{n} worktree gets repaired.', '{n} worktrees get repaired.')}`} {t('Savor\'s terminals of this project close.')}
          </p>
          {plan.blockers.map((b) => (
            <p key={b} class="error-text">
              {b}
            </p>
          ))}
          {plan.processes.length > 0 && (
            <div>
              <p class="warning-text">{t('Processes outside Savor work in the folder. They keep running in the old place:')}</p>
              <pre class="mono small">{plan.processes.map((p) => `${p.pid}  ${p.command}`).join('\n')}</pre>
            </div>
          )}
          {(plan.mode === 'move' || plan.symlink) && (
            <label class="check">
              <input type="checkbox" checked={link} onChange={(e) => setLink(e.currentTarget.checked)} /> {plan.mode === 'move' ? t('Leave a symlink at the old path') : t('Keep the symlink {path}', { path: plan.from })}
            </label>
          )}
          {!plan.blockers.length && (
            <div class="row">
              <button type="button" class="primary" disabled={busy} onClick={run}>
                {busy ? t('Moving…') : plan.processes.length ? t('Move anyway') : plan.mode === 'move' ? t('Move') : t('Point here')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Conversations from Claude Code and Codex sessions that ran in this folder outside Savor.
function ImportSection({ project }: { project: Project }) {
  const [open, setOpen] = useState(false)
  return (
    <div class="form">
      <h2>{t('Import conversations')}</h2>
      <p class="muted">{t('Claude Code and Codex keep transcripts of the sessions you ran in this folder. Bring them in as conversations; they continue with the same agent session.')}</p>
      <div class="row">
        <button type="button" class="ghost" onClick={() => setOpen(true)}>
          <Download size={14} /> {t('Import conversations…')}
        </button>
      </div>
      {open && <ImportDialog project={project} onClose={() => setOpen(false)} />}
    </div>
  )
}

function ImportDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [sessions, setSessions] = useState<ImportableSession[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Thread[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api<ImportableSession[]>('GET', `/projects/${project.id}/import`).then(
      (list) => {
        setSessions(list)
        setChosen(new Set(list.filter((s) => !s.imported).map((s) => s.id)))
      },
      (e: Error) => setError(e.message),
    )
  }, [])
  const toggle = (id: string) => setChosen((c) => {
    const next = new Set(c)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const run = async () => {
    setBusy(true)
    try {
      setDone(await api<Thread[]>('POST', `/projects/${project.id}/import`, { sessions: sessions!.filter((s) => chosen.has(s.id)).map(({ provider, id }) => ({ provider, id })) }))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="overlay" onClick={onClose}>
      <div class="dialog import-dialog" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          <Download size={18} />
          <div class="dialog-title">
            <b>{t('Import conversations')}</b>
            <small class="muted">{t('Sessions that ran in {path}', { path: project.path })}</small>
          </div>
          <button class="icon-btn" title={t('Close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div class="dialog-body">
          {error && <div class="error-text pad">{error}</div>}
          {done ? (
            <p class="pad">
              {plural(done.length, 'Imported {n} conversation.', 'Imported {n} conversations.')}{' '}
              <a class="link" href={`#/p/${project.id}`} onClick={onClose}>
                {t('Open conversations')}
              </a>
            </p>
          ) : sessions === null ? (
            <p class="muted pad">{t('Looking for sessions…')}</p>
          ) : !sessions.length ? (
            <p class="muted pad">{t('No Claude Code or Codex sessions found for this folder.')}</p>
          ) : (
            sessions.map((s) => (
              <label key={s.id} class={`import-row ${s.imported ? 'done' : ''}`}>
                <input type="checkbox" disabled={s.imported} checked={!s.imported && chosen.has(s.id)} onChange={() => toggle(s.id)} />
                <span class="import-title">{s.title}</span>
                <span class="muted small">
                  {PROVIDER_NAMES[s.provider]} · {formatDay(s.startedAt)} · {plural(s.messages, '{n} message', '{n} messages')}
                  {s.imported ? t(' · imported') : ''}
                </span>
              </label>
            ))
          )}
        </div>
        {!done && sessions?.length ? (
          <footer class="dialog-foot">
            <span class="muted small">{t('{n} selected', { n: chosen.size })}</span>
            <button class="primary" disabled={!chosen.size || busy} onClick={run}>
              {busy ? t('Importing…') : t('Import {n}', { n: chosen.size })}
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  )
}

export interface DeviceRow { id: string; name: string; via: 'lan' | 'relay'; terminal?: boolean; createdAt: string; lastSeenAt: string | null }
export interface RelayState { url: string | null; enabled: boolean; state: 'off' | 'connecting' | 'online' | 'error'; error?: string; id?: string }

export const RELAY_LABEL = { off: t('Off'), connecting: t('Connecting…'), online: t('Connected'), error: t('Not connected') }

export function qr(text: string) {
  const q = qrcode(0, 'M')
  q.addData(text)
  q.make()
  return q.createSvgTag({ cellSize: 5, margin: 2, scalable: true })
}

export function Devices() {
  const [devices] = useApi<DeviceRow[]>('/devices', (e) => e.type === 'devices')
  const [relay] = useApi<RelayState>('/relay', (e) => e.type === 'devices')
  const [relayUrl, setRelayUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState<{ code: string; url: string; relayUrl: string | null; expiresAt: string } | null>(null)
  const [address, setAddress] = useState<{ url: string | null; fallback: string } | null>(null)
  const [addressDraft, setAddressDraft] = useState<string | null>(null)
  const [shortcutName, setShortcutName] = useState(t('iPhone shortcut'))
  const [shortcutToken, setShortcutToken] = useState<string | null>(null)
  const [creatingToken, setCreatingToken] = useState(false)
  useEffect(() => void api('GET', '/devices/address').then(setAddress), [])
  // Allowing a device voids every open code, so the QR code goes too.
  useEffect(() => setPairing(null), [devices?.length])
  const saveAddress = async () => {
    try {
      setAddress(await api('PUT', '/devices/address', { url: addressDraft ?? '' }))
      setAddressDraft(null)
      setPairing(null)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const revoke = (d: DeviceRow) => confirm(t('Revoke access for {name}?', { name: d.name })) && api('DELETE', `/devices/${d.id}`)
  const createToken = async () => {
    setCreatingToken(true)
    try {
      setShortcutToken((await api('POST', '/devices/token', { name: shortcutName })).token)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCreatingToken(false)
    }
  }
  const saveRelay = async (enabled: boolean) => {
    try {
      await api('PUT', '/relay', { url: relayUrl ?? relay?.url ?? '', enabled })
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const link = pairing?.relayUrl ?? pairing?.url

  return (
    <div class="page">
      <div class="form">
        <h1>{t('Devices & remote access')}</h1>
        <p class="muted">
          {t('Pair your phone or another computer to use Savor remotely. Requests from paired devices are marked as remote, and agents treat them with extra care.')}
        </p>

        <h2>{t('Relay')}</h2>
        <p class="muted">
          {t('A relay lets paired devices reach this computer from anywhere, without a VPN or open ports. Traffic is end-to-end encrypted between the device and this computer; the relay only forwards ciphertext. The relay does serve the web app, so use one you trust or run your own')} (<code>npm run relay</code>).
        </p>
        <div class="row wide">
          <label>
            {t('Relay URL')}
            <input placeholder="https://relay.example.com" value={relayUrl ?? relay?.url ?? ''} onInput={(e) => setRelayUrl(e.currentTarget.value)} />
          </label>
        </div>
        <div class="row">
          {relay?.enabled ? (
            <button class="ghost" onClick={() => saveRelay(false)}>
              {t('Turn off')}
            </button>
          ) : (
            <button class="primary" onClick={() => saveRelay(true)}>
              {t('Connect')}
            </button>
          )}
          {relay && (
            <span class={`relay-state ${relay.state}`}>
              <i /> {RELAY_LABEL[relay.state]}
              {relay.state === 'error' && relay.error ? ` · ${relay.error}` : ''}
            </span>
          )}
        </div>
        {error && <div class="error-text">{error}</div>}

        <h2>{t('Pair a device')}</h2>
        <p class="muted">
          {relay?.state === 'online'
            ? t('The QR code opens Savor through the relay.')
            : t('Without a relay, the device has to reach this computer directly: same network, or a VPN such as Tailscale.')}
        </p>
        {relay?.state !== 'online' && (
          <div class="row wide">
            <label>
              {t('Address of this computer for paired devices')}{' '}
              <small class="muted">
                {t('e.g. the HTTPS address {command} gives it, or its LAN address with Savor started as SAVOR_HOST=0.0.0.0', { command: `tailscale serve ${new URL(address?.fallback ?? 'http://localhost:4317').port}` })}
              </small>
              <input placeholder={address?.fallback ?? ''} value={addressDraft ?? address?.url ?? ''} onInput={(e) => setAddressDraft(e.currentTarget.value)} />
            </label>
            {addressDraft !== null && addressDraft !== (address?.url ?? '') && (
              <button class="ghost" onClick={saveAddress}>
                {t('Save')}
              </button>
            )}
          </div>
        )}
        <div class="row">
          <button class="primary" onClick={async () => setPairing(await api('POST', '/devices/pairing'))}>
            <Smartphone size={15} /> {t('Pair a device')}
          </button>
        </div>
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

        <h2>{t('Shortcut token')}</h2>
        <p class="muted">{t('For iOS Shortcuts or other HTTP clients that reach this computer directly over your network or VPN. The token has the same access as a paired device. Revoke it in the device list below.')}</p>
        {shortcutToken ? (
          <div class="pairing">
            <div>
              <p>{t('Copy this Cookie header into your shortcut. It is shown only here, until you dismiss it or leave this page.')}</p>
              <input aria-label={t('Shortcut Cookie header')} class="mono" readOnly value={`savor_device=${shortcutToken}`} onFocus={(e) => e.currentTarget.select()} />
              <button class="ghost" onClick={() => setShortcutToken(null)}>{t('Done')}</button>
            </div>
          </div>
        ) : (
          <div class="row wide">
            <label>
              {t('Shortcut name')}
              <input value={shortcutName} onInput={(e) => setShortcutName(e.currentTarget.value)} />
            </label>
            <button class="primary" disabled={creatingToken || !shortcutName.trim()} onClick={createToken}>{t('Create token')}</button>
          </div>
        )}

        <h2>{t('Paired devices')}</h2>
        <p class="muted">
          {t('The terminal is a shell on this computer. A device you allow it can open one in every project folder and worktree and run any command as you. Turning it off or revoking the device ends its terminals right away.')}
        </p>
        {devices && !devices.length && <p class="muted">{t('None yet.')}</p>}
        {devices?.map((d) => (
          <div key={d.id} class="device">
            <Smartphone size={18} />
            <div>
              <b>{d.name}</b>
              <small class="muted">
                {d.via === 'relay' ? t('Via relay') : t('Direct')} · {t('paired {when}', { when: new Date(d.createdAt).toLocaleDateString() })} · {t('last seen {when}', { when: d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : t('never') })}
              </small>
            </div>
            <label class="check">
              <input type="checkbox" checked={!!d.terminal} onChange={(e) => api('PATCH', `/devices/${d.id}`, { terminal: e.currentTarget.checked })} /> {t('Terminal')}
            </label>
            <button class="ghost danger" onClick={() => revoke(d)}>
              <Trash2 size={14} /> {t('Revoke')}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

const spaced = (check: string) => `${check.slice(0, 3)} ${check.slice(3)}`

// A device with a valid code waits until it is allowed here. Both show the same number, so a request
// from someone else who got hold of the code stands out.
export function PairingRequests() {
  const [requests] = useApi<{ id: string; name: string; via: 'relay' | 'lan'; check: string }[]>('/devices/requests', (e) => e.type === 'devices')
  const request = requests?.[0]
  if (!request) return null
  const decide = (approve: boolean) => api('POST', `/devices/requests/${request.id}`, { approve }).catch(() => {})
  return (
    <div class="overlay">
      <div class="dialog pick-dialog pairing-request">
        <header class="dialog-head">
          <Smartphone size={18} />
          <div class="dialog-title">
            <b>{t('Allow “{name}”?', { name: request.name })}</b>
          </div>
        </header>
        <div class="dialog-body">
          <p>
            {request.via === 'relay' ? t('A device wants to use Savor on this computer through the relay. Only allow it if it is yours and shows this number:') : t('A device wants to use Savor on this computer directly. Only allow it if it is yours and shows this number:')}
          </p>
          <b class="check-number">{spaced(request.check)}</b>
          <p class="muted">{t('If you didn\'t just pair a device, decline and don\'t share the pairing code again.')}</p>
        </div>
        <footer class="dialog-foot">
          <button class="ghost danger" onClick={() => decide(false)}>
            {t('Decline')}
          </button>
          <button class="primary" onClick={() => decide(true)}>
            {t('Allow')}
          </button>
        </footer>
      </div>
    </div>
  )
}

function Waiting({ check }: { check: string }) {
  return (
    <div class="gate">
      <img src="/icon.svg" alt="" />
      <h1>{t('Allow this device on your computer')}</h1>
      <p class="muted">{t('Your computer asks whether to let this device in. Check that it shows the same number:')}</p>
      <b class="check-number">{spaced(check)}</b>
    </div>
  )
}

// Pairing a phone through the relay: the QR code carries the computer's public key and a one-time code.
export function RemotePair({ daemonPk, code, relay }: { daemonPk: string; code: string; relay?: string }) {
  const [name, setName] = useState(/iPhone|Android|iPad/.exec(navigator.userAgent)?.[0] ?? t('My phone'))
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState('')
  const [error, setError] = useState('')
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    try {
      await pairThroughRelay(daemonPk, code, name, setCheck, relay)
      location.replace('/')
    } catch (err) {
      setError((err as Error).message)
      setCheck('')
      setBusy(false)
    }
  }
  if (check) return <Waiting check={check} />
  return (
    <div class="gate">
      <img src="/icon.svg" alt="" />
      <h1>{t('Pair this device')}</h1>
      <p class="muted">{t('The connection to your computer is end-to-end encrypted; the relay only passes it on.')}</p>
      <form class="form" onSubmit={submit}>
        <label>
          {t('Device name')}
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        {error && <div class="error-text">{error}</div>}
        <button class="primary" disabled={busy}>
          {busy ? t('Pairing…') : t('Pair')}
        </button>
      </form>
    </div>
  )
}

// In the iOS app: scan the QR code, or paste the pairing link when the camera can't.
export function AppPair() {
  const [link, setLink] = useState('')
  const [pairing, setPairing] = useState<ReturnType<typeof parsePairingLink>>(null)
  const [error, setError] = useState('')
  const use = (text: string) => {
    const next = parsePairingLink(text)
    setPairing(next)
    setError(next ? '' : t('That is not a Savor pairing link.'))
  }
  const scan = () => scanQrCode().then(use, (e) => setError((e as Error).message))
  if (pairing) return <RemotePair {...pairing} />
  return (
    <div class="gate">
      <img src="/icon.svg" alt="" />
      <h1>{t('Pair with your computer')}</h1>
      <p class="muted">{t('Open Savor on your computer, go to Devices & remote access → Pair a device, and scan the QR code.')}</p>
      <button class="primary" onClick={scan}>
        {t('Scan QR code')}
      </button>
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault()
          use(link)
        }}
      >
        <label>
          {t('Or paste the pairing link')}
          <input value={link} onInput={(e) => setLink(e.currentTarget.value)} placeholder="https://…/#/rpair/…" />
        </label>
        {error && <div class="error-text">{error}</div>}
        <button class="ghost" disabled={!link.trim()}>
          {t('Continue')}
        </button>
      </form>
    </div>
  )
}

export function Pair({ code: initial }: { code?: string }) {
  const [code, setCode] = useState(initial ?? '')
  const [name, setName] = useState(/iPhone|Android|iPad/.exec(navigator.userAgent)?.[0] ?? t('My device'))
  const [check, setCheck] = useState('')
  const [error, setError] = useState('')
  const submit = async (e: Event) => {
    e.preventDefault()
    const next = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')
    setCheck(next)
    const r = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, check: next }) }).catch(() => null)
    if (r?.ok) return location.replace('/')
    setCheck('')
    setError((await r?.json().catch(() => null))?.error ?? t('Pairing failed'))

  }
  if (check) return <Waiting check={check} />
  return (
    <div class="gate">
      <img src="/icon.svg" alt="" />
      <h1>{t('Pair this device')}</h1>
      <form class="form" onSubmit={submit}>
        <label>
          {t('Pairing code')}
          <input value={code} onInput={(e) => setCode(e.currentTarget.value)} autoFocus={!initial} />
        </label>
        <label>
          {t('Device name')}
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        {error && <div class="error-text">{error}</div>}
        <button class="primary" disabled={!code.trim()}>
          {t('Pair')}
        </button>
      </form>
    </div>
  )
}
