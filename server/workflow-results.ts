import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import * as store from './store.js'
import type { Project, Workflow, WorkflowResult, WorkflowStep } from './store.js'

export const preflightSchema = z.object({
  file: z.string().regex(/^\.workflow-checks\/[a-zA-Z0-9_-]+\.json$/),
  maxAgeSeconds: z.number().int().min(1).max(86400),
}).strict().nullable()

export const resultSchema = z.object({
  status: z.enum(['successful', 'partial', 'blocked', 'skipped', 'waiting', 'failed']),
  reason: z.string().trim().min(1).max(2000),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  followUp: z.array(z.string().trim().min(1).max(2000)).max(20),
}).strict().superRefine((r, ctx) => {
  if (['partial', 'blocked', 'waiting', 'failed'].includes(r.status) && !r.followUp.length)
    ctx.addIssue({ code: 'custom', message: 'An unresolved result needs follow-up work.' })
  if (['successful', 'skipped'].includes(r.status) && r.followUp.length)
    ctx.addIssue({ code: 'custom', message: 'Open follow-up work cannot be successful or skipped.' })
})

const signalSchema = z.object({
  checkedAt: z.iso.datetime(),
  status: z.enum(['ok', 'blocked', 'failed']),
  work: z.boolean(),
  pending: z.boolean(),
  reason: z.string().trim().min(1).max(2000),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  followUp: z.array(z.string().trim().min(1).max(2000)).max(20),
}).strict()

