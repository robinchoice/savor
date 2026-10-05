import { Cron } from 'croner'
import * as store from './store.js'
import type { Origin, Project, Thread, Workflow } from './store.js'
import { emit } from './events.js'
import * as agents from './agents.js'

let jobs: Cron[] = []
// A run that starts this long after its scheduled time was caught up.
const LATE = 60_000

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

export const nextRun = (wf: Workflow) => {
  if (!wf.enabled || !wf.cron) return null
  try {
    return new Cron(wf.cron, { timezone: wf.timezone, paused: true }).nextRun()?.toISOString() ?? null
  } catch {
    return null
  }
}

// The scheduled time that is due: the latest one that has come, unless it is settled.
function dueSlot(wf: Workflow) {
  const [slot] = new Cron(wf.cron!, { timezone: wf.timezone, paused: true }).previousRuns(1, new Date(Date.now() + 1))
  return slot && slot.toISOString() > wf.settledAt ? slot : null
}

// Still at it: in a turn, or waiting for background work it started.
const working = (p: Project, t: Thread) => agents.isBusy(t.id) || (!t.error && agents.awaitsBackground(p, t.id))

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

type Start = Pick<NonNullable<Thread['workflow']>, 'trigger' | 'due'>

export function runWorkflow(projectId: string, workflowId: string, by: Origin, start: Start = { trigger: 'manual' }) {
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
  const prompt = `Run workflow “${wf.name}”:\n\n${wf.prompt}${chain}`
  const thread = store.createThread(p, { title: wf.name, label: wf.name, workflow: { id: wf.id, name: wf.name, ...start } })
  store.saveWorkflow(p, { ...wf, lastRunAt: store.now() })
  emit({ type: 'thread', projectId: p.id, threadId: thread.id })
  emit({ type: 'workflows', projectId: p.id })
  agents.send(p, thread.id, { text: prompt, origin })
  return thread
}

export interface Run {
  at: string
  trigger: 'scheduled' | 'manual' | 'caught'
  due?: string
  status: 'working' | 'needs' | 'failed' | 'finished' | 'skipped'
  // The run's conversation; for a skipped time, the conversation that was in its way.
  threadId: string
  summary: string
  workedMs: number
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
        status: working(p, t) ? 'working' : t.needsYou ? 'needs' : t.error || last?.kind === 'error' ? 'failed' : 'finished',
        threadId: t.id,
        summary: plain(t.error ?? last?.text ?? ''),
        workedMs: messages.reduce((ms, m) => ms + (m.workTiming ? Date.parse(m.workTiming.finishedAt) - Date.parse(m.workTiming.startedAt) : 0), 0),
      }
    })
}
