#!/usr/bin/env node
// Stand-in for `claude -p --input-format stream-json` used by the end-to-end tests. It speaks the
// same stream-json protocol (user messages in, events and control requests out) and answers through
// Savor's MCP tools:
// - "ask: <question>" → conclusion with that question and the options Yes/No
// - "approve: <anything>" → permission prompt via a can_use_tool control request, then the verdict
// - "background: <text>" → acknowledges, registers a process it started and ends the turn without a conclusion
// - "own-background: <text>" → acknowledges, reports a background task of its own and ends the turn; once the
//   test's release file names the input, the task is done and it concludes in a turn it starts by itself
// - "own-server: <text>" → reports a background task of its own that keeps running after the conclusion
// - "native-ask: <question>" → an AskUserQuestion control request with the options Blue/Green
// - "open-page: <url>" → an MCP server asks through an elicitation control request to open that page, then "Page: <action>"
// - "recall" → concludes with the history Savor handed over in front of the input, or "nothing"
// - "context: <text>" → concludes with the Savor context it got in front of the input
// - "note: <text>" → concludes with the note Savor put between that context and the input, or "none"
// - "limit: <text>" → acknowledges, waits for the test's release file, then stops at a usage limit that reset
//   58 seconds ago ("limit-later: <text>" right away, at one that resets in an hour); continued once the limit
//   reset, it concludes
// - "ci: <text>" → acknowledges and asks Savor to watch CI for HEAD; concludes with what watch_ci returned when
//   the runs had finished or the call failed, else ends the turn, and concludes with the result Savor continues
//   the request with ("ci-done: <text>" concludes right after asking)
// - "slow: <text>" → acknowledges, waits for the test's release file or an interrupt, then echoes
//   (and says so when Savor told it that a restart cut the turn off, and names what the user added meanwhile)
// - a last text block of its own that starts with "/" → "Skill <name and arguments>", the way Claude Code runs slash commands
// - anything else → acknowledgement plus a conclusion echoing the input with one suggestion
// While the test's outdated file exists it refuses to start, like a release that lacks an option.
// `--version` and `auth status` answer like the real CLI, so Savor lists the fake as installed.
// With --no-session-persistence it answers a side question (/btw) on stdin.
// Started without an MCP config it is Savor's probe and answers the initialize request with its models and
// commands.
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
// A side question: one answer as JSON, about the session it was resumed from.
if (args.includes('--no-session-persistence')) {
  let prompt = ''
  for await (const chunk of process.stdin) prompt += chunk
  const from = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'nothing'
  console.log(JSON.stringify({ type: 'result', is_error: false, result: `Aside from ${from}${args.includes('--fork-session') ? ' (fork)' : ''}: ${prompt.slice(prompt.indexOf('Question: ') + 10)}` }))
  process.exit(0)
}
if (!args.includes('--mcp-config')) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line)
    const answer = (response) => console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } }))
    if (msg.request?.subtype !== 'initialize') return
    const models = [
      { value: 'default', displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'high'] },
      { value: 'fake-fable[1m]', displayName: 'Fable', description: 'Fake Fable', supportedEffortLevels: ['low', 'high', 'xhigh', 'max'] },
      { value: 'fake-haiku', displayName: 'Haiku' },
    ]
    const commands = [
      { name: 'greet', description: 'Say hello to someone (user)', argumentHint: '<name>' },
      { name: 'tools:lint', description: '(tools) Check the code', argumentHint: '' },
      { name: 'code-review', description: 'Review the current diff', argumentHint: '', builtin: true },
      { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '', builtin: true },
      { name: 'color', description: 'Set the prompt bar color', argumentHint: '', builtin: true },
      { name: '__remote-workflow', description: '', argumentHint: '', builtin: true },
    ]
    answer({ models, commands })
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
// A fork resumes one session and continues under the ID given for the new one.
const sessionId = args.includes('--resume') && !args.includes('--fork-session') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1] ?? crypto.randomUUID()
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
const released = async (input) => {
  const release = process.env.FAKE_AGENT_LOG + '.release'
  while (!fs.existsSync(release) || fs.readFileSync(release, 'utf8') !== input) await sleep(20)
}

let started = false
let interrupted = false
// What the user added to the running turn, as Claude Code takes it in at its next step.
let added = []

