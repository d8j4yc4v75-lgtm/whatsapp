import { db } from './db.js'
import { note } from './sessions.js'
import { sendPush } from './push.js'

// Herramientas de cobranza: respuestas rápidas, notas, recordatorios, resultados y exportación
const DAY = 864e5
// México no usa horario de verano desde 2022: UTC-6
const TZ_OFFSET_MS = Number(process.env.TZ_OFFSET_HOURS || -6) * 3600000

const setting = {
	get: key => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value,
	set: (key, value) => db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value)
}

// Etiquetas y respuestas rápidas de cobranza que se crean una sola vez
function seedDefaults() {
	if (!setting.get('seeded_labels')) {
		const exists = db.prepare('SELECT 1 FROM labels WHERE lower(name) = lower(?)')
		const ins = db.prepare('INSERT INTO labels (name, color) VALUES (?, ?)')
		for (const [name, color] of [['Promesa de pago', '#FF9500'], ['Pagó', '#25D366'], ['No contesta', '#8E8E93'], ['Número equivocado', '#FF2D55']]) {
			if (!exists.get(name)) ins.run(name, color)
		}
		setting.set('seeded_labels', '1')
	}
	if (!setting.get('seeded_replies')) {
		const ins = db.prepare('INSERT INTO quick_replies (title, text) VALUES (?, ?)')
		for (const [title, text] of [
			['Saludo', 'Hola {nombre}, gracias por responder. ¿En qué te puedo ayudar?'],
			['Opciones de pago', 'Con gusto, {nombre}. Podemos revisar un pago en una sola exhibición o en parcialidades. ¿Qué opción te acomoda mejor?'],
			['Fecha de pago', '¿Para qué fecha podrías realizar el pago?'],
			['Confirmar promesa', 'Perfecto, {nombre}. Queda registrado tu compromiso de pago. Te escribo ese día para confirmar. ¡Gracias!'],
			['Datos para pagar', 'Te comparto los datos para realizar tu pago:\n\n(escribe aquí los datos)'],
			['Comprobante', '¿Me podrías enviar una foto de tu comprobante cuando realices el pago, por favor?'],
			['Gracias por pagar', 'Recibimos tu pago, {nombre}. ¡Muchas gracias!'],
			['Número equivocado', 'Disculpa la molestia. Damos de baja este número. ¡Que tengas buen día!']
		]) ins.run(title, text)
		setting.set('seeded_replies', '1')
	}
}

const parseKey = key => {
	const i = String(key).indexOf(':')
	const accountId = Number(String(key).slice(0, i))
	const jid = String(key).slice(i + 1)
	if (i < 1 || !accountId || !jid) throw Object.assign(new Error('Conversación inválida'), { status: 404 })
	return { accountId, jid, key: `${accountId}:${jid}` }
}

const dayKey = ts => new Date(ts + TZ_OFFSET_MS).toISOString().slice(0, 10)

