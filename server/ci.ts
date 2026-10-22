// GitHub Actions runs, read with the GitHub CLI: those of a commit for agents that wait for CI, and the
// running ones of all projects for the status bar.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BIN, command } from './config.js'
import { emit } from './events.js'
import * as store from './store.js'

export interface Run { databaseId: number; name: string; workflowName: string; status: string; conclusion: string; url: string }

export function runsOf(cwd: string, sha: string) {
  return gh<Run[]>(cwd, ['run', 'list', '--commit', sha, '--json', 'databaseId,name,workflowName,status,conclusion,url', '--limit', '50'])
}

export const finished = (runs: Run[]) => runs.length > 0 && runs.every((r) => r.status === 'completed')
export const failed = (runs: Run[]) => runs.filter((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion))

export function report(sha: string, runs: Run[]) {
  const bad = failed(runs)
  return [
    `CI for ${sha.slice(0, 7)}: ${bad.length ? `${bad.length} of ${runs.length} runs failed` : `all ${runs.length} runs passed`}.`,
    ...runs.map((r) => `- ${r.workflowName}${r.name && r.name !== r.workflowName ? ` · ${r.name}` : ''}: ${r.conclusion} ${r.url}`),
    ...(bad.length ? [`The log of a failed run: gh run view ${bad[0].databaseId} --log-failed`] : []),
  ].join('\n')
}

// ---- the running runs of all projects, for the status bar ----

// GitHub is asked only while a project has runs going or was pushed a moment ago. A push shows locally:
// git renames the new remote-tracking ref into .git/refs/remotes/origin, which changes the folder's mtime.
// A run that fails stays until it is dismissed; the others leave when they are done.
export interface LiveRun {
  id: number
  projectId: string
  project: string
  workflow: string
  number: number
  url: string
  status: string
  failed: boolean
  startedAt: string
  // Finished and all steps of its jobs, as far as GitHub lists them yet.
  done: number
  total: number
  // The median duration of the last successful runs of the same workflow.
  typicalMs: number | null
}

interface ListedRun { databaseId: number; number: number; workflowName: string; workflowDatabaseId: number; status: string; conclusion: string; url: string; createdAt: string; startedAt: string; updatedAt: string }
interface Job { status: string; steps?: { status: string }[] }

const TICK_MS = 5_000
const LIVE_POLL_MS = 15_000
// How long after a push or a watch_ci GitHub is asked for runs to show up.
const APPEAR_MS = 2 * 60_000
const RED = ['failure', 'timed_out', 'startup_failure']
const FIELDS = 'databaseId,number,workflowName,workflowDatabaseId,status,conclusion,url,createdAt,startedAt,updatedAt'

const live = new Map<number, LiveRun>()
const dismissed = new Set<number>()
// Per project: until when GitHub is asked, and since when its failed runs are shown, also those that
// failed before they were seen running.
const awake = new Map<string, { until: number; since: number }>()
const refStamps = new Map<string, number>()
let lastPoll = 0
let polling = false

function gh<T>(cwd: string, args: string[]) {
  return new Promise<T>((resolve, reject) => {
    execFile(...command(BIN.gh, args), { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`gh ${args[0]} ${args[1]} failed: ${(stderr || err.message).trim()}`))
      try {
        resolve(JSON.parse(stdout))
      } catch (e) {
        reject(e)
      }
    })
  })
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null
}

export const liveRuns = () => [...live.values()].sort((a, b) => a.project.localeCompare(b.project) || a.number - b.number)

export function dismiss(id: number) {
  dismissed.add(id)
  if (live.delete(id)) emit({ type: 'ci' })
}

// Ask GitHub about a project's runs for the next minutes, e.g. after a push.
export function wake(projectId: string) {
  const now = Date.now()
  const a = awake.get(projectId)
  awake.set(projectId, { until: now + APPEAR_MS, since: a && a.until > now ? a.since : now - 10_000 })
  lastPoll = 0
}

export function startCiMonitor() {
  setInterval(tick, TICK_MS).unref()
}

function tick() {
  for (const ref of store.state().projects) {
    let stamp = 0
    try {
      stamp = fs.statSync(path.join(ref.path, '.git', 'refs', 'remotes', 'origin')).mtimeMs
    } catch {}
    const before = refStamps.get(ref.id)
    refStamps.set(ref.id, stamp)
    if (before !== undefined && stamp !== before) wake(ref.id)
  }
  if (polling || Date.now() - lastPoll < LIVE_POLL_MS) return
  const due = [...awake].filter(([, a]) => a.until > Date.now()).map(([id]) => id)
  if (!due.length) return
  polling = true
  lastPoll = Date.now()
  Promise.all(due.map(poll)).finally(() => {
    polling = false
    emit({ type: 'ci' })
  })
}

async function poll(projectId: string) {
  const p = store.listProjects().find((p) => p.id === projectId)
  const a = awake.get(projectId)!
  let runs: ListedRun[]
  try {
    if (!p) throw new Error('gone')
    runs = await gh<ListedRun[]>(p.path, ['run', 'list', '--limit', '30', '--json', FIELDS])
  } catch {
    // No GitHub remote, no login or no network: quiet until the next push.
    awake.delete(projectId)
    return
  }
  // Runs seen going before: they stay when they failed, also when they started before the push.
  const seen = [...live.values()].filter((r) => r.projectId === projectId && !r.failed).map((r) => r.id)
  const next: LiveRun[] = []
  for (const r of runs) {
    const red = r.status === 'completed' && RED.includes(r.conclusion)
    if (dismissed.has(r.databaseId) || (r.status === 'completed' && !(red && (seen.includes(r.databaseId) || Date.parse(r.createdAt) >= a.since)))) continue
    const jobs = red ? [] : await gh<{ jobs?: Job[] }>(p!.path, ['run', 'view', String(r.databaseId), '--json', 'jobs']).then((v) => v.jobs ?? [], () => [])
    const typical = runs
      .filter((x) => x.workflowDatabaseId === r.workflowDatabaseId && x.conclusion === 'success')
      .slice(0, 10)
      .map((x) => Date.parse(x.updatedAt) - Date.parse(x.startedAt))
    next.push({
      id: r.databaseId,
      projectId,
      project: p!.name,
      workflow: r.workflowName,
      number: r.number,
      url: r.url,
      status: r.status,
      failed: red,
      startedAt: r.startedAt || r.createdAt,
      done: jobs.reduce((n, j) => n + (j.steps?.length ? j.steps.filter((s) => s.status === 'completed').length : +(j.status === 'completed')), 0),
      total: jobs.reduce((n, j) => n + (j.steps?.length || 1), 0),
      typicalMs: median(typical),
    })
  }
  for (const id of seen) live.delete(id)
  for (const r of next) live.set(r.id, r)
  if (next.some((r) => !r.failed)) a.until = Math.max(a.until, Date.now() + LIVE_POLL_MS * 2)
}
