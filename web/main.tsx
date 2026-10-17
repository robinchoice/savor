import './monitoring'
import { Fragment, render } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { ArrowDownAZ, Coffee, Download, Lock, FolderOpen, Monitor, Pin, PinOff, RefreshCw, Search, Files as FilesIcon, MessageSquare, Moon, Server, SlidersHorizontal, SquareKanban, Sun, Workflow as WorkflowIcon, ChevronDown, Inbox, Layers, LayoutList, Smartphone, X, CalendarCheck, FileDown, MoreHorizontal, SquareTerminal } from 'lucide-preact'
import { api, avatarStyle, cap, connectEvents, desktop, go, initial, lastThreadKey, Unauthorized, useApi, useEvent, type Me, type Project } from './api'
import { ContextActions, Conversations } from './Conversations'
import { FilesView } from './Files'
import { WorkflowButtons, Workflows } from './Workflows'
import { ExportView, TodayView } from './Workspace'
import { AllProjects } from './Overview'
import { Settings, Devices, Pair, PairingRequests, RemotePair } from './Settings'
import { loadProfile, loadProfiles, rememberHost, remote, setTransport, switchProfile } from './transport'
import { ProcessesPopover } from './Processes'
import { setTerminalOpen, TerminalButton, TerminalPanel } from './Terminal'
import { ArrangeButton, Dock, Panel, useNarrow } from './Layout'
import { useNotifications } from './notify'
import { AccountDialog, AppearanceMenu, FeedbackDialog } from './Account'
import { BugButton } from './BugButton'
import { AddProject, SetupWizard } from './Setup'
import { usePrefs } from './prefs'
import { ShortcutsDialog, useShortcut, type Action } from './Shortcuts'
import { StatusBar } from './StatusBar'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './style.css'
import { t } from './i18n'

function useRoute() {
  // A query after the path, as in #/p/<id>/new?voice=1, is for the view and not part of the route.
  const read = () => location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent)
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

// The project that was open last, so a restart of the app (also after an update) returns to it.
// A project left on another page than its conversations, as its settings or a file, opens there again.
// On a phone a project opens with its list of conversations: the chat would fill the whole screen.
const LAST_PROJECT = 'savor-last-project'
const lastPageKey = (pid: string) => `savor-last-page:${pid}`
const projectHref = (pid: string) => {
  const page = localStorage.getItem(lastPageKey(pid))
  if (page) return `#/p/${pid}/${page}`
  const tid = !matchMedia('(max-width: 860px)').matches && localStorage.getItem(lastThreadKey(pid))
  return `#/p/${pid}${tid ? `/t/${tid}` : ''}`
}

