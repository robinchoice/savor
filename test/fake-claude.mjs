#!/usr/bin/env node
// Stand-in for `claude -p --input-format stream-json` used by the end-to-end tests. It speaks the
// same stream-json protocol (user messages in, events and control requests out) and answers through
// Savor's MCP tools:
// - "ask: <question>" → conclusion with that question and the options Yes/No
// - "approve: <anything>" → permission prompt via a can_use_tool control request, then the verdict
// - "native-ask: <question>" → an AskUserQuestion control request with the options Blue/Green
// - "slow: <text>" → acknowledges, waits for the test's release file or an interrupt, then echoes
// - "background: <text>" → acknowledges, registers a process it started and ends the turn without a conclusion
// - anything else → acknowledgement plus a conclusion echoing the input with one suggestion
// While the test's outdated file exists it refuses to start, like a release that lacks an option.
// `--version` and `auth status` answer like the real CLI, so Savor lists the fake as installed.
// Started without an MCP config it is Savor's probe and answers the initialize request with its models.
import readline from 'node:readline'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('9.9.9 (Fake Claude)')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, email: 'fake@claude.test' }))
  process.exit(0)
}
if (!args.includes('--mcp-config')) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line)
    if (msg.request?.subtype !== 'initialize') return
    const models = [
      { value: 'default', displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'high'] },
      { value: 'fake-fable[1m]', displayName: 'Fable', description: 'Fake Fable', supportedEffortLevels: ['low', 'high', 'max'] },
      { value: 'fake-haiku', displayName: 'Haiku' },
    ]
    console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { models } } }))
  })
  await new Promise(() => {})
}
if (fs.existsSync(process.env.FAKE_AGENT_LOG + '.outdated')) {
  console.error("error: unknown option '--permission-prompts'")
  process.exit(1)
}
const config = args[args.indexOf('--mcp-config') + 1]
const mcp = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.savor
if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ agent: 'claude', argv: process.argv, cwd: process.cwd(), configMode: fs.statSync(config).mode & 0o777 }) + '\n')
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1] ?? crypto.randomUUID()
const out = (e) => process.stdout.write(JSON.stringify(e) + '\n')

const client = new Client({ name: 'fake-claude', version: '1' })
await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: mcp.headers } }))
const call = async (name, a) => JSON.parse((await client.callTool({ name, arguments: a })).content[0].text)

const controls = new Map() // request_id → resolve(response)
const control = (request) =>
  new Promise((resolve) => {
    const request_id = crypto.randomUUID()
    controls.set(request_id, resolve)
    out({ type: 'control_request', request_id, request })
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let started = false
let interrupted = false

async function turn(text) {
  const input = text.slice(text.indexOf('New input:\n') + 'New input:\n'.length).trim()
  if (!started) out({ type: 'system', subtype: 'init', session_id: sessionId })
  started = true
  interrupted = false
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } })

  if (text.includes('"threadLabel":null')) await call('set_thread_label', { label: 'Fake agent test' })
  if (input.startsWith('fail:')) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: input.slice(5).trim() })
    return
  } else if (input.startsWith('ask:')) {
    await call('send_conclusion_message', { text: 'One question first.', questions: [{ title: input.slice(4).trim(), body: '', options: ['Yes', 'No'] }] })
  } else if (input.startsWith('approve:')) {
    const verdict = await control({
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'rm -rf build' },
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }], behavior: 'allow', destination: 'localSettings' }],
      tool_use_id: 'toolu_fake',
    })
    await call('send_conclusion_message', { text: `Permission: ${verdict.behavior}${verdict.updatedPermissions?.length ? ' always' : ''}` })
  } else if (input.startsWith('native-ask:')) {
    const question = input.slice('native-ask:'.length).trim()
    const verdict = await control({
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: { questions: [{ question, header: 'Pick', options: [{ label: 'Blue', description: '' }, { label: 'Green', description: '' }], multiSelect: false }] },
      tool_use_id: 'toolu_ask',
    })
    await call('send_conclusion_message', { text: `Answered: ${verdict.updatedInput?.answers?.[question] ?? verdict.behavior}` })
  } else if (input.startsWith('slow:')) {
    await call('send_acknowledgement_message', { text: 'On it.' })
    const release = process.env.FAKE_AGENT_LOG + '.release'
    while (!interrupted && (!fs.existsSync(release) || fs.readFileSync(release, 'utf8') !== input)) await sleep(20)
    if (!interrupted) await call('send_conclusion_message', { text: `Echo: ${input.slice(5).trim()}` })
  } else if (input.startsWith('background:')) {
    await call('send_acknowledgement_message', { text: 'On it.' })
    const job = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { detached: true, stdio: 'ignore' })
    job.unref()
    await call('register_process', { pid: job.pid, name: input.slice('background:'.length).trim(), command: 'node -e …' })
  } else {
    await call('send_acknowledgement_message', { text: 'On it.' })
    await call('send_conclusion_message', { text: `Echo: ${input}`, suggestions: ['Do it again'] })
  }
  out({ type: 'result', subtype: interrupted ? 'success' : 'success', is_error: false, result: 'done' })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.type === 'control_response') return controls.get(msg.response.request_id)?.(msg.response.response)
  if (msg.type === 'control_request') {
    if (msg.request.subtype === 'interrupt') interrupted = true
    return out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } })
  }
  if (msg.type === 'user') turn(msg.message.content[0].text)
})
rl.on('close', () => client.close().then(() => process.exit(0)))
