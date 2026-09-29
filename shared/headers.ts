// Response headers for the daemon and the relay. The CSP allows only same-origin code; the relay's
// web app additionally opens a WebSocket to its own host, and previews and attachments are data:
// and blob: images. A strict CSP matters most on the relay, where the device key lives.
export function securityHeaders(host?: string) {
  const ws = host && /^[\w.:[\]-]+$/.test(host) ? ` ws://${host} wss://${host}` : ''
  return {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      `connect-src 'self'${ws}`,
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  }
}
