import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('Overview imports without sending or losing a draft, and links routed conversations with their remote origin', { timeout: 60_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-inbox-'))
  const home = path.join(tmp, 'home')
  const port = await new Promise((resolve) => {
    const listener = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = listener.address()
      listener.close(() => resolve(port))
    })
  })
  const base = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.mjs')], {
    env: { ...process.env, SAVOR_HOME: home, SAVOR_PORT: String(port), SAVOR_USAGE_URL: '', SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs') },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const exited = new Promise((resolve) => server.on('exit', resolve))
  let browser, client
  try {
    await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
    const { token, mcpToken } = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'))
    const request = (method, url, body, cookie = `savor_token=${token}`) => fetch(`${base}/api${url}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
    })
    const kontor = await (await request('POST', '/projects', { path: path.join(tmp, 'kontor'), create: true, name: 'Kontor' })).json()
    await request('PATCH', `/projects/${kontor.id}`, { type: 'kontor', agent: { provider: 'claude' } })
    const target = await (await request('POST', '/projects', { path: path.join(tmp, 'target'), create: true, name: 'Target' })).json()
    await request('PATCH', `/projects/${target.id}`, { agent: { provider: 'claude' } })
    assert.equal((await request('POST', `/projects/${target.id}/threads`, { text: 'invalid', inbox: true })).status, 400)
    browser = await chromium.launch({ executablePath: process.env.SAVOR_CHROMIUM })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.goto(`${base}/?token=${token}#/all`)
    await page.waitForSelector('.start-anywhere textarea')
    const draft = page.locator('.start-anywhere textarea')
    await draft.fill('Existing unsent thought')
    const captured = 'Savor: prüfen & verbessern?\nKontor: Grüße + #Notiz / 🎤'
    await page.evaluate((text) => { location.hash = `/all?text=${encodeURIComponent(text)}` }, captured)
    await page.waitForFunction(() => !location.hash.includes('text='))
    const merged = `Existing unsent thought\n\n${captured}`
    assert.equal(await draft.inputValue(), merged)
    assert.equal(await page.locator('.start-anywhere .pill').textContent(), 'Start in Automatic · via Kontor ')
    assert.deepEqual(await (await request('GET', `/projects/${kontor.id}/threads`)).json(), [])
    await page.reload()
    await page.waitForSelector('.start-anywhere textarea')
    assert.equal(await draft.inputValue(), merged)
    const fresh = await browser.newPage()
    await fresh.goto(`${base}/#/all?text=${encodeURIComponent(captured)}`)
    await fresh.waitForSelector('.gate')
    assert.ok(new URL(await fresh.url()).hash.includes('text='))
    await fresh.context().addCookies([{ name: 'savor_token', value: token, url: base }])
    await fresh.reload()
    await fresh.waitForFunction(() => !location.hash.includes('text='))
    assert.equal(await fresh.locator('.start-anywhere textarea').inputValue(), captured)
    await fresh.reload()
    await fresh.waitForSelector('.start-anywhere textarea')
    assert.equal(await fresh.locator('.start-anywhere textarea').inputValue(), captured)
    await fresh.close()
    await page.click('.start-anywhere button[title="Send"]')
    await page.waitForURL(/#\/all\/inbox\//)
    const inbox = (await (await request('GET', `/projects/${kontor.id}/threads`)).json())[0]
    assert.equal(inbox.inbox, true)
    const stored = await (await request('GET', `/projects/${kontor.id}/threads/${inbox.id}`)).json()
    assert.equal(stored.messages[0].text, merged)
    await page.goto(`${base}/#/all`)
    await page.click('.start-anywhere .pill')
    await page.click('.start-anywhere .menu button:has-text("Target")')
    await page.fill('.start-anywhere textarea', 'Direct request')
    await page.keyboard.press('Enter')
    await page.waitForURL(new RegExp(`#/all/inbox/${target.id}/`))
    assert.equal((await (await request('GET', `/projects/${target.id}/threads`)).json())[0].inbox, undefined)
    await page.goto(`${base}/#/all`)
    await page.click('.start-anywhere .pill')
    await page.click('.start-anywhere .menu button:has-text("Target")')
    const kontorAgent = (await (await request('GET', '/projects')).json()).find((p) => p.id === kontor.id).agent
    await page.click('.start-anywhere .agent-btn')
    await page.click('.ap-effort button:has-text("Low")')
    await page.keyboard.press('Escape')
    await page.evaluate(() => { location.hash = '/all?text=Reimport%20from%20target' })
    await page.waitForFunction(() => !location.hash.includes('text='))
    await page.click('.start-anywhere button[title="Send"]')
    await page.waitForURL(new RegExp(`#/all/inbox/${kontor.id}/`))
    const reimported = (await (await request('GET', `/projects/${kontor.id}/threads`)).json()).find((t) => t.title === 'Reimport from target')
    assert.deepEqual(reimported.agent, kontorAgent)
    assert.deepEqual((await (await request('GET', '/projects')).json()).find((p) => p.id === kontor.id).agent, kontorAgent)

    const device = await (await request('POST', '/devices/token', { name: 'Phone' })).json()
    const cookie = `savor_device=${device.token}`
    const remote = await (await request('POST', `/projects/${kontor.id}/threads`, { text: 'context: remote entry', inbox: true }, cookie)).json()
    const until = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        const data = await predicate()
        if (data) return data
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('No agent conclusion')
    }
    const context = async (project, thread) => until(async () => {
      const data = await (await request('GET', `/projects/${project.id}/threads/${thread.id}`)).json()
      const message = data.messages.find((m) => m.text.startsWith('Context: '))
      return message && JSON.parse(message.text.slice('Context: '.length))
    })
    assert.equal((await context(kontor, remote)).requestOrigin, 'remote')
    client = new Client({ name: 'inbox-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?project=${kontor.id}&thread=${remote.id}`), { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
    const call = await client.callTool({ name: 'start_conversation', arguments: { project: target.id, prompt: 'context: routed task' } })
    assert.equal(call.isError, undefined)
    const child = JSON.parse(call.content[0].text)
    const childContext = await context(target, child)
    assert.equal(childContext.requestOrigin, 'remote')
    assert.equal(childContext.inboxSource.threadId, remote.id)
    const childData = await (await request('GET', `/projects/${target.id}/threads/${child.id}`)).json()
    assert.deepEqual([childData.messages[0].origin, childData.messages[0].device], ['remote', 'Phone'])
    const links = await (await request('GET', `/projects/${kontor.id}/threads/${remote.id}/links`)).json()
    assert.deepEqual(links.targets.map((l) => [l.project.id, l.thread.id]), [[target.id, child.id]])
    await page.goto(`${base}/#/all/inbox/${kontor.id}/${remote.id}`)
    await page.click('.routing-links a:has-text("Target")')
    await page.waitForSelector('.routing-links a:has-text("Inbox")')
    await page.click('.routing-links a:has-text("Inbox")')
    await page.waitForURL(new RegExp(remote.id))
    await request('DELETE', `/projects/${target.id}/threads/${child.id}`)
    assert.deepEqual((await (await request('GET', `/projects/${kontor.id}/threads/${remote.id}/links`)).json()).targets, [])
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  } finally {
    await client?.close()
    await browser?.close()
    server.kill()
    await exited
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
