// Keeps an outbound connection to the configured relay and serves the devices tunneled through it.
// Each device connection runs the handshake from shared/tunnel.ts, then carries encrypted HTTP
// requests that are replayed against this daemon's own API with the device's identity.
//
// Anything arriving from the relay is untrusted: handlers never throw, connections that don't finish
// their handshake in time are closed, and only normalized /api paths are forwarded.
import * as t from '../shared/tunnel.js'
import * as store from './store.js'
import * as devices from './devices.js'
import { PORT } from './config.js'
import { emit } from './events.js'

type Status = { state: 'off' | 'connecting' | 'online' | 'error'; error?: string; id?: string }

const HANDSHAKE_MS = Number(process.env.SAVOR_TUNNEL_HANDSHAKE_MS ?? 10_000)

let socket: WebSocket | null = null
let status: Status = { state: 'off' }
let retryTimer: NodeJS.Timeout | undefined
let retryDelay = 2000
const conns = new Map<string, Conn>()

export const identity = () => t.keypairFrom(t.b64.dec(store.state().identity))

export function relayStatus() {
  const { relay } = store.state()
  return { ...relay, ...status, publicKey: t.b64.enc(identity().pk) }
}

// Link a phone opens to pair through the relay; the code comes from the local pairing screen.
export function pairingLink(code: string) {
  const { relay } = store.state()
  if (!relay.enabled || !relay.url || status.state !== 'online') return null
  return `${relay.url.replace(/\/$/, '')}/#/rpair/${t.b64.enc(identity().pk)}/${code}`
}

// The API path a tunneled request may reach, after the same normalization fetch() applies.
export function tunnelPath(path: unknown) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null
  const url = new URL(path, 'http://x')
  if (!url.pathname.startsWith('/api/') || url.pathname === '/api/pair' || url.pathname.startsWith('/api/pair/')) return null
  return url.pathname + url.search
}

// Revoking a device ends its tunnels right away, including open event streams.
export function closeDevice(deviceId: string) {
  for (const c of conns.values()) if (c.deviceId === deviceId) c.fail('device revoked')
}

function setStatus(next: Status) {
  status = next
  emit({ type: 'devices' })
}

export function startRelay() {
  clearTimeout(retryTimer)
  socket?.close()
  socket = null
  for (const c of conns.values()) c.dispose()
  const { relay } = store.state()
  if (!relay.enabled || !relay.url) return setStatus({ state: 'off' })
  connect(relay.url)
}

function connect(url: string) {
  setStatus({ state: 'connecting' })
  const ws = new WebSocket(`${url.replace(/^http/, 'ws').replace(/\/$/, '')}/daemon`)
  socket = ws
  ws.onmessage = (ev) => {
    if (socket !== ws) return
    try {
      onRelayMessage(ws, JSON.parse(String(ev.data)))
    } catch (e) {
      console.error('relay message rejected:', (e as Error).message)
    }
  }
  ws.onclose = (ev) => {
    if (socket !== ws) return
    for (const c of conns.values()) c.dispose()
    setStatus({ state: 'error', error: ev.reason || `Connection closed (${ev.code})` })
    retryTimer = setTimeout(() => connect(url), retryDelay)
    retryDelay = Math.min(retryDelay * 2, 60_000)
  }
}

function onRelayMessage(ws: WebSocket, m: any) {
  if (m.t === 'challenge') ws.send(JSON.stringify({ t: 'auth', pk: t.b64.enc(identity().pk), mac: t.answerChallenge(identity(), m) }))
  if (m.t === 'ready') {
    retryDelay = 2000
    setStatus({ state: 'online', id: m.id })
  }
  if (typeof m.c !== 'string') return
  if (m.t === 'open' && !conns.has(m.c)) conns.set(m.c, new Conn(m.c, ws))
  if (m.t === 'data') conns.get(m.c)?.receive(m.d)
  if (m.t === 'close') conns.get(m.c)?.dispose()
}

interface Req { id: number; method?: string; path?: string; body?: string; cancel?: boolean }

class Conn {
  deviceId: string | null = null
  private channel: t.Channel | null = null
  private pairing: { code: string; channel: t.Channel }[] | null = null
  private streams = new Map<number, AbortController>()
  private handshakeTimer: NodeJS.Timeout

