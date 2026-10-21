import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudePacing, PACING_INTERVAL } from '../server/claude-pacing.ts'

const HOUR = 3600_000

test('the account queue combines projects, actual usage, spacing and FIFO order', async () => {
  let now = 10 * HOUR
  let percent = 19
  const pacing = new ClaudePacing(async () => ({ percent, resetsAt: 14 * HOUR, observedAt: now }), () => now)
  assert.ok(await pacing.admit('project-a')) // 19 > 18 after one hour
  percent = 18
  assert.ok(await pacing.admit('project-b')) // waits behind A
  assert.equal(await pacing.admit('project-a'), null)
  now += PACING_INTERVAL
  assert.ok(await pacing.admit('project-b')) // A still works
  pacing.release('project-a')
  assert.equal(await pacing.admit('project-b'), null)
  pacing.release('project-b')
  assert.ok(await pacing.admit('project-c')) // spacing also holds after quick completion
  now += PACING_INTERVAL
  assert.equal(await pacing.admit('project-c'), null)
})

test('unknown, expired, stale and invalid usage never opens the background queue', async () => {
  const now = 10 * HOUR
  let sample = null
  const pacing = new ClaudePacing(async () => sample, () => now)
  for (const value of [null, { percent: NaN }, { percent: -1 }, { percent: 101 }, { resetsAt: NaN }, { observedAt: NaN }, { resetsAt: now }, { resetsAt: now + 5 * HOUR + 1 }, { observedAt: now - 90_001 }, { observedAt: now + 1 }]) {
    sample = value === null ? null : { percent: 0, resetsAt: now + HOUR, observedAt: now, ...value }
    assert.ok(await pacing.admit('work'))
  }
  sample = { percent: 0, resetsAt: now + HOUR, observedAt: now }
  assert.equal(await pacing.admit('work'), null)
})

test('reserve holds at 90 percent and a reset needs a new valid sample', async () => {
  let now = 10 * HOUR
  let sample = { percent: 90, resetsAt: now + 1, observedAt: now }
  const pacing = new ClaudePacing(async () => sample, () => now)
  assert.ok(await pacing.admit('resume'))
  now += 2
  assert.ok(await pacing.admit('resume')) // old reset must not be treated as fresh zero
  sample = { percent: 0, resetsAt: now + 5 * HOUR, observedAt: now }
  assert.equal(await pacing.admit('resume'), null)
})

test('concurrent admissions share one slot, cancellation and interactive work are respected', async () => {
  let now = 10 * HOUR
  let resolve
  const sample = new Promise((r) => { resolve = r })
  const pacing = new ClaudePacing(() => sample, () => now)
  const cancelled = pacing.admit('stopped')
  const a = pacing.admit('a')
  const b = pacing.admit('b')
  pacing.cancel('stopped')
  resolve({ percent: 0, resetsAt: now + HOUR, observedAt: now })
  assert.ok(await cancelled)
  assert.equal(await a, null)
  assert.ok(await b)
  pacing.release('a')
  now += PACING_INTERVAL
  pacing.running('human')
  assert.ok(await pacing.admit('b'))
  pacing.release('human')
  assert.equal(await pacing.admit('b'), null)
})
