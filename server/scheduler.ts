import { Cron } from 'croner'
import * as store from './store.js'
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
        jobs.push(new Cron(wf.cron, { timezone: wf.timezone, catch: (e) => console.error(e) }, () => void runWorkflow(p.id, wf.id)))
      } catch (e) {
        console.error(`workflow ${wf.id}: ${(e as Error).message}`)
      }
    }
  }
}

export function runWorkflow(projectId: string, workflowId: string) {
  const p = store.getProject(projectId)
  const wf = store.getWorkflow(p, workflowId)
  const thread = store.createThread(p, { label: wf.name })
  store.saveWorkflow(p, { ...wf, lastRunAt: new Date().toISOString() })
  emit({ type: 'thread', projectId: p.id, threadId: thread.id })
  emit({ type: 'workflows', projectId: p.id })
  agents.send(p, thread.id, wf.prompt)
  return thread
}
