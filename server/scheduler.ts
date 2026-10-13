import { Cron } from 'croner'
import * as store from './store.js'
import type { Origin, Project, Provider, Thread, Workflow } from './store.js'
import { emit } from './events.js'
import * as agents from './agents.js'
import { BUDGET_REACHED } from './session.js'

let jobs: Cron[] = []
// A run that starts this long after its scheduled time was caught up.
const LATE = 60_000
// A run started early takes the place of the next scheduled time when that comes within this time.
const EARLY = 12 * 3600_000

export function validateCron(expr: string, timezone?: string) {
  new Cron(expr, { timezone, paused: true }).stop()
}

export function syncSchedules() {
  jobs.forEach((j) => j.stop())
  jobs = []
  for (const p of store.listProjects()) {
    for (const wf of store.listWorkflows(p)) {
      if (!wf.enabled || !wf.cron) continue
      try {
        jobs.push(new Cron(wf.cron, { timezone: wf.timezone, catch: (e) => console.error(e) }, () => onSchedule(p.id, wf.id)))
        // A scheduled time passed while Savor was not running. A workflow from before Savor kept track of that has none to catch up.
        if (wf.settledAt && dueSlot(wf)) onSchedule(p.id, wf.id)
      } catch (e) {
        console.error(`workflow ${wf.id}: ${(e as Error).message}`)
      }
    }
  }
}

// The next scheduled time that is not settled yet: a run started early settles the one it took the place of.
export const nextRun = (wf: Workflow) => {
  if (!wf.enabled || !wf.cron) return null
  try {
    const from = Date.parse(wf.settledAt) > Date.now() ? new Date(wf.settledAt) : undefined
    return new Cron(wf.cron, { timezone: wf.timezone, paused: true }).nextRun(from)?.toISOString() ?? null
  } catch {
    return null
  }
}

// The scheduled time that is due: the latest one that has come, unless it is settled.
// croner leaves a time out of previousRuns until a full second after it, also when its job fires right on time.
function dueSlot(wf: Workflow) {
  const [slot] = new Cron(wf.cron!, { timezone: wf.timezone, paused: true }).previousRuns(1, new Date(Date.now() + 1000))
  return slot && slot.toISOString() > wf.settledAt ? slot : null
}

// Still at it: in a turn, or waiting for background work it started.
const working = (p: Project, t: Thread) => agents.isBusy(t.id) || agents.waiting(p, t)

// A run of the workflow that still works or waits for the user.
const openRun = (p: Project, wf: Workflow) => store.listThreads(p).find((t) => t.workflow?.id === wf.id && !t.completed && (working(p, t) || t.needsYou))

// A scheduled time has come, now or while Savor was not running. It runs unless the project is paused, the
// workflow does not catch up what it missed, or a run of it is still open: then the time is skipped.
function onSchedule(projectId: string, workflowId: string) {
  const p = store.getProject(projectId)
  const wf = store.getWorkflow(p, workflowId)
  const slot = dueSlot(wf)
  if (!slot) return
  const late = Date.now() - slot.getTime() > LATE
  const runs = !p.paused && (!late || wf.catchUp)
  const open = runs && openRun(p, wf)
  store.saveWorkflow(p, { ...wf, settledAt: store.now(), ...(open && { skipped: [...wf.skipped, { at: slot.toISOString(), blockedBy: open.id }].slice(-50) }) })
  if (open) emit({ type: 'workflows', projectId })
  else if (runs) runWorkflow(projectId, workflowId, 'local', late ? { trigger: 'caught', due: slot.toISOString() } : { trigger: 'scheduled' })
}

// The project's default agent ran on `model`. Workflows with the model-change trigger run when it is new to
// them, and then wait for the next one. One that is off or blocked by an open run only notes the model.
export function modelSeen(projectId: string, model: string) {
  const p = store.getProject(projectId)
  if (p.model === model) return
  store.updateProject(p.id, { model })
  for (const wf of store.listWorkflows(p)) {
    if (!wf.onModelChange || wf.model === model) continue
    store.saveWorkflow(p, { ...wf, model })
    if (wf.model && wf.enabled && !p.paused && !openRun(p, wf)) runWorkflow(p.id, wf.id, 'local', { trigger: 'model', model })
  }
  emit({ type: 'workflows', projectId })
}

