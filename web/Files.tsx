import { useEffect, useRef, useState } from 'preact/hooks'
import { lazy, Suspense } from 'preact/compat'
import { ChevronDown, ChevronRight, Download, File, FileText, Folder, Plus, Smartphone, Trash2 } from 'lucide-preact'
import { api, apiBlob, go, useApi, type Doc, type Project } from './api'
import { t, tx } from './i18n'
import type { PreviewKind } from './FileViewer'

// The editors are big: they load when a file or document opens.
const CodeEditor = lazy(() => import('./CodeEditor'))
const RichEditor = lazy(() => import('./RichEditor'))
const FileViewer = lazy(() => import('./FileViewer'))
const CsvTable = lazy(() => import('./FileViewer').then((m) => ({ default: m.CsvTable })))

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
          <span>{t('Documents')}</span>
          <button class="icon-btn" title={t('New document')} onClick={newDoc}>
            <Plus size={15} />
          </button>
        </div>
        {docs?.map((d) => (
          <a key={d.id} class={`tree-item ${kind === 'doc' && id === d.id ? 'active' : ''}`} href={`#/p/${project.id}/files/doc/${d.id}`}>
            <FileText size={14} /> {d.title} {d.origin === 'remote' && <span class="muted" title={t('Last changed from a paired device')}><Smartphone size={12} /></span>}
          </a>
        ))}
        {docs && !docs.length && <p class="muted small pad">{t('No documents yet.')}</p>}
        <div class="tree-head">
          <span>{project.name}</span>
        </div>
        <Tree project={project} path="" active={kind === 'f' ? id : undefined} />
      </aside>
      <section class="file-view">
        {kind === 'doc' && id ? (
          <DocEditor key={id} base={base} id={id} projectId={project.id} />
        ) : kind === 'f' && id && previewOf(id) ? (
          <FilePreview key={id} base={base} path={id} kind={previewOf(id)!} />
        ) : kind === 'f' && id ? (
          <FileEditor key={id} base={base} path={id} line={Number(line) || undefined} />
        ) : (
          <div class="empty-state">
            <h2>{t('Files')}</h2>
            <p class="muted">{t('Documents you and your agents write, plus everything in {path}.', { path: project.path })}</p>
          </div>
        )}
      </section>
    </div>
  )
}

function Tree({ project, path, active }: { project: Project; path: string; active?: string }) {
  const [entries] = useApi<Entry[]>(`/projects/${project.id}/files?path=${encodeURIComponent(path)}`, () => false)
  // A folder linked from a message comes up opened, as do the folders above the active entry.
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries((active?.split('/') ?? []).map((_, i, parts) => [parts.slice(0, i + 1).join('/'), true])))
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
const isTable = (path: string) => /\.(csv|tsv)$/i.test(path)
const previewOf = (path: string): PreviewKind | null => path.match(/\.(pdf|docx|xlsx)$/i)?.[1].toLowerCase() as PreviewKind ?? null

// Markdown opens in the rich editor and CSV as a table unless the source view was chosen; the choice is remembered.
function useRichMode(key: string) {
  const [rich, setRich] = useState(() => localStorage.getItem(key) !== 'source')
  const toggle = (next: boolean) => {
    localStorage.setItem(key, next ? 'rich' : 'source')
    setRich(next)
  }
  return [rich, toggle] as const
}

const ModeToggle = ({ rich, setRich, labels = [t('Rich'), t('Markdown')] }: { rich: boolean; setRich: (b: boolean) => void; labels?: string[] }) => (
  <div class="segmented">
    <button type="button" class={rich ? 'selected' : ''} onClick={() => setRich(true)}>
      {labels[0]}
    </button>
    <button type="button" class={!rich ? 'selected' : ''} onClick={() => setRich(false)}>
      {labels[1]}
    </button>
  </div>
)

const Loading = ({ text = t('Loading editor…') }: { text?: string }) => <p class="muted pad">{text}</p>

