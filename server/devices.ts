import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import * as store from './store.js'
import type { Origin } from './store.js'
import { emit } from './events.js'

// Three kinds of credentials:
// - the owner token (printed on start). It only counts as "local" when used from this machine.
// - device tokens, handed out by redeeming a short-lived pairing code on the LAN. "remote", unless owner.
// - device keys, registered by pairing through the relay. The relay tunnel forwards their requests
//   to this server with the internal relay token. "remote", unless owner (see the setup code below).
// Either way a valid code only asks: the device is added once someone allows it on this computer.
// The one exception is the setup code below.

const PAIRING_TTL_MS = 10 * 60_000
const APPROVAL_MS = Number(process.env.SAVOR_PAIRING_APPROVAL_MS ?? 2 * 60_000)
const MAX_FAILED_PAIRINGS = 10
const pairings = new Map<string, number>()
let failedPairings = 0
// Only for the demo instance Apple's beta review pairs with: a fixed code that never runs out and lets
// every device in without asking. Never set it on a computer with real work on it.
const DEMO_CODE = process.env.SAVOR_DEMO_PAIRING?.toUpperCase()

// A Savor Cloud instance has no one at the computer to allow the first device. With SAVOR_SETUP set and no
// owner device yet, each start creates a setup code and prints it. The device that pairs with it comes in
// without asking and becomes the owner, with the rights of this computer. The code works once, runs out after
// a day and is too long to guess, so failed pairings don't void it.
const SETUP_TTL_MS = Number(process.env.SAVOR_SETUP_MS ?? 24 * 60 * 60_000)
let setup: { code: string; expires: number } | null = null

export function createSetupCode() {
  if (!process.env.SAVOR_SETUP || store.state().devices.some((d) => d.owner)) return null
  setup = { code: crypto.randomBytes(16).toString('hex').toUpperCase(), expires: Date.now() + SETUP_TTL_MS }
  return setup.code
}

export const openSetupCode = () => (setup && setup.expires > Date.now() ? setup.code : null)

export interface PairingRequest { id: string; name: string; via: 'relay' | 'lan'; check: string }
const requests = new Map<string, PairingRequest & { decide(approved: boolean): void }>()

export interface Auth { origin: Origin; device?: store.Device }

const cookies = (req: IncomingMessage) =>
  Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]))

const originOf = (device: store.Device): Origin => (device.owner ? 'local' : 'remote')

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
    return { origin: originOf(device), device }
  }
  if (!c.savor_device) return null
  const given = store.hash(c.savor_device)
  const device = s.devices.find((d) => d.tokenHash && store.sameHash(d.tokenHash, given))
  if (!device) return null
  seen(s, device)
  return { origin: originOf(device), device }
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

const deviceName = (name: string) => name.slice(0, 60) || 'Device'

// Spends the code and asks this computer to let the device in. Resolves false when declined, when
// nobody answers in time or when the device gives up. Once one is allowed, every open code is void.
// The setup code is spent here too and lets its device in as the owner.
export function requestApproval(code: string, name: string, via: PairingRequest['via'], check: string) {
  if (DEMO_CODE && code.toUpperCase() === DEMO_CODE) return { approved: Promise.resolve(true), cancel: () => {}, owner: false }
  if (setup && store.safeEqual(code.toUpperCase(), setup.code)) {
    const valid = setup.expires > Date.now()
    setup = null
    if (!valid) throw new Error('Pairing code invalid or expired.')
    return { approved: Promise.resolve(true), cancel: () => {}, owner: true }
  }
  takeCode(code)
  failedPairings = 0
  const id = store.newId()
  let decide!: (approved: boolean) => void
  const approved = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => decide(false), APPROVAL_MS)
    decide = (yes) => {
      if (!requests.delete(id)) return
      clearTimeout(timer)
      if (yes) pairings.clear()
      emit({ type: 'devices' })
      resolve(yes)
    }
  })
  requests.set(id, { id, name: deviceName(name), via, check, decide })
  emit({ type: 'devices' })
  return { approved, cancel: () => decide(false), owner: false }
}

export const pairingRequests = (): PairingRequest[] => [...requests.values()].map(({ decide, ...r }) => r)

export function decidePairing(id: string, approved: boolean) {
  const request = requests.get(id)
  if (!request) throw new store.NotFound('pairing request')
  request.decide(approved)
}

function addDevice(device: Omit<store.Device, 'id' | 'createdAt' | 'lastSeenAt'>) {
  const s = store.state()
  const d = { id: store.newId(), ...device, name: deviceName(device.name), createdAt: store.now(), lastSeenAt: store.now() }
  s.devices.push(d)
  store.saveState(s)
  return d
}

export function addTokenDevice(name: string, owner = false) {
  pairings.clear()
  const token = crypto.randomBytes(32).toString('hex')
  addDevice({ name, tokenHash: store.hash(token), ...(owner && { owner }) })
  return token
}

// ---- pairing through the relay ----

export const openPairingCodes = () => [...pairings].filter(([, expires]) => expires > Date.now()).map(([code]) => code).concat(DEMO_CODE ?? [], openSetupCode() ?? [])

// One device key serves every computer a browser pairs with, so it can pair here again. It keeps its one
// entry then, and revoking it still cuts it off.
export function addKeyDevice(name: string, publicKey: string, owner = false) {
  const s = store.state()
  const known = s.devices.find((d) => d.publicKey === publicKey)
  if (!known) return addDevice({ name, tokenHash: '', publicKey, ...(owner && { owner }) })
  known.name = deviceName(name)
  if (owner) known.owner = true
  store.saveState(s)
  return known
}

// Guessing codes through the relay gets a handful of tries, then every open code is void.
export function pairingFailed() {
  if (++failedPairings < MAX_FAILED_PAIRINGS) return
  pairings.clear()
  failedPairings = 0
}

export const deviceByKey = (publicKey: string) => store.state().devices.find((d) => d.publicKey === publicKey)
export const deviceById = (id: string) => store.state().devices.find((d) => d.id === id)

export const listDevices = () => store.state().devices.map(({ tokenHash, publicKey, push, ...d }) => ({ ...d, via: publicKey ? 'relay' : 'lan' }))

export function revokeDevice(id: string) {
  const s = store.state()
  s.devices = s.devices.filter((d) => d.id !== id)
  store.saveState(s)
}
