// Minimal service worker: makes the UI installable as a PWA, shows Web Push from the daemon and
// routes notification clicks.
// All requests go to the network.
self.addEventListener('fetch', () => {})

// The daemon only pushes while Savor is not on screen; the same tag replaces the page's own notification.
self.addEventListener('push', (e) => {
  const { title, body, tag, hash } = e.data?.json() ?? {}
  e.waitUntil(self.registration.showNotification(title ?? 'Savor', { body, tag, icon: '/icon.svg', data: { hash } }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const hash = e.notification.data?.hash ?? '/'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      if (!windows.length) return self.clients.openWindow(`/#${hash}`)
      windows[0].postMessage({ type: 'open', hash })
      return windows[0].focus()
    }),
  )
})
