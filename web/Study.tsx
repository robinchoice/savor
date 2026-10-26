import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { ArrowLeft, ArrowLeftRight, BookOpen, Download, ExternalLink, FileText, MessageSquare, PenLine, Plus, Search, Upload, X } from 'lucide-preact'
import { api, freeAgent, go, kindOf, readFileAsDataUrl, RINGS, useApi, type AgentConfig, type Attachment, type Fallback, type Project, type Thread } from './api'
import { REASONS, ThreadView } from './Conversations'
import { Composer } from './Composer'
import { FileEditor, FilePreview } from './Files'
import { useNarrow } from './Layout'
import { askInChat, FORMATS, mainThread, STYLES } from './Workspace'
import { plural, t, tx } from './i18n'
import { authorLine, pdfPage, StudyContext, type Source, type StudyScope } from './cite'

// Academic writing in three columns, like NotebookLM: the sources, one chat for the whole work, and the
// work itself with its chapters and the export. A chapter or a PDF opens on the right, or in the middle
// for those who rather write than chat. Everything shown comes from the project's files.

interface Sources { bibliography: string; sources: Source[]; missing: { key: string; cited: number }[] }
interface Hit { id: string; doi: string | null; title: string; year: number | null; authors: string[]; moreAuthors: boolean; venue: string; cited: number; pdf: boolean; url: string | null; added: boolean }
interface Check { level: 'ok' | 'error' | 'warn' | 'info'; text: string; file?: string; line?: number }
interface Work { format: string; style: string | null; outline: { path: string; title: string; words: number }[]; words: number; target: number; title: string | null; kind: string | null; deadline: string | null; checks: Check[]; missingTools: string[] }
// `jump` counts the citations followed, so the same one again goes back to its page.
type Open = { kind: 'chapter'; path: string } | { kind: 'pdf'; path: string; page?: number | null; jump?: number } | null
type Tab = 'sources' | 'chat' | 'work'

