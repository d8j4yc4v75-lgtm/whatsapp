// Notificaciones de la evaluación diaria
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('push', e => {
	const data = e.data ? e.data.json() : {}
	e.waitUntil(self.registration.showNotification(data.title || 'Coach', {
		body: data.body || '',
		icon: '/icons/icon-192.png',
		badge: '/icons/icon-192.png',
		data: { url: data.url || '/' },
	}))
})

self.addEventListener('notificationclick', e => {
	e.notification.close()
	const url = e.notification.data?.url || '/'
	e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => {
		for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus() }
		return self.clients.openWindow(url)
	}))
})
