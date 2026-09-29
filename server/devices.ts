import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import * as store from './store.js'
import type { Origin } from './store.js'

// Two kinds of credentials:
// - the owner token (printed on start). It only counts as "local" when used from this machine.
// - device tokens, handed out by redeeming a short-lived pairing code. Always "remote".

const PAIRING_TTL_MS = 10 * 60_000
const pairings = new Map<string, number>()

export interface Auth { origin: Origin; device?: store.Device }

const cookies = (req: IncomingMessage) =>
  Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]))

const loopback = (req: IncomingMessage) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')

export function authenticate(req: IncomingMessage): Auth | null {
  const c = cookies(req)
  const s = store.state()
  if (c.savor_token === s.token) return { origin: loopback(req) && !req.headers['x-forwarded-for'] ? 'local' : 'remote' }
  if (!c.savor_device) return null
  const device = s.devices.find((d) => d.tokenHash === store.hash(c.savor_device))
  if (!device) return null
  if (!device.lastSeenAt || Date.now() - Date.parse(device.lastSeenAt) > 60_000) {
    device.lastSeenAt = store.now()
    store.saveState(s)
  }
  return { origin: 'remote', device }
}

export function createPairing() {
  const code = crypto.randomBytes(5).toString('hex').toUpperCase()
  pairings.set(code, Date.now() + PAIRING_TTL_MS)
  return { code, expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString() }
}

export function redeem(code: string, name: string) {
  const expires = pairings.get(code.toUpperCase())
  pairings.delete(code.toUpperCase())
  if (!expires || expires < Date.now()) throw new Error('Pairing code invalid or expired.')
  const token = crypto.randomBytes(32).toString('hex')
  const s = store.state()
  s.devices.push({ id: store.newId(), name: name.slice(0, 60) || 'Device', tokenHash: store.hash(token), createdAt: store.now(), lastSeenAt: store.now() })
  store.saveState(s)
  return token
}

export const listDevices = () => store.state().devices.map(({ tokenHash, ...d }) => d)

export function revokeDevice(id: string) {
  const s = store.state()
  s.devices = s.devices.filter((d) => d.id !== id)
  store.saveState(s)
}
