// Savor relay: lets phones and browsers reach a Savor daemon that sits behind NAT, without a VPN.
// Daemons connect outbound and prove they hold the key their address is derived from. Devices
// connect to that address; the relay pairs the sockets and forwards opaque, end-to-end encrypted
// frames (see shared/tunnel.ts). It also serves the web UI, which runs the device side.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { b64, daemonId, relayChallenge } from '../shared/tunnel.js'

const PORT = Number(process.env.RELAY_PORT ?? 8787)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = process.env.RELAY_WEB_DIR ?? [path.join(HERE, '..', 'dist', 'web'), path.join(HERE, '..', 'web')].find((d) => fs.existsSync(path.join(d, 'index.html')))!
const MAX_FRAME = 32 * 1024 * 1024
const MAX_DEVICES_PER_DAEMON = 32
const CONNECTS_PER_MINUTE = 60
// For tests: append every forwarded payload so they can check that no plaintext passes through.
const TAP = process.env.RELAY_TAP_FILE

interface Daemon { socket: WebSocket; devices: Map<string, WebSocket> }
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
  // Tells the UI to run in relay mode, i.e. to talk to its daemon through the tunnel.
  if (url.pathname === '/savor-relay.json') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"relay":true}')
  if (url.pathname === '/healthz') return res.writeHead(200).end(`ok ${daemons.size}`)
  const file = path.join(WEB, path.normalize(url.pathname))
  const target = file.startsWith(WEB) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(WEB, 'index.html')
  res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' })
  fs.createReadStream(target).pipe(res)
}

function rateLimited(ip: string) {
  const now = Date.now()
  const recent = (recentConnects.get(ip) ?? []).filter((t) => now - t < 60_000)
  recent.push(now)
  recentConnects.set(ip, recent)
  return recent.length > CONNECTS_PER_MINUTE
}

const send = (socket: WebSocket, message: object) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(message))

function acceptDaemon(socket: WebSocket) {
  const { challenge, verify } = relayChallenge()
  send(socket, challenge)
  let id: string | null = null

  socket.on('message', (raw) => {
    let m: any
    try {
      m = JSON.parse(raw.toString())
    } catch {
      return socket.close(4400, 'bad frame')
    }
    if (!id) {
      const pk = b64.dec(m.pk ?? '')
      if (m.t !== 'auth' || pk.length !== 32 || !verify(pk, b64.dec(m.mac ?? ''))) return socket.close(4401, 'auth failed')
      id = daemonId(pk)
      // A reconnect from the same key replaces the old socket; its tunnels can't be resumed.
      const old = daemons.get(id)
      daemons.set(id, { socket, devices: new Map() })
      if (old) {
        old.socket.close(4409, 'replaced')
        for (const device of old.devices.values()) device.close(4503, 'daemon reconnected')
      }
      return send(socket, { t: 'ready', id })
    }
    const device = daemons.get(id)?.devices.get(m.c)
    if (!device) return
    if (m.t === 'data') {
      if (TAP) fs.appendFileSync(TAP, m.d + '\n')
      device.send(m.d)
    }
    if (m.t === 'close') device.close(1000)
  })

  socket.on('close', () => {
    const d = id ? daemons.get(id) : null
    if (!d || d.socket !== socket) return
    daemons.delete(id!)
    for (const device of d.devices.values()) device.close(4503, 'daemon offline')
  })
}

function acceptDevice(socket: WebSocket, id: string) {
  const daemon = daemons.get(id)
  if (!daemon) return socket.close(4404, 'daemon offline')
  if (daemon.devices.size >= MAX_DEVICES_PER_DAEMON) return socket.close(4429, 'too many devices')
  const c = crypto.randomBytes(9).toString('base64url')
  daemon.devices.set(c, socket)
  send(daemon.socket, { t: 'open', c })
  socket.on('message', (raw) => {
    if (TAP) fs.appendFileSync(TAP, raw.toString() + '\n')
    const d = daemons.get(id)
    if (d) send(d.socket, { t: 'data', c, d: raw.toString() })
  })
  socket.on('close', () => {
    const d = daemons.get(id)
    if (!d) return
    d.devices.delete(c)
    send(d.socket, { t: 'close', c })
  })
}

const server = http.createServer(serveStatic)
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() || req.socket.remoteAddress || ''
  if (rateLimited(ip)) return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/daemon') acceptDaemon(ws)
    else if (url.pathname === '/connect') acceptDevice(ws, url.searchParams.get('id') ?? '')
    else ws.close(4404, 'not found')
  })
})

server.listen(PORT, () => console.log(`Savor relay listening on :${PORT}, serving ${WEB}`))
