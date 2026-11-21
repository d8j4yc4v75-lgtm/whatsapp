import { db } from './db.js'

// WhatsApp a veces identifica a una persona con un «LID» (un código interno como +100936143892589)
// en lugar de su número. Cuando se sabe a qué número corresponde, el chat del LID se junta con el
// del número real (mensajes, etiquetas, notas, recordatorios y promesas).
// La equivalencia LID → número se guarda aparte, para que no se pierda si el número se desvincula.

const KEYED = [['conversation_labels', 'jid'], ['conversation_notes', 'conv_key'], ['reminders', 'conv_key'], ['promises', 'conv_key']]
try { db.exec('CREATE INDEX IF NOT EXISTS idx_items_jid ON campaign_items (jid)') } catch {}

let hook = null
/** Se llama con las cuentas cuyos chats se juntaron (para refrescar la lista en la app) */
export function onLidMerged(fn) { hook = fn }

const q = {
	chatAccs: db.prepare('SELECT account_id FROM chats WHERE jid = ?'),
	msgAccs: db.prepare('SELECT DISTINCT account_id FROM messages WHERE jid = ?'),
	setLid: db.prepare('INSERT OR REPLACE INTO lid_map (lid, pn) VALUES (?, ?)'),
	getLid: db.prepare('SELECT pn FROM lid_map WHERE lid = ?'),
	moveMsgs: db.prepare('UPDATE messages SET jid = @pn, sender = CASE WHEN sender = @lid THEN @pn ELSE sender END WHERE account_id = @acc AND jid = @lid'),
	chat: db.prepare('SELECT * FROM chats WHERE account_id = ? AND jid = ?'),
	mergeChat: db.prepare('UPDATE chats SET last_ts = MAX(last_ts, ?), unread = unread + ?, name = COALESCE(name, ?) WHERE account_id = ? AND jid = ?'),
	delChat: db.prepare('DELETE FROM chats WHERE account_id = ? AND jid = ?'),
	renameChat: db.prepare('UPDATE chats SET jid = ? WHERE account_id = ? AND jid = ?'),
	copyContact: db.prepare('INSERT OR IGNORE INTO contacts (jid, name, notify) SELECT ?, name, notify FROM contacts WHERE jid = ?')
}

const isLid = j => /^\d+@lid$/.test(String(j || ''))
const isPn = j => /^\d+@s\.whatsapp\.net$/.test(String(j || ''))

/** Junta el chat de un LID con el del número real. Devuelve las cuentas afectadas. */
export function mergeLid(lid, pn) {
	if (!isLid(lid) || !isPn(pn)) return []
	const accs = [...new Set([...q.chatAccs.all(lid), ...q.msgAccs.all(lid)].map(r => r.account_id))]
	if (!accs.length) return []
	db.transaction(() => {
		q.copyContact.run(pn, lid)
		// (la columna jid de los envíos se crea en campaigns.js; si todavía no existe, no pasa nada)
		try { db.prepare('UPDATE campaign_items SET jid = ? WHERE jid = ?').run(pn, lid) } catch {}
		for (const acc of accs) {
			q.moveMsgs.run({ acc, lid, pn })
			const l = q.chat.get(acc, lid)
			if (l) {
				if (q.chat.get(acc, pn)) {
					q.mergeChat.run(l.last_ts, l.unread, l.name, acc, pn)
					q.delChat.run(acc, lid)
				} else {
					q.renameChat.run(pn, acc, lid)
				}
			}
			const oldKey = `${acc}:${lid}`
			const newKey = `${acc}:${pn}`
			for (const [table, col] of KEYED) {
				try {
					db.prepare(`UPDATE OR IGNORE ${table} SET ${col} = ? WHERE ${col} = ?`).run(newKey, oldKey)
					db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(oldKey)
				} catch {}
			}
		}
	})()
	try { hook?.(accs, lid, pn) } catch {}
	return accs
}

/** Guarda la equivalencia LID → número y junta los chats que estaban con el LID */
export function saveLidMapping(lid, pn) {
	if (!isLid(lid) || !isPn(pn)) return []
	if (q.getLid.get(lid)?.pn !== pn) q.setLid.run(lid, pn)
	return mergeLid(lid, pn)
}

/**
 * Las equivalencias que WhatsApp guarda en las llaves de cada número vienen como
 * { "<número>": "<lid>", "<lid>_reverse": "<número>" }. Devuelve los pares [lid, número].
 */
export function lidPairsFromKeys(entries) {
	const pairs = []
	for (const [id, value] of entries) {
		if (typeof value !== 'string') continue
		const [lidUser, pnUser] = id.endsWith('_reverse') ? [id.slice(0, -8), value] : [value, id]
		if (/^\d+$/.test(lidUser) && /^\d+$/.test(pnUser)) pairs.push([`${lidUser}@lid`, `${pnUser}@s.whatsapp.net`])
	}
	return pairs
}

/** Al arrancar: copia las equivalencias guardadas por WhatsApp y junta los chats con LID que ya se puedan */
export function repairLids() {
	let learned = 0
	let merged = 0
	try {
		const rows = db.prepare("SELECT id, value FROM auth_keys WHERE type = 'lid-mapping'").all()
		const entries = []
		for (const r of rows) { try { entries.push([r.id, JSON.parse(r.value)]) } catch {} }
		db.transaction(() => {
			for (const [lid, pn] of lidPairsFromKeys(entries)) {
				if (q.getLid.get(lid)?.pn !== pn) { q.setLid.run(lid, pn); learned++ }
			}
		})()
	} catch {}
	for (const { jid } of db.prepare("SELECT DISTINCT jid FROM chats WHERE jid LIKE '%@lid'").all()) {
		const pn = q.getLid.get(jid)?.pn
		if (pn && mergeLid(jid, pn).length) merged++
	}
	return { learned, merged }
}
