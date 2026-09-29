// End-to-end encrypted tunnel between a device and the daemon, carried over an untrusted relay.
//
// Keys are X25519, traffic is ChaCha20-Poly1305 with per-direction counter nonces, key derivation
// is HKDF-SHA256 over the transcript. The relay only ever sees public keys and ciphertext.
//
// Session handshake (device and daemon know each other's static keys from pairing):
//   device → daemon  hello { device: S_c, e: E_c }
//   daemon → device  welcome { e: E_d, proof: seal("ok") }
//   keys = HKDF(DH(E_c,E_d) ‖ DH(S_c,E_d) ‖ DH(E_c,S_d), transcript)
// Only the holders of S_c and S_d can derive the keys, and fresh ephemerals give forward secrecy.
//
// Pairing handshake (device knows S_d and a one-time code from the QR code shown on the desktop):
//   device → daemon  hello { e: E_c }        daemon → device  welcome { e: E_d }
//   keys = HKDF(DH(E_c,E_d) ‖ DH(E_c,S_d), salt = SHA-256(code), transcript)
//   device → daemon  seal({ name, device: S_c })   daemon → device  seal({ paired: true })
import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToUtf8, equalBytes, randomBytes, utf8ToBytes } from '@noble/ciphers/utils.js'

const PROTOCOL = utf8ToBytes('savor-relay-v1')

export const b64 = {
  enc(bytes: Uint8Array) {
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  },
  dec: (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)),
}

export interface KeyPair { sk: Uint8Array; pk: Uint8Array }

export function keypair(): KeyPair {
  const sk = x25519.utils.randomSecretKey()
  return { sk, pk: x25519.getPublicKey(sk) }
}

export const keypairFrom = (sk: Uint8Array): KeyPair => ({ sk, pk: x25519.getPublicKey(sk) })

// The relay address of a daemon is derived from its public key.
export const daemonId = (pk: Uint8Array) => b64.enc(sha256(pk).slice(0, 16))

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

  open(text: string): any {
    return JSON.parse(bytesToUtf8(chacha20poly1305(this.receiveKey, Channel.nonce(this.received++)).decrypt(b64.dec(text))))
  }
}

// ---- device side ----

export function deviceSession(device: KeyPair, daemonPk: Uint8Array) {
  const e = keypair()
  return {
    hello: { type: 'hello', mode: 'session', device: b64.enc(device.pk), e: b64.enc(e.pk) },
    // Returns the channel once the daemon proved it holds the daemon key.
    finish(welcome: { e: string; proof: string }) {
      const ed = b64.dec(welcome.e)
      const k = derive([dh(e.sk, ed), dh(device.sk, ed), dh(e.sk, daemonPk)], [daemonPk, device.pk, e.pk, ed])
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
    finish(welcome: { e: string }) {
      const ed = b64.dec(welcome.e)
      const k = derive([dh(e.sk, ed), dh(e.sk, daemonPk)], [daemonPk, e.pk, ed], pairingSalt(code))
      return new Channel(k.toDaemon, k.toDevice)
    },
  }
}

// ---- daemon side ----

export function daemonSession(daemon: KeyPair, devicePk: Uint8Array, hello: { e: string }) {
  const e = keypair()
  const ec = b64.dec(hello.e)
  const k = derive([dh(e.sk, ec), dh(e.sk, devicePk), dh(daemon.sk, ec)], [daemon.pk, devicePk, ec, e.pk])
  const channel = new Channel(k.toDevice, k.toDaemon)
  return { channel, welcome: { type: 'welcome', e: b64.enc(e.pk), proof: channel.seal('ok') } }
}

// One welcome for a pairing attempt; the channel for each open pairing code is tried in turn.
export function daemonPairing(daemon: KeyPair, hello: { e: string }, codes: string[]) {
  const e = keypair()
  const ec = b64.dec(hello.e)
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
    verify(pk: Uint8Array, mac: Uint8Array) {
      return equalBytes(hmac(sha256, dh(e.sk, pk), nonce), mac)
    },
  }
}

export const answerChallenge = (daemon: KeyPair, challenge: { e: string; nonce: string }) =>
  b64.enc(hmac(sha256, dh(daemon.sk, b64.dec(challenge.e)), b64.dec(challenge.nonce)))
