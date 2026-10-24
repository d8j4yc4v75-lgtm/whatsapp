import { db } from './db.js'

// «Salud» de cada número de WhatsApp normal: rechazos recientes y antigüedad de la vinculación.
// Sirve para el semáforo y para subir poco a poco el límite diario de los envíos en modo seguro.
try { db.exec('ALTER TABLE accounts ADD COLUMN linked_at INTEGER') } catch {}

const DAY = 864e5

const q = {
	account: db.prepare('SELECT * FROM accounts WHERE id = ?'),
	rejections: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND from_me = 1 AND status = 0 AND ts > ?')
}

export function markLinked(accountId) {
	db.prepare('UPDATE accounts SET linked_at = COALESCE(linked_at, ?) WHERE id = ?').run(Date.now(), accountId)
}

export function markUnlinked(accountId) {
	db.prepare('UPDATE accounts SET linked_at = NULL WHERE id = ?').run(accountId)
}

/** Límite diario sugerido según los días desde que se vinculó el número */
function rampLimit(ageDays) {
	if (ageDays < 3) return 10
	if (ageDays < 5) return 15
	if (ageDays < 7) return 20
	return 30
}

export function accountHealth(accountId, status) {
	const a = q.account.get(accountId)
	if (!a || a.kind === 'cloud') return null
	const now = Date.now()
	const r24 = q.rejections.get(accountId, now - DAY).n
	const r72 = q.rejections.get(accountId, now - 3 * DAY).n
	const ageDays = a.linked_at ? Math.floor((now - a.linked_at) / DAY) : 0
	const st = status || a.status
	let level
	let reason
	let suggestedDaily = rampLimit(ageDays)
	if (st !== 'connected') {
		level = 'red'
		reason = 'Desconectado'
		suggestedDaily = 0
	} else if (r24 >= 2) {
		level = 'red'
		reason = `WhatsApp rechazó ${r24} mensajes en las últimas 24 h. Déjalo descansar unos días.`
		suggestedDaily = 0
	} else if (r72 >= 1) {
		level = 'yellow'
		reason = 'Tuvo rechazos en los últimos 3 días. Envía poco.'
		suggestedDaily = Math.max(5, Math.floor(suggestedDaily / 2))
	} else if (ageDays < 3) {
		level = 'yellow'
		reason = `Vinculado hace ${ageDays} día(s): se está calentando.`
	} else {
		level = 'green'
		reason = 'Sin rechazos recientes.'
	}
	return { level, reason, rejections24h: r24, rejections72h: r72, ageDays, suggestedDaily }
}