export function preflight(p: Project, wf: Workflow): WorkflowStep['preflight'] {
  if (!wf.preflight) return undefined
  const blocked = (reason: string, status: 'blocked' | 'failed' = 'blocked'): NonNullable<WorkflowStep['preflight']> => ({
    status, reason, evidence: ['Workflow preflight could not establish that work is ready.'], followUp: ['Refresh the preflight with the existing authorized producer, then retry the workflow.'],
  })
  const config = preflightSchema.safeParse(wf.preflight)
  if (!config.success || !config.data) return blocked('Invalid preflight configuration.', 'failed')
  const file = path.join(p.path, config.data.file)
  let fd: number | undefined
  try {
    const dir = fs.lstatSync(path.dirname(file))
    if (!dir.isDirectory() || dir.isSymbolicLink()) return blocked('The preflight directory must be a regular project directory.', 'failed')
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) return blocked('The preflight must be a regular file of at most 64 KiB.', 'failed')
    const buffer = Buffer.alloc(65537)
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0)
    if (size > 65536) return blocked('The preflight exceeds 64 KiB.', 'failed')
    const parsed = signalSchema.safeParse(JSON.parse(buffer.subarray(0, size).toString('utf8')))
    if (!parsed.success) return blocked('Invalid preflight data.', 'failed')
    const s = parsed.data
    const age = Date.now() - Date.parse(s.checkedAt)
    if (age < 0 || age > config.data.maxAgeSeconds * 1000) return blocked('The preflight is stale or has a future timestamp.')
    if ((s.status !== 'ok' || s.pending) && !s.followUp.length) return blocked('The preflight is missing required follow-up work.', 'failed')
    if (s.status === 'ok' && !s.work && !s.pending && s.followUp.length) return blocked('A no-work preflight cannot contain unfinished work.', 'failed')
    return { checkedAt: s.checkedAt, status: s.status !== 'ok' ? s.status : s.work || s.pending ? 'ready' : 'skipped', reason: s.reason, evidence: s.evidence, followUp: s.followUp }
  } catch (e) {
    return blocked((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'The preflight file is missing.' : 'The preflight file could not be read or validated.', (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'blocked' : 'failed')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export const settled = (r: WorkflowResult | undefined) => !!r && (r.status === 'successful' || r.status === 'skipped')

export function saveStep(p: Project, tid: string, step: WorkflowStep) {
  const t = store.getThread(p, tid)
  if (!t.workflow) throw new Error('This conversation is not a workflow run.')
  const steps = t.workflow.steps ?? []
  store.updateThread(p, tid, { workflow: { ...t.workflow, steps: steps.some((s) => s.id === step.id) ? steps.map((s) => s.id === step.id ? step : s) : [...steps, step] } })
  return step
}

export function beginStep(p: Project, tid: string, wf: Workflow) {
  const t = store.getThread(p, tid)
  if (!t.workflow) throw new Error('This conversation is not a workflow run.')
  const prev = t.workflow.steps?.find((s) => s.id === wf.id)
  if (settled(prev?.result)) return { ...prev!, run: false }
  const check = wf.enabled ? preflight(p, wf) : { status: 'blocked' as const, reason: 'The linked workflow is paused.', evidence: [wf.id], followUp: ['Wait for the workflow to be enabled.'] }
  if (check) attempt(p, tid, 'check', { stepId: wf.id, check })
  const step: WorkflowStep = { ...prev, id: wf.id, name: wf.name, startedAt: prev?.startedAt ?? store.now(), preflight: check }
  if (check && check.status !== 'ready') {
    // A no-work signal cannot close unfinished work already recorded by the agent.
    const unresolved = !!prev?.begun && (!settled(prev.result) || prev.delegated?.some((d) => !d.evidence))
    step.result = check.status === 'skipped' && unresolved
      ? { status: 'blocked', reason: 'Unfinished work requires a ready preflight.', evidence: check.evidence, followUp: prev?.result?.followUp.length ? prev.result.followUp : ['Finish or explicitly resolve the previously started step.'] }
      : { status: check.status, reason: check.reason, evidence: check.evidence, followUp: check.followUp }
    step.finishedAt = store.now()
    saveStep(p, tid, step)
    return { ...step, run: false }
  }
  delete step.result
  delete step.finishedAt
  step.begun = true
  saveStep(p, tid, step)
  const fresh = store.getThread(p, tid)
  store.updateThread(p, tid, { workflow: { ...fresh.workflow!, activeStep: wf.id } })
  return { ...step, run: true }
}

export function recordResult(p: Project, tid: string, id: string, result: WorkflowResult, verified: { threadId: string; evidence: string }[] = []) {
  const t = store.getThread(p, tid)
  const step = t.workflow?.steps?.find((s) => s.id === id)
  if (!step?.begun || (step.preflight && step.preflight.status !== 'ready')) throw new Error('Begin the workflow step with a ready preflight before reporting its result.')
  const clean = resultSchema.parse(result)
  const delegated = step.delegated?.map((d) => ({ ...d, evidence: verified.find((v) => v.threadId === d.threadId)?.evidence ?? d.evidence }))
  if (['successful', 'skipped'].includes(clean.status) && delegated?.some((d) => !d.evidence)) throw new Error('Delegated work needs explicit verification evidence before this step can finish.')
  return saveStep(p, tid, { ...step, result: clean, delegated, finishedAt: store.now() })
}

export function delegated(p: Project, tid: string, target: Project, threadId: string) {
  const t = store.getThread(p, tid)
  const step = t.workflow?.steps?.find((s) => s.id === t.workflow?.activeStep)
  if (!step) return
  const ref = `${target.id}/${threadId}`
  saveStep(p, tid, { ...step, delegated: [...(step.delegated ?? []).filter((d) => d.projectId !== target.id || d.threadId !== threadId), { projectId: target.id, threadId }], result: { status: 'partial', reason: 'Work was delegated and awaits verification.', evidence: [ref], followUp: [`Verify the result of ${ref}.`] } })
}

export function attempt(p: Project, tid: string, kind: store.WorkflowAttempt['kind'], detail: Pick<store.WorkflowAttempt, 'stepId' | 'check'> = {}) {
  const t = store.getThread(p, tid)
  if (t.workflow?.steps) store.updateThread(p, tid, { workflow: { ...t.workflow,
    attempts: [...(t.workflow.attempts ?? []), { at: store.now(), kind, ...detail }].slice(-200),
    attemptCounts: { ...t.workflow.attemptCounts, [kind]: (t.workflow.attemptCounts?.[kind] ?? 0) + 1 },
  } })
}
