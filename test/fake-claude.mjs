#!/usr/bin/env node
// Stand-in for `claude -p --input-format stream-json` used by the end-to-end tests. It speaks the
// same stream-json protocol and answers through Savor's MCP tools:
// - "ask: <question>" → conclusion with that question and the options Yes/No
// - "approve: <anything>" → asks for permission via approve_tool, then concludes with the verdict
// - anything else → acknowledgement plus a conclusion echoing the input with one suggestion
import readline from 'node:readline'
import crypto from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const args = process.argv.slice(2)
const mcpUrl = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.savor.url
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1] ?? crypto.randomUUID()
const out = (e) => process.stdout.write(JSON.stringify(e) + '\n')

const client = new Client({ name: 'fake-claude', version: '1' })
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)))
const call = async (name, a) => JSON.parse((await client.callTool({ name, arguments: a })).content[0].text)

let started = false
for await (const line of readline.createInterface({ input: process.stdin })) {
  const text = JSON.parse(line).message.content[0].text
  const input = text.slice(text.indexOf('New input:\n') + 'New input:\n'.length).trim()
  if (!started) out({ type: 'system', subtype: 'init', session_id: sessionId })
  started = true
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } })

  if (text.includes('"threadLabel":null')) await call('set_thread_label', { label: 'Fake agent test' })
  if (input.startsWith('ask:')) {
    await call('send_conclusion_message', { text: 'One question first.', questions: [{ title: input.slice(4).trim(), body: '', options: ['Yes', 'No'] }] })
  } else if (input.startsWith('approve:')) {
    const verdict = await call('approve_tool', { tool_name: 'Bash', input: { command: 'rm -rf build' } })
    await call('send_conclusion_message', { text: `Permission: ${verdict.behavior}` })
  } else {
    await call('send_acknowledgement_message', { text: 'On it.' })
    await call('send_conclusion_message', { text: `Echo: ${input}`, suggestions: ['Do it again'] })
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
}
await client.close()
