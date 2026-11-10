import { useEffect, useState } from 'preact/hooks'
import { ExternalLink, FolderGit2, GitBranch } from 'lucide-preact'
import { api, go, type Project } from './api'
import { t } from './i18n'

// Signing Claude Code, Codex and gh in from Savor (server/signin.ts): the link opens on this device, the
// code goes back to the computer, which also waits for the sign-in where the tool does.
type Tool = 'claude' | 'codex' | 'gh'
interface SignIn { state: 'idle' | 'waiting' | 'done' | 'failed'; url?: string; code?: string; paste?: boolean; error?: string }

const LABELS: Record<Tool, string> = { claude: 'Sign in with Claude', codex: 'Sign in with ChatGPT', gh: 'Connect GitHub' }
const SITES: Record<Tool, string> = { claude: "Claude's", codex: "OpenAI's", gh: "GitHub's" }
export const canSignIn = (id: string): id is Tool => id === 'claude' || id === 'codex'

export function SignInFlow({ tool, onDone }: { tool: Tool; onDone: () => void }) {
  const [s, setS] = useState<SignIn>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const run = async (call: () => Promise<SignIn>) => {
    setBusy(true)
    try {
      const next = await call()
      setS(next)
      if (next.state === 'done') onDone()
    } catch (err) {
      setS({ state: 'failed', error: (err as Error).message })
    }
    setBusy(false)
  }
  // Codex and gh wait for the sign-in on their own; Savor asks how it went.
  useEffect(() => {
    if (s.state !== 'waiting' || s.paste) return
    const id = setInterval(() => void api<SignIn>('GET', `/signin/${tool}`).then((next) => (setS(next), next.state === 'done' && onDone()), () => {}), 2000)
    return () => clearInterval(id)
  }, [s.state, s.paste])
  // A login still waiting on the computer ends with the dialog.
  useEffect(() => () => void api('DELETE', `/signin/${tool}`).catch(() => {}), [])
  const cancel = () => run(() => api<SignIn>('DELETE', `/signin/${tool}`))

  if (s.state !== 'waiting')
    return (
      <div class="signin">
        <button class="primary" disabled={busy} onClick={() => run(() => api<SignIn>('POST', `/signin/${tool}`))}>
          {busy ? t('Starting…') : t(LABELS[tool])}
        </button>
        {s.state === 'failed' && <small class="error-text">{s.error}</small>}
      </div>
    )
  if (s.paste)
    return (
      <form class="signin" onSubmit={(e) => (e.preventDefault(), run(() => api<SignIn>('POST', `/signin/${tool}/code`, { code })))}>
        <a class="button primary" href={s.url} target="_blank" rel="noreferrer">
          <ExternalLink size={14} /> {t("Open {site} sign-in page", { site: t(SITES[tool]) })}
        </a>
        <small class="muted">{t('Sign in there. At the end the page shows a code: paste it here.')}</small>
        <div class="row">
          <input class="grow" placeholder={t('Paste the code')} value={code} onInput={(e) => setCode(e.currentTarget.value)} autoComplete="off" />
          <button class="primary" disabled={busy || !code.trim()}>
            {busy ? t('Checking…') : t('Done')}
          </button>
        </div>
        <button type="button" class="link small" onClick={cancel}>
          {t('Cancel')}
        </button>
      </form>
    )
  const open = () => void navigator.clipboard?.writeText(s.code ?? '').catch(() => {})
  return (
    <div class="signin">
      <small class="muted">{t("Enter this code on {site} page. Savor notices on its own when you are signed in.", { site: t(SITES[tool]) })}</small>
      <div class="signin-code">{s.code}</div>
      <a class="button primary" href={s.url} target="_blank" rel="noreferrer" onClick={open}>
        <ExternalLink size={14} /> {t('Copy code and open the page')}
      </a>
      <small class="muted">
        <span class="spinner small" /> {t('Waiting for the sign-in…')}{' '}
        <button type="button" class="link small" onClick={cancel}>
          {t('Cancel')}
        </button>
      </small>
    </div>
  )
}

interface GitHub { installed: boolean; account: string | null }
export function useGitHub(enabled = true) {
  const [gh, setGh] = useState<GitHub>()
  const load = () => void (enabled && api<GitHub>('GET', '/github').then(setGh, () => setGh({ installed: false, account: null })))
  useEffect(load, [enabled])
  return [gh, load] as const
}

// The GitHub CLI as a row like an agent's: agents use it to clone and push, and Savor to get a repo.
export function GitHubRow({ gh, onDone }: { gh?: GitHub; onDone: () => void }) {
  if (!gh?.installed) return null
  return (
    <div class="signin-row">
      <div class="setting agent-status">
        <GitBranch size={16} />
        <span>
          <b>GitHub</b>
          <small class="muted">{gh.account ? `@${gh.account}` : t('So agents can clone and push your repositories')}</small>
        </span>
        <span class={gh.account ? 'ok' : 'muted'}>{gh.account ? t('Signed in') : t('Optional')}</span>
      </div>
      {!gh.account && <SignInFlow tool="gh" onDone={onDone} />}
    </div>
  )
}

interface Repo { name: string; description: string; private: boolean; updated: string }
// Picks a repository of the GitHub account and clones it into the projects folder as a project.
export function CloneRepo({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) {
  const [gh, reload] = useGitHub()
  const [list, setList] = useState<Repo[]>()
  const [filter, setFilter] = useState('')
  const [cloning, setCloning] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (gh?.account) api<Repo[]>('GET', '/github/repos').then(setList, (err) => setError((err as Error).message))
  }, [gh?.account])
  const clone = async (repo: string) => {
    setCloning(repo)
    setError('')
    try {
      const p = await api<Project>('POST', '/projects/clone', { repo })
      onAdded()
      go(`/p/${p.id}`)
    } catch (err) {
      setError((err as Error).message)
    }
    setCloning('')
  }
  const shown = (list ?? []).filter((r) => r.name.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 30)
  return (
    <div class="clone-repo">
      {!gh ? (
        <small class="muted">{t('Looking…')}</small>
      ) : !gh.installed ? (
        <small class="muted">{t('The GitHub CLI (gh) is not installed on this computer.')}</small>
      ) : !gh.account ? (
        <>
          <small class="muted">{t('Connect GitHub first. Savor then lists your repositories.')}</small>
          <SignInFlow tool="gh" onDone={reload} />
        </>
      ) : (
        <>
          <input autoFocus placeholder={t('Search your repositories')} value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
          <div class="repo-list">
            {!list && !error && <small class="muted">{t('Looking…')}</small>}
            {list && !shown.length && <small class="muted">{t('No repository matches.')}</small>}
            {shown.map((r) => (
              <button key={r.name} class="repo" disabled={!!cloning} onClick={() => clone(r.name)}>
                <FolderGit2 size={14} />
                <span>
                  <b>{r.name}</b>
                  {r.description && <small class="muted">{r.description}</small>}
                </span>
                {cloning === r.name ? <small class="muted">{t('Cloning…')}</small> : r.private && <small class="muted">{t('Private')}</small>}
              </button>
            ))}
          </div>
        </>
      )}
      {error && <div class="error-text">{error}</div>}
      <div class="row">
        <span class="spacer" />
        <button type="button" class="ghost" onClick={onCancel}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  )
}
