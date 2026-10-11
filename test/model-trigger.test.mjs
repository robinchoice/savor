// Workflows with the model-change trigger: setting it only notes the model, a new model of the project's
// default agent starts one run, and a paused workflow only notes it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-model-'))
let server
after(() => {
  server?.kill()
  fs.rmSync(TMP, { recursive: true, force: true })
})

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

async function until(fn, ms = 20_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 200))
  }
}

test('a workflow runs once per new model of the project’s agent', { timeout: 90_000 }, async () => {
  const port = await freePort()
  const HOME = path.join(TMP, 'home')
  const entry = fs.existsSync(path.join(ROOT, 'dist/server/index.mjs')) ? 'dist/server/index.mjs' : 'bin/savor.js'
  server = spawn(process.execPath, [path.join(ROOT, entry)], {
    env: { ...process.env, SAVOR_HOME: HOME, SAVOR_PORT: String(port), SAVOR_CODEX_BIN: path.join(ROOT, 'test/fake-codex.mjs'), SAVOR_GH_BIN: path.join(ROOT, 'test/fake-gh.mjs'), CODEX_HOME: path.join(TMP, 'codex') },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
  const { token } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return r.json()
  }

  const project = await api('POST', '/projects', { path: path.join(TMP, 'app'), create: true })
  const pp = `/projects/${project.id}`
  const model = async () => (await api('GET', '/projects')).find((p) => p.id === project.id).model
  const turn = async (text) => {
    const t = await api('POST', `${pp}/threads`, { text })
    await until(async () => (await api('GET', `${pp}/threads/${t.id}`)).messages.some((m) => m.kind === 'conclusion'))
  }
  await api('PATCH', pp, { agent: { provider: 'codex', model: 'm1', permissionMode: 'read-only' } })
  await turn('first')
  assert.equal(await model(), 'm1')

  // Setting the trigger notes the model without a run.
  const on = await api('POST', `${pp}/workflows`, { name: 'Uplift check', prompt: 'check', onModelChange: true })
  const off = await api('POST', `${pp}/workflows`, { name: 'Paused', prompt: 'check', onModelChange: true, enabled: false })
  assert.equal(on.model, 'm1')
  await turn('same model')
  assert.deepEqual(await api('GET', `${pp}/workflows/${on.id}/runs`), [])

  await api('PATCH', pp, { agent: { model: 'm2' } })
  await turn('new model')
  const [run] = await until(async () => {
    const runs = await api('GET', `${pp}/workflows/${on.id}/runs`)
    return runs.length && runs
  })
  assert.equal(run.trigger, 'model')
  assert.equal(run.model, 'm2')
  const first = (await api('GET', `${pp}/threads/${run.threadId}`)).messages[0].text
  assert.match(first, /new model now: m2/)
  await until(async () => (await api('GET', `${pp}/workflows/${on.id}/runs`))[0].status === 'finished')
  // The paused one only notes the model, and the same model starts nothing again.
  await turn('again')
  assert.equal((await api('GET', `${pp}/workflows/${on.id}/runs`)).length, 1)
  assert.deepEqual(await api('GET', `${pp}/workflows/${off.id}/runs`), [])
  assert.equal((await api('GET', `${pp}/workflows`)).find((w) => w.id === off.id).model, 'm2')
})
