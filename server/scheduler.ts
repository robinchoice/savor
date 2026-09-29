import { Cron } from 'croner'
import * as store from './store.js'
import type { Origin } from './store.js'
import { emit } from './events.js'
import * as agents from './agents.js'

let jobs: Cron[] = []

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
        jobs.push(
          new Cron(wf.cron, { timezone: wf.timezone, catch: (e) => console.error(e) }, () => {
            // Paused projects keep their schedules but skip runs.
            if (!store.getProject(p.id).paused) runWorkflow(p.id, wf.id, 'local')
          }),
        )
      } catch (e) {
        console.error(`workflow ${wf.id}: ${(e as Error).message}`)
      }
    }
  }
}

export const nextRun = (wf: store.Workflow) => {
  if (!wf.enabled || !wf.cron) return null
  try {
    return new Cron(wf.cron, { timezone: wf.timezone, paused: true }).nextRun()?.toISOString() ?? null
  } catch {
    return null
  }
}

export function runWorkflow(projectId: string, workflowId: string, origin: Origin) {
  const p = store.getProject(projectId)
  const wf = store.getWorkflow(p, workflowId)
  const linked = wf.next.flatMap((id) => {
    try {
      return [store.getWorkflow(p, id)]
    } catch {
      return []
    }
  })
  const chain = linked.length ? `\n\nWhen this is done, continue with the linked workflows in order: ${linked.map((l) => `“${l.name}” (id ${l.id})`).join(', ')}.` : ''
  const prompt = `Run workflow “${wf.name}”:\n\n${wf.prompt}${chain}`
  const thread = store.createThread(p, { title: wf.name, label: wf.name })
  store.saveWorkflow(p, { ...wf, lastRunAt: store.now() })
  emit({ type: 'thread', projectId: p.id, threadId: thread.id })
  emit({ type: 'workflows', projectId: p.id })
  agents.send(p, thread.id, { text: prompt, origin })
  return thread
}
