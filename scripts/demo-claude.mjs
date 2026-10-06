#!/usr/bin/env node
// Stand-in for Claude Code that plays the scripted demo conversations of scripts/screenshots.mjs. It speaks
// the same stream-json protocol as test/fake-claude.mjs and answers through Savor's MCP tools.
// DEMO_SITE_URL is the bakery page the demo opens in the preview.
import readline from 'node:readline'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const MODEL = 'sonnet'
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('2.1.0 (Claude Code)')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, email: 'demo@savor.dev' }))
  process.exit(0)
}
// Savor's probe: models and commands for the composer.
if (!args.includes('--mcp-config')) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line)
    const answer = (response) => console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } }))
    if (msg.request?.subtype === 'get_context_usage') return answer({ skills: { skillFrontmatter: [] } })
    if (msg.request?.subtype !== 'initialize') return
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
    answer({
      models: [
        { value: 'default', displayName: 'Default (recommended)', supportedEffortLevels: efforts },
        { value: MODEL, displayName: 'Sonnet', supportedEffortLevels: efforts },
      ],
      commands: [],
    })
  })
  await new Promise(() => {})
}

const config = args[args.indexOf('--mcp-config') + 1]
const mcp = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.savor
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : (args[args.indexOf('--session-id') + 1] ?? crypto.randomUUID())
const out = (e) => process.stdout.write(JSON.stringify(e) + '\n')
const client = new Client({ name: 'demo-claude', version: '1' })
await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: mcp.headers } }))
const call = async (name, a) => {
  const r = await client.callTool({ name, arguments: a })
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`)
  return name === 'open_browser' ? null : JSON.parse(r.content[0].text)
}
const say = (text) => out({ type: 'assistant', parent_tool_use_id: null, message: { model: MODEL, usage: { input_tokens: 1200, cache_read_input_tokens: 30000 }, content: [{ type: 'text', text }] } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHECKLIST = `# Website Launch Checklist

## Domain
- [ ] Point brotzeit-bakery.de to the new host
- [ ] Redirect www to the bare domain

## SEO basics
- [ ] Title and description for every page
- [ ] Opening hours as structured data

## Google Business Profile
- [ ] Link the new website
- [ ] Update photos and opening hours
`

let started = false
async function turn(text) {
  const input = text.slice(text.indexOf('New input:\n') + 'New input:\n'.length).trim()
  if (!started) out({ type: 'system', subtype: 'init', session_id: sessionId })
  started = true
  const label = text.includes('"threadLabel":null')

  if (input.includes('launch checklist')) {
    if (label) await call('set_thread_label', { label: 'Website launch checklist' })
    await call('send_acknowledgement_message', { text: 'Writing the checklist as a document.', summary: 'Launch checklist for the new website.' })
    say('Drafting the checklist.')
    const doc = await call('create_document', { title: 'Website Launch Checklist', content: CHECKLIST })
    await call('send_conclusion_message', {
      text: `Checklist created: [Website Launch Checklist](${doc.url}). It covers domain, SEO basics, Google Business Profile and photos. Two questions:`,
      questions: [
        { title: 'What is the launch date?', body: 'Free text, e.g. a date or a week.', options: [] },
        { title: 'Should we offer online pre-orders?', body: '', options: ['Yes', 'Later', 'No'], recommended: 0 },
      ],
    })
  } else if (input.includes('landing page')) {
    if (label) await call('set_thread_label', { label: 'Brotzeit Bakery Landing Page' })
    await call('send_acknowledgement_message', { text: 'Building the page in index.html.', summary: 'Landing page for the Brotzeit bakery.' })
    say('Drafting the hero, the bestsellers and the map.')
    await call('send_conclusion_message', {
      text: 'The first draft of index.html has a hero, three bestsellers and a map placeholder. One choice before I polish it:',
      questions: [{ title: 'Which accent color?', body: '', options: ['Warm orange', 'Deep green', 'Rye brown'], recommended: 0 }],
    })
  } else if (input.includes('Warm orange')) {
    say('Warm orange it is.')
    await call('open_browser', { url: process.env.DEMO_SITE_URL })
    await call('send_conclusion_message', { text: `Warm orange (#d9792b) is the accent in index.html. The page is live at ${process.env.DEMO_SITE_URL}.` })
  } else {
    say('Enlarging the headline and reloading.')
    await sleep(300)
    await call('send_conclusion_message', {
      text: 'The hero headline is larger (up to 6rem, was 4.5rem) and the preview is reloaded.',
      suggestions: ['Replace the map placeholder with a real OpenStreetMap embed', 'Add a short story section about the bakery and a contact footer', 'Add photos of the three bestsellers'],
    })
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', modelUsage: { [MODEL]: { contextWindow: 200000 } } })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.type === 'control_request') return out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } })
  if (msg.type === 'user') turn(msg.message.content.find((c) => c.type === 'text').text)
})
rl.on('close', () => client.close().then(() => process.exit(0)))
