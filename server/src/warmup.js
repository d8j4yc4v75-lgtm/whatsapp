import { db } from './db.js'
import { accountHealth } from './health.js'
import { vary } from './text.js'

// Calentamiento: tus propios números conversan entre sí para que las cuentas se vean activas
// y "maduren" antes de usarlas en envíos. Solo son TUS números hablando entre ellos.
//
// Para parecer personas reales:
// - Funciona las 24 h, pero siguiendo una curva de actividad humana: mucho de día, poco de noche
//   y casi nada de madrugada. Cada número tiene su propio "horario de sueño" (unos se duermen
//   antes, otros más tarde).
// - Conversaciones coherentes (guiones con muchas variantes), no frases sueltas al azar.
// - Varias charlas a la vez, con respuestas que llegan en segundos, minutos o al día siguiente
//   (si el otro "está dormido" contesta cuando despierta). A veces se queda en visto.
// - "En línea" → "escribiendo…" → mensaje → desconectado. Reacciones con emoji de vez en cuando.
// - Cada día cada número habla un poco más o un poco menos; los días de descanso, menos.
// - Rota las parejas para que no hablen siempre los mismos.
// - Periodo de gracia: un número recién vinculado no envía nada sus primeras horas.

const TZ = process.env.TZ_CAMPAIGNS || 'America/Mexico_City'
const DAY = 864e5
const MIN = 60000
const rnd = (a, b) => a + Math.random() * (b - a)
const irnd = (a, b) => Math.floor(rnd(a, b + 1))
const pick = arr => arr[Math.floor(Math.random() * arr.length)]
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const jidOf = phone => `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

// Hora, minuto y día de la semana en México (el servidor está en UTC)
function tzNow() {
	const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', hourCycle: 'h23' })
		.formatToParts(new Date(Date.now())).map(x => [x.type, x.value]))
	return { h: Number(p.hour) % 24, m: Number(p.minute), s: Number(p.second), wd: WD[p.weekday] }
}
// Medianoche de hoy en México (antes se usaba la del servidor y el "hoy" se cortaba a las 6 pm)
const startOfDay = () => { const t = tzNow(); return Date.now() - ((t.h * 60 + t.m) * 60 + t.s) * 1000 }
// Número pseudoaleatorio estable entre 0 y 1 (mismo resultado para los mismos datos)
const hash01 = (...nums) => { let h = 2166136261; for (const n of nums) { h ^= n; h = Math.imul(h, 16777619) } return (h >>> 0) / 4294967296 }

// Actividad típica de una persona por hora (0–23): alta de día, baja de noche, casi nula de madrugada
const CURVE = [0.28, 0.14, 0.07, 0.04, 0.04, 0.07, 0.18, 0.42, 0.68, 0.85, 0.95, 1, 1, 0.95, 0.85, 0.82, 0.88, 0.95, 1, 1, 0.95, 0.85, 0.66, 0.46]
const sumCurve = (from, to) => { let s = 0; for (let h = from; h !== to; h = (h + 1) % 24) s += CURVE[h]; return s || CURVE.reduce((a, b) => a + b, 0) }
const AVG_LINES = 3.2 // mensajes promedio por charla

db.exec(`CREATE TABLE IF NOT EXISTS warmup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  peer_id INTEGER,
  ts INTEGER NOT NULL
)`)
db.exec('CREATE INDEX IF NOT EXISTS idx_warmup_ts ON warmup_log (account_id, ts)')
try { db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)') } catch {}

// Guiones de charla: las líneas se alternan entre los dos números (A, B, A, B…).
// {a|b|c} = variantes; opciones vacías ({😅|}) a veces no ponen nada.
// when: 'morning' (6–11 h), 'night' (21–2 h), 'weekend' (vie–dom) o cualquier momento.
const SCRIPTS = [
	{ lines: ['{Hola|Qué onda|Buenas}, ¿{cómo vas|cómo estás|qué tal todo}?', '{Bien|Muy bien|Todo bien}, {gracias|aquí andamos}. ¿{Y tú|Tú qué tal}?', '{Bien también|Todo tranquilo|Aquí, trabajando} {😅|🙌|}', '{Qué bueno|Me da gusto|Excelente} {👍|}'] },
	{ lines: ['¿Ya {comiste|almorzaste}?', '{Todavía no|Apenas voy|Sí, hace rato} {😂|}', '{Yo tampoco|Yo ya|Igual} jaja, {hoy hay|me tocó} {tacos|pozole|comida corrida|tortas}', '{Qué rico|Se me antojó|Provecho} {🤤|😋|}'] },
	{ lines: ['Oye, ¿{al final|entonces} {quedó|salió} lo {de ayer|del pendiente|que vimos}?', '{Sí, ya quedó|Todavía no, mañana|Ya casi}', '{Va, me avisas|Ok, quedo atento|Perfecto, gracias}', '{Sale|Claro|Va} {👍|}'] },
	{ lines: ['¿{Viste|Supiste} lo del partido {de anoche|del domingo|de ayer}?', '{Sí|Nooo}, {qué partidazo|estuvo malísimo|no lo vi}', '{Jajaja|Neta|No manches}, {a ver el próximo|ni modo}', '{Sí|Ojalá} {⚽|😂|}'] },
	{ lines: ['¿{Cómo está|Qué tal} el {tráfico|clima} {por allá|hoy}?', '{Horrible|Tranquilo|Está lloviendo} {😩|☔|}', '{Igual aquí|Aquí está soleado|Uff} {jaja|}', '{Cuídate|Ni modo|Ánimo} {🙏|}'] },
	{ lines: ['¿{Me pasas|Me mandas} {el número|los datos|la dirección} {cuando puedas|al rato}?', '{Claro|Sí}, {ahorita te lo paso|dame un minuto|en un rato}', '{Gracias|Mil gracias|Va}'] },
	{ when: 'weekend', lines: ['{Feliz|Buen} {fin de semana|viernes} {🎉|🙌|}', '{Igualmente|Gracias, igual}! ¿{Qué planes|Vas a salir}?', '{Nada|Descansar|Ver series} {jaja|😂|}, ¿{y tú|tú}?', '{Igual|Lo mismo}, {a descansar|tranquilo} {😴|}'] },
	{ lines: ['¿{A qué hora|Cuándo} {nos vemos|pasas}?', '{Como a las|Tipo} {5|6|7}, ¿{te parece|va}?', '{Va, perfecto|Sale|Ok}'] },
	{ lines: ['{Te mando|Ahí te va} {la foto|el archivo|lo que me pediste} {más tarde|al rato}', '{Va, gracias|Ok, sin prisa|Perfecto}'] },
	{ lines: ['¿Ya {pagaste|hiciste} {lo de la luz|el súper|lo del recibo}?', '{Sí, ayer|Todavía no, mañana|Ya mero}', '{Ok|Va}, {no se te olvide|cualquier cosa me dices}', '{Sí|Claro} {😅|👍|}'] },
	{ lines: ['{Qué calor|Qué frío} {hace hoy|está haciendo} {🥵|🥶|}', '{Demasiado|Muchísimo|Sí, horrible} {jaja|}', '{Ya quiero que cambie|Ni modo} {😂|}'] },
	{ lines: ['¿Cómo {sigue|está} {tu mamá|tu familia|tu papá}?', '{Mejor, gracias|Bien, gracias por preguntar|Ahí va}', '{Qué bueno|Me alegra} {🙏|}, {saludos|mándale saludos}', '{Gracias|Igual} {🙌|}'] },
	{ lines: ['{Oye|Fíjate} que {vi|me acordé de} {algo|una cosa} {chistosa|curiosa} {jaja|😂}', '¿{Qué cosa|De qué}?', '{Luego te cuento|Al rato te digo} {jaja|}', '{Va|Ok, me dejas con la duda} {😂|}'] },
	{ lines: ['¿{Conoces|Sabes de} {algún|un} {mecánico|doctor|plomero} {bueno|de confianza}?', '{Sí, te paso su número|Déjame preguntar|Mmm no, pero pregunto}', '{Gracias|Te lo agradezco}'] },
	{ when: 'morning', lines: ['{Buenos días|Buen día} {☀️|}', '{Buenos días|Buen día}! ¿{Cómo amaneciste|Qué tal}?', '{Bien|Con sueño} {jaja|😴|}', '{Igual|Ánimo} {☕|}'] },
	{ when: 'night', lines: ['{Buenas noches|Ya me voy a dormir} {😴|🌙|}', '{Descansa|Buenas noches|Que descanses}', '{Igualmente|Gracias}'] },
	{ lines: ['¿Ya {viste|empezaste} {la serie|la película} que te dije?', '{Todavía no|Ya, está buenísima|Apenas voy empezando}', '{Tienes que verla|¿Verdad que sí?|Te va a gustar} {😄|}'] },
	{ lines: ['{Gracias por|Gracias, ya me llegó} {lo de ayer|el paquete|la info}', '{De nada|Con gusto|Para eso estamos} {🙌|}'] },
	{ lines: ['¿{Vas a ir|Irás} {a la reunión|a la comida} {del sábado|de mañana}?', '{Sí|Creo que sí|No creo}, ¿{tú|y tú}?', '{Yo sí|Todavía no sé}', '{Va, ahí nos vemos|Ok, me avisas}'] },
	{ lines: ['{Ando|Estoy} {en el súper|haciendo mandados|en la calle}, ¿{necesitas algo|se te ofrece algo}?', '{No, gracias|Si ves {pan|leche|tortillas}, tráeme porfa}', '{Va|Sale|Ok} {👍|}'] },
	{ lines: ['¿{Estás ocupado|Tienes un minuto}?', '{Sí, dime|Un poco, ¿qué pasó?|Ahorita sí}', '{Nada grave|Luego te marco|Era para ver lo de mañana}, {al rato hablamos|no te preocupes}', '{Va|Ok, al rato} {👍|}'] },
	{ lines: ['{Ya llegué|Ya estoy en casa} {🙌|}', '{Qué bueno|Perfecto}, {descansa|me avisas cualquier cosa}'] },
	{ when: 'night', lines: ['¿{Sigues despierto|Ya te dormiste}?', '{Ya casi|Todavía no} {jaja|😴|}', '{Igual|Yo también ya me voy}, {buenas noches|descansa}'] }
]
const REACTS = ['👍', '❤️', '😂', '🙌', '👌', '🔥', '😅', '🙏']
const GREET = { morning: '{Buenos días|Buen día}', afternoon: '{Buenas tardes|Buenas}', night: '{Buenas noches|Buenas}' }

const DEFAULTS = { enabled: false, auto: true, allDay: true, perDay: 6, minDelay: 25, maxDelay: 150, startHour: 9, endHour: 21 }
const GRACE_HOURS = Number(process.env.WARMUP_GRACE_HOURS || 24) // espera tras vincular antes de enviar

export class WarmupManager {
	constructor(manager) {
		this.manager = manager
		this.busy = false
		this.convos = new Map() // charlas en curso
		this.queue = [] // próximos eventos: { at, kind: 'say' | 'read', convoId, readerId, fromPhone }
		// Tras reiniciar el servidor, espera unos minutos a que los números se reconecten antes de hablar
		this.nextConvoAt = Date.now() + rnd(2, 8) * MIN
		this.lastActionAt = 0
		this.seq = 0
		this.timer = setInterval(() => this.tick().catch(() => {}), 5000)
	}

	settings() {
		const row = db.prepare("SELECT value FROM app_settings WHERE key = 'warmup'").get()
		return { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) }
	}
	save(partial) {
		const s = { ...this.settings(), ...partial }
		s.perDay = clamp(Number(s.perDay) || DEFAULTS.perDay, 1, 40)
		s.minDelay = clamp(Number(s.minDelay) || DEFAULTS.minDelay, 5, 360)
		s.maxDelay = clamp(Number(s.maxDelay) || DEFAULTS.maxDelay, s.minDelay, 720)
		s.startHour = clamp(Number(s.startHour) || 0, 0, 23)
		s.endHour = clamp(Number(s.endHour) || 24, s.startHour + 1, 24)
		s.enabled = Boolean(s.enabled)
		s.auto = s.auto === undefined ? true : Boolean(s.auto)
		s.allDay = s.allDay === undefined ? true : Boolean(s.allDay)
		db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('warmup', ?)").run(JSON.stringify(s))
		if (s.enabled) this.nextConvoAt = Math.min(this.nextConvoAt, Date.now() + rnd(0.5, 3) * MIN)
		else { this.convos.clear(); this.queue = [] }
		return s
	}

	// ---- Análisis de cada número ----
	since(a) { return Math.max(a.linked_at || 0, a.rest_ended_at || 0) }
	ageDays(a) { const s = this.since(a); return s ? Math.floor((Date.now() - s) / DAY) : 0 }
	ageHours(a) { const s = this.since(a); return s ? (Date.now() - s) / 36e5 : 0 }
	// Horario de sueño propio de cada número: se recorre entre -1 y +2 horas (unos más madrugadores)
	sleepShift(a) { return Math.floor(hash01(a.id, 7) * 4) - 1 }
	awake(a, hour) { return CURVE[((hour - this.sleepShift(a)) % 24 + 24) % 24] }
	// Ese día habla un poco más o menos (0.7–1.15); los días de descanso, menos
	dayFactor(a) {
		const f = 0.7 + hash01(a.id, Math.floor(startOfDay() / DAY)) * 0.45
		let rest = [0]
		try { rest = JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key = 'rest_days'").get()?.value || '[0]') } catch {}
		return rest.includes(tzNow().wd) ? f * 0.6 : f
	}

	// MODO AUTOMÁTICO: según estado, rechazos y antigüedad decide cuántos mensajes al día
	autoBase(a) {
		const info = this.manager.accountInfo(a.id)
		if (!info || info.status !== 'connected') return 0
		const h = accountHealth(a.id, info.status)
		if (!h || h.level === 'red') return 0 // descansando, desconectado o con rechazos: no lo cargamos
		if (this.ageHours(a) < GRACE_HOURS) return 0 // recién vinculado: solo recibe
		const age = h.ageDays
		if (age < 1) return 2
		if (age < 3) return 2 + age // día 1: 3, día 2: 4
		if (h.level === 'yellow') return 3
		if (age < 7) return 6
		return 8 // número maduro y sano: mantenimiento para verse activo
	}
	targetFor(a, s) {
		let base
		if (s.auto) base = this.autoBase(a)
		else base = this.ageHours(a) < GRACE_HOURS ? 0 : Math.min(s.perDay, 3 + 2 * this.ageDays(a))
		if (!base) return 0
		const t = Math.max(1, Math.round(base * this.dayFactor(a)))
		return s.auto ? t : Math.min(s.perDay, t)
	}

	// Números de WhatsApp normal conectados, con número y sin descanso
	eligible() {
		const rows = db.prepare("SELECT id, name, phone, linked_at, rest_ended_at, rest_until FROM accounts WHERE (kind IS NULL OR kind != 'cloud') AND phone IS NOT NULL AND phone != ''").all()
		const now = Date.now()
		return rows.filter(a => {
			if (a.rest_until && a.rest_until > now) return false
			try { return this.manager.accountInfo(a.id)?.status === 'connected' } catch { return false }
		})
	}
	sentToday(id) { return db.prepare('SELECT COUNT(*) AS n FROM warmup_log WHERE account_id = ? AND ts > ?').get(id, startOfDay()).n }
	canSend(a, s) { return this.sentToday(a.id) < this.targetFor(a, s) }
	lastPair(a, b) {
		return db.prepare('SELECT MAX(ts) AS t FROM warmup_log WHERE (account_id = ? AND peer_id = ?) OR (account_id = ? AND peer_id = ?)').get(a, b, b, a).t || 0
	}
	inWindow(s, hour) {
		if (s.allDay) return true
		return s.startHour <= s.endHour ? hour >= s.startHour && hour < s.endHour : hour >= s.startHour || hour < s.endHour
	}

	// ---- Estado para la pantalla ----
	status() {
		const s = this.settings()
		const elig = this.eligible()
		const { h } = tzNow()
		const total = elig.reduce((n, a) => n + this.targetFor(a, s), 0)
		const w = CURVE[h]
		return {
			...s,
			eligible: elig.length,
			running: s.enabled && elig.length >= 2,
			plan: {
				totalPerDay: total,
				activity: w >= 0.7 ? 'alta' : w >= 0.3 ? 'media' : 'baja',
				nextConvoIn: s.enabled ? Math.max(0, Math.round((this.nextConvoAt - Date.now()) / MIN)) : null,
				activeConvos: this.convos.size,
				startHour: s.allDay ? 0 : s.startHour,
				endHour: s.allDay ? 24 : s.endHour
			},
			numbers: elig.map(a => ({
				id: a.id, name: a.name, sentToday: this.sentToday(a.id), target: this.targetFor(a, s),
				ageDays: this.ageDays(a), asleep: this.awake(a, h) < 0.15, grace: this.ageHours(a) < GRACE_HOURS
			}))
		}
	}

	// ---- Motor ----
	async tick() {
		if (this.busy) return
		const s = this.settings()
		if (!s.enabled) return
		const elig = this.eligible()
		if (elig.length < 2) return
		this.busy = true
		try {
			const now = Date.now()
			const byId = new Map(elig.map(a => [a.id, a]))
			// 1) Lecturas pendientes (el que recibió abre el chat)
			for (const ev of this.queue.filter(e => e.kind === 'read' && e.at <= now)) {
				this.queue = this.queue.filter(e => e !== ev)
				try { await this.manager.get(ev.readerId).markRead(jidOf(ev.fromPhone)) } catch {}
			}
			// 2) Un mensaje a la vez, con respiro entre cualquier envío
			if (now >= this.lastActionAt) {
				const due = this.queue.filter(e => e.kind === 'say' && e.at <= now).sort((a, b) => a.at - b.at)[0]
				if (due) { this.queue = this.queue.filter(e => e !== due); await this.say(due, byId, s) }
			}
			// 3) ¿Empieza otra charla?
			const { h, wd } = tzNow()
			if (Date.now() >= this.nextConvoAt) {
				if (this.inWindow(s, h)) this.spawn(elig, s, h, wd)
				this.scheduleNextConvo(s, elig, h)
			}
		} finally { this.busy = false }
	}

	spawn(elig, s, hour, wd) {
		const maxActive = Math.min(3, Math.floor(elig.length / 2))
		if (this.convos.size >= maxActive) return
		const busyIds = new Set([...this.convos.values()].flatMap(c => [c.a, c.b]))
		// Quién empieza: el que está despierto y aún tiene cupo
		const ready = elig.filter(a => !busyIds.has(a.id) && this.canSend(a, s))
		const starter = weighted(ready, a => this.awake(a, hour) ** 1.5 * (this.targetFor(a, s) - this.sentToday(a.id)))
		if (!starter) return
		// Con quién: preferir a quien no ha hablado con él hace tiempo
		const partners = elig.filter(x => x.id !== starter.id && !busyIds.has(x.id))
		const partner = weighted(partners, x => (0.2 + this.awake(x, hour)) * clamp((Date.now() - this.lastPair(starter.id, x.id)) / DAY, 0.15, 1.5))
		if (!partner) return
		const night = hour >= 21 || hour < 3
		const morning = hour >= 6 && hour < 12
		const weekend = [5, 6, 0].includes(wd)
		// Guion según el momento del día, evitando repetir los usados hace poco
		this.recent = this.recent || []
		const script = weighted(SCRIPTS, sc => (this.recent.includes(sc) ? 0.05 : 1) *
			(!sc.when ? (night ? 0.4 : 1) : sc.when === 'night' ? (night ? 3 : 0) : sc.when === 'morning' ? (morning ? 2 : 0) : sc.when === 'weekend' ? (weekend ? 1.5 : 0) : 1))
		if (!script) return
		this.recent = [script, ...this.recent].slice(0, 8)
		const lines = [...script.lines]
		// A veces el primer mensaje lleva saludo según la hora
		if (!script.when && Math.random() < 0.3) lines[0] = `${morning ? GREET.morning : hour < 19 ? GREET.afternoon : GREET.night}. ${lines[0]}`
		const id = ++this.seq
		this.convos.set(id, { id, a: starter.id, b: partner.id, lines, i: 0, when: script.when || null })
		this.queue.push({ at: Date.now() + rnd(0, 40) * 1000, kind: 'say', convoId: id })
	}

	end(convoId) {
		this.convos.delete(convoId)
		this.queue = this.queue.filter(e => !(e.kind === 'say' && e.convoId === convoId))
	}

	async say(ev, byId, s) {
		const c = this.convos.get(ev.convoId)
		if (!c) return
		const speaker = byId.get(c.i % 2 === 0 ? c.a : c.b)
		const listener = byId.get(c.i % 2 === 0 ? c.b : c.a)
		if (!speaker || !listener || !this.canSend(speaker, s)) return this.end(c.id)
		const isLast = c.i === c.lines.length - 1
		const session = this.manager.get(speaker.id)
		const toJid = jidOf(listener.phone)
		const { h } = tzNow()
		try {
			await session.online(irnd(25, 90) * 1000)
			// El cierre a veces es solo una reacción (👍) en vez de escribir
			if (isLast && c.i > 0 && Math.random() < 0.35 && await session.reactLast(toJid, pick(REACTS))) {
				this.log(speaker.id, listener.id)
				return this.end(c.id)
			}
			// A media charla, a veces reacciona y luego contesta
			if (c.i > 0 && !isLast && Math.random() < 0.1) { await session.reactLast(toJid, pick(REACTS)); await sleep(irnd(800, 2500)) }
			const text = vary(c.lines[c.i])
			await session.setPresence(toJid, 'composing')
			await sleep(Math.min(6000, irnd(700, 1300) + text.length * irnd(30, 60)))
			await session.send(toJid, { text })
			await session.setPresence(toJid, 'paused')
			this.log(speaker.id, listener.id)
		} catch {
			return this.end(c.id)
		} finally {
			this.lastActionAt = Date.now() + irnd(6, 18) * 1000 // respiro antes de cualquier otro envío
		}
		c.i++
		const t = this.replyTiming(listener, h)
		this.queue.push({ at: Date.now() + t.readIn, kind: 'read', readerId: listener.id, fromPhone: speaker.phone })
		// Fin del guion, o a veces se queda "en visto".
		// Un "buenas noches" a alguien dormido solo se lee en la mañana, no se contesta.
		const asleep = this.awake(listener, h) < 0.15
		if (c.i >= c.lines.length || (c.i >= 2 && Math.random() < 0.07) || (asleep && c.when === 'night')) return this.end(c.id)
		this.queue.push({ at: Date.now() + t.readIn + t.replyIn, kind: 'say', convoId: c.id })
	}

	// Cuándo lee y cuándo contesta el otro, según qué tan despierto está
	replyTiming(a, hour) {
		const w = this.awake(a, hour)
		if (w < 0.15) { // dormido: lo verá cuando despierte
			let ahead = 1
			while (ahead < 24 && this.awake(a, (hour + ahead) % 24) < 0.35) ahead++
			const { m } = tzNow()
			return { readIn: ((ahead * 60 - m) + rnd(0, 50)) * MIN, replyIn: rnd(0.3, 5) * MIN }
		}
		if (w < 0.5) return { readIn: rnd(1, 25) * MIN, replyIn: rnd(0.25, 3) * MIN }
		const r = Math.random()
		const readIn = r < 0.7 ? rnd(4, 45) * 1000 : r < 0.93 ? rnd(1, 8) * MIN : rnd(8, 35) * MIN
		return { readIn, replyIn: rnd(10, 90) * 1000 }
	}

	// Cada cuánto empieza una charla nueva: más seguido de día, muy poco de noche
	scheduleNextConvo(s, elig, hour) {
		const total = elig.reduce((n, a) => n + this.targetFor(a, s), 0)
		if (!total) { this.nextConvoAt = Date.now() + 30 * MIN; return }
		const w = Math.max(CURVE[hour], 0.04)
		let gapMin
		if (s.auto) {
			const perDay = Math.max(1, total / AVG_LINES)
			const windowSum = s.allDay ? sumCurve(0, 0) : sumCurve(s.startHour, s.endHour % 24)
			const mean = windowSum * 60 / perDay / w
			gapMin = clamp(-Math.log(1 - Math.random()) * mean, 6, 360) // intervalos irregulares, como una persona
		} else {
			gapMin = rnd(s.minDelay, s.maxDelay) / Math.max(w, 0.2)
		}
		this.nextConvoAt = Date.now() + gapMin * MIN
	}

	log(from, to) { db.prepare('INSERT INTO warmup_log (account_id, peer_id, ts) VALUES (?, ?, ?)').run(from, to, Date.now()) }
}

// Elige un elemento al azar según su peso
function weighted(list, weightOf) {
	const items = list.map(x => [x, Math.max(0, weightOf(x) || 0)]).filter(([, w]) => w > 0)
	const total = items.reduce((n, [, w]) => n + w, 0)
	if (!total) return null
	let r = Math.random() * total
	for (const [x, w] of items) { r -= w; if (r <= 0) return x }
	return items[items.length - 1][0]
}