function App() {
  const [me, setMe] = useState<Me | null | false>(null)
  const [mode, setMode] = useState<'direct' | 'relay' | null>(null)
  const [link, setLink] = useState<{ connected: boolean; error?: string }>({ connected: true })
  const route = useRoute()
  const { terminalOpen, terminalMax } = usePrefs()
  const narrow = useNarrow()
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
        if (mode === 'relay') rememberHost(m.host)
        setMe(m)
        connectEvents()
      },
      (e) => setMe(e instanceof Unauthorized ? false : null),
    )
  }, [mode, link.connected])
  useNotifications(route[2] === 't' ? route[3] : undefined, projects, me)
  useEffect(() => {
    if (projects?.length && !['p', 'all', 'devices', 'pair', 'rpair'].includes(route[0])) {
      const last = projects.find((p) => p.id === localStorage.getItem(LAST_PROJECT))
      go(projectHref((last ?? projects.find((p) => p.pinned) ?? projects[0]).id))
    }
  }, [projects, route[0]])
  useEffect(() => {
    if (route[0] !== 'p' || !route[1]) return
    localStorage.setItem(LAST_PROJECT, route[1])
    if (route[2] && !['t', 'new', 'fan'].includes(route[2])) return localStorage.setItem(lastPageKey(route[1]), location.hash.split('?')[0].split('/').slice(3).join('/'))
    localStorage.removeItem(lastPageKey(route[1]))
    if (route[2] === 't' && route[3]) localStorage.setItem(lastThreadKey(route[1]), route[3])
    else localStorage.removeItem(lastThreadKey(route[1]))
  }, [route.join('/')])

  if (route[0] === 'pair') return <Pair code={route[1]} />
  if (route[0] === 'rpair') return <RemotePair daemonPk={route[1]} code={route[2]} />
  if (mode === 'relay' && !loadProfile())
    return (
      <div class="gate">
        <img src="/icon.svg" alt="" />
        <h1>{t('Savor')}</h1>
        <p>{t('This is a Savor relay. To reach your computer from here, open Savor on it, go to Devices & remote access → Pair a device, and scan the QR code.')}</p>
      </div>
    )
  if (me === null)
    return mode === 'relay' && !link.connected ? (
      <div class="gate">
        <img src="/icon.svg" alt="" />
        <h1>{t('Connecting…')}</h1>
        <p class="muted">{link.error ?? t('Reaching your computer through the relay.')}</p>
        {loadProfiles()
          .filter((p) => p.daemonPk !== loadProfile()!.daemonPk)
          .map((p) => (
            <button key={p.daemonPk} class="ghost" onClick={() => switchProfile(p)}>
              {t('Switch to {host}', { host: p.host ?? t('your other computer') })}
            </button>
          ))}
      </div>
    ) : null
  if (me === false)
    return (
      <div class="gate">
        <img src="/icon.svg" alt="" />
        <h1>Savor</h1>
        <p>{t('Open the link with ?token=… that the daemon printed on start, or pair this device from Settings → Devices on your computer.')}</p>
      </div>
    )

  // Routes: p/:pid[/t/:tid | /fan/:id | /files/... | /workflows[/:id] | /settings] | all[/:section] | devices
  const [, pid, section, ...rest] = route
  const project = projects?.find((p) => p.id === pid)

  let main = <Welcome me={me} setMe={setMe} />
  // The conversations and the inbox put their parts in panels of their own; every other page of a project or of All
  // is the main panel.
  let panels = false
  if (route[0] === 'devices') main = <Devices />
  else if (route[0] === 'all') {
    panels = route[1] === 'inbox'
    main = <AllProjects projects={projects ?? []} section={route[1]} rest={route.slice(2)} importText={new URLSearchParams(location.hash.split('?')[1] ?? '').get('text') ?? undefined} />
  }
  else if (project) {
    if (section === 'files') main = <FilesView key={project.id} project={project} rest={rest} />
    else if (section === 'workflows') main = <Workflows key={project.id} project={project} rest={rest} />
    else if (section === 'settings') main = <Settings key={project.id} project={project} />
    else if (section === 'export') main = <ExportView key={project.id} project={project} />
    else if (section === 'today') main = <TodayView key={project.id} project={project} />
    else {
      panels = true
      main = <Conversations key={project.id} project={project} threadId={section === 't' ? rest[0] : undefined} fanoutId={section === 'fan' ? rest[0] : undefined} isNew={section === 'new'} />
    }
  }
  const terminal = project && terminalOpen && <TerminalPanel key={project.id} project={project} threadId={section === 't' ? rest[0] : undefined} />
  const docked = (project || route[0] === 'all') && !narrow

  return (
    <div class={`app ${!docked && terminal && terminalMax ? 'terminal-max' : ''}`}>
      {mode === 'relay' && !link.connected && <div class="link-banner">{t('Reconnecting to your computer…')}</div>}
      <UpdateBanner />
      <RestartBanner />
      <TopBar projects={projects ?? []} active={project} all={route[0] === 'all'} me={me} setMe={setMe} />
      {project && <SubBar project={project} projects={projects ?? []} section={section} threadId={section === 't' ? rest[0] : undefined} />}
      {route[0] === 'all' && <AllBar section={route[1]} />}
      <main>
        {docked ? (
          <Dock>
            {panels ? main : <Panel id="main" title={cap((project ? section : route[1]) ?? 'overview')}>{main}</Panel>}
            {terminal && <Panel id="terminal">{terminal}</Panel>}
          </Dock>
        ) : (
          main
        )}
      </main>
      {!docked && terminal}
      {!narrow && <StatusBar />}
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
      <span>{state === 'installing' ? t('Installing Savor {version}…', { version }) : state === 'failed' ? t('Could not install the update') : t('Savor {version} is ready', { version })}</span>
      {state !== 'installing' && (
        <>
          <button class="ghost small" onClick={install}>
            {t('Install and restart')}
          </button>
          <button class="icon-btn" title={t('Later: installs when you quit Savor')} onClick={() => setState('dismissed')}>
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
      <span>{restarting ? t('Savor is restarting…') : left ? t('Savor restarts in {n} s to finish an update', { n: left }) : t('Savor was updated')}</span>
      {!restarting && (
        <button class="ghost small" onClick={restartNow}>
          {t('Restart now')}
        </button>
      )}
    </div>
  )
}

function TopBar({ projects, active, all, me, setMe }: { projects: Project[]; active?: Project; all: boolean; me: Me; setMe: (m: Me) => void }) {
  const [menu, setMenu] = useState<'projects' | 'appearance' | null>(null)
  const [dialog, setDialog] = useState<'account' | 'feedback' | 'shortcuts' | null>(null)
  const { theme, feedbackButton, bugButton } = usePrefs()
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun
  const total = (k: keyof Project['counts']) => projects.reduce((n, p) => n + p.counts[k], 0)
  const toggleAwake = async () => setMe({ ...me, ...(await api('POST', '/awake', { on: !me.awake })) })
  const togglePin = (e: Event, p: Project) => {
    e.preventDefault()
    e.stopPropagation()
    api('PATCH', `/projects/${p.id}`, { pinned: !p.pinned })
  }
  // Tabs follow by name, behind the fixed ones. A tab dragged to a place, or fixed with a right click, stays
  // there, and so do the tabs before it. The new order shows right away and the server keeps it.
  const [drag, setDrag] = useState<{ id: string; over?: string; after?: boolean } | null>(null)
  const [order, setOrder] = useState<string[] | null>(null)
  const [tabMenu, setTabMenu] = useState<{ project: Project; x: number; y: number } | null>(null)
  useEffect(() => setOrder(null), [projects])
  // A health warning in the status bar leads to the agents in this dialog.
  useEffect(() => {
    const on = () => setDialog('account')
    addEventListener('savor-account', on)
    return () => removeEventListener('savor-account', on)
  }, [])
  const sorted = order ? [...projects].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : projects
  const tabs = sorted.filter((p) => p.pinned || p.id === active?.id)
  const fixUpTo = (ids: string[], id: string) => {
    setOrder(ids)
    const upTo = ids.indexOf(id)
    const fixed = new Set(projects.filter((p) => p.fixed).map((p) => p.id))
    api('PUT', '/projects/order', { ids: ids.filter((x, i) => fixed.has(x) || (i <= upTo && tabs.some((p) => p.id === x))) })
  }
  for (let i = 0; i < 9; i++) useShortcut(`project${i + 1}` as Action, tabs[i] && (() => (location.hash = projectHref(tabs[i].id))))
  useShortcut('shortcuts', () => setDialog('shortcuts'))
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
    setDrag(null)
    fixUpTo(ids, drag.id)
  }
  // A click outside a menu closes it, unless that click just opened the other menu.
  const closeMenu = (which: typeof menu) => setMenu((m) => (m === which ? null : m))
  // Where the account dialog leads.
  const open = (what: 'feedback' | 'appearance' | 'shortcuts') => {
    setDialog(what === 'appearance' ? null : what)
    if (what === 'appearance') setMenu(what)
  }

  return (
    <header class="topbar">
      <a href="#/all" class="brand" title={t('All projects')}>
        <img class="logo" src="/icon.svg" alt={t('Savor')} />
        <span class="brandname" aria-hidden="true">{t('Savor')}</span>
      </a>
      <nav class="project-tabs">
        <a href="#/all" class={`project-tab all-tab ${all ? 'active' : ''}`} title={t('Conversations and workflows of all projects')}>
          <Layers size={16} />
          <span class="name">{t('All')}</span>
          <Counts project={{ counts: { working: total('working'), blocked: total('blocked'), unread: total('unread'), open: total('open') } }} />
        </a>
        <span class="tab-sep" />
        {tabs.map((p, i) => (
          <Fragment key={p.id}>
            {i > 0 && tabs[i - 1].fixed && !p.fixed && <span class="tab-sep" />}
            <a
              href={projectHref(p.id)}
              class={`project-tab ${p.id === active?.id ? 'active' : ''} ${drag?.id === p.id ? 'dragging' : ''} ${drag?.over === p.id ? (drag.after ? 'drop-after' : 'drop-before') : ''}`}
              draggable
              onDragStart={(e) => (e.dataTransfer!.effectAllowed = 'move', setDrag({ id: p.id }))}
              onDragOver={(e) => dragOver(e, p)}
              onDrop={drop}
              onDragEnd={() => setDrag(null)}
              onContextMenu={(e) => (e.preventDefault(), setTabMenu({ project: p, x: e.clientX, y: e.clientY }))}
            >
              <span class="avatar" style={avatarStyle(p.tint)}>
                {initial(p.name)}
              </span>
              <span class="name">{p.name}</span>
              {p.paused && <span class="muted small">{t('paused')}</span>}
              <Counts project={p} />
              <button class={`tab-pin ${p.pinned ? '' : 'unpinned'}`} title={p.pinned ? t('Unpin: remove the tab') : t('Pin as a tab')} onClick={(e) => togglePin(e, p)}>
                {p.pinned ? <PinOff size={13} /> : <Pin size={13} />}
              </button>
            </a>
          </Fragment>
        ))}
      </nav>
      {tabMenu && <TabMenu project={tabMenu.project} at={tabMenu} fix={() => fixUpTo(sorted.map((p) => p.id), tabMenu.project.id)} close={() => setTabMenu(null)} />}
      <div class="topbar-right">
        <WorkflowButtons />
        <div class="menu-anchor">
          <button class="pill" onClick={() => setMenu(menu === 'projects' ? null : 'projects')}>
            <FolderOpen size={15} /> {t('Projects')} <ChevronDown size={14} />
          </button>
          {menu === 'projects' && <ProjectsMenu projects={sorted} active={active} me={me} setMe={setMe} close={() => closeMenu('projects')} />}
        </div>
        {feedbackButton && (
          <button class="icon-btn wide-only" title={t('Send feedback')} onClick={() => setDialog('feedback')}>
            <MessageSquare size={17} />
          </button>
        )}
        {me.origin === 'local' && (
          <button class={`icon-btn ${me.awake ? 'on' : ''}`} title={me.awake ? t('Keeping this computer awake') : t('Keep this computer awake')} onClick={toggleAwake}>
            <Coffee size={17} />
          </button>
        )}
        <div class="menu-anchor">
          <button class="icon-btn wide-only" title={t('Appearance')} onClick={() => setMenu(menu === 'appearance' ? null : 'appearance')}>
            <ThemeIcon size={17} />
          </button>
          {menu === 'appearance' && <AppearanceMenu close={() => closeMenu('appearance')} />}
        </div>
        <button class="account" title={me.origin === 'local' ? t('This computer') : t('Remote device: {name}', { name: me.device ?? '' })} onClick={() => setDialog('account')}>
          {me.origin === 'local' ? 'S' : <Smartphone size={15} />}
          <span class="online" />
        </button>
        {dialog === 'account' && <AccountDialog me={me} projects={projects.length} toggleAwake={toggleAwake} open={open} onClose={() => setDialog(null)} />}
        {dialog === 'feedback' && <FeedbackDialog me={me} onClose={() => setDialog(null)} />}
        {dialog === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
        {bugButton && <BugButton me={me} />}
      </div>
    </header>
  )
}

// Right-clicking a tab fixes it in place, lets it follow by name again, or closes it.
function TabMenu({ project: p, at, fix, close }: { project: Project; at: { x: number; y: number }; fix: () => void; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const on = (e: MouseEvent) => !e.composedPath().includes(ref.current!) && close()
    setTimeout(() => {
      addEventListener('click', on)
      addEventListener('contextmenu', on)
    })
    return () => {
      removeEventListener('click', on)
      removeEventListener('contextmenu', on)
    }
  }, [])
  const patch = (body: Partial<Project>) => {
    close()
    api('PATCH', `/projects/${p.id}`, body)
  }
  return (
    <div ref={ref} class="menu" style={{ position: 'fixed', left: at.x, top: at.y }}>
      {p.fixed ? (
        <button onClick={() => patch({ fixed: false })}>
          <ArrowDownAZ size={14} /> {t('Sort by name')}
        </button>
      ) : (
        <button onClick={() => (close(), fix())}>
          <Lock size={14} /> {t('Keep in place')}
        </button>
      )}
      {p.pinned && (
        <button onClick={() => patch({ pinned: false })}>
          <PinOff size={14} /> {t('Close tab')}
        </button>
      )}
    </div>
  )
}

