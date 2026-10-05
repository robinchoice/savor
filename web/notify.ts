import { useEffect, useState } from 'preact/hooks'
import { api, go, useEvent, type Me, type Project } from './api'
import { b64 } from '../shared/tunnel'

const KEY = 'savor-notify'
let pushing = false

// A paired device also gets Web Push from the daemon, so it hears from Savor while the app is closed.
async function syncPush(on: boolean) {
  const reg = await navigator.serviceWorker?.ready
  if (!reg?.pushManager) return
  let sub = await reg.pushManager.getSubscription()
  if (!on) {
    pushing = false
    if (!sub) return
    await sub.unsubscribe()
    return api('DELETE', '/push')
  }
  const { publicKey } = await api<{ publicKey: string | null }>('GET', '/push')
  if (!publicKey) return
  // A subscription made for another key (the daemon's state was reset) has to be replaced.
  if (sub && b64.enc(new Uint8Array(sub.options.applicationServerKey!)) !== publicKey) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64.dec(publicKey) })
  await api('PUT', '/push', sub.toJSON())
  pushing = true
  reportVisible()
}

// While Savor is on screen the page notifies from the event stream, so the daemon holds back pushes.
const reportVisible = () => pushing && api('POST', '/push/visible', { visible: !document.hidden }).catch(() => {})

export const notificationsOn = () => 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem(KEY) !== 'off'

export function useNotificationToggle(remote: boolean) {
  const [on, setOn] = useState(notificationsOn())
  const toggle = async () => {
    if (on) {
      localStorage.setItem(KEY, 'off')
      setOn(false)
      if (remote) syncPush(false).catch(console.error)
      return
    }
    localStorage.removeItem(KEY)
    const granted = (await Notification.requestPermission()) === 'granted'
    setOn(granted)
    if (granted && remote) syncPush(true).catch(console.error)
  }
  return ['Notification' in window, on, toggle] as const
}

async function show(title: string, body: string, hash: string, tag: string) {
  const options = { body, tag, icon: '/icon.svg', data: { hash } }
  try {
    const n = new Notification(title, options)
    n.onclick = () => {
      window.focus()
      go(hash)
      n.close()
    }
  } catch {
    // Mobile browsers only allow notifications through the service worker.
    ;(await navigator.serviceWorker?.ready)?.showNotification(title, options)
  }
}

// Notify when an agent finishes or needs you, unless that conversation is already on screen.
export function useNotifications(currentThread: string | undefined, projects: Project[] | undefined, me: Me | null | false) {
  useEvent(
    (e) => {
      if (e.type !== 'notify' || !notificationsOn()) return
      if (!document.hidden && e.threadId === currentThread) return
      show(e.title ?? 'Savor', e.body ?? '', `/p/${e.projectId}/t/${e.threadId}`, e.threadId ?? '')
    },
    [currentThread],
  )
  const remote = !!me && me.origin === 'remote'
  useEffect(() => {
    if (!remote) return
    if (notificationsOn()) syncPush(true).catch(console.error)
    document.addEventListener('visibilitychange', reportVisible)
    const timer = setInterval(() => !document.hidden && reportVisible(), 30_000)
    return () => {
      document.removeEventListener('visibilitychange', reportVisible)
      clearInterval(timer)
    }
  }, [remote])
  useEffect(() => {
    const onMessage = (e: MessageEvent) => e.data?.type === 'open' && go(e.data.hash)
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [])
  // Unread + needs-you count on the tab title and the installed app icon.
  useEffect(() => {
    const n = projects?.reduce((sum, p) => sum + p.counts.unread + p.counts.needsYou, 0) ?? 0
    document.title = n ? `(${n}) Savor` : 'Savor'
    if (n) navigator.setAppBadge?.(n)
    else navigator.clearAppBadge?.()
  }, [projects])
}
