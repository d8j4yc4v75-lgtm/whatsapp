import { db } from './db.js'

// Calentamiento: tus propios números conversan entre sí, poco a poco y a horas normales,
// para que las cuentas nuevas se vean activas y "maduren" antes de usarlas en envíos.
// Solo son TUS números hablando entre ellos: no se molesta a terceros.
// Para verse real: conversaciones de varios turnos, "escribiendo…", lectura del que recibe,
// ráfagas cortas con pausas largas entre charlas, y arranque gradual según la antigüedad.

const TZ = process.env.TZ_CAMPAIGNS || 'America/Mexico_City'
const DAY = 864e5
const hourNow = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
const rnd = (a, b) => a + Math.random() * (b - a)
const irnd = (a, b) => Math.floor(rnd(a, b + 1))
const pick = arr => arr[Math.floor(Math.random() * arr.length)]
const sleep = ms => new Promise(r => setTimeout(r, ms))
const jidOf = phone => `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`

db.exec(`CREATE TABLE IF NOT EXISTS warmup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  peer_id INTEGER,
  ts INTEGER NOT NULL
)`)
db.exec('CREATE INDEX IF NOT EXISTS idx_warmup_ts ON warmup_log (account_id, ts)')
try { db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)') } catch {}

// Pools de frases. Un "abridor" empieza la charla; luego se alterna con respuestas/seguimientos.
const OPENERS = [
	'Hola, ¿cómo vas?', '¿Qué tal el día?', 'Buenas 👋', '¿Cómo amaneciste?', '¿Qué cuentas?',
	'¿Todo bien por allá?', 'Oye, ¿tienes un momento?', '¿Cómo va todo?', 'Hola!', '¿Qué haces?',
	'¿Ya comiste?', '¿Nos ponemos de acuerdo al rato?', '¿Viste lo de ayer?', 'Buen día ☀️'
]
const FOLLOWUPS = [
	'¿Y cómo vamos con lo demás?', 'Oye y lo otro, ¿salió?', '¿Te parece bien así?', '¿Mañana entonces?',
	'Perfecto, lo reviso', 'Sí, justo en eso ando', 'Vale, cualquier cosa te aviso', '¿Te marco al rato?',
	'Jaja sí, ni me acordaba', 'Ok, lo dejo listo', '¿Lo mando por aquí?', 'Gracias, me sirve mucho',
	'Sale, lo vemos', '¿Algo más que falte?', 'Quedo pendiente'
]
const REPLIES = [
	'Todo bien, ¿y tú?', 'Sí, aquí andamos', 'Perfecto 👍', 'Vale, gracias', 'Sí, me llegó',
	'Claro que sí', 'Jaja va', 'Sale pues', 'De acuerdo', 'Listo, gracias 🙌', '👍', 'Buen día!',
	'Ahí la llevamos', 'Sí, sin problema', 'Quedamos así entonces', 'Va va', 'Con gusto', 'Sí, dale',
	'Ok perfecto', 'Me parece 👌'
]
const CLOSERS = ['Listo, gracias 🙌', 'Va, nos hablamos', 'Sale, cualquier cosa te aviso', 'Perfecto, quedamos así 👍', 'Gracias! Saludos', 'Ok, hasta al rato']

const DEFAULTS = { enabled: false, perDay: 6, minDelay: 25, maxDelay: 150, startHour: 9, endHour: 21 }

export class WarmupManager {
	constructor(manager) {
		this.manager = manager
		this.busy = false
		this.nextAt = 0
		this.convo = null // charla en curso: { a, b, turnsLeft, speaker, msgIndex }
		this.timer = setInterval(() => this.tick().catch(() => {}), 12000)
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
		if (s.enabled) this.nextAt = 0
		return s
	}

	// Días desde que el número se vinculó o terminó su último descanso (para el arranque gradual)
	ageDays(a) {
		const since = Math.max(a.linked_at || 0, a.rest_ended_at || 0)
		return since ? Math.floor((Date.now() - since) / DAY) : 0
	}
	// Tope del día por número: arranca bajo en números nuevos y sube hasta el que elija el usuario
	targetFor(a, perDay) {
		const ramp = 3 + 2 * this.ageDays(a) // día 0:3, día 1:5, día 2:7…
		return Math.max(1, Math.min(perDay, ramp))
	}

