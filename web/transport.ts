// How the UI reaches its daemon: directly over HTTP when served by the daemon, or through the
// end-to-end encrypted relay tunnel when served by a relay (see shared/tunnel.ts).
import * as t from '../shared/tunnel'

export interface Response { status: number; type: string; body: string; binary?: boolean }

export interface Transport {
  request(method: string, path: string, body?: string): Promise<Response>
  // Server-sent events: calls onData with each event's data. Returns a function that stops it.
  stream(path: string, onData: (data: string) => void): () => void
  // URL for <img src>; the tunnel has to fetch and wrap binary responses first.
  imageUrl(path: string): Promise<string>
}

export const direct: Transport = {
  async request(method, path, body) {
    const r = await fetch(path, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body })
    return { status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() }
  },
  stream(path, onData) {
    const es = new EventSource(path)
    es.onmessage = (m) => onData(m.data)
    return () => es.close()
  },
  imageUrl: async (path) => path,
}

export let transport: Transport = direct
export const setTransport = (next: Transport) => (transport = next)

// ---- device key ----
// The device's private key is a non-extractable WebCrypto key kept in IndexedDB, so script running
// on the page can use it but not read it out. Browsers without X25519 in WebCrypto fall back to a
// raw key.

type StoredKey = { privateKey: CryptoKey; pk: Uint8Array } | { sk: Uint8Array; pk: Uint8Array }

function keyStore<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const open = indexedDB.open('savor', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('keys')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      // Resolve once the transaction has committed: pairing navigates away right after storing the
      // key, and Safari drops a write that hasn't committed yet.
      const tx = open.result.transaction('keys', mode)
      const req = op(tx.objectStore('keys'))
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = () => reject(tx.error ?? req.error)
      tx.onabort = () => reject(tx.error ?? new Error('Storing the device key failed.'))
    }
  })
}

async function createDeviceKey(): Promise<StoredKey> {
  try {
    const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair
    return { privateKey: pair.privateKey, pk: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) }
  } catch {
    return t.keypair()
  }
}

function deviceKey(stored: StoredKey): t.DeviceKey {
  if ('sk' in stored) return t.rawDeviceKey(stored)
  return {
    pk: stored.pk,
    async dh(peer) {
      const pub = await crypto.subtle.importKey('raw', new Uint8Array(peer), { name: 'X25519' }, false, [])
      return new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: pub }, stored.privateKey, 256))
    },
  }
}

// ---- remote mode ----

// Which computer this browser is paired with; the key itself lives in IndexedDB.
export interface RemoteProfile { daemonPk: string; name: string }
const PROFILE_KEY = 'savor-remote'

export const loadProfile = (): RemoteProfile | null => JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null')

export async function forgetProfile() {
  localStorage.removeItem(PROFILE_KEY)
  await keyStore('readwrite', (s) => s.delete('device'))
}

const relaySocket = (daemonPk: Uint8Array) => new WebSocket(`${location.origin.replace(/^http/, 'ws')}/connect?id=${t.daemonId(daemonPk)}`)

function nextMessage(ws: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    ws.addEventListener('message', (m) => resolve(String(m.data)), { once: true })
    ws.addEventListener('close', (e) => reject(new Error(e.reason || 'Your computer is not reachable through the relay.')), { once: true })
  })
}

async function welcome(ws: WebSocket, hello: object) {
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('close', (e) => reject(new Error(e.reason || 'Your computer is not reachable through the relay.')), { once: true })
  })
  ws.send(JSON.stringify(hello))
  const reply = JSON.parse(await nextMessage(ws))
  if (reply.type === 'error') throw new Error(reply.error)
  return reply
}

