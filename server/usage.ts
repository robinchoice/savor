// The anonymous usage ping: at most once a day, the desktop app tells the relay a random ID made on
// this computer, the version, the platform and whether this is one of the maker's own installations
// (`internal` in state.json). Nothing else. The desktop app sets SAVOR_USAGE_URL, so a daemon run
// from source or in tests sends nothing; the setting "Count this installation" turns it off.
import crypto from 'node:crypto'
import * as store from './store.js'
import { VERSION } from './config.js'

const URL = process.env.SAVOR_USAGE_URL
const DAY = 86_400_000

export const usageAvailable = () => !!URL

async function ping() {
  let s = store.state()
  if (s.usagePing === false || (s.usagePingedAt && Date.now() - Date.parse(s.usagePingedAt) < DAY)) return
  if (!s.installId) {
    s.installId = crypto.randomBytes(16).toString('base64url')
    store.saveState(s)
  }
  const body = { id: s.installId, version: VERSION, platform: process.platform, internal: s.internal === true }
  const sent = await fetch(URL!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }).then(
    (r) => r.ok,
    () => false,
  )
  if (!sent) return
  s = store.state()
  s.usagePingedAt = new Date().toISOString()
  store.saveState(s)
}

export function startUsagePing() {
  if (!URL) return
  ping()
  setInterval(ping, 3_600_000).unref()
}
