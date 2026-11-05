import { db } from './db.js'
import { note } from './sessions.js'
import { CloudSession, normalizePhone } from './cloud.js'
import { accountHealth, replyStats } from './health.js'
import { vary } from './text.js'
import { goodLocalTime } from './smart.js'

// Envíos masivos: con plantillas de la API oficial, o en «modo seguro» con cuentas de WhatsApp normal.
// Se mandan escalonados, en horario y respetando límites diarios.
const TZ = process.env.TZ_CAMPAIGNS || 'America/Mexico_City'

const weekdayNow = () => ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date())]
const restDays = () => {
	try { return JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key = 'rest_days'").get()?.value || '[0]') } catch { return [0] }
}

const hourNow = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))

// Errores que significan que hay que detener la campaña completa (no solo ese número)
const FATAL = new Set([190, 10, 200, 132001, 132015, 132016, 133010, 131048])

// Modo seguro: si un número acumula estos rechazos en 2 horas, deja de usarse en esa campaña
const SAFE_MAX_REJECTS = 2

for (const sql of [
	"ALTER TABLE campaigns ADD COLUMN kind TEXT NOT NULL DEFAULT 'cloud'",
	'ALTER TABLE campaigns ADD COLUMN message TEXT',
	'ALTER TABLE campaigns ADD COLUMN accounts TEXT',
	'ALTER TABLE campaigns ADD COLUMN daily_per_number INTEGER NOT NULL DEFAULT 30',
	'ALTER TABLE campaigns ADD COLUMN min_delay INTEGER NOT NULL DEFAULT 120',
	'ALTER TABLE campaigns ADD COLUMN max_delay INTEGER NOT NULL DEFAULT 300',
	'ALTER TABLE campaigns ADD COLUMN disabled TEXT',
	'ALTER TABLE campaign_items ADD COLUMN sent_by INTEGER',
	'ALTER TABLE campaign_items ADD COLUMN jid TEXT',
	'ALTER TABLE campaigns ADD COLUMN auto_ramp INTEGER NOT NULL DEFAULT 1',
	'ALTER TABLE campaigns ADD COLUMN hourly_per_number INTEGER NOT NULL DEFAULT 8',
	'ALTER TABLE campaigns ADD COLUMN target_numbers INTEGER',
	'ALTER TABLE accounts ADD COLUMN reserve INTEGER NOT NULL DEFAULT 0',
	// Urgente: ignora los topes diarios/por hora sugeridos (recordatorios obligatorios)
	'ALTER TABLE campaigns ADD COLUMN forced INTEGER NOT NULL DEFAULT 0',
	// Brincar a quien ya tiene chat con alguno de tus números
	'ALTER TABLE campaigns ADD COLUMN skip_chats INTEGER NOT NULL DEFAULT 0'
]) {
	try { db.exec(sql) } catch {}
}

try { db.exec('CREATE INDEX IF NOT EXISTS idx_items_phone ON campaign_items (phone, sent_at)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_chats_jid ON chats (jid)') } catch {}

try { db.exec('CREATE INDEX IF NOT EXISTS idx_items_message ON campaign_items (message_id)') } catch {}

/**
 * ¿Con cuáles de tus números ya hay chat con este cliente? (cualquier mensaje, de ida o de vuelta,
 * incluso de envíos anteriores, o un chat que ya existía en el teléfono)
 */
const chatAccStmt = db.prepare(`
	SELECT account_id FROM messages WHERE jid IN (?, ?, ?)
	UNION SELECT account_id FROM chats WHERE jid IN (?, ?, ?) AND last_ts > 0`)
