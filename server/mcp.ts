import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import * as store from './store.js'
import type { Project } from './store.js'
import { emit } from './events.js'
import { appUrl, VERSION } from './config.js'
import * as agents from './agents.js'
import * as browser from './browser.js'
import * as processes from './processes.js'
import { runWorkflow, runs, syncSchedules, validateCron } from './scheduler.js'
import { beginStep, delegated, preflightSchema, recordResult, resultSchema, saveStep, settled } from './workflow-results.js'
import { listAgents, mergeAgent, STATIC } from './providers.js'
import { addWorktree, git, openProject } from './git.js'
import * as ci from './ci.js'
import * as move from './move.js'
import * as terminal from './terminal.js'

const SUMMARY = z.string().min(1).max(120).describe('One short sentence on what the user\'s latest input asks for, in their language. The conversation list shows it.')

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }] })

function findProject(ref: string) {
  const all = store.listProjects()
  const found = all.find((p) => p.id === ref || (path.isAbsolute(ref) && path.resolve(ref) === path.resolve(p.path)))
  if (!found) throw new Error(`Unknown project ${ref}. Known projects: ${all.map((p) => `${p.id} (${p.name}, ${p.path})`).join('; ')}`)
  return found
}

const PROJECT = z.string().min(1).optional().describe('Project id or absolute path, see list_projects; defaults to this project')

