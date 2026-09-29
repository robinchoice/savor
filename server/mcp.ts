import type { IncomingMessage, ServerResponse } from 'node:http'
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

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }] })

const approvals = new Map<string, (allow: boolean) => void>()

export function resolveApproval(p: Project, tid: string, mid: string, allow: boolean) {
  const msg = store.readMessages(p, tid).find((m) => m.id === mid)
  if (!msg?.approval) throw new store.NotFound(`approval ${mid}`)
  store.updateMessage(p, tid, mid, { approval: { ...msg.approval, status: allow ? 'allowed' : 'denied' } })
  emit({ type: 'message', projectId: p.id, threadId: tid })
  approvals.get(mid)?.(allow)
  approvals.delete(mid)
}

function buildServer(p: Project, tid: string) {
  const server = new McpServer({ name: 'savor', version: '0.1.0' })
  const threadUrl = (id: string) => appUrl(`/p/${p.id}/t/${id}`)
  const touchThread = () => emit({ type: 'thread', projectId: p.id, threadId: tid })

  // ---- messages ----

  server.registerTool(
    'set_thread_label',
    { description: 'Set a short 3–6 word label for this conversation. Call first when threadLabel is null.', inputSchema: { label: z.string().min(1).max(80) } },
    async ({ label }) => {
      store.updateThread(p, tid, { label })
      touchThread()
      return ok({ label })
    },
  )

  server.registerTool(
    'send_acknowledgement_message',
    { description: 'Tell the user you received their input and are starting work. Send before long work.', inputSchema: { text: z.string().min(1) } },
    async ({ text }) => ok({ id: agents.post(p, tid, { kind: 'ack', text }).id }),
  )

  server.registerTool(
    'send_user_requested_message',
    { description: 'Send an extra message the user explicitly asked for (e.g. requested progress updates). Not for unsolicited updates.', inputSchema: { text: z.string().min(1) } },
    async ({ text }) => ok({ id: agents.post(p, tid, { kind: 'update', text }).id }),
  )

  server.registerTool(
    'send_conclusion_message',
    {
      description:
        'Deliver the one final result for the current request. Questions block: end your turn afterwards. Suggestions are follow-up prompts in the user’s voice. Commits are full git hashes created this turn.',
      inputSchema: {
        text: z.string().optional(),
        questions: z.array(z.object({ title: z.string(), body: z.string().default(''), options: z.array(z.string()).max(8) })).max(10).optional(),
        suggestions: z.array(z.string()).max(3).optional(),
        commits: z.array(z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)).optional(),
      },
    },
    async ({ text, questions, suggestions, commits }) => {
      if (!text && !questions?.length) throw new Error('Provide text, questions, or both.')
      const msg = agents.post(p, tid, { kind: 'conclusion', text, questions, suggestions, commits })
      agents.markConcluded(tid)
      store.updateThread(p, tid, { unread: true })
      touchThread()
      return ok({ id: msg.id, note: 'Delivered. Finish your turn now.' })
    },
  )

  // ---- documents ----

  const docUrl = (id: string) => appUrl(`/p/${p.id}/docs/${id}`)

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
  const workflowShape = {
    name: z.string().min(1),
    prompt: z.string().min(1).describe('Instructions the agent receives on each run'),
    cron: z.string().nullable().optional().describe('5-field cron expression, null for manual runs only'),
    timezone: z.string().optional().describe('IANA timezone, defaults to the host timezone'),
    enabled: z.boolean().optional(),
  }

  server.registerTool('list_workflows', { description: 'List workflows (saved prompts, optionally on a cron schedule).' }, async () =>
    ok(store.listWorkflows(p).map((wf) => ({ ...wf, url: wfUrl(wf.id) }))),
  )

  server.registerTool('read_workflow', { description: 'Read a workflow.', inputSchema: { id: z.string() } }, async ({ id }) => ok(store.getWorkflow(p, id)))

  server.registerTool(
    'create_workflow',
    { description: 'Save a workflow. With a cron expression Savor runs it on schedule in a new conversation.', inputSchema: workflowShape },
    async (wf) => {
      if (wf.cron) validateCron(wf.cron, wf.timezone)
      const saved = store.saveWorkflow(p, wf)
      syncSchedules()
      emit({ type: 'workflows', projectId: p.id })
      return ok({ id: saved.id, url: wfUrl(saved.id) })
    },
  )

  server.registerTool(
    'update_workflow',
    { description: 'Update fields of a workflow.', inputSchema: { id: z.string(), ...workflowShape, name: z.string().optional(), prompt: z.string().optional() } },
    async ({ id, ...patch }) => {
      if (patch.cron) validateCron(patch.cron, patch.timezone)
      const prev = store.getWorkflow(p, id)
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      store.saveWorkflow(p, { ...prev, ...clean })
      syncSchedules()
      emit({ type: 'workflows', projectId: p.id })
      return ok({ id, url: wfUrl(id) })
    },
  )

  server.registerTool('run_workflow', { description: 'Run a workflow now in a new conversation.', inputSchema: { id: z.string() } }, async ({ id }) => {
    const t = runWorkflow(p.id, id)
    return ok({ threadId: t.id, url: threadUrl(t.id) })
  })

  // ---- conversations ----

  server.registerTool(
    'start_conversation',
    { description: 'Start a new conversation in this project with its own agent, e.g. to delegate a separate task.', inputSchema: { prompt: z.string().min(1), label: z.string().optional() } },
    async ({ prompt, label }) => {
      const t = store.createThread(p, { label, parentId: tid })
      emit({ type: 'thread', projectId: p.id, threadId: t.id })
      agents.send(p, t.id, prompt)
      return ok({ id: t.id, url: threadUrl(t.id) })
    },
  )

  server.registerTool('list_conversations', { description: 'List conversations in this project.' }, async () =>
    ok(store.listThreads(p).map((t) => ({ id: t.id, label: t.label, createdAt: t.createdAt, busy: agents.isBusy(t.id), url: threadUrl(t.id) }))),
  )

  server.registerTool('read_conversation', { description: 'Read the visible messages of a conversation.', inputSchema: { id: z.string() } }, async ({ id }) =>
    ok({
      busy: agents.isBusy(id),
      messages: store.readMessages(p, id).filter((m) => m.kind !== 'trace').map(({ kind, text, questions, ts }) => ({ kind, text, questions, ts })),
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
      processes.register(p, { pid, name, command, cwd: cwd ?? p.path, url: url ?? null, log: log ?? null, threadId: tid, startedAt: new Date().toISOString() })
      return ok({ registered: pid })
    },
  )

  server.registerTool('unregister_process', { description: 'Unregister a process after stopping it.', inputSchema: { pid: z.number().int() } }, async ({ pid }) => {
    processes.unregister(p, pid)
    return ok({ unregistered: pid })
  })

  // ---- product preview ----

  const browserTool = async (fn: () => Promise<string>) => {
    const out = await fn()
    emit({ type: 'browser', projectId: p.id, threadId: tid })
    return ok(out)
  }

  server.registerTool('open_browser', { description: 'Show a working web product in the preview beside this conversation.', inputSchema: { url: z.string().url() } }, async ({ url }) => {
    await browser.open(tid, url)
    store.updateThread(p, tid, { preview: url })
    touchThread()
    return browserTool(async () => 'Opened. Use browser_inspect to read the page.')
  })
  server.registerTool('browser_inspect', { description: 'Read the preview: visible text, controls with refs, console errors.' }, async () => browserTool(() => browser.inspect(tid)))
  server.registerTool('browser_click', { description: 'Click a control by ref from browser_inspect.', inputSchema: { ref: z.string() } }, async ({ ref }) => browserTool(() => browser.click(tid, ref)))
  server.registerTool('browser_fill', { description: 'Fill a text field or select an option by ref.', inputSchema: { ref: z.string(), value: z.string() } }, async ({ ref, value }) =>
    browserTool(() => browser.fill(tid, ref, value)),
  )
  server.registerTool('browser_press', { description: 'Press a key, e.g. Enter or Control+A.', inputSchema: { key: z.string() } }, async ({ key }) => browserTool(() => browser.press(tid, key)))
  server.registerTool('browser_scroll', { description: 'Scroll the page vertically by dy pixels.', inputSchema: { dy: z.number() } }, async ({ dy }) => browserTool(() => browser.scroll(tid, dy)))
  server.registerTool('browser_navigate', { description: 'Navigate the preview to a URL.', inputSchema: { url: z.string().url() } }, async ({ url }) => {
    store.updateThread(p, tid, { preview: url })
    return browserTool(() => browser.navigate(tid, url))
  })
  server.registerTool('browser_screenshot', { description: 'Capture the preview as an image.' }, async () => {
    const png = await browser.snapshot(tid)
    emit({ type: 'browser', projectId: p.id, threadId: tid })
    return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }] }
  })

  // ---- permission prompts (Claude Code --permission-prompt-tool) ----

  server.registerTool(
    'approve_tool',
    { description: 'Internal: asks the user to approve a tool call.', inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() } },
    async ({ tool_name, input }) => {
      const msg = agents.post(p, tid, { kind: 'approval', approval: { tool: tool_name, input, status: 'pending' } })
      store.updateThread(p, tid, { unread: true })
      touchThread()
      const allow = await new Promise<boolean>((resolve) => approvals.set(msg.id, resolve))
      return ok(allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user denied this action.' })
    },
  )

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