function stats(manager, days) {
	const since = Date.now() - days * DAY
	const accounts = manager.accounts()
	const perAccount = accounts.map(a => {
		const one = (sql, ...p) => db.prepare(sql).get(...p).n
		return {
			accountId: a.id,
			sent: one('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND from_me = 1 AND ts > ?', a.id, since),
			received: one('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND from_me = 0 AND ts > ?', a.id, since),
			people: one('SELECT COUNT(DISTINCT jid) AS n FROM messages WHERE account_id = ? AND from_me = 0 AND ts > ?', a.id, since),
			campaignSent: one("SELECT COUNT(*) AS n FROM campaign_items WHERE sent_by = ? AND status = 'sent' AND sent_at > ?", a.id, since),
			campaignReplied: one(`
				SELECT COUNT(*) AS n FROM campaign_items i WHERE i.sent_by = ? AND i.status = 'sent' AND i.sent_at > ? AND EXISTS (
					SELECT 1 FROM messages m WHERE m.account_id = i.sent_by AND m.jid = i.jid AND m.from_me = 0 AND m.ts > i.sent_at)`, a.id, since),
			rejected: one('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND from_me = 1 AND status = 0 AND ts > ?', a.id, since)
		}
	})
	const labels = db.prepare('SELECT * FROM labels ORDER BY name').all().map(l => ({
		id: l.id,
		name: l.name,
		color: l.color,
		total: db.prepare('SELECT COUNT(*) AS n FROM conversation_labels WHERE label_id = ?').get(l.id).n,
		recent: db.prepare('SELECT COUNT(*) AS n FROM conversation_labels WHERE label_id = ? AND at > ?').get(l.id, since).n
	}))
	// Serie por día (hora de México)
	const series = new Map()
	for (let i = days - 1; i >= 0; i--) series.set(dayKey(Date.now() - i * DAY), { day: dayKey(Date.now() - i * DAY), sent: 0, received: 0, replies: 0 })
	for (const r of db.prepare('SELECT ts, from_me FROM messages WHERE ts > ?').all(since)) {
		const d = series.get(dayKey(r.ts))
		if (d) d[r.from_me ? 'sent' : 'received']++
	}
	for (const r of db.prepare(`
		SELECT i.sent_at AS ts FROM campaign_items i WHERE i.status = 'sent' AND i.sent_at > ? AND EXISTS (
			SELECT 1 FROM messages m WHERE m.account_id = i.sent_by AND m.jid = i.jid AND m.from_me = 0 AND m.ts > i.sent_at)`).all(since)) {
		const d = series.get(dayKey(r.ts))
		if (d) d.replies++
	}
	const total = perAccount.reduce((t, a) => {
		for (const k of Object.keys(a)) if (k !== 'accountId') t[k] = (t[k] || 0) + a[k]
		return t
	}, {})
	return { days, total, perAccount, labels, series: [...series.values()] }
}

const csvCell = v => {
	const s = String(v ?? '')
	return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const fmtDate = ts => (ts ? new Date(ts + TZ_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16) : '')

function exportCampaign(id) {
	const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id)
	if (!c) throw Object.assign(new Error('Envío no encontrado'), { status: 404 })
	const items = db.prepare('SELECT * FROM campaign_items WHERE campaign_id = ? ORDER BY id').all(id)
	const maxParams = items.reduce((n, i) => Math.max(n, JSON.parse(i.params).length), 0)
	const names = new Map(db.prepare('SELECT id, name FROM accounts').all().map(a => [a.id, a.name]))
	const optouts = new Set(db.prepare('SELECT phone FROM optouts').all().map(r => r.phone))
	const status = { pending: 'Pendiente', sending: 'Enviando', sent: 'Enviado', failed: 'Fallido', skipped: 'Omitido' }
	const head = ['Teléfono', ...Array.from({ length: maxParams }, (_, i) => `Dato ${i + 1}`), 'Estado', 'Enviado desde', 'Fecha de envío', 'Leído', 'Respondió', 'Pidió BAJA', 'Error']
	const lines = [head.map(csvCell).join(',')]
	for (const i of items) {
		const params = JSON.parse(i.params)
		const msg = i.message_id ? db.prepare('SELECT status FROM messages WHERE account_id = ? AND id = ?').get(i.sent_by, i.message_id) : null
		const replied = i.status === 'sent' && i.jid
			? Boolean(db.prepare('SELECT 1 FROM messages WHERE account_id = ? AND jid = ? AND from_me = 0 AND ts > ? LIMIT 1').get(i.sent_by, i.jid, i.sent_at))
			: false
		const bare = i.phone.replace(/^521/, '52')
		const baja = optouts.has(i.phone) || optouts.has(bare) || optouts.has('521' + bare.slice(2))
		lines.push([
			i.phone, ...Array.from({ length: maxParams }, (_, k) => params[k] ?? ''),
			status[i.status] || i.status, names.get(i.sent_by) || '', fmtDate(i.sent_at),
			msg && msg.status >= 4 ? 'Sí' : 'No', replied ? 'Sí' : 'No', baja ? 'Sí' : 'No', i.error || ''
		].map(csvCell).join(','))
	}
	// El BOM hace que Excel muestre bien los acentos
	return { name: `envio-${id}-${c.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '_')}.csv`, body: '﻿' + lines.join('\r\n') }
}

