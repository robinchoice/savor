import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('damaged activity does not crash the next agent event or overwrite saved chats', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-activity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  process.env.SAVOR_HOME = path.join(dir, 'home')
  const store = await import('../server/store.ts')
  const { Activity } = await import('../server/session.ts')
  const project = { id: 'activity-test', path: dir, agent: store.defaultAgent() }
  const thread = store.createThread(project, { title: 'Saved conversation' })
  store.appendMessage(project, thread.id, { kind: 'user', text: 'Keep this conversation' })
  const threadDir = path.join(dir, '.savor', 'threads', thread.id)
  const file = path.join(threadDir, 'activity.jsonl')
  const messageFile = path.join(threadDir, 'messages.jsonl')
  const messages = fs.readFileSync(messageFile)
  const first = { id: 1, type: 'note', label: 'Before damage', time: store.now() }
  const last = { id: 7, type: 'note', label: 'After damage', time: store.now() }
  const finishedAt = store.now()
  const original = `${JSON.stringify(first)}\n${'\0'.repeat(380)}\n{broken\n\0${JSON.stringify(last)}\n${JSON.stringify({ id: 7, finishedAt })}\n`
  fs.writeFileSync(file, original)
  const warn = t.mock.method(console, 'warn', () => {})
  assert.deepEqual(store.readActivity(project, thread.id), [first, { ...last, finishedAt }])
  assert.equal(fs.readFileSync(file, 'utf8'), original)
  assert.equal(warn.mock.calls.length, 1)
  assert.ok(!warn.mock.calls[0].arguments[0].includes('{broken'))

  const activity = new Activity(project, thread.id, () => true)
  activity.start('tool', 'command', 'echo recovered')
  activity.finish('tool')
  activity.instant('note', 'Still running')
  const recovered = store.readActivity(project, thread.id)
  assert.deepEqual(recovered.map((event) => event.id), [1, 7, 8, 9])
  assert.ok(recovered[2].finishedAt)
  assert.equal(recovered[3].label, 'Still running')
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(original))
  assert.deepEqual(fs.readFileSync(messageFile), messages)
  assert.equal(store.getThread(project, thread.id).title, 'Saved conversation')
})

test('damaged messages, threads, workflows and decisions are skipped and kept', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-damaged-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  process.env.SAVOR_HOME = path.join(dir, 'home')
  const store = await import('../server/store.ts')
  const project = { id: 'damaged-test', path: dir, agent: store.defaultAgent() }
  const kept = store.createThread(project, { title: 'Kept' })
  const broken = store.createThread(project, { title: 'Broken' })
  store.appendMessage(project, kept.id, { kind: 'user', text: 'first' })
  const data = path.join(dir, '.savor')
  const messages = path.join(data, 'threads', kept.id, 'messages.jsonl')
  fs.appendFileSync(messages, `${'\0'.repeat(20)}\n  \n42\n{"id":"cut`)
  const thread = path.join(data, 'threads', broken.id, 'thread.json')
  fs.writeFileSync(thread, '\0'.repeat(50))
  fs.mkdirSync(path.join(data, 'workflows'), { recursive: true })
  fs.writeFileSync(path.join(data, 'workflows', 'broken.json'), '{"id":"broken","na')
  fs.mkdirSync(path.join(data, 'decisions'), { recursive: true })
  fs.writeFileSync(path.join(data, 'decisions', 'broken.json'), 'null')
  t.mock.method(console, 'warn', () => {})

  assert.deepEqual(store.readMessages(project, kept.id).map((m) => m.text), ['first'])
  // The next message starts on a line of its own.
  store.appendMessage(project, kept.id, { kind: 'user', text: 'second' })
  assert.deepEqual(store.readMessages(project, kept.id).map((m) => m.text), ['first', 'second'])
  assert.deepEqual(store.listThreads(project).map((x) => x.title), ['Kept'])
  assert.equal(fs.readFileSync(`${thread}.damaged`, 'utf8'), '\0'.repeat(50))
  assert.deepEqual(store.listWorkflows(project), [])
  assert.deepEqual(store.listDecisions(project), [])
})
