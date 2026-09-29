// End-to-end encrypted tunnel between a device and the daemon, carried over an untrusted relay.
//
// Keys are X25519, traffic is ChaCha20-Poly1305 with per-direction counter nonces, key derivation
// is HKDF-SHA256 over the transcript. The relay only ever sees ephemeral public keys, the daemon's
// public key and ciphertext.
//
// Session handshake (device and daemon know each other's static keys from pairing):
//   device → daemon  hello { e: E_c, device: Enc(DH(E_c,S_d), S_c) }   (hides which device connects)
//   daemon → device  welcome { e: E_d, proof: seal("ok") }
//   keys = HKDF(DH(E_c,E_d) ‖ DH(S_c,E_d) ‖ DH(E_c,S_d), transcript)
// Only the holders of S_c and S_d can derive the keys, and fresh ephemerals give forward secrecy.
//
// Pairing handshake (device knows S_d and a one-time code from the QR code shown on the desktop):
//   device → daemon  hello { e: E_c }        daemon → device  welcome { e: E_d }
//   keys = HKDF(DH(E_c,E_d) ‖ DH(E_c,S_d), salt = SHA-256(code), transcript)
//   device → daemon  seal({ name, device: S_c })   daemon → device  seal({ paired: true })
// The welcome carries no proof in this mode, so a relay can't test code guesses offline.
//
// Everything decoded from the wire goes through publicKey()/b64.dec(), which throw on bad input;
// callers treat any throw as a failed handshake.
import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToUtf8, equalBytes, randomBytes, utf8ToBytes } from '@noble/ciphers/utils.js'

// v2: device key hidden in the hello. Relay web app and daemon must speak the same version.
const PROTOCOL = utf8ToBytes('savor-relay-v2')

export const b64 = {
  enc(bytes: Uint8Array) {
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  },
  dec(text: unknown) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Invalid base64')
    return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
  },
}

// A peer's X25519 public key from the wire.
export function publicKey(text: unknown) {
  const key = b64.dec(text)
  if (key.length !== 32) throw new Error('Invalid public key')
  return key
}

export interface KeyPair { sk: Uint8Array; pk: Uint8Array }

export function keypair(): KeyPair {
  const sk = x25519.utils.randomSecretKey()
  return { sk, pk: x25519.getPublicKey(sk) }
}

export const keypairFrom = (sk: Uint8Array): KeyPair => ({ sk, pk: x25519.getPublicKey(sk) })

// A device's long-term key. In browsers the private half can be a non-extractable WebCrypto key,
// so only the DH operation is exposed.
export interface DeviceKey { pk: Uint8Array; dh(peer: Uint8Array): Promise<Uint8Array> }

export const rawDeviceKey = (kp: KeyPair): DeviceKey => ({ pk: kp.pk, dh: async (peer) => dh(kp.sk, peer) })

// The relay address of a daemon is derived from its public key.
export const daemonId = (pk: Uint8Array) => b64.enc(sha256(pk).slice(0, 16))

// noble rejects low-order points (all-zero shared secrets) by throwing.
const dh = (sk: Uint8Array, pk: Uint8Array) => x25519.getSharedSecret(sk, pk)

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) out.set(p, (i += p.length) - p.length)
  return out
}

function derive(ikm: Uint8Array[], transcript: Uint8Array[], salt?: Uint8Array) {
  const okm = hkdf(sha256, concat(...ikm), salt, concat(PROTOCOL, ...transcript), 64)
  return { toDaemon: okm.slice(0, 32), toDevice: okm.slice(32) }
}

// Encrypts the device's static key in the hello; the key is unique per ephemeral, so nonce 0 is safe.
const helloCipher = (shared: Uint8Array, daemonPk: Uint8Array, ephemeralPk: Uint8Array) =>
  chacha20poly1305(hkdf(sha256, shared, undefined, concat(PROTOCOL, utf8ToBytes('hello'), daemonPk, ephemeralPk), 32), new Uint8Array(12))

export const pairingSalt = (code: string) => sha256(utf8ToBytes(code.trim().toUpperCase()))

// Encrypted, ordered message stream. A tampered, replayed or reordered message fails to open.
export class Channel {
  private sent = 0n
  private received = 0n
  constructor(
    private sendKey: Uint8Array,
    private receiveKey: Uint8Array,
  ) {}

