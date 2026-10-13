// What keeps Savor from working right now, in one list, after Tailscale's health warnings: each with a
// severity and exactly one action. A warning only shows once its cause has lasted `delay`, so a short
// drop (the relay reconnecting) doesn't flicker in the status bar.
import { emit } from './events.js'
import { listAgents } from './providers.js'
import { relayStatus } from './relay-client.js'
import { previewBrowserFailed } from './browser.js'
import * as store from './store.js'

export interface Warning {
  code: string
  severity: 'high' | 'medium' | 'low'
  title: string
  text: string
  // A command to run in a terminal, a page of the UI, or a call to the API.
  action: { label: string; command?: string; href?: string; post?: string; account?: true }
}

const RELAY_DELAY = Number(process.env.SAVOR_HEALTH_RELAY_MS ?? 30_000)

// When each active warning's cause started, and the timers that announce it once it is due.
const since = new Map<string, number>()
const due = new Map<string, NodeJS.Timeout>()

export async function listWarnings(updateWaiting: boolean): Promise<Warning[]> {
  const found: (Warning & { delay?: number })[] = []
  const agent = store.state().agent ?? store.defaultAgent()
  const info = (await listAgents()).find((a) => a.id === agent.provider)
  if (info && !info.installed)
    found.push({ code: 'agent-missing', severity: 'high', title: `${info.name} is not installed`, text: `New projects start with ${info.name}, but it is not on this computer. Install it or choose another agent.`, action: { label: 'Choose agent', account: true } })
  else if (info?.signedIn === false)
    found.push({ code: 'agent-signed-out', severity: 'high', title: `${info.name} is signed out`, text: `New conversations with ${info.name} fail until you sign in again. Run this in a terminal:`, action: { label: 'Sign in', command: info.signIn } })
  const relay = relayStatus()
  if (relay.enabled && relay.state !== 'online')
    found.push({ code: 'relay-offline', severity: 'medium', title: 'Relay not connected', text: `Paired devices can't reach this computer through the relay${relay.error ? `: ${relay.error}` : '.'}`, action: { label: 'Open remote access', href: '#/devices' }, delay: RELAY_DELAY })
  if (previewBrowserFailed())
    found.push({ code: 'chromium-missing', severity: 'medium', title: 'Chromium for the preview is missing', text: 'Savor could not download Chromium, so the preview cannot open pages. Install it with:', action: { label: 'Install', command: 'npx playwright install chromium' } })
  if (updateWaiting)
    found.push({ code: 'update-ready', severity: 'low', title: 'Update ready', text: 'A new version of Savor is installed and starts with the next restart.', action: { label: 'Restart now', post: '/restart' } })

  for (const code of since.keys())
    if (!found.some((w) => w.code === code)) {
      since.delete(code)
      clearTimeout(due.get(code))
      due.delete(code)
    }
  const now = Date.now()
  return found
    .filter(({ code, delay = 0 }) => {
      if (!since.has(code)) since.set(code, now)
      const left = since.get(code)! + delay - now
      if (left > 0 && !due.has(code)) due.set(code, setTimeout(() => (due.delete(code), emit({ type: 'health' })), left))
      return left <= 0
    })
    .map(({ delay, ...w }) => w)
}
