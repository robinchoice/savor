import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import * as store from './store.js'
import type { Project } from './store.js'
import { emit } from './events.js'
import { appUrl } from './config.js'
import * as agents from './agents.js'
import * as browser from './browser.js'
import * as processes from './processes.js'
import { runWorkflow, syncSchedules, validateCron } from './scheduler.js'
import { listAgents, mergeAgent, STATIC } from './providers.js'
import { addWorktree } from './git.js'

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }] })

function findProject(ref: string) {
  const all = store.listProjects()
  const found = all.find((p) => p.id === ref || (path.isAbsolute(ref) && path.resolve(ref) === path.resolve(p.path)))
  if (!found) throw new Error(`Unknown project ${ref}. Known projects: ${all.map((p) => `${p.id} (${p.name}, ${p.path})`).join('; ')}`)
  return found
}

function buildServer(p: Project, tid: string) {
  const server = new McpServer({ name: 'savor', version: '0.6.5' })
  const threadUrl = (id: string, project = p) => appUrl(`/p/${project.id}/t/${id}`)
  const touchThread = () => emit({ type: 'thread', projectId: p.id, threadId: tid })
  const modelInfo = () => store.getThread(p, tid).agent

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
      inputSchema: { text: z.string().min(1) },
    },
    async ({ text }) => {
      const r = agents.request(p, tid)
      if (r.ack && r.ack.text !== text) throw new Error('This request already has a different acknowledgement message.')
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
      if (!prev) r.updates.set(idempotencyKey, { text, id: agents.post(p, tid, { kind: 'update', text, modelInfo: modelInfo() }).id })
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
      },
    },
    async ({ text, questions, suggestions, commits }) => {
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
      }
      agents.markConcluded(tid, msg.id)
      store.updateThread(p, tid, { unread: true, needsYou: !!questions?.length })
      touchThread()
      agents.notify(p, tid, questions?.length ? `Your turn: ${questions[0].title}` : text!, questions?.length ? 'Has a question' : 'Finished')
      return ok({ id: msg.id, note: 'Delivered. Finish your turn now.' })
    },
  )

  // ---- documents ----

  const docUrl = (id: string) => appUrl(`/p/${p.id}/files/doc/${id}`)

  server.registerTool('list_documents', { description: 'List documents in this project.' }, async () =>
    ok(store.listDocs(p).map(({ id, title, updatedAt }) => ({ id, title, updatedAt, url: docUrl(id) }))),
  )

  server.registerTool('read_document', { description: 'Read a document (markdown).', inputSchema: { id: z.string() } }, async ({ id }) => ok(store.getDoc(p, id)))

  server.registerTool(
    'create_document',
    { description: 'Create a markdown document in this project.', inputSchema: { title: z.string().min(1), content: z.string() } },
    async ({ title, content }) => {
      const doc = store.saveDoc(p, { title, content })
      emit({ type: 'documents', projectId: p.id })
      return ok({ id: doc.id, url: docUrl(doc.id) })
    },
  )

  server.registerTool(
    'update_document',
    { description: 'Replace the title and/or content of a document.', inputSchema: { id: z.string(), title: z.string().optional(), content: z.string().optional() } },
    async ({ id, title, content }) => {
      const prev = store.getDoc(p, id)
      store.saveDoc(p, { id, title: title ?? prev.title, content: content ?? prev.content })
      emit({ type: 'documents', projectId: p.id })
      return ok({ id, url: docUrl(id) })
    },
  )

  // ---- workflows ----

  const wfUrl = (id: string) => appUrl(`/p/${p.id}/workflows/${id}`)
  // A workflow as an agent read it: update_workflow applies only while it is still that.
  const revisionOf = (wf: store.Workflow) => store.hash(JSON.stringify([wf.name, wf.prompt, wf.collection, wf.cron, wf.timezone, wf.scheduleLabel, wf.enabled, wf.catchUp, wf.next]))
  const workflowShape = {
    name: z.string().min(1),
    prompt: z.string().min(1).describe('Instructions the agent receives on each run'),
    collection: z.string().optional().describe('Name of the group the workflow is listed under'),
    cron: z.string().nullable().optional().describe('5-field cron expression, null for manual runs only'),
    timezone: z.string().optional().describe('IANA timezone, defaults to the host timezone'),
    scheduleLabel: z.string().nullable().optional().describe('The schedule in plain words, in the user’s language, e.g. “Mondays at 9:00”'),
    enabled: z.boolean().optional(),
    catchUp: z.boolean().optional().describe('Whether a scheduled time that passed while Savor was not running is run once at the next start (default true)'),
    next: z.array(z.string()).optional().describe('IDs of workflows to continue with after this one (a chain)'),
  }

  server.registerTool('list_workflows', { description: 'List workflows (saved prompts, optionally scheduled and chained).' }, async () =>
    ok(store.listWorkflows(p).map((wf) => ({ ...wf, url: wfUrl(wf.id) }))),
  )

  server.registerTool('read_workflow', { description: 'Read a workflow, including the workflows it links to and the revision update_workflow asks for.', inputSchema: { id: z.string() } }, async ({ id }) => {
    const wf = store.getWorkflow(p, id)
    return ok({ ...wf, revision: revisionOf(wf) })
  })

  server.registerTool(
    'create_workflow',
    { description: 'Save a workflow. With a cron expression Savor runs it on schedule in a new conversation.', inputSchema: workflowShape },
    async (wf) => {
      if (wf.cron) validateCron(wf.cron, wf.timezone)
      const saved = store.saveWorkflow(p, wf, agents.originOf(p, tid))
      syncSchedules()
      emit({ type: 'workflows', projectId: p.id })
      return ok({ id: saved.id, url: wfUrl(saved.id) })
    },
  )

  server.registerTool(
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
      store.saveWorkflow(p, { ...prev, ...clean }, agents.originOf(p, tid))
      syncSchedules()
      emit({ type: 'workflows', projectId: p.id })
      return ok({ id, url: wfUrl(id) })
    },
  )

  server.registerTool('run_workflow', { description: 'Run a workflow now in a new conversation.', inputSchema: { id: z.string() } }, async ({ id }) => {
    const t = runWorkflow(p.id, id, agents.originOf(p, tid))
    return ok({ threadId: t.id, url: threadUrl(t.id) })
  })

  // ---- conversations ----

  server.registerTool('list_projects', { description: 'The Savor projects on this computer, for start_conversation.' }, async () =>
    ok(store.listProjects().map(({ id, name, path }) => ({ id, name, path }))),
  )

  server.registerTool(
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
          .object({ provider: z.enum(Object.keys(STATIC) as [string, ...string[]]), model: z.string().optional(), reasoning: z.string().optional(), fast: z.boolean().optional(), permissionMode: z.string().optional() })
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
        worktree: worktree ? addWorktree(target, worktree) : here ? store.getThread(p, tid).worktree : null,
      })
      emit({ type: 'thread', projectId: target.id, threadId: t.id })
      const origin = agents.originOf(p, tid)
      const device = agents.deviceOf(p, tid)
      agents.send(target, t.id, { text: prompt, origin, device })
      // Input from a paired device that lands in another project shows up there, not only in this conversation.
      if (!here && origin === 'remote') {
        store.updateThread(target, t.id, { unread: true })
        agents.notify(target, t.id, `Started from ${p.name} by ${device ?? 'a paired device'}`, 'Started from another project')
      }
      return ok({ id: t.id, project: target.id, url: threadUrl(t.id, target) })
    },
  )

  server.registerTool('list_agents', { description: 'The agents installed on this computer with their models, reasoning levels and permission modes, for start_conversation.' }, async () =>
    ok({ current: modelInfo(), agents: await listAgents() }),
  )

  server.registerTool('list_conversations', { description: 'List conversations in this project.' }, async () =>
    ok(
      store.listThreads(p).map((t) => ({ id: t.id, title: t.title, label: t.label?.name ?? null, completed: t.completed, busy: agents.isBusy(t.id), worktree: t.worktree?.branch ?? null, url: threadUrl(t.id) })),
    ),
  )

  server.registerTool('read_conversation', { description: 'Read the visible messages of a conversation.', inputSchema: { id: z.string() } }, async ({ id }) =>
    ok({
      busy: agents.isBusy(id),
      messages: store.readMessages(p, id).map(({ kind, text, questions, ts }) => ({ kind, text, questions, ts })),
    }),
  )

  // ---- background processes ----

  server.registerTool(
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

  server.registerTool('unregister_process', { description: 'Unregister a process after stopping it.', inputSchema: { pid: z.number().int() } }, async ({ pid }) => {
    processes.unregister(p, pid)
    return ok({ unregistered: pid })
  })

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
