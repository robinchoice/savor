// The agent process server/acp.ts starts for each ACP agent.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-acp-'))
process.env.SAVOR_HOME = HOME
process.env.SAVOR_GROK_BIN = path.resolve('test/fake-acp.mjs')
const { acpCommand, acpResets, grokModels, stuckOn, todoSteps } = await import('../server/acp.ts')
after(() => fs.rmSync(HOME, { recursive: true, force: true }))

test('Grok models and their effort levels come from ACP initialize without a prompt', async () => {
  assert.deepEqual(await grokModels(), [
    { id: 'fake-grok', label: 'Fake Grok', detail: 'A reasoning model', efforts: ['low', 'xhigh'] },
    { id: 'fake-grok-fast', label: 'fake-grok-fast', detail: undefined, efforts: [] },
  ])
})

test("Grok Build's Always approve mode is a flag of its agent process", () => {
  assert.deepEqual(acpCommand('grok', 'p', 't', 'default').args, ['--no-auto-update', 'agent', '--no-leader', 'stdio'])
  assert.deepEqual(acpCommand('grok', 'p', 't', 'always-approve').args, ['--no-auto-update', 'agent', '--always-approve', '--no-leader', 'stdio'])
  assert.deepEqual(acpCommand('opencode', 'p', 't', 'always-approve').args, ['acp', '--print-logs', '--log-level', 'ERROR'])
})

test("OpenCode's Full access mode allows every permission in its config", () => {
  const config = (mode) => JSON.parse(acpCommand('opencode', 'p', 't', mode).env.OPENCODE_CONFIG_CONTENT)
  assert.equal(config('full-access').permission, 'allow')
  assert.equal(config('build').permission, undefined)
})

test("OpenCode's Auto mode lets the pinned review plugin answer what is set to ask", () => {
  const config = (mode) => JSON.parse(acpCommand('opencode', 'p', 't', mode).env.OPENCODE_CONFIG_CONTENT)
  const auto = config('auto')
  assert.match(auto.plugin[0], /^opencode-auto-permissions@\d+\.\d+\.\d+$/)
  assert.equal(Object.keys(auto.permission.bash)[0], '*')
  assert.equal(auto.permission.bash['rm *'], 'ask')
  assert.equal(auto.permission.external_directory, 'ask')
  assert.equal(config('build').plugin, undefined)
})

test("a usage limit resets at the end of the usage period Grok Build's _x.ai/billing reports", () => {
  const now = Date.parse('2026-10-21T12:00:00Z')
  // As Grok Build 1.0.62 answers on the free tier.
  const billing = { config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-15T00:00:00+00:00', end: '2026-10-22T00:00:00+00:00' }, billingPeriodEnd: '2026-10-22T00:00:00+00:00' }, subscription_tier: 'Free' }
  assert.equal(acpResets(billing, now), Date.parse('2026-10-22T00:00:00Z'))
  assert.equal(acpResets({ config: { ...billing.config, creditUsagePercent: 100 } }, now), Date.parse('2026-10-22T00:00:00Z'))
  // Credit left, a period that is over, or no billing at all: no time to wait for.
  assert.equal(acpResets({ config: { ...billing.config, creditUsagePercent: 40 } }, now), null)
  assert.equal(acpResets(billing, Date.parse('2026-10-23T00:00:00Z')), null)
  assert.equal(acpResets(null, now), null)
})

test('OpenCode 1.x reports a usage limit only in its log, which Savor reads for its own session', () => {
  const line = 'timestamp=2026-11-05T09:08:34.423Z level=ERROR run=f1 message="stream error" providerID=opencode modelID=big-pickle session.id=ses_a small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"'
  assert.equal(stuckOn(line, 'ses_a'), 'Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go')
  assert.equal(stuckOn(line, 'ses_ab'), null)
  assert.equal(stuckOn(line, ''), null)
  // Rate limits and other errors OpenCode retries or answers itself.
  assert.equal(stuckOn(line.replace(/error\.error=".*"/, 'error.error="AI_APICallError: Rate limit exceeded"'), 'ses_a'), null)
  assert.equal(stuckOn(line.replace('stream error', 'process'), 'ses_a'), null)
})

test("OpenCode's todowrite tool calls carry the todo list as their raw input, in every form ACP allows", () => {
  // A JSON string, as the raw input the model produced, and an object, as a parsed tool input.
  assert.deepEqual(todoSteps('{"todos":[{"content":"Read the code","status":"completed"},{"content":"Change it","status":"in_progress"},{"content":"Test it","status":"pending"}]}'), [
    { text: 'Read the code', status: 'done' },
    { text: 'Change it', status: 'active' },
    { text: 'Test it', status: 'pending' },
  ])
  assert.deepEqual(todoSteps({ todos: [{ content: 'Only a text' }] }), [{ text: 'Only a text', status: 'pending' }])
  // Other tools' inputs, with or without a todos field, are no todo list.
  assert.equal(todoSteps({ command: 'ls -la' }), null)
  assert.equal(todoSteps({ todos: [{ content: 'Read', status: 'done' }, { note: 'no content' }] }), null)
  assert.equal(todoSteps({ todos: [] }), null)
  assert.equal(todoSteps('not json'), null)
  assert.equal(todoSteps(null), null)
})
