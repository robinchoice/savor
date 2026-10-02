import { useEffect, useState } from 'preact/hooks'
import { GitCommitHorizontal, X } from 'lucide-preact'
import { api, type Commit, type Project } from './api'

// What a commit changed: file list with +/− and the patch per file.
export function CommitDialog({ project, hash, threadId, onClose }: { project: Project; hash: string; threadId: string; onClose: () => void }) {
  const [commit, setCommit] = useState<Commit | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api<Commit>('GET', `/projects/${project.id}/git/commits/${hash}?thread=${threadId}`).then(setCommit, (e: Error) => setError(e.message))
  }, [hash])
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [])
  const added = commit?.files.reduce((n, f) => n + (f.additions ?? 0), 0) ?? 0
  const deleted = commit?.files.reduce((n, f) => n + (f.deletions ?? 0), 0) ?? 0

  return (
    <div class="overlay" onClick={onClose}>
      <div class="dialog commit-dialog" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          <GitCommitHorizontal size={18} />
          <div class="dialog-title">
            <b>{commit?.subject ?? hash.slice(0, 7)}</b>
            {commit && (
              <small class="muted">
                <code>{commit.hash.slice(0, 7)}</code> · {commit.author} · {new Date(commit.date).toLocaleString()} · {commit.files.length} file{commit.files.length === 1 ? '' : 's'}{' '}
                <span class="add">+{added}</span> <span class="del">−{deleted}</span>
              </small>
            )}
          </div>
          <button class="icon-btn" title="Close (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div class="dialog-body">
          {error && <div class="error-text pad">{error}</div>}
          {commit?.body && <p class="commit-body">{commit.body}</p>}
          {commit?.files.map((f) => (
            <details key={f.path} class="diff-file" open={commit.files.length <= 8}>
              <summary>
                <span class="mono">{f.path}</span>
                <span class="muted">
                  {f.additions === null ? 'binary' : <span class="add">+{f.additions}</span>} {f.deletions === null ? '' : <span class="del">−{f.deletions}</span>}
                </span>
              </summary>
              <pre class="diff">
                {f.patch.split('\n').map((line, i) => (
                  <span key={i} class={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>
                    {line}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </details>
          ))}
        </div>
      </div>
    </div>
  )
}
