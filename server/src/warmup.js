import { db } from './db.js'
import { accountHealth } from './health.js'
import { vary } from './text.js'

// Calentamiento: tus propios números conversan entre sí para que las cuentas se vean activas
// y "maduren" antes de usarlas en envíos. Solo son TUS números hablando entre ellos.
//
// Para parecer personas reales:
// - Curva de actividad humana de 24 h (mucho de día, casi nada de madrugada). Cada número tiene su
//   propio horario de sueño y el fin de semana todos se levantan un poco más tarde.
// - Charlas coherentes según el momento (mañana, comida, tarde, noche, lunes, fin de semana).
// - Varias charlas a la vez; respuestas en segundos, minutos o al día siguiente si el otro duerme.
//   A veces se queda en visto, a veces contesta en dos mensajes seguidos o citando el mensaje.
// - "En línea" → leído → "escribiendo…" (a veces duda y vuelve a escribir) → mensaje → desconectado.
// - Reparte el cupo del día según lo que falta y la hora: no se atrasa ni se amontona de noche.
// - Da más charla de ida y vuelta a los números que hoy hicieron envíos masivos.
// - Recién vinculados: solo reciben. En descanso de masivos: charlas ligeras para recuperarse.
// - Las charlas en curso sobreviven a un reinicio del servidor.

const TZ = process.env.TZ_CAMPAIGNS || 'America/Mexico_City'
const DAY = 864e5
const MIN = 60000
const rnd = (a, b) => a + Math.random() * (b - a)
const irnd = (a, b) => Math.floor(rnd(a, b + 1))
const pick = arr => arr[Math.floor(Math.random() * arr.length)]
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const digits = phone => String(phone || '').replace(/\D/g, '')
const jidOf = phone => `${digits(phone)}@s.whatsapp.net`
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

const FMT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', hourCycle: 'h23' })
// Hora, minuto y día de la semana en México (el servidor está en UTC)
function tzNow(t = Date.now()) {
	const p = {}
	for (const x of FMT.formatToParts(new Date(t))) p[x.type] = x.value
	return { h: Number(p.hour) % 24, m: Number(p.minute), s: Number(p.second), wd: WD[p.weekday] }
}
const startOfDay = () => { const t = tzNow(); return Date.now() - ((t.h * 60 + t.m) * 60 + t.s) * 1000 }
const dayKey = () => Math.floor((startOfDay() + 6 * 36e5) / DAY)
const isWeekend = wd => wd === 0 || wd === 6
// Número pseudoaleatorio estable entre 0 y 1 (mismo resultado para los mismos datos)
const hash01 = (...nums) => { let h = 2166136261; for (const n of nums) { h ^= n; h = Math.imul(h, 16777619) } return (h >>> 0) / 4294967296 }

// Actividad típica de una persona por hora (0–23)
const CURVE = [0.28, 0.14, 0.07, 0.04, 0.04, 0.07, 0.18, 0.42, 0.68, 0.85, 0.95, 1, 1, 0.95, 0.85, 0.82, 0.88, 0.95, 1, 1, 0.95, 0.85, 0.66, 0.46]
const DAY_SUM = CURVE.reduce((a, b) => a + b, 0)
// Actividad que queda desde "ahora" hasta la hora `end` (0–24), contando la fracción de la hora actual
function curveLeft(h, m, end = 24) {
	if (end <= h) return 0
	let s = CURVE[h] * (1 - m / 60)
	for (let x = h + 1; x < end; x++) s += CURVE[x]
	return s
}
function curveSpan(from, to) { let s = 0; for (let x = from; x < to; x++) s += CURVE[x]; return s }

db.exec(`CREATE TABLE IF NOT EXISTS warmup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  peer_id INTEGER,
  ts INTEGER NOT NULL
)`)
db.exec('CREATE INDEX IF NOT EXISTS idx_warmup_ts ON warmup_log (account_id, ts)')
db.exec('CREATE INDEX IF NOT EXISTS idx_warmup_ts_only ON warmup_log (ts)')
db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)')

const q = {
	log: db.prepare('INSERT INTO warmup_log (account_id, peer_id, ts) VALUES (?, ?, ?)'),
	sentSince: db.prepare('SELECT account_id AS id, COUNT(*) AS n FROM warmup_log WHERE ts > ? GROUP BY account_id'),
	recvSince: db.prepare('SELECT peer_id AS id, COUNT(*) AS n FROM warmup_log WHERE ts > ? AND peer_id IS NOT NULL GROUP BY peer_id'),
	pairs: db.prepare('SELECT account_id AS a, peer_id AS b, MAX(ts) AS t FROM warmup_log WHERE ts > ? AND peer_id IS NOT NULL GROUP BY account_id, peer_id'),
	perDay: db.prepare('SELECT ts FROM warmup_log WHERE ts > ?'),
	prune: db.prepare('DELETE FROM warmup_log WHERE ts < ?'),
	accounts: db.prepare("SELECT id, name, phone, linked_at, rest_ended_at, rest_until FROM accounts WHERE (kind IS NULL OR kind != 'cloud') AND phone IS NOT NULL AND phone != ''"),
	getSetting: db.prepare('SELECT value FROM app_settings WHERE key = ?'),
	setSetting: db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)'),
	lidsOf: db.prepare('SELECT lid FROM lid_map WHERE pn = ?'),
	chatTs: db.prepare('SELECT last_ts FROM chats WHERE account_id = ? AND jid = ?'),
	lastIn: db.prepare('SELECT id, remote_jid, participant, text FROM messages WHERE account_id = ? AND jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT 1')
}
let campaignStmt = null
function campaignToday(since) {
	try {
		campaignStmt ||= db.prepare("SELECT sent_by AS id, COUNT(*) AS n FROM campaign_items WHERE status = 'sent' AND sent_at > ? GROUP BY sent_by")
		return new Map(campaignStmt.all(since).map(r => [r.id, r.n]))
	} catch { return new Map() }
}

