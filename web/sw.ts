// Service worker: makes the UI installable as a PWA, shows Web Push from the daemon, answers questions
// from the notification and routes notification clicks. Built on its own by esbuild into sw.js.
// All requests go to the network.
import { direct, remote, storedProfile, type Transport } from './transport'

const sw = self as any

interface Question { title: string; options: { id: string; label: string }[]; recommended: number | null; approval?: string; decision?: string }
interface Push { title: string; body: string; status: string; tag: string; hash: string; badge: number; question?: Question }
interface Data { push: Push; held?: string }

sw.addEventListener('fetch', () => {})

const setBadge = (n: number) => (n ? sw.navigator.setAppBadge?.(n) : sw.navigator.clearAppBadge?.())?.catch?.(() => {})

// Android shows two buttons at most: the recommended option and "Why?", or both options when there are two.
function actions(q?: Question) {
  if (!q) return []
  const option = (i: number) => ({ action: `o${i}`, title: q.options[i].label })
  if (q.recommended != null && q.options[q.recommended]) return [option(q.recommended), { action: 'why', title: 'Why?' }]
  return q.options.length === 2 ? [option(0), option(1)] : []
}

const show = (title: string, body: string, data: Data, extra: object = {}) =>
  sw.registration.showNotification(title, { body, tag: data.push.tag, icon: '/icon.svg', data, ...extra })

function notice(p: Push) {
  const body = p.question ? `${p.question.title}${p.question.recommended != null && p.question.options[p.question.recommended] ? `\nRecommended: ${p.question.options[p.question.recommended].label}` : ''}` : p.body
  return show(`${p.title} · ${p.status}`, body, { push: p }, { actions: actions(p.question) })
}

// Seen or answered on another device: its notification goes away here too. Safari ends subscriptions
// whose pushes show nothing, so there the notification turns into a quiet receipt instead.
async function dismiss(tag: string) {
  const shown: Notification[] = await sw.registration.getNotifications({ tag })
  const open = shown.filter((n) => !(n.data as Data | undefined)?.held)
  if (!open.length) return
  const sub = await sw.registration.pushManager.getSubscription()
  if (!sub?.endpoint.includes('push.apple.com')) return open.forEach((n) => n.close())
  return show((open[0].data as Data).push.title, 'Seen on another device.', open[0].data, { silent: true })
}

sw.addEventListener('push', (e: any) => {
  const p = e.data?.json() ?? {}
  setBadge(p.badge ?? 0)
  e.waitUntil(p.dismiss ? dismiss(p.dismiss) : notice(p))
})

// The page's transport: through the relay tunnel when this device was paired through it, else directly.
async function transport(): Promise<Transport> {
  const profile = await storedProfile().catch(() => undefined)
  return profile ? remote(profile, () => {}) : direct
}

async function call(method: string, path: string, body?: object) {
  const r = await (await transport()).request(method, `/api${path}`, body && JSON.stringify(body))
  const data = r.body ? JSON.parse(r.body) : {}
  if (r.status >= 400) throw new Error(data.error ?? `Error ${r.status}`)
  return data
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const base = (p: Push) => p.hash.replace(/^\/p\//, '/projects/').replace('/t/', '/threads/')

async function answer(p: Push, i: number) {
  const q = p.question!
  const option = q.options[i]
  try {
    const { id, ms } = await call('POST', `${base(p)}/held`, q.approval ? { approval: q.approval, choice: option.id } : { decision: q.decision, selected: i })
    await show(`Answered: ${option.label}`, `Goes to the agent in ${Math.round(ms / 1000)} s.`, { push: p, held: id }, { actions: [{ action: 'undo', title: 'Undo' }, { action: 'why', title: 'Why?' }] })
    await sleep(ms)
    const still: Notification[] = await sw.registration.getNotifications({ tag: p.tag })
    if (still.some((n) => (n.data as Data).held === id)) await show(`Answered: ${option.label}`, 'Sent to the agent.', { push: p, held: id }, { silent: true })
  } catch (e) {
    await show(`${p.title} · Not answered`, `${(e as Error).message} Tap to open the conversation.`, { push: { ...p, question: undefined } })
  }
}

async function undo(data: Data) {
  try {
    await call('DELETE', `/held/${data.held}`)
    await notice(data.push)
  } catch (e) {
    await show(`${data.push.title} · Too late to undo`, (e as Error).message, { push: { ...data.push, question: undefined } })
  }
}

function open(hash: string) {
  return sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows: any[]) => {
    if (!windows.length) return sw.clients.openWindow(`/#${hash}`)
    windows[0].postMessage({ type: 'open', hash })
    return windows[0].focus()
  })
}

sw.addEventListener('notificationclick', (e: any) => {
  const n: Notification = e.notification
  const data = n.data as Data | undefined
  n.close()
  const action: string = e.action
  if (data && action.startsWith('o')) return e.waitUntil(answer(data.push, Number(action.slice(1))))
  if (data && action === 'undo') return e.waitUntil(undo(data))
  // "Why?" and the notification itself open the conversation, where the agent's reasoning stands with the question.
  e.waitUntil(open(data?.push?.hash ?? '/'))
})
