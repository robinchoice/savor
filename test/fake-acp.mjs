#!/usr/bin/env node
// Stand-in for an Agent Client Protocol agent (`opencode acp`) used by the end-to-end tests. It
// finds Savor's MCP server in OPENCODE_CONFIG_CONTENT and in the session's mcpServers.
// - "approve: <anything>" → session/request_permission with Allow once / Reject, then "ACP permission: <optionId>"
// - "plan: <anything>" → _x.ai/exit_plan_mode like Grok Build, then "ACP plan: <outcome>"
// - a prompt that starts with a slash command → "ACP command: <prompt>"
// - anything else → "ACP echo: <input>"
// Like Grok Build, it asks with session/request_permission before it calls a Savor tool.
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
log({ argv: process.argv })

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
async function conclude(text) {
  client ??= await (async () => {
    const c = new Client({ name: 'fake-acp', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: Object.fromEntries(mcp.headers.map((h) => [h.name, h.value])) } }))
    return c
  })()
  const r = await agentRequest('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 'mcp', title: 'savor__send_conclusion_message', kind: 'other', status: 'pending', rawInput: { variant: 'UseTool', tool_name: 'savor__send_conclusion_message', tool_input: { text } } },
    options: [
      { optionId: 'always-allow', name: 'always allow', kind: 'allow_always' },
      { optionId: 'allow-once', name: 'allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'reject once', kind: 'reject_once' },
    ],
  })
  log({ mcpPermission: r.outcome.optionId })
  if (r.outcome.optionId !== 'reject-once') await client.callTool({ name: 'send_conclusion_message', arguments: { text } })
}

const sessionId = 'fake-acp-session'
let cancelled = false

async function prompt(params, reply) {
  cancelled = false
  const text = params.prompt.find((p) => p.type === 'text')?.text ?? ''
  const at = text.indexOf('New input:\n')
  const input = at < 0 ? '' : text.slice(at + 'New input:\n'.length).trim()
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call1', title: 'Reading files', kind: 'read', status: 'in_progress' } })
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call1', status: 'completed' } })
  // Grok Build names only the tool in the title.
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call3', title: 'run_terminal_command', rawInput: { command: 'ls -la' }, _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute' } } } })
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call3', status: 'completed' } })
  let answer
  if (text.startsWith('/')) {
    answer = `ACP command: ${text}`
  } else if (!input) {
    // A side question carries no Savor envelope.
    answer = `ACP aside: ${text.slice(text.lastIndexOf('Question: ') + 'Question: '.length)}`
    notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } } })
    return reply({ stopReason: 'end_turn' })
  } else if (input.startsWith('approve:')) {
    const r = await agentRequest('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call2', title: 'Run rm -rf build', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build' } },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    })
    answer = `ACP permission: ${r.outcome.outcome === 'selected' ? r.outcome.optionId : 'cancelled'}`
  } else if (input.startsWith('plan:')) {
    const r = await agentRequest('_x.ai/exit_plan_mode', { sessionId, toolCallId: 'call4', planContent: '# Plan\n\nCreate hello.txt.' })
    answer = `ACP plan: ${r.outcome}`
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
      // Like Grok Build, it offers the effort as a config option and does not announce its modes.
      reply({ sessionId, configOptions: [{ id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] }] })
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
    case 'session/set_config_option':
      log({ [msg.method]: msg.params.modeId ?? msg.params.modelId ?? `${msg.params.configId}=${msg.params.value}` })
      return reply({})
    case 'session/prompt':
      return void prompt(msg.params, reply)
    case 'session/cancel':
      cancelled = true
      return
    default:
      return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
  }
})
rl.on('close', () => (client ? client.close() : Promise.resolve()).then(() => process.exit(0)))
