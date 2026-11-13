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
// A paired device marked `approver` at this computer can open codes too and answer the requests they
// bring in. A device it allows gets in only for a while, without the terminal, and can't let others in.

const PAIRING_TTL_MS = 10 * 60_000
const APPROVAL_MS = Number(process.env.SAVOR_PAIRING_APPROVAL_MS ?? 2 * 60_000)
const MAX_FAILED_PAIRINGS = 10
const pairings = new Map<string, { expires: number; by?: string }>() // code → expiry and the approver that opened it
let failedPairings = 0
// Only for the demo instance Apple's beta review pairs with: a fixed code that never runs out and lets
// every device in without asking. Never set it on a computer with real work on it.
const DEMO_CODE = process.env.SAVOR_DEMO_PAIRING?.toUpperCase()

// A Savor Cloud instance has no one at the computer to allow the first device. cloud/new-instance.sh puts a
// setup code in state.json and its link in Robin's vault; Savor never prints or logs it. With SAVOR_SETUP set
// and no owner device yet, the device that pairs with it comes in without asking and becomes the owner, with the
// rights of this computer. The code works once, until the expiry new-instance.sh gave it, and is too long to
// guess, so failed pairings don't void it.
const ownerPaired = (s: ReturnType<typeof store.state>) => s.devices.some((d) => d.owner)

export function openSetupCode() {
  const s = store.state()
  if (!process.env.SAVOR_SETUP || ownerPaired(s) || !s.setupCode || s.setupCode.expires <= Date.now()) return null
  return s.setupCode.code
}

// Why a setup link no longer works, for its page to say so: its device is in already, or it ran out.
export function closedSetup() {
  if (!process.env.SAVOR_SETUP || openSetupCode()) return null
  return ownerPaired(store.state()) ? 'setup used' : 'setup expired'
}

export interface PairingRequest { id: string; name: string; via: 'relay' | 'lan'; check: string; by?: string }
// What an allowed device gets: nothing extra when allowed here, a time limit when an approver allowed it.
export interface Grant { expiresAt?: string; addedBy?: string }
const requests = new Map<string, PairingRequest & { decide(grant: Grant | null): void }>()

export interface Auth { origin: Origin; device?: store.Device }

const cookies = (req: IncomingMessage) =>
  Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]))

const originOf = (device: store.Device): Origin => (device.owner ? 'local' : 'remote')

const live = (d: store.Device) => !d.expiresAt || Date.parse(d.expiresAt) > Date.now()

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
    const device = s.devices.find((d) => d.publicKey && d.id === req.headers['x-savor-device'] && live(d))
    if (!device) return null
    seen(s, device)
    return { origin: originOf(device), device }
  }
  if (!c.savor_device) return null
  const given = store.hash(c.savor_device)
  const device = s.devices.find((d) => d.tokenHash && store.sameHash(d.tokenHash, given) && live(d))
  if (!device) return null
  seen(s, device)
  return { origin: originOf(device), device }
}

export function createPairing(by?: string) {
  const code = crypto.randomBytes(5).toString('hex').toUpperCase()
  pairings.set(code, { expires: Date.now() + PAIRING_TTL_MS, ...(by && { by }) })
  return { code, expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString() }
}

function takeCode(code: string) {
  const pairing = pairings.get(code.toUpperCase())
  pairings.delete(code.toUpperCase())
  if (!pairing || pairing.expires < Date.now()) throw new Error('Pairing code invalid or expired.')
  return pairing.by
}

const deviceName = (name: string) => name.slice(0, 60) || 'Device'

