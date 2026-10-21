import { db } from './db.js'
import { note } from './sessions.js'
import { CloudSession, normalizePhone } from './cloud.js'

// Envíos masivos con plantillas: se mandan escalonados, en horario y respetando el límite diario de Meta
const TZ = process.env.TZ_CAMPAIGNS || 'America/Mexico_City'

const hourNow = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))

// Errores que significan que hay que detener la campaña completa (no solo ese número)
const FATAL = new Set([190, 10, 200, 132001, 132015, 132016, 133010, 131048])

export class CampaignRunner {
	constructor(manager) {
		this.manager = manager
		this.busy = false
		this.timer = setInterval(() => this.tick().catch(e => note(null, 'campaign-error', e.message)), 5000)
	}

	create({ accountId, name, template, language, perHour, startHour, endHour, rows }) {
		if (!Array.isArray(rows) || !rows.length) throw new Error('La lista está vacía')
		if (rows.length > 20000) throw new Error('Máximo 20,000 contactos por envío')
		const optouts = new Set(db.prepare('SELECT phone FROM optouts').all().map(r => r.phone))
		const seen = new Set()
		const items = []
		const invalid = []
		for (const r of rows) {
			let phone
			try { phone = normalizePhone(r.phone) } catch { invalid.push(r.phone); continue }
			if (seen.has(phone)) continue
			seen.add(phone)
			items.push({ phone, params: (r.params || []).map(p => String(p ?? '').trim()), skipped: optouts.has(phone) || optouts.has(phone.replace(/^521/, '52')) })
		}
		if (!items.length) throw new Error('Ningún número de la lista es válido')
		const id = db.transaction(() => {
			const { lastInsertRowid } = db.prepare(`
				INSERT INTO campaigns (account_id, name, template, language, per_hour, start_hour, end_hour, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`).run(
				accountId, String(name || template).slice(0, 80), template, language,
				Math.min(600, Math.max(1, Number(perHour) || 50)),
				Math.min(23, Math.max(0, Number(startHour ?? 9))),
				Math.min(24, Math.max(1, Number(endHour ?? 19))),
				Date.now()
			)
			const ins = db.prepare('INSERT INTO campaign_items (campaign_id, phone, params, status, error) VALUES (?, ?, ?, ?, ?)')
			for (const it of items) {
				ins.run(lastInsertRowid, it.phone, JSON.stringify(it.params), it.skipped ? 'skipped' : 'pending', it.skipped ? 'Pidió no recibir mensajes (BAJA)' : null)
			}
			return Number(lastInsertRowid)
		})()
		this.emit(id)
		return { campaign: this.get(id), invalid }
	}

	get(id) {
		const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id)
		if (!c) return null
		const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM campaign_items WHERE campaign_id = ? GROUP BY status').all(id).map(r => [r.status, r.n]))
		const read = db.prepare(`
			SELECT COUNT(*) AS n FROM campaign_items i JOIN messages m ON m.id = i.message_id
			WHERE i.campaign_id = ? AND m.status >= 4`).get(id).n
		return {
			id: c.id,
			accountId: c.account_id,
			name: c.name,
			template: c.template,
			language: c.language,
			perHour: c.per_hour,
			startHour: c.start_hour,
			endHour: c.end_hour,
			status: c.status,
			note: c.note,
			createdAt: c.created_at,
			counts: { pending: counts.pending || 0, sent: counts.sent || 0, failed: counts.failed || 0, skipped: counts.skipped || 0, read }
		}
	}

	list() {
		return db.prepare('SELECT id FROM campaigns ORDER BY id DESC LIMIT 50').all().map(r => this.get(r.id))
	}

	items(id, status) {
		return db.prepare(`SELECT phone, params, status, error, sent_at FROM campaign_items WHERE campaign_id = ? ${status ? 'AND status = ?' : ''} ORDER BY id LIMIT 2000`)
			.all(...(status ? [id, status] : [id])).map(r => ({ ...r, params: JSON.parse(r.params) }))
	}

	setStatus(id, status, noteText = null) {
		db.prepare('UPDATE campaigns SET status = ?, note = ? WHERE id = ?').run(status, noteText, id)
		this.emit(id)
	}

	emit(id) {
		this.manager.emit('event', { type: 'campaign.update', data: this.get(id) })
	}

	/** Personas distintas a las que esta cuenta escribió primero en las últimas 24 h */
	sentLast24h(accountId) {
		return db.prepare(`
			SELECT COUNT(DISTINCT i.phone) AS n FROM campaign_items i JOIN campaigns c ON c.id = i.campaign_id
			WHERE c.account_id = ? AND i.status IN ('sent', 'failed') AND i.sent_at > ?`).get(accountId, Date.now() - 864e5).n
	}

	async tick() {
		if (this.busy) return
		this.busy = true
		try {
			const hour = hourNow()
			for (const c of db.prepare("SELECT * FROM campaigns WHERE status = 'running'").all()) {
				const inWindow = c.start_hour <= c.end_hour ? hour >= c.start_hour && hour < c.end_hour : hour >= c.start_hour || hour < c.end_hour
				if (!inWindow) continue
				if (Date.now() - c.last_sent_at < 3600000 / c.per_hour) continue
				const session = this.manager.sessions.get(c.account_id)
				if (!(session instanceof CloudSession) || session.status !== 'connected') continue
				const limit = session.config.dailyLimit || 250
				if (this.sentLast24h(c.account_id) >= limit) {
					if (c.note !== 'limit') { db.prepare("UPDATE campaigns SET note = 'limit' WHERE id = ?").run(c.id); this.emit(c.id) }
					continue
				}
				const item = db.prepare("SELECT * FROM campaign_items WHERE campaign_id = ? AND status = 'pending' ORDER BY id LIMIT 1").get(c.id)
				if (!item) {
					this.setStatus(c.id, 'done')
					continue
				}
				db.prepare('UPDATE campaigns SET last_sent_at = ?, note = NULL WHERE id = ?').run(Date.now(), c.id)
				try {
					const { id } = await session.sendTemplate(item.phone, { name: c.template, language: c.language, params: JSON.parse(item.params) })
					db.prepare("UPDATE campaign_items SET status = 'sent', message_id = ?, sent_at = ? WHERE id = ?").run(id, Date.now(), item.id)
				} catch (e) {
					db.prepare("UPDATE campaign_items SET status = 'failed', error = ?, sent_at = ? WHERE id = ?").run(e.message, Date.now(), item.id)
					if (FATAL.has(e.code)) this.setStatus(c.id, 'paused', e.message)
				}
				this.emit(c.id)
			}
		} finally {
			this.busy = false
		}
	}
}
