import { useEffect, useState } from 'preact/hooks'
import { ChevronDown, ChevronRight, File, FileText, Folder, Plus, Pencil, Trash2 } from 'lucide-preact'
import { api, go, useApi, type Doc, type Project } from './api'
import { Markdown } from './Conversations'

interface Entry { name: string; path: string; dir: boolean }

// Routes: files | files/doc/:id | files/f/:encodedPath
export function FilesView({ project, rest }: { project: Project; rest: string[] }) {
  const [kind, id] = rest
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
          <FileEditor key={id} base={base} path={id} />
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
  const [entries, setEntries] = useState<Entry[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  useEffect(() => void api<Entry[]>('GET', `/projects/${project.id}/files?path=${encodeURIComponent(path)}`).then(setEntries), [path])
  return (
    <div class="tree">
      {entries.map((e) =>
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

function FileEditor({ base, path }: { base: string; path: string }) {
  const [file, setFile] = useState<{ content: string; binary: boolean; truncated: boolean; size: number } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const load = () => api('GET', `${base}/file?path=${encodeURIComponent(path)}`).then(setFile, (e) => setError(e.message))
  useEffect(() => void load(), [path])
  const save = async () => {
    await api('PUT', `${base}/file`, { path, content: draft })
    setDraft(null)
    load()
  }
  if (error) return <div class="error-text pad">{error}</div>
  if (!file) return null
  const isMd = path.endsWith('.md')
  return (
    <article class="doc">
      <div class="doc-head">
        <h1 class="mono">{path}</h1>
        {!file.binary && !file.truncated && draft === null && (
          <button class="ghost" onClick={() => setDraft(file.content)}>
            <Pencil size={14} /> Edit
          </button>
        )}
      </div>
      {file.binary ? (
        <p class="muted">Binary file · {file.size} bytes</p>
      ) : draft !== null ? (
        <>
          <textarea class="code-input" value={draft} onInput={(e) => setDraft(e.currentTarget.value)} />
          <div class="row">
            <button class="primary" onClick={save}>
              Save
            </button>
            <button class="ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : isMd ? (
        <Markdown text={file.content} />
      ) : (
        <pre class="code">{file.content}</pre>
      )}
      {file.truncated && <p class="muted">Showing the first 512 KB.</p>}
    </article>
  )
}

function DocEditor({ base, id, projectId }: { base: string; id: string; projectId: string }) {
  const [doc] = useApi<Doc>(`${base}/docs/${id}`, (e) => e.type === 'documents' && e.projectId === projectId)
  const [draft, setDraft] = useState<{ title: string; content: string } | null>(null)
  useEffect(() => {
    if (doc && doc.title === 'Untitled' && !doc.content && draft === null) setDraft({ title: doc.title, content: '' })
  }, [doc])
  if (!doc) return null
  const save = async () => {
    await api('PUT', `${base}/docs/${id}`, draft)
    setDraft(null)
  }
  const remove = async () => {
    if (!confirm(`Delete “${doc.title}”?`)) return
    await api('DELETE', `${base}/docs/${id}`)
    go(`/p/${projectId}/files`)
  }
  return (
    <article class="doc">
      {draft ? (
        <>
          <input class="title-input" value={draft.title} onInput={(e) => setDraft({ ...draft, title: e.currentTarget.value })} />
          <textarea class="code-input" placeholder="Write in markdown…" value={draft.content} onInput={(e) => setDraft({ ...draft, content: e.currentTarget.value })} />
          <div class="row">
            <button class="primary" onClick={save}>
              Save
            </button>
            <button class="ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div class="doc-head">
            <h1>{doc.title}</h1>
            <div class="row">
              <button class="ghost" onClick={() => setDraft({ title: doc.title, content: doc.content })}>
                <Pencil size={14} /> Edit
              </button>
              <button class="ghost danger" onClick={remove}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          <Markdown text={doc.content} />
        </>
      )}
    </article>
  )
}
