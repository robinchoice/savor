// A change to one message rewrites the conversation's file. A write that fails halfway (a full disk,
// a hard reset) leaves the conversation as it was.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-store-'))
process.env.SAVOR_HOME = path.join(TMP, 'home')
const store = await import('../server/store.ts')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

test('regression: a rewrite of the messages that fails halfway keeps the conversation', () => {
  const p = store.addProject(path.join(TMP, 'project'))
  const t = store.createThread(p, { title: 'Conversation' })
  const first = store.appendMessage(p, t.id, { kind: 'user', text: 'first' })
  store.appendMessage(p, t.id, { kind: 'conclusion', text: 'second' })
  const write = fs.writeFileSync
  fs.writeFileSync = (target, data, ...rest) => {
    write(target, String(data).slice(0, 10), ...rest)
    throw new Error('ENOSPC')
  }
  try {
    assert.throws(() => store.updateMessage(p, t.id, first.id, { delivered: true }), /ENOSPC/)
  } finally {
    fs.writeFileSync = write
  }
  assert.deepEqual(store.readMessages(p, t.id).map((m) => m.text), ['first', 'second'])
})
