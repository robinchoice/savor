import './monitoring'
import { render } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Coffee, Download, FolderOpen, Monitor, Pin, PinOff, RefreshCw, Search, Files as FilesIcon, MessageSquare, Moon, Server, SlidersHorizontal, SquareKanban, Sun, Workflow as WorkflowIcon, ChevronDown, Inbox, Layers, LayoutList, Smartphone, X, CalendarCheck, FileDown } from 'lucide-preact'
import { api, avatarStyle, connectEvents, desktop, go, initial, Unauthorized, useApi, useEvent, type Me, type Project } from './api'
import { ContextActions, Conversations } from './Conversations'
import { FilesView } from './Files'
import { WorkflowButtons, Workflows } from './Workflows'
import { ExportView, TodayView } from './Workspace'
import { AllProjects } from './Overview'
import { Settings, Devices, Pair, PairingRequests, RemotePair } from './Settings'
import { loadProfile, remote, setTransport } from './transport'
import { ProcessesPopover } from './Processes'
import { TerminalButton, TerminalPanel } from './Terminal'
import { useNotifications } from './notify'
import { AccountDialog, AppearanceMenu, FeedbackDialog } from './Account'
import { BugButton } from './BugButton'
import { AddProject, SetupWizard } from './Setup'
import { usePrefs } from './prefs'
import { UsageMeter } from './Usage'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './style.css'

function useRoute() {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => setRoute(read())
    addEventListener('hashchange', on)
    // The hash can change between the first render and this effect, e.g. right after a reload.
    on()
    return () => removeEventListener('hashchange', on)
  }, [])
  return route
}

// The conversation that was open when a project was left; its tab opens it again, otherwise a new one.
const lastThreadKey = (pid: string) => `savor-last-thread:${pid}`
// The project that was open last, so a restart of the app (also after an update) returns to it.
const LAST_PROJECT = 'savor-last-project'
const projectHref = (pid: string) => {
  const tid = localStorage.getItem(lastThreadKey(pid))
  return `#/p/${pid}${tid ? `/t/${tid}` : ''}`
}

function App() {
  const [me, setMe] = useState<Me | null | false>(null)
  const [mode, setMode] = useState<'direct' | 'relay' | null>(null)
  const [link, setLink] = useState<{ connected: boolean; error?: string }>({ connected: true })
  const route = useRoute()
  const { terminalOpen, terminalMax } = usePrefs()
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
  useNotifications(route[2] === 't' ? route[3] : undefined, projects, me)
  useEffect(() => {
    if (projects?.length && route[0] !== 'p' && route[0] !== 'all' && route[0] !== 'devices') {
      const last = projects.find((p) => p.id === localStorage.getItem(LAST_PROJECT))
      go(projectHref((last ?? projects.find((p) => p.pinned) ?? projects[0]).id))
    }
  }, [projects, route[0]])
  useEffect(() => {
    if (route[0] !== 'p' || !route[1]) return
    localStorage.setItem(LAST_PROJECT, route[1])
    if (route[2] === 't' && route[3]) localStorage.setItem(lastThreadKey(route[1]), route[3])
    else localStorage.removeItem(lastThreadKey(route[1]))
  }, [route.join('/')])

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

  // Routes: p/:pid[/t/:tid | /fan/:id | /files/... | /workflows[/:id] | /settings] | all[/:section] | devices
  const [, pid, section, ...rest] = route
  const project = projects?.find((p) => p.id === pid)

  let main = <Welcome me={me} setMe={setMe} />
  if (route[0] === 'devices') main = <Devices />
  else if (route[0] === 'all') main = <AllProjects projects={projects ?? []} section={route[1]} rest={route.slice(2)} />
  else if (project) {
    if (section === 'files') main = <FilesView key={project.id} project={project} rest={rest} />
    else if (section === 'workflows') main = <Workflows key={project.id} project={project} rest={rest} />
    else if (section === 'settings') main = <Settings key={project.id} project={project} />
    else if (section === 'export') main = <ExportView key={project.id} project={project} />
    else if (section === 'today') main = <TodayView key={project.id} project={project} />
    else main = <Conversations key={project.id} project={project} threadId={section === 't' ? rest[0] : undefined} fanoutId={section === 'fan' ? rest[0] : undefined} isNew={section === 'new'} />
  }

  return (
    <div class={`app ${project && terminalOpen && terminalMax ? 'terminal-max' : ''}`}>
      {mode === 'relay' && !link.connected && <div class="link-banner">Reconnecting to your computer…</div>}
      <UpdateBanner />
      <RestartBanner />
      <TopBar projects={projects ?? []} active={project} all={route[0] === 'all'} me={me} setMe={setMe} />
      {project && <SubBar project={project} projects={projects ?? []} section={section} threadId={section === 't' ? rest[0] : undefined} />}
      {route[0] === 'all' && <AllBar section={route[1]} />}
      <main>{main}</main>
      {project && terminalOpen && <TerminalPanel key={project.id} project={project} threadId={section === 't' ? rest[0] : undefined} />}
      {me.origin === 'local' && <PairingRequests />}
    </div>
  )
}

