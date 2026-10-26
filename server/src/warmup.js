import { db } from './db.js'

// Calentamiento: tus propios números se escriben entre sí, poco a poco y a horas normales,
// para que las cuentas nuevas se vean activas y "maduren" antes de usarlas en envíos.
// Solo son TUS números hablando entre ellos: no se molesta a terceros.

const TZ = process.env.TZ_CAMPAIGNS || 'America/Mexico_City'
const hourNow = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
const rnd = (a, b) => a + Math.random() * (b - a)
const pick = arr => arr[Math.floor(Math.random() * arr.length)]

db.exec(`CREATE TABLE IF NOT EXISTS warmup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  peer_id INTEGER,
  ts INTEGER NOT NULL
)`)
db.exec('CREATE INDEX IF NOT EXISTS idx_warmup_ts ON warmup_log (account_id, ts)')
try { db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)') } catch {}

// Frases cortas y naturales; se contesta con alguna de las respuestas para simular charla
const OPENERS = [
	'Hola, ¿cómo vas?', '¿Todo bien por allá?', '¿Qué tal el día?', 'Buenas 👋', '¿Ya comiste?',
	'¿Cómo amaneciste?', 'Oye, ¿sigues por ahí?', '¿Qué cuentas?', 'Hola, ¿me confirmas algo?',
	'¿Cómo va todo?', 'Buen día ☀️', '¿Pudiste ver lo de ayer?', '¿Nos hablamos al rato?',
	'Gracias por todo 🙌', '¿Te llegó bien el mensaje?', 'Perfecto, quedamos así', 'Va, sale 👍',
	'¿Cómo quedamos entonces?', 'Te escribo más tarde', 'Saludos!'
]
const REPLIES = [
	'Todo bien, ¿y tú?', 'Sí, aquí andamos', 'Perfecto 👍', 'Vale, gracias', 'Sí, me llegó',
	'Claro que sí', 'Jaja va', 'Sale pues', 'De acuerdo', 'Listo, gracias 🙌', '👍', 'Buen día!',
	'Ahí la llevamos', 'Sí señor', 'Quedamos así entonces', 'Va va', 'Con gusto'
]

const DEFAULTS = { enabled: false, perDay: 6, minDelay: 20, maxDelay: 120, startHour: 9, endHour: 21 }

export class WarmupManager {
	constructor(manager) {
		this.manager = manager
		this.busy = false
		this.nextAt = 0
		this.pendingReply = null // { from, to } el que recibió contesta en la próxima vuelta
		this.timer = setInterval(() => this.tick().catch(() => {}), 15000)
	}

	settings() {
		const row = db.prepare("SELECT value FROM app_settings WHERE key = 'warmup'").get()
		return { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) }
	}
	save(partial) {
		const s = { ...this.settings(), ...partial }
		s.perDay = Math.min(40, Math.max(1, Number(s.perDay) || DEFAULTS.perDay))
		s.minDelay = Math.min(360, Math.max(5, Number(s.minDelay) || DEFAULTS.minDelay))
		s.maxDelay = Math.min(720, Math.max(s.minDelay, Number(s.maxDelay) || DEFAULTS.maxDelay))
		s.startHour = Math.min(23, Math.max(0, Number(s.startHour)))
		s.endHour = Math.min(24, Math.max(s.startHour + 1, Number(s.endHour)))
		s.enabled = Boolean(s.enabled)
		db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('warmup', ?)").run(JSON.stringify(s))
		if (s.enabled) this.nextAt = 0 // que empiece pronto
		return s
	}

	// Números tuyos de WhatsApp normal, conectados, con número y que no estén descansando
	eligible() {
		const rows = db.prepare("SELECT id, name, phone, rest_until FROM accounts WHERE (kind IS NULL OR kind != 'cloud') AND phone IS NOT NULL AND phone != ''").all()
		const now = Date.now()
		return rows.filter(a => {
			if (a.rest_until && a.rest_until > now) return false
			try { return this.manager.accountInfo(a.id)?.status === 'connected' } catch { return false }
		})
	}

	sentToday(accountId) {
		return db.prepare('SELECT COUNT(*) AS n FROM warmup_log WHERE account_id = ? AND ts > ?').get(accountId, startOfDay()).n
	}

	status() {
		const s = this.settings()
		const elig = this.eligible()
		return {
			...s,
			eligible: elig.length,
			running: s.enabled && elig.length >= 2,
			numbers: elig.map(a => ({ id: a.id, name: a.name, sentToday: this.sentToday(a.id), perDay: s.perDay }))
		}
	}

	async tick() {
		if (this.busy) return
		const s = this.settings()
		if (!s.enabled) return
		const hour = hourNow()
		const inWindow = s.startHour <= s.endHour ? hour >= s.startHour && hour < s.endHour : hour >= s.startHour || hour < s.endHour
		if (!inWindow) return
		if (Date.now() < this.nextAt) return
		const elig = this.eligible()
		if (elig.length < 2) return
		this.busy = true
		try {
			let from, to, text
			// Si alguien quedó pendiente de contestar, responde (se ve como conversación real)
			if (this.pendingReply && elig.find(a => a.id === this.pendingReply.from) && elig.find(a => a.id === this.pendingReply.to)) {
				from = elig.find(a => a.id === this.pendingReply.from)
				to = elig.find(a => a.id === this.pendingReply.to)
				text = pick(REPLIES)
				this.pendingReply = null
			} else {
				// Elige un emisor que no haya llegado a su tope del día
				const senders = elig.filter(a => this.sentToday(a.id) < s.perDay)
				if (!senders.length) { this.scheduleNext(s); return }
				from = pick(senders)
				to = pick(elig.filter(a => a.id !== from.id))
				text = pick(OPENERS)
				// El que recibe contestará en la próxima vuelta
				if (this.sentToday(to.id) < s.perDay) this.pendingReply = { from: to.id, to: from.id }
			}
			const jid = `${String(to.phone).replace(/\D/g, '')}@s.whatsapp.net`
			await this.manager.get(from.id).send(jid, { text })
			db.prepare('INSERT INTO warmup_log (account_id, peer_id, ts) VALUES (?, ?, ?)').run(from.id, to.id, Date.now())
		} catch { this.pendingReply = null } finally {
			this.scheduleNext(s)
			this.busy = false
		}
	}

	scheduleNext(s) { this.nextAt = Date.now() + rnd(s.minDelay, s.maxDelay) * 60000 }
}
