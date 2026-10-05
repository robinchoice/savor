#!/usr/bin/env node
// Stand-in for `codex app-server` used by the end-to-end tests: JSON-RPC over stdio with the v2
// methods Savor uses. It reaches Savor's MCP server through the -c mcp_servers.savor.* options (the
// bearer token comes from the environment variable they name).
// - "approve: <anything>" → item/commandExecution/requestApproval, then "Codex permission: <decision>"
// - "ask-native: <question>" → item/tool/requestUserInput with the options Red/Blue, then "Codex answered: <label>"
// - a skill item in the input → "Codex skill: <name> from <path>"
// - anything else → "Codex echo: <input>"
import fs from 'node:fs'
import readline from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('codex-cli 9.9.9')
  process.exit(0)
}
if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ agent: 'codex', argv: process.argv }) + '\n')
const config = Object.fromEntries(args.filter((_, i) => args[i - 1] === '-c').map((a) => [a.slice(0, a.indexOf('=')), JSON.parse(a.slice(a.indexOf('=') + 1))]))
const mcpUrl = config['mcp_servers.savor.url']
const token = process.env[config['mcp_servers.savor.bearer_token_env_var']]

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const notify = (method, params) => out({ jsonrpc: '2.0', method, params })
let nextId = 1000
const waiting = new Map()
const serverRequest = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    out({ jsonrpc: '2.0', id, method, params })
  })

let client = null
async function conclude(text) {
  if (!mcpUrl) return
  client ??= await (async () => {
    const c = new Client({ name: 'fake-codex', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    return c
  })()
  await client.callTool({ name: 'send_conclusion_message', arguments: { text } })
}

let threadId = 'fake-codex-thread'
let turnId = null

async function runTurn(params) {
  const text = params.input.find((i) => i.type === 'text')?.text ?? ''
  const input = text.slice(text.indexOf('New input:\n') + 'New input:\n'.length).trim()
  const turn = { id: `turn-${nextId++}`, items: [], status: 'inProgress', error: null }
  turnId = turn.id
  notify('turn/started', { threadId, turn })
  const last = { totalTokens: 51200, inputTokens: 50000, cachedInputTokens: 40000, cacheWriteInputTokens: 0, outputTokens: 1200, reasoningOutputTokens: 0 }
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: last, last, modelContextWindow: 256000 } })
  notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd1', command: 'echo hi', cwd: '.', status: 'inProgress' } })
  notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd1', command: 'echo hi', cwd: '.', status: 'completed' } })
  const skill = params.input.find((i) => i.type === 'skill')
  let reply
  if (skill) {
    reply = `Codex skill: ${skill.name} from ${skill.path}`
  } else if (input.startsWith('approve:')) {
    const { decision } = await serverRequest('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'cmd2', command: 'rm -rf build', cwd: '.', startedAtMs: Date.now() })
    reply = `Codex permission: ${decision}`
  } else if (input.startsWith('ask-native:')) {
    const question = input.slice('ask-native:'.length).trim()
    const { answers } = await serverRequest('item/tool/requestUserInput', {
      threadId,
      turnId,
      itemId: 'q1',
      isBlocking: true,
      questions: [{ id: 'color', header: 'Color', question, isOther: false, isSecret: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }],
    })
    reply = `Codex answered: ${answers.color.answers[0]}`
  } else {
    reply = `Codex echo: ${input}`
  }
  if (turnId !== turn.id) return
  // Like the real app-server, calling an MCP tool first asks the client to approve it.
  const ok = await serverRequest('mcpServer/elicitation/request', {
    threadId,
    turnId,
    serverName: 'savor',
    mode: 'form',
    _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params: { text: reply } },
    message: 'Allow the savor MCP server to run tool "send_conclusion_message"?',
    requestedSchema: { type: 'object', properties: {} },
  })
  if (ok?.action !== 'accept') reply = `Codex MCP rejected: ${JSON.stringify(ok)}`
  await conclude(reply)
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'msg1', text: reply, phase: 'final' } })
  notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } })
  turnId = null
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id !== undefined && waiting.has(msg.id)) return waiting.get(msg.id)(msg.result)
  const reply = (result) => out({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize':
      return reply({ userAgent: 'fake-codex', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' })
    case 'initialized':
      return
    case 'account/read':
      return reply({ account: { type: 'chatgpt', email: 'fake@codex.test', planType: 'plus' }, requiresOpenaiAuth: true })
    case 'model/list':
      return reply({ data: [{ id: 'fake-model', model: 'fake-model', displayName: 'Fake model', description: 'For tests', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], isDefault: true }], nextCursor: null })
    case 'skills/list': {
      const skill = (name, enabled) => ({ name, description: `The ${name} skill`, path: `/fake/skills/${name}/SKILL.md`, scope: 'user', enabled })
      return reply({ data: [{ cwd: msg.params.cwds[0], errors: [], skills: [skill('greet', true), skill('retired', false)] }] })
    }
    case 'thread/start':
      return reply({ thread: { id: threadId }, model: msg.params.model ?? 'fake-model' })
    case 'thread/resume':
      threadId = msg.params.threadId
      return reply({ thread: { id: threadId }, model: 'fake-model' })
    case 'thread/fork':
      threadId = `fork-of-${msg.params.threadId}`
      return reply({ thread: { id: threadId }, model: 'fake-model' })
    case 'turn/start':
      runTurn(msg.params).then(() => {}, (e) => notify('error', { error: { message: e.message }, willRetry: false, threadId, turnId }))
      return reply({ turn: { id: `turn-${nextId}`, items: [], status: 'inProgress', error: null } })
    case 'turn/interrupt': {
      const id = turnId
      turnId = null
      reply({})
      return notify('turn/completed', { threadId, turn: { id, items: [], status: 'interrupted', error: null } })
    }
    default:
      return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
  }
})
rl.on('close', () => (client ? client.close() : Promise.resolve()).then(() => process.exit(0)))
