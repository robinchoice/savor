import './monitoring'
import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Coffee, Download, Folder, FolderOpen, Monitor, Pin, Search, Files as FilesIcon, MessageSquare, Moon, Plus, Server, SlidersHorizontal, Sun, Workflow as WorkflowIcon, ChevronDown, Smartphone, X } from 'lucide-preact'
import { api, connectEvents, desktop, go, Unauthorized, useApi, useEvent, type Me, type Project } from './api'
import { Conversations } from './Conversations'
import { FilesView } from './Files'
import { Workflows } from './Workflows'
import { Settings, Devices, Pair, RemotePair } from './Settings'
import { loadProfile, remote, setTransport } from './transport'
import { ProcessesPopover } from './Processes'
import { useNotifications } from './notify'
import { EnjoyImport, EnjoyOffer, useEnjoyProjects } from './EnjoyImport'
import { AccountDialog, AppearanceMenu, FeedbackDialog } from './Account'
import { usePrefs } from './prefs'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
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
    if (me || !link.connected || !mode || (mode === 'relay' && !loadProfile())) return
    api<Me>('GET', '/me').then(
      (m) => {
        setMe(m)
        connectEvents()
      },
      (e) => setMe(e instanceof Unauthorized ? false : null),
    )
  }, [mode, link.connected])
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
    <div class="app">
      {mode === 'relay' && !link.connected && <div class="link-banner">Reconnecting to your computer…</div>}
      <TopBar projects={projects ?? []} active={project} me={me} setMe={setMe} />
      {project && <SubBar project={project} section={section} />}
      <main>{main}</main>
    </div>
  )
}

function TopBar({ projects, active, me, setMe }: { projects: Project[]; active?: Project; me: Me; setMe: (m: Me) => void }) {
  const [menu, setMenu] = useState<'projects' | 'appearance' | null>(null)
  const [dialog, setDialog] = useState<'account' | 'feedback' | 'enjoy' | null>(null)
  const { theme, feedbackButton } = usePrefs()
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun
  const toggleAwake = async () => setMe({ ...me, ...(await api('POST', '/awake', { on: !me.awake })) })
  // A click outside a menu closes it, unless that click just opened the other menu.
  const closeMenu = (which: typeof menu) => setMenu((m) => (m === which ? null : m))
  // Where the account dialog leads.
  const open = (what: 'feedback' | 'appearance' | 'enjoy') => {
    setDialog(what === 'appearance' ? null : what)
    if (what === 'appearance') setMenu(what)
  }

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
            <Counts project={p} />
          </a>
        ))}
      </nav>
      <div class="topbar-right">
        <div class="menu-anchor">
          <button class="pill" onClick={() => setMenu(menu === 'projects' ? null : 'projects')}>
            <FolderOpen size={15} /> Projects <ChevronDown size={14} />
          </button>
          {menu === 'projects' && <ProjectsMenu projects={projects} active={active} me={me} setMe={setMe} close={() => closeMenu('projects')} onEnjoy={() => (setMenu(null), setDialog('enjoy'))} />}
        </div>
        {feedbackButton && (
          <button class="icon-btn wide-only" title="Send feedback" onClick={() => setDialog('feedback')}>
            <MessageSquare size={17} />
          </button>
        )}
        {me.origin === 'local' && (
          <button class={`icon-btn ${me.awake ? 'on' : ''}`} title={me.awake ? 'Keeping this computer awake' : 'Keep this computer awake'} onClick={toggleAwake}>
            <Coffee size={17} />
          </button>
        )}
        <div class="menu-anchor">
          <button class="icon-btn wide-only" title="Appearance" onClick={() => setMenu(menu === 'appearance' ? null : 'appearance')}>
            <ThemeIcon size={17} />
          </button>
          {menu === 'appearance' && <AppearanceMenu close={() => closeMenu('appearance')} />}
        </div>
        <button class="account" title={me.origin === 'local' ? 'This computer' : `Remote device: ${me.device}`} onClick={() => setDialog('account')}>
          {me.origin === 'local' ? 'S' : <Smartphone size={15} />}
          <span class="online" />
        </button>
        {dialog === 'account' && <AccountDialog me={me} projects={projects.length} toggleAwake={toggleAwake} open={open} onClose={() => setDialog(null)} />}
        {dialog === 'feedback' && <FeedbackDialog me={me} onClose={() => setDialog(null)} />}
        {dialog === 'enjoy' && <EnjoyImport onClose={() => setDialog(null)} />}
      </div>
    </header>
  )
}