// Guiones: las líneas se alternan entre los dos números (A, B, A, B…).
// {a|b|c} = variantes; opciones vacías ({😅|}) a veces no ponen nada; "||" = dos mensajes seguidos.
// when: morning (6–11), lunch (12–16), afternoon (16–20), night (21–2), monday, weekend (vie–dom).
// greets: el guion ya empieza saludando (no se le antepone "Buenas tardes").
const SCRIPTS = [
	{ greets: true, lines: ['{Hola|Qué onda|Buenas}||¿{cómo vas|cómo estás|qué tal todo}?', '{Bien|Muy bien|Todo bien}, {gracias|aquí andamos}. ¿{Y tú|Tú qué tal}?', '{Bien también|Todo tranquilo|Aquí, trabajando} {😅|🙌|}', '{Qué bueno|Me da gusto|Excelente} {👍|}'] },
	{ when: 'lunch', lines: ['¿Ya {comiste|almorzaste}?', '{Todavía no|Apenas voy|Sí, hace rato} {😂|}', '{Yo tampoco|Yo ya|Igual} jaja, {hoy hay|me tocó} {tacos|pozole|comida corrida|tortas|enchiladas}', '{Qué rico|Se me antojó|Provecho} {🤤|😋|}'] },
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
	{ lines: ['¿{Conoces|Sabes de} {algún|un} {mecánico|doctor|plomero|electricista} {bueno|de confianza}?', '{Sí, te paso su número|Déjame preguntar|Mmm no, pero pregunto}', '{Gracias|Te lo agradezco}'] },
	{ when: 'morning', greets: true, lines: ['{Buenos días|Buen día} {☀️|}', '{Buenos días|Buen día}! ¿{Cómo amaneciste|Qué tal}?', '{Bien|Con sueño} {jaja|😴|}', '{Igual|Ánimo} {☕|}'] },
	{ when: 'morning', greets: true, lines: ['{Buenos días|Buen día}, ¿{ya desayunaste|ya vas para allá}?', '{Apenas|Ya, gracias|Todavía no} {☕|}', '{Va|Ok}, {buen día|que te vaya bien}'] },
	{ when: 'night', greets: true, lines: ['{Buenas noches|Ya me voy a dormir} {😴|🌙|}', '{Descansa|Buenas noches|Que descanses}', '{Igualmente|Gracias}'] },
	{ when: 'night', lines: ['¿{Sigues despierto|Ya te dormiste}?', '{Ya casi|Todavía no} {jaja|😴|}', '{Igual|Yo también ya me voy}, {buenas noches|descansa}'] },
	{ lines: ['¿Ya {viste|empezaste} {la serie|la película} que te dije?', '{Todavía no|Ya, está buenísima|Apenas voy empezando}', '{Tienes que verla|¿Verdad que sí?|Te va a gustar} {😄|}'] },
	{ lines: ['{Gracias por|Gracias, ya me llegó} {lo de ayer|el paquete|la info}', '{De nada|Con gusto|Para eso estamos} {🙌|}'] },
	{ lines: ['¿{Vas a ir|Irás} {a la reunión|a la comida} {del sábado|de mañana}?', '{Sí|Creo que sí|No creo}, ¿{tú|y tú}?', '{Yo sí|Todavía no sé}', '{Va, ahí nos vemos|Ok, me avisas}'] },
	{ lines: ['{Ando|Estoy} {en el súper|haciendo mandados|en la calle}, ¿{necesitas algo|se te ofrece algo}?', '{No, gracias|Si ves {pan|leche|tortillas}, tráeme porfa}', '{Va|Sale|Ok} {👍|}'] },
	{ lines: ['¿{Estás ocupado|Tienes un minuto}?', '{Sí, dime|Un poco, ¿qué pasó?|Ahorita sí}', '{Nada grave|Luego te marco|Era para ver lo de mañana}, {al rato hablamos|no te preocupes}', '{Va|Ok, al rato} {👍|}'] },
	{ lines: ['{Ya llegué|Ya estoy en casa} {🙌|}', '{Qué bueno|Perfecto}, {descansa|me avisas cualquier cosa}'] },
	{ when: 'monday', lines: ['{Ya es lunes|Otra vez lunes} {😩|😴|}', '{Ni me digas|No me recuerdes|Ánimo} {jaja|😂|}', '{A darle|Ni modo, a trabajar} {💪|}'] },
	{ lines: ['¿{Tienes|Traes} {cargador|cable} {de iPhone|tipo C}?', '{Sí, ¿lo necesitas?|No, se me olvidó|Creo que sí}', '{Sí porfa|No, ya conseguí|Luego te digo}', '{Va|Ok} {👍|}'] },
	{ lines: ['{Mañana|El lunes} {tengo que|hay que} {ir al banco|pasar al centro|hacer un trámite}, ¿{me acompañas|vas a ir}?', '{Sí, ¿a qué hora?|No puedo, perdón|Depende de la hora}', '{Temprano|Como a las 10|En la tarde}', '{Va|Ok, me avisas} {👍|}'] },
	{ lines: ['{Se me olvidó|Ya no me acordé de} {decirte|comentarte} lo {de mañana|del sábado} {😅|}', '¿{Qué pasó|Qué cosa}?', '{Que siempre sí|Que se movió para otro día|Que al final no}', '{Ah, ok|Va, gracias por avisar|Entendido}'] },
	{ greets: true, lines: ['{Buenas|Hola}, ¿{todo bien|cómo va el día}?', '{Todo bien|Pesado pero bien|Tranquilo}, ¿{y tú|tú}?', '{Igual|Bien, gracias} {🙌|}'] },
	{ lines: ['¿{Ya viste|Viste} el precio de {la gasolina|el gas|las tortillas|el aguacate}?', '{Sí, carísimo|No manches, ¿subió otra vez?|Ni me digas}', '{Todo sube|Así está todo} {😩|}'] },
	{ when: 'afternoon', lines: ['¿Qué {vas a hacer|haces} {hoy en la noche|al rato}?', '{Nada|Descansar|Ver una peli}, ¿{por?|qué pasó?}', '{Para ver si salíamos|Nada, era pregunta} {jaja|}', '{Va, luego vemos|Otro día} {👍|}'] },
	{ when: 'afternoon', lines: ['¿{Sigues en el trabajo|Ya saliste}?', '{Todavía no|Ya mero|Ya, voy en camino}', '{Va|Ok}, {con cuidado|avísame cuando llegues}'] },
	{ lines: ['¿Ya {llegaste|estás en tu casa}?', '{Ya|Todavía no, ya casi|Sí, hace rato}', '{Va|Ok}, {avísame|cuídate}'] },
	{ lines: ['{Ando|Estoy} {bien cansado|muerto} {hoy|jaja}', '{Igual yo|¿Mucho trabajo?|Descansa}', '{Sí, bastante|Un montón} {😩|}', '{Ánimo|Ya mero es fin de semana} {💪|}'] },
	{ lines: ['¿{Sabes|Supiste} si {mañana|el lunes} {abren|trabajan} {los bancos|las oficinas}?', '{Creo que sí|No sé, déjame ver|Sí, normal}', '{Gracias|Va, gracias}'] },
	{ lines: ['{Mira|Oye}, {me acordé de ti|me pasó algo chistoso} {jaja|😂}', '{Jajaja|Jaja} ¿{qué pasó|por?} {😂|}', '{Luego te cuento bien|Al rato te platico} {jaja|}'] },
	{ lines: ['¿{Me puedes|Puedes} marcar {cuando puedas|al rato}?', '{Sí, en 10 min|Ahorita no puedo, en un rato|Va}', '{Ok|Gracias}'] },
	{ weight: 0.25, lines: ['{Feliz cumpleaños|Felicidades}!! {🎂|🎉|🥳}', '{Muchas gracias|Gracias}!! {❤️|🙌|}'] }
]
const REACTS = ['👍', '❤️', '😂', '🙌', '👌', '🔥', '😅', '🙏']
const GREET = { morning: '{Buenos días|Buen día}', afternoon: '{Buenas tardes|Buenas}', night: '{Buenas noches|Buenas}' }
// Mensajes promedio por charla (contando los que se parten en dos)
const AVG_LINES = SCRIPTS.reduce((n, s) => n + s.lines.length, 0) / SCRIPTS.length

