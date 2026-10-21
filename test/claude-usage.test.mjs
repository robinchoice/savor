import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('a failed Usage probe cannot refresh a retained sample or manufacture a reset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-claude-usage-'))
  process.env.SAVOR_HOME = path.join(dir, 'home')
  process.env.SAVOR_CLAUDE_BIN = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
  process.env.FAKE_AGENT_LOG = path.join(dir, 'agents.jsonl')
  const file = process.env.FAKE_AGENT_LOG + '.limits'
  const realNow = Date.now
  let now = realNow()
  try {
    Date.now = () => now
    const { claudeBudgetUsage } = await import('../server/providers.ts')
    const reset = now + 5 * 3600_000
    fs.writeFileSync(file, JSON.stringify([{ group: 'session', percent: 12, resets_at: new Date(reset).toISOString() }]))
    const first = await claudeBudgetUsage()
    assert.deepEqual(first, { percent: 12, resetsAt: reset, observedAt: now })
    fs.writeFileSync(file, '[]')
    now += 120_000
    assert.deepEqual(await claudeBudgetUsage(), first)
    fs.writeFileSync(file, JSON.stringify([{ group: 'session', percent: 100, resets_at: new Date(now - 1).toISOString() }]))
    now += 60_000
    assert.equal((await claudeBudgetUsage()).percent, 100)
    assert.ok((await claudeBudgetUsage()).resetsAt < now)
    fs.writeFileSync(file, JSON.stringify([{ group: 'weekly', percent: 12, resets_at: new Date(reset).toISOString() }]))
    now += 60_000
    assert.equal(await claudeBudgetUsage(), null)
  } finally {
    Date.now = realNow
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
