import { Fragment } from 'preact'
import { useState } from 'preact/hooks'
import { GitBranch, MessageSquare, PanelLeftClose, PanelLeftOpen, RotateCw } from 'lucide-preact'
import { useApi, type Commit, type CommitFile, type Project, type Thread } from './api'

// A line of a diff, named by the side it is on: removed lines by their old number, all others by their new one.
interface Anchor { side: 'old' | 'new'; line: number }
// A comment on one line or a range of lines, kept with the conversation until it is sent.
export interface ReviewComment { id: string; source: string; path: string; from: Anchor; to: Anchor; lines: string; code: string; text: string }
// What is shown: everything the worktree changed since it branched off, uncommitted changes, or a commit hash.
export type Source = string

interface Row { kind: 'hunk' | 'add' | 'del' | 'ctx'; old?: number; new?: number; text: string }

function rows(patch: string): Row[] {
  const out: Row[] = []
  let old = 0
  let now = 0
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)
    if (hunk) {
      old = Number(hunk[1])
      now = Number(hunk[2])
      out.push({ kind: 'hunk', text: line })
    } else if (line[0] === '+') out.push({ kind: 'add', new: now++, text: line.slice(1) })
    else if (line[0] === '-') out.push({ kind: 'del', old: old++, text: line.slice(1) })
    else if (line[0] === ' ') out.push({ kind: 'ctx', old: old++, new: now++, text: line.slice(1) })
  }
  return out
}

const anchor = (r: Row): Anchor => (r.kind === 'del' ? { side: 'old', line: r.old! } : { side: 'new', line: r.new! })
const same = (a: Anchor, b: Anchor) => a.side === b.side && a.line === b.line
const span = (n: number[]) => (n.length > 1 ? `${n[0]}-${n[n.length - 1]}` : `${n[0]}`)

// Lines as the agent reads them: new line numbers where there are any, old ones for removed code only.
function linesOf(picked: Row[]) {
  const now = picked.flatMap((r) => r.new ?? [])
  return now.length ? span(now) : `${span(picked.map((r) => r.old!))} (removed)`
}

// The comments as one message, with the code each one is about.
export const reviewMessage = (comments: ReviewComment[]) =>
  comments.length
    ? `\n\nReview comments on the changes:\n` +
      comments.map((c) => `\n${c.path}:${c.lines}${/^[0-9a-f]+$/.test(c.source) ? ` (commit ${c.source.slice(0, 7)})` : ''}\n\`\`\`diff\n${c.code}\n\`\`\`\n${c.text}\n`).join('')
    : ''

interface Props {
  project: Project
  thread: Thread
  commits: string[]
  source: Source
  setSource: (s: Source) => void
  comments: ReviewComment[]
  saveComments: (c: ReviewComment[]) => void
  narrow: boolean
  chatHidden: boolean
  onToggleChat: () => void
}