// A new release has downloaded in the desktop app: one click installs it and restarts Savor.
function UpdateBanner() {
  const [version, setVersion] = useState<string | null>(null)
  const [state, setState] = useState<'ready' | 'installing' | 'failed' | 'dismissed'>('ready')
  useEffect(() => desktop?.onUpdateReady(setVersion), [])
  if (!version || state === 'dismissed') return null
  const install = () => {
    setState('installing')
    desktop!.installUpdate().catch(() => setState('failed'))
  }
  return (
    <div class="update-banner">
      <Download size={15} />
      <span>{state === 'installing' ? `Installing Savor ${version}…` : state === 'failed' ? 'Could not install the update' : `Savor ${version} is ready`}</span>
      {state !== 'installing' && (
        <>
          <button class="ghost small" onClick={install}>
            Install and restart
          </button>
          <button class="icon-btn" title="Later: installs when you quit Savor" onClick={() => setState('dismissed')}>
            <X size={14} />
          </button>
        </>
      )}
    </div>
  )
}

// The daemon restarts into an update it found installed: the UI counts down to it, so the short
// moment without Savor doesn't come out of nowhere. With automatic restarts off it only offers one.
function RestartBanner() {
  const [restart] = useApi<{ updated: boolean; left: number | null }>('/restart', (e) => e.type === 'restart')
  const [requested, setRequested] = useState(false)
  const [now, setNow] = useState(Date.now())
  const deadline = useMemo(() => (restart?.left != null ? Date.now() + restart.left : null), [restart])
  useEffect(() => {
    if (!deadline) return
    const tick = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(tick)
  }, [deadline])
  if (!restart?.updated) return null
  const left = deadline && Math.max(0, Math.ceil((deadline - now) / 1000))
  const restarting = requested || left === 0
  const restartNow = () => {
    setRequested(true)
    api('POST', '/restart').catch(() => setRequested(false))
  }
  return (
    <div class="update-banner">
      {restarting ? <span class="spinner" /> : <RefreshCw size={15} />}
      <span>{restarting ? 'Savor is restarting…' : left ? `Savor restarts in ${left} s to finish an update` : 'Savor was updated'}</span>
      {!restarting && (
        <button class="ghost small" onClick={restartNow}>
          Restart now
        </button>
      )}
    </div>
  )
}

