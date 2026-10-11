import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('shortcut tokens require local approval, send remote prompts and can be revoked', { timeout: 30_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-shortcut-'))
  const home = path.join(tmp, 'home')
  const port = await new Promise((resolve) => {
    const listener = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = listener.address()
      listener.close(() => resolve(port))
    })
  })
  const server = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.mjs')], {
    env: { ...process.env, SAVOR_HOME: home, SAVOR_PORT: String(port), SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs') },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const exited = new Promise((resolve) => server.on('exit', resolve))
  try {
    await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
    const owner = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).token
    const request = (method, url, body, cookie = `savor_token=${owner}`, headers = {}) => fetch(`http://127.0.0.1:${port}/api${url}`, {
      method, headers: { cookie, 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body),
    })
    assert.equal((await request('POST', '/devices/token', { name: 'shortcut' }, '')).status, 401)
    assert.equal((await request('POST', '/devices/token', { name: 'shortcut' }, undefined, { 'x-forwarded-for': '100.64.0.6' })).status, 403)
    assert.equal((await request('POST', '/devices/token', { name: '  ' })).status, 400)
    const pairing = await (await request('POST', '/devices/pairing')).json()
    const minted = await request('POST', '/devices/token', { name: 'Kontor shortcut' })
    assert.equal(minted.status, 200)
    assert.equal(minted.headers.get('cache-control'), 'no-store')
    const { token } = await minted.json()
    assert.match(token, /^[a-f0-9]{64}$/)
    assert.equal((await request('POST', '/pair', { code: pairing.code, name: 'late phone', check: '042137' })).status, 400)
    assert.ok(!fs.readFileSync(path.join(home, 'state.json'), 'utf8').includes(token))
    const cookie = `savor_device=${token}`
    const me = await (await request('GET', '/me', undefined, cookie)).json()
    assert.deepEqual([me.origin, me.device], ['remote', 'Kontor shortcut'])
    assert.equal((await request('POST', '/devices/token', { name: 'another' }, cookie)).status, 403)
    const project = await (await request('POST', '/projects', { path: path.join(tmp, 'project'), create: true, agent: { provider: 'claude' } })).json()
    const sent = await request('POST', `/projects/${project.id}/threads`, { text: 'dictated prompt' }, cookie)
    assert.equal(sent.status, 200)
    const thread = await sent.json()
    const url = `/projects/${project.id}/threads/${thread.id}`
    let received
    for (let i = 0; i < 100; i++) {
      received = await (await request('GET', url)).json()
      if (received.messages.some((m) => m.text === 'Echo: dictated prompt')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.deepEqual([received.messages[0].origin, received.messages[0].device], ['remote', 'Kontor shortcut'])
    assert.ok(received.messages.some((m) => m.text === 'Echo: dictated prompt'))
    const devices = await (await request('GET', '/devices')).json()
    assert.ok(!JSON.stringify(devices).includes(token))
    await request('DELETE', `/devices/${devices.find((d) => d.name === 'Kontor shortcut').id}`)
    assert.equal((await request('GET', '/me', undefined, cookie)).status, 401)
  } finally {
    server.kill()
    await exited
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
