// Savor relay: lets phones and browsers reach a Savor daemon that sits behind NAT, without a VPN.
// Daemons connect outbound and prove they hold the key their address is derived from. Devices
// connect to that address; the relay pairs the sockets and forwards opaque, end-to-end encrypted
// frames (see shared/tunnel.ts). It also serves the web UI, which runs the device side.
//
// Everything a client sends is untrusted: handlers never throw, sockets that don't authenticate or
// start talking in time are closed, and connections are capped per IP, per daemon and in total.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { daemonId, publicKey, relayChallenge } from '../shared/tunnel.js'
import { newNonce, securityHeaders, withNonce } from '../shared/headers.js'

const PORT = Number(process.env.RELAY_PORT ?? 8787)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = process.env.RELAY_WEB_DIR ?? [path.join(HERE, '..', 'dist', 'web'), path.join(HERE, '..', 'web')].find((d) => fs.existsSync(path.join(d, 'index.html')))!
// Only behind a reverse proxy (Caddy, nginx) is X-Forwarded-For the client's address.
const TRUST_PROXY = process.env.RELAY_TRUST_PROXY === '1'
const HANDSHAKE_MS = Number(process.env.RELAY_HANDSHAKE_TIMEOUT_MS ?? 10_000)
const MAX_FRAME = 32 * 1024 * 1024
const MAX_DAEMONS = Number(process.env.RELAY_MAX_DAEMONS ?? 5000)
const MAX_DEVICES_PER_DAEMON = 32
const MAX_DEVICES_PER_IP_PER_DAEMON = 8
const CONNECTS_PER_MINUTE = 60
// For tests: append every forwarded payload so they can check that no plaintext passes through.
const TAP = process.env.RELAY_TAP_FILE

interface Device { socket: WebSocket; ip: string }
interface Daemon { socket: WebSocket; devices: Map<string, Device> }
const daemons = new Map<string, Daemon>()
const recentConnects = new Map<string, number[]>()

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x')
  const nonce = newNonce()
  for (const [k, v] of Object.entries(securityHeaders(req.headers.host, nonce))) res.setHeader(k, v)
  // Tells the UI to run in relay mode, i.e. to talk to its daemon through the tunnel.
  if (url.pathname === '/savor-relay.json') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"relay":true}')
  if (url.pathname === '/healthz') return res.writeHead(200).end('ok')
  const file = path.join(WEB, path.normalize(url.pathname))
  const target = file.startsWith(WEB + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(WEB, 'index.html')
  res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' })
  if (target.endsWith('index.html')) return res.end(withNonce(fs.readFileSync(target, 'utf8'), nonce))
  fs.createReadStream(target).pipe(res)
}

const clientIp = (req: http.IncomingMessage) =>
  (TRUST_PROXY && (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim()) || req.socket.remoteAddress || ''

function rateLimited(ip: string) {
  const now = Date.now()
  const recent = (recentConnects.get(ip) ?? []).filter((t) => now - t < 60_000)
  recent.push(now)
  recentConnects.set(ip, recent)
  return recent.length > CONNECTS_PER_MINUTE
}

setInterval(() => {
  const now = Date.now()
  for (const [ip, times] of recentConnects) if (times.every((t) => now - t >= 60_000)) recentConnects.delete(ip)
}, 60_000).unref()

const send = (socket: WebSocket, message: object) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(message))

function parse(raw: unknown) {
  try {
    const m = JSON.parse(String(raw))
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null
  } catch {
    return null
  }
}

function acceptDaemon(socket: WebSocket) {
  const { challenge, verify } = relayChallenge()
  send(socket, challenge)
  let id: string | null = null
  const authTimer = setTimeout(() => socket.close(4408, 'auth timeout'), HANDSHAKE_MS)

  socket.on('message', (raw) => {
    const m = parse(raw)
    if (!m) return socket.close(4400, 'bad frame')
    if (!id) {
      let pk: Uint8Array
      try {
        pk = publicKey(m.pk)
      } catch {
        return socket.close(4401, 'auth failed')
      }
      if (m.t !== 'auth' || !verify(pk, m.mac)) return socket.close(4401, 'auth failed')
      const next = daemonId(pk)
      if (!daemons.has(next) && daemons.size >= MAX_DAEMONS) return socket.close(4503, 'relay full')
      clearTimeout(authTimer)
      id = next
      // A reconnect from the same key replaces the old socket; its tunnels can't be resumed.
      const old = daemons.get(id)
      daemons.set(id, { socket, devices: new Map() })
      if (old) {
        old.socket.close(4409, 'replaced')
        for (const device of old.devices.values()) device.socket.close(4503, 'daemon reconnected')
      }
      return send(socket, { t: 'ready', id })
    }
    if (typeof m.c !== 'string') return
    const device = daemons.get(id)?.devices.get(m.c)
    if (!device) return
    if (m.t === 'data' && typeof m.d === 'string') {
      if (TAP) fs.appendFileSync(TAP, m.d + '\n')
      device.socket.send(m.d)
    }
    if (m.t === 'close') device.socket.close(1000)
  })

  socket.on('close', () => {
    clearTimeout(authTimer)
    const d = id ? daemons.get(id) : null
    if (!d || d.socket !== socket) return
    daemons.delete(id!)
    for (const device of d.devices.values()) device.socket.close(4503, 'daemon offline')
  })
}

function acceptDevice(socket: WebSocket, id: string, ip: string) {
  const daemon = daemons.get(id)
  if (!daemon) return socket.close(4404, 'daemon offline')
  const fromIp = [...daemon.devices.values()].filter((d) => d.ip === ip).length
  if (daemon.devices.size >= MAX_DEVICES_PER_DAEMON || fromIp >= MAX_DEVICES_PER_IP_PER_DAEMON) return socket.close(4429, 'too many devices')
  const c = crypto.randomBytes(9).toString('base64url')
  daemon.devices.set(c, { socket, ip })
  send(daemon.socket, { t: 'open', c })
  // A device that doesn't start its handshake right away only holds a slot.
  const helloTimer = setTimeout(() => socket.close(4408, 'handshake timeout'), HANDSHAKE_MS)
  socket.on('message', (raw) => {
    clearTimeout(helloTimer)
    const d = daemons.get(id)
    if (!d) return
    const text = String(raw)
    if (TAP) fs.appendFileSync(TAP, text + '\n')
    send(d.socket, { t: 'data', c, d: text })
  })
  socket.on('close', () => {
    clearTimeout(helloTimer)
    const d = daemons.get(id)
    if (!d || !d.devices.delete(c)) return
    send(d.socket, { t: 'close', c })
  })
}

const server = http.createServer(serveStatic)
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const ip = clientIp(req)
  if (rateLimited(ip)) return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('error', () => ws.terminate())
    if (url.pathname === '/daemon') acceptDaemon(ws)
    else if (url.pathname === '/connect') acceptDevice(ws, url.searchParams.get('id') ?? '', ip)
    else ws.close(4404, 'not found')
  })
})

server.listen(PORT, () => console.log(`Savor relay listening on :${PORT}, serving ${WEB}`))
