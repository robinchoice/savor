#!/usr/bin/env node
// Stand-in for an Agent Client Protocol agent (`opencode acp`) used by the end-to-end tests. It
// finds Savor's MCP server in OPENCODE_CONFIG_CONTENT and in the session's mcpServers.
// - "approve: <anything>" → session/request_permission with Allow once / Reject, then "ACP permission: <optionId>"
// - anything else → "ACP echo: <input>"
// `--version` and `models` answer like the real CLI, so Savor lists the fake as installed.
import fs from 'node:fs'
import readline from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('9.9.9')
  process.exit(0)
}
if (args[0] === 'models') {
  console.log('fake/model\nfake/other')
  process.exit(0)
}
if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ agent: 'opencode', argv: process.argv }) + '\n')

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
  await client.callTool({ name: 'send_conclusion_message', arguments: { text } })
}

const sessionId = 'fake-acp-session'
let cancelled = false

async function prompt(params, reply) {
  cancelled = false
  const text = params.prompt.find((p) => p.type === 'text')?.text ?? ''
  const input = text.slice(text.indexOf('New input:\n') + 'New input:\n'.length).trim()
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call1', title: 'Reading files', kind: 'read', status: 'in_progress' } })
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call1', status: 'completed' } })
  let answer
  if (input.startsWith('approve:')) {
    const r = await agentRequest('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call2', title: 'Run rm -rf build', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build' } },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    })
    answer = `ACP permission: ${r.outcome.outcome === 'selected' ? r.outcome.optionId : 'cancelled'}`
  } else {
    answer = `ACP echo: ${input}`
  }
  if (cancelled) return reply({ stopReason: 'cancelled' })
  notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } } })
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
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [] })
    case 'session/new':
      mcp = msg.params.mcpServers.find((s) => s.name === 'savor')
      return reply({ sessionId, modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] } })
    case 'session/load':
      mcp = msg.params.mcpServers.find((s) => s.name === 'savor')
      return reply({ modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] } })
    case 'session/set_mode':
    case 'session/set_model':
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
