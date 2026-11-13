// Devices a paired approver lets in: only through its own codes, only for a while.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.SAVOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-devices-'))
const store = await import('../server/store.ts')
const devices = await import('../server/devices.ts')

const viaRelay = (id) => ({ headers: { 'x-savor-relay': store.state().relayToken, 'x-savor-device': id }, socket: { remoteAddress: '127.0.0.1' } })
const later = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString()
const stored = (id) => store.state().devices.find((d) => d.id === id)
function expire(id) {
  const s = store.state()
  s.devices.find((d) => d.id === id).expiresAt = new Date(Date.now() - 1000).toISOString()
  store.saveState(s)
}

test('an approver answers only the requests its own codes brought in, and its devices come in for a while', async () => {
  const phone = devices.addKeyDevice('Phone', 'phone-key')
  const local = devices.createPairing()
  const fromHere = devices.requestApproval(local.code, 'Elsewhere', 'relay', '111111')
  assert.deepEqual(devices.pairingRequests(phone.id), [])
  const [elsewhere] = devices.pairingRequests()
  assert.throws(() => devices.decidePairing(elsewhere.id, true, { id: phone.id, expiresAt: later(1) }), store.NotFound)
  devices.decidePairing(elsewhere.id, false)
  assert.equal(await fromHere.approved, null)

  const { code } = devices.createPairing(phone.id)
  const asked = devices.requestApproval(code, 'Borrowed laptop', 'relay', '222222')
  const [request] = devices.pairingRequests(phone.id)
  assert.equal(request.name, 'Borrowed laptop')
  const expiresAt = later(12)
  devices.decidePairing(request.id, true, { id: phone.id, expiresAt })
  const grant = await asked.approved
  assert.deepEqual(grant, { expiresAt, addedBy: phone.id })
  const laptop = devices.addKeyDevice('Borrowed laptop', 'laptop-key', false, grant)
  assert.equal(devices.authenticate(viaRelay(laptop.id)).device.id, laptop.id)
  assert.deepEqual(devices.listDevices(phone.id).map((d) => [d.name, d.addedBy]), [['Borrowed laptop', 'Phone']])

  // Once its time is up, it is out, through every way in, and the sweep finds it.
  expire(laptop.id)
  assert.equal(devices.authenticate(viaRelay(laptop.id)), null)
  assert.equal(devices.deviceByKey('laptop-key'), undefined)
  assert.equal(devices.deviceById(laptop.id), undefined)
  assert.deepEqual(devices.expiredDevices(), [laptop.id])
  devices.revokeDevice(laptop.id)
})

test('a time limit never shortens what a device already had, and pairing here again lifts it', () => {
  const tablet = devices.addKeyDevice('Tablet', 'tablet-key')
  devices.addKeyDevice('Tablet', 'tablet-key', false, { expiresAt: later(1), addedBy: 'someone' })
  assert.equal(stored(tablet.id).expiresAt, undefined)

  const guest = devices.addKeyDevice('Guest', 'guest-key', false, { expiresAt: later(1), addedBy: 'someone' })
  const longer = later(168)
  devices.addKeyDevice('Guest', 'guest-key', false, { expiresAt: longer, addedBy: 'someone' })
  assert.equal(stored(guest.id).expiresAt, longer)
  devices.addKeyDevice('Guest', 'guest-key')
  assert.deepEqual([stored(guest.id).expiresAt, stored(guest.id).addedBy], [undefined, undefined])
})

test('a token device let in for a while is out once its time is up', () => {
  const token = devices.addTokenDevice('Hotel PC', false, { expiresAt: later(1), addedBy: 'someone' })
  const req = { headers: { cookie: `savor_device=${token}` }, socket: { remoteAddress: '203.0.113.5' } }
  const device = devices.authenticate(req).device
  assert.equal(device.name, 'Hotel PC')
  expire(device.id)
  assert.equal(devices.authenticate(req), null)
})
