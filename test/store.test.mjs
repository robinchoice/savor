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

// The store keeps parsed files in memory and checks each read against the file's mtime and size. Savor
// keeps a file only once it has been unchanged for two seconds, so these tests date their files back.
const old = (file, seconds = 60) => fs.utimesSync(file, new Date(Date.now() - seconds * 1000), new Date(Date.now() - seconds * 1000))
const threadFiles = (p, t) => ['thread.json', 'messages.jsonl'].map((f) => path.join(p.path, '.savor', 'threads', t.id, f))

test('a conversation changed outside Savor is read again', () => {
  const p = store.addProject(path.join(TMP, 'outside'))
  const t = store.createThread(p, { title: 'aaaa' })
  store.appendMessage(p, t.id, { kind: 'user', text: 'first' })
  const [threadFile, messagesFile] = threadFiles(p, t)
  old(threadFile)
  old(messagesFile)
  assert.equal(store.getThread(p, t.id).title, 'aaaa')
  assert.equal(store.listThreads(p)[0].title, 'aaaa')
  assert.equal(store.countMessages(p, t.id), 1)
  assert.equal(store.readMessages(p, t.id).length, 1)

  // Two changes within one tick of the file system's clock leave the same mtime and size.
  const tick = new Date()
  const retitle = (from, to) => {
    fs.writeFileSync(threadFile, fs.readFileSync(threadFile, 'utf8').replace(from, to))
    fs.utimesSync(threadFile, tick, tick)
  }
  retitle('aaaa', 'bbbb')
  fs.appendFileSync(messagesFile, JSON.stringify({ id: 'm2', ts: store.now(), kind: 'conclusion', text: 'second' }) + '\n')
  assert.equal(store.getThread(p, t.id).title, 'bbbb')
  assert.equal(store.listThreads(p)[0].title, 'bbbb')
  assert.equal(store.countMessages(p, t.id), 2)
  assert.deepEqual(store.readMessages(p, t.id).map((m) => m.text), ['first', 'second'])

  retitle('bbbb', 'cccc')
  assert.equal(store.getThread(p, t.id).title, 'cccc')
})

test('what a caller changes in what it read does not reach the next reader', () => {
  const p = store.addProject(path.join(TMP, 'frozen'))
  const t = store.createThread(p, { title: 'Conversation', label: 'Label' })
  store.appendMessage(p, t.id, { kind: 'user', text: 'first' })
  store.saveDecision(p, { id: 'd1', groupId: 'g', threadId: t.id, title: 'Which?', body: '', options: ['a', 'b'], selected: null, answer: null, resolved: false, createdAt: store.now() })
  store.saveProcs(p, [{ pid: 1, name: 'dev', cwd: p.path, command: 'sleep', url: null, log: null, threadId: t.id, startedAt: store.now() }])
  threadFiles(p, t).forEach((f) => old(f))
  for (let round = 0; round < 2; round++) {
    // The lists and the records' own fields are the caller's.
    const thread = store.getThread(p, t.id)
    thread.title = 'changed'
    const messages = store.readMessages(p, t.id)
    messages.pop()
    const decision = store.listDecisions(p, t.id)[0]
    decision.resolved = true
    store.listProcs(p).pop()
    // What is shared with the cache refuses the change.
    assert.throws(() => (store.readMessages(p, t.id)[0].text = 'changed'), TypeError)
    assert.throws(() => (thread.label.name = 'changed'), TypeError)
    assert.throws(() => decision.options.push('c'), TypeError)
  }
  assert.equal(store.getThread(p, t.id).title, 'Conversation')
  assert.equal(store.getThread(p, t.id).label.name, 'Label')
  assert.deepEqual(store.readMessages(p, t.id).map((m) => m.text), ['first'])
  assert.deepEqual(store.listDecisions(p, t.id).map((d) => [d.resolved, d.options]), [[false, ['a', 'b']]])
  assert.equal(store.listProcs(p).length, 1)
})

test('the decisions of a conversation follow files added, changed and removed outside Savor', () => {
  const p = store.addProject(path.join(TMP, 'decisions'))
  const dir = path.join(p.path, '.savor', 'decisions')
  const decision = (id, threadId) => ({ id, groupId: 'g', threadId, title: id, body: '', options: [], selected: null, answer: null, resolved: false, createdAt: `2026-01-0${id.slice(1)}T00:00:00.000Z` })
  const settle = () => [dir, ...fs.readdirSync(dir).map((f) => path.join(dir, f))].forEach((f) => old(f))
  const titles = (tid) => store.listDecisions(p, tid).map((d) => `${d.title}${d.resolved ? ' resolved' : ''}`)
  store.saveDecision(p, decision('d1', 'one'))
  store.saveDecision(p, decision('d2', 'two'))
  settle()
  assert.deepEqual([titles('one'), titles('two'), titles('none')], [['d1'], ['d2'], []])
  assert.deepEqual(titles('one'), ['d1'])

  fs.writeFileSync(path.join(dir, 'd3.json'), JSON.stringify(decision('d3', 'one')))
  assert.deepEqual(titles('one'), ['d1', 'd3'])
  settle()
  assert.deepEqual(titles('one'), ['d1', 'd3'])

  fs.writeFileSync(path.join(dir, 'd1.json'), JSON.stringify({ ...decision('d1', 'one'), resolved: true }))
  assert.deepEqual(titles('one'), ['d1 resolved', 'd3'])
  settle()
  fs.rmSync(path.join(dir, 'd3.json'))
  assert.deepEqual([titles('one'), titles('two')], [['d1 resolved'], ['d2']])
})