  constructor(
    private c: string,
    private ws: WebSocket,
  ) {
    this.handshakeTimer = setTimeout(() => this.fail('handshake timeout'), HANDSHAKE_MS)
  }

  private send(d: string) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify({ t: 'data', c: this.c, d }))
  }

  fail(error: string) {
    this.send(JSON.stringify({ type: 'error', error }))
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify({ t: 'close', c: this.c }))
    this.dispose()
  }

  dispose() {
    clearTimeout(this.handshakeTimer)
    for (const s of this.streams.values()) s.abort()
    this.channel = null
    conns.delete(this.c)
  }

  receive(d: unknown) {
    if (typeof d !== 'string') return this.fail('bad frame')
    try {
      if (this.channel) return this.onRequest(d)
      if (this.pairing) return this.onPairing(d)
      this.onHello(JSON.parse(d))
    } catch {
      this.fail('bad handshake')
    }
  }

  private onHello(hello: any) {
    if (hello?.type !== 'hello') return this.fail('bad hello')
    if (hello.mode === 'session') {
      const devicePk = t.openHello(identity(), hello)
      const device = devices.deviceByKey(t.b64.enc(devicePk))
      if (!device) return this.fail('unknown device')
      const session = t.daemonSession(identity(), devicePk, hello)
      this.channel = session.channel
      this.deviceId = device.id
      clearTimeout(this.handshakeTimer)
      return this.send(JSON.stringify(session.welcome))
    }
    if (hello.mode === 'pair') {
      const codes = devices.openPairingCodes()
      if (!codes.length) return this.fail('no pairing in progress')
      const pairing = t.daemonPairing(identity(), hello, codes)
      this.pairing = pairing.candidates
      return this.send(JSON.stringify(pairing.welcome))
    }
    this.fail('bad hello')
  }

  private onPairing(d: string) {
    for (const { code, channel } of this.pairing!) {
      let m: any
      try {
        m = channel.open(d)
      } catch {
        continue
      }
      const devicePk = t.publicKey(m?.device)
      const device = devices.redeemWithKey(code, typeof m.name === 'string' ? m.name : '', t.b64.enc(devicePk))
      emit({ type: 'devices' })
      this.send(channel.seal({ paired: true, deviceId: device.id }))
      return this.fail('paired')
    }
    devices.pairingFailed()
    this.fail('pairing failed')
  }

  private onRequest(d: string) {
    let req: Req
    try {
      req = this.channel!.open(d)
    } catch {
      return this.fail('decryption failed')
    }
    if (!devices.deviceById(this.deviceId!)) return this.fail('device revoked')
    if (typeof req?.id !== 'number') return
    if (req.cancel) return this.streams.get(req.id)?.abort()
    this.forward(req).catch((e) => this.reply({ id: req.id, status: 502, type: 'application/json', body: JSON.stringify({ error: String(e.message ?? e) }), end: true }))
  }

  private reply(m: object) {
    if (this.channel) this.send(this.channel.seal(m))
  }

  private async forward(req: Req) {
    const path = tunnelPath(req.path)
    if (!path) return this.reply({ id: req.id, status: 404, type: 'application/json', body: '{"error":"not found"}', end: true })
    const abort = new AbortController()
    this.streams.set(req.id, abort)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
        method: typeof req.method === 'string' ? req.method : 'GET',
        headers: { 'content-type': 'application/json', 'x-savor-relay': store.state().relayToken, 'x-savor-device': this.deviceId! },
        body: typeof req.body === 'string' ? req.body : undefined,
        signal: abort.signal,
      })
      const type = res.headers.get('content-type') ?? ''
      if (type.startsWith('text/event-stream') && res.body) {
        this.reply({ id: req.id, status: res.status, type })
        const decoder = new TextDecoder()
        for await (const chunk of res.body) this.reply({ id: req.id, chunk: decoder.decode(chunk, { stream: true }) })
        return this.reply({ id: req.id, end: true })
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      const text = /json|text|javascript|svg/.test(type)
      this.reply({ id: req.id, status: res.status, type, body: text ? new TextDecoder().decode(bytes) : t.b64.enc(bytes), binary: !text, end: true })
    } catch (e) {
      if (!abort.signal.aborted) throw e
    } finally {
      this.streams.delete(req.id)
    }
  }
}
