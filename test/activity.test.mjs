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