function TopBar({ projects, active, all, me, setMe }: { projects: Project[]; active?: Project; all: boolean; me: Me; setMe: (m: Me) => void }) {
  const [menu, setMenu] = useState<'projects' | 'appearance' | null>(null)
  const [dialog, setDialog] = useState<'account' | 'feedback' | null>(null)
  const { theme, feedbackButton, bugButton } = usePrefs()
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun
  const total = (k: keyof Project['counts']) => projects.reduce((n, p) => n + p.counts[k], 0)
  const toggleAwake = async () => setMe({ ...me, ...(await api('POST', '/awake', { on: !me.awake })) })
  const togglePin = (e: Event, p: Project) => {
    e.preventDefault()
    e.stopPropagation()
    api('PATCH', `/projects/${p.id}`, { pinned: !p.pinned })
  }
  // Tabs can be dragged into a new order; it shows right away and the server keeps it.
  const [drag, setDrag] = useState<{ id: string; over?: string; after?: boolean } | null>(null)
  const [order, setOrder] = useState<string[] | null>(null)
  useEffect(() => setOrder(null), [projects])
  const sorted = order ? [...projects].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : projects
  const dragOver = (e: DragEvent, p: Project) => {
    if (!drag || drag.id === p.id) return
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDrag({ ...drag, over: p.id, after: e.clientX > r.left + r.width / 2 })
  }
  const drop = (e: DragEvent) => {
    e.preventDefault()
    if (!drag?.over) return setDrag(null)
    const ids = sorted.map((p) => p.id).filter((id) => id !== drag.id)
    ids.splice(ids.indexOf(drag.over) + (drag.after ? 1 : 0), 0, drag.id)
    setOrder(ids)
    setDrag(null)
    api('PUT', '/projects/order', { ids })
  }
  // A click outside a menu closes it, unless that click just opened the other menu.
  const closeMenu = (which: typeof menu) => setMenu((m) => (m === which ? null : m))
  // Where the account dialog leads.
  const open = (what: 'feedback' | 'appearance') => {
    setDialog(what === 'appearance' ? null : what)
    if (what === 'appearance') setMenu(what)
  }

  return (
    <header class="topbar">
      <img class="logo" src="/icon.svg" alt="Savor" />
      <span class="brandname" aria-hidden="true">Savor</span>
      <nav class="project-tabs">
        <a href="#/all" class={`project-tab all-tab ${all ? 'active' : ''}`} title="Conversations and workflows of all projects">
          <Layers size={16} />
          <span class="name">All</span>
          <Counts project={{ counts: { working: total('working'), blocked: total('blocked'), unread: total('unread') } }} />
        </a>
        <span class="tab-sep" />
        {sorted.filter((p) => p.pinned || p.id === active?.id).map((p) => (
          <a
            key={p.id}
            href={projectHref(p.id)}
            class={`project-tab ${p.id === active?.id ? 'active' : ''} ${drag?.id === p.id ? 'dragging' : ''} ${drag?.over === p.id ? (drag.after ? 'drop-after' : 'drop-before') : ''}`}
            draggable
            onDragStart={(e) => (e.dataTransfer!.effectAllowed = 'move', setDrag({ id: p.id }))}
            onDragOver={(e) => dragOver(e, p)}
            onDrop={drop}
            onDragEnd={() => setDrag(null)}
          >
            <span class="avatar" style={avatarStyle(p.tint)}>
              {initial(p.name)}
            </span>
            <span class="name">{p.name}</span>
            {p.paused && <span class="muted small">paused</span>}
            <Counts project={p} />
            <button class={`tab-pin ${p.pinned ? '' : 'unpinned'}`} title={p.pinned ? 'Unpin: remove the tab' : 'Pin as a tab'} onClick={(e) => togglePin(e, p)}>
              {p.pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
          </a>
        ))}
      </nav>
      <div class="topbar-right">
        <WorkflowButtons />
        <UsageMeter />
        <div class="menu-anchor">
          <button class="pill" onClick={() => setMenu(menu === 'projects' ? null : 'projects')}>
            <FolderOpen size={15} /> Projects <ChevronDown size={14} />
          </button>
          {menu === 'projects' && <ProjectsMenu projects={projects} active={active} me={me} setMe={setMe} close={() => closeMenu('projects')} />}
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
        {bugButton && <BugButton me={me} />}
      </div>
    </header>
  )
}

const Counts = ({ project: p }: { project: Pick<Project, 'counts'> }) => (
  <>
    {p.counts.working > 0 && (
      <span class="badge working" title="Working">
        <span class="ring busy" /> {p.counts.working}
      </span>
    )}
    {p.counts.blocked > 0 && (
      <span class="badge blocked" title="Questions, approvals and errors">
        <span class="ring needs" /> {p.counts.blocked}
      </span>
    )}
    {p.counts.unread > 0 && (
      <span class="badge unread" title="New results">
        <span class="ring unread" /> {p.counts.unread}
      </span>
    )}
  </>
)

function ProjectsMenu({ projects, active, me, setMe, close }: { projects: Project[]; active?: Project; me: Me; setMe: (m: Me) => void; close: () => void }) {
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // The path, not the target: a clicked button may be gone by the time the click gets here.
    const on = (e: MouseEvent) => !e.composedPath().includes(ref.current!) && close()
    setTimeout(() => addEventListener('click', on))
    return () => removeEventListener('click', on)
  }, [])
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
          <a key={p.id} href={projectHref(p.id)} class={p.id === active?.id ? 'active' : ''} title={p.path} onClick={close}>
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
          <AddProject me={me} setMe={setMe} onAdded={close} />
        </div>
      )}
      {error && <div class="error-text">{error}</div>}
    </div>
  )
}

