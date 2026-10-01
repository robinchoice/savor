// Properties of the tunnel crypto in shared/tunnel.ts and the tunnel path filter.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as t from '../shared/tunnel.ts'
import { tunnelPath } from '../server/relay-client.ts'

const daemon = t.keypair()
const device = t.keypair()
const fails = (fn) => assert.throws(fn)

async function session(deviceKp = device, daemonKp = daemon, registeredPk = device.pk) {
  const d = t.deviceSession(t.rawDeviceKey(deviceKp), daemon.pk)
  const s = t.daemonSession(daemonKp, registeredPk, d.hello)
  return { d, s, channel: await d.finish(s.welcome) }
}

test('session: both sides derive the same keys, messages round-trip', async () => {
  const { s, channel } = await session()
  assert.equal(s.channel.open(channel.seal({ path: '/api/me', big: 'x'.repeat(200_000) })).path, '/api/me')
  assert.equal(channel.open(s.channel.seal('pong')), 'pong')
})

test('session: the relay cannot see which device connects', () => {
  const d = t.deviceSession(t.rawDeviceKey(device), daemon.pk)
  assert.ok(!JSON.stringify(d.hello).includes(t.b64.enc(device.pk)))
  assert.deepEqual(t.openHello(daemon, d.hello), device.pk)
  fails(() => t.openHello(t.keypair(), d.hello))
})

test('session: replayed, reordered and tampered messages are rejected', async () => {
  const { d, s, channel } = await session()
  const [a, b] = [channel.seal(1), channel.seal(2)]
  fails(() => s.channel.open(b))
  fails(() => t.daemonSession(daemon, device.pk, d.hello).channel.open(a))
  const tampered = a.slice(0, -2) + (a.endsWith('A') ? 'BB' : 'AA')
  fails(() => t.daemonSession(daemon, device.pk, d.hello).channel.open(tampered))
})

test('session: an unknown device key or a fake daemon key breaks the handshake', async () => {
  await assert.rejects(session(t.keypair()))
  await assert.rejects(session(device, t.keypair()))
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
  assert.deepEqual(
    matched.map((c) => c.code),
    ['AB12CD34EF'],
  )
})

test('relay login cannot be forged without the daemon key', () => {
  const { challenge, verify } = t.relayChallenge()
  assert.ok(verify(daemon.pk, t.answerChallenge(daemon, challenge)))
  assert.ok(!verify(daemon.pk, t.answerChallenge(t.keypair(), challenge)))
  assert.ok(!verify(daemon.pk, '!!!'))
  assert.ok(!verify(daemon.pk, 42))
})

test('malformed keys from the wire are rejected, not accepted', () => {
  for (const bad of ['!!!', 'AAAA', 42, null, undefined, t.b64.enc(new Uint8Array(32))]) {
    fails(() => t.daemonSession(daemon, device.pk, { e: bad }))
  }
  fails(() => t.publicKey(t.b64.enc(new Uint8Array(31))))
})

test('the tunnel only forwards normalized /api paths, never pairing', () => {
  assert.equal(tunnelPath('/api/projects?x=1'), '/api/projects?x=1')
  for (const p of ['/api/pair', '/api/./pair', '/api/%2e/pair', '/api/../mcp', '/api/%2e%2e/mcp?project=x', '/mcp', 'api/me', '//evil/api/me', '/\\evil/api/me', 42]) {
    assert.equal(tunnelPath(p), null, String(p))
  }
})
