import crypto from 'node:crypto'

// Response headers for the daemon and the relay. The CSP allows only same-origin code; the relay's
// web app additionally opens a WebSocket to its own host, and previews and attachments are data:
// and blob: images. A strict CSP matters most on the relay, where the device key lives. The editors
// (CodeMirror, TipTap) add their own <style> elements, which the per-page nonce lets through.
export function securityHeaders(host?: string, nonce?: string) {
  const ws = host && /^[\w.:[\]-]+$/.test(host) ? ` ws://${host} wss://${host}` : ''
  return {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      `style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}`,
      "img-src 'self' data: blob:",
      `connect-src 'self'${ws} https://glitchtip.diespaetzles.lol`,
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
    'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
  }
}

export const newNonce = () => crypto.randomBytes(16).toString('base64')

// The page learns its nonce from a meta tag, which the editors pass on to their style elements.
export const withNonce = (html: string, nonce: string) => html.replace('</head>', `<meta name="csp-nonce" content="${nonce}"></head>`)
