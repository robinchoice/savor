import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright-core'

test('the preview recreates closed profiles and preserves each project login', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-browser-'))
  process.env.SAVOR_HOME = home
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
    fs.rmSync(home, { recursive: true, force: true })
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
