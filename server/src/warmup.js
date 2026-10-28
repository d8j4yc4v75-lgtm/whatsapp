import { db } from './db.js'
import { accountHealth } from './health.js'

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
// Saludos según la hora, para que el primer mensaje de la charla suene natural
const GREET = {
	manana: ['Buenos días ☀️', '¿Cómo amaneciste?', 'Buen día!', 'Hola, buen día', '¿Qué tal la mañana?'],
	tarde: ['Buenas tardes', '¿Qué tal la tarde?', 'Hola, buenas', '¿Cómo va la tarde?'],
	noche: ['Buenas noches', '¿Qué tal el día?', 'Hola, buenas noches', '¿Cómo te fue hoy?']
}
const openerFor = hour => {
	const base = hour < 12 ? GREET.manana : hour < 19 ? GREET.tarde : GREET.noche
	return Math.random() < 0.6 ? pick(base) : pick(OPENERS)
}
const REACTS = ['👍', '❤️', '😂', '🙌', '👌', '🔥', '😅']

const DEFAULTS = { enabled: false, auto: true, perDay: 6, minDelay: 25, maxDelay: 150, startHour: 9, endHour: 21 }
const AUTO_START = 9, AUTO_END = 21
const GRACE_HOURS = Number(process.env.WARMUP_GRACE_HOURS || 24) // espera tras vincular antes de enviar
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

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
		s.auto = s.auto === undefined ? true : Boolean(s.auto)
		db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('warmup', ?)").run(JSON.stringify(s))
		if (s.enabled) this.nextAt = 0
		return s
	}

	// Días desde que el número se vinculó o terminó su último descanso (para el arranque gradual)
	ageDays(a) {
		const since = Math.max(a.linked_at || 0, a.rest_ended_at || 0)
		return since ? Math.floor((Date.now() - since) / DAY) : 0
	}
	// Horas desde que se vinculó / terminó su descanso (para el periodo de gracia)
	ageHours(a) {
		const since = Math.max(a.linked_at || 0, a.rest_ended_at || 0)
		return since ? (Date.now() - since) / 36e5 : 0
	}
	// MODO AUTOMÁTICO: analiza el número (estado, rechazos, antigüedad) y decide solo cuántos
	autoTarget(a) {
		const info = this.manager.accountInfo(a.id)
		if (!info || info.status !== 'connected') return 0
		const h = accountHealth(a.id, info.status)
		if (!h || h.level === 'red') return 0 // descansando, desconectado o con rechazos: no lo cargamos
		// Periodo de gracia: un número recién vinculado NO envía nada en sus primeras horas
		// (es cuando WhatsApp más rápido restringe). Solo puede recibir.
		if (this.ageHours(a) < GRACE_HOURS) return 0
		const age = h.ageDays
		if (age < 1) return 2 // su primer día ya pasada la gracia: muy poquito
		if (age < 3) return 2 + age // día 1:3, día 2:4
		if (h.level === 'yellow') return 3 // tuvo algún rechazo reciente
		return 6 // número maduro y sano: mantenimiento para verse activo
	}
	// Tope del día por número
	targetFor(a, s) {
		if (s.auto) return this.autoTarget(a)
		if (this.ageHours(a) < GRACE_HOURS) return 0 // gracia también en manual: no enviar recién vinculado
		const ramp = 3 + 2 * this.ageDays(a) // día 0:3, día 1:5, día 2:7…
		return Math.max(1, Math.min(s.perDay, ramp))
	}

	// MODO AUTOMÁTICO: reparte los mensajes del día a lo largo del horario, solo
	autoDelays(s, elig) {
		const total = elig.reduce((n, a) => n + this.targetFor(a, s), 0)
		const windowH = ((s.auto ? AUTO_END : s.endHour) - (s.auto ? AUTO_START : s.startHour) + 24) % 24 || 24
		const avg = total > 0 ? (windowH * 60) / total : 60
		return { min: clamp(avg * 0.5, 10, 240), max: clamp(avg * 1.5, 15, 300) }
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
	canSend(a, s) { return this.sentToday(a.id) < this.targetFor(a, s) }

	status() {
		const s = this.settings()
		const elig = this.eligible()
		const total = elig.reduce((n, a) => n + this.targetFor(a, s), 0)
		const d = this.autoDelays(s, elig)
		return {
			...s,
			eligible: elig.length,
			running: s.enabled && elig.length >= 2,
			plan: { totalPerDay: total, everyMin: Math.round((d.min + d.max) / 2), startHour: s.auto ? AUTO_START : s.startHour, endHour: s.auto ? AUTO_END : s.endHour },
			numbers: elig.map(a => ({ id: a.id, name: a.name, sentToday: this.sentToday(a.id), target: this.targetFor(a, s), ageDays: this.ageDays(a) }))
		}
	}

	// Elige quién arranca, favoreciendo a los que aún tienen cupo del día
	startConvo(elig, s) {
		const ready = elig.filter(a => this.canSend(a, s))
		if (ready.length < 1) return null
		const weight = a => Math.max(1, this.targetFor(a, s) - this.sentToday(a.id))
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
		const sh = s.auto ? AUTO_START : s.startHour, eh = s.auto ? AUTO_END : s.endHour
		const inWindow = sh <= eh ? hour >= sh && hour < eh : hour >= sh || hour < eh
		if (!inWindow) return
		if (Date.now() < this.nextAt) return
		const elig = this.eligible()
		this._elig = elig
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

			const toJid = jidOf(toAcc.phone)
			const fromSession = this.manager.get(fromAcc.id)

			// A media charla, a veces se reacciona con un emoji en vez de escribir (como una persona)
			const canReact = c.msgIndex > 0 && c.turnsLeft > 1
			if (canReact && Math.random() < 0.22 && await fromSession.reactLast(toJid, pick(REACTS))) {
				db.prepare('INSERT INTO warmup_log (account_id, peer_id, ts) VALUES (?, ?, ?)').run(fromAcc.id, toAcc.id, Date.now())
			} else {
				const text = c.msgIndex === 0 ? openerFor(hour)
					: c.turnsLeft <= 1 ? pick(CLOSERS)
						: Math.random() < 0.5 ? pick(REPLIES) : pick(FOLLOWUPS)
				// "escribiendo…" un tiempo proporcional al largo del mensaje
				await fromSession.setPresence(toJid, 'composing')
				await sleep(Math.min(5000, irnd(700, 1200) + text.length * irnd(25, 55)))
				await fromSession.send(toJid, { text })
				await fromSession.setPresence(toJid, 'paused')
				db.prepare('INSERT INTO warmup_log (account_id, peer_id, ts) VALUES (?, ?, ?)').run(fromAcc.id, toAcc.id, Date.now())
			}

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

	betweenConvos(s) {
		if (s.auto) { const d = this.autoDelays(s, this._elig || []); this.nextAt = Date.now() + rnd(d.min, d.max) * 60000 }
		else this.nextAt = Date.now() + rnd(s.minDelay, s.maxDelay) * 60000
	}
}
