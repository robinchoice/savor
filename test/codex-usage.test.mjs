import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-codex-usage-'))
process.env.SAVOR_HOME = home
process.env.SAVOR_CODEX_BIN = path.resolve('test/fake-codex.mjs')
for (const provider of ['CLAUDE', 'OPENCODE', 'GROK', 'ANTIGRAVITY']) process.env[`SAVOR_${provider}_BIN`] = path.join(home, 'missing')
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