const DEFAULTS = { enabled: false, auto: true, allDay: true, perDay: 6, minDelay: 25, maxDelay: 150, startHour: 9, endHour: 21 }
const GRACE_HOURS = Number(process.env.WARMUP_GRACE_HOURS || 24) // espera tras vincular antes de enviar
const GRACE_RECEIVE = 6 // mensajes que puede recibir al día un número recién vinculado
const MAX_ACTIVE = 4 // charlas a la vez como máximo
const OVERFLOW = 3 // mensajes extra para terminar una charla ya empezada aunque se acabe el cupo

// Momento del día para elegir guion
function moments(h, wd) {
	return {
		morning: h >= 6 && h < 12,
		lunch: h >= 12 && h < 16,
		afternoon: h >= 16 && h < 21,
		night: h >= 21 || h < 3,
		monday: wd === 1 && h < 14,
		weekend: wd === 5 ? h >= 14 : wd === 6 || wd === 0
	}
}
const BOOST = { morning: 2, lunch: 2, afternoon: 1.5, night: 3, monday: 2, weekend: 1.5 }

// Parte un texto en dos mensajes como lo haría una persona ("Bien, gracias." + "¿Y tú?")
function bubbles(raw) {
	const parts = raw.split('||').map(vary).filter(Boolean)
	if (parts.length > 1) {
		if (Math.random() < 0.8) return parts
		// Juntos en un solo mensaje: "Hola, ¿cómo estás?" o "Buenas tardes. ¿Ya comiste?"
		return [parts.reduce((a, b) => `${a}${/^[¿¡]?[A-ZÁÉÍÓÚÑ]/u.test(b) ? '.' : ','} ${b}`)]
	}
	const t = parts[0] || ''
	const m = t.match(/^(.{4,}?[.!?])\s+([¿¡A-ZÁÉÍÓÚÑ].{2,})$/u)
	return m && Math.random() < 0.3 ? [m[1], m[2]] : [t]
}

