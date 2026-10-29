import { db } from './db.js'

// «Salud» de cada número de WhatsApp normal: rechazos recientes y antigüedad de la vinculación.
// Sirve para el semáforo y para subir poco a poco el límite diario de los envíos en modo seguro.
for (const sql of [
	'ALTER TABLE accounts ADD COLUMN linked_at INTEGER',
	'ALTER TABLE accounts ADD COLUMN rest_until INTEGER',
	'ALTER TABLE accounts ADD COLUMN rest_ended_at INTEGER'
]) {
	try { db.exec(sql) } catch {}
}

const DAY = 864e5

const q = {
	account: db.prepare('SELECT * FROM accounts WHERE id = ?'),
	rejections: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND from_me = 1 AND status = 0 AND ts > ?')
}

const REST_DAYS = Number(process.env.REST_DAYS || 5)

/** Pone a descansar un número: los envíos masivos no lo usan hasta la fecha indicada */
export function setRest(accountId, days) {
	if (days > 0) {
		db.prepare('UPDATE accounts SET rest_until = ? WHERE id = ?').run(Date.now() + days * DAY, accountId)
	} else {
		db.prepare('UPDATE accounts SET rest_until = NULL, rest_ended_at = ? WHERE id = ?').run(Date.now(), accountId)
	}
}

/** Si WhatsApp le rechazó 2 o más mensajes en 24 h, el número descansa solo */
export function maybeRest(accountId) {
	const a = q.account.get(accountId)
	if (!a || (a.rest_until && a.rest_until > Date.now())) return false
	if (q.rejections.get(accountId, Date.now() - DAY).n < 2) return false
	setRest(accountId, REST_DAYS)
	return true
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

const rrCache = new Map()
/** De las personas a las que este número les escribió en envíos masivos (3 días), cuántas contestaron */
export function replyStats(accountId) {
	const hit = rrCache.get(accountId)
	if (hit && Date.now() - hit.at < 120000) return hit.v
	let v = { sent: 0, rate: 1 }
	try {
		const r = db.prepare(`
			SELECT COUNT(*) AS sent, SUM(CASE WHEN EXISTS (
				SELECT 1 FROM messages m WHERE m.account_id = ci.sent_by AND m.jid = ci.jid AND m.from_me = 0 AND m.ts > ci.sent_at
			) THEN 1 ELSE 0 END) AS replied
			FROM campaign_items ci WHERE ci.sent_by = ? AND ci.status = 'sent' AND ci.sent_at > ?`).get(accountId, Date.now() - 3 * DAY)
		v = { sent: r.sent || 0, rate: r.sent ? (r.replied || 0) / r.sent : 1 }
	} catch {}
	rrCache.set(accountId, { at: Date.now(), v })
	return v
}

export function accountHealth(accountId, status) {
	const a = q.account.get(accountId)
	if (!a || a.kind === 'cloud') return null
	const now = Date.now()
	const r24 = q.rejections.get(accountId, now - DAY).n
	const r72 = q.rejections.get(accountId, now - 3 * DAY).n
	// Al terminar un descanso, el límite vuelve a subir desde abajo
	if (a.rest_until && a.rest_until <= now) {
		db.prepare('UPDATE accounts SET rest_until = NULL, rest_ended_at = ? WHERE id = ?').run(a.rest_until, accountId)
		a.rest_ended_at = a.rest_until
		a.rest_until = null
	}
	const since = Math.max(a.linked_at || 0, a.rest_ended_at || 0)
	const ageDays = since ? Math.floor((now - since) / DAY) : 0
	const st = status || a.status
	const resting = a.rest_until && a.rest_until > now
	let level
	let reason
	let suggestedDaily = rampLimit(ageDays)
	if (st !== 'connected') {
		level = 'red'
		reason = 'Desconectado'
		suggestedDaily = 0
	} else if (resting) {
		level = 'red'
		reason = `Descansando hasta el ${new Date(a.rest_until).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'America/Mexico_City' })}. Los envíos masivos no lo usan.`
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
	// Si casi nadie le contesta, WhatsApp lo ve como spam (y la gente lo reporta): bajar el ritmo
	const rs = replyStats(accountId)
	if (level !== 'red' && rs.sent >= 30 && rs.rate < 0.05) {
		level = 'yellow'
		reason = `Casi nadie le contesta (${Math.round(rs.rate * 100)}% de ${rs.sent}). Baja el ritmo para que no lo reporten.`
		suggestedDaily = Math.max(5, Math.floor(suggestedDaily / 2))
	}
	return { level, reason, rejections24h: r24, rejections72h: r72, ageDays, suggestedDaily, restUntil: resting ? a.rest_until : null, replyRate: rs.sent ? Math.round(rs.rate * 100) : null, sent3d: rs.sent }
}