// Spends the code and asks this computer, or the approver that opened the code, to let the device in.
// Resolves null when declined, when nobody answers in time or when the device gives up. Once one is
// allowed, every open code is void. The setup code is spent here too and lets its device in as the owner.
export function requestApproval(code: string, name: string, via: PairingRequest['via'], check: string) {
  if (DEMO_CODE && code.toUpperCase() === DEMO_CODE) return { approved: Promise.resolve<Grant | null>({}), cancel: () => {}, owner: false }
  const setup = openSetupCode()
  if (setup && store.safeEqual(code.toUpperCase(), setup)) {
    const s = store.state()
    delete s.setupCode
    store.saveState(s)
    return { approved: Promise.resolve<Grant | null>({}), cancel: () => {}, owner: true }
  }
  const by = takeCode(code)
  failedPairings = 0
  const id = store.newId()
  let decide!: (grant: Grant | null) => void
  const approved = new Promise<Grant | null>((resolve) => {
    const timer = setTimeout(() => decide(null), APPROVAL_MS)
    decide = (grant) => {
      if (!requests.delete(id)) return
      clearTimeout(timer)
      if (grant) pairings.clear()
      emit({ type: 'devices' })
      resolve(grant)
    }
  })
  requests.set(id, { id, name: deviceName(name), via, check, ...(by && { by }), decide })
  emit({ type: 'devices' })
  return { approved, cancel: () => decide(null), owner: false }
}

// This computer sees every request, an approver only those its own codes brought in.
export const pairingRequests = (by?: string): PairingRequest[] => [...requests.values()].filter((r) => !by || r.by === by).map(({ decide, ...r }) => r)

// `by` is the approver answering, with how long its device may stay; without one, this computer answers.
export function decidePairing(id: string, approved: boolean, by?: { id: string; expiresAt: string }) {
  const request = requests.get(id)
  if (!request || (by && request.by !== by.id)) throw new store.NotFound('pairing request')
  request.decide(approved ? (by ? { expiresAt: by.expiresAt, addedBy: by.id } : {}) : null)
}

function addDevice(device: Omit<store.Device, 'id' | 'createdAt' | 'lastSeenAt'>) {
  const s = store.state()
  const d = { id: store.newId(), ...device, name: deviceName(device.name), createdAt: store.now(), lastSeenAt: store.now() }
  s.devices.push(d)
  store.saveState(s)
  return d
}

export function addTokenDevice(name: string, owner = false, grant: Grant = {}) {
  pairings.clear()
  const token = crypto.randomBytes(32).toString('hex')
  addDevice({ name, tokenHash: store.hash(token), ...(owner && { owner }), ...grant })
  return token
}

// ---- pairing through the relay ----

export const openPairingCodes = () => [...pairings].filter(([, p]) => p.expires > Date.now()).map(([code]) => code).concat(DEMO_CODE ?? [], openSetupCode() ?? [])

// One device key serves every computer a browser pairs with, so it can pair here again. It keeps its one
// entry then, and revoking it still cuts it off. A time limit never shortens what it already had.
export function addKeyDevice(name: string, publicKey: string, owner = false, grant: Grant = {}) {
  const s = store.state()
  const known = s.devices.find((d) => d.publicKey === publicKey)
  if (!known) return addDevice({ name, tokenHash: '', publicKey, ...(owner && { owner }), ...grant })
  known.name = deviceName(name)
  if (owner) known.owner = true
  if (!grant.expiresAt) {
    delete known.expiresAt
    delete known.addedBy
  } else if (known.expiresAt) Object.assign(known, grant)
  store.saveState(s)
  return known
}

// Guessing codes through the relay gets a handful of tries, then every open code is void.
export function pairingFailed() {
  if (++failedPairings < MAX_FAILED_PAIRINGS) return
  pairings.clear()
  failedPairings = 0
}

export const deviceByKey = (publicKey: string) => store.state().devices.find((d) => d.publicKey === publicKey && live(d))
export const deviceById = (id: string) => store.state().devices.find((d) => d.id === id && live(d))
export const expiredDevices = () => store.state().devices.filter((d) => !live(d)).map((d) => d.id)

// This computer lists every device, an approver the ones it let in.
export function listDevices(by?: string) {
  const all = store.state().devices
  return all
    .filter((d) => !by || d.addedBy === by)
    .map(({ tokenHash, publicKey, push, addedBy, ...d }) => ({ ...d, via: publicKey ? 'relay' : 'lan', ...(addedBy && { addedBy: all.find((a) => a.id === addedBy)?.name ?? null }) }))
}

export function revokeDevice(id: string) {
  const s = store.state()
  s.devices = s.devices.filter((d) => d.id !== id)
  store.saveState(s)
}