function SubBar({ project, projects, section, threadId }: { project: Project; projects: Project[]; section?: string; threadId?: string }) {
  const [procsOpen, setProcsOpen] = useState(false)
  const [procCount, setProcCount] = useState(0)
  const load = () => api<unknown[]>('GET', `/projects/${project.id}/processes`).then((l) => setProcCount(l.length))
  useEffect(() => void load(), [project.id])
  useEvent((e) => e.type === 'processes' && e.projectId === project.id && load(), [project.id])
  const tab = (id: string, label: string, Icon: any, href: string, counts?: Project['counts']) => (
    <a href={href} class={`subtab ${(['t', 'new', undefined].includes(section) ? 't' : section) === id ? 'active' : ''}`}>
      <Icon size={15} /> {label}
      {counts?.blocked ? <i class="pill-count blocked" title="Questions, approvals and errors">{counts.blocked}</i> : null}
      {counts?.unread ? <i class="pill-count" title="New results">{counts.unread}</i> : null}
    </a>
  )
  return (
    <div class="subbar">
      {project.type === 'kontor' && tab('today', 'Today', CalendarCheck, `#/p/${project.id}/today`)}
      {tab('t', 'Conversations', MessageSquare, `#/p/${project.id}`, project.counts)}
      {tab('files', 'Files', FilesIcon, `#/p/${project.id}/files`)}
      {tab('workflows', 'Workflows', WorkflowIcon, `#/p/${project.id}/workflows`)}
      {project.type === 'academic-writing' && tab('export', 'Export', FileDown, `#/p/${project.id}/export`)}
      <ContextActions project={project} projects={projects} threadId={threadId} />
      <div class="subbar-right">
        <TerminalButton project={project} />
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

function AllBar({ section }: { section?: string }) {
  const tab = (id: string, label: string, Icon: any) => (
    <a href={`#/all${id && `/${id}`}`} class={`subtab ${(section ?? '') === id ? 'active' : ''}`}>
      <Icon size={15} /> {label}
    </a>
  )
  return (
    <div class="subbar">
      {tab('', 'Overview', LayoutList)}
      {tab('inbox', 'Inbox', Inbox)}
      {tab('board', 'Board', SquareKanban)}
      {tab('workflows', 'Workflows', WorkflowIcon)}
    </div>
  )
}

function Welcome({ me, setMe }: { me: Me; setMe: (m: Me) => void }) {
  return (
    <div class="empty-state">
      {me.setup && <SetupWizard me={me} setMe={setMe} />}
      <img src="/icon.svg" alt="" />
      <h2>Open a project</h2>
      <p class="muted">Use Projects to start a new project or open a folder. Conversations, documents and workflows live in its <code>.savor/</code> directory.</p>
    </div>
  )
}

render(<App />, document.getElementById('app')!)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')
