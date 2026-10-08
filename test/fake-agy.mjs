#!/usr/bin/env node
// Stand-in for the Antigravity CLI (`agy`) used by the end-to-end tests. A turn (`--print <prompt>` with
// stream-json output) reaches Savor's MCP server through the "savor" stdio server Savor put into
// mcp_config.json, answers "Antigravity echo: <input>" there and reports a tool step and the result.
// `--version`, `models` and the slash commands /skills and /usage answer like the real CLI.
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const args = process.argv.slice(2)
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')

if (args[0] === '--version') {
  console.log('1.3.1')
  process.exit(0)
}
if (args[0] === 'models') {
  console.log('Fetching available models...\nfake-gemini-high\tFake Gemini (High)\nfake-claude\tFake Claude')
  process.exit(0)
}
const prompt = flag('--print')
if (prompt === '/skills') {
  out({ status: 'SUCCESS', command: { name: 'skills', data: { skills: [{ name: 'fake-skill', description: 'A fake Antigravity skill' }] } } })
  process.exit(0)
}
if (prompt === '/usage') {
  const buckets = [{ id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.75, reset_time: '2030-01-01T00:00:00Z' }]
  out({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets }] } } })
  process.exit(0)
}
if (flag('--output-format') === 'json') {
  out({ status: 'SUCCESS', response: `Antigravity aside: ${prompt.slice(prompt.lastIndexOf('Question: ') + 'Question: '.length)}` })
  process.exit(0)
}
if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ agent: 'antigravity', argv: process.argv.slice(0, -1) }) + '\n')

const conversation = flag('--conversation') ?? 'fake-agy-conversation'
const input = prompt.slice(prompt.indexOf('New input:\n') + 'New input:\n'.length).trim()
const step = (i, s) => out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: i, ...s } })
out({ event: 'init', conversation_id: conversation, init: { model: flag('--model') ?? 'fake-gemini-high', cwd: process.cwd() } })
step(1, { state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } })
step(1, { state: 'DONE', step_type: 'tool', tool_name: 'run_command' })
step(2, { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 12000, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0 } })

const savor = JSON.parse(fs.readFileSync(path.join(process.env.SAVOR_ANTIGRAVITY_HOME, 'config', 'mcp_config.json'), 'utf8')).mcpServers.savor
const client = new Client({ name: 'fake-agy', version: '1' })
await client.connect(new StdioClientTransport({ command: savor.command, args: savor.args, env: process.env }))
const answer = `Antigravity echo: ${input}`
await client.callTool({ name: 'send_conclusion_message', arguments: { text: answer } })
await client.close()
out({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: answer } })
