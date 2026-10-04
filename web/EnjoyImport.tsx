import { useEffect, useState } from 'preact/hooks'
import { Download, X } from 'lucide-preact'
import { api, go, type EnjoyProject, type EnjoyResult } from './api'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// Enjoy's projects on this computer, for the places that offer the import. Empty on paired devices.
export function useEnjoyProjects() {
  const [projects, setProjects] = useState<EnjoyProject[]>([])
  useEffect(() => void api<EnjoyProject[]>('GET', '/enjoy').then(setProjects, () => {}), [])
  return projects
}

export function EnjoyImport({ onClose }: { onClose: () => void }) {
  const [projects, setProjects] = useState<EnjoyProject[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<{ at: number; name: string } | null>(null)
  const [results, setResults] = useState<EnjoyResult[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api<EnjoyProject[]>('GET', '/enjoy').then(
      (list) => {
        setProjects(list)
        setChosen(new Set(list.filter((p) => !p.missing).map((p) => p.path)))
      },
      (e: Error) => setError(e.message),
    )
  }, [])
  const toggle = (path: string) => setChosen((c) => {
    const next = new Set(c)
    next.has(path) ? next.delete(path) : next.add(path)
    return next
  })
  // One project per request, so the progress shows and the daemon stays responsive in between.
  const run = async () => {
    const done: EnjoyResult[] = []
    try {
      for (const p of projects!.filter((p) => chosen.has(p.path))) {
        setProgress({ at: done.length + 1, name: p.name })
        done.push(...(await api<EnjoyResult[]>('POST', '/enjoy', { paths: [p.path] })))
      }
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
    setProgress(null)
    setResults(done)
  }
  const sum = (key: 'added' | 'updated' | 'kept' | 'documents' | 'workflows') => (results ?? []).reduce((n, r) => n + r[key], 0)

  return (
    <div class="overlay" onClick={progress ? undefined : onClose}>
      <div class="dialog import-dialog" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          <Download size={18} />
          <div class="dialog-title">
            <b>Import from Enjoy</b>
            <small class="muted">Projects, conversations, documents and workflows from Enjoy on this computer</small>
          </div>
          <button class="icon-btn" title="Close" disabled={!!progress} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div class="dialog-body">
          {error && <div class="error-text pad">{error}</div>}
          {results ? (
            <p class="pad">
              Imported {plural(sum('added'), 'conversation')}, {plural(sum('documents'), 'document')} and {plural(sum('workflows'), 'workflow')} from {plural(results.length, 'project')}.
              {sum('updated') > 0 && ` ${plural(sum('updated'), 'conversation')} got what happened in Enjoy since the last import.`}
              {sum('kept') > 0 && ` ${plural(sum('kept'), 'conversation')} stayed as they are in Savor.`}{' '}
              {results[0] && (
                <a class="link" href={`#/p/${results[0].projectId}`} onClick={onClose}>
                  Open {projects?.find((p) => p.path === results[0].path)?.name}
                </a>
              )}
            </p>
          ) : projects === null ? (
            <p class="muted pad">Looking for Enjoy projects…</p>
          ) : !projects.length ? (
            <p class="muted pad">No Enjoy projects found on this computer.</p>
          ) : (
            <>
              <p class="muted small pad">
                Conversations continue with the agent session they had in Enjoy. Savor keeps its records in each project's <code>.savor/</code> folder and excludes that folder from git on this computer. Import again later to pick up what happened in Enjoy since; conversations you continued in Savor stay untouched.
              </p>
              {projects.map((p) => (
                <label key={p.path} class={`import-row ${p.missing ? 'done' : ''}`}>
                  <input type="checkbox" disabled={p.missing || !!progress} checked={!p.missing && chosen.has(p.path)} onChange={() => toggle(p.path)} />
                  <span class="import-title">
                    {p.name} <small class="muted mono">{p.path}</small>
                  </span>
                  <span class="muted small">
                    {p.missing
                      ? 'The folder no longer exists'
                      : [plural(p.conversations, 'conversation'), p.documents && plural(p.documents, 'document'), p.workflows && plural(p.workflows, 'workflow'), p.added && `${p.added} already in Savor`].filter(Boolean).join(' · ')}
                  </span>
                </label>
              ))}
            </>
          )}
        </div>
        {!results && projects?.length ? (
          <footer class="dialog-foot">
            <span class="muted small">{progress ? `Importing ${progress.name} (${progress.at} of ${chosen.size})…` : `${chosen.size} selected`}</span>
            <button class="primary" disabled={!chosen.size || !!progress} onClick={run}>
              {progress ? 'Importing…' : `Import ${plural(chosen.size, 'project')}`}
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  )
}

// The same offer for the empty start screen.
export function EnjoyOffer() {
  const projects = useEnjoyProjects()
  const [open, setOpen] = useState(false)
  if (!projects.length) return null
  return (
    <>
      <button class="primary" onClick={() => setOpen(true)}>
        <Download size={15} /> Import {plural(projects.length, 'project')} from Enjoy
      </button>
      {open && <EnjoyImport onClose={() => (setOpen(false), go('/'))} />}
    </>
  )
}
