import { useEffect, useState } from 'preact/hooks'
import qrcode from 'qrcode-generator'
import { Download, Smartphone, Trash2, X } from 'lucide-preact'
import { api, formatDay, go, PROVIDER_NAMES, useApi, useAgents, type ImportableSession, type Project, type Thread } from './api'
import { pairThroughRelay } from './transport'

const TINTS = ['#b5654a', '#8b6bc7', '#3f9a78', '#c59a3d', '#c8577a', '#4a9bb8', '#7a8794']

export function Settings({ project }: { project: Project }) {
  const [draft, setDraft] = useState({ name: project.name, tint: project.tint, verbosity: project.verbosity, paused: project.paused, agent: project.agent })
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
    if (!confirm(`Remove ${project.name} from Savor? Files stay on disk.`)) return
    await api('DELETE', `/projects/${project.id}`)
    go('/')
  }

  return (
    <div class="page">
      <form class="form" onSubmit={save}>
        <h1>Project settings</h1>
        <p class="muted mono">{project.path}</p>
        <label>
          Name
          <input value={draft.name} onInput={(e) => set({ name: e.currentTarget.value })} />
        </label>
        <div>
          <div class="field-label">Color</div>
          <div class="swatches">
            {TINTS.map((t) => (
              <button type="button" key={t} class={`swatch ${draft.tint === t ? 'selected' : ''}`} style={{ background: t }} onClick={() => set({ tint: t })} aria-label={t} />
            ))}
          </div>
        </div>
        <label>
          Role & instructions <small class="muted">ROLE.md — every agent in this project gets this</small>
          <textarea rows={8} value={role ?? ''} placeholder="e.g. You are the engineer for a small bakery's ordering app. Keep the UI in German." onInput={(e) => (setSaved(false), setRole(e.currentTarget.value))} />
        </label>
        <div class="row wide">
          <label>
            Agent verbosity
            <select value={draft.verbosity} onChange={(e) => set({ verbosity: e.currentTarget.value as Project['verbosity'] })}>
              <option value="low">Low — just results</option>
              <option value="medium">Medium</option>
              <option value="high">High — explain everything</option>
            </select>
          </label>
          <label>
            Default agent
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
                    {info && !info.installed ? ' (not installed)' : ''}
                  </option>
                )
              })}
            </select>
          </label>
        </div>
        <label class="check">
          <input type="checkbox" checked={draft.paused} onChange={(e) => set({ paused: e.currentTarget.checked })} /> Pause project — scheduled workflows don't run
        </label>
        <div class="row">
          <button class="primary" type="submit">
            Save
          </button>
          {saved && <span class="muted">Saved.</span>}
          {error && <span class="error-text">{error}</span>}
          <span class="spacer" />
          <button type="button" class="ghost danger" onClick={remove}>
            Remove project
          </button>
        </div>
      </form>
      <ImportSection project={project} />
    </div>
  )
}

