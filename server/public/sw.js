// Service worker: solo maneja notificaciones push (la app siempre se carga del servidor)
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('push', event => {
	const data = event.data ? event.data.json() : {}
	event.waitUntil((async () => {
		if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
			await self.navigator.setAppBadge(data.badge).catch(() => {})
		}
		const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
		const viewing = windows.some(w => w.visibilityState === 'visible' && w.url.includes('#/chat/' + encodeURIComponent(data.jid)))
		if (viewing) return
		await self.registration.showNotification(data.title || 'MultiWA', {
			body: data.body || '',
			tag: data.jid,
			renotify: true,
			icon: '/icons/icon-192.png',
			badge: '/icons/icon-192.png',
			data: { jid: data.jid }
		})
	})())
})

self.addEventListener('notificationclick', event => {
	event.notification.close()
	const url = '/#/chat/' + encodeURIComponent(event.notification.data?.jid || '')
	event.waitUntil((async () => {
		const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
		for (const w of windows) {
			await w.focus()
			w.postMessage({ type: 'open', jid: event.notification.data?.jid })
			return
		}
		await self.clients.openWindow(url)
	})())
})
