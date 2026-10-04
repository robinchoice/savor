import './monitoring'
import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Coffee, Download, FolderOpen, Pin, PinOff, Search, Files as FilesIcon, Layers, MessageSquare, Moon, Plus, Server, SlidersHorizontal, Sun, Workflow as WorkflowIcon, ChevronDown, Smartphone, Bell, BellOff } from 'lucide-preact'
import { api, connectEvents, go, Unauthorized, useApi, useEvent, type Me, type Project } from './api'
import { Conversations } from './Conversations'
import { FilesView } from './Files'
import { Workflows } from './Workflows'
import { Settings, Devices, Pair, RemotePair } from './Settings'
import { loadProfile, remote, setTransport, forgetProfile } from './transport'
import { ProcessesPopover } from './Processes'
import { useNotifications, useNotificationToggle } from './notify'
import { EnjoyImport, EnjoyOffer, useEnjoyProjects } from './EnjoyImport'
import './style.css'

function useRoute() {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => setRoute(read())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return route
}

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('savor-theme') ?? 'dark')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('savor-theme', theme)
  }, [theme])
  return [theme, () => setTheme(theme === 'dark' ? 'light' : 'dark')] as const
}

export const initial = (name: string) => (name.trim()[0] ?? '?').toLowerCase()

// Text on a project color: dark on light tints, white on the others.
export function inkOn(tint: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(tint.slice(i, i + 2), 16))
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#1b1c1f' : '#fff'
}
const avatarStyle = (tint: string) => ({ background: tint, color: inkOn(tint) })

function App() {
  const [me, setMe] = useState<Me | null | false>(null)
  const [mode, setMode] = useState<'direct' | 'relay' | null>(null)
  const [link, setLink] = useState<{ connected: boolean; error?: string }>({ connected: true })
  const route = useRoute()
  const [theme, toggleTheme] = useTheme()
  const [projects] = useApi<Project[]>(me ? '/projects' : null, (e) => ['projects', 'thread', 'status'].includes(e.type))

  // Served by a relay: talk to the paired computer through the encrypted tunnel.
  useEffect(() => {
    fetch('/savor-relay.json')
      .then((r) => r.json())
      .catch(() => null)
      .then((cfg) => {
        const profile = cfg?.relay ? loadProfile() : null
        if (profile) setTransport(remote(profile, (connected, error) => setLink({ connected, error })))
        setMode(cfg?.relay ? 'relay' : 'direct')
      })
  }, [])
  useEffect(() => {
    if (!mode || (mode === 'relay' && !loadProfile())) return
    api<Me>('GET', '/me').then(
      (m) => {
        setMe(m)
        connectEvents()
      },
      (e) => setMe(e instanceof Unauthorized ? false : null),
    )
  }, [mode])
  useNotifications(route[2] === 't' ? route[3] : undefined, projects)
  useEffect(() => {
    if (projects?.length && route[0] !== 'p' && route[0] !== 'devices') go(`/p/${(projects.find((p) => p.pinned) ?? projects[0]).id}`)
  }, [projects, route[0]])

  if (route[0] === 'pair') return <Pair code={route[1]} />
  if (route[0] === 'rpair') return <RemotePair daemonPk={route[1]} code={route[2]} />
  if (mode === 'relay' && !loadProfile())
    return (
      <div class="gate">
        <img src="/icon.svg" alt="" />
        <h1>Savor</h1>
        <p>This is a Savor relay. To reach your computer from here, open Savor on it, go to Devices & remote access → Pair a device, and scan the QR code.</p>
      </div>
    )
  if (me === null)
    return mode === 'relay' && !link.connected ? (
      <div class="gate">
        <img src="/icon.svg" alt="" />
        <h1>Connecting…</h1>
        <p class="muted">{link.error ?? 'Reaching your computer through the relay.'}</p>
      </div>
    ) : null
  if (me === false)
    return (
      <div class="gate">
        <img src="/icon.svg" alt="" />
        <h1>Savor</h1>
        <p>Open the link with <code>?token=…</code> that the daemon printed on start, or pair this device from Settings → Devices on your computer.</p>
      </div>
    )

  // Routes: p/:pid[/t/:tid | /files/... | /workflows[/:id] | /settings] | devices
  const [, pid, section, ...rest] = route
  const project = projects?.find((p) => p.id === pid)

  let main = <Welcome />
  if (route[0] === 'devices') main = <Devices />
  else if (project) {
    if (section === 'files') main = <FilesView key={project.id} project={project} rest={rest} />
    else if (section === 'workflows') main = <Workflows key={project.id} project={project} rest={rest} />
    else if (section === 'settings') main = <Settings key={project.id} project={project} />
    else main = <Conversations key={project.id} project={project} threadId={section === 't' ? rest[0] : undefined} isNew={section === 'new'} />
  }

  return (
    <div class="app" style={project ? { '--tint': project.tint, '--tint-ink': inkOn(project.tint) } : undefined}>
      {mode === 'relay' && !link.connected && <div class="link-banner">Reconnecting to your computer…</div>}
      <TopBar projects={projects ?? []} active={project} me={me} setMe={setMe} theme={theme} toggleTheme={toggleTheme} />
      {project && <SubBar project={project} section={section} />}
      <main>{main}</main>
    </div>
  )
}

