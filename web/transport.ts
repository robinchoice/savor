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
    const r = await fetch(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body })
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

// ---- remote mode ----

export interface RemoteProfile { daemonPk: string; deviceSk: string; name: string }
const PROFILE_KEY = 'savor-remote'

export const loadProfile = (): RemoteProfile | null => JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null')
export const forgetProfile = () => localStorage.removeItem(PROFILE_KEY)

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
  const daemonPk = t.b64.dec(daemonPkText)
  const device = t.keypair()
  const ws = relaySocket(daemonPk)
  const pairing = t.devicePairing(daemonPk, code)
  const channel = pairing.finish(await welcome(ws, pairing.hello))
  ws.send(channel.seal({ name, device: t.b64.enc(device.pk) }))
  const reply = await nextMessage(ws)
  ws.close()
  let result: any
  try {
    result = channel.open(reply)
  } catch {
    throw new Error(JSON.parse(reply).error === 'pairing failed' ? 'Pairing code invalid or expired.' : 'Pairing failed.')
  }
  if (!result.paired) throw new Error('Pairing failed.')
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ daemonPk: daemonPkText, deviceSk: t.b64.enc(device.sk), name }))
}

type Pending = { resolve: (r: Response) => void; reject: (e: Error) => void; onData?: (data: string) => void; buffer: string; path: string }

// One encrypted tunnel with request multiplexing. Reconnects on its own and resumes open streams.
export function remote(profile: RemoteProfile, onState: (connected: boolean, error?: string) => void): Transport {
  const daemonPk = t.b64.dec(profile.daemonPk)
  const device = t.keypairFrom(t.b64.dec(profile.deviceSk))
  const pending = new Map<number, Pending>()
  let nextId = 1
  let ready: Promise<{ ws: WebSocket; channel: t.Channel }> | null = null

  function connect() {
    ready = (async () => {
      const ws = relaySocket(daemonPk)
      const session = t.deviceSession(device, daemonPk)
      const channel = session.finish(await welcome(ws, session.hello))
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
    ready.catch((e) => {
      onState(false, e.message)
      ready = null
      setTimeout(resume, 5000)
    })
    return ready
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
      if (!r.binary) return ''
      return URL.createObjectURL(new Blob([t.b64.dec(r.body)], { type: r.type }))
    },
  }
}

export const setTransport = (next: Transport) => (transport = next)
