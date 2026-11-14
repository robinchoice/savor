// The agent process server/acp.ts starts for each ACP agent.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-acp-'))
process.env.SAVOR_HOME = HOME
const { acpCommand, stuckOn, todoSteps } = await import('../server/acp.ts')
after(() => fs.rmSync(HOME, { recursive: true, force: true }))

test('retired provider settings migrate without losing conversations or widening permissions', async () => {
  const store = await import('../server/store.ts')
  for (const provider of ['grok', 'antigravity', 'gemini']) {
    const legacy = { ...store.defaultAgent(), provider, model: 'retired-model', reasoning: 'max', permissionMode: 'bypass', fast: true, ultracode: true }
    const expected = { ...store.defaultAgent(), permissionMode: 'manual' }
    const fallback = { ...store.defaultAgent(), permissionMode: 'auto' }
    const project = store.addProject(path.join(HOME, provider))
    fs.writeFileSync(path.join(project.path, '.savor/project.json'), JSON.stringify({ ...project, agent: legacy }))
    const thread = store.createThread(project, { title: 'Earlier work', agent: legacy })
    store.updateThread(project, thread.id, { preferred: legacy, agentSessions: [{ provider, sessionId: 'old-session' }] })
    const message = store.appendMessage(project, thread.id, { kind: 'conclusion', text: 'Earlier work stays here.' })
    const workflow = store.saveWorkflow(project, { name: 'Legacy', prompt: 'Continue the work', agent: legacy })
    store.saveState({ ...store.state(), agent: legacy, presets: [{ id: 'old', name: 'Old', agent: legacy }], fallback: { on: true, agents: [fallback, legacy] } })
    assert.deepEqual(store.state().agent, expected)
    assert.deepEqual(store.listPresets()[0].agent, expected)
    assert.deepEqual(store.state().fallback.agents, [fallback])
    assert.deepEqual(store.getProject(project.id).agent, expected)
    for (const loaded of [store.getThread(project, thread.id), store.listThreads(project)[0]]) {
      assert.deepEqual(loaded.agent, expected)
      assert.equal(loaded.preferred, null)
      assert.deepEqual(loaded.agentSessions, [{ provider, sessionId: 'old-session' }])
    }
    assert.deepEqual(store.readMessages(project, thread.id), [message])
    assert.deepEqual(store.getWorkflow(project, workflow.id).agent, expected)
    assert.deepEqual(store.listWorkflows(project)[0].agent, expected)
    assert.equal(store.upgradeAgent({ ...legacy, permissionMode: 'plan' }).permissionMode, 'plan')
  }
})

test("OpenCode's Full access mode allows every permission in its config", () => {
  const config = (mode) => JSON.parse(acpCommand('p', 't', mode).env.OPENCODE_CONFIG_CONTENT)
  assert.equal(config('full-access').permission, 'allow')
  assert.equal(config('build').permission, undefined)
})

test("OpenCode takes Savor's protocol as an instructions file for its system prompt", () => {
  const config = (file) => JSON.parse(acpCommand('p', 't', 'build', file).env.OPENCODE_CONFIG_CONTENT)
  assert.deepEqual(config('/tmp/protocol.md').instructions, ['/tmp/protocol.md'])
  assert.equal(config(undefined).instructions, undefined)
})

test("OpenCode's Auto mode lets the pinned review plugin answer what is set to ask", () => {
  const config = (mode) => JSON.parse(acpCommand('p', 't', mode).env.OPENCODE_CONFIG_CONTENT)
  const auto = config('auto')
  assert.match(auto.plugin[0], /^opencode-auto-permissions@\d+\.\d+\.\d+$/)
  assert.equal(Object.keys(auto.permission.bash)[0], '*')
  assert.equal(auto.permission.bash['rm *'], 'ask')
  assert.equal(auto.permission.external_directory, 'ask')
  assert.equal(config('build').plugin, undefined)
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