const Counts = ({ project: p }: { project: Project }) => (
  <>
    {p.counts.working > 0 && (
      <span class="badge working" title="Working">
        <span class="ring busy" /> {p.counts.working}
      </span>
    )}
    {p.counts.needsYou + p.counts.unread > 0 && (
      <span class="badge unread" title="Your turn or unread">
        <span class={`ring ${p.counts.needsYou ? 'needs' : 'unread'}`} /> {p.counts.needsYou + p.counts.unread}
      </span>
    )}
  </>
)

function ProjectsMenu({ projects, active, me, setMe, close, onEnjoy }: { projects: Project[]; active?: Project; me: Me; setMe: (m: Me) => void; close: () => void; onEnjoy: () => void }) {
  const enjoy = useEnjoyProjects()
  const [query, setQuery] = useState('')
  const [step, setStep] = useState<'new' | 'open' | null>(null)
  const [name, setName] = useState('')
  const [dir, setDir] = useState(me.projectsDir)
  const [editDir, setEditDir] = useState(false)
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // The path, not the target: a clicked button may be gone by the time the click gets here.
    const on = (e: MouseEvent) => !e.composedPath().includes(ref.current!) && close()
    setTimeout(() => addEventListener('click', on))
    return () => removeEventListener('click', on)
  }, [])
  const add = async (body: { path: string; name?: string; create?: boolean }) => {
    try {
      const p = await api<Project>('POST', '/projects', body)
      if (body.create) setMe({ ...me, projectsDir: dir })
      close()
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
  const q = query.trim().toLowerCase()
  const shown = projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
  const pin = (e: Event, p: Project) => {
    e.preventDefault()
    e.stopPropagation()
    api('PATCH', `/projects/${p.id}`, { pinned: !p.pinned }).catch((err: Error) => setError(err.message))
  }
  return (
    <div class="menu right wide projects" ref={ref}>
      <div class="panel-head">
        <b>Your projects</b>
        <button class="icon-btn" title="Close" onClick={close}>
          <X size={16} />
        </button>
      </div>
      <label class="search">
        <Search size={15} />
        <input autoFocus placeholder="Find a project…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>
      <div class="project-list">
        {shown.map((p) => (
          <a key={p.id} href={`#/p/${p.id}`} class={p.id === active?.id ? 'active' : ''} title={p.path} onClick={close}>
            <span class="avatar" style={avatarStyle(p.tint)}>
              {initial(p.name)}
            </span>
            <span class="name">{p.name}</span>
            <Counts project={p} />
            <button class={`switch pin ${p.pinned ? 'on' : ''}`} style={{ '--c': p.tint }} title={p.pinned ? 'Unpin: remove the tab' : 'Pin as a tab'} onClick={(e) => pin(e, p)}>
              <i>
                <Pin size={11} />
              </i>
            </button>
          </a>
        ))}
      </div>
      {me.origin === 'local' && (
        <div class="panel-actions">
          {step === 'new' ? (
            <form onSubmit={create}>
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
              {enjoy.length > 0 && (
                <button class="import-link" onClick={onEnjoy}>
                  <Download size={13} /> Import from Enjoy…
                </button>
              )}
            </>
          )}
        </div>
      )}
      {error && <div class="error-text">{error}</div>}
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
      <p class="muted">Use Projects to start a new project or open a folder. Conversations, documents and workflows live in its <code>.savor/</code> directory.</p>
      <EnjoyOffer />
    </div>
  )
}

render(<App />, document.getElementById('app')!)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')
