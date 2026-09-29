// Properties of the tunnel crypto in shared/tunnel.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as t from '../shared/tunnel.ts'

const daemon = t.keypair()
const device = t.keypair()
const fails = (fn) => assert.throws(fn)

test('session: both sides derive the same keys, messages round-trip', () => {
  const d = t.deviceSession(device, daemon.pk)
  const s = t.daemonSession(daemon, device.pk, d.hello)
  const channel = d.finish(s.welcome)
  assert.equal(s.channel.open(channel.seal({ path: '/api/me', big: 'x'.repeat(200_000) })).path, '/api/me')
  assert.equal(channel.open(s.channel.seal('pong')), 'pong')
})

test('session: replayed, reordered and tampered messages are rejected', () => {
  const d = t.deviceSession(device, daemon.pk)
  const s = t.daemonSession(daemon, device.pk, d.hello)
  const channel = d.finish(s.welcome)
  const [a, b] = [channel.seal(1), channel.seal(2)]
  fails(() => s.channel.open(b))
  const s2 = t.daemonSession(daemon, device.pk, d.hello)
  fails(() => s2.channel.open(a))
  const tampered = a.slice(0, -2) + (a.endsWith('A') ? 'BB' : 'AA')
  fails(() => t.daemonSession(daemon, device.pk, d.hello).channel.open(tampered))
})

test('session: an unknown device key or a fake daemon key breaks the handshake', () => {
  const impostor = t.deviceSession(t.keypair(), daemon.pk)
  fails(() => impostor.finish(t.daemonSession(daemon, device.pk, impostor.hello).welcome))
  const d = t.deviceSession(device, daemon.pk)
  fails(() => d.finish(t.daemonSession(t.keypair(), device.pk, d.hello).welcome))
})

test('pairing: only the right one-time code opens the channel', () => {
  const p = t.devicePairing(daemon.pk, 'ab12cd34ef')
  const dp = t.daemonPairing(daemon, p.hello, ['0000000000', 'AB12CD34EF'])
  const first = p.finish(dp.welcome).seal({ name: 'phone' })
  const matched = dp.candidates.filter(({ channel }) => {
    try {
      return channel.open(first).name === 'phone'
    } catch {
      return false
    }
  })
  assert.deepEqual(matched.map((c) => c.code), ['AB12CD34EF'])
})

test('relay login cannot be forged without the daemon key', () => {
  const { challenge, verify } = t.relayChallenge()
  assert.ok(verify(daemon.pk, t.b64.dec(t.answerChallenge(daemon, challenge))))
  assert.ok(!verify(daemon.pk, t.b64.dec(t.answerChallenge(t.keypair(), challenge))))
})
