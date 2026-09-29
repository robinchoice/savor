import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { api, connectEvents, go, Unauthorized, useApi, type Project, type Thread } from './api'
import { NewThread, ThreadView } from './Thread'
import { Documents, Processes, Settings, Workflows } from './Pages'
import './style.css'

function useRoute() {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => setRoute(read())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return route
}

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const route = useRoute()
  const [projects] = useApi<Project[]>(authed ? '/projects' : null, (e) => e.type === 'projects')

  useEffect(() => {
    api('GET', '/projects').then(
      () => {
        setAuthed(true)
        connectEvents()
      },
      (e) => setAuthed(e instanceof Unauthorized ? false : true),
    )
  }, [])
  useEffect(() => setMenuOpen(false), [route.join('/')])
  useEffect(() => {
    if (projects?.length && !route[1]) go(`/p/${projects[0].id}/new`)
  }, [projects, route[1]])

  if (authed === null) return null
  if (!authed)
    return (
      <div class="gate">
        <h1>Savor</h1>
        <p>Open the link with <code>?token=…</code> that the daemon printed on start.</p>
      </div>
    )

  // Routes: p/:pid/(t/:tid | new | docs[/:id] | workflows[/:id] | processes | settings)
  const [, pid, section, id] = route
  const project = projects?.find((p) => p.id === pid) ?? projects?.[0]

  let main = <Welcome />
  if (project) {
    if (section === 't' && id) main = <ThreadView key={id} project={project} threadId={id} />
    else if (section === 'docs') main = <Documents project={project} docId={id} />
    else if (section === 'workflows') main = <Workflows project={project} workflowId={id} />
    else if (section === 'processes') main = <Processes project={project} />
    else if (section === 'settings') main = <Settings project={project} />
    else main = <NewThread project={project} />
  }

  return (
    <div class={`shell ${menuOpen ? 'menu-open' : ''}`}>
      <Sidebar projects={projects ?? []} project={project} section={section} activeId={id} />
      <main>
        <button class="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">
          ☰
        </button>
        {main}
      </main>
    </div>
  )
}

function Sidebar({ projects, project, section, activeId }: { projects: Project[]; project?: Project; section?: string; activeId?: string }) {
  const [threads] = useApi<Thread[]>(project ? `/projects/${project.id}/threads` : null, (e) => e.projectId === project?.id && (e.type === 'thread' || e.type === 'status'))
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')

  const addProject = async (e: Event) => {
    e.preventDefault()
    const p = await api<Project>('POST', '/projects', { path })
    setPath('')
    setAdding(false)
    go(`/p/${p.id}/new`)
  }

  const link = (s: string) => `#/p/${project?.id}/${s}`
  return (
    <aside class="sidebar">
      <div class="brand">
        <img src="/icon.svg" alt="" /> Savor
      </div>

      <div class="projects">
        {projects.map((p) => (
          <a key={p.id} href={`#/p/${p.id}/new`} class={p.id === project?.id ? 'active' : ''} title={p.path}>
            {p.name}
          </a>
        ))}
        {adding || !projects.length ? (
          <form onSubmit={addProject}>
            <input autoFocus placeholder="/path/to/project" value={path} onInput={(e) => setPath(e.currentTarget.value)} />
          </form>
        ) : (
          <button class="ghost" onClick={() => setAdding(true)}>
            + Project
          </button>
        )}
      </div>

      {project && (
        <>
          <nav>
            <a href={link('new')} class={`new ${section === 'new' ? 'active' : ''}`}>
              + New conversation
            </a>
            <a href={link('docs')} class={section === 'docs' ? 'active' : ''}>Documents</a>
            <a href={link('workflows')} class={section === 'workflows' ? 'active' : ''}>Workflows</a>
            <a href={link('processes')} class={section === 'processes' ? 'active' : ''}>Processes</a>
            <a href={link('settings')} class={section === 'settings' ? 'active' : ''}>Settings</a>
          </nav>
          <div class="threads">
            {threads?.map((t) => (
              <a key={t.id} href={link(`t/${t.id}`)} class={`${section === 't' && activeId === t.id ? 'active' : ''} ${t.unread ? 'unread' : ''}`}>
                {t.busy && <span class="pulse" />}
                <span class="label">{t.label ?? 'New conversation'}</span>
              </a>
            ))}
          </div>
        </>
      )}
    </aside>
  )
}

function Welcome() {
  return (
    <div class="empty">
      <h2>Add a project</h2>
      <p>Point Savor at a folder. Conversations, documents and workflows live in its <code>.savor/</code> directory.</p>
    </div>
  )
}

render(<App />, document.getElementById('app')!)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')