export class WarmupManager {
	constructor(manager) {
		this.manager = manager
		this.busy = false
		this.convos = new Map() // charlas en curso
		this.queue = [] // próximos eventos: { at, kind: 'say' | 'read', convoId, readerId, fromPhone }
		this.recent = [] // índices de guiones usados hace poco
		this.seq = 0
		this.avgLines = AVG_LINES
		this.lastActionAt = 0
		// Tras reiniciar, espera unos minutos a que los números se reconecten antes de hablar
		this.nextConvoAt = Date.now() + rnd(2, 8) * MIN
		this.s = this.loadSettings()
		this.day = null
		this.snap = null
		this.dirty = false
		try { q.prune.run(Date.now() - 60 * DAY) } catch {}
		this.loadPairs()
		this.restore()
		this.timer = setInterval(() => this.tick().catch(() => { this.busy = false }), 5000)
		this.timer.unref?.()
	}

	// ---- Ajustes ----
	loadSettings() {
		try { return { ...DEFAULTS, ...JSON.parse(q.getSetting.get('warmup')?.value || '{}') } } catch { return { ...DEFAULTS } }
	}
	settings() { return { ...this.s } }
	save(partial) {
		const s = { ...this.s, ...partial }
		s.perDay = clamp(Number(s.perDay) || DEFAULTS.perDay, 1, 40)
		s.minDelay = clamp(Number(s.minDelay) || DEFAULTS.minDelay, 5, 360)
		s.maxDelay = clamp(Number(s.maxDelay) || DEFAULTS.maxDelay, s.minDelay, 720)
		s.startHour = clamp(Math.floor(Number(s.startHour) || 0), 0, 23)
		s.endHour = clamp(Math.floor(Number(s.endHour) || 24), s.startHour + 1, 24)
		s.enabled = Boolean(s.enabled)
		s.auto = s.auto === undefined ? true : Boolean(s.auto)
		s.allDay = s.allDay === undefined ? true : Boolean(s.allDay)
		q.setSetting.run('warmup', JSON.stringify(s))
		const wasOn = this.s.enabled
		this.s = s
		this.snap = null
		if (s.enabled && !wasOn) this.nextConvoAt = Date.now() + rnd(0.5, 3) * MIN
		if (s.enabled) this.nextConvoAt = Math.min(this.nextConvoAt, Date.now() + 20 * MIN)
		else { this.convos.clear(); this.queue = [] }
		this.dirty = true
		this.persist()
		return s
	}
	// Empieza una charla en cuanto se pueda (botón "Iniciar ahora")
	kick() {
		if (!this.s.enabled) throw new Error('Activa el calentamiento primero')
		this.snap = null
		this.nextConvoAt = Date.now()
		this.forceNext = true
		this.replanOnly = false
		setTimeout(() => this.tick().catch(() => {}), 50)
	}

	// ---- Estado guardado (para no cortar charlas al reiniciar) ----
	persist() {
		if (!this.dirty) return
		this.dirty = false
		try {
			q.setSetting.run('warmup_state', JSON.stringify({ convos: [...this.convos.values()], queue: this.queue, nextConvoAt: this.nextConvoAt, recent: this.recent, seq: this.seq, avgLines: this.avgLines }))
		} catch {}
	}
	restore() {
		let st
		try { st = JSON.parse(q.getSetting.get('warmup_state')?.value || 'null') } catch {}
		if (!st || !this.s.enabled) return
		const now = Date.now()
		this.seq = st.seq || 0
		if (st.avgLines > 0) this.avgLines = clamp(st.avgLines, 1.5, 6)
		this.recent = (st.recent || []).filter(i => Number.isInteger(i) && SCRIPTS[i])
		for (const c of st.convos || []) if (c && now - (c.lastAt || 0) < 30 * 36e5) this.convos.set(c.id, c)
		// Lo que se debía hacer mientras estuvo apagado se reprograma escalonado, no todo de golpe
		let k = 0
		this.queue = (st.queue || []).filter(e => e && (e.kind === 'read' ? now - e.at < 12 * 36e5 : this.convos.has(e.convoId)))
			.map(e => (e.at < now + 2 * MIN ? { ...e, at: now + (3 + k++ * rnd(1, 3)) * MIN } : e))
		for (const c of this.convos.values()) if (!this.queue.some(e => e.kind === 'say' && e.convoId === c.id)) this.convos.delete(c.id)
		if (st.nextConvoAt > this.nextConvoAt) this.nextConvoAt = st.nextConvoAt
	}

