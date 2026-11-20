// The service worker (web/sw.ts) with stand-ins for its globals: the notifications, the key store and the relay's socket.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { b64, keypair } from '../shared/tunnel.ts'

test('regression: answers from notifications share one tunnel per computer', async () => {
  const handlers = {}
  const sockets = []
  const closed = []
  const profileOf = () => ({ daemonPk: b64.enc(keypair().pk), name: 'Phone', relay: 'https://relay.test' })
  let profile = profileOf()
  let device = keypair()
  const stored = { get device() { return device }, get profile() { return profile } }
  let transactions = 0
  globalThis.self = {
    addEventListener: (type, fn) => (handlers[type] = fn),
    registration: { showNotification: async () => {}, getNotifications: async () => [] },
    navigator: {},
  }
  // The key store answers once its transaction is through, like IndexedDB.
  globalThis.indexedDB = {
    open() {
      transactions++
      const open = { result: { transaction: () => {
        const tx = { objectStore: () => ({ get: (key) => ({ result: stored[key] }), put: () => ({}) }) }
        setImmediate(() => { tx.oncomplete(); transactions-- })
        return tx
      } } }
      setImmediate(() => open.onsuccess())
      return open
    },
  }
  // A relay that never answers: the tunnel stays, waiting for it.
  globalThis.WebSocket = class {
    constructor(url) {
      sockets.push(url)
      this.id = sockets.length - 1
    }
    addEventListener() {}
    close() { closed.push(this.id) }
  }
  await import('../web/sw.ts')

  const push = { title: 'Savor', body: '', status: 'Your turn', tag: 't', hash: '/p/p1/t/t1', badge: 1, question: { title: 'Go on?', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }], recommended: 0, decision: 'd1' } }
  const tap = (action) => handlers.notificationclick({ action, notification: { data: { push, held: 'h1' }, close() {} }, waitUntil() {} })
  const settled = async () => {
    do { await new Promise(setImmediate) } while (transactions)
  }
  tap('o0')
  tap('undo')
  tap('o1')
  await settled()
  assert.equal(sockets.length, 1)
  // The app switched to another computer: its answers go there, through a tunnel of their own.
  const first = profile
  profile = profileOf()
  tap('o0')
  tap('o0')
  await settled()
  assert.equal(sockets.length, 2)
  assert.notEqual(sockets[1], sockets[0])
  profile = first
  tap('o0')
  await settled()
  assert.equal(sockets.length, 2)
  // Forgetting the last computer and pairing again gives this browser a new identity.
  device = keypair()
  tap('o0')
  tap('undo')
  await settled()
  assert.equal(sockets.length, 3)
  assert.deepEqual(closed, [0])
})
