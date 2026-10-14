import { useEffect, useState } from 'preact/hooks'
import { ArrowLeft, GitBranch, GitMerge, MessageSquare, Split, Trophy, X } from 'lucide-preact'
import { agentSummary, api, duration, go, PROVIDER_NAMES, useAgents, useApi, type FanoutRun, type Project, type ProviderInfo } from './api'
import { Markdown, ProviderIcon } from './Conversations'
import { transport } from './transport'
import { plural, t } from './i18n'

const totals = (r: FanoutRun) => ({ added: r.changes.reduce((n, c) => n + (c.additions ?? 0), 0), deleted: r.changes.reduce((n, c) => n + (c.deletions ?? 0), 0) })

// The conversations of a fan-out side by side: answer, changed files and preview. Picking one merges
// its worktree into the project and can delete the others.
export function Fanout({ project, id }: { project: Project; id: string }) {
  const [runs, , error] = useApi<FanoutRun[]>(`/projects/${project.id}/fanout/${id}`, (e) => e.projectId === project.id && ['thread', 'status', 'message', 'browser'].includes(e.type))
  const agents = useAgents()
  const [pick, setPick] = useState<FanoutRun | null>(null)
  if (!runs)
    return (
      <section class="thread">
        <div class="empty-state" role="status">
          <p>{error ? t('Could not load this comparison: {error}', { error: error.message }) : t('Loading comparison…')}</p>
        </div>
      </section>
    )
  const finished = runs.filter((r) => !r.thread.busy && !r.thread.waiting).length
  const winner = runs.find((r) => r.merged)
  return (
    <section class="thread fanout">
      <header class="thread-head">
        <a class="square back" href={`#/p/${project.id}`} title={t('All conversations')}>
          <ArrowLeft size={17} />
        </a>
        <div class="thread-head-text">
          <h1>{runs[0].thread.title}</h1>
          <div class="thread-sub">
            <span class="status">
              <Split size={12} /> {plural(runs.length, '{n} agent', '{n} agents')}
            </span>
            <span class="status">{finished === runs.length ? t('All finished') : t('{done} of {n} finished', { done: finished, n: runs.length })}</span>
            {winner && (
              <span class="status done">
                <GitMerge size={12} /> {t('{branch} merged', { branch: winner.worktree!.branch })}
              </span>
            )}
          </div>
        </div>
      </header>
      <div class="fan-cols">
        {runs.map((r) => (
          <Column key={r.thread.id} project={project} run={r} info={agents?.find((a) => a.id === r.thread.agent.provider)} onPick={winner ? undefined : () => setPick(r)} />
        ))}
      </div>
      {pick && <PickDialog project={project} run={pick} others={runs.filter((r) => r !== pick)} onClose={() => setPick(null)} />}
    </section>
  )
}

function Column({ project, run, info, onPick }: { project: Project; run: FanoutRun; info?: ProviderInfo; onPick?: () => void }) {
  const th = run.thread
  const wt = run.worktree
  const working = !!(th.busy || th.waiting)
  const { added, deleted } = totals(run)
  const [label, cls] = run.merged
    ? [t('Merged'), 'done']
    : !wt
      ? [t('Deleted'), 'done']
      : working
        ? [t('Working'), 'working']
        : th.needsYou
          ? [t('Your turn'), 'needs']
          : th.error
            ? [t('Error'), 'error']
            : wt.dirty
              ? [t('Uncommitted changes'), 'needs']
              : [t('Ready'), '']
  const openPreview = () => {
    localStorage.setItem(`savor-view:${th.id}`, 'browser')
    go(`/p/${project.id}/t/${th.id}`)
  }
  return (
    <article class={`fan-col ${run.merged ? 'won' : ''} ${wt ? '' : 'gone'}`}>
      <header class="fan-col-head">
        <div class="fan-who">
          <ProviderIcon provider={th.agent.provider} size={16} />
          <b>{PROVIDER_NAMES[th.agent.provider] ?? th.agent.provider}</b>
          <span class={`status ${cls}`}>
            {working && <span class="spinner small" />} {label}
          </span>
        </div>
        <small class="muted">
          {agentSummary(th.agent, info)}
          {run.workTiming && ` · ${duration(Date.parse(run.workTiming.finishedAt) - Date.parse(run.workTiming.startedAt))}`}
        </small>
        {wt && (
          <small class="muted mono">
            <GitBranch size={12} /> {wt.branch}
          </small>
        )}
      </header>
      <section>
        <div class="fan-k">{t('Answer')}</div>
        {run.answer ? <Markdown text={run.answer} /> : <p class="muted small">{working ? t('Working…') : t('No answer yet.')}</p>}
      </section>
      <section>
        <div class="fan-k">
          {plural(run.changes.length, '{n} file', '{n} files')} · <span class="add">+{added}</span> <span class="del">−{deleted}</span>
          {wt && !run.merged && ` · ${plural(wt.ahead, '{n} commit', '{n} commits')}`}
        </div>
        {run.changes.map((c) => (
          <div class="fan-file" key={c.path}>
            <span class="mono">{c.path}</span>
            {c.additions === null ? (
              <span class="muted">{t('binary')}</span>
            ) : (
              <span>
                <span class="add">+{c.additions}</span> <span class="del">−{c.deletions}</span>
              </span>
            )}
          </div>
        ))}
      </section>
      <section>
        <div class="fan-k">{t('Preview')}</div>
        {th.preview ? <Frame path={`/api/projects/${project.id}/threads/${th.id}/browser/frame?at=${encodeURIComponent(th.updatedAt)}`} url={th.preview} onOpen={openPreview} /> : <p class="muted small">{t('No preview: the agent didn’t open one.')}</p>}
      </section>
      <footer>
        <a class="ghost" href={`#/p/${project.id}/t/${th.id}`}>
          <MessageSquare size={14} /> {t('Open')}
        </a>
        {onPick && wt && (
          <button class="primary" disabled={working || !wt.ahead} title={working ? t('Wait until the agent is done') : !wt.ahead ? t('Nothing committed yet: ask the agent to commit its work') : t('Merge this one into the project')} onClick={onPick}>
            <Trophy size={14} /> {t('Pick')}
          </button>
        )}
      </footer>
    </article>
  )
}

