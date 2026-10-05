// Web Push in server/push.ts: payload encryption (RFC 8291), VAPID signatures (RFC 8292), and who gets a push.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-push-'))
process.env.SAVOR_HOME = HOME
const push = await import('../server/push.ts')
const store = await import('../server/store.ts')
const devices = await import('../server/devices.ts')
after(() => fs.rmSync(HOME, { recursive: true, force: true }))

const b = (s) => Buffer.from(s, 'base64url')
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), len))

// The browser's side of RFC 8291, written independently of the sender.
function decrypt(body, uaPrivate, authSecret) {
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const ikm = hkdf(ecdh.computeSecret(asPublic), authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32)
  const decipher = crypto.createDecipheriv('aes-128-gcm', hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16), hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12))
  const record = body.subarray(21 + idlen)
  decipher.setAuthTag(record.subarray(-16))
  const plain = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()])
  assert.equal(plain.at(-1), 2)
  return plain.subarray(0, -1).toString()
}

// RFC 8291, Appendix A.
const ua = { private: b('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), public: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' }

test('the test decryptor reads the RFC 8291 example', () => {
  const body = b('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN')
  assert.equal(decrypt(body, ua.private, b(ua.auth)), 'When I grow up, I want to be a watermelon')
})

test('payloads are encrypted for the subscribed browser', () => {
  const body = push.encrypt({ endpoint: 'https://push.example/x', keys: { p256dh: ua.public, auth: ua.auth } }, '{"title":"Savor"}')
  assert.equal(decrypt(body, ua.private, b(ua.auth)), '{"title":"Savor"}')
  assert.ok(!body.includes(Buffer.from('Savor')))
})

test('pushes go to subscribed devices that are not showing Savor, signed with the VAPID key', async (t) => {
  const s = store.state()
  s.devices.push(
    { id: 'phone', name: 'Phone', tokenHash: '', publicKey: 'x', createdAt: store.now(), lastSeenAt: null },
    { id: 'tablet', name: 'Tablet', tokenHash: '', publicKey: 'y', createdAt: store.now(), lastSeenAt: null },
    { id: 'laptop', name: 'Laptop', tokenHash: '', publicKey: 'z', createdAt: store.now(), lastSeenAt: null },
  )
  store.saveState(s)
  const keys = { p256dh: ua.public, auth: ua.auth }
  push.subscribe('phone', { endpoint: 'https://fcm.example/send/phone', keys })
  push.subscribe('tablet', { endpoint: 'https://fcm.example/send/tablet', keys })
  push.setVisible('tablet', true)

  const sent = []
  let status = 201
  t.mock.method(globalThis, 'fetch', async (url, init) => (sent.push({ url, init }), new Response('', { status })))
  const project = { id: 'p1', name: 'Shop' }
  push.send(project, 't1', 'Needs your approval')
  await new Promise((r) => setImmediate(r))

  assert.deepEqual(sent.map((r) => r.url), ['https://fcm.example/send/phone'])
  const { init } = sent[0]
  assert.equal(init.headers['content-encoding'], 'aes128gcm')
  assert.deepEqual(JSON.parse(decrypt(init.body, ua.private, b(ua.auth))), { title: 'Shop', body: 'Needs your approval', tag: 't1', hash: '/p/p1/t/t1' })

  const [, jwt, k] = init.headers.authorization.match(/^vapid t=(\S+), k=(\S+)$/)
  assert.equal(k, push.publicKey())
  const [head, claims, sig] = jwt.split('.')
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b(k).subarray(1, 33).toString('base64url'), y: b(k).subarray(33).toString('base64url') }, format: 'jwk' })
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, b(sig)))
  assert.equal(JSON.parse(b(claims)).aud, 'https://fcm.example')

  // The VAPID key stays the same and is kept with the daemon's other keys.
  assert.equal(fs.statSync(path.join(HOME, 'state.json')).mode & 0o777, 0o600)
  assert.ok(store.state().vapid.d)

  // A subscription the push service no longer knows is forgotten.
  status = 410
  push.setVisible('tablet', false)
  push.send(project, 't1', 'Finished')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(sent.length, 3)
  assert.equal(devices.deviceById('phone').push, undefined)
  assert.equal(devices.deviceById('tablet').push, undefined)

  // Revoking a device removes its subscription with it.
  push.subscribe('laptop', { endpoint: 'https://fcm.example/send/laptop', keys })
  devices.revokeDevice('laptop')
  assert.ok(!JSON.stringify(store.state()).includes('send/laptop'))
})
