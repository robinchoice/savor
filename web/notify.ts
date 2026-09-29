import { useEffect, useState } from 'preact/hooks'
import { go, useEvent, type Project } from './api'

const KEY = 'savor-notify'

export const notificationsOn = () => 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem(KEY) !== 'off'

export function useNotificationToggle() {
  const [on, setOn] = useState(notificationsOn())
  const toggle = async () => {
    if (on) {
      localStorage.setItem(KEY, 'off')
      return setOn(false)
    }
    localStorage.removeItem(KEY)
    setOn((await Notification.requestPermission()) === 'granted')
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
export function useNotifications(currentThread: string | undefined, projects: Project[] | undefined) {
  useEvent(
    (e) => {
      if (e.type !== 'notify' || !notificationsOn()) return
      if (!document.hidden && e.threadId === currentThread) return
      show(e.title ?? 'Savor', e.body ?? '', `/p/${e.projectId}/t/${e.threadId}`, e.threadId ?? '')
    },
    [currentThread],
  )
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
