import { useEffect, useRef, useState } from 'preact/hooks'
import { lazy, Suspense } from 'preact/compat'
import { ChevronDown, ChevronRight, File, FileText, Folder, Plus, Trash2 } from 'lucide-preact'
import { api, go, useApi, type Doc, type Project } from './api'

// The editors are big: they load when a file or document opens.
const CodeEditor = lazy(() => import('./CodeEditor'))
const RichEditor = lazy(() => import('./RichEditor'))

interface Entry { name: string; path: string; dir: boolean }

// Routes: files | files/doc/:id | files/f/:encodedPath[/:line]
export function FilesView({ project, rest }: { project: Project; rest: string[] }) {
  const [kind, id, line] = rest
  const base = `/projects/${project.id}`
  const [docs] = useApi<Doc[]>(`${base}/docs`, (e) => e.type === 'documents' && e.projectId === project.id)
  const newDoc = async () => {
    const d = await api<Doc>('POST', `${base}/docs`, { title: 'Untitled', content: '' })
    go(`/p/${project.id}/files/doc/${d.id}`)
  }
  return (
    <div class="files">
      <aside class="file-tree">
        <div class="tree-head">
          <span>Documents</span>
          <button class="icon-btn" title="New document" onClick={newDoc}>
            <Plus size={15} />
          </button>
        </div>
        {docs?.map((d) => (
          <a key={d.id} class={`tree-item ${kind === 'doc' && id === d.id ? 'active' : ''}`} href={`#/p/${project.id}/files/doc/${d.id}`}>
            <FileText size={14} /> {d.title}
          </a>
        ))}
        {docs && !docs.length && <p class="muted small pad">No documents yet.</p>}
        <div class="tree-head">
          <span>{project.name}</span>
        </div>
        <Tree project={project} path="" active={kind === 'f' ? id : undefined} />
      </aside>
      <section class="file-view">
        {kind === 'doc' && id ? (
          <DocEditor key={id} base={base} id={id} projectId={project.id} />
        ) : kind === 'f' && id ? (
          <FileEditor key={id} base={base} path={id} line={Number(line) || undefined} />
        ) : (
          <div class="empty-state">
            <h2>Files</h2>
            <p class="muted">Documents you and your agents write, plus everything in {project.path}.</p>
          </div>
        )}
      </section>
    </div>
  )
}