// Conversations from Claude Code and Codex sessions that ran in this folder outside Savor.
function ImportSection({ project }: { project: Project }) {
  const [open, setOpen] = useState(false)
  return (
    <div class="form">
      <h2>Import conversations</h2>
      <p class="muted">Claude Code and Codex keep transcripts of the sessions you ran in this folder. Bring them in as conversations; they continue with the same agent session.</p>
      <div class="row">
        <button type="button" class="ghost" onClick={() => setOpen(true)}>
          <Download size={14} /> Import conversations…
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
            <b>Import conversations</b>
            <small class="muted">Sessions that ran in {project.path}</small>
          </div>
          <button class="icon-btn" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div class="dialog-body">
          {error && <div class="error-text pad">{error}</div>}
          {done ? (
            <p class="pad">
              Imported {done.length} conversation{done.length === 1 ? '' : 's'}.{' '}
              <a class="link" href={`#/p/${project.id}`} onClick={onClose}>
                Open conversations
              </a>
            </p>
          ) : sessions === null ? (
            <p class="muted pad">Looking for sessions…</p>
          ) : !sessions.length ? (
            <p class="muted pad">No Claude Code or Codex sessions found for this folder.</p>
          ) : (
            sessions.map((s) => (
              <label key={s.id} class={`import-row ${s.imported ? 'done' : ''}`}>
                <input type="checkbox" disabled={s.imported} checked={!s.imported && chosen.has(s.id)} onChange={() => toggle(s.id)} />
                <span class="import-title">{s.title}</span>
                <span class="muted small">
                  {PROVIDER_NAMES[s.provider]} · {formatDay(s.startedAt)} · {s.messages} message{s.messages === 1 ? '' : 's'}
                  {s.imported ? ' · imported' : ''}
                </span>
              </label>
            ))
          )}
        </div>
        {!done && sessions?.length ? (
          <footer class="dialog-foot">
            <span class="muted small">{chosen.size} selected</span>
            <button class="primary" disabled={!chosen.size || busy} onClick={run}>
              {busy ? 'Importing…' : `Import ${chosen.size}`}
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  )
}

export interface DeviceRow { id: string; name: string; via: 'lan' | 'relay'; createdAt: string; lastSeenAt: string | null }
export interface RelayState { url: string | null; enabled: boolean; state: 'off' | 'connecting' | 'online' | 'error'; error?: string; id?: string }

export const RELAY_LABEL = { off: 'Off', connecting: 'Connecting…', online: 'Connected', error: 'Not connected' }

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
  useEffect(() => void api('GET', '/devices/address').then(setAddress), [])
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

  const revoke = (d: DeviceRow) => confirm(`Revoke access for ${d.name}?`) && api('DELETE', `/devices/${d.id}`)
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
        <h1>Devices & remote access</h1>
        <p class="muted">
          Pair your phone or another computer to use Savor remotely. Requests from paired devices are marked as remote, and agents treat them with extra care.
        </p>

        <h2>Relay</h2>
        <p class="muted">
          A relay lets paired devices reach this computer from anywhere, without a VPN or open ports. Traffic is end-to-end encrypted between the device and this computer; the relay only forwards
          ciphertext. The relay does serve the web app, so use one you trust or run your own (<code>npm run relay</code>).
        </p>
        <div class="row wide">
          <label>
            Relay URL
            <input placeholder="https://relay.example.com" value={relayUrl ?? relay?.url ?? ''} onInput={(e) => setRelayUrl(e.currentTarget.value)} />
          </label>
        </div>
        <div class="row">
          {relay?.enabled ? (
            <button class="ghost" onClick={() => saveRelay(false)}>
              Turn off
            </button>
          ) : (
            <button class="primary" onClick={() => saveRelay(true)}>
              Connect
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

        <h2>Pair a device</h2>
        <p class="muted">
          {relay?.state === 'online'
            ? 'The QR code opens Savor through the relay.'
            : 'Without a relay, the device has to reach this computer directly: same network, or a VPN such as Tailscale.'}
        </p>
        {relay?.state !== 'online' && (
          <div class="row wide">
            <label>
              Address of this computer for paired devices{' '}
              <small class="muted">
                e.g. the HTTPS address <code>tailscale serve {new URL(address?.fallback ?? 'http://localhost:4317').port}</code> gives it, or its LAN address with Savor started as SAVOR_HOST=0.0.0.0
              </small>
              <input placeholder={address?.fallback ?? ''} value={addressDraft ?? address?.url ?? ''} onInput={(e) => setAddressDraft(e.currentTarget.value)} />
            </label>
            {addressDraft !== null && addressDraft !== (address?.url ?? '') && (
              <button class="ghost" onClick={saveAddress}>
                Save
              </button>
            )}
          </div>
        )}
        <div class="row">
          <button class="primary" onClick={async () => setPairing(await api('POST', '/devices/pairing'))}>
            <Smartphone size={15} /> Pair a device
          </button>
        </div>
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

        <h2>Paired devices</h2>
        {devices && !devices.length && <p class="muted">None yet.</p>}
        {devices?.map((d) => (
          <div key={d.id} class="device">
            <Smartphone size={18} />
            <div>
              <b>{d.name}</b>
              <small class="muted">
                {d.via === 'relay' ? 'Via relay' : 'Direct'} · paired {new Date(d.createdAt).toLocaleDateString()} · last seen {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'never'}
              </small>
            </div>
            <button class="ghost danger" onClick={() => revoke(d)}>
              <Trash2 size={14} /> Revoke
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// Pairing a phone through the relay: the QR code carries the computer's public key and a one-time code.
export function RemotePair({ daemonPk, code }: { daemonPk: string; code: string }) {
  const [name, setName] = useState(/iPhone|Android|iPad/.exec(navigator.userAgent)?.[0] ?? 'My phone')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    try {
      await pairThroughRelay(daemonPk, code, name)
      location.replace('/')
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <div class="gate">
      <img src="/icon.svg" alt="" />
      <h1>Pair this device</h1>
      <p class="muted">The connection to your computer is end-to-end encrypted; the relay only passes it on.</p>
      <form class="form" onSubmit={submit}>
        <label>
          Device name
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        {error && <div class="error-text">{error}</div>}
        <button class="primary" disabled={busy}>
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </form>
    </div>
  )
}

export function Pair({ code: initial }: { code?: string }) {
  const [code, setCode] = useState(initial ?? '')
  const [name, setName] = useState(/iPhone|Android|iPad/.exec(navigator.userAgent)?.[0] ?? 'My device')
  const [error, setError] = useState('')
  const submit = async (e: Event) => {
    e.preventDefault()
    const r = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) })
    if (!r.ok) return setError((await r.json()).error ?? 'Pairing failed')
    location.replace('/')
  }
  return (
    <div class="gate">
      <img src="/icon.svg" alt="" />
      <h1>Pair this device</h1>
      <form class="form" onSubmit={submit}>
        <label>
          Pairing code
          <input value={code} onInput={(e) => setCode(e.currentTarget.value)} autoFocus={!initial} />
        </label>
        <label>
          Device name
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        {error && <div class="error-text">{error}</div>}
        <button class="primary" disabled={!code.trim()}>
          Pair
        </button>
      </form>
    </div>
  )
}