// PDFs, Word and Excel files open read-only, with a button to download them.
function FilePreview({ base, path, kind }: { base: string; path: string; kind: PreviewKind }) {
  const [file, setFile] = useState<{ blob: Blob; url: string } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let url = ''
    let gone = false
    apiBlob(`${base}/file/raw?path=${encodeURIComponent(path)}`).then(
      (b) => {
        if (gone) return
        // Only a PDF keeps its type, for the browser's viewer; a blob of another type could run script on this origin.
        const blob = new Blob([b], { type: kind === 'pdf' ? 'application/pdf' : 'application/octet-stream' })
        setFile({ blob, url: (url = URL.createObjectURL(blob)) })
      },
      (e) => !gone && setError(tx(e.message)),
    )
    return () => {
      gone = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [path])
  const name = path.split('/').pop()!
  return (
    <article class="doc editor-page">
      <div class="doc-head">
        <h1 class="mono">{path}</h1>
        {file && (
          <a class="ghost" href={file.url} download={name}>
            <Download size={14} /> {t('Download')}
          </a>
        )}
      </div>
      {error ? (
        <div class="error-text">{error}</div>
      ) : !file ? (
        <Loading text={t('Loading preview…')} />
      ) : (
        <Suspense fallback={<Loading text={t('Loading preview…')} />}>
          <FileViewer kind={kind} blob={file.blob} url={file.url} name={name} />
        </Suspense>
      )}
    </article>
  )
}

function FileEditor({ base, path, line }: { base: string; path: string; line?: number }) {
  const [file, setFile] = useState<{ dir?: boolean; content: string; binary: boolean; truncated: boolean; size: number } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [rich, setRich] = useRichMode(isTable(path) ? 'savor-csv-view' : 'savor-md-editor')
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
  if (file.dir)
    return (
      <div class="empty-state">
        <h2 class="mono">{path}</h2>
        <p class="muted">{t('A folder: its files are in the tree.')}</p>
      </div>
    )
  const md = isMarkdown(path)
  const table = isTable(path)
  return (
    <article class="doc editor-page">
      <div class="doc-head">
        <h1 class="mono">{path}</h1>
        <div class="row">
          {md && !file.binary && <ModeToggle rich={rich} setRich={setRich} />}
          {table && !file.binary && !file.truncated && <ModeToggle rich={rich} setRich={setRich} labels={[t('Table'), t('Text')]} />}
          {dirty && <span class="muted small">{t('Unsaved changes')}</span>}
          {!file.binary && !file.truncated && (
            <button class="primary" disabled={!dirty} onClick={save} title={t('Save (Ctrl+S)')}>
              {t('Save')}
            </button>
          )}
        </div>
      </div>
      {error && <div class="error-text">{error}</div>}
      {file.binary ? (
        <p class="muted">{t('Binary file · {n} bytes', { n: file.size })}</p>
      ) : file.truncated ? (
        <>
          <p class="muted">{t('Showing the first 512 KB. Files this large can\'t be edited here.')}</p>
          <pre class="code">{file.content}</pre>
        </>
      ) : (
        <Suspense fallback={<Loading />}>
          {md && rich ? (
            <RichEditor key="rich" value={draft ?? file.content} onChange={setDraft} onSave={save} />
          ) : table && rich ? (
            <CsvTable value={draft ?? file.content} />
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
  const [rich, setRich] = useRichMode('savor-md-editor')
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
    if (!doc || !confirm(t('Delete “{title}”?', { title: doc.title }))) return
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
          placeholder={t('Title')}
          onInput={(e) => {
            setTitle(e.currentTarget.value)
            schedule({ title: e.currentTarget.value })
          }}
        />
        <div class="row">
          <ModeToggle rich={rich} setRich={setRich} />
          <span class={`muted small ${state === 'error' ? 'error-text' : ''}`}>{{ saved: t('Saved'), unsaved: t('Unsaved'), saving: t('Saving…'), error: t('Could not save') }[state]}
</span>
          <button class="ghost danger" title={t('Delete document')} onClick={remove}>
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