	// ---- Contadores en memoria (se recargan al cambiar de día) ----
	loadCounters() {
		const d = dayKey()
		if (this.day === d) return
		this.day = d
		const since = startOfDay()
		this.sent = new Map(q.sentSince.all(since).map(r => [r.id, r.n]))
		this.recv = new Map(q.recvSince.all(since).map(r => [r.id, r.n]))
		this.snap = null
		try { q.prune.run(Date.now() - 60 * DAY) } catch {}
	}
	loadPairs() {
		this.pairs = new Map()
		for (const r of q.pairs.all(Date.now() - 14 * DAY)) {
			const k = r.a < r.b ? `${r.a}:${r.b}` : `${r.b}:${r.a}`
			this.pairs.set(k, Math.max(this.pairs.get(k) || 0, r.t))
		}
	}
	lastPair(a, b) { return this.pairs.get(a < b ? `${a}:${b}` : `${b}:${a}`) || 0 }
	sentToday(id) { this.loadCounters(); return this.sent.get(id) || 0 }
	recvToday(id) { this.loadCounters(); return this.recv.get(id) || 0 }
	log(from, to) {
		const now = Date.now()
		q.log.run(from, to, now)
		this.loadCounters()
		this.sent.set(from, (this.sent.get(from) || 0) + 1)
		this.recv.set(to, (this.recv.get(to) || 0) + 1)
		this.pairs.set(from < to ? `${from}:${to}` : `${to}:${from}`, now)
	}

	// ---- Análisis de cada número ----
	since(a) { return Math.max(a.linked_at || 0, a.rest_ended_at || 0) }
	ageDays(a) { const s = this.since(a); return s ? Math.floor((Date.now() - s) / DAY) : 0 }
	ageHours(a) { const s = this.since(a); return s ? (Date.now() - s) / 36e5 : 0 }
	// Horario de sueño propio (de -1 a +2 h); el fin de semana todos se levantan una hora más tarde
	sleepShift(a, wd) { return Math.floor(hash01(a.id, 7) * 4) - 1 + (isWeekend(wd) ? 1 : 0) }
	awake(a, hour, wd = tzNow().wd) { return CURVE[((hour - this.sleepShift(a, wd)) % 24 + 24) % 24] }
	restDays() {
		try { return JSON.parse(q.getSetting.get('rest_days')?.value || '[0]') } catch { return [0] }
	}
	// Ese día habla un poco más o menos (0.7–1.15); los días de descanso, menos
	dayFactor(a, rest, wd) {
		const f = 0.7 + hash01(a.id, this.day) * 0.45
		return rest.includes(wd) ? f * 0.6 : f
	}

	// MODO AUTOMÁTICO: según estado, rechazos, antigüedad y masivos de hoy decide cuántos mensajes al día
	autoBase(a, h, camp) {
		if (!h || a.grace) return 0
		if (h.restUntil) return h.rejections24h >= 2 ? 0 : 2 // descanso de masivos: charla ligera para recuperarse
		if (h.level === 'red') return 0 // rechazos o mensajes que no se entregan: no lo cargamos
		const age = h.ageDays
		let base
		if (age < 1) base = 2
		else if (age < 3) base = 2 + age // día 1: 3, día 2: 4
		else if (h.level === 'yellow') base = 3
		else if (age < 7) base = 6
		else base = 8 // número maduro y sano: mantenimiento para verse activo
		// Si hoy hizo envíos masivos, más charla de ida y vuelta para equilibrar
		if (camp >= 20 && h.level === 'green') base += Math.min(4, 1 + Math.floor(camp / 40))
		return base
	}

	// Foto del momento: números conectados con su salud y cupo (se recalcula cada minuto)
	snapshot(force = false) {
		this.loadCounters()
		if (!force && this.snap && Date.now() - this.snap.at < MIN) return this.snap
		const s = this.s
		const now = Date.now()
		const { wd } = tzNow()
		const rest = this.restDays()
		const camp = campaignToday(startOfDay())
		const list = []
		for (const row of q.accounts.all()) {
			if (this.manager.sessions.get(row.id)?.status !== 'connected') continue
			const a = { ...row, grace: this.ageHours(row) < GRACE_HOURS, campaign: camp.get(row.id) || 0 }
			let h = null
			try { h = accountHealth(a.id, 'connected') } catch {}
			a.level = h?.level || 'red'
			a.resting = Boolean(h?.restUntil || (a.rest_until && a.rest_until > now))
			let base
			if (s.auto) base = this.autoBase(a, h, a.campaign)
			else base = a.grace || a.level === 'red' ? 0 : Math.min(s.perDay, 3 + 2 * this.ageDays(a))
			a.target = base ? Math.max(1, Math.round(base * this.dayFactor(a, rest, wd))) : 0
			if (!s.auto) a.target = Math.min(s.perDay, a.target)
			list.push(a)
		}
		this.snap = { at: now, list, byId: new Map(list.map(a => [a.id, a])) }
		return this.snap
	}
	live(id) { return this.manager.sessions.get(id)?.status === 'connected' }
	canSpeak(a, continuing) { return !a.grace && a.target > 0 && this.sentToday(a.id) < a.target + (continuing ? OVERFLOW : 0) }
	inWindow(hour) {
		const s = this.s
		if (s.allDay) return true
		return hour >= s.startHour && hour < s.endHour
	}
	// JID con el que este número tiene guardado el chat del otro (puede estar como @lid)
	chatJid(accountId, phone) {
		const pn = jidOf(phone)
		let best = pn
		let bestTs = q.chatTs.get(accountId, pn)?.last_ts ?? -1
		for (const { lid } of q.lidsOf.all(pn)) {
			const t = q.chatTs.get(accountId, lid)?.last_ts ?? -1
			if (t > bestTs) { best = lid; bestTs = t }
		}
		return best
	}

