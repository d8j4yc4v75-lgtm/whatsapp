import fs from 'node:fs'
import path from 'node:path'
import webpush from 'web-push'
import { DATA_DIR } from './config.js'
import { db } from './db.js'

db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`)

// Las claves VAPID se generan una sola vez y se guardan junto a los datos
const vapidFile = path.join(DATA_DIR, 'vapid.json')
if (!fs.existsSync(vapidFile)) fs.writeFileSync(vapidFile, JSON.stringify(webpush.generateVAPIDKeys()))
const vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8'))
webpush.setVapidDetails('mailto:multiwa@example.com', vapid.publicKey, vapid.privateKey)

export const VAPID_PUBLIC_KEY = vapid.publicKey

export function saveSubscription(sub) {
	if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Suscripción inválida')
	db.prepare('INSERT OR REPLACE INTO push_subscriptions (endpoint, data, created_at) VALUES (?, ?, ?)')
		.run(sub.endpoint, JSON.stringify(sub), Date.now())
}

export function sendPush({ title, body, jid, badge }) {
	const subs = db.prepare('SELECT endpoint, data FROM push_subscriptions').all()
	const payload = JSON.stringify({ title, body, jid, badge })
	for (const s of subs) {
		webpush.sendNotification(JSON.parse(s.data), payload, { TTL: 3600, urgency: 'high' }).catch(err => {
			// 404/410 = la suscripción ya no existe
			if (err.statusCode === 404 || err.statusCode === 410) {
				db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint)
			}
		})
	}
}