// What the conversation changed, with comments on lines that go to the agent with the next message.
export function Changes({ project, thread, commits, source, setSource, comments, saveComments, narrow, chatHidden, onToggleChat }: Props) {
  const commit = /^[0-9a-f]+$/.test(source)
  const git = `/projects/${project.id}/git`
  const [changes, reload, error] = useApi<CommitFile[] | Commit>(
    commit ? `${git}/commits/${source}?thread=${thread.id}` : `${git}/changes?thread=${thread.id}${source === 'base' ? '&against=base' : ''}`,
    // A turn that ends may have changed files.
    (e) => !commit && e.threadId === thread.id && e.type === 'status',
  )
  const [projectGit] = useApi<{ branch: string | null }>(thread.worktree ? git : null, () => false)
  const files = changes && ('files' in changes ? changes.files : changes)
  const added = files?.reduce((n, f) => n + (f.additions ?? 0), 0) ?? 0
  const deleted = files?.reduce((n, f) => n + (f.deletions ?? 0), 0) ?? 0
  const options: [Source, string][] = [
    ...(thread.worktree ? [['base', `${thread.worktree.branch} vs ${projectGit?.branch ?? 'project'}`] as [Source, string]] : []),
    ['uncommitted', 'Uncommitted changes'],
    ...[...new Set([...(commit ? [source] : []), ...commits])].map((h): [Source, string] => [h, `Commit ${h.slice(0, 7)}`]),
  ]

  return (
    <div class="changes">
      <div class="changes-bar">
        {!narrow && (
          <button class="icon-btn" title={chatHidden ? 'Show chat' : 'Hide chat'} onClick={onToggleChat}>
            {chatHidden ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        )}
        <label class="source-select">
          <GitBranch size={14} />
          <select value={source} onChange={(e) => setSource(e.currentTarget.value)}>
            {options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {files && (
          <span class="muted small">
            {files.length} file{files.length === 1 ? '' : 's'} <span class="add">+{added}</span> <span class="del">−{deleted}</span>
          </span>
        )}
        {!commit && (
          <button class="icon-btn" title="Reload" onClick={reload}>
            <RotateCw size={15} />
          </button>
        )}
      </div>
      {changes && 'subject' in changes && (
        <div class="changes-commit">
          <b>{changes.subject}</b>
          <small class="muted">
            {changes.author} · {new Date(changes.date).toLocaleString()}
          </small>
        </div>
      )}
      {files && files.length > 1 && (
        <div class="changes-files">
          {files.map((f, i) => (
            <button key={f.path} title={f.path} onClick={() => document.getElementById(`diff-${i}`)?.scrollIntoView({ block: 'start' })}>
              {narrow ? f.path.split('/').pop() : f.path}
            </button>
          ))}
        </div>
      )}
      <div class={`changes-list ${chatHidden && !narrow ? 'floating' : ''}`}>
        {error && <div class="error-text pad">{error.message}</div>}
        {files?.length === 0 && <p class="muted center">No changes.</p>}
        {files?.map((f, i) => (
          <DiffFile key={`${source}:${f.path}`} id={`diff-${i}`} file={f} source={source} comments={comments} saveComments={saveComments} />
        ))}
      </div>
    </div>
  )
}

// A selection of rows, from the line clicked first to the one clicked last, and the comment it may already have.
interface Selection { from: number; to: number; editing?: string }

function DiffFile({ id, file, source, comments, saveComments }: { id: string; file: CommitFile; source: Source; comments: ReviewComment[]; saveComments: (c: ReviewComment[]) => void }) {
  const list = rows(file.patch)
  const mine = comments.filter((c) => c.source === source && c.path === file.path)
  const [sel, setSel] = useState<Selection | null>(null)
  const [draft, setDraft] = useState('')
  const at = (a: Anchor) => list.findIndex((r) => r.kind !== 'hunk' && same(anchor(r), a))
  // Comments whose lines are gone, e.g. after the agent changed the file again, show above the diff.
  const lost = mine.filter((c) => at(c.to) < 0)
  const commented = new Set(mine.flatMap((c) => {
    const [a, b] = [at(c.from), at(c.to)]
    return a < 0 || b < 0 ? [] : list.slice(Math.min(a, b), Math.max(a, b) + 1).map((_, k) => Math.min(a, b) + k)
  }))
  const [lo, hi] = sel ? [Math.min(sel.from, sel.to), Math.max(sel.from, sel.to)] : [-1, -1]

  // A click starts a selection; while one is open, further clicks move its end, so ranges work without a keyboard.
  const pick = (i: number) => {
    if (sel && !sel.editing) setSel({ from: sel.from, to: i })
    else {
      setSel({ from: i, to: i })
      setDraft('')
    }
  }
  const edit = (c: ReviewComment) => {
    setSel({ from: at(c.from), to: at(c.to), editing: c.id })
    setDraft(c.text)
  }
  const close = () => setSel(null)
  const save = () => {
    const text = draft.trim()
    if (!text || !sel) return
    if (sel.editing) saveComments(comments.map((c) => (c.id === sel.editing ? { ...c, text } : c)))
    else {
      const picked = list.slice(lo, hi + 1).filter((r) => r.kind !== 'hunk')
      const comment: ReviewComment = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        source,
        path: file.path,
        from: anchor(picked[0]),
        to: anchor(picked[picked.length - 1]),
        lines: linesOf(picked),
        code: picked.map((r) => (r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' ') + r.text).join('\n'),
        text,
      }
      saveComments([...comments, comment])
    }
    close()
  }
  const remove = (c: ReviewComment) => saveComments(comments.filter((x) => x.id !== c.id))

  const editor = (
    <div class="review-box">
      <div class="review-head">
        <MessageSquare size={12} /> {sel && !sel.editing && hi > lo ? `Lines ${linesOf(list.slice(lo, hi + 1).filter((r) => r.kind !== 'hunk'))}` : 'Comment'}
        {sel && !sel.editing && <span class="faint">· click another line to extend</span>}
      </div>
      <textarea
        autoFocus
        placeholder="What should the agent change here?"
        value={draft}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
        }}
      />
      <div class="review-actions">
        <button class="ghost small" onClick={close}>
          Cancel
        </button>
        <button class="primary small" disabled={!draft.trim()} onClick={save}>
          {sel?.editing ? 'Update' : 'Add comment'}
        </button>
      </div>
    </div>
  )
  const card = (c: ReviewComment, lostLines = false) => (
    <div key={c.id} class="review-box">
      <div class="review-head">
        <MessageSquare size={12} /> Line {c.lines}
        {lostLines && <span class="faint">· no longer in the diff</span>}
        <span class="spacer" />
        {!lostLines && <button onClick={() => edit(c)}>Edit</button>}
        <button onClick={() => remove(c)}>Delete</button>
      </div>
      {lostLines && <pre class="review-code">{c.code}</pre>}
      <div class="review-text">{c.text}</div>
    </div>
  )

  return (
    <section class="diff-file" id={id}>
      <header>
        <span class="mono">{file.path}</span>
        {mine.length > 0 && (
          <span class="review-count">
            <MessageSquare size={12} /> {mine.length}
          </span>
        )}
        <span class="muted small">{file.additions === null ? 'binary' : <><span class="add">+{file.additions}</span> <span class="del">−{file.deletions}</span></>}</span>
      </header>
      {lost.map((c) => card(c, true))}
      <div class="diff-rows">
        {list.map((r, i) => {
          if (r.kind === 'hunk') return <div key={i} class="diff-row hunk">{r.text}</div>
          const here = mine.filter((c) => at(c.to) === i)
          const editingHere = sel && (sel.editing ? here.some((c) => c.id === sel.editing) : i === hi)
          return (
            <Fragment key={i}>
              <div class={`diff-row ${r.kind} ${i >= lo && i <= hi ? 'selected' : ''} ${commented.has(i) ? 'commented' : ''}`}>
                <button class="gutter" title="Comment on this line" onClick={() => pick(i)}>
                  <span class="old">{r.old}</span>
                  <span class="new">{r.new}</span>
                </button>
                <span class="diff-text">{r.text}</span>
              </div>
              {here.map((c) => (sel?.editing === c.id ? null : card(c)))}
              {editingHere && editor}
            </Fragment>
          )
        })}
      </div>
    </section>
  )
}