// First contact: prove knowledge of the one-time code and register this device's key.
export async function pairThroughRelay(daemonPkText: string, code: string, name: string) {
  const daemonPk = t.publicKey(daemonPkText)
  const key = await createDeviceKey()
  const ws = relaySocket(daemonPk)
  const pairing = t.devicePairing(daemonPk, code)
  const channel = pairing.finish(await welcome(ws, pairing.hello))
  ws.send(channel.seal({ name, device: t.b64.enc(key.pk) }))
  const reply = await nextMessage(ws)
  ws.close()
  let result: any
  try {
    result = channel.open(reply)
  } catch {
    throw new Error(JSON.parse(reply).error === 'pairing failed' ? 'Pairing code invalid or expired.' : 'Pairing failed.')
  }
  if (!result.paired) throw new Error('Pairing failed.')
  await keyStore('readwrite', (s) => s.put(key, 'device'))
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ daemonPk: daemonPkText, name }))
}

type Pending = { resolve: (r: Response) => void; reject: (e: Error) => void; onData?: (data: string) => void; buffer: string; path: string }
type Tunnel = { ws: WebSocket; channel: t.Channel }

// One encrypted tunnel with request multiplexing. Reconnects on its own and resumes open streams.
export function remote(profile: RemoteProfile, onState: (connected: boolean, error?: string) => void): Transport {
  const daemonPk = t.publicKey(profile.daemonPk)
  const device = keyStore<StoredKey | undefined>('readonly', (s) => s.get('device')).then((stored) => {
    if (!stored) throw new Error('This browser has no device key. Pair it again.')
    return deviceKey(stored)
  })
  const pending = new Map<number, Pending>()
  let nextId = 1
  let ready: Promise<Tunnel> | null = null

  function connect() {
    const attempt: Promise<Tunnel> = (async () => {
      const ws = relaySocket(daemonPk)
      const session = t.deviceSession(await device, daemonPk)
      const channel = await session.finish(await welcome(ws, session.hello))
      ws.onmessage = (m) => {
        let msg: any
        try {
          msg = channel.open(String(m.data))
        } catch {
          return ws.close()
        }
        const p = pending.get(msg.id)
        if (!p) return
        if (p.onData) {
          p.buffer += msg.chunk ?? ''
          const events = p.buffer.split('\n\n')
          p.buffer = events.pop() ?? ''
          for (const e of events) for (const line of e.split('\n')) if (line.startsWith('data: ')) p.onData(line.slice(6))
          return
        }
        if (msg.end) {
          pending.delete(msg.id)
          p.resolve({ status: msg.status, type: msg.type, body: msg.body, binary: msg.binary })
        }
      }
      ws.onclose = () => {
        onState(false)
        ready = null
        for (const [id, p] of pending) {
          if (p.onData) continue
          pending.delete(id)
          p.reject(new Error('Connection lost'))
        }
        setTimeout(resume, 2000)
      }
      onState(true)
      return { ws, channel }
    })()
    ready = attempt
    attempt.catch((e) => {
      onState(false, e.message)
      ready = null
      setTimeout(resume, 5000)
    })
    return attempt
  }

  // After a reconnect, streams are requested again so events keep flowing.
  async function resume() {
    if (ready) return
    const tunnel = await connect().catch(() => null)
    if (!tunnel) return
    for (const [id, p] of pending) if (p.onData) tunnel.ws.send(tunnel.channel.seal({ id, method: 'GET', path: p.path }))
  }

  const tunnel = () => ready ?? connect()

  return {
    async request(method, path, body) {
      const { ws, channel } = await tunnel()
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, buffer: '', path })
        ws.send(channel.seal({ id, method, path, body }))
      })
    },
    stream(path, onData) {
      const id = nextId++
      pending.set(id, { resolve: () => {}, reject: () => {}, onData, buffer: '', path })
      tunnel().then(({ ws, channel }) => ws.send(channel.seal({ id, method: 'GET', path })))
      return () => {
        pending.delete(id)
        ready?.then(({ ws, channel }) => ws.readyState === ws.OPEN && ws.send(channel.seal({ id, cancel: true })))
      }
    },
    async imageUrl(path) {
      const r = await this.request('GET', path)
      // Only images become blob URLs; a blob of another type could run script on this origin.
      if (!r.binary || !/^image\/(png|jpeg|gif|webp)$/.test(r.type)) return ''
      return URL.createObjectURL(new Blob([t.b64.dec(r.body)], { type: r.type }))
    },
  }
}