export function chatAccounts(phone) {
	const digits = String(phone || '').replace(/\D/g, '')
	const d = digits.slice(-10)
	const v = [`${digits}@s.whatsapp.net`, `521${d}@s.whatsapp.net`, `52${d}@s.whatsapp.net`]
	return new Set(chatAccStmt.all(...v, ...v).map(r => r.account_id))
}
const CHAT_SKIP = 'Ya tiene chat con todos los números del envío'
// Los que se brincaron con la regla anterior (cuando un solo número tenía chat) vuelven a la cola
// para que ahora se los mande otro número que no haya platicado con ellos
{
	const old = db.prepare("SELECT DISTINCT campaign_id FROM campaign_items WHERE status = 'skipped' AND error = 'Ya tiene chat con uno de tus números'").all().map(r => r.campaign_id)
	if (old.length) {
		db.prepare("UPDATE campaign_items SET status = 'pending', error = NULL WHERE status = 'skipped' AND error = 'Ya tiene chat con uno de tus números'").run()
		for (const id of old) db.prepare("UPDATE campaigns SET status = 'running', note = NULL WHERE id = ? AND status = 'done'").run(id)
	}
}

const fill = (text, params) => String(text || '').replace(/\{\{(\d+)\}\}/g, (m, n) => params[Number(n) - 1] ?? '')
const clamp = (v, min, max, def) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : def))
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Variantes {a|b|c}: solo se procesan si el mensaje las usa (así no se toca un texto normal)
const variar = t => /\{[^{}]*\|/.test(t) ? vary(t) : t
// Variación estable del tope diario por número y día (±15%), para que no todos manden el mismo número
const dailyJitter = acc => { const h = ((acc * 2654435761) ^ Math.floor(Date.now() / 864e5)) >>> 0; return 0.85 + (h % 1000) / 1000 * 0.30 }

export class CampaignRunner {
	constructor(manager) {
		this.manager = manager
		this.busy = false
		// Próximo momento en que cada número del modo seguro puede volver a enviar
		this.nextAt = new Map()
		// Respiro global: no deja que dos números envíen al mismo instante (se ve menos a "robot")
		this.globalNextAt = 0
		this.recover()
		this.timer = setInterval(() => this.tick().catch(e => note(null, 'campaign-error', e.message)), 5000)
	}

	create({ kind, accountId, accountIds, name, template, language, message, perHour, startHour, endHour, dailyPerNumber, hourlyPerNumber, minDelay, maxDelay, autoRamp, forced, skipChats, rows }) {
		const safe = kind === 'safe'
		if (!Array.isArray(rows) || !rows.length) throw new Error('La lista está vacía')
		if (rows.length > 20000) throw new Error('Máximo 20,000 contactos por envío')
		if (safe) {
			if (!String(message || '').trim()) throw new Error('Escribe el mensaje')
			if (!Array.isArray(accountIds) || !accountIds.length) throw new Error('Elige al menos un número para enviar')
		}
		const optouts = new Set(db.prepare('SELECT phone FROM optouts').all().map(r => r.phone))
		const seen = new Set()
		const items = []
		const invalid = []
		for (const r of rows) {
			let phone
			try { phone = normalizePhone(r.phone) } catch { invalid.push(r.phone); continue }
			if (seen.has(phone)) continue
			seen.add(phone)
			const bare = phone.replace(/^521/, '52')
			const optout = optouts.has(phone) || optouts.has(bare) || optouts.has('521' + bare.slice(2))
			const senders = safe ? accountIds.map(Number) : [Number(accountId)]
			const withChat = !optout && skipChats ? chatAccounts(phone) : null
			items.push({ phone, params: (r.params || []).map(p => String(p ?? '').trim()), skipped: optout, chat: Boolean(withChat) && senders.every(a => withChat.has(a)) })
		}
		if (!items.length) throw new Error('Ningún número de la lista es válido')
		const minD = clamp(minDelay, 30, 3600, 120)
		const maxD = Math.max(minD, clamp(maxDelay, 30, 7200, 300))
		const id = db.transaction(() => {
			const { lastInsertRowid } = db.prepare(`
				INSERT INTO campaigns (account_id, name, template, language, per_hour, start_hour, end_hour, status, created_at,
					kind, message, accounts, daily_per_number, min_delay, max_delay, auto_ramp, hourly_per_number, target_numbers)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				safe ? accountIds[0] : accountId,
				String(name || template || 'Envío').slice(0, 80),
				safe ? '' : template,
				safe ? '' : language,
				clamp(perHour, 1, 600, 50),
				clamp(startHour, 0, 23, 9),
				clamp(endHour, 1, 24, 19),
				Date.now(),
				safe ? 'safe' : 'cloud',
				safe ? String(message).trim() : null,
				safe ? JSON.stringify(accountIds.map(Number)) : null,
				clamp(dailyPerNumber, 1, 200, 30),
				minD,
				maxD,
				autoRamp === false ? 0 : 1,
				clamp(hourlyPerNumber, 1, 60, 8),
				safe ? accountIds.length : null
			)
			const ins = db.prepare('INSERT INTO campaign_items (campaign_id, phone, params, status, error) VALUES (?, ?, ?, ?, ?)')
			for (const it of items) {
				ins.run(lastInsertRowid, it.phone, JSON.stringify(it.params), it.skipped || it.chat ? 'skipped' : 'pending', it.skipped ? 'Pidió no recibir mensajes (BAJA)' : it.chat ? CHAT_SKIP : null)
			}
			return Number(lastInsertRowid)
		})()
		if (forced) db.prepare('UPDATE campaigns SET forced = 1 WHERE id = ?').run(id)
		if (skipChats) db.prepare('UPDATE campaigns SET skip_chats = 1 WHERE id = ?').run(id)
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
		const withChat = db.prepare("SELECT COUNT(*) AS n FROM campaign_items WHERE campaign_id = ? AND status = 'skipped' AND error LIKE 'Ya tiene chat%'").get(id).n
		const replied = db.prepare(`
			SELECT COUNT(*) AS n FROM campaign_items i
			WHERE i.campaign_id = ? AND i.status = 'sent' AND EXISTS (
				SELECT 1 FROM messages m WHERE m.account_id = i.sent_by AND m.jid = i.jid AND m.from_me = 0 AND m.ts > i.sent_at)`).get(id).n
		return {
			id: c.id,
			kind: c.kind || 'cloud',
			accountId: c.account_id,
			accountIds: c.accounts ? JSON.parse(c.accounts) : [c.account_id],
			disabledIds: c.disabled ? JSON.parse(c.disabled) : [],
			name: c.name,
			template: c.template,
			language: c.language,
			message: c.message,
			perHour: c.per_hour,
			dailyPerNumber: c.daily_per_number,
			autoRamp: c.auto_ramp !== 0,
			forced: Boolean(c.forced),
			skipChats: Boolean(c.skip_chats),
			hourlyPerNumber: c.hourly_per_number,
			minDelay: c.min_delay,
			maxDelay: c.max_delay,
			startHour: c.start_hour,
			endHour: c.end_hour,
			status: c.status,
			note: c.note,
			createdAt: c.created_at,
			counts: { pending: counts.pending || 0, sent: counts.sent || 0, failed: counts.failed || 0, skipped: counts.skipped || 0, withChat, read, replied }
		}
	}

	list() {
		return db.prepare('SELECT id FROM campaigns ORDER BY id DESC LIMIT 50').all().map(r => this.get(r.id))
	}

	items(id, status) {
		return db.prepare(`SELECT phone, params, status, error, sent_at FROM campaign_items WHERE campaign_id = ? ${status ? 'AND status = ?' : ''} ORDER BY id LIMIT 2000`)
			.all(...(status ? [id, status] : [id])).map(r => ({ ...r, params: JSON.parse(r.params) }))
	}

	skipForChat(item) {
		db.prepare("UPDATE campaign_items SET status = 'skipped', error = ? WHERE id = ? AND status = 'pending'").run(CHAT_SKIP, item.id)
	}

	/** Vuelve a poner en cola los fallidos (menos los que no tienen WhatsApp) y reactiva el envío */
	retryFailed(id) {
		const n = db.prepare("UPDATE campaign_items SET status = 'pending', error = NULL, sent_by = NULL, sent_at = NULL, message_id = NULL WHERE campaign_id = ? AND status = 'failed' AND (error IS NULL OR error NOT LIKE '%no tiene WhatsApp%')").run(id).changes
		if (n) db.prepare("UPDATE campaigns SET status = 'running', note = NULL, disabled = NULL WHERE id = ?").run(id)
		this.emit(id)
		return n
	}

	/** Activa o quita el modo urgente de un envío ya creado */
	setForced(id, on) {
		db.prepare('UPDATE campaigns SET forced = ?, note = NULL WHERE id = ?').run(on ? 1 : 0, id)
		this.emit(id)
		return this.get(id)
	}

	setStatus(id, status, noteText = null) {
		db.prepare('UPDATE campaigns SET status = ?, note = ? WHERE id = ?').run(status, noteText, id)
		this.emit(id)
	}

	setNote(c, text) {
		if (c.note === text) return
		db.prepare('UPDATE campaigns SET note = ? WHERE id = ?').run(text, c.id)
		c.note = text
		this.emit(c.id)
	}

	emit(id) {
		this.manager.emit('event', { type: 'campaign.update', data: this.get(id) })
	}

	/** Personas distintas a las que esta cuenta de la API escribió primero en las últimas 24 h */
	sentLast24h(accountId) {
		return db.prepare(`
			SELECT COUNT(DISTINCT i.phone) AS n FROM campaign_items i JOIN campaigns c ON c.id = i.campaign_id
			WHERE c.kind = 'cloud' AND c.account_id = ? AND i.status IN ('sent', 'failed') AND i.sent_at > ?`).get(accountId, Date.now() - 864e5).n
	}

	/** Mensajes enviados por un número en modo seguro en las últimas 24 h (de todas las campañas) */
	safeSentLast24h(accountId) {
		return db.prepare(`
			SELECT COUNT(*) AS n FROM campaign_items WHERE sent_by = ? AND status IN ('sent', 'failed') AND sent_at > ?`).get(accountId, Date.now() - 864e5).n
	}

	async tick() {
		if (this.busy) return
		this.busy = true
		try {
			const hour = hourNow()
			// Días de descanso: ese día no sale ningún envío masivo
			const restToday = restDays().includes(weekdayNow())
			for (const c of db.prepare("SELECT * FROM campaigns WHERE status = 'running'").all()) {
				// Un envío urgente sí sale en días de descanso (solo respeta su horario)
				const inWindow = (!restToday || c.forced) && (c.start_hour <= c.end_hour ? hour >= c.start_hour && hour < c.end_hour : hour >= c.start_hour || hour < c.end_hour)
				if (c.kind === 'safe') await this.tickSafe(c, inWindow)
				else if (inWindow) await this.tickCloud(c)
			}
		} finally {
			this.busy = false
		}
	}

	async tickCloud(c) {
		if (Date.now() - c.last_sent_at < 3600000 / c.per_hour) return
		const session = this.manager.sessions.get(c.account_id)
		if (!(session instanceof CloudSession) || session.status !== 'connected') return
		const limit = session.config.dailyLimit || 250
		if (this.sentLast24h(c.account_id) >= limit) return this.setNote(c, 'limit')
		const pendingItems = db.prepare("SELECT * FROM campaign_items WHERE campaign_id = ? AND status = 'pending' ORDER BY id LIMIT 200").all(c.id)
		if (!pendingItems.length) return this.setStatus(c.id, 'done')
		const item = pendingItems.find(it => goodLocalTime(it.phone, c.start_hour, c.end_hour))
		if (!item) return
		if (c.skip_chats && chatAccounts(item.phone).has(c.account_id)) { this.skipForChat(item); return this.emit(c.id) }
		db.prepare('UPDATE campaigns SET last_sent_at = ?, note = NULL WHERE id = ?').run(Date.now(), c.id)
		try {
			const { id, jid } = await session.sendTemplate(item.phone, { name: c.template, language: c.language, params: JSON.parse(item.params) })
			db.prepare("UPDATE campaign_items SET status = 'sent', message_id = ?, sent_at = ?, sent_by = ?, jid = ? WHERE id = ?").run(id, Date.now(), c.account_id, jid, item.id)
		} catch (e) {
			db.prepare("UPDATE campaign_items SET status = 'failed', error = ?, sent_at = ? WHERE id = ?").run(e.message, Date.now(), item.id)
			if (FATAL.has(e.code)) this.setStatus(c.id, 'paused', e.message)
		}
		this.emit(c.id)
	}

	async tickSafe(c, inWindow) {
		// Mensajes que WhatsApp rechazó después de enviarse (por ejemplo, error 463)
		const rejected = db.prepare(`
			UPDATE campaign_items SET status = 'failed', error = 'WhatsApp rechazó el mensaje'
			WHERE campaign_id = ? AND status = 'sent' AND EXISTS (
				SELECT 1 FROM messages m WHERE m.account_id = campaign_items.sent_by AND m.id = campaign_items.message_id AND m.status = 0)`).run(c.id)
		const accounts = JSON.parse(c.accounts || '[]')
		const disabled = new Set(JSON.parse(c.disabled || '[]'))
		// Se deja de usar un número si WhatsApp le rechaza varios mensajes seguidos
		for (const acc of accounts) {
			if (disabled.has(acc)) continue
			const n = db.prepare(`
				SELECT COUNT(*) AS n FROM campaign_items
				WHERE campaign_id = ? AND sent_by = ? AND status = 'failed' AND error = 'WhatsApp rechazó el mensaje' AND sent_at > ?`).get(c.id, acc, Date.now() - 2 * 3600000).n
			if (n >= SAFE_MAX_REJECTS) {
				disabled.add(acc)
				const name = db.prepare('SELECT name FROM accounts WHERE id = ?').get(acc)?.name || acc
				note(acc, 'safe-disabled', String(c.id))
				db.prepare('UPDATE campaigns SET disabled = ? WHERE id = ?').run(JSON.stringify([...disabled]), c.id)
				this.setNote(c, `Se dejó de usar «${name}» porque WhatsApp le rechazó mensajes. Úsalo poco unos días.`)
			}
		}
		if (rejected.changes) this.emit(c.id)
		// Números de reserva: si alguno de los elegidos ya no puede enviar, entra uno de reserva en su lugar
		const usable = acc => {
			const session = this.manager.sessions.get(acc)
			return !disabled.has(acc) && session && !(session instanceof CloudSession) && session.status === 'connected' && !accountHealth(acc, session.status)?.restUntil
		}
		const target = c.target_numbers || accounts.length
		if (accounts.filter(usable).length < target) {
			const reserve = db.prepare("SELECT id, name FROM accounts WHERE reserve = 1 AND kind != 'cloud' ORDER BY id").all()
				.find(r => !accounts.includes(r.id) && usable(r.id))
			if (reserve) {
				accounts.push(reserve.id)
				db.prepare('UPDATE campaigns SET accounts = ? WHERE id = ?').run(JSON.stringify(accounts), c.id)
				// Empieza con pocos mensajes, como un número recién activado
				db.prepare('UPDATE accounts SET rest_ended_at = ? WHERE id = ?').run(Date.now(), reserve.id)
				note(reserve.id, 'reserve-in', String(c.id))
				this.setNote(c, `Entró el número de reserva «${reserve.name}» porque otro dejó de estar disponible.`)
				this.emit(c.id)
			}
		}
		const active = accounts.filter(a => !disabled.has(a))
		if (!active.length) return this.setStatus(c.id, 'paused', 'Ningún número disponible: WhatsApp rechazó mensajes de todos. Espera unos días antes de reanudar.')
		if (!inWindow) return

		const pending = db.prepare("SELECT COUNT(*) AS n FROM campaign_items WHERE campaign_id = ? AND status = 'pending'").get(c.id).n
		if (!pending) return this.setStatus(c.id, 'done')

		// Qué números pueden enviar ahora (conectados, sin descanso y debajo de sus topes)
		const ready = new Map()
		for (const acc of active) {
			const session = this.manager.sessions.get(acc)
			if (!session || session instanceof CloudSession || session.status !== 'connected') continue
			// Con «subir poco a poco», el límite depende de la salud del número
			const health = accountHealth(acc, session.status)
			if (health?.restUntil) continue
			// En rojo (rechazos o mensajes que no se entregan) no se usa en ningún modo: fallaría y lo terminaría de bloquear
			if (health?.level === 'red') continue
			// Urgente: sin topes diarios ni por hora (solo las pausas entre mensajes). Nunca usa un número
			// al que WhatsApp le está rechazando mensajes: fallarían y lo terminarían de bloquear.
			if (c.forced) {
				ready.set(acc, session)
				continue
			}
			let base = c.auto_ramp !== 0 && health ? Math.min(c.daily_per_number, health.suggestedDaily) : c.daily_per_number
			// Freno: si casi nadie le contesta, baja a la mitad (con «subir poco a poco» ya lo hace la salud)
			if (c.auto_ramp === 0) { const rr = replyStats(acc); if (rr.sent >= 30 && rr.rate < 0.05) base = Math.ceil(base / 2) }
			const limit = Math.max(1, Math.round(base * dailyJitter(acc)))
			if (this.safeSentLast24h(acc) >= limit) continue
			// Límite por hora para que no se junten muchos mensajes seguidos
			const lastHour = db.prepare("SELECT COUNT(*) AS n FROM campaign_items WHERE sent_by = ? AND status IN ('sent', 'failed', 'sending') AND sent_at > ?").get(acc, Date.now() - 3600000).n
			if (lastHour >= (c.hourly_per_number || 8)) continue
			ready.set(acc, session)
		}
		const anyAvailable = ready.size > 0
		// Orden al azar: así no siempre envía primero el mismo número
		for (const acc of [...ready.keys()].sort(() => Math.random() - 0.5)) {
			const session = ready.get(acc)
			const now = Date.now()
			if (!this.nextAt.has(acc)) this.nextAt.set(acc, now + Math.random() * 30000)
			if (now < this.nextAt.get(acc)) continue
			// Respiro global: si otro número envió hace un momento, este espera su turno (no todos a la vez)
			if (now < this.globalNextAt) break
			const item = this.pickItem(c, acc, ready)
			if (!item) continue
			// Se reserva el contacto antes de enviar para no repetirlo
			db.prepare("UPDATE campaign_items SET status = 'sending', sent_by = ?, sent_at = ? WHERE id = ?").run(acc, now, item.id)
			const delay = (c.min_delay + Math.random() * (c.max_delay - c.min_delay)) * 1000
			this.nextAt.set(acc, now + delay)
			try {
				const text = variar(fill(c.message, JSON.parse(item.params)))
				const jid = await this.manager.resolvePhone(acc, item.phone)
				// En línea → "escribiendo…" (proporcional al largo) → enviar → desconectado, como una persona
				await session.online?.((30 + Math.random() * 60) * 1000)
				await session.setPresence(jid, 'composing').catch(() => {})
				await sleep(Math.min(6000, 900 + text.length * 30))
				const sent = await session.send(jid, { text })
				await session.setPresence(jid, 'paused').catch(() => {})
				db.prepare("UPDATE campaign_items SET status = 'sent', message_id = ?, sent_at = ?, jid = ? WHERE id = ?").run(sent.id, Date.now(), jid, item.id)
				// Micro-descanso: de vez en cuando el número "se despega" un rato, como alguien real
				if (Math.random() < 0.08) this.nextAt.set(acc, Date.now() + (10 + Math.random() * 20) * 60000)
			} catch (e) {
				const noWa = /no tiene WhatsApp|inválido/i.test(e.message)
				db.prepare("UPDATE campaign_items SET status = 'failed', error = ?, sent_at = ?, sent_by = ? WHERE id = ?")
					.run(noWa ? 'Ese número no tiene WhatsApp' : e.message, Date.now(), noWa ? null : acc, item.id)
				// Un número sin WhatsApp no gasta el turno de envío
				if (noWa) this.nextAt.set(acc, Date.now() + 5000)
			}
			this.emit(c.id)
			// Deja pasar unos segundos antes de que CUALQUIER otro número envíe, y corta aquí la vuelta
			this.globalNextAt = Date.now() + 8000 + Math.random() * 17000
			break
		}
		if (!anyAvailable) {
			const connected = active.some(a => this.manager.sessions.get(a)?.status === 'connected')
			this.setNote(c, connected ? 'limit-safe' : 'Esperando a que los números elegidos estén conectados')
		} else if (c.note === 'limit-safe' || c.note === 'Esperando a que los números elegidos estén conectados') {
			this.setNote(c, null)
		}
	}

	/**
	 * Elige el siguiente contacto para este número:
	 * - Si este número ya platicó antes con la persona, se lo manda él (se ve como seguir una charla).
	 * - Si otro número que puede enviar ya platicó con ella, se lo deja a ese.
	 * - Con «enviar desde un número sin chat» es al revés: el número que ya platicó con la persona
	 *   no le escribe; se lo manda el siguiente número del envío que nunca le ha escrito.
	 * - No se le escribe a alguien que ya recibió un mensaje masivo en las últimas 24 h (de cualquier envío).
	 */
	pickItem(c, acc, ready) {
		const cands = db.prepare("SELECT * FROM campaign_items WHERE campaign_id = ? AND status = 'pending' ORDER BY id LIMIT 200").all(c.id)
		const recent = db.prepare("SELECT 1 FROM campaign_items WHERE phone = ? AND status IN ('sent', 'sending') AND sent_at > ? LIMIT 1")
		const owners = db.prepare('SELECT account_id FROM chats WHERE jid IN (?, ?, ?) AND last_ts > 0')
		const since = Date.now() - 864e5
		const disabled = new Set(c.disabled ? JSON.parse(c.disabled) : [])
		const senders = JSON.parse(c.accounts || '[]').filter(a => !disabled.has(a))
		let neutral = null
		for (const it of cands) {
			if (c.skip_chats) {
				const withChat = chatAccounts(it.phone)
				// Todos los números del envío ya platicaron con este cliente → se brinca
				if (senders.length && senders.every(a => withChat.has(a))) { this.skipForChat(it); continue }
				// Este número ya platicó con él → se lo manda otro número del envío que no tenga chat
				if (withChat.has(acc)) continue
				if (!goodLocalTime(it.phone, c.start_hour, c.end_hour)) continue
				if (!c.forced && recent.get(it.phone, since)) continue
				return it
			}
			// Solo a buena hora para el cliente: su hora local (según su lada) dentro del horario del envío y de 7 a 22 h
			if (!goodLocalTime(it.phone, c.start_hour, c.end_hour)) continue
			if (!c.forced && recent.get(it.phone, since)) continue
			const digits = String(it.phone).replace(/\D/g, '')
			const d = digits.slice(-10)
			const own = owners.all(`${digits}@s.whatsapp.net`, `521${d}@s.whatsapp.net`, `52${d}@s.whatsapp.net`).map(r => r.account_id).filter(a => ready.has(a))
			if (own.includes(acc)) return it
			if (own.length) continue
			if (!neutral) neutral = it
		}
		return neutral
	}

	/** Tras un reinicio, los contactos que quedaron «enviando» vuelven a la cola */
	recover() {
		db.prepare("UPDATE campaign_items SET status = 'pending', sent_by = NULL, sent_at = NULL WHERE status = 'sending'").run()
	}
}