	// Números tuyos de WhatsApp normal, conectados, con número y que no estén descansando
	eligible() {
		const rows = db.prepare("SELECT id, name, phone, linked_at, rest_ended_at, rest_until FROM accounts WHERE (kind IS NULL OR kind != 'cloud') AND phone IS NOT NULL AND phone != ''").all()
		const now = Date.now()
		return rows.filter(a => {
			if (a.rest_until && a.rest_until > now) return false
			try { return this.manager.accountInfo(a.id)?.status === 'connected' } catch { return false }
		})
	}

	sentToday(accountId) {
		return db.prepare('SELECT COUNT(*) AS n FROM warmup_log WHERE account_id = ? AND ts > ?').get(accountId, startOfDay()).n
	}
	canSend(a, s) { return this.sentToday(a.id) < this.targetFor(a, s.perDay) }

	status() {
		const s = this.settings()
		const elig = this.eligible()
		return {
			...s,
			eligible: elig.length,
			running: s.enabled && elig.length >= 2,
			numbers: elig.map(a => ({ id: a.id, name: a.name, sentToday: this.sentToday(a.id), target: this.targetFor(a, s.perDay), ageDays: this.ageDays(a) }))
		}
	}

	// Elige quién arranca, favoreciendo a los que aún tienen cupo del día
	startConvo(elig, s) {
		const ready = elig.filter(a => this.canSend(a, s))
		if (ready.length < 1) return null
		const weight = a => Math.max(1, this.targetFor(a, s.perDay) - this.sentToday(a.id))
		const total = ready.reduce((n, a) => n + weight(a), 0)
		let r = Math.random() * total
		let aAcc = ready[0]
		for (const a of ready) { r -= weight(a); if (r <= 0) { aAcc = a; break } }
		const others = elig.filter(x => x.id !== aAcc.id)
		if (!others.length) return null
		const bAcc = pick(others)
		return { a: aAcc.id, b: bAcc.id, turnsLeft: irnd(1, 5), speaker: aAcc.id, msgIndex: 0 }
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
		if (elig.length < 2) { this.convo = null; return }
		this.busy = true
		try {
			// Reanuda la charla en curso si ambos siguen disponibles, si no empieza una nueva
			let c = this.convo
			if (c && (!elig.find(a => a.id === c.a) || !elig.find(a => a.id === c.b))) c = this.convo = null
			if (!c) { c = this.startConvo(elig, s); this.convo = c }
			if (!c) { this.betweenConvos(s); return }

			const fromAcc = elig.find(a => a.id === c.speaker)
			const toId = c.speaker === c.a ? c.b : c.a
			const toAcc = elig.find(a => a.id === toId)
			if (!fromAcc || !toAcc || !this.canSend(fromAcc, s)) { this.convo = null; this.betweenConvos(s); return }

			const text = c.msgIndex === 0 ? pick(OPENERS)
				: c.turnsLeft <= 1 ? pick(CLOSERS)
					: Math.random() < 0.5 ? pick(REPLIES) : pick(FOLLOWUPS)

			const toJid = jidOf(toAcc.phone)
			const fromSession = this.manager.get(fromAcc.id)
			// "escribiendo…" un ratito antes de enviar
			await fromSession.setPresence(toJid, 'composing')
			await sleep(irnd(1200, 3500))
			await fromSession.send(toJid, { text })
			await fromSession.setPresence(toJid, 'paused')
			db.prepare('INSERT INTO warmup_log (account_id, peer_id, ts) VALUES (?, ?, ?)').run(fromAcc.id, toAcc.id, Date.now())

			// El que recibe lo marca como leído unos segundos después (se ve real)
			const fromJid = jidOf(fromAcc.phone)
			setTimeout(() => { try { this.manager.get(toId).markRead(fromJid) } catch {} }, irnd(4000, 11000))

			// Avanza la charla
			c.msgIndex++
			c.turnsLeft--
			c.speaker = toId
			if (c.turnsLeft <= 0 || !this.canSend(toAcc, s)) {
				this.convo = null
				this.betweenConvos(s) // pausa larga hasta la siguiente charla
			} else {
				this.nextAt = Date.now() + irnd(20, 120) * 1000 // respuesta dentro de la misma charla: segundos
			}
		} catch {
			this.convo = null
			this.betweenConvos(s)
		} finally { this.busy = false }
	}

	betweenConvos(s) { this.nextAt = Date.now() + rnd(s.minDelay, s.maxDelay) * 60000 }
}
