import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-codex-usage-'))
process.env.SAVOR_HOME = home
process.env.SAVOR_CODEX_BIN = path.resolve('test/fake-codex.mjs')
for (const provider of ['CLAUDE', 'OPENCODE']) process.env[`SAVOR_${provider}_BIN`] = path.join(home, 'missing')
process.env.FAKE_AGENT_LOG = path.join(home, 'agents.jsonl')
const limitsFile = process.env.FAKE_AGENT_LOG + '.codex-limits'
const { listUsage } = await import('../server/providers.ts')
const { fallbackSettings } = await import('../server/agents.ts')
after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

const write = (value) => fs.writeFileSync(limitsFile, JSON.stringify(value))
const window = (usedPercent, windowDurationMins, resetsAt) => ({ usedPercent, windowDurationMins, resetsAt })

test('Codex reads all quota buckets, retains failed probes as stale, and stops blocking after reset', async (t) => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const reset = Math.floor(now / 1000) + 180
  const main = { limitId: 'codex', primary: window(25, 300, reset), secondary: window(60, 10080, reset) }
  const other = { limitId: 'codex_other', limitName: 'Other models', primary: window(100, 10080, reset), secondary: null }
  write({ rateLimits: main, rateLimitsByLimitId: { codex: main, codex_other: other } })
  let [usage] = await listUsage(true)
  assert.equal(usage.stale, false)
  assert.deepEqual(usage.windows.map((w) => [w.label, w.percent]), [['5 hours', 25], ['Weekly', 60], ['Weekly · Other models', 100]])
  assert.ok(!(await fallbackSettings()).limited.includes('codex'))

  main.secondary.usedPercent = 100
  write({ rateLimits: main, rateLimitsByLimitId: { codex: main, codex_other: other } })
  t.mock.timers.tick(61_000)
  ;[usage] = await listUsage(true)
  assert.ok((await fallbackSettings()).limited.includes('codex'))

  write({ error: 'Quota service unavailable' })
  t.mock.timers.tick(61_000)
  const [failed] = await listUsage(true)
  assert.equal(failed.stale, true)
  assert.deepEqual(failed.windows, usage.windows)
  assert.equal((await listUsage())[0].stale, true)

  t.mock.timers.tick(61_000)
  assert.ok(!(await fallbackSettings()).limited.includes('codex'))
  assert.equal((await listUsage(true))[0].stale, true)

  const renewed = { ...main, secondary: window(2, 10080, reset + 604800) }
  write({ rateLimits: renewed })
  t.mock.timers.tick(61_000)
  ;[usage] = await listUsage(true)
  assert.equal(usage.stale, false)
  assert.deepEqual(usage.windows.map((w) => [w.label, w.percent]), [['5 hours', 25], ['Weekly', 2]])
})

test('the agents are asked for their usage every five minutes, and every minute while one of them works', async (t) => {
  // Later than the clock of the test above, which the usage remembers.
  const now = Date.now() + 3600_000
  t.mock.timers.enable({ apis: ['Date'], now })
  const used = (percent) => write({ rateLimits: { limitId: 'codex', primary: window(percent, 300, Math.floor(now / 1000) + 7200), secondary: null } })
  const shown = async (working) => (await listUsage(false, working))[0].windows[0].percent
  const shows = async (percent, working) => {
    while ((await shown(working)) !== percent) await new Promise((r) => setTimeout(r, 50))
  }
  used(10)
  assert.equal((await listUsage(true))[0].windows[0].percent, 10)

  // Nobody works: a minute later Codex is not asked again.
  used(20)
  t.mock.timers.tick(61_000)
  assert.equal(await shown(false), 10)
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(await shown(false), 10)
  // An agent works: it is.
  await shows(20, true)

  // Nobody works again: after five minutes.
  used(30)
  t.mock.timers.tick(61_000)
  assert.equal(await shown(false), 20)
  t.mock.timers.tick(4 * 60_000)
  await shows(30, false)
})