	// ---- Estado para la pantalla ----
	status() {
		const s = this.s
		const snap = this.snapshot()
		const { h, m, wd } = tzNow()
		const list = snap.list
		const total = list.reduce((n, a) => n + a.target, 0)
		const sent = list.reduce((n, a) => n + this.sentToday(a.id), 0)
		const w = CURVE[h]
		// Mensajes de los últimos 7 días (para la gráfica)
		const sod = startOfDay()
		const week = Array(7).fill(0)
		try {
			for (const { ts } of q.perDay.all(sod - 6 * DAY)) {
				const i = 6 - Math.floor((sod + DAY - 1 - ts) / DAY)
				if (i >= 0 && i < 7) week[i]++
			}
		} catch {}
		const speakers = list.filter(a => !a.grace && a.target > 0).length
		return {
			...s,
			eligible: list.length,
			running: s.enabled && list.length >= 2 && speakers >= 1,
			plan: {
				totalPerDay: total,
				sentToday: sent,
				activity: !this.inWindow(h) ? 'fuera' : w >= 0.7 ? 'alta' : w >= 0.3 ? 'media' : 'baja',
				nextConvoIn: s.enabled ? Math.max(0, Math.round((this.nextConvoAt - Date.now()) / MIN)) : null,
				activeConvos: this.convos.size,
				startHour: s.allDay ? 0 : s.startHour,
				endHour: s.allDay ? 24 : s.endHour,
				week,
				dayLeft: Math.round(curveLeft(h, m) / DAY_SUM * 100)
			},
			numbers: list.map(a => ({
				id: a.id, name: a.name, sentToday: this.sentToday(a.id), receivedToday: this.recvToday(a.id), target: a.target,
				ageDays: this.ageDays(a), asleep: this.awake(a, h, wd) < 0.15, grace: a.grace, resting: a.resting,
				level: a.level, campaignToday: a.campaign,
				inConvo: [...this.convos.values()].some(c => c.a === a.id || c.b === a.id)
			}))
		}
	}

	// ---- Motor ----
	async tick() {
		if (this.busy || !this.s.enabled) return
		const now = Date.now()
		// Sin nada pendiente no se toca la base de datos
		if (now < this.nextConvoAt && !this.queue.some(e => e.at <= now)) return
		this.busy = true
		try {
			const snap = this.snapshot()
			if (snap.list.length < 2) {
				if (now >= this.nextConvoAt) this.nextConvoAt = now + rnd(3, 8) * MIN
				return
			}
			// 1) Lecturas pendientes: el que recibió se conecta y abre el chat
			for (const ev of this.queue.filter(e => e.kind === 'read' && e.at <= now)) {
				this.queue = this.queue.filter(e => e !== ev)
				this.dirty = true
				const session = this.manager.sessions.get(ev.readerId)
				if (!session || !this.live(ev.readerId)) continue
				try {
					await session.online(irnd(12, 40) * 1000)
					await session.markRead(this.chatJid(ev.readerId, ev.fromPhone))
				} catch {}
			}
			// 2) Un mensaje a la vez, con respiro entre envíos
			if (Date.now() >= this.lastActionAt) {
				const due = this.queue.filter(e => e.kind === 'say' && e.at <= Date.now()).sort((a, b) => a.at - b.at)[0]
				if (due) {
					this.queue = this.queue.filter(e => e !== due)
					this.dirty = true
					await this.say(due, snap)
				}
			}
			// 3) ¿Empieza otra charla?
			if (Date.now() >= this.nextConvoAt) {
				const { h, wd } = tzNow()
				const force = this.forceNext
				this.forceNext = false
				const go = force || (!this.replanOnly && this.inWindow(h))
				const r = go ? this.spawn(snap, h, wd, force) : 'skip'
				// Si todos están ocupados en otras charlas, la nueva solo se pospone unos minutos
				if (r === 'busy') { this.nextConvoAt = Date.now() + rnd(3, 10) * MIN; this.replanOnly = false }
				else this.scheduleNextConvo(snap)
				this.dirty = true
			}
		} finally {
			this.busy = false
			this.persist()
		}
	}