  private static nonce(n: bigint) {
    const nonce = new Uint8Array(12)
    new DataView(nonce.buffer).setBigUint64(4, n)
    return nonce
  }

  seal(message: unknown): string {
    return b64.enc(chacha20poly1305(this.sendKey, Channel.nonce(this.sent++)).encrypt(utf8ToBytes(JSON.stringify(message))))
  }

  open(text: unknown): any {
    return JSON.parse(bytesToUtf8(chacha20poly1305(this.receiveKey, Channel.nonce(this.received++)).decrypt(b64.dec(text))))
  }
}

// ---- device side ----

export function deviceSession(device: DeviceKey, daemonPk: Uint8Array) {
  const e = keypair()
  const hidden = helloCipher(dh(e.sk, daemonPk), daemonPk, e.pk).encrypt(device.pk)
  return {
    hello: { type: 'hello', mode: 'session', e: b64.enc(e.pk), device: b64.enc(hidden) },
    // Resolves to the channel once the daemon proved it holds the daemon key.
    async finish(welcome: { e: unknown; proof: unknown }) {
      const ed = publicKey(welcome.e)
      const k = derive([dh(e.sk, ed), await device.dh(ed), dh(e.sk, daemonPk)], [daemonPk, device.pk, e.pk, ed])
      const channel = new Channel(k.toDaemon, k.toDevice)
      if (channel.open(welcome.proof) !== 'ok') throw new Error('Daemon proof mismatch')
      return channel
    },
  }
}

export function devicePairing(daemonPk: Uint8Array, code: string) {
  const e = keypair()
  return {
    hello: { type: 'hello', mode: 'pair', e: b64.enc(e.pk) },
    finish(welcome: { e: unknown }) {
      const ed = publicKey(welcome.e)
      const k = derive([dh(e.sk, ed), dh(e.sk, daemonPk)], [daemonPk, e.pk, ed], pairingSalt(code))
      return new Channel(k.toDaemon, k.toDevice)
    },
  }
}

// ---- daemon side ----

// Which device is connecting; only the daemon can read it.
export function openHello(daemon: KeyPair, hello: { e: unknown; device: unknown }) {
  const ec = publicKey(hello.e)
  const pk = helloCipher(dh(daemon.sk, ec), daemon.pk, ec).decrypt(b64.dec(hello.device))
  if (pk.length !== 32) throw new Error('Invalid device key')
  return pk
}

export function daemonSession(daemon: KeyPair, devicePk: Uint8Array, hello: { e: unknown }) {
  const e = keypair()
  const ec = publicKey(hello.e)
  const k = derive([dh(e.sk, ec), dh(e.sk, devicePk), dh(daemon.sk, ec)], [daemon.pk, devicePk, ec, e.pk])
  const channel = new Channel(k.toDevice, k.toDaemon)
  return { channel, welcome: { type: 'welcome', e: b64.enc(e.pk), proof: channel.seal('ok') } }
}

// One welcome for a pairing attempt; the channel for each open pairing code is tried in turn.
export function daemonPairing(daemon: KeyPair, hello: { e: unknown }, codes: string[]) {
  const e = keypair()
  const ec = publicKey(hello.e)
  const ikm = [dh(e.sk, ec), dh(daemon.sk, ec)]
  const transcript = [daemon.pk, ec, e.pk]
  return {
    welcome: { type: 'welcome', e: b64.enc(e.pk) },
    candidates: codes.map((code) => {
      const k = derive(ikm, transcript, pairingSalt(code))
      return { code, channel: new Channel(k.toDevice, k.toDaemon) }
    }),
  }
}

// ---- daemon ↔ relay: prove possession of the daemon key without revealing it ----

export function relayChallenge() {
  const e = keypair()
  const nonce = randomBytes(32)
  return {
    challenge: { t: 'challenge', e: b64.enc(e.pk), nonce: b64.enc(nonce) },
    verify(pk: Uint8Array, mac: unknown) {
      try {
        const expected = hmac(sha256, dh(e.sk, pk), nonce)
        const given = b64.dec(mac)
        return given.length === expected.length && equalBytes(expected, given)
      } catch {
        return false
      }
    },
  }
}

export const answerChallenge = (daemon: KeyPair, challenge: { e: unknown; nonce: unknown }) =>
  b64.enc(hmac(sha256, dh(daemon.sk, publicKey(challenge.e)), b64.dec(challenge.nonce)))