// The workflow and every workflow its `next` links lead to, each once.
function reachable(p: Project, wf: Workflow) {
  const all = new Map([[wf.id, wf]])
  for (const w of all.values()) {
    for (const id of w.next) {
      if (all.has(id)) continue
      try {
        all.set(id, store.getWorkflow(p, id))
      } catch {}
    }
  }
  return [...all.values()]
}

type Start = Pick<NonNullable<Thread['workflow']>, 'trigger' | 'due' | 'model'>

export function runWorkflow(projectId: string, workflowId: string, by: Origin, start: Start = { trigger: 'manual' }, chained = false) {
  const p = store.getProject(projectId)
  const wf = store.getWorkflow(p, workflowId)
  // Instructions a paired device wrote run as remote, even when the schedule or a local workflow starts them.
  const origin = by === 'remote' || reachable(p, wf).some((w) => w.origin === 'remote') ? 'remote' : 'local'
  const linked = wf.next.flatMap((id) => {
    try {
      return [store.getWorkflow(p, id)]
    } catch {
      return []
    }
  })
  const chain = linked.length ? `\n\nWhen this is done, continue with the linked workflows in order: ${linked.map((l) => `“${l.name}” (id ${l.id})`).join(', ')}.` : ''
  const changed = start.model ? `The project's agent runs on a new model now: ${start.model}.\n\n` : ''
  const prompt = `${changed}Run workflow “${wf.name}”:\n\n${wf.prompt}${chain}`
  const thread = store.createThread(p, { title: wf.name, label: wf.name, workflow: { id: wf.id, name: wf.name, ...start, ...(wf.budgetUsd && { budgetUsd: wf.budgetUsd }) } })
  store.saveWorkflow(p, { ...wf, lastRunAt: store.now() })
  emit({ type: 'thread', projectId: p.id, threadId: thread.id })
  emit({ type: 'workflows', projectId: p.id })
  agents.send(p, thread.id, { text: prompt, origin, chained })
  return thread
}

// Runs the workflow now instead of at its next scheduled time, when that comes soon. Without one it is a manual run.
export function runEarly(projectId: string, workflowId: string, by: Origin) {
  const p = store.getProject(projectId)
  const next = nextRun(store.getWorkflow(p, workflowId))
  if (!next || Date.parse(next) - Date.now() > EARLY) return runWorkflow(projectId, workflowId, by)
  const thread = runWorkflow(projectId, workflowId, by, { trigger: 'early', due: next })
  store.saveWorkflow(p, { ...store.getWorkflow(p, workflowId), settledAt: next })
  emit({ type: 'workflows', projectId })
  return thread
}

export interface Run {
  at: string
  trigger: 'scheduled' | 'manual' | 'caught' | 'early' | 'model'
  due?: string
  model?: string
  status: 'working' | 'needs' | 'stopped' | 'budget' | 'failed' | 'finished' | 'skipped'
  // The run's conversation; for a skipped time, the conversation that was in its way.
  threadId: string
  summary: string
  workedMs: number
  // What the run used, as far as its agent reports it.
  usd?: number
  tokens?: number
}

// What a conversation's agents used, summed over the ones that report it.
function used(t: Thread) {
  const usd = t.spent?.filter((s) => s.usd != null)
  const tokens = t.spent?.filter((s) => s.tokens != null)
  return { ...(usd?.length && { usd: usd.reduce((n, s) => n + s.usd!, 0) }), ...(tokens?.length && { tokens: tokens.reduce((n, s) => n + s.tokens!, 0) }) }
}