function startReminders(manager) {
	setInterval(() => {
		try {
			const due = db.prepare('SELECT * FROM reminders WHERE done = 0 AND at <= ?').all(Date.now())
			for (const r of due) {
				db.prepare('UPDATE reminders SET done = 1 WHERE id = ?').run(r.id)
				let conv = null
				try {
					const { accountId, jid } = parseKey(r.conv_key)
					conv = manager.conversation(accountId, jid)
				} catch {}
				const who = conv?.name || (conv?.phone ? '+' + conv.phone : 'Cliente')
				sendPush({ title: `⏰ ${who}`, body: r.text || 'Recordatorio', jid: r.conv_key, badge: manager.totalUnread() })
				manager.emit('event', { type: 'reminder', data: { key: r.conv_key, text: r.text, name: who } })
				if (conv) manager.emit('event', { type: 'conversation.update', data: manager.conversation(conv.accountId, conv.jid) })
			}
		} catch (e) {
			note(null, 'reminder-error', e.message)
		}
	}, 30000)
}

export function setupExtras({ app, route, manager }) {
	seedDefaults()
	startReminders(manager)

	const refresh = key => {
		const { accountId, jid } = parseKey(key)
		const conv = manager.conversation(accountId, jid)
		if (conv) manager.emit('event', { type: 'conversation.update', data: conv })
		return conv
	}

	// ---- Respuestas rápidas ----
	app.get('/api/quick-replies', route(() => db.prepare('SELECT * FROM quick_replies ORDER BY title').all()))
	app.post('/api/quick-replies', route(req => {
		const title = String(req.body.title || '').trim()
		const text = String(req.body.text || '').trim()
		if (!title || !text) throw new Error('Escribe el nombre y el texto')
		const { lastInsertRowid } = db.prepare('INSERT INTO quick_replies (title, text) VALUES (?, ?)').run(title.slice(0, 60), text.slice(0, 2000))
		return db.prepare('SELECT * FROM quick_replies WHERE id = ?').get(lastInsertRowid)
	}))
	app.delete('/api/quick-replies/:id', route(req => {
		db.prepare('DELETE FROM quick_replies WHERE id = ?').run(Number(req.params.id))
		return { ok: true }
	}))

	// ---- Notas por cliente ----
	app.put('/api/conversations/:key/note', route(req => {
		const { key } = parseKey(req.params.key)
		const text = String(req.body.text || '').trim().slice(0, 4000)
		if (text) db.prepare('INSERT OR REPLACE INTO conversation_notes (conv_key, text, updated_at) VALUES (?, ?, ?)').run(key, text, Date.now())
		else db.prepare('DELETE FROM conversation_notes WHERE conv_key = ?').run(key)
		return refresh(key)
	}))

	// ---- Recordatorios ----
	app.get('/api/conversations/:key/reminders', route(req =>
		db.prepare('SELECT id, at, text FROM reminders WHERE conv_key = ? AND done = 0 ORDER BY at').all(parseKey(req.params.key).key)))
	app.post('/api/conversations/:key/reminders', route(req => {
		const { key } = parseKey(req.params.key)
		const at = Number(req.body.at)
		if (!at || at < Date.now() - 60000) throw new Error('Elige una fecha y hora futura')
		db.prepare('INSERT INTO reminders (conv_key, at, text, created_at) VALUES (?, ?, ?, ?)').run(key, at, String(req.body.text || '').trim().slice(0, 500), Date.now())
		return refresh(key)
	}))
	app.delete('/api/reminders/:id', route(req => {
		const r = db.prepare('SELECT conv_key FROM reminders WHERE id = ?').get(Number(req.params.id))
		db.prepare('DELETE FROM reminders WHERE id = ?').run(Number(req.params.id))
		return r ? refresh(r.conv_key) : { ok: true }
	}))

	// ---- Resultados ----
	app.get('/api/stats', route(req => stats(manager, Math.min(90, Math.max(1, Number(req.query.days) || 7)))))

	// ---- Exportar a Excel (CSV) ----
	app.get('/api/campaigns/:cid/export', route((req, res) => {
		const { name, body } = exportCampaign(Number(req.params.cid))
		res.setHeader('Content-Type', 'text/csv; charset=utf-8')
		res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
		res.send(body)
	}))
}