function buildServer(p: Project, tid: string) {
  const server = new McpServer({ name: 'savor', version: VERSION })
  const threadUrl = (id: string, project = p) => appUrl(`/p/${project.id}/t/${id}`)
  const touchThread = () => emit({ type: 'thread', projectId: p.id, threadId: tid })
  const modelInfo = () => store.getThread(p, tid).agent
  // What this conversation's agent writes carries the origin of the input it works on.
  const provenance = (): store.Provenance => ({ origin: agents.originOf(p, tid), from: { projectId: p.id, threadId: tid } })

  // A tool that changes something. Each call goes to the action log of the project it changed, a refused one too.
  const changed = (ref: unknown) => {
    try {
      return typeof ref === 'string' ? findProject(ref) : p
    } catch {
      return p
    }
  }
  const change = <I extends z.ZodRawShape>(name: string, config: { description: string; inputSchema: I }, cb: ToolCallback<I>) =>
    server.registerTool(name, config, (async (args: Record<string, unknown>, extra: unknown) => {
      let error: string | undefined
      try {
        return await (cb as (args: unknown, extra: unknown) => unknown)(args, extra)
      } catch (e) {
        error = (e as Error).message
        throw e
      } finally {
        store.logAction(changed(args.project), {
          at: store.now(),
          tool: name,
          args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v])),
          ...(error && { error }),
          projectId: p.id,
          threadId: tid,
          origin: agents.originOf(p, tid),
          device: agents.deviceOf(p, tid),
          ...(agents.chainedOf(p, tid) && { chained: true }),
        })
      }
    }) as ToolCallback<I>)

  // ---- messages ----

  server.registerTool(
    'set_thread_label',
    { description: 'Set a short 3–6 word label for this conversation. Call first when threadLabel is null.', inputSchema: { label: z.string().min(1).max(80) } },
    async ({ label }) => {
      store.updateThread(p, tid, { label: { name: label, hue: store.hueFor(label) } })
      touchThread()
      return ok({ label })
    },
  )

  server.registerTool(
    'send_acknowledgement_message',
    {
      description: 'Tell the user you received their input and are starting work. One per input; retrying with the same text is safe.',
      inputSchema: { text: z.string().min(1), summary: SUMMARY },
    },
    async ({ text, summary }) => {
      const r = agents.request(p, tid)
      if (r.ack && r.ack.text !== text) throw new Error('This request already has a different acknowledgement message.')
      if (summary) store.updateThread(p, tid, { summary })
      r.ack ??= { text, id: agents.post(p, tid, { kind: 'ack', text, modelInfo: modelInfo() }).id }
      return ok({ id: r.ack.id })
    },
  )

  server.registerTool(
    'send_user_requested_message',
    {
      description:
        'Send an extra message the user explicitly asked for (e.g. requested progress updates). Not for unsolicited updates. Use a different idempotencyKey per distinct message; reuse key and text when retrying.',
      inputSchema: { idempotencyKey: z.string().regex(/^[\w-]{1,100}$/), text: z.string().min(1) },
    },
    async ({ idempotencyKey, text }) => {
      const r = agents.request(p, tid)
      const prev = r.updates.get(idempotencyKey)
      if (prev && prev.text !== text) throw new Error(`idempotencyKey ${idempotencyKey} was already used with different text.`)
      if (!prev) r.updates.set(idempotencyKey, { text, id: agents.post(p, tid, { kind: 'update', text, key: idempotencyKey, modelInfo: modelInfo() }).id })
      return ok({ id: r.updates.get(idempotencyKey)!.id })
    },
  )

  server.registerTool(
    'send_conclusion_message',
    {
      description:
        'Deliver the one final result for the current request. Questions block: end your turn afterwards. Suggestions are follow-up prompts in the user’s voice. Commits are full git hashes created this turn. Retry with identical content only.',
      inputSchema: {
        text: z.string().optional(),
        questions: z
          .array(z.object({ title: z.string(), body: z.string().default(''), options: z.array(z.string()).max(8), recommended: z.number().int().min(0).optional() }))
          .max(10)
          .optional(),
        suggestions: z.array(z.string()).max(3).optional(),
        commits: z.array(z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)).optional(),
        summary: SUMMARY.optional(),
      },
    },
    async ({ text, questions, suggestions, commits, summary }) => {
      if (!text && !questions?.length) throw new Error('Provide text, questions, or both.')
      const unrecommended = questions?.find((q) => q.options.length && (q.recommended ?? Infinity) >= q.options.length)
      if (unrecommended) throw new Error(`Set recommended to the index of the option you recommend for "${unrecommended.title}" and explain why in its body.`)
      const r = agents.request(p, tid)
      const key = agents.conclusionKey({ text, questions, suggestions, commits })
      if (r.conclusion) {
        if (r.conclusion.key !== key) throw new Error('This request already has a conclusion. Finish your turn and wait for new input.')
        return ok({ id: r.conclusion.id, note: 'Already delivered. Finish your turn now.' })
      }
      const msg = agents.post(p, tid, { kind: 'conclusion', text, questions, suggestions, commits, modelInfo: modelInfo() })
      r.conclusion = { key, id: msg.id }
      if (questions?.length) {
        const decisions = questions.map((q, i) => ({
          id: `${msg.id}-q${i}`,
          groupId: msg.id,
          threadId: tid,
          ...q,
          selected: null,
          answer: null,
          resolved: false,
          createdAt: msg.ts,
        }))
        decisions.forEach((d) => store.saveDecision(p, d))
        store.updateMessage(p, tid, msg.id, { decisionIds: decisions.map((d) => d.id) })
        const run = store.getThread(p, tid).workflow
        const step = run?.steps?.find((s) => s.id === run.activeStep)
        if (step?.begun && !settled(step.result) && (!step.preflight || step.preflight.status === 'ready')) recordResult(p, tid, step.id, { status: 'waiting', reason: 'Waiting for the user’s decision.', evidence: [msg.id], followUp: questions.map((q) => q.title) })
      }
      agents.markConcluded(tid, msg.id)
      store.updateThread(p, tid, { unread: true, needsYou: store.listDecisions(p, tid).some((d) => !d.resolved), ...(summary && { summary }) })
      touchThread()
      agents.notify(p, tid, questions?.length ? 'ask' : 'result', questions?.length ? `Your turn: ${questions[0].title}` : text!, questions?.length ? 'Has a question' : 'Finished')
      return ok({ id: msg.id, note: 'Delivered. Finish your turn now.' })
    },
  )

  // ---- documents ----

  const docUrl = (id: string) => appUrl(`/p/${p.id}/files/doc/${id}`)

  server.registerTool('list_documents', { description: 'List documents in this project.' }, async () =>
    ok(store.listDocs(p).map(({ id, title, updatedAt, origin }) => ({ id, title, updatedAt, origin, url: docUrl(id) }))),
  )

  server.registerTool('read_document', { description: 'Read a document (markdown).', inputSchema: { id: z.string() } }, async ({ id }) => ok(store.getDoc(p, id)))

  change(
    'create_document',
    { description: 'Create a markdown document in this project.', inputSchema: { title: z.string().min(1), content: z.string() } },
    async ({ title, content }) => {
      const doc = store.saveDoc(p, { title, content }, provenance())
      emit({ type: 'documents', projectId: p.id })
      return ok({ id: doc.id, url: docUrl(doc.id) })
    },
  )

  change(
    'update_document',
    { description: 'Replace the title and/or content of a document.', inputSchema: { id: z.string(), title: z.string().optional(), content: z.string().optional() } },
    async ({ id, title, content }) => {
      const prev = store.getDoc(p, id)
      store.saveDoc(p, { id, title: title ?? prev.title, content: content ?? prev.content }, provenance())
      emit({ type: 'documents', projectId: p.id })
      return ok({ id, url: docUrl(id) })
    },
  )

  // ---- workflows ----

  const wfUrl = (id: string) => appUrl(`/p/${p.id}/workflows/${id}`)
  // A workflow as an agent read it: update_workflow applies only while it is still that.
  const revisionOf = (wf: store.Workflow) => store.hash(JSON.stringify([wf.name, wf.prompt, wf.collection, wf.cron, wf.timezone, wf.scheduleLabel, wf.enabled, wf.catchUp, wf.button, wf.onModelChange, wf.next, wf.preflight]))
  const workflowShape = {
    name: z.string().min(1),
    prompt: z.string().min(1).describe('Instructions the agent receives on each run'),
    collection: z.string().optional().describe('Name of the group the workflow is listed under'),
    cron: z.string().nullable().optional().describe('5-field cron expression, null for manual runs only'),
    timezone: z.string().optional().describe('IANA timezone, defaults to the host timezone'),
    scheduleLabel: z.string().nullable().optional().describe('The schedule in plain words, in the user’s language, e.g. “Mondays at 9:00”'),
    enabled: z.boolean().optional(),
    catchUp: z.boolean().optional().describe('Whether a scheduled time that passed while Savor was not running is run once at the next start (default true)'),
    button: z.boolean().optional().describe('Whether the top bar shows a button that runs it now, in place of its next scheduled time within 12 hours (default false)'),
    onModelChange: z.boolean().optional().describe('Whether it also runs once each time the project’s agent runs on a new model (default false)'),
    next: z.array(z.string()).optional().describe('IDs of workflows to continue with after this one (a chain)'),
    preflight: preflightSchema.optional().describe('Read a fresh JSON signal from .workflow-checks/<name>.json before starting the agent. No commands are executed. Null removes it.'),
  }

  server.registerTool('list_workflows', { description: 'List workflows (saved prompts, optionally scheduled and chained).' }, async () =>
    ok(store.listWorkflows(p).map((wf) => ({ ...wf, url: wfUrl(wf.id) }))),
  )

  server.registerTool('read_workflow', { description: 'Read a workflow, including the workflows it links to and the revision update_workflow and delete_workflow ask for.', inputSchema: { id: z.string() } }, async ({ id }) => {
    const wf = store.getWorkflow(p, id)
    return ok({ ...wf, revision: revisionOf(wf) })
  })

  change(
    'create_workflow',
    { description: 'Save a workflow. With a cron expression Savor runs it on schedule in a new conversation.', inputSchema: workflowShape },
    async (wf) => {
      if (wf.cron) validateCron(wf.cron, wf.timezone)
      const saved = store.saveWorkflow(p, { ...wf, threadId: tid }, agents.originOf(p, tid))
      syncSchedules()
      emit({ type: 'workflows', projectId: p.id })
      return ok({ id: saved.id, url: wfUrl(saved.id) })
    },
  )

  change(
    'update_workflow',
    {
      description: 'Update fields of a workflow, with the revision read_workflow returned for it.',
      inputSchema: { id: z.string(), revision: z.string(), ...workflowShape, name: z.string().optional(), prompt: z.string().optional() },
    },
    async ({ id, revision, ...patch }) => {
      if (patch.cron) validateCron(patch.cron, patch.timezone)
      const prev = store.getWorkflow(p, id)
      if (revision !== revisionOf(prev)) throw new Error('The workflow changed since you read it. Read it again and apply your change to that.')
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      store.saveWorkflow(p, { ...prev, ...clean, threadId: tid }, agents.originOf(p, tid))
      syncSchedules()
      emit({ type: 'workflows', projectId: p.id })
      return ok({ id, url: wfUrl(id) })
    },
  )

  change(
    'delete_workflow',
    { description: 'Delete a workflow, with the revision read_workflow returned for it.', inputSchema: { id: z.string(), revision: z.string() } },
    async ({ id, revision }) => {
      if (revision !== revisionOf(store.getWorkflow(p, id))) throw new Error('The workflow changed since you read it. Read it again before deleting it.')
      store.deleteWorkflow(p, id)
      syncSchedules()
      emit({ type: 'workflows', projectId: p.id })
      return ok({ id })
    },
  )

  change('run_workflow', { description: 'Run a workflow now in a new conversation.', inputSchema: { id: z.string() } }, async ({ id }) => {
    const t = runWorkflow(p.id, id, agents.originOf(p, tid), undefined, agents.chainedOf(p, tid))
    if (t.id !== tid) delegated(p, tid, p, t.id)
    return ok({ threadId: t.id, url: threadUrl(t.id) })
  })

  server.registerTool('list_workflow_runs', { description: 'Read workflow run lifecycle, step outcomes, evidence, follow-up, attempts, duration and reported usage. A finished turn is not a successful outcome.', inputSchema: { id: z.string() } }, async ({ id }) => ok(runs(p, store.getWorkflow(p, id))))

  change('begin_workflow_step', { description: 'Before executing a linked workflow in this run, check its preflight. Execute the returned prompt only when run is true. Already settled steps return run false. Paused steps are blocked.', inputSchema: { id: z.string() } }, async ({ id }) => {
    const t = store.getThread(p, tid)
    if (!t.workflow?.steps?.some((s) => s.id === id)) throw new Error('The workflow is not a step of this run.')
    const prev = t.workflow.steps.find((s) => s.id === id)!
    const wf = store.listWorkflows(p).find((w) => w.id === id)
    if (!wf || (wf.origin === 'remote' && agents.originOf(p, tid) === 'local')) {
      const step = saveStep(p, tid, { ...prev, finishedAt: store.now(), result: { status: 'blocked', reason: !wf ? 'The linked workflow is missing.' : 'The linked workflow now has remote instructions.', evidence: [id], followUp: [!wf ? 'Restore the linked workflow or explicitly resolve this run.' : 'Resume the run so its input carries remote origin.'] } })
      touchThread()
      return ok({ ...step, run: false })
    }
    const step = beginStep(p, tid, wf)
    touchThread()
    return ok({ ...step, ...(step.run && { prompt: wf.prompt, next: wf.next }) })
  })

  change('report_workflow_result', {
    description: 'Persist the business outcome of one begun workflow step, separately from ending the turn. Delegation is partial until explicitly verified; closing its conversation is insufficient. Include evidence and remaining follow-up. Waiting means an intentional wait for the user; blocked means an unmet prerequisite.',
    inputSchema: { id: z.string(), result: resultSchema, verifiedDelegations: z.array(z.object({ threadId: z.string(), evidence: z.string().trim().min(1).max(2000) })).max(100).optional() },
  }, async ({ id, result, verifiedDelegations }) => {
    const step = recordResult(p, tid, id, result, verifiedDelegations)
    touchThread()
    emit({ type: 'workflows', projectId: p.id })
    return ok(step)
  })

  // ---- backlog ----

  change(
    'add_to_backlog',
    {
      description:
        'Put something on the backlog of this project, or of another one named by `project`: work worth doing later that nobody started yet, e.g. a follow-up you noticed but that is outside the current request. The user starts it from the board in All projects. Check list_backlog first so the same item is not added twice.',
      inputSchema: { title: z.string().trim().min(1).max(300).describe('What to do, as a prompt an agent can start from'), project: PROJECT },
    },
    async ({ title, project }) => {
      const target = project ? findProject(project) : p
      const item = store.addBacklogItem(target, title, provenance())
      emit({ type: 'backlog', projectId: target.id })
      return ok({ id: item.id, project: target.id, url: appUrl('/all/board') })
    },
  )

  server.registerTool('list_backlog', { description: 'List the backlog of this project, or of another one named by `project`.', inputSchema: { project: PROJECT } }, async ({ project }) =>
    ok(store.readBacklog(project ? findProject(project) : p).items),
  )

  change(
    'remove_from_backlog',
    {
      description:
        'Remove an item from the backlog of this project, or of another one named by `project`. Only for items that are already done or that you just started in a conversation; the id comes from list_backlog.',
      inputSchema: { id: z.string().min(1), project: PROJECT },
    },
    async ({ id, project }) => {
      const target = project ? findProject(project) : p
      if (!store.removeBacklogItem(target, id)) throw new Error(`No backlog item ${id} in project ${target.id}. list_backlog shows the ids.`)
      emit({ type: 'backlog', projectId: target.id })
      return ok({ id, project: target.id })
    },
  )

  // ---- conversations ----

  server.registerTool('list_projects', { description: 'The Savor projects on this computer, for start_conversation, send_to_conversation and the `project` of the other conversation tools.' }, async () =>
    ok(store.listProjects().map(({ id, name, path }) => ({ id, name, path }))),
  )

  change(
    'create_project',
    {
      description:
        'Add a Savor project for a folder, e.g. after cloning a new repository. A missing folder is created with an empty git repository; an existing one is opened as it is, and one that already is a project returns that project. Use the id for start_conversation and the other tools.',
      inputSchema: { path: z.string().min(1).describe('Absolute path or ~/…'), name: z.string().min(1).optional().describe('Display name; defaults to the folder name') },
    },
    async ({ path: dir, name }) => {
      if (agents.originOf(p, tid) === 'remote') throw new Error('Projects can only be added from input on this computer.')
      if (!/^(~\/|\/)/.test(dir)) throw new Error('Give an absolute path or one starting with ~/.')
      const project = openProject(dir, name, !fs.existsSync(store.expand(dir)))
      return ok({ id: project.id, name: project.name, path: project.path })
    },
  )

  // Both change what Savor knows about the computer's folders, so the user approves each call in this conversation.
  const approved = async (title: string, detail: string, allow: string) =>
    (await agents.askApproval(p, tid, { title, detail, options: [{ id: 'allow', label: allow, kind: 'allow' }, { id: 'deny', label: 'Cancel', kind: 'deny' }] })).choice === 'allow'

  change(
    'move_project',
    {
      description:
        'Move or rename a project folder, archive it to `_archive/` next to it, or point the project at the place it already moved to (e.g. the target of a symlink). Conversations, git worktrees and Claude Code sessions follow. The user approves the move here first. Conversations of that project must not be at work, so it can\'t move the project this conversation runs in.',
      inputSchema: {
        project: z.string().min(1).describe('Project id or absolute path, see list_projects'),
        path: z.string().min(1).optional().describe('New absolute path or ~/…'),
        archive: z.boolean().optional().describe('Move to `_archive/<folder>` next to the folder instead of `path`'),
        link: z.boolean().optional().describe('Leave a symlink at the old path, or keep the one there (default true)'),
      },
    },
    async ({ project, path: dir, archive, link }) => {
      const target = findProject(project)
      const to = archive ? move.archivePath(target) : dir
      if (!to || !/^(~\/|\/)/.test(to)) throw new Error('Give `path` as an absolute path or one starting with ~/, or `archive`.')
      const plan = move.planMove(target, to)
      if (plan.blockers.length) throw new Error(plan.blockers.join(' '))
      const keep = link ?? true
      const detail = [
        `${plan.mode === 'move' ? 'Moves' : 'Points the project from'} ${plan.from} ${plan.mode === 'move' ? 'to' : 'at'} ${plan.to}${plan.mode === 'move' && keep ? ', leaving a symlink at the old path' : ''}.`,
        plan.symlink && (keep ? `The symlink ${plan.from} stays.` : `Deletes the symlink ${plan.from}.`),
        plan.claudeSessions && `${plan.claudeSessions} Claude Code session${plan.claudeSessions === 1 ? '' : 's'} move along.`,
        plan.worktrees && `${plan.worktrees} worktree${plan.worktrees === 1 ? '' : 's'} get repaired.`,
        plan.processes.length && `Processes outside Savor work in the folder:\n${plan.processes.map((pr) => `  ${pr.pid} ${pr.command}`).join('\n')}`,
      ].filter(Boolean).join('\n')
      if (!(await approved(`Move ${target.name}?`, detail, plan.processes.length ? 'Move anyway' : 'Move'))) return ok('The user cancelled the move.')
      // Moved or removed elsewhere meanwhile, it would be another folder now.
      const now = store.listProjects().find((q) => q.id === target.id)
      if (now?.path !== target.path) throw new Error(`${target.name} changed while waiting for the approval. Look again.`)
      const moved = move.moveProject(now, to, { link: keep, force: true })
      return ok({ id: moved.id, name: moved.name, path: moved.path })
    },
  )

  change(
    'remove_project',
    {
      description: 'Remove a project from Savor. Its folder and the conversations in its .savor stay on disk; adding the folder again brings them back. The user approves it here first.',
      inputSchema: { project: z.string().min(1).describe('Project id or absolute path, see list_projects') },
    },
    async ({ project }) => {
      const target = findProject(project)
      if (target.id === p.id) throw new Error('This conversation runs in that project. Remove it from another one.')
      if (!(await approved(`Remove ${target.name} from Savor?`, `${target.path} and its conversations stay on disk.`, 'Remove'))) return ok('The user kept the project.')
      store.removeProject(target.id)
      terminal.closeProject(target.id)
      emit({ type: 'projects' })
      return ok(`Removed ${target.name}.`)
    },
  )

  change(
    'start_conversation',
    {
      description:
        'Start a new conversation with its own agent, e.g. to delegate a separate task. It starts in this project unless `project` names another one (see list_projects). Without agent settings it uses this conversation’s agent, or the other project’s default agent; agent settings change that agent. With `worktree`, the conversation works in its own git worktree of that branch (created from HEAD when new); otherwise it works where this conversation works, or in another project’s folder.',
      inputSchema: {
        prompt: z.string().min(1),
        label: z.string().optional(),
        project: z.string().min(1).optional().describe('Project id or absolute path, see list_projects'),
        worktree: z.string().min(1).optional().describe('Branch name for a separate git worktree'),
        agent: z
          .object({ provider: z.enum(Object.keys(STATIC) as [string, ...string[]]), model: z.string().optional(), reasoning: z.string().optional(), fast: z.boolean().optional(), ultracode: z.boolean().optional(), permissionMode: z.string().optional() })
          .optional()
          .describe('See list_agents for providers, models, reasoning levels and permission modes'),
      },
    },
    async ({ prompt, label, project, worktree, agent }) => {
      const target = project ? findProject(project) : p
      const here = target.id === p.id
      const current = modelInfo()
      const base = here ? current : target.agent
      const chosen = agent ? mergeAgent(base, { ...agent, provider: agent.provider as store.Provider }) : base
      if (chosen.permissionMode !== current.permissionMode && STATIC[chosen.provider].modes.find((m) => m.id === chosen.permissionMode)?.unsafe)
        throw new Error('A started conversation cannot have broader permissions than this one.')
      // A thread id only means something within its project, and this conversation's worktree belongs to this one.
      const t = store.createThread(target, {
        title: prompt,
        label,
        agent: chosen,
        parentId: here ? tid : undefined,
        routedFrom: store.getThread(p, tid).inbox ? { projectId: p.id, threadId: tid } : undefined,
        worktree: worktree ? addWorktree(target, worktree) : here ? store.getThread(p, tid).worktree : null,
        unattended: agents.unattended(store.getThread(p, tid)),
      })
      delegated(p, tid, target, t.id)
      emit({ type: 'thread', projectId: target.id, threadId: t.id })
      const origin = agents.originOf(p, tid)
      const device = agents.deviceOf(p, tid)
      agents.send(target, t.id, { text: prompt, origin, device, chained: agents.chainedOf(p, tid) })
      // Input from a paired device that lands in another project shows up there, not only in this conversation.
      if (!here && origin === 'remote') {
        store.updateThread(target, t.id, { unread: true })
        agents.notify(target, t.id, 'message', `Started from ${p.name} by ${device ?? 'a paired device'}`, 'Started from another project', p.name)
      }
      return ok({ id: t.id, project: target.id, url: threadUrl(t.id, target) })
    },
  )

  server.registerTool('list_agents', { description: 'The agents installed on this computer with their models, reasoning levels and permission modes, for start_conversation.' }, async () =>
    ok({ current: modelInfo(), agents: await listAgents() }),
  )

  server.registerTool(
    'list_conversations',
    {
      description: 'List the conversations in this project, or in another one named by `project`, newest input first. Without filters it lists all of them.',
      inputSchema: {
        project: PROJECT,
        state: z.enum(['open', 'busy']).optional().describe('Only conversations not marked as done (open) or with an agent at work (busy)'),
        since: z.iso.datetime({ offset: true }).optional().describe('Only conversations changed since this ISO time, see updatedAt'),
        limit: z.number().int().min(1).optional().describe('At most this many conversations'),
      },
    },
    async ({ project, state, since, limit }) => {
      const target = project ? findProject(project) : p
      const threads = store
        .listThreads(target)
        .filter((t) => (state === 'open' ? !t.completed : state === 'busy' ? agents.isBusy(t.id) : true) && (!since || Date.parse(t.updatedAt) >= Date.parse(since)))
        .slice(0, limit)
      return ok(threads.map((t) => ({ id: t.id, title: t.title, label: t.label?.name ?? null, completed: t.completed, busy: agents.isBusy(t.id), worktree: t.worktree?.branch ?? null, updatedAt: t.updatedAt, url: threadUrl(t.id, target) })))
    },
  )

  server.registerTool(
    'read_conversation',
    { description: 'Read the visible messages of a conversation in this project, or in another one named by `project`. `from` marks messages another conversation’s agent sent.', inputSchema: { id: z.string(), project: PROJECT } },
    async ({ id, project }) => {
      const target = project ? findProject(project) : p
      return ok({
        busy: agents.isBusy(id),
        workflow: store.getThread(target, id).workflow,
        messages: store.readMessages(target, id).map(({ kind, text, questions, ts, from }) => ({ kind, text, questions, ts, from })),
      })
    },
  )

  change(
    'send_to_conversation',
    {
      description:
        'Send a message to an existing conversation, in this project or in another one named by `project` (ids from list_conversations), e.g. to pass on a change other sessions need to know about. It waits in that conversation’s queue like user input and reaches its agent after the current turn, shown and marked as a message from this conversation. It informs and never approves anything. A turn set off by an agent message cannot send one: answer in your conclusion instead.',
      inputSchema: { id: z.string(), text: z.string().min(1), project: PROJECT },
    },
    async ({ id, text, project }) => {
      const target = project ? findProject(project) : p
      if (target.id === p.id && id === tid) throw new Error('This is your own conversation.')
      if (agents.chainedOf(p, tid)) throw new Error('This turn was set off by a message from another agent, so it cannot send agent messages. Answer in your conclusion; the sender can read it with read_conversation.')
      store.getThread(target, id)
      const me = store.getThread(p, tid)
      const origin = agents.originOf(p, tid)
      const device = agents.deviceOf(p, tid)
      const msg = agents.send(target, id, { text, origin, device, chained: true, from: { projectId: p.id, project: p.name, threadId: tid, label: me.label?.name ?? me.title } })
      delegated(p, tid, target, id)
      // A message set off by a paired device's input is announced in the receiving conversation, wherever it is.
      if (origin === 'remote') {
        store.updateThread(target, id, { unread: true })
        agents.notify(target, id, 'message', `Message from ${p.name} by ${device ?? 'a paired device'}`, 'Message from another agent', p.name)
      }
      emit({ type: 'thread', projectId: target.id, threadId: id })
      return ok({ id: msg.id, queued: msg.delivered === false, url: threadUrl(id, target) })
    },
  )

  change(
    'complete_conversation',
    {
      description:
        'Mark a finished conversation as done, in this project or in another one named by `project` (ids from list_conversations), like the user does in the list. Only for conversations whose request is carried out, with nothing left open. New input reopens it.',
      inputSchema: { id: z.string(), project: PROJECT },
    },
    async ({ id, project }) => {
      const target = project ? findProject(project) : p
      if (target.id === p.id && id === tid) throw new Error('This is your own conversation.')
      const t = store.getThread(target, id)
      if (agents.isBusy(id) || agents.waiting(target, t)) throw new Error('The conversation is still working.')
      if (t.needsYou) throw new Error('The conversation waits for the user.')
      store.updateThread(target, id, { completed: true })
      emit({ type: 'thread', projectId: target.id, threadId: id })
      agents.tidyWorktree(target, t.worktree?.path)
      return ok({ id, completed: true, url: threadUrl(id, target) })
    },
  )

  // ---- background processes ----

  change(
    'register_process',
    {
      description: 'Register a background process you started (server, watcher, long job) right after launch.',
      inputSchema: {
        pid: z.number().int().positive().describe('Real OS PID'),
        name: z.string().min(1),
        command: z.string(),
        cwd: z.string().optional(),
        url: z.string().optional(),
        log: z.string().regex(/^\.savor-logs\/[\w-]+\.log$/).optional(),
      },
    },
    async ({ pid, name, command, cwd, url, log }) => {
      processes.register(p, { pid, name, command, cwd: cwd ?? store.cwdOf(p, store.getThread(p, tid)), url: url ?? null, log: log ?? null, threadId: tid, startedAt: store.now() })
      return ok({ registered: pid })
    },
  )

  change('unregister_process', { description: 'Unregister a process after stopping it.', inputSchema: { pid: z.number().int() } }, async ({ pid }) => {
    processes.unregister(p, pid)
    return ok({ unregistered: pid })
  })

  // ---- CI ----

  server.registerTool(
    'watch_ci',
    {
      description:
        'Wait for the GitHub Actions runs of a pushed commit without holding your turn (uses the GitHub CLI). When they have not all finished yet, Savor checks them every 20 seconds and continues this request with their result once they have: end your turn without a conclusion if your conclusion depends on them, e.g. a deploy to verify. Without `commit` it watches HEAD of your working directory, or of the repo of `project` for a commit pushed from another project.',
      inputSchema: { commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(), project: PROJECT },
    },
    async ({ commit, project }) => {
      const target = project ? findProject(project) : null
      const cwd = target?.path ?? store.cwdOf(p, store.getThread(p, tid))
      const sha = git(cwd, 'rev-parse', commit ?? 'HEAD')
      const runs = await ci.runsOf(cwd, sha)
      if (ci.finished(runs)) return ok(ci.report(sha, runs))
      agents.watchCi(p, tid, sha, target?.id)
      const going = runs.filter((r) => r.status !== 'completed').length
      return ok(`${runs.length ? `${going} of ${runs.length} runs are still going` : 'No runs have shown up yet'}. Savor continues this request with their result when they have finished: end your turn now, without a conclusion if it depends on them.`)
    },
  )

  // ---- product preview ----

  const browserTool = async (fn: () => Promise<string>) => ok(await fn())

  server.registerTool('open_browser', { description: 'Show a working web product in the preview beside this conversation.', inputSchema: { url: z.string().url() } }, async ({ url }) => {
    await browser.open(p.id, tid, url)
    store.updateThread(p, tid, { preview: url })
    touchThread()
    emit({ type: 'browser', projectId: p.id, threadId: tid })
    return ok('Opened. Use browser_inspect to read the page.')
  })
  server.registerTool('browser_inspect', { description: 'Read the preview: visible text, controls with refs, console errors.' }, async () => browserTool(() => browser.inspect(tid)))
  server.registerTool('browser_click', { description: 'Click a control by ref from browser_inspect.', inputSchema: { ref: z.string() } }, async ({ ref }) => browserTool(() => browser.click(tid, ref)))
  server.registerTool('browser_fill', { description: 'Fill a text field or select an option by ref.', inputSchema: { ref: z.string(), value: z.string() } }, async ({ ref, value }) =>
    browserTool(() => browser.fill(tid, ref, value)),
  )
  server.registerTool(
    'browser_type',
    { description: 'Type text as real keystrokes, optionally clicking a control (ref) first. Use browser_fill to replace a value instead.', inputSchema: { text: z.string(), ref: z.string().optional() } },
    async ({ text, ref }) => browserTool(() => browser.type(tid, text, ref)),
  )
  server.registerTool(
    'browser_pointer',
    {
      description: 'Mouse input at page coordinates (CSS pixels, viewport 1280×800) for canvases, drag handles and elements without a ref.',
      inputSchema: { action: z.enum(['click', 'dblclick', 'move', 'down', 'up']), x: z.number(), y: z.number() },
    },
    async ({ action, x, y }) => browserTool(() => browser.pointer(tid, action, x, y)),
  )
  server.registerTool('browser_press', { description: 'Press a key, e.g. Enter or Control+A.', inputSchema: { key: z.string() } }, async ({ key }) => browserTool(() => browser.press(tid, key)))
  server.registerTool('browser_scroll', { description: 'Scroll the page vertically by dy pixels.', inputSchema: { dy: z.number() } }, async ({ dy }) => browserTool(() => browser.scroll(tid, dy)))
  server.registerTool('browser_navigate', { description: 'Navigate the preview to a URL.', inputSchema: { url: z.string().url() } }, async ({ url }) => {
    store.updateThread(p, tid, { preview: url })
    return browserTool(() => browser.navigate(tid, url))
  })
  server.registerTool('browser_screenshot', { description: 'Capture the preview as an image.' }, async () => ({
    content: [{ type: 'image' as const, data: (await browser.screenshot(tid)).toString('base64'), mimeType: 'image/png' }],
  }))

  return server
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL, body: unknown) {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  const p = store.getProject(url.searchParams.get('project') ?? '')
  const tid = url.searchParams.get('thread') ?? ''
  store.getThread(p, tid)
  const server = buildServer(p, tid)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    transport.close()
    server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