// What the workflow's runs that started this month used together.
export function month(p: Project, wf: Workflow, threads = store.listThreads(p)) {
  const start = new Date()
  start.setDate(1)
  start.setHours(0, 0, 0, 0)
  const runs = threads.filter((t) => t.workflow?.id === wf.id && Date.parse(t.createdAt) >= start.getTime()).map(used)
  return { usd: runs.reduce((n, r) => n + (r.usd ?? 0), 0), tokens: runs.reduce((n, r) => n + (r.tokens ?? 0), 0) }
}

// An agent session reported what it used so far. A workflow run counts toward the month: when the runs
// pass 80 % of the workflow's monthly budget Savor warns, at 100 % it pauses the workflow until it is
// enabled again.
// It gets the project itself: a session can still report after its project was removed from Savor.
export function spent(p: Project, tid: string, provider: Provider, usage: { usd?: number; tokens?: number }) {
  const t = store.getThread(p, tid)
  const was = t.spent?.find((s) => s.provider === provider)?.usd ?? 0
  // Saved as it is: this is no change to the conversation, so its place in the list stays.
  store.saveThread(p, { ...t, spent: [...(t.spent ?? []).filter((s) => s.provider !== provider), { provider, ...usage }] })
  if (!t.workflow) return
  emit({ type: 'workflows', projectId: p.id })
  let wf: Workflow
  try {
    wf = store.getWorkflow(p, t.workflow.id)
  } catch {
    return
  }
  const limit = wf.monthlyBudgetUsd
  if (!limit) return
  const after = month(p, wf).usd
  const before = after - ((usage.usd ?? 0) - was)
  const crossed = (share: number) => before < share * limit && after >= share * limit
  const total = `$${after.toFixed(2)} of $${limit}`
  if (crossed(1)) {
    if (wf.enabled) store.saveWorkflow(p, { ...wf, enabled: false })
    syncSchedules()
    warn(p, tid, `“${wf.name}” used its monthly budget (${total}) and is paused. Enable it again on its page to let it run this month.`, 'Monthly budget used')
  } else if (crossed(0.8)) warn(p, tid, `“${wf.name}” used 80 % of its monthly budget (${total}).`, 'Monthly budget at 80 %')
}

function warn(p: Project, tid: string, text: string, status: string) {
  agents.post(p, tid, { kind: 'update', text })
  agents.notify(p, tid, 'run', text, status)
  emit({ type: 'workflows', projectId: p.id })
}

// The first words of a message, without its markdown.
const plain = (text: string) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*[-+] /gm, '').replace(/[*`#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 240)

// What a workflow did, newest first: the conversations it started and the scheduled times it skipped.
export function runs(p: Project, wf: Workflow, threads = store.listThreads(p), limit = 50): Run[] {
  const entries: { at: string; thread?: Thread; blockedBy?: string }[] = [
    ...threads.filter((t) => t.workflow?.id === wf.id).map((thread) => ({ at: thread.createdAt, thread })),
    ...wf.skipped.map((s) => ({ at: s.at, blockedBy: s.blockedBy })),
  ]
  return entries
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map(({ at, thread: t, blockedBy }): Run => {
      if (!t) return { at, trigger: 'scheduled', status: 'skipped', threadId: blockedBy!, summary: '', workedMs: 0 }
      const messages = store.readMessages(p, t.id)
      const last = messages.filter((m) => m.kind === 'conclusion' || m.kind === 'error').at(-1)
      return {
        at,
        trigger: t.workflow!.trigger,
        due: t.workflow!.due,
        model: t.workflow!.model,
        status: working(p, t) ? 'working' : t.needsYou ? 'needs' : t.error === 'Turn stopped.' ? 'stopped' : t.error?.startsWith(BUDGET_REACHED) ? 'budget' : t.error || last?.kind === 'error' ? 'failed' : 'finished',
        threadId: t.id,
        summary: plain(t.error ?? last?.text ?? ''),
        workedMs: messages.reduce((ms, m) => ms + (m.workTiming ? Date.parse(m.workTiming.finishedAt) - Date.parse(m.workTiming.startedAt) : 0), 0),
        ...used(t),
      }
    })
}