	spawn(snap, hour, wd, force = false) {
		const list = snap.list
		const maxActive = Math.min(MAX_ACTIVE, Math.floor(list.length / 2))
		if (this.convos.size >= maxActive) return 'busy'
		const busyIds = new Set([...this.convos.values()].flatMap(c => [c.a, c.b]))
		// Quién empieza: el que está despierto y aún tiene cupo
		const ready = list.filter(a => !busyIds.has(a.id) && this.live(a.id) && this.canSpeak(a, false))
		const starter = weighted(ready, a => (force ? 1 : this.awake(a, hour, wd) ** 1.5) * (a.target - this.sentToday(a.id)))
		if (!starter) return list.some(a => busyIds.has(a.id) && this.canSpeak(a, false)) ? 'busy' : 'none'
		// Con quién: quien no ha hablado con él hace tiempo, despierto, y más si hoy hizo masivos
		const partners = list.filter(x => x.id !== starter.id && !busyIds.has(x.id) && this.live(x.id) && (!x.grace || this.recvToday(x.id) < GRACE_RECEIVE))
		const partner = weighted(partners, x =>
			(0.2 + this.awake(x, hour, wd)) *
			clamp((Date.now() - this.lastPair(starter.id, x.id)) / DAY, 0.15, 1.5) *
			(1 + Math.min(1.5, x.campaign / 40)) *
			(x.grace ? 0.7 : this.canSpeak(x, false) ? 1 : 0.35))
		if (!partner) return this.convos.size ? 'busy' : 'none'
		// Guion según el momento, evitando repetir los usados hace poco
		const mo = moments(hour, wd)
		const idx = weighted(SCRIPTS.map((_, i) => i), i => {
			const sc = SCRIPTS[i]
			const fit = !sc.when ? (mo.night ? 0.4 : 1) : mo[sc.when] ? BOOST[sc.when] : 0
			return fit * (sc.weight ?? 1) * (this.recent.includes(i) ? 0.03 : 1)
		})
		if (idx == null) return 'none'
		const script = SCRIPTS[idx]
		this.recent = [idx, ...this.recent].slice(0, 12)
		let lines = [...script.lines]
		// Recién vinculado: solo recibe (un mensaje, sin respuesta)
		if (partner.grace || !this.canSpeak(partner, true)) lines = lines.slice(0, 1)
		// A veces el primer mensaje lleva saludo según la hora
		if (!script.when && !script.greets && Math.random() < 0.25) {
			lines[0] = `${mo.morning ? GREET.morning : hour >= 12 && hour < 19 ? GREET.afternoon : GREET.night}||${lines[0]}`
		}
		const id = ++this.seq
		this.convos.set(id, { id, a: starter.id, b: partner.id, lines, i: 0, when: script.when || null, lastAt: Date.now() })
		this.queue.push({ at: Date.now() + rnd(force ? 0 : 5, force ? 5 : 40) * 1000, kind: 'say', convoId: id })
		this.dirty = true
		return 'ok'
	}

	end(convoId) {
		// Aprende cuántos mensajes salen de verdad por charla (algunas acaban antes) para planear mejor
		const c = this.convos.get(convoId)
		if (c?.n) this.avgLines = clamp(this.avgLines * 0.92 + c.n * 0.08, 1.5, 6)
		this.convos.delete(convoId)
		this.queue = this.queue.filter(e => !(e.kind === 'say' && e.convoId === convoId))
		this.dirty = true
	}

	async say(ev, snap) {
		const c = this.convos.get(ev.convoId)
		if (!c) return
		const speaker = snap.byId.get(c.i % 2 === 0 ? c.a : c.b)
		const listener = snap.byId.get(c.i % 2 === 0 ? c.b : c.a)
		if (!speaker || !listener || !this.live(speaker.id) || !this.canSpeak(speaker, c.i > 0)) return this.end(c.id)
		const isLast = c.i === c.lines.length - 1
		const session = this.manager.sessions.get(speaker.id)
		const toJid = jidOf(listener.phone)
		const chat = this.chatJid(speaker.id, listener.phone)
		const { h, wd } = tzNow()
		try {
			await session.online(irnd(25, 90) * 1000)
			// El cierre a veces es solo una reacción (👍) en vez de escribir
			if (isLast && c.i > 0 && Math.random() < 0.3 && await session.reactLast(chat, pick(REACTS))) {
				this.log(speaker.id, listener.id)
				c.n = (c.n || 0) + 1
				return this.end(c.id)
			}
			// A media charla, a veces reacciona y luego contesta
			if (c.i > 0 && !isLast && Math.random() < 0.1) { await session.reactLast(chat, pick(REACTS)); await sleep(irnd(800, 2500)) }
			// A veces contesta citando el mensaje anterior
			let quoted
			if (c.i > 0 && Math.random() < 0.08) {
				const r = q.lastIn.get(speaker.id, chat)
				if (r?.text) quoted = { key: { remoteJid: r.remote_jid, id: r.id, fromMe: false, participant: r.participant || undefined }, message: { conversation: r.text } }
			}
			const parts = bubbles(c.lines[c.i])
			for (let j = 0; j < parts.length; j++) {
				const text = parts[j]
				await session.setPresence(toJid, 'composing')
				// A veces duda: deja de escribir y vuelve a empezar
				if (text.length > 18 && Math.random() < 0.15) {
					await sleep(irnd(1500, 3500))
					await session.setPresence(toJid, 'paused')
					await sleep(irnd(1500, 5000))
					await session.setPresence(toJid, 'composing')
				}
				await sleep(Math.min(7000, irnd(700, 1300) + text.length * irnd(35, 65)))
				await session.send(toJid, { text }, undefined, j === 0 && quoted ? { quoted } : undefined)
				this.log(speaker.id, listener.id)
				c.n = (c.n || 0) + 1
				if (j < parts.length - 1) await sleep(irnd(500, 1800))
			}
			await session.setPresence(toJid, 'paused')
		} catch {
			return this.end(c.id)
		} finally {
			this.lastActionAt = Date.now() + irnd(6, 18) * 1000 // respiro antes de cualquier otro envío
		}
		c.i++
		c.lastAt = Date.now()
		this.dirty = true
		const t = this.replyTiming(listener, h, wd)
		this.queue.push({ at: Date.now() + t.readIn, kind: 'read', readerId: listener.id, fromPhone: speaker.phone })
		// Fin del guion, o a veces se queda "en visto".
		// Un "buenas noches" a alguien dormido solo se lee en la mañana, no se contesta.
		const asleep = this.awake(listener, h, wd) < 0.15
		if (c.i >= c.lines.length || (c.i >= 2 && Math.random() < 0.07) || (asleep && c.when === 'night')) return this.end(c.id)
		this.queue.push({ at: Date.now() + t.readIn + t.replyIn, kind: 'say', convoId: c.id })
	}