async function turn(text, command) {
  const input = command ?? text.slice(text.indexOf('New input:\n') + 'New input:\n'.length).trim()
  if (!started) out({ type: 'system', subtype: 'init', session_id: sessionId })
  started = true
  interrupted = false
  // The context holds 38,000 of the 200,000 tokens the result names; what a subagent used is not part of it.
  out({ type: 'assistant', parent_tool_use_id: null, message: { model: 'fake-fable', usage: { input_tokens: 1200, cache_read_input_tokens: 30000, cache_creation_input_tokens: 6800 }, content: [{ type: 'text', text: 'working' }] } })
  out({ type: 'assistant', parent_tool_use_id: 'toolu_subagent', message: { model: 'fake-haiku', usage: { input_tokens: 150000 }, content: [] } })

  if (text.includes('"threadLabel":null')) await call('set_thread_label', { label: 'Fake agent test' })
  if (input.startsWith('fail:')) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: input.slice(5).trim() })
    return
  } else if (input.startsWith('ask:')) {
    await call('send_conclusion_message', { text: 'One question first.', questions: [{ title: input.slice(4).trim(), body: '', options: ['Yes', 'No'], recommended: 1 }] })
  } else if (input.startsWith('approve:')) {
    const verdict = await control({
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'rm -rf build' },
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }], behavior: 'allow', destination: 'localSettings' }],
      tool_use_id: 'toolu_fake',
    })
    await call('send_conclusion_message', { text: `Permission: ${verdict.behavior}${verdict.updatedPermissions?.length ? ' always' : ''}` })
  } else if (input.startsWith('background:')) {
    await call('send_acknowledgement_message', { text: 'On it.', summary: 'Work on the request.' })
    const job = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { detached: true, stdio: 'ignore' })
    job.unref()
    await call('register_process', { pid: job.pid, name: input.slice('background:'.length).trim(), command: 'node -e …' })
  } else if (input.startsWith('own-background:') || input.startsWith('own-server:')) {
    await call('send_acknowledgement_message', { text: 'On it.', summary: 'Work on the request.' })
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: input }] })
    if (input.startsWith('own-server:')) await call('send_conclusion_message', { text: `Echo: ${input}` })
    else
      released(input).then(async () => {
        out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
        out({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' })
        await call('send_conclusion_message', { text: `Echo: ${input}` })
        out({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
      })
  } else if (input.startsWith('native-ask:')) {
    const question = input.slice('native-ask:'.length).trim()
    const verdict = await control({
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: { questions: [{ question, header: 'Pick', options: [{ label: 'Blue', description: '' }, { label: 'Green', description: '' }], multiSelect: false }] },
      tool_use_id: 'toolu_ask',
    })
    await call('send_conclusion_message', { text: `Answered: ${verdict.updatedInput?.answers?.[question] ?? verdict.behavior}` })
  } else if (input.startsWith('open-page:')) {
    const verdict = await control({ subtype: 'elicitation', mcp_server_name: 'docs', message: 'Sign in to Docs.', mode: 'url', url: input.slice('open-page:'.length).trim(), elicitation_id: 'e1' })
    await call('send_conclusion_message', { text: `Page: ${verdict?.action ?? 'refused'}` })
  } else if (input.startsWith('recall')) {
    const handed = text.includes('Earlier in this conversation')
    await call('send_conclusion_message', { text: `Handed over: ${handed ? text.slice(0, text.indexOf('Savor context:')).trim() : 'nothing'}` })
  } else if (input.startsWith('context:')) {
    await call('send_conclusion_message', { text: `Context: ${text.match(/Savor context:\n(.*)\n/)[1]}` })
  } else if (input.startsWith('limit:') || input.startsWith('limit-later:')) {
    if (text.includes('You stopped at a usage limit')) {
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })
      await call('send_conclusion_message', { text: `Echo: ${input} (after the limit)` })
    } else {
      await call('send_acknowledgement_message', { text: 'On it.', summary: 'Work on the request.' })
      if (input.startsWith('limit:')) await released(input)
      const resetsAt = Math.floor(Date.now() / 1000) + (input.startsWith('limit:') ? -58 : 3600)
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } })
      out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm" })
      return
    }
  } else if (input.startsWith('ci:') || input.startsWith('ci-done:')) {
    const finished = text.match(/The CI runs you asked Savor to watch have finished\.\n([\s\S]*?)\n\nThis is still the same request/)
    if (finished) await call('send_conclusion_message', { text: `After CI: ${finished[1]}` })
    else {
      await call('send_acknowledgement_message', { text: 'Pushed.', summary: 'Push and check CI.' })
      const r = await client.callTool({ name: 'watch_ci', arguments: {} })
      const said = r.content[0].text
      if (r.isError || said.startsWith('CI for ')) await call('send_conclusion_message', { text: `Watch: ${said}` })
      else if (input.startsWith('ci-done:')) await call('send_conclusion_message', { text: 'Done without waiting.' })
    }
  } else if (input.startsWith('note:')) {
    await call('send_conclusion_message', { text: `Note: ${text.match(/Savor context:\n.*\n\n([\s\S]*)New input:/)[1].trim() || 'none'}` })
  } else if (command) {
    await call('send_conclusion_message', { text: `Skill ${command.slice(1)}` })
  } else if (input.startsWith('slow:')) {
    await call('send_acknowledgement_message', { text: 'On it.', summary: 'Work on the request.' })
    const release = process.env.FAKE_AGENT_LOG + '.release'
    while (!interrupted && (!fs.existsSync(release) || fs.readFileSync(release, 'utf8') !== input)) await sleep(20)
    if (!interrupted) await call('send_conclusion_message', { text: `Echo: ${input.slice(5).trim()}${text.includes('Savor was restarted') ? ' (after a restart)' : ''}${added.length ? ` (added: ${added.join(', ')})` : ''}` })
    added = []
  } else {
    await call('send_acknowledgement_message', { text: 'On it.', summary: 'Work on the request.' })
    await call('send_conclusion_message', { text: `Echo: ${input}`, suggestions: ['Do it again'] })
  }
  // Claude Code ends an interrupted turn with an error result.
  if (interrupted) out({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: null })
  else out({ type: 'result', subtype: 'success', is_error: false, result: 'done', modelUsage: { 'fake-fable': { contextWindow: 200000 } } })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.type === 'control_response') return controls.get(msg.response.request_id)?.(msg.response.response)
  if (msg.type === 'control_request') {
    if (msg.request.subtype === 'interrupt') interrupted = true
    return out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } })
  }
  if (msg.type === 'user') {
    const texts = msg.message.content.filter((c) => c.type === 'text').map((c) => c.text)
    if (texts[0].startsWith('The user adds this to the current request while you work:\n')) return added.push(texts[0].split('\n')[1])
    turn(texts[0], texts.length > 1 && texts.at(-1).startsWith('/') ? texts.at(-1) : null)
  }
})
rl.on('close', () => client.close().then(() => process.exit(0)))
