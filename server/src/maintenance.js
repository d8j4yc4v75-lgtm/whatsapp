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

export function cleanup() {
	try {
		// Copias de sesiones cerradas que guardaban versiones anteriores
		if (fs.existsSync(AUTH_DIR)) {
			for (const name of fs.readdirSync(AUTH_DIR)) {
				if (name.includes('-logout-')) fs.rmSync(path.join(AUTH_DIR, name), { recursive: true, force: true })
			}
		}
		let removed = pruneMedia(14 * DAY)
		if (freeRatio() < 0.2) removed += pruneMedia(DAY)
		if (freeRatio() < 0.1) removed += pruneMedia(0)
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
