import crypto from 'node:crypto'
import { db } from './db.js'
import { API_TOKEN } from './config.js'

// Cada dispositivo que entra con la contraseña recibe su propia llave.
// Así se puede ver cuáles están abiertos y cerrar la sesión de uno sin afectar a los demás.
db.exec(`CREATE TABLE IF NOT EXISTS app_sessions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	hash TEXT UNIQUE NOT NULL,
	name TEXT,
	ip TEXT,
	created_at INTEGER,
	last_seen INTEGER
)`)

const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex')
const setting = k => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k)?.value

// La llave única de antes sigue sirviendo hasta que se cierran las demás sesiones
const legacyOpen = () => setting('legacy_token_closed') !== '1'

function deviceName(ua = '') {
	const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
		: /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Dispositivo'
	const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
		: /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : ''
	return br ? `${os} · ${br}` : os
}

const ipOf = req => String(req.get?.('x-forwarded-for') || req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
	|| req.socket?.remoteAddress || ''

export function createDevice(req) {
	const token = crypto.randomBytes(32).toString('hex')
	const now = Date.now()
	const ua = req.get?.('user-agent') || req.headers?.['user-agent'] || ''
	db.prepare('INSERT INTO app_sessions (hash, name, ip, created_at, last_seen) VALUES (?, ?, ?, ?, ?)')
		.run(sha(token), deviceName(ua), ipOf(req), now, now)
	return token
}

// Devuelve { id } si la llave es de un dispositivo, { id: null } si es la llave anterior, o null si no vale
export function checkToken(token) {
	if (!token) return null
	const row = db.prepare('SELECT id FROM app_sessions WHERE hash = ?').get(sha(token))
	if (row) return { id: row.id }
	if (token === API_TOKEN && legacyOpen()) return { id: null }
	return null
}

const seenAt = new Map()
export function touch(id, req) {
	if (!id) return
	const now = Date.now()
	if (now - (seenAt.get(id) || 0) < 60000) return
	seenAt.set(id, now)
	if (req) db.prepare('UPDATE app_sessions SET last_seen = ?, ip = ? WHERE id = ?').run(now, ipOf(req), id)
	else db.prepare('UPDATE app_sessions SET last_seen = ? WHERE id = ?').run(now, id)
}
export function touchNow(id) { if (id) { seenAt.set(id, Date.now()); db.prepare('UPDATE app_sessions SET last_seen = ? WHERE id = ?').run(Date.now(), id) } }

export function listDevices(currentId, onlineIds) {
	const rows = db.prepare('SELECT id, name, ip, created_at AS createdAt, last_seen AS lastSeen FROM app_sessions ORDER BY last_seen DESC').all()
	return {
		current: currentId,
		legacy: legacyOpen(),
		devices: rows.map(r => ({ ...r, current: r.id === currentId, online: r.id === currentId || onlineIds.has(r.id) }))
	}
}

export function removeDevice(id) {
	return db.prepare('DELETE FROM app_sessions WHERE id = ?').run(id).changes > 0
}

export function removeOthers(currentId) {
	const ids = db.prepare('SELECT id FROM app_sessions WHERE id != ?').all(currentId).map(r => r.id)
	db.prepare('DELETE FROM app_sessions WHERE id != ?').run(currentId)
	db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('legacy_token_closed', '1')").run()
	return ids
}

// Sesiones sin uso en 90 días se cierran solas
export function pruneDevices() {
	db.prepare('DELETE FROM app_sessions WHERE last_seen < ?').run(Date.now() - 90 * 864e5)
}
