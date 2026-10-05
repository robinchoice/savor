// Web Push to paired devices (RFC 8030), so a phone hears about a conversation while the app is closed.
// The daemon sends straight to the browser's push service; the relay is not involved. Payloads are
// encrypted for the subscribed browser (RFC 8291) and only carry the project name, a short status and
// the conversation's address, never conversation content. Requests are signed with this daemon's
// VAPID key (RFC 8292), created on first use and kept in state.json.
import crypto from 'node:crypto'
import * as store from './store.js'

const SUBJECT = 'https://github.com/robinchoice/savor'
// While a device shows Savor, its page notifies from the event stream and the push would be a double.
const PRESENCE_MS = 70_000
const visible = new Map<string, number>() // device id → visible until

function vapid() {
  const s = store.state()
  if (!s.vapid) {
    s.vapid = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
    store.saveState(s)
  }
  const jwk = s.vapid
  return { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url') }
}

export const publicKey = () => vapid().publicKey

export function subscribe(deviceId: string, sub: store.PushSubscription | null) {
  const s = store.state()
  const device = s.devices.find((d) => d.id === deviceId)
  if (!device) return
  device.push = sub ?? undefined
  store.saveState(s)
}

export function setVisible(deviceId: string, on: boolean) {
  if (on) visible.set(deviceId, Date.now() + PRESENCE_MS)
  else visible.delete(deviceId)
}

// aes128gcm content encoding for one record (RFC 8188, keys from RFC 8291).
export function encrypt(sub: store.PushSubscription, payload: string) {
  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url')
  const ecdh = crypto.createECDH('prime256v1')
  const asPublic = ecdh.generateKeys()
  const salt = crypto.randomBytes(16)
  const hkdf = (ikm: Buffer, s: Buffer, info: Buffer, len: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len))
  const ikm = hkdf(ecdh.computeSecret(uaPublic), Buffer.from(sub.keys.auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32)
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header)
  header.writeUInt32BE(4096, 16)
  header[20] = asPublic.length
  return Buffer.concat([header, asPublic, body])
}

function authorization(endpoint: string) {
  const { key, publicKey } = vapid()
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })}`
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `vapid t=${unsigned}.${signature}, k=${publicKey}`
}

async function deliver(deviceId: string, sub: store.PushSubscription, payload: string) {
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { authorization: authorization(sub.endpoint), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high' },
      body: encrypt(sub, payload),
    })
    // The browser dropped the subscription: forget it.
    if (r.status === 404 || r.status === 410) subscribe(deviceId, null)
    else if (!r.ok) console.error(`push to ${new URL(sub.endpoint).host} failed: ${r.status} ${await r.text()}`)
  } catch (e) {
    console.error('push failed:', (e as Error).message)
  }
}

export function send(project: store.Project, threadId: string, status: string) {
  const payload = JSON.stringify({ title: project.name, body: status, tag: threadId, hash: `/p/${project.id}/t/${threadId}` })
  for (const d of store.state().devices) if (d.push && !((visible.get(d.id) ?? 0) > Date.now())) deliver(d.id, d.push, payload)
}
