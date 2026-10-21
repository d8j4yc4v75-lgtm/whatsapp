import http2 from 'node:http2'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { APNS } from './config.js'
import { db } from './db.js'

const enabled = Boolean(APNS.keyFile && APNS.keyId && APNS.teamId && APNS.bundleId)
let key
let jwt
let jwtAt = 0

const b64url = buf => Buffer.from(buf).toString('base64url')

function getJwt() {
	// Apple pide renovar el token entre 20 y 60 minutos
	if (jwt && Date.now() - jwtAt < 40 * 60 * 1000) return jwt
	key ??= fs.readFileSync(APNS.keyFile, 'utf8')
	const header = b64url(JSON.stringify({ alg: 'ES256', kid: APNS.keyId }))
	const payload = b64url(JSON.stringify({ iss: APNS.teamId, iat: Math.floor(Date.now() / 1000) }))
	const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' })
	jwt = `${header}.${payload}.${b64url(sig)}`
	jwtAt = Date.now()
	return jwt
}

export function pushEnabled() {
	return enabled
}

export function sendPush({ title, body, jid, badge }) {
	if (!enabled) return
	const tokens = db.prepare('SELECT token FROM devices').all().map(r => r.token)
	if (!tokens.length) return
	const host = APNS.production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com'
	const client = http2.connect(host)
	client.on('error', err => console.error('APNs:', err.message))
	const payload = JSON.stringify({
		aps: { alert: { title, body }, sound: 'default', badge, 'thread-id': jid },
		jid
	})
	let pending = tokens.length
	for (const token of tokens) {
		const req = client.request({
			':method': 'POST',
			':path': `/3/device/${token}`,
			authorization: `bearer ${getJwt()}`,
			'apns-topic': APNS.bundleId,
			'apns-push-type': 'alert'
		})
		let status
		req.on('response', h => { status = h[':status'] })
		req.on('data', () => {})
		req.on('end', () => {
			// 410 = token ya no válido
			if (status === 410 || status === 400) db.prepare('DELETE FROM devices WHERE token = ?').run(token)
			if (--pending === 0) client.close()
		})
		req.end(payload)
	}
}
