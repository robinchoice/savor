import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess, { execFileSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { chromium } from 'playwright-core'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-browser-'))
process.env.SAVOR_HOME = home
process.env.SAVOR_PREVIEW_WAIT_MS = '300'
const agent = path.join(home, 'agent.mjs')
fs.writeFileSync(agent, '#!/usr/bin/env node\nprocess.stdin.resume()\n', { mode: 0o755 })
process.env.SAVOR_CLAUDE_BIN = agent
after(() => fs.rmSync(home, { recursive: true, force: true }))

test('the preview recreates closed profiles and preserves each project login', async (t) => {
  const preview = await import('../server/browser.ts')
  const contexts = []
  const launch = chromium.launchPersistentContext.bind(chromium)
  t.mock.method(chromium, 'launchPersistentContext', async (...args) => {
    const context = await launch(...args)
    contexts.push(context)
    return context
  })
  const site = http.createServer((req, res) => res.end('<h1>Preview</h1>'))
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${site.address().port}/`
  t.after(async () => {
    await Promise.all(contexts.map((context) => context.close()))
    await new Promise((resolve) => site.close(resolve))
  })

  await preview.open('project-a', 'thread-a', url)
  const first = contexts[0]
  await first.addCookies([{ name: 'login', value: 'project-a', url, expires: Math.floor(Date.now() / 1000) + 3600 }])
  await first.pages().find((page) => page.url() === url).evaluate(() => localStorage.setItem('login', 'project-a'))
  await preview.open('project-a', 'thread-a', url)
  assert.equal(contexts.length, 1)

  await preview.open('project-b', 'thread-b', url)
  const other = contexts[1]
  assert.deepEqual(await other.cookies(url), [])

  // First closed, then crashed: Chromium of project A goes away under Savor.
  const crash = async (context) => {
    const closed = new Promise((resolve) => context.once('close', resolve))
    execFileSync('pkill', ['-KILL', '-f', path.join(home, 'browser', 'project-a')])
    await closed
  }
  let previous = first
  for (const close of [(context) => context.close(), crash]) {
    await close(previous)
    assert.equal(preview.has('thread-a'), false)
    const count = contexts.length
    await preview.open('project-a', 'thread-a', url)
    assert.equal(contexts.length, count + 1)
    const restored = (previous = contexts.at(-1))
    assert.equal((await restored.cookies(url)).find((cookie) => cookie.name === 'login')?.value, 'project-a')
    assert.equal(await restored.pages().find((page) => page.url() === url).evaluate(() => localStorage.getItem('login')), 'project-a')
    await preview.open('project-a', 'thread-a', url)
    await preview.open('project-a', 'another-thread', url)
    assert.equal(contexts.length, count + 1)
    await preview.open('project-b', 'thread-b', url)
    assert.equal(contexts.length, count + 1)
    assert.deepEqual(await other.cookies(url), [])
    assert.equal(await other.pages().find((page) => page.url() === url).evaluate(() => localStorage.getItem('login')), null)
  }
})

test('a viewer that has the latest frame waits for the next one instead of asking again at once', async (t) => {
  const preview = await import('../server/browser.ts')
  const contexts = []
  const launch = chromium.launchPersistentContext.bind(chromium)
  t.mock.method(chromium, 'launchPersistentContext', async (...args) => {
    const context = await launch(...args)
    contexts.push(context)
    return context
  })
  const site = http.createServer((req, res) => res.end('<h1>Still</h1>'))
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${site.address().port}/`
  t.after(async () => {
    await Promise.all(contexts.map((context) => context.close()))
    await new Promise((resolve) => site.close(resolve))
  })

  await preview.open('project-still', 'thread-still', url)
  let shot = await preview.snapshot('thread-still', null)
  assert.ok(shot.frame)
  // A page that stands still answers a few times a second, without an image.
  let asked = 0
  for (const end = Date.now() + 1500; Date.now() < end; asked++) {
    const next = await preview.snapshot('thread-still', shot.revision)
    assert.equal(next.frame === null, next.revision === shot.revision)
    shot = next
  }
  assert.ok(asked <= 15, `asked ${asked} times in 1.5 s`)
  // A change in the page ends the wait with its frame.
  const before = shot.revision
  const waiting = preview.snapshot('thread-still', before)
  await contexts[0].pages().find((page) => page.url() === url).evaluate(() => (document.body.style.background = 'red'))
  for (shot = await waiting; !shot.frame; ) shot = await preview.snapshot('thread-still', before)
  assert.notEqual(shot.revision, before)
})

test('regression: an unattended preview closes, keeps its login and stays open for a viewer or working agent', async (t) => {
  process.env.SAVOR_PREVIEW_IDLE_MS = '400'
  const preview = await import('../server/browser.ts?idle')
  const store = await import('../server/store.ts')
  const agents = await import('../server/agents.ts')
  const p = store.addProject(path.join(home, 'idle-project'))
  const thread = store.createThread(p, { title: 'Working', agent: p.agent })
  const contexts = []
  const launch = chromium.launchPersistentContext.bind(chromium)
  t.mock.method(chromium, 'launchPersistentContext', async (...args) => {
    const context = await launch(...args)
    contexts.push(context)
    return context
  })
  t.after(async () => {
    agents.stopAgent(p, thread.id)
    await Promise.all(contexts.map((c) => c.close()))
  })
  await preview.open(p.id, thread.id, 'about:blank')
  const first = contexts[0]
  await first.addCookies([{ name: 'login', value: 'kept', url: 'http://example.test', expires: Math.floor(Date.now() / 1000) + 3600 }])
  // Snapshot requests keep the page alive beyond its idle limit.
  let shot = await preview.snapshot(thread.id, null)
  for (const end = Date.now() + 800; Date.now() < end;) shot = await preview.snapshot(thread.id, shot.revision)
  assert.equal(preview.has(thread.id), true)
  agents.send(p, thread.id, { text: 'Wait for work', origin: 'local' })
  assert.equal(agents.isBusy(thread.id), true)
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(preview.has(thread.id), true)
  agents.stopAgent(p, thread.id)
  await first.waitForEvent('close', { timeout: 5000 })
  assert.equal(preview.has(thread.id), false)
  await preview.open(p.id, thread.id, 'about:blank')
  assert.equal(contexts.length, 2)
  assert.equal((await contexts[1].cookies('http://example.test'))[0]?.value, 'kept')
})

test('regression: a failed Chromium download is not repeated by every preview request', async (t) => {
  const preview = await import('../server/browser.ts?installation')
  const exists = fs.existsSync
  t.mock.method(fs, 'existsSync', (file) => /chrom(e|ium)/i.test(String(file)) ? false : exists(file))
  let attempts = 0
  t.mock.method(childProcess, 'spawn', () => {
    attempts++
    const child = new EventEmitter()
    setImmediate(() => child.emit('exit', 1))
    return child
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  for (let i = 0; i < 3; i++) await assert.rejects(preview.open('download-project', `thread-${i}`, 'about:blank'), /Installing Chromium/)
  assert.equal(attempts, 1)
  assert.equal(preview.previewBrowserFailed(), true)
})

test('regression: simultaneous viewers reopen one preview tab', async (t) => {
  const preview = await import('../server/browser.ts')
  const launch = chromium.launchPersistentContext.bind(chromium)
  let context, initialTabs
  t.mock.method(chromium, 'launchPersistentContext', async (...args) => {
    context = await launch(...args)
    initialTabs = context.pages().length
    return context
  })
  t.after(() => context?.close())
  await Promise.all([
    preview.open('shared-project', 'shared-thread', 'about:blank'),
    preview.open('shared-project', 'shared-thread', 'about:blank'),
  ])
  assert.equal(context.pages().length, initialTabs + 1)
})
