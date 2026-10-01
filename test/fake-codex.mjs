#!/usr/bin/env node
// Stand-in for `codex exec --json` used by the end-to-end tests. Like Codex it reads the prompt from
// stdin, reaches Savor's MCP server through the -c mcp_servers.savor.* options (the bearer token comes
// from the environment variable they name) and prints JSON events. It concludes with "Codex echo: <input>".
import fs from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const args = process.argv.slice(2)
const config = Object.fromEntries(args.filter((_, i) => args[i - 1] === '-c').map((a) => [a.slice(0, a.indexOf('=')), JSON.parse(a.slice(a.indexOf('=') + 1))]))
const token = process.env[config['mcp_servers.savor.bearer_token_env_var']]
if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ agent: 'codex', argv: process.argv }) + '\n')

const prompt = fs.readFileSync(0, 'utf8')
const input = prompt.slice(prompt.indexOf('New input:\n') + 'New input:\n'.length).trim()
const client = new Client({ name: 'fake-codex', version: '1' })
await client.connect(new StreamableHTTPClientTransport(new URL(config['mcp_servers.savor.url']), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
await client.callTool({ name: 'send_conclusion_message', arguments: { text: `Codex echo: ${input}` } })
await client.close()

const out = (e) => process.stdout.write(JSON.stringify(e) + '\n')
out({ type: 'thread.started', thread_id: 'fake-codex-session' })
out({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: `Codex echo: ${input}` } })
