import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import computers from '../desktop/computers.cjs'

const PK = 'q2Xc0Lw7cJ6p2T1r9-Zs_4hVfE3uKpQ8mN5bA0yD1xE'

test('only pairing links from the Devices page open in the window', () => {
  assert.equal(computers.pairingUrl(' https://xps.tail1234.ts.net/#/pair/A1B2C3D4E5 '), 'https://xps.tail1234.ts.net/#/pair/A1B2C3D4E5')
  assert.equal(computers.pairingUrl(`https://relay.example/#/rpair/${PK}/A1B2C3D4E5`), `https://relay.example/#/rpair/${PK}/A1B2C3D4E5`)
  assert.equal(computers.pairingUrl(`https://relay.example/#/rpair/${PK}/A1B2C3D4E5/1767225600`), `https://relay.example/#/rpair/${PK}/A1B2C3D4E5/1767225600`)
  for (const bad of ['https://xps.example/', 'https://xps.example/#/p/abc', 'file:///etc/passwd#/pair/A1', 'javascript:alert(1)//#/pair/A1', 'https://user:pw@xps.example/#/pair/A1', 'not a link', ''])
    assert.equal(computers.pairingUrl(bad), null, bad)
})

test('a paired computer is remembered once, by its address or its relay key', () => {
  let s = computers.load(path.join(os.tmpdir(), 'savor-no-such-computers.json'))
  assert.deepEqual(s, { server: true, last: 'local', computers: [] })
  const xps = computers.computerAt('https://xps.tail1234.ts.net', { host: 'xps' })
  assert.deepEqual(xps, { id: 'https://xps.tail1234.ts.net', name: 'xps', url: 'https://xps.tail1234.ts.net/', via: 'direct' })
  const relayed = computers.computerAt('https://relay.example', { host: 'optiplex', daemonPk: PK })
  assert.deepEqual(relayed, { id: `https://relay.example#${PK}`, name: 'optiplex', url: `https://relay.example/#/computer/${PK}`, via: 'relay' })
  // A key that is no base64url is no key.
  assert.equal(computers.computerAt('https://relay.example', { host: 'x', daemonPk: '../../x' }).via, 'direct')
  s = computers.remember(computers.remember(s, xps), relayed)
  s = computers.remember(s, { ...xps, name: 'xps-renamed' })
  assert.deepEqual(s.computers.map((c) => c.name), ['xps-renamed', 'optiplex'])
  assert.equal(s.last, xps.id)
  assert.equal(computers.access(s, 'https://relay.example', {}), 'computer')
  assert.equal(computers.access(s, 'https://evil.example', {}), null)
})

test('the app opens the last computer, this one, or the first paired when it is only a client', () => {
  const xps = computers.computerAt('https://xps.example', { host: 'xps' })
  const s = computers.remember({ server: true, last: 'local', computers: [] }, xps)
  assert.equal(computers.startId(s), xps.id)
  assert.equal(computers.startId({ ...s, last: 'local' }), 'local')
  assert.equal(computers.startId({ ...s, last: 'local', server: false }), xps.id)
  assert.equal(computers.startId({ server: false, last: 'local', computers: [] }), null)
  const forgotten = computers.forget(s, xps.id)
  assert.deepEqual(forgotten.computers, [])
  assert.equal(computers.startId(forgotten), 'local')
})

test('the list survives a restart, and a damaged file starts empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-computers-'))
  const file = path.join(dir, 'computers.json')
  const s = computers.remember({ server: false, last: 'local', computers: [] }, computers.computerAt('https://xps.example', { host: 'xps' }))
  computers.save(file, s)
  assert.deepEqual(computers.load(file), s)
  fs.writeFileSync(file, '\0\0\0')
  assert.deepEqual(computers.load(file), { server: true, last: 'local', computers: [] })
  fs.rmSync(dir, { recursive: true })
})

test('the shell trusts this computer only while it runs Savor, paired computers, and a pairing page until it is left', () => {
  const local = 'http://localhost:4317'
  const s = computers.remember({ server: true, last: 'local', computers: [] }, computers.computerAt('https://xps.example', { host: 'xps' }))
  const access = (origin, pending = null, state = s) => computers.access(state, origin, { local, pending })
  assert.equal(access(local), 'local')
  // Without Savor here, whatever answers on its port is a stranger, such as a tunnel to another computer.
  assert.equal(access(local, null, { ...s, server: false }), null)
  assert.equal(access(local, local, { ...s, server: false }), 'pairing')
  assert.equal(access('https://xps.example'), 'computer')
  assert.equal(access('https://new.example', 'https://new.example'), 'pairing')
  assert.equal(access('https://evil.example', 'https://new.example'), null)
  for (const nothing of [null, 'null', '']) assert.equal(access(nothing, null), null, String(nothing))
})