function Tree({ project, path, active }: { project: Project; path: string; active?: string }) {
  const [entries] = useApi<Entry[]>(`/projects/${project.id}/files?path=${encodeURIComponent(path)}`, () => false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  return (
    <div class="tree">
      {entries?.map((e) =>
        e.dir ? (
          <div key={e.path}>
            <button class="tree-item" onClick={() => setOpen({ ...open, [e.path]: !open[e.path] })}>
              {open[e.path] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Folder size={14} /> {e.name}
            </button>
            {open[e.path] && (
              <div class="tree-children">
                <Tree project={project} path={e.path} active={active} />
              </div>
            )}
          </div>
        ) : (
          <a key={e.path} class={`tree-item file ${active === e.path ? 'active' : ''}`} href={`#/p/${project.id}/files/f/${encodeURIComponent(e.path)}`}>
            <File size={14} /> {e.name}
          </a>
        ),
      )}
    </div>
  )
}

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path)

// Markdown opens in the rich editor unless the source view was chosen; the choice is remembered.
function useMarkdownMode() {
  const [rich, setRich] = useState(() => localStorage.getItem('savor-md-editor') !== 'source')
  const toggle = (next: boolean) => {
    localStorage.setItem('savor-md-editor', next ? 'rich' : 'source')
    setRich(next)
  }
  return [rich, toggle] as const
}

const ModeToggle = ({ rich, setRich }: { rich: boolean; setRich: (b: boolean) => void }) => (
  <div class="segmented">
    <button type="button" class={rich ? 'selected' : ''} onClick={() => setRich(true)}>
      Rich
    </button>
    <button type="button" class={!rich ? 'selected' : ''} onClick={() => setRich(false)}>
      Markdown
    </button>
  </div>
)

const Loading = () => <p class="muted pad">Loading editor…</p>

function FileEditor({ base, path, line }: { base: string; path: string; line?: number }) {
  const [file, setFile] = useState<{ content: string; binary: boolean; truncated: boolean; size: number } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [rich, setRich] = useMarkdownMode()
  useEffect(() => void api('GET', `${base}/file?path=${encodeURIComponent(path)}`).then(setFile, (e) => setError(e.message)), [path])
  const dirty = file !== null && draft !== null && draft !== file.content
  const save = async () => {
    if (!dirty) return
    try {
      await api('PUT', `${base}/file`, { path, content: draft })
      setFile({ ...file, content: draft })
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  if (error && !file) return <div class="error-text pad">{error}</div>
  if (!file) return null
  const md = isMarkdown(path)
  return (
    <article class="doc editor-page">
      <div class="doc-head">
        <h1 class="mono">{path}</h1>
        <div class="row">
          {md && !file.binary && <ModeToggle rich={rich} setRich={setRich} />}
          {dirty && <span class="muted small">Unsaved changes</span>}
          {!file.binary && !file.truncated && (
            <button class="primary" disabled={!dirty} onClick={save} title="Save (Ctrl+S)">
              Save
            </button>
          )}
        </div>
      </div>
      {error && <div class="error-text">{error}</div>}
      {file.binary ? (
        <p class="muted">Binary file · {file.size} bytes</p>
      ) : file.truncated ? (
        <>
          <p class="muted">Showing the first 512 KB. Files this large can't be edited here.</p>
          <pre class="code">{file.content}</pre>
        </>
      ) : (
        <Suspense fallback={<Loading />}>
          {md && rich ? (
            <RichEditor key="rich" value={draft ?? file.content} onChange={setDraft} onSave={save} />
          ) : (
            <CodeEditor key="code" value={draft ?? file.content} path={path} line={line} onChange={setDraft} onSave={save} />
          )}
        </Suspense>
      )}
    </article>
  )
}

// Documents save themselves a moment after each change.
function DocEditor({ base, id, projectId }: { base: string; id: string; projectId: string }) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [title, setTitle] = useState('')
  const [state, setState] = useState<'saved' | 'unsaved' | 'saving' | 'error'>('saved')
  const [rich, setRich] = useMarkdownMode()
  const pending = useRef<{ title: string; content: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    api<Doc>('GET', `${base}/docs/${id}`).then((d) => {
      setDoc(d)
      setTitle(d.title)
    })
  }, [id])

  const flush = async () => {
    const next = pending.current
    if (!next) return
    pending.current = null
    setState('saving')
    try {
      await api('PUT', `${base}/docs/${id}`, next)
      setState(pending.current ? 'unsaved' : 'saved')
    } catch {
      setState('error')
    }
  }
  const schedule = (patch: Partial<{ title: string; content: string }>) => {
    pending.current = { title: pending.current?.title ?? title, content: pending.current?.content ?? doc!.content, ...patch }
    setState('unsaved')
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, 800)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  const remove = async () => {
    if (!doc || !confirm(`Delete “${doc.title}”?`)) return
    await api('DELETE', `${base}/docs/${id}`)
    go(`/p/${projectId}/files`)
  }
  if (!doc) return null
  const content = pending.current?.content ?? doc.content
  return (
    <article class="doc editor-page">
      <div class="doc-head">
        <input
          class="title-input"
          value={title}
          placeholder="Title"
          onInput={(e) => {
            setTitle(e.currentTarget.value)
            schedule({ title: e.currentTarget.value })
          }}
        />
        <div class="row">
          <ModeToggle rich={rich} setRich={setRich} />
          <span class={`muted small ${state === 'error' ? 'error-text' : ''}`}>{{ saved: 'Saved', unsaved: 'Unsaved', saving: 'Saving…', error: 'Could not save' }[state]}</span>
          <button class="ghost danger" title="Delete document" onClick={remove}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <Suspense fallback={<Loading />}>
        {rich ? (
          <RichEditor key="rich" value={content} onChange={(c) => schedule({ content: c })} onSave={flush} autoFocus={!doc.content} />
        ) : (
          <CodeEditor key="code" value={content} path={`${doc.title}.md`} onChange={(c) => schedule({ content: c })} onSave={flush} />
        )}
      </Suspense>
    </article>
  )
}