function Frame({ path, url, onOpen }: { path: string; url: string; onOpen: () => void }) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = ''
    transport.imageUrl(path).then((u) => setSrc((current = u)), () => setFailed(true))
    return () => current.startsWith('blob:') && URL.revokeObjectURL(current)
  }, [path])
  return (
    <button class="fan-frame" title={t('Open the preview')} onClick={onOpen}>
      {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : <span class="muted small">{failed ? t('Preview not available') : t('Loading preview…')}</span>}
      <span class="fan-url">{url}</span>
    </button>
  )
}

function PickDialog({ project, run, others, onClose }: { project: Project; run: FanoutRun; others: FanoutRun[]; onClose: () => void }) {
  const wt = run.worktree!
  const rest = others.filter((r) => r.worktree)
  const running = rest.filter((r) => r.thread.busy || r.thread.waiting).length
  const [removeOthers, setRemoveOthers] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { added, deleted } = totals(run)
  const merge = async () => {
    setBusy(true)
    try {
      await api('POST', `/projects/${project.id}/worktrees/merge`, { path: wt.path })
      if (removeOthers) for (const r of rest) await api('DELETE', `/projects/${project.id}/worktrees?path=${encodeURIComponent(r.worktree!.path)}`)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <div class="overlay" onClick={onClose}>
      <div class="dialog pick-dialog" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          <GitMerge size={18} />
          <div class="dialog-title">
            <b>{t('Merge {branch} into the project?', { branch: wt.branch })}</b>
            <small class="muted">
              {plural(wt.ahead, '{n} commit', '{n} commits')} · {plural(run.changes.length, '{n} file', '{n} files')} <span class="add">+{added}</span> <span class="del">−{deleted}</span>
            </small>
          </div>
          <button class="icon-btn" title={t('Close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div class="dialog-body">
          {wt.dirty && <p class="attn-text">{t('This worktree also has uncommitted changes. Only commits are merged, so ask the agent to commit them first or they stay behind.')}</p>}
          {rest.length > 0 && (
            <label class="pick-others">
              <input type="checkbox" checked={removeOthers} onChange={(e) => setRemoveOthers(e.currentTarget.checked)} />
              <span>
                {rest.length === 1 ? t('Delete the other worktree and its branch') : t('Delete the other {n} worktrees and their branches', { n: rest.length })}
                <small class="mono muted">{rest.map((r) => r.worktree!.branch).join(', ')}</small>
                <small class="muted">
                  {running > 0 && `${plural(running, '{n} agent still working will be stopped.', '{n} agents still working will be stopped.')} `}{rest.length === 1 ? t('Its conversation stays and is marked finished.') : t('Their conversations stay and are marked finished.')}
                </small>
              </span>
            </label>
          )}
          {error && <div class="error-text">{error}</div>}
          <div class="pick-actions">
            <button class="ghost" onClick={onClose}>
              {t('Cancel')}
            </button>
            <button class="primary" disabled={busy} onClick={merge}>
              <GitMerge size={14} /> {busy ? t('Merging…') : removeOthers && rest.length ? t('Merge and delete') : t('Merge')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
