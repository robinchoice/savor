#!/usr/bin/env node
// Stand-in for an Agent Client Protocol agent (`opencode acp`) used by the end-to-end tests. It
// finds Savor's MCP server in OPENCODE_CONFIG_CONTENT and in the session's mcpServers.
// - "approve: <anything>" → session/request_permission with Allow once / Reject, then "ACP permission: <optionId>"
// - "reviewed: <anything>" → the same ask, but the tool call fails right after it, as when OpenCode's review plugin rejects it
// - "todo: <anything>" → a todowrite tool call with the todo list as its raw JSON input and a compaction, then "ACP todo: <input>"
// - "stuck: <anything>" → on a model of the providers "fake" or "free", like OpenCode 1.x at its free limit: the error goes to the
//   log on stderr and the prompt gets no answer; on other models "ACP echo: <input> (<model>)"
// - "forget: <anything>" → acknowledges and ends the turn without a conclusion; asked for it, "ACP remembered: <input>"
// - a prompt that starts with a slash command → "ACP command: <prompt>"
// - anything else → "ACP echo: <input>"
// `--version` and `models` answer like the real CLI, so Savor lists the fake as installed.
import fs from 'node:fs'
import readline from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const args = process.argv.slice(2)
const log = (entry) => process.env.FAKE_AGENT_LOG && fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ agent: 'opencode', ...entry }) + '\n')
if (args[0] === '--version' || args[0] === 'models') log({ probe: args[0] })
if (args[0] === '--version') {
  console.log('9.9.9')
  process.exit(0)
}
if (args[0] === 'models') {
  console.log(`fake/model\n${JSON.stringify({ name: 'Fake model', variants: { low: {}, high: {} } }, null, 2)}\nfake/other\n${JSON.stringify({ name: 'Other' }, null, 2)}`)
  process.exit(0)
}
if (args[0] === 'session') process.exit(0)
// Whether Savor's protocol came as an instructions file for OpenCode's system prompt.
const instructions = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}').instructions ?? []
log({ argv: process.argv, instructions: instructions.map((f) => fs.readFileSync(f, 'utf8').startsWith('You are running inside Savor')) })

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const notify = (method, params) => out({ jsonrpc: '2.0', method, params })
let nextId = 5000
const waiting = new Map()
const agentRequest = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    out({ jsonrpc: '2.0', id, method, params })
  })

let mcp = null
let client = null
async function conclude(text, tool = 'send_conclusion_message') {
  client ??= await (async () => {
    const c = new Client({ name: 'fake-acp', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: Object.fromEntries(mcp.headers.map((h) => [h.name, h.value])) } }))
    return c
  })()
  await client.callTool({ name: tool, arguments: { text, ...(tool === 'send_acknowledgement_message' && { summary: text }) } })
}

const sessionId = 'fake-acp-session'
let cancelled = false
let model = ''

async function prompt(params, reply) {
  cancelled = false
  const text = params.prompt.find((p) => p.type === 'text')?.text ?? ''
  const at = text.indexOf('New input:\n')
  const input = at < 0 ? '' : text.slice(at + 'New input:\n'.length).trim()
  // What the prompt carried of Savor's protocol: the full text on a session's first prompt and after a
  // compaction, the one-line reminder on every other one.
  if (input) log({ prompt: { input, protocol: text.startsWith('You are running inside Savor'), reminder: text.includes('Savor reminder') } })
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call1', title: 'Reading files', kind: 'read', status: 'in_progress' } })
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call1', status: 'completed' } })
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call3', title: 'ls -la', kind: 'execute', rawInput: { command: 'ls -la' } } })
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call3', status: 'completed' } })
  let answer
  if (input.startsWith('stuck:') && /^(fake|free)\//.test(model)) {
    return void process.stderr.write(`timestamp=${new Date().toISOString()} level=ERROR run=1 message="stream error" providerID=fake modelID=${model} session.id=${params.sessionId} small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go"\n`)
  } else if (input.startsWith('stuck:')) {
    answer = `ACP echo: ${input} (${model})`
  } else if (input.startsWith('forget:') && text.includes('without send_conclusion_message')) {
    answer = `ACP remembered: ${input}`
  } else if (input.startsWith('forget:')) {
    await conclude(`Working on ${input}`, 'send_acknowledgement_message')
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done, I think.' } } })
    return reply({ stopReason: 'end_turn' })
  } else if (text.startsWith('/')) {
    answer = `ACP command: ${text}`
  } else if (!input) {
    // A side question carries no Savor envelope.
    answer = `ACP aside: ${text.slice(text.lastIndexOf('Question: ') + 'Question: '.length)}`
    notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } } })
    return reply({ stopReason: 'end_turn' })
  } else if (input.startsWith('approve:') || input.startsWith('reviewed:')) {
    if (input.startsWith('reviewed:')) setTimeout(() => notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call2', status: 'failed' } }), 200)
    const r = await agentRequest('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call2', title: 'Run rm -rf build', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build' } },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    })
    answer = `ACP permission: ${r.outcome.outcome === 'selected' ? r.outcome.optionId : 'cancelled'}`
  } else if (input.startsWith('todo:')) {
    // OpenCode 1.x: the whole todo list as the raw input of a todowrite tool call, as a JSON string, and a
    // compaction that drops the protocol from the history before the turn ends.
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call5', title: 'Updating todos', kind: 'other', rawInput: JSON.stringify({ todos: [{ content: 'Read the code', status: 'completed' }, { content: 'Change it', status: 'in_progress' }, { content: 'Test it', status: 'pending' }] }) } })
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call5', status: 'completed' } })
    notify('session/update', { sessionId, update: { sessionUpdate: 'compaction_summary_chunk', content: { type: 'text', text: 'Earlier conversation summarized.' } } })
    answer = `ACP todo: ${input.slice(5).trim()}`
  } else {
    answer = `ACP echo: ${input}`
  }
  if (cancelled) return reply({ stopReason: 'cancelled' })
  notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } } })
  notify('session/update', { sessionId, update: { sessionUpdate: 'usage_update', used: 4200, size: 100000 } })
  await conclude(answer)
  reply({ stopReason: 'end_turn' })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id !== undefined && waiting.has(msg.id)) return waiting.get(msg.id)(msg.result)
  const reply = (result) => out({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { fork: {} } }, authMethods: [] })
    case 'session/new':
      mcp = msg.params.mcpServers.find((s) => s.name === 'savor')
      reply({ sessionId, modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] } })
      return notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'review changes' }] } })
    case 'session/fork':
      log({ fork: msg.params.sessionId })
      mcp = msg.params.mcpServers.find((s) => s.name === 'savor')
      return reply({ sessionId: `fork-of-${msg.params.sessionId}`, modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] } })
    case 'session/load':
      mcp = msg.params.mcpServers.find((s) => s.name === 'savor')
      return reply({ modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] } })
    case 'session/set_mode':
    case 'session/set_model':
      if (msg.method === 'session/set_model') model = msg.params.modelId
      log({ [msg.method]: msg.params.modeId ?? msg.params.modelId })
      return reply({})
    case 'session/prompt':
      return void prompt({ ...msg.params, id: msg.id }, reply)
    case 'session/cancel':
      cancelled = true
      return
    default:
      return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
  }
})
rl.on('close', () => (client ? client.close() : Promise.resolve()).then(() => process.exit(0)))