export function StudyView({ project, threadId, isNew }: { project: Project; threadId?: string; isNew?: boolean }) {
  const [threads] = useApi<Thread[]>(`/projects/${project.id}/threads`, (e) => e.projectId === project.id && ['thread', 'status', 'message'].includes(e.type))
  const narrow = useNarrow()
  const [tab, setTab] = useState<Tab>('chat')
  const [open, setOpenState] = useState<Open>(null)
  const wideKey = `savor-study-wide:${project.id}`
  const [wide, setWideState] = useState(() => localStorage.getItem(wideKey) === '1')
  const setWide = (on: boolean) => {
    localStorage.setItem(wideKey, on ? '1' : '0')
    setWideState(on)
  }
  const setOpen = (o: Open) => {
    setOpenState(o)
    if (narrow) setTab('work')
  }
  const main = threads && !isNew ? mainThread(threads) : undefined
  const chatId = isNew ? undefined : threadId ?? main?.id
  // Asked from a source or a check: into the chat, or as the first message of a new one.
  const ask = async (text: string) => {
    if (narrow) setTab('chat')
    if (chatId) return void (await api('POST', `/projects/${project.id}/threads/${chatId}/messages`, { text }))
    go(`/p/${project.id}/t/${await askInChat(project, text)}`)
  }
  // A source added here can be one the manuscript already cites, so the checks of the work follow.
  const [sourcesRev, setSourcesRev] = useState(0)
  const [sourcesData, reloadSources] = useApi<Sources>(`/projects/${project.id}/sources`, (e) => e.projectId === project.id && e.type === 'status')
  const [selected, setSelected] = useState<Source | null>(null)
  const [focus, setFocus] = useState<Source[]>([])
  const jumps = useRef(0)
  const scope = useMemo<StudyScope>(() => {
    const sources = sourcesData?.sources ?? []
    return {
      sources,
      // The picked sources as listed now, with a text copy that may have come since; gone ones drop out.
      focus: sourcesData ? focus.map((f) => sources.find((s) => same(s, f))).filter((s): s is Source => !!s) : focus,
      setFocus,
      // A citation opens its PDF at the page, or the source's details when there is no PDF.
      open: async (key, page) => {
        const s = sources.find((x) => x.key === key)
        if (!s) return
        if (s.file) return setOpen({ kind: 'pdf', path: s.file, page: await pdfPage(`/projects/${project.id}`, s, page), jump: ++jumps.current })
        setSelected(s)
        if (narrow) setTab('sources')
      },
    }
  }, [sourcesData, focus, narrow])
  // Asking about one source picks it for the next questions.
  const askAbout = (s: Source) => {
    setFocus([s])
    if (narrow) setTab('chat')
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.study-chat .composer textarea')?.focus())
  }
  const others = (threads ?? []).filter((th) => th.id !== chatId && !th.completed && (th.busy || th.waiting || th.waitsFor))

  const chat = (
    <section class="study-chat">
      {!threads ? null : chatId ? (
        <ThreadView key={chatId} project={project} threadId={chatId} plain={chatId === main?.id ? 'main' : 'side'} />
      ) : (
        <NewChat project={project} />
      )}
    </section>
  )
  const doc = open && <DocPane project={project} open={open} close={() => setOpenState(null)} wide={wide && !narrow} setWide={setWide} narrow={narrow} />
  const work = <WorkPane project={project} open={setOpen} ask={ask} others={others} rev={sourcesRev} />
  const swapped = wide && !narrow && !!open
  return (
    <StudyContext.Provider value={scope}>
    <div class={`study tab-${tab} ${swapped ? 'swapped' : ''}`}>
      <SourcesPane project={project} data={sourcesData} reload={reloadSources} selected={selected} setSelected={setSelected} openPdf={(path) => setOpen({ kind: 'pdf', path })} ask={ask} askAbout={askAbout} changed={() => setSourcesRev((n) => n + 1)} />
      <div class="study-mid">{swapped ? doc : chat}</div>
      <div class="study-side">{swapped ? chat : doc || work}</div>
      {narrow && (
        <nav class="study-tabs">
          {([['sources', BookOpen, t('Sources')], ['chat', MessageSquare, t('Chat')], ['work', PenLine, t('Manuscript')]] as const).map(([id, Icon, label]) => (
            <button key={id} class={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
    </StudyContext.Provider>
  )
}

function NewChat({ project }: { project: Project }) {
  const [chosen, setAgent] = useState<AgentConfig | null>(null)
  const [fallback] = useApi<Fallback>('/fallback', (e) => e.type === 'settings' || e.type === 'status')
  const agent = chosen ?? freeAgent(project.agent, fallback)
  const send = async (text: string, attachments: Attachment[]) => {
    const th = await api<Thread>('POST', `/projects/${project.id}/threads`, { text, attachments, agent: chosen ?? project.agent })
    go(`/p/${project.id}/t/${th.id}`)
  }
  return (
    <section class="thread new-thread">
      <div class="new-hero">
        <h1>{t('What are you working on?')}</h1>
        <p class="muted">{t('Ask about your sources, or give the agent a task for the work: search for literature, draft a chapter, check the citations.')}</p>
      </div>
      <Composer project={project} agent={agent} setAgent={setAgent} onSend={send} placeholder={t('Ask about your sources or give a task…')} autoFocus />
    </section>
  )
}

function SourcesPane({ project, data, reload, selected, setSelected, openPdf, ask, askAbout, changed }: { project: Project; data: Sources | null | undefined; reload: () => void; selected: Source | null; setSelected: (s: Source | null) => void; openPdf: (path: string) => void; ask: (text: string) => void; askAbout: (s: Source) => void; changed: () => void }) {
  const base = `/projects/${project.id}/sources`
  const { focus, setFocus } = useContext(StudyContext)!
  const picked = (s: Source) => focus.some((f) => same(f, s))
  const [searching, setSearching] = useState(false)
  const [note, setNote] = useState<{ text: string; url?: string | null; error?: boolean } | null>(null)
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const upload = async (files: File[]) => {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')
    if (!pdfs.length) return setNote({ text: t('Only PDFs can be added as sources.'), error: true })
    setNote({ text: plural(pdfs.length, 'Adding {n} PDF…', 'Adding {n} PDFs…') })
    let withEntry = 0
    try {
      for (const f of pdfs) {
        const r = await api<{ key: string | null }>('POST', `${base}/upload`, { name: f.name, dataUrl: await readFileAsDataUrl(f) })
        if (r.key) withEntry++
      }
      setNote({ text: withEntry === pdfs.length ? plural(pdfs.length, 'Added {n} PDF with its entry in the bibliography.', 'Added {n} PDFs with their entries in the bibliography.') : t('Added to sources/. Savor found no DOI in some of them: open one to let the agent fill in the details.') })
    } catch (e) {
      setNote({ text: tx((e as Error).message), error: true })
    }
    reload()
    changed()
  }
  const added = (r: { key: string; file: string | null; pdfUrl: string | null }) => {
    setNote(r.file ? { text: t('Added {key} with its PDF.', { key: r.key }) } : { text: t('Added {key} to the bibliography. No open PDF could be downloaded: get it in the browser and upload it.', { key: r.key }), url: r.pdfUrl })
    reload()
    changed()
  }
  const sources = data?.sources ?? []
  return (
    <aside
      class={`study-sources ${drag ? 'drop' : ''}`}
      onDragOver={(e) => (e.preventDefault(), setDrag(true))}
      onDragLeave={(e) => !(e.currentTarget as Node).contains(e.relatedTarget as Node) && setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        if (e.dataTransfer?.files.length) upload([...e.dataTransfer.files])
      }}
    >
      {selected ? (
        <SourceDetail source={selected} back={() => setSelected(null)} openPdf={openPdf} ask={ask} askAbout={askAbout} bibliography={data?.bibliography ?? 'references.bib'} />
      ) : (
        <>
          <div class="study-head">
            <h2>{t('Sources')}</h2>
            <span class="muted small">{sources.length || ''}</span>
          </div>
          <div class="study-actions">
            <button class={`ghost ${searching ? 'on' : ''}`} onClick={() => setSearching(!searching)}>
              <Search size={15} /> {t('Search')}
            </button>
            <button class="ghost" onClick={() => input.current!.click()}>
              <Upload size={15} /> {t('Upload')}
            </button>
            <input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => (upload([...e.currentTarget.files!]), (e.currentTarget.value = ''))} />
          </div>
          {note && (
            <div class={`study-note ${note.error ? 'error' : ''}`}>
              <span>
                {note.text}{' '}
                {note.url && (
                  <a href={note.url} target="_blank" rel="noreferrer">
                    {t('Open the PDF')} <ExternalLink size={11} />
                  </a>
                )}
              </span>
              <button class="icon-btn" title={t('Close')} onClick={() => setNote(null)}>
                <X size={13} />
              </button>
            </div>
          )}
          {searching && <SourceSearch project={project} added={added} />}
          {focus.length > 0 && (
            <div class="study-focus small">
              <span>{plural(focus.length, 'Answers only from {n} source', 'Answers only from {n} sources')}</span>
              <button class="link-btn" onClick={() => setFocus([])}>
                {t('All sources')}
              </button>
            </div>
          )}
          <div class="study-list">
            {data?.missing.map((m) => (
              <div key={m.key} class="study-source missing">
                <span class="doc-icon">?</span>
                <div>
                  <div class="title mono">[@{m.key}]</div>
                  <div class="tags">
                    <span class="tag warn">{t('cited, but not in {file}', { file: data.bibliography })}</span>
                  </div>
                  <button class="link-btn" onClick={() => ask(`The manuscript cites [@${m.key}], but ${data.bibliography} has no entry for it. Find the work, check its DOI, and add the entry under exactly this key. Do not invent anything: if you can't find it, tell me.`)}>
                    {t('Let the agent find it')}
                  </button>
                </div>
              </div>
            ))}
            {sources.map((s) => (
              <div key={s.key ?? s.file} class={`study-source-row ${picked(s) ? 'picked' : ''}`}>
                <button class="study-source" onClick={() => setSelected(s)}>
                  <span class="doc-icon">{s.file ? 'PDF' : '—'}</span>
                  <div>
                    <div class="title">{s.title}</div>
                    {(s.authors || s.year) && <div class="muted small">{[authorLine(s.authors), s.year].filter(Boolean).join(' · ')}</div>}
                    <div class="tags">
                      {!s.key ? <span class="tag warn">{t('no entry yet')}</span> : s.cited ? <span class="tag ok">{t('cited {n}×', { n: s.cited })}</span> : <span class="tag">{t('not cited')}</span>}
                      {s.key && !s.file && <span class="tag">{t('no PDF')}</span>}
                    </div>
                  </div>
                </button>
                <label class="study-pick" title={t('Answer the next questions from this source')}>
                  <input type="checkbox" aria-label={t('Answer the next questions from this source')} checked={picked(s)} onChange={() => setFocus(picked(s) ? focus.filter((f) => !same(f, s)) : [...focus, s])} />
                </label>
              </div>
            ))}
            {data && !sources.length && !data.missing.length && <p class="muted small study-empty">{t('No sources yet. Search for literature or upload PDFs; they go into sources/ and their entries into {file}.', { file: data.bibliography })}</p>}
            <div class="study-drop muted small">{t('Drop PDFs here')}</div>
          </div>
        </>
      )}
    </aside>
  )
}

function SourceSearch({ project, added }: { project: Project; added: (r: { key: string; file: string | null; pdfUrl: string | null }) => void }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'best' | 'cited' | 'new'>('best')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const run = async (s = sort) => {
    if (!q.trim()) return
    setBusy('search')
    setError('')
    try {
      setHits(await api<Hit[]>('GET', `/projects/${project.id}/sources/search?q=${encodeURIComponent(q)}&sort=${s}`))
    } catch (e) {
      setError(tx((e as Error).message))
    }
    setBusy(null)
  }
  const add = async (h: Hit) => {
    setBusy(h.id)
    setError('')
    try {
      added(await api('POST', `/projects/${project.id}/sources`, { doi: h.doi }))
      setHits((list) => list!.map((x) => (x.id === h.id ? { ...x, added: true } : x)))
    } catch (e) {
      setError(tx((e as Error).message))
    }
    setBusy(null)
  }
  return (
    <div class="study-search">
      <input autoFocus placeholder={t('Topic, title, author or DOI')} value={q} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
      <div class="row small">
        {(['best', 'cited', 'new'] as const).map((s) => (
          <button key={s} class={`ws-chip ${sort === s ? 'on' : ''}`} onClick={() => (setSort(s), hits && run(s))}>
            {s === 'best' ? t('Best match') : s === 'cited' ? t('Most cited') : t('Newest')}
          </button>
        ))}
        <span class="spacer" />
        <span class="muted">{t('in OpenAlex')}</span>
      </div>
      {error && <div class="error-text small">{error}</div>}
      {busy === 'search' && <p class="muted small">{t('Searching…')}</p>}
      {hits && busy !== 'search' && (
        <div class="study-hits">
          {!hits.length && <p class="muted small">{t('Nothing found.')}</p>}
          {hits.map((h) => (
            <div key={h.id} class="study-hit">
              <div>
                <div class="title">{h.title}</div>
                <div class="muted small">
                  {[h.authors.join(', ') + (h.moreAuthors ? ' …' : ''), h.year, h.venue].filter(Boolean).join(' · ')}
                </div>
                <div class="tags">
                  <span class="tag">{plural(h.cited, '{n} citation', '{n} citations')}</span>
                  {h.pdf ? <span class="tag ok">{t('open PDF')}</span> : <span class="tag">{t('no open PDF')}</span>}
                  {h.url && (
                    <a class="tag" href={h.url} target="_blank" rel="noreferrer">
                      {t('open')} <ExternalLink size={10} />
                    </a>
                  )}
                </div>
              </div>
              <button class="icon-btn" disabled={h.added || !h.doi || !!busy} title={h.added ? t('In your sources') : !h.doi ? t('Without a DOI Savor can\'t add it') : t('Add to the sources')} onClick={() => add(h)}>
                {busy === h.id ? <span class="spinner" /> : h.added ? '✓' : <Plus size={15} />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// The same work by its key or its PDF: a loose PDF keeps its file when it gets an entry.
const same = (a: Source, b: Source) => (!!a.key && a.key === b.key) || (!!a.file && a.file === b.file)

function SourceDetail({ source: s, back, openPdf, ask, askAbout, bibliography }: { source: Source; back: () => void; openPdf: (path: string) => void; ask: (text: string) => void; askAbout: (s: Source) => void; bibliography: string }) {
  return (
    <div class="study-detail">
      <button class="ghost small" onClick={back}>
        <ArrowLeft size={14} /> {t('All sources')}
      </button>
      <h3>{s.title}</h3>
      <p class="muted small">
        {[s.authors.split(/\s+and\s+/).join('; '), s.year, s.venue].filter(Boolean).join(' · ')}
        {s.doi && (
          <>
            <br />
            <a href={`https://doi.org/${s.doi}`} target="_blank" rel="noreferrer">
              doi.org/{s.doi}
            </a>
          </>
        )}
      </p>
      <div class="tags">
        {s.key && <span class="tag mono">@{s.key}</span>}
        {s.file && <span class="tag mono">{s.file}</span>}
        {s.key && <span class={`tag ${s.cited ? 'ok' : ''}`}>{s.cited ? t('cited {n}×', { n: s.cited }) : t('not cited')}</span>}
      </div>
      <div class="row wrap">
        {s.file && (
          <button class="ghost" onClick={() => openPdf(s.file!)}>
            <FileText size={15} /> {t('Open PDF')}
          </button>
        )}
        {(s.key || s.file) && (
          <button class="ghost" onClick={() => askAbout(s)}>
            <MessageSquare size={15} /> {t('Ask in the chat')}
          </button>
        )}
        {!s.key && s.file && (
          <button class="ghost" onClick={() => ask(`${s.file} has no entry in ${bibliography} yet. Read the PDF, find the work and check its DOI, add the entry, and rename the file to <key>.pdf. Do not invent anything: if you can't identify it, tell me.`)}>
            {t('Let the agent fill in the details')}
          </button>
        )}
      </div>
    </div>
  )
}

function WorkPane({ project, open, ask, others, rev }: { project: Project; open: (o: Open) => void; ask: (text: string) => void; others: Thread[]; rev: number }) {
  const base = `/projects/${project.id}/export`
  const [work, reload] = useApi<Work>(base, (e) => e.projectId === project.id && e.type === 'status')
  useEffect(() => void (rev && reload()), [rev])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ path: string } | null>(null)
  const [error, setError] = useState('')
  if (!work) return <aside class="study-work" />
  const problems = work.checks.filter((c) => c.level === 'error' || c.level === 'warn')
  const format = FORMATS.find(([id]) => id === work.format)?.[1] ?? work.format
  const style = STYLES.find(([id]) => id === work.style)?.[1] ?? work.style
  const days = work.deadline && /^\d{4}-\d{2}-\d{2}$/.test(work.deadline) ? Math.ceil((new Date(work.deadline).getTime() - Date.now()) / 86_400_000) : null
  const run = async () => {
    setBusy(true)
    setError('')
    setResult(null)
    try {
      setResult(await api('POST', base))
      reload()
    } catch (e) {
      setError(tx((e as Error).message))
    }
    setBusy(false)
  }
  const fix = () => ask(`Fix what keeps the manuscript from a clean export:\n\n${problems.map((c) => `- ${c.text}${c.file ? ` (${c.file}${c.line ? `:${c.line}` : ''})` : ''}`).join('\n')}\n\nDo not invent sources: if a citation has no entry, find the work and check its DOI, or tell me what is missing.`)
  return (
    <aside class="study-work">
      <div class="study-head">
        <h2>{t('Manuscript')}</h2>
      </div>
      <div class="study-body">
        {others.length > 0 && (
          <div class="ws-card work-bg-card">
            <div class="field-label">{t('In the background')}</div>
            {others.map((th) => (
              <a key={th.id} class="work-bg" href={`#/p/${project.id}/t/${th.id}`}>
                <span class={`ring ${RINGS[kindOf(th)]}`} />
                <span class="name">{th.summary ?? th.title}</span>
                <span class="muted small">{th.waitsFor ? REASONS[th.waitsFor.reason] : t('Working')}</span>
              </a>
            ))}
          </div>
        )}
        {work.title && <div class="work-title">{work.title}</div>}
        <div class="muted small">
          {[work.kind, style, work.deadline && (days !== null && days >= 0 ? t('due {date} ({n} days)', { date: new Date(work.deadline).toLocaleDateString(), n: days }) : t('due {date}', { date: work.deadline }))].filter(Boolean).join(' · ')}
        </div>
        <div class="work-progress">
          <span class="small muted">{work.target ? t('{n} of {target} words', { n: work.words.toLocaleString(), target: work.target.toLocaleString() }) : plural(work.words, '{n} word', '{n} words')}</span>
          {work.target > 0 && (
            <div class="bar">
              <i style={{ width: `${Math.min(100, (work.words / work.target) * 100)}%` }} />
            </div>
          )}
        </div>
        <div class="field-label">{t('Chapters')}</div>
        {work.outline.map((c) => (
          <button key={c.path} class="work-chapter" onClick={() => open({ kind: 'chapter', path: c.path })}>
            <span class="name">{c.title}</span>
            <span class="muted small">{c.words ? c.words.toLocaleString() : '–'}</span>
          </button>
        ))}
        {!work.outline.length && <p class="muted small">{t('No chapters in manuscript/ yet.')}</p>}
        <div class="field-label">{t('Export')}</div>
        <div class="ws-card">
          <div class="row">
            <b>{format}</b>
            <span class="spacer" />
            <a class="small" href={`#/p/${project.id}/export`}>
              {t('Settings')}
            </a>
          </div>
          {problems.map((c, i) => (
            <div key={i} class={`ws-check lvl-${c.level}`}>
              <i>{c.level === 'error' ? '✗' : '!'}</i>
              <span>
                {tx(c.text)}
                {c.file && (
                  <>
                    {' · '}
                    <button class="link-btn mono" onClick={() => open({ kind: 'chapter', path: c.file! })}>
                      {c.file.replace(/^manuscript\//, '')}
                      {c.line ? `:${c.line}` : ''}
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
          {!problems.length && <div class="ws-check lvl-ok"><i>✓</i><span>{t('Ready to export')}</span></div>}
          {work.missingTools.length > 0 && (
            <div class="ws-check lvl-error">
              <i>✗</i>
              <span>
                {t('{tools} not installed.', { tools: work.missingTools.join(t(' and ')) })} <a href={`#/p/${project.id}/export`}>{t('More')}</a>
              </span>
            </div>
          )}
          <div class="row">
            <button class="primary" disabled={busy || work.missingTools.length > 0 || !work.outline.length} onClick={run}>
              <Download size={15} /> {busy ? t('Exporting…') : t('Export')}
            </button>
            {problems.length > 0 && (
              <button class="ghost" onClick={fix}>
                {t('Let the agent fix it')}
              </button>
            )}
          </div>
          {error && <div class="error-text small">{error}</div>}
          {result && (
            <a class="ws-file" href={`/api${base}/${encodeURIComponent(result.path.replace(/^export\//, ''))}`} download>
              <span class="mono small">{result.path}</span>
              <Download size={14} />
            </a>
          )}
        </div>
        <a class="small muted work-all" href={`#/p/${project.id}/conversations`}>
          {t('All conversations')}
        </a>
      </div>
    </aside>
  )
}

function DocPane({ project, open, close, wide, setWide, narrow }: { project: Project; open: NonNullable<Open>; close: () => void; wide: boolean; setWide: (on: boolean) => void; narrow: boolean }) {
  const base = `/projects/${project.id}`
  return (
    <aside class="study-doc">
      <div class="study-doc-bar">
        <button class="ghost small" onClick={close}>
          <ArrowLeft size={14} /> {t('Overview')}
        </button>
        <span class="spacer" />
        {!narrow && (
          <button class={`ghost small ${wide ? 'on' : ''}`} title={wide ? t('Text back to the right, chat in the middle') : t('Text in the middle, chat on the right')} onClick={() => setWide(!wide)}>
            <ArrowLeftRight size={14} /> {wide ? t('Chat in the middle') : t('Text in the middle')}
          </button>
        )}
      </div>
      {open.kind === 'pdf' ? <FilePreview key={open.path} base={base} path={open.path} kind="pdf" page={open.page} jump={open.jump} /> : <FileEditor key={open.path} base={base} path={open.path} follow={project.id} />}
    </aside>
  )
}
