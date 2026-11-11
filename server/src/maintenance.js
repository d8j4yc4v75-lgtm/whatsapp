import fs from 'node:fs'
import path from 'node:path'
import { db } from './db.js'
import { DATA_DIR } from './config.js'
import { MEDIA_DIR, note } from './sessions.js'

// Mantiene el disco con espacio: si se llena, WhatsApp no puede guardar sus llaves y las sesiones se caen
const AUTH_DIR = path.join(DATA_DIR, 'auth')
const DAY = 864e5

function walk(dir) {
	let size = 0
	let files = 0
	if (!fs.existsSync(dir)) return { size, files }
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			const r = walk(p)
			size += r.size
			files += r.files
		} else {
			try { size += fs.statSync(p).size; files++ } catch {}
		}
	}
	return { size, files }
}

export function diskInfo() {
	const mb = n => Math.round(n / 1048576 * 10) / 10
	let total = null
	let free = null
	try {
		const s = fs.statfsSync(DATA_DIR)
		total = mb(s.blocks * s.bsize)
		free = mb(s.bavail * s.bsize)
	} catch {}
	const parts = {}
	for (const name of fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : []) {
		const p = path.join(DATA_DIR, name)
		const r = fs.statSync(p).isDirectory() ? walk(p) : { size: fs.statSync(p).size, files: 1 }
		parts[name] = { mb: mb(r.size), files: r.files }
	}
	return { totalMb: total, freeMb: free, parts }
}

function freeRatio() {
	try {
		const s = fs.statfsSync(DATA_DIR)
		return s.bavail / s.blocks
	} catch {
		return 1
	}
}

/** Borra archivos multimedia viejos (se pueden volver a descargar de WhatsApp mientras existan) */
function pruneMedia(olderThanMs) {
	let removed = 0
	const rows = db.prepare('SELECT account_id, id, media_path FROM messages WHERE media_path IS NOT NULL AND ts < ?').all(Date.now() - olderThanMs)
	const clear = db.prepare('UPDATE messages SET media_path = NULL WHERE account_id = ? AND id = ?')
	for (const r of rows) {
		try {
			fs.rmSync(r.media_path, { force: true })
			fs.rmSync(r.media_path.replace(/\.[^.]+$/, '') + '.play.m4a', { force: true })
		} catch {}
		clear.run(r.account_id, r.id)
		removed++
	}
	return removed
}

// Días que se conservan fotos, audios y documentos descargados (ajustable en Ajustes › Almacenamiento)
export function mediaDays() {
	const v = Number(db.prepare("SELECT value FROM app_settings WHERE key = 'media_days'").get()?.value)
	return v >= 1 && v <= 365 ? v : 14
}
export function setMediaDays(days) {
	const d = Math.max(1, Math.min(365, Math.floor(Number(days) || 14)))
	db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('media_days', ?)").run(String(d))
	cleanup()
	return d
}

// Chats sin actividad: se borran después de X meses (0 = nunca). Así la base de datos no crece sin fin.
export function chatMonths() {
	const v = Number(db.prepare("SELECT value FROM app_settings WHERE key = 'chat_months'").get()?.value)
	return v >= 1 && v <= 60 ? Math.floor(v) : 0
}
export function setChatMonths(months) {
	const m = Math.max(0, Math.min(60, Math.floor(Number(months) || 0)))
	db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('chat_months', ?)").run(String(m))
	return m
}
function pruneChats() {
	const months = chatMonths()
	if (!months) return 0
	const cut = Date.now() - months * 30 * DAY
	// Se conservan los chats con recordatorio pendiente
	const old = db.prepare(`
		SELECT c.account_id, c.jid FROM chats c
		WHERE c.last_ts < ? AND c.jid NOT LIKE '%@g.us'
		AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.account_id = c.account_id AND m.jid = c.jid AND m.ts >= ?)
		AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.conv_key = c.account_id || ':' || c.jid AND r.done = 0)
		LIMIT 2000`).all(cut, cut)
	const files = db.prepare('SELECT media_path FROM messages WHERE account_id = ? AND jid = ? AND media_path IS NOT NULL')
	const run = db.transaction(rows => {
		for (const { account_id, jid } of rows) {
			const key = `${account_id}:${jid}`
			for (const f of files.all(account_id, jid)) { try { fs.rmSync(f.media_path, { force: true }) } catch {} }
			db.prepare('DELETE FROM messages WHERE account_id = ? AND jid = ?').run(account_id, jid)
			db.prepare('DELETE FROM chats WHERE account_id = ? AND jid = ?').run(account_id, jid)
			db.prepare('DELETE FROM conversation_notes WHERE conv_key = ?').run(key)
			db.prepare('DELETE FROM reminders WHERE conv_key = ?').run(key)
			db.prepare('DELETE FROM conversation_labels WHERE jid = ?').run(key)
		}
	})
	run(old)
	return old.length
}

export function cleanup() {
	try {
		// Copias de sesiones cerradas que guardaban versiones anteriores
		if (fs.existsSync(AUTH_DIR)) {
			for (const name of fs.readdirSync(AUTH_DIR)) {
				if (name.includes('-logout-')) fs.rmSync(path.join(AUTH_DIR, name), { recursive: true, force: true })
			}
		}
		let removed = pruneMedia(mediaDays() * DAY)
		if (freeRatio() < 0.2) removed += pruneMedia(DAY)
		if (freeRatio() < 0.1) removed += pruneMedia(0)
		const chats = pruneChats()
		if (chats) note(null, 'cleanup', `chats ${chats}`)
		db.pragma('wal_checkpoint(TRUNCATE)')
		if (removed) note(null, 'cleanup', `media ${removed}`)
	} catch (e) {
		note(null, 'cleanup-error', e.message)
	}
}

export function startMaintenance() {
	cleanup()
	setInterval(cleanup, 3600000)
}
