// The agent process server/acp.ts starts for each ACP agent.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-acp-'))
process.env.SAVOR_HOME = HOME
const { acpCommand, acpResets } = await import('../server/acp.ts')
after(() => fs.rmSync(HOME, { recursive: true, force: true }))

test("Grok Build's Always approve mode is a flag of its agent process", () => {
  assert.deepEqual(acpCommand('grok', 'p', 't', 'default').args, ['--no-auto-update', 'agent', '--no-leader', 'stdio'])
  assert.deepEqual(acpCommand('grok', 'p', 't', 'always-approve').args, ['--no-auto-update', 'agent', '--always-approve', '--no-leader', 'stdio'])
  assert.deepEqual(acpCommand('opencode', 'p', 't', 'always-approve').args, ['acp'])
})

test("a usage limit resets at the end of the usage period Grok Build's _x.ai/billing reports", () => {
  const now = Date.parse('2026-10-21T12:00:00Z')
  // As Grok Build 1.0.62 answers on the free tier.
  const billing = { config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-15T00:00:00+00:00', end: '2026-10-22T00:00:00+00:00' }, billingPeriodEnd: '2026-10-22T00:00:00+00:00' }, subscription_tier: 'Free' }
  assert.equal(acpResets(billing, now), Date.parse('2026-10-22T00:00:00Z'))
  assert.equal(acpResets({ config: { ...billing.config, creditUsagePercent: 100 } }, now), Date.parse('2026-10-22T00:00:00Z'))
  // Credit left, a period that is over, or no billing at all: no time to wait for.
  assert.equal(acpResets({ config: { ...billing.config, creditUsagePercent: 40 } }, now), null)
  assert.equal(acpResets(billing, Date.parse('2026-10-23T00:00:00Z')), null)
  assert.equal(acpResets(null, now), null)
})
