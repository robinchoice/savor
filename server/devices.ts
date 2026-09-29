import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import * as store from './store.js'
import type { Origin } from './store.js'

// Three kinds of credentials:
// - the owner token (printed on start). It only counts as "local" when used from this machine.
// - device tokens, handed out by redeeming a short-lived pairing code on the LAN. Always "remote".
// - device keys, registered by pairing through the relay. The relay tunnel forwards their requests
//   to this server with the internal relay token. Always "remote".

const PAIRING_TTL_MS = 10 * 60_000
const MAX_FAILED_PAIRINGS = 10
const pairings = new Map<string, number>()
let failedPairings = 0

export interface Auth { origin: Origin; device?: store.Device }

const cookies = (req: IncomingMessage) =>
  Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]))

const loopback = (req: IncomingMessage) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')

function seen(s: ReturnType<typeof store.state>, device: store.Device) {
  if (device.lastSeenAt && Date.now() - Date.parse(device.lastSeenAt) < 60_000) return
  device.lastSeenAt = store.now()
  store.saveState(s)
}

export function authenticate(req: IncomingMessage): Auth | null {
  const c = cookies(req)
  const s = store.state()
  if (store.safeEqual(c.savor_token, s.token)) return { origin: loopback(req) && !req.headers['x-forwarded-for'] ? 'local' : 'remote' }
  if (store.safeEqual(req.headers['x-savor-relay'], s.relayToken) && loopback(req)) {
    const device = s.devices.find((d) => d.publicKey && d.id === req.headers['x-savor-device'])
    if (!device) return null
    seen(s, device)
    return { origin: 'remote', device }
  }
  if (!c.savor_device) return null
  const given = store.hash(c.savor_device)
  const device = s.devices.find((d) => d.tokenHash && store.sameHash(d.tokenHash, given))
  if (!device) return null
  seen(s, device)
  return { origin: 'remote', device }
}

export function createPairing() {
  const code = crypto.randomBytes(5).toString('hex').toUpperCase()
  pairings.set(code, Date.now() + PAIRING_TTL_MS)
  return { code, expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString() }
}

function takeCode(code: string) {
  const expires = pairings.get(code.toUpperCase())
  pairings.delete(code.toUpperCase())
  if (!expires || expires < Date.now()) throw new Error('Pairing code invalid or expired.')
}

function addDevice(device: Omit<store.Device, 'id' | 'createdAt' | 'lastSeenAt'>) {
  const s = store.state()
  const d = { id: store.newId(), ...device, name: device.name.slice(0, 60) || 'Device', createdAt: store.now(), lastSeenAt: store.now() }
  s.devices.push(d)
  store.saveState(s)
  return d
}

export function redeem(code: string, name: string) {
  takeCode(code)
  const token = crypto.randomBytes(32).toString('hex')
  addDevice({ name, tokenHash: store.hash(token) })
  return token
}

// ---- pairing through the relay ----

export const openPairingCodes = () => [...pairings].filter(([, expires]) => expires > Date.now()).map(([code]) => code)

export function redeemWithKey(code: string, name: string, publicKey: string) {
  takeCode(code)
  failedPairings = 0
  return addDevice({ name, tokenHash: '', publicKey })
}

// Guessing codes through the relay gets a handful of tries, then every open code is void.
export function pairingFailed() {
  if (++failedPairings < MAX_FAILED_PAIRINGS) return
  pairings.clear()
  failedPairings = 0
}

export const deviceByKey = (publicKey: string) => store.state().devices.find((d) => d.publicKey === publicKey)
export const deviceById = (id: string) => store.state().devices.find((d) => d.id === id)

export const listDevices = () => store.state().devices.map(({ tokenHash, publicKey, ...d }) => ({ ...d, via: publicKey ? 'relay' : 'lan' }))

export function revokeDevice(id: string) {
  const s = store.state()
  s.devices = s.devices.filter((d) => d.id !== id)
  store.saveState(s)
}
