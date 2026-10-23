import webpush from 'web-push'
import { state, save } from './store.js'

// Claves VAPID generadas una sola vez y guardadas con los datos
if (!state.vapid) {
	state.vapid = webpush.generateVAPIDKeys()
	save()
}
webpush.setVapidDetails('mailto:coach@example.com', state.vapid.publicKey, state.vapid.privateKey)

export const publicKey = () => state.vapid.publicKey

export function subscribe(sub) {
	if (!sub?.endpoint) throw Object.assign(new Error('Suscripción inválida'), { status: 400 })
	state.pushSubs = state.pushSubs.filter(s => s.endpoint !== sub.endpoint).concat(sub)
	save()
}

export async function notify(title, body, url = '/') {
	const payload = JSON.stringify({ title, body, url })
	const alive = []
	for (const sub of state.pushSubs) {
		try {
			await webpush.sendNotification(sub, payload)
			alive.push(sub)
		} catch (e) {
			// 404/410: el iPhone dio de baja la suscripción
			if (e.statusCode !== 404 && e.statusCode !== 410) alive.push(sub)
		}
	}
	if (alive.length !== state.pushSubs.length) {
		state.pushSubs = alive
		save()
	}
}