	// Cuándo lee y cuándo contesta el otro, según qué tan despierto está
	replyTiming(a, hour, wd) {
		const w = this.awake(a, hour, wd)
		if (w < 0.15) { // dormido: lo verá cuando despierte
			let ahead = 1
			while (ahead < 24 && this.awake(a, (hour + ahead) % 24, wd) < 0.35) ahead++
			const { m } = tzNow()
			return { readIn: ((ahead * 60 - m) + rnd(0, 50)) * MIN, replyIn: rnd(0.3, 5) * MIN }
		}
		if (w < 0.5) return { readIn: rnd(1, 25) * MIN, replyIn: rnd(0.25, 3) * MIN }
		const r = Math.random()
		const readIn = r < 0.7 ? rnd(4, 45) * 1000 : r < 0.93 ? rnd(1, 8) * MIN : rnd(8, 35) * MIN
		return { readIn, replyIn: rnd(10, 90) * 1000 }
	}

	// Cada cuánto empieza una charla nueva: reparte lo que falta del día según la curva de actividad,
	// así se pone al corriente si va atrasado, pero sin amontonar charlas de noche.
	scheduleNextConvo(snap) {
		const s = this.s
		const { h, m } = tzNow()
		const w = Math.max(CURVE[h], 0.04)
		let gapMin
		if (!s.auto) {
			gapMin = rnd(s.minDelay, s.maxDelay) / Math.max(w, 0.2)
		} else {
			const list = snap.list
			const total = list.reduce((n, a) => n + a.target, 0)
			const left = list.reduce((n, a) => n + Math.max(0, a.target - this.sentToday(a.id)), 0)
			const end = s.allDay ? 24 : s.endHour
			const inWin = x => s.allDay || (x >= s.startHour && x < s.endHour)
			const daySum = s.allDay ? DAY_SUM : curveSpan(s.startHour, s.endHour)
			const curveRest = curveLeft(h, m, end)
			// Charlas que tocan en lo que queda de hoy (con tope para ponerse al corriente poco a poco)
			const fair = total / this.avgLines * curveRest / daySum * 1.35
			const today = left < 2 ? 0 : Math.min(left / this.avgLines, fair)
			const kToday = curveRest > 0 ? today / curveRest : 0
			const kTomorrow = total / this.avgLines / daySum
			// Proceso de Poisson con ritmo que cambia cada hora: recorre el reloj de 5 en 5 minutos
			// acumulando actividad hasta "gastar" un intervalo aleatorio. Así la mañana arranca a su hora
			// y de madrugada casi no pasa nada, sin saltos raros.
			const need = -Math.log(1 - Math.random())
			let acc = 0
			gapMin = 24 * 60
			for (let t = 5; t <= 24 * 60; t += 5) {
				const mins = h * 60 + m + t
				const hour = Math.floor(mins / 60) % 24
				const k = mins < 24 * 60 ? kToday : kTomorrow
				if (inWin(hour)) acc += k * CURVE[hour] * 5 / 60
				if (acc >= need) { gapMin = t - rnd(0, 5); break }
			}
			if (!total) gapMin = rnd(15, 30) // aún no hay quién hable (recién vinculados): revisa luego
		}
		// Si falta mucho, solo vuelve a planear dentro de 2 h (por si cambian los números); no inicia charla
		this.replanOnly = gapMin > 120
		this.nextConvoAt = Date.now() + clamp(gapMin, 4, 120) * MIN
	}
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