function TopBar({ projects, active, me, setMe, theme, toggleTheme }: { projects: Project[]; active?: Project; me: Me; setMe: (m: Me) => void; theme: string; toggleTheme: () => void }) {
  const [menu, setMenu] = useState<'projects' | 'account' | null>(null)
  const [enjoyOpen, setEnjoyOpen] = useState(false)
  const [canNotify, notifyOn, toggleNotify] = useNotificationToggle()
  const toggleAwake = async () => setMe({ ...me, ...(await api('POST', '/awake', { on: !me.awake })) })

  return (
    <header class="topbar">
      <img class="logo" src="/icon.svg" alt="Savor" />
      <nav class="project-tabs">
        {projects.filter((p) => p.pinned || p.id === active?.id).map((p) => (
          <a key={p.id} href={`#/p/${p.id}`} class={`project-tab ${p.id === active?.id ? 'active' : ''}`}>
            <span class="avatar" style={avatarStyle(p.tint)}>
              {initial(p.name)}
            </span>
            <span class="name">{p.name}</span>
            {p.paused && <span class="muted small">paused</span>}
            {p.counts.working > 0 && (
              <span class="badge working" title="Working">
                <Layers size={13} /> {p.counts.working}
              </span>
            )}
            {p.counts.needsYou + p.counts.unread > 0 && (
              <span class="badge unread" title="Needs you / unread">
                <MessageSquare size={14} />
                <i>{p.counts.needsYou + p.counts.unread}</i>
              </span>
            )}
          </a>
        ))}
      </nav>
      <div class="topbar-right">
        <div class="menu-anchor">
          <button class="pill" onClick={() => setMenu(menu === 'projects' ? null : 'projects')}>
            <FolderOpen size={15} /> Projects <ChevronDown size={14} />
          </button>
          {menu === 'projects' && <ProjectsMenu projects={projects} close={() => setMenu(null)} onEnjoy={() => (setMenu(null), setEnjoyOpen(true))} />}
          {enjoyOpen && <EnjoyImport onClose={() => setEnjoyOpen(false)} />}
        </div>
        {me.origin === 'local' && (
          <button class={`icon-btn ${me.awake ? 'on' : ''}`} title={me.awake ? 'Keeping this computer awake' : 'Keep this computer awake'} onClick={toggleAwake}>
            <Coffee size={17} />
          </button>
        )}
        <button class="icon-btn" title="Toggle theme" onClick={toggleTheme}>
          {theme === 'dark' ? <Moon size={17} /> : <Sun size={17} />}
        </button>
        <div class="menu-anchor">
          <button class="account" title={me.origin === 'local' ? 'This computer' : `Remote device: ${me.device}`} onClick={() => setMenu(menu === 'account' ? null : 'account')}>
            {me.origin === 'local' ? 'S' : <Smartphone size={15} />}
            <span class="online" />
          </button>
          {menu === 'account' && (
            <div class="menu right" onClick={() => setMenu(null)}>
              <div class="menu-label">{me.origin === 'local' ? 'Signed in on this computer' : `Remote device · ${me.device}`}</div>
              {canNotify && (
                <button onClick={toggleNotify}>
                  {notifyOn ? <Bell size={15} /> : <BellOff size={15} />} Notifications {notifyOn ? 'on' : 'off'}
                </button>
              )}
              {me.origin === 'local' && <a href="#/devices">Devices & remote access</a>}
              {loadProfile() && (
                <button onClick={() => confirm('Forget this computer on this device? You will need to pair again.') && forgetProfile().then(() => location.reload())}>Forget this computer</button>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

function ProjectsMenu({ projects, close, onEnjoy }: { projects: Project[]; close: () => void; onEnjoy: () => void }) {
  const enjoy = useEnjoyProjects()
  const [query, setQuery] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const on = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close()
    setTimeout(() => addEventListener('click', on))
    return () => removeEventListener('click', on)
  }, [])
  const add = async (e: Event) => {
    e.preventDefault()
    try {
      const p = await api<Project>('POST', '/projects', { path })
      close()
      go(`/p/${p.id}`)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  const q = query.trim().toLowerCase()
  const shown = projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
  const pin = (e: Event, p: Project) => {
    e.preventDefault()
    e.stopPropagation()
    api('PATCH', `/projects/${p.id}`, { pinned: !p.pinned }).catch((err: Error) => setError(err.message))
  }
  return (
    <div class="menu right wide" ref={ref}>
      {projects.length > 8 && (
        <label class="search">
          <Search size={15} />
          <input autoFocus placeholder="Find a project…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
      )}
      {shown.map((p) => (
        <a key={p.id} href={`#/p/${p.id}`} onClick={close}>
          <span class="avatar small" style={avatarStyle(p.tint)}>
            {initial(p.name)}
          </span>
          <span>
            {p.name}
            <small class="mono">{p.path}</small>
          </span>
          <button class={`icon-btn pin ${p.pinned ? 'on' : ''}`} title={p.pinned ? 'Unpin: remove the tab' : 'Pin as a tab'} onClick={(e) => pin(e, p)}>
            {p.pinned ? <Pin size={14} /> : <PinOff size={14} />}
          </button>
        </a>
      ))}
      <form onSubmit={add} class="menu-form">
        <input placeholder="Open folder: /path/to/project" value={path} onInput={(e) => setPath(e.currentTarget.value)} />
        <button class="primary" disabled={!path.trim()}>
          <Plus size={15} /> Add
        </button>
      </form>
      {error && <div class="error-text">{error}</div>}
      {enjoy.length > 0 && (
        <button onClick={onEnjoy}>
          <Download size={15} /> Import from Enjoy…
        </button>
      )}
    </div>
  )
}

function SubBar({ project, section }: { project: Project; section?: string }) {
  const [procsOpen, setProcsOpen] = useState(false)
  const [procCount, setProcCount] = useState(0)
  const load = () => api<unknown[]>('GET', `/projects/${project.id}/processes`).then((l) => setProcCount(l.length))
  useEffect(() => void load(), [project.id])
  useEvent((e) => e.type === 'processes' && e.projectId === project.id && load(), [project.id])
  const tab = (id: string, label: string, Icon: any, href: string, badge?: number) => (
    <a href={href} class={`subtab ${(['t', 'new', undefined].includes(section) ? 't' : section) === id ? 'active' : ''}`}>
      <Icon size={15} /> {label}
      {badge ? <i class="dot-count">{badge}</i> : null}
    </a>
  )
  return (
    <div class="subbar">
      {tab('t', 'Conversations', MessageSquare, `#/p/${project.id}`, project.counts.unread + project.counts.needsYou)}
      {tab('files', 'Files', FilesIcon, `#/p/${project.id}/files`)}
      {tab('workflows', 'Workflows', WorkflowIcon, `#/p/${project.id}/workflows`)}
      <div class="subbar-right">
        <div class="menu-anchor">
          <button class={`icon-btn ${procCount ? 'on' : ''}`} title="Background processes" onClick={() => setProcsOpen(!procsOpen)}>
            <Server size={16} />
            {procCount > 0 && <i class="dot-count">{procCount}</i>}
          </button>
          {procsOpen && <ProcessesPopover project={project} close={() => setProcsOpen(false)} />}
        </div>
        <a class={`icon-btn ${section === 'settings' ? 'on' : ''}`} title="Project settings" href={`#/p/${project.id}/settings`}>
          <SlidersHorizontal size={16} />
        </a>
      </div>
    </div>
  )
}

function Welcome() {
  return (
    <div class="empty-state">
      <img src="/icon.svg" alt="" />
      <h2>Open a project</h2>
      <p class="muted">Use Projects → Add to point Savor at a folder. Conversations, documents and workflows live in its <code>.savor/</code> directory.</p>
      <EnjoyOffer />
    </div>
  )
}

render(<App />, document.getElementById('app')!)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')
