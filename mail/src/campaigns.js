import { db } from './db.js'

// Envíos masivos de correo con plantilla, escalonados, por horario y con límite diario por buzón
const TZ = process.env.TZ_CAMPAIGNS || 'America/Mexico_City'
const hourNow = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
const clamp = (v, min, max, def) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : def))
const fill = (text, params) => String(text || '').replace(/\{\{(\d+)\}\}/g, (m, n) => params[Number(n) - 1] ?? '')
export const isEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim())

export class MailCampaignRunner {
	constructor(manager) {
		this.manager = manager
		this.busy = false
		this.nextAt = new Map()
		// Al reiniciar, lo que quedó «enviando» vuelve a la cola
		db.prepare("UPDATE campaign_items SET status = 'pending', sent_by = NULL WHERE status = 'sending'").run()
		this.timer = setInterval(() => this.tick().catch(() => {}), 5000)
	}

	create({ name, accountIds, subject, body, perHour, dailyPerAccount, startHour, endHour, minDelay, maxDelay, rows }) {
		if (!Array.isArray(accountIds) || !accountIds.length) throw new Error('Elige al menos una cuenta para enviar')
		if (!String(subject || '').trim()) throw new Error('Escribe el asunto')
		if (!String(body || '').trim()) throw new Error('Escribe el mensaje')
		if (!Array.isArray(rows) || !rows.length) throw new Error('La lista está vacía')
		const optouts = new Set(db.prepare('SELECT email FROM optouts').all().map(r => r.email))
		const seen = new Set()
		const items = []
		const invalid = []
		for (const r of rows) {
			const email = String(r.email || '').trim().toLowerCase()
			if (!isEmail(email)) { invalid.push(r.email); continue }
			if (seen.has(email)) continue
			seen.add(email)
			items.push({ email, params: (r.params || []).map(p => String(p ?? '').trim()), skipped: optouts.has(email) })
		}
		if (!items.length) throw new Error('Ningún correo de la lista es válido')
		const minD = clamp(minDelay, 10, 3600, 60)
		const maxD = Math.max(minD, clamp(maxDelay, 10, 7200, 180))
		const id = db.transaction(() => {
			const { lastInsertRowid } = db.prepare(`INSERT INTO campaigns
				(name, accounts, subject, body, per_hour, daily_per_account, start_hour, end_hour, min_delay, max_delay, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`).run(
				String(name || subject).slice(0, 80), JSON.stringify(accountIds.map(Number)),
				String(subject).slice(0, 300), String(body),
				clamp(perHour, 1, 200, 20), clamp(dailyPerAccount, 1, 200, 40),
				clamp(startHour, 0, 23, 9), clamp(endHour, 1, 24, 19), minD, maxD, Date.now())
			const ins = db.prepare('INSERT INTO campaign_items (campaign_id, email, params, status, error) VALUES (?, ?, ?, ?, ?)')
			for (const it of items) ins.run(lastInsertRowid, it.email, JSON.stringify(it.params), it.skipped ? 'skipped' : 'pending', it.skipped ? 'Pidió baja' : null)
			return Number(lastInsertRowid)
		})()
		this.emit(id)
		return { campaign: this.get(id), invalid }
	}

	get(id) {
		const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id)
		if (!c) return null
		const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM campaign_items WHERE campaign_id = ? GROUP BY status').all(id).map(r => [r.status, r.n]))
		return {
			id: c.id, name: c.name, accountIds: JSON.parse(c.accounts), subject: c.subject, body: c.body,
			perHour: c.per_hour, dailyPerAccount: c.daily_per_account, startHour: c.start_hour, endHour: c.end_hour,
			minDelay: c.min_delay, maxDelay: c.max_delay, status: c.status, note: c.note, createdAt: c.created_at,
			counts: { pending: counts.pending || 0, sent: counts.sent || 0, failed: counts.failed || 0, skipped: counts.skipped || 0 }
		}
	}

	list() { return db.prepare('SELECT id FROM campaigns ORDER BY id DESC LIMIT 50').all().map(r => this.get(r.id)) }
	items(id, status) {
		return db.prepare(`SELECT email, params, status, error, sent_at, sent_by FROM campaign_items WHERE campaign_id = ? ${status ? 'AND status = ?' : ''} ORDER BY id LIMIT 3000`)
			.all(...(status ? [id, status] : [id])).map(r => ({ ...r, params: JSON.parse(r.params) }))
	}
	setStatus(id, status, note = null) { db.prepare('UPDATE campaigns SET status = ?, note = ? WHERE id = ?').run(status, note, id); this.emit(id) }
	setNote(c, text) { if (c.note === text) return; db.prepare('UPDATE campaigns SET note = ? WHERE id = ?').run(text, c.id); c.note = text; this.emit(c.id) }
	emit(id) { this.manager.emit('event', { type: 'campaign.update', data: this.get(id) }) }

	sentLast24h(accountId) {
		return db.prepare("SELECT COUNT(*) AS n FROM campaign_items WHERE sent_by = ? AND status = 'sent' AND sent_at > ?").get(accountId, Date.now() - 864e5).n
	}
	sentLastHour(accountId) {
		return db.prepare("SELECT COUNT(*) AS n FROM campaign_items WHERE sent_by = ? AND status IN ('sent','sending') AND sent_at > ?").get(accountId, Date.now() - 3600000).n
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
				const accounts = JSON.parse(c.accounts)
				let available = false
				for (const acc of accounts) {
					const box = this.manager.boxes.get(acc)
					if (!box || box.status !== 'connected') continue
					if (this.sentLast24h(acc) >= c.daily_per_account) continue
					if (this.sentLastHour(acc) >= Math.ceil(c.per_hour / accounts.length) + 1) continue
					available = true
					const now = Date.now()
					if (!this.nextAt.has(acc)) this.nextAt.set(acc, now)
					if (now < this.nextAt.get(acc)) continue
					const item = db.prepare("SELECT * FROM campaign_items WHERE campaign_id = ? AND status = 'pending' ORDER BY id LIMIT 1").get(c.id)
					if (!item) { available = false; break }
					db.prepare("UPDATE campaign_items SET status = 'sending', sent_by = ?, sent_at = ? WHERE id = ?").run(acc, now, item.id)
					db.prepare('UPDATE campaigns SET last_sent_at = ? WHERE id = ?').run(now, c.id)
					this.nextAt.set(acc, now + (c.min_delay + Math.random() * (c.max_delay - c.min_delay)) * 1000)
					const params = JSON.parse(item.params)
					try {
						await box.send({ to: item.email, subject: fill(c.subject, params), text: fill(c.body, params) })
						db.prepare("UPDATE campaign_items SET status = 'sent', sent_at = ? WHERE id = ?").run(Date.now(), item.id)
					} catch (e) {
						db.prepare("UPDATE campaign_items SET status = 'failed', error = ? WHERE id = ?").run(e.message.slice(0, 200), item.id)
					}
					this.emit(c.id)
					break // un correo por vuelta para no saturar
				}
				const pending = db.prepare("SELECT COUNT(*) AS n FROM campaign_items WHERE campaign_id = ? AND status = 'pending'").get(c.id).n
				if (!pending) this.setStatus(c.id, 'done')
				else if (!available) this.setNote(c, 'Esperando: los buzones alcanzaron su límite del día. Sigue mañana solo.')
				else if (c.note) this.setNote(c, null)
			}
		} finally { this.busy = false }
	}
}

export function optOut(email) {
	if (isEmail(email)) db.prepare('INSERT OR REPLACE INTO optouts (email, at) VALUES (?, ?)').run(String(email).toLowerCase(), Date.now())
}
