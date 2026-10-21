// Web Push to paired devices (RFC 8030), so a phone hears about a conversation while the app is closed.
// The daemon sends straight to the browser's push service; the relay is not involved. Payloads are
// encrypted for the subscribed browser (RFC 8291). They carry the project name, a short status and the
// conversation's address, and for a question that can be answered from the notification its title and
// options, cut to 120 characters each. Requests are signed with this daemon's VAPID key (RFC 8292),
// created on first use and kept in state.json.
// A notice goes to the phones only once it stayed unseen for a while (pushDelay, questions at most a
// minute), at once when Savor shows nowhere. Seen on one device, it disappears from the others.
import crypto from 'node:crypto'
import * as store from './store.js'
import { stateOf } from './agents.js'

const SUBJECT = 'https://github.com/robinchoice/savor'
// While a page shows Savor it notifies from the event stream, and its device's push would be a double.
const PRESENCE_MS = 70_000
const ASK_DELAY_MS = 60_000
export const DEFAULT_DELAY = 5
const visible = new Map<string, { device: string | null; until: number }>() // page id → its device, visible until
const pending = new Map<string, NodeJS.Timeout>() // thread id → its push waiting to go out
const sent = new Map<string, Set<string>>() // thread id → the devices that got its push

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

export function setVisible(page: string, device: string | null, on: boolean) {
  if (on) visible.set(page, { device, until: Date.now() + PRESENCE_MS })
  else visible.delete(page)
}
const shows = (device?: string) => [...visible.values()].some((v) => v.until > Date.now() && (device === undefined || v.device === device))

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

// What the app icon counts, like the tab title: conversations blocked on the user or with something unseen.
function badge() {
  let n = 0
  for (const p of store.listProjects()) for (const t of store.listThreads(p)) if (['blocked', 'unread'].includes(stateOf(p, t))) n++
  return n
}

const cut = (s: string) => (s.length > 120 ? `${s.slice(0, 119)}…` : s)

// A pending approval without a form, or a single open question with options: answerable from the notification.
function ask(p: store.Project, tid: string) {
  const approval = store.readMessages(p, tid).filter((m) => m.approval?.status === 'pending').at(-1)
  if (approval) {
    const a = approval.approval!
    return a.fields ? null : { title: cut(a.title), options: a.options.map((o) => ({ id: o.id, label: cut(o.label) })), recommended: 0, approval: approval.id }
  }
  const open = store.listDecisions(p, tid).filter((d) => !d.resolved)
  const d = open.length === 1 && open[0].options.length ? open[0] : null
  return d && { title: cut(d.title), options: d.options.map((o, i) => ({ id: String(i), label: cut(o) })), recommended: d.recommended ?? null, decision: d.id }
}

export const delay = () => store.state().pushDelay ?? DEFAULT_DELAY

export function send(project: store.Project, threadId: string, status: string) {
  clearTimeout(pending.get(threadId))
  const notice = store.getThread(project, threadId).notice
  const fire = () => {
    pending.delete(threadId)
    const t = store.listThreads(project).find((t) => t.id === threadId)
    // Seen meanwhile, or a newer notice took its place.
    if (!t?.unread || t.notice?.at !== notice?.at) return
    const question = t.needsYou ? ask(project, threadId) : null
    const payload = JSON.stringify({ title: project.name, body: question ? question.title : status, status, tag: threadId, hash: `/p/${project.id}/t/${threadId}`, badge: badge(), ...(question && { question }) })
    for (const d of store.state().devices) {
      if (!d.push || shows(d.id)) continue
      deliver(d.id, d.push, payload)
      sent.set(threadId, (sent.get(threadId) ?? new Set()).add(d.id))
    }
  }
  const ms = !shows() ? 0 : Math.min(delay() * 60_000, notice?.type === 'ask' ? ASK_DELAY_MS : Infinity)
  if (ms) pending.set(threadId, setTimeout(fire, ms))
  else fire()
}

// The conversation was opened, read or answered somewhere: no push for it anymore, and the ones sent go away.
export function seen(threadId: string) {
  clearTimeout(pending.get(threadId))
  pending.delete(threadId)
  const devices = sent.get(threadId)
  if (!devices) return
  sent.delete(threadId)
  const payload = JSON.stringify({ dismiss: threadId, badge: badge() })
  for (const d of store.state().devices) if (d.push && devices.has(d.id)) deliver(d.id, d.push, payload)
}