const Counts = ({ project: p }: { project: Pick<Project, 'counts'> }) => (
  <>
    {p.counts.working > 0 && (
      <span class="badge working" title={t('Working')}>
        <span class="ring busy" /> {p.counts.working}
      </span>
    )}
    {p.counts.blocked > 0 && (
      <span class="badge blocked" title={t('Questions, approvals and errors')}>
        <span class="ring needs" /> {p.counts.blocked}
      </span>
    )}
    {p.counts.unread > 0 && (
      <span class="badge unread" title={t('New results')}>
        <span class="ring unread" /> {p.counts.unread}
      </span>
    )}
    {p.counts.open > 0 && (
      <span class="badge open" title={t('Read, not finished')}>
        <span class="ring open" /> {p.counts.open}
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
  const shown = projects
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const pin = (e: Event, p: Project) => {
    e.preventDefault()
    e.stopPropagation()
    api('PATCH', `/projects/${p.id}`, { pinned: !p.pinned }).catch((err: Error) => setError(err.message))
  }
  return (
    <div class="menu right wide projects" ref={ref}>
      <div class="panel-head">
        <b>{t('Your projects')}</b>
        <button class="icon-btn" title={t('Close')} onClick={close}>
          <X size={16} />
        </button>
      </div>
      <label class="search">
        <Search size={15} />
        <input autoFocus placeholder={t('Find a project…')} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>
      <div class="project-list">
        {shown.map((p) => (
          <a key={p.id} href={projectHref(p.id)} class={p.id === active?.id ? 'active' : ''} title={p.path} onClick={close}>
            <span class="avatar" style={avatarStyle(p.tint)}>
              {initial(p.name)}
            </span>
            <span class="name">{p.name}</span>
            <Counts project={p} />
            <button class={`switch pin ${p.pinned ? 'on' : ''}`} style={{ '--c': p.tint }} title={p.pinned ? t('Unpin: remove the tab') : t('Pin as a tab')} onClick={(e) => pin(e, p)}>
              <i>
                <Pin size={11} />
              </i>
            </button>
          </a>
        ))}
      </div>
      <div class="panel-actions">
        <AddProject me={me} setMe={setMe} onAdded={close} />
      </div>
      {error && <div class="error-text">{error}</div>}
    </div>
  )
}

function SubBar({ project, projects, section, threadId }: { project: Project; projects: Project[]; section?: string; threadId?: string }) {
  const [menu, setMenu] = useState<'more' | 'procs' | null>(null)
  const [procCount, setProcCount] = useState(0)
  const load = () => api<unknown[]>('GET', `/projects/${project.id}/processes`).then((l) => setProcCount(l.length))
  useEffect(() => void load(), [project.id])
  useEvent((e) => e.type === 'processes' && e.projectId === project.id && load(), [project.id])
  useShortcut('new', () => go(`/p/${project.id}/new`))
  useShortcut('conversations', () => go(`/p/${project.id}`))
  useShortcut('files', () => go(`/p/${project.id}/files`))
  useShortcut('workflows', () => go(`/p/${project.id}/workflows`))
  const tab = (id: string, label: string, Icon: any, href: string, counts?: Project['counts'], extra = '') => (
    <a href={href} class={`subtab ${extra} ${(['t', 'new', undefined].includes(section) ? 't' : section) === id ? 'active' : ''}`}>
      <Icon size={15} /> {label}
      {counts?.blocked ? <i class="pill-count blocked" title={t('Questions, approvals and errors')}>{counts.blocked}</i> : null}
      {counts?.unread ? <i class="pill-count" title={t('New results')}>{counts.unread}</i> : null}
    </a>
  )
  return (
    <div class="subbar">
      {project.type === 'kontor' && tab('today', t('Today'), CalendarCheck, `#/p/${project.id}/today`, undefined, 'extra')}
      {tab('t', t('Conversations'), MessageSquare, `#/p/${project.id}`, project.counts)}
      {tab('files', t('Files'), FilesIcon, `#/p/${project.id}/files`)}
      {tab('workflows', t('Workflows'), WorkflowIcon, `#/p/${project.id}/workflows`)}
      {project.type === 'academic-writing' && tab('export', t('Export'), FileDown, `#/p/${project.id}/export`, undefined, 'extra')}
      <ContextActions project={project} projects={projects} threadId={threadId} />
      <div class="subbar-right menu-anchor">
        <ArrangeButton />
        <TerminalButton project={project} />
        <button class={`icon-btn ${procCount ? 'on' : ''}`} title={t('Background processes')} onClick={() => setMenu(menu === 'procs' ? null : 'procs')}>
          <Server size={16} />
          {procCount > 0 && <i class="dot-count">{procCount}</i>}
        </button>
        <a class={`icon-btn ${section === 'settings' ? 'on' : ''}`} title={t('Project settings')} href={`#/p/${project.id}/settings`}>
          <SlidersHorizontal size={16} />
        </a>
        <button class={`icon-btn more ${section === 'settings' ? 'on' : ''}`} title={t('More')} onClick={() => setMenu(menu === 'more' ? null : 'more')}>
          <MoreHorizontal size={16} />
          {procCount > 0 && <i class="dot-count">{procCount}</i>}
        </button>
        {menu === 'procs' && <ProcessesPopover project={project} close={() => setMenu(null)} />}
        {menu === 'more' && <MoreMenu project={project} procCount={procCount} openProcs={() => setMenu('procs')} close={() => setMenu(null)} />}
      </div>
    </div>
  )
}

// On mobile the subbar keeps Conversations, Files and Workflows; everything else is in this menu.
function MoreMenu({ project, procCount, openProcs, close }: { project: Project; procCount: number; openProcs: () => void; close: () => void }) {
  const { terminalOpen } = usePrefs()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const on = (e: MouseEvent) => !e.composedPath().includes(ref.current!) && close()
    setTimeout(() => addEventListener('click', on))
    return () => removeEventListener('click', on)
  }, [])
  return (
    <div class="menu right more" ref={ref}>
      {project.type === 'kontor' && <a href={`#/p/${project.id}/today`} onClick={close}><CalendarCheck size={16} /> <span>{t('Today')}</span></a>}
      {project.type === 'academic-writing' && <a href={`#/p/${project.id}/export`} onClick={close}><FileDown size={16} /> <span>{t('Export')}</span></a>}
      <button onClick={() => (setTerminalOpen(!terminalOpen), close())}>
        <SquareTerminal size={16} /> <span>{terminalOpen ? t('Close terminal') : t('Terminal')}</span>
      </button>
      <button onClick={openProcs}>
        <Server size={16} /> <span>{t('Background processes')}</span>
        {procCount > 0 && <small>{procCount}</small>}
      </button>
      <a href={`#/p/${project.id}/settings`} onClick={close}><SlidersHorizontal size={16} /> <span>{t('Project settings')}</span></a>
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
      {tab('', t('Overview'), LayoutList)}
      {tab('inbox', t('Inbox'), Inbox)}
      {tab('board', t('Board'), SquareKanban)}
      {tab('workflows', t('Workflows'), WorkflowIcon)}
    </div>
  )
}

function Welcome({ me, setMe }: { me: Me; setMe: (m: Me) => void }) {
  return (
    <div class="empty-state">
      {me.setup && <SetupWizard me={me} setMe={setMe} />}
      <img src="/icon.svg" alt="" />
      <h2>{t('Open a project')}</h2>
      <p class="muted">{t('Use Projects to start a new project or open a folder. Conversations, documents and workflows live in its .savor/ directory.')}</p>

    </div>
  )
}

render(<App />, document.getElementById('app')!)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')
