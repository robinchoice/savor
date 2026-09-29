// Minimal service worker: makes the UI installable as a PWA and routes notification clicks.
// All requests go to the network.
self.addEventListener('fetch', () => {})

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
