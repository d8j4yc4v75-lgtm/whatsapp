import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { db } from './db.js'
import { DATA_DIR } from './config.js'
import { accountHealth } from './health.js'
import { vary } from './text.js'
import { sendPush } from './push.js'
import { hasFfmpeg, toOpus } from './ffmpeg.js'
import { isOwnJid, resetOwnCache } from './sessions.js'
import {
	SCRIPTS, GROUP_SCRIPTS, GROUP_NAMES, STORY_TEXTS, STORY_COLORS, REACTS, GREET, CONTACT_NAMES,
	hash01, parseCustom, persona, styleText
} from './warmup-scripts.js'

// Calentamiento: tus propios números conversan entre sí para que las cuentas se vean activas
// y "maduren" antes de usarlas en envíos. Solo son TUS números hablando entre ellos.
//
// - Curva de actividad humana de 24 h; cada número tiene su horario de sueño y su forma de escribir
//   (cómo se ríe, si usa emojis, acentos, abreviaturas, qué tan rápido escribe y contesta).
// - Charlas según el momento del día, con fotos, notas de voz, ubicación y tarjetas de contacto;
//   a veces en dos mensajes seguidos, citando, con reacciones o dejando en visto.
// - Grupo entre tus números con charlas de varios, y estados (historias) que los demás ven.
// - Reparte el cupo del día con un proceso de Poisson sobre la curva de actividad y aprende cuánto
//   dura de verdad cada charla. No se cruza con tus chats reales ni con los envíos masivos.
// - Prueba de entrega: si los mensajes de un número no le llegan a tus otros números, lo pausa y avisa.
// - Madurez 0–100 por número, con consejos (foto, info del perfil…) y cuándo estará listo.
// - Las charlas sobreviven a un reinicio del servidor.

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
function tzNow(t = Date.now()) {
	const p = {}
	for (const x of FMT.formatToParts(new Date(t))) p[x.type] = x.value
	return { h: Number(p.hour) % 24, m: Number(p.minute), s: Number(p.second), wd: WD[p.weekday] }
}
const startOfDay = () => { const t = tzNow(); return Date.now() - ((t.h * 60 + t.m) * 60 + t.s) * 1000 }
const dayKey = () => Math.floor((startOfDay() + 6 * 36e5) / DAY)
const isWeekend = wd => wd === 0 || wd === 6

// Actividad típica de una persona por hora (0–23)
const CURVE = [0.28, 0.14, 0.07, 0.04, 0.04, 0.07, 0.18, 0.42, 0.68, 0.85, 0.95, 1, 1, 0.95, 0.85, 0.82, 0.88, 0.95, 1, 1, 0.95, 0.85, 0.66, 0.46]
const DAY_SUM = CURVE.reduce((a, b) => a + b, 0)
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
	vol: db.prepare('SELECT account_id AS id, COUNT(*) AS n, COUNT(DISTINCT peer_id) AS peers FROM warmup_log WHERE ts > ? GROUP BY account_id'),
	pairs: db.prepare('SELECT account_id AS a, peer_id AS b, MAX(ts) AS t FROM warmup_log WHERE ts > ? AND peer_id IS NOT NULL GROUP BY account_id, peer_id'),
	perDay: db.prepare('SELECT ts FROM warmup_log WHERE ts > ?'),
	prune: db.prepare('DELETE FROM warmup_log WHERE ts < ?'),
	accounts: db.prepare("SELECT id, name, phone, linked_at, rest_ended_at, rest_until FROM accounts WHERE (kind IS NULL OR kind != 'cloud') AND phone IS NOT NULL AND phone != ''"),
	getSetting: db.prepare('SELECT value FROM app_settings WHERE key = ?'),
	setSetting: db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)'),
	lidsOf: db.prepare('SELECT lid FROM lid_map WHERE pn = ?'),
	chatTs: db.prepare('SELECT last_ts FROM chats WHERE account_id = ? AND jid = ?'),
	lastIn: db.prepare('SELECT id, remote_jid, participant, text FROM messages WHERE account_id = ? AND jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT 1'),
	hasMsg: db.prepare('SELECT 1 FROM messages WHERE account_id = ? AND id = ?'),
	recentOut: db.prepare('SELECT jid FROM messages WHERE account_id = ? AND from_me = 1 AND ts > ? ORDER BY ts DESC LIMIT 30')
}
let campStmt = null
let campRecentStmt = null
function campaignToday(since) {
	try {
		campStmt ||= db.prepare("SELECT sent_by AS id, COUNT(*) AS n FROM campaign_items WHERE status = 'sent' AND sent_at > ? GROUP BY sent_by")
		return new Map(campStmt.all(since).map(r => [r.id, r.n]))
	} catch { return new Map() }
}
function campaignRecent(id, since) {
	try {
		campRecentStmt ||= db.prepare("SELECT 1 FROM campaign_items WHERE sent_by = ? AND status IN ('sent', 'sending') AND sent_at > ? LIMIT 1")
		return Boolean(campRecentStmt.get(id, since))
	} catch { return false }
}
const getJSON = (key, def) => { try { return JSON.parse(q.getSetting.get(key)?.value || 'null') ?? def } catch { return def } }
const setJSON = (key, v) => { try { q.setSetting.run(key, JSON.stringify(v)) } catch {} }

// ---- Biblioteca de fotos y notas de voz para el calentamiento ----
const MEDIA_DIR = path.join(DATA_DIR, 'warmup-media')
const IMG = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const NAME_OK = /^(img|aud)-[\w-]+\.(jpg|png|webp|ogg)$/
const MAX_FILES = 40
export const library = {
	list() {
		try {
			return fs.readdirSync(MEDIA_DIR).filter(f => NAME_OK.test(f)).map(f => {
				const st = fs.statSync(path.join(MEDIA_DIR, f))
				return { name: f, kind: f.startsWith('img') ? 'image' : 'audio', size: st.size, at: st.mtimeMs }
			}).sort((a, b) => b.at - a.at)
		} catch { return [] }
	},
	count(kind) { return this.list().filter(f => f.kind === kind).length },
	async add(buffer, mime, originalName) {
		if (!buffer?.length) throw new Error('Falta el archivo')
		if (buffer.length > 8 * 1024 * 1024) throw new Error('El archivo es muy grande (máximo 8 MB)')
		if (this.list().length >= MAX_FILES) throw new Error(`Máximo ${MAX_FILES} archivos; borra alguno`)
		fs.mkdirSync(MEDIA_DIR, { recursive: true })
		const base = String(mime || '').split(';')[0]
		const id = crypto.randomUUID().slice(0, 12)
		if (IMG[base]) {
			const name = `img-${id}.${IMG[base]}`
			fs.writeFileSync(path.join(MEDIA_DIR, name), buffer)
			return name
		}
		if (base.startsWith('audio/') || /\.(m4a|mp3|ogg|opus|wav|aac)$/i.test(originalName || '')) {
			let ogg = buffer
			if (!/ogg|opus/.test(base)) {
				if (!await hasFfmpeg()) throw new Error('Para notas de voz sube un .ogg (falta ffmpeg en el servidor)')
				ogg = await toOpus(buffer)
			}
			const name = `aud-${id}.ogg`
			fs.writeFileSync(path.join(MEDIA_DIR, name), ogg)
			return name
		}
		throw new Error('Sube una foto (JPG, PNG) o un audio')
	},
	remove(name) {
		if (!NAME_OK.test(String(name))) throw new Error('Archivo inválido')
		fs.rmSync(path.join(MEDIA_DIR, name), { force: true })
	},
	file(name) {
		if (!NAME_OK.test(String(name))) return null
		const p = path.join(MEDIA_DIR, name)
		return fs.existsSync(p) ? p : null
	}
}

const AVG_LINES = SCRIPTS.reduce((n, s) => n + s.lines.length, 0) / SCRIPTS.length
const DEFAULTS = { enabled: false, auto: true, allDay: true, perDay: 6, minDelay: 25, maxDelay: 150, startHour: 9, endHour: 21, intensity: 'normal', media: true, stories: true, groups: true }
const INTENSITY = { suave: 0.6, normal: 1, intenso: 1.4 }
const GRACE_HOURS = Number(process.env.WARMUP_GRACE_HOURS || 24) // espera tras vincular antes de enviar
const GRACE_RECEIVE = 6 // mensajes que puede recibir al día un número recién vinculado
const MAX_ACTIVE = 4 // charlas a la vez como máximo
const OVERFLOW = 3 // mensajes extra para terminar una charla ya empezada aunque se acabe el cupo
const CHECK_AFTER = 10 * MIN // cuánto esperar para comprobar que el mensaje le llegó al otro número
const FAILS_TO_FLAG = 3
const FLAG_HOURS = 12
const LAT = Number(process.env.WARMUP_LAT || 19.4326)
const LNG = Number(process.env.WARMUP_LNG || -99.1332)

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
const needs = sc => new Set(sc.lines.filter(l => typeof l === 'object').map(l => l.media))
const keyOf = sc => (typeof sc.lines[0] === 'string' ? sc.lines[0] : JSON.stringify(sc.lines[0])).slice(0, 80)

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
		this.queue = [] // { at, kind: 'say' | 'read' | 'view', ... }
		this.checks = [] // pruebas de entrega pendientes { at, id, from, to }
		this.fails = {} // fallos de entrega seguidos por número
		this.flags = {} // números pausados por no entregar { id: { until, reason } }
		this.recent = [] // guiones usados hace poco
		this.seq = 0
		this.avgLines = AVG_LINES
		this.lastActionAt = 0
		// Tras reiniciar, espera unos minutos a que los números se reconecten antes de hablar
		this.nextConvoAt = Date.now() + rnd(2, 8) * MIN
		this.nextHousekeeping = Date.now() + rnd(3, 6) * MIN
		this.profiles = new Map() // perfil de cada número (foto, nombre, info), revisado cada 12 h
		this.recentMedia = []
		this.s = this.loadSettings()
		this.custom = parseCustom(getJSON('warmup_custom', ''))
		this.groups = getJSON('warmup_groups', [])
		this.stories = getJSON('warmup_stories', {})
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
	loadSettings() { return { ...DEFAULTS, ...getJSON('warmup', {}) } }
	settings() { return { ...this.s } }
	save(partial) {
		const s = { ...this.s, ...partial }
		s.perDay = clamp(Number(s.perDay) || DEFAULTS.perDay, 1, 40)
		s.minDelay = clamp(Number(s.minDelay) || DEFAULTS.minDelay, 5, 360)
		s.maxDelay = clamp(Number(s.maxDelay) || DEFAULTS.maxDelay, s.minDelay, 720)
		s.startHour = clamp(Math.floor(Number(s.startHour) || 0), 0, 23)
		s.endHour = clamp(Math.floor(Number(s.endHour) || 24), s.startHour + 1, 24)
		for (const k of ['enabled', 'auto', 'allDay', 'media', 'stories', 'groups']) s[k] = s[k] === undefined ? DEFAULTS[k] : Boolean(s[k])
		if (!INTENSITY[s.intensity]) s.intensity = 'normal'
		setJSON('warmup', s)
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
	customText() { return getJSON('warmup_custom', '') }
	saveCustom(text) {
		const t = String(text || '').slice(0, 30000)
		setJSON('warmup_custom', t)
		this.custom = parseCustom(t)
		return { text: t, count: this.custom.length }
	}
	unflag(id) {
		delete this.flags[id]
		this.fails[id] = 0
		this.snap = null
		this.dirty = true
		this.persist()
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
		setJSON('warmup_state', {
			convos: [...this.convos.values()], queue: this.queue, checks: this.checks, fails: this.fails, flags: this.flags,
			nextConvoAt: this.nextConvoAt, recent: this.recent, seq: this.seq, avgLines: this.avgLines
		})
	}
	restore() {
		const st = getJSON('warmup_state', null)
		if (!st) return
		const now = Date.now()
		this.fails = st.fails || {}
		for (const [id, f] of Object.entries(st.flags || {})) if (f?.until > now) this.flags[id] = f
		if (!this.s.enabled) return
		this.seq = st.seq || 0
		if (st.avgLines > 0) this.avgLines = clamp(st.avgLines, 1.5, 6)
		this.recent = (st.recent || []).filter(x => typeof x === 'string')
		this.checks = (st.checks || []).filter(c => c && now - c.at < 6 * 36e5)
		for (const c of st.convos || []) if (c?.order && now - (c.lastAt || 0) < 30 * 36e5) this.convos.set(c.id, c)
		// Lo que se debía hacer mientras estuvo apagado se reprograma escalonado, no todo de golpe
		let k = 0
		this.queue = (st.queue || []).filter(e => e && (e.kind === 'say' ? this.convos.has(e.convoId) : now - e.at < 12 * 36e5))
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
		q.log.run(from, to ?? null, now)
		this.loadCounters()
		this.sent.set(from, (this.sent.get(from) || 0) + 1)
		if (to != null) {
			this.recv.set(to, (this.recv.get(to) || 0) + 1)
			this.pairs.set(from < to ? `${from}:${to}` : `${to}:${from}`, now)
		}
	}

	// ---- Análisis de cada número ----
	since(a) { return Math.max(a.linked_at || 0, a.rest_ended_at || 0) }
	ageDays(a) { const s = this.since(a); return s ? Math.floor((Date.now() - s) / DAY) : 0 }
	ageHours(a) { const s = this.since(a); return s ? (Date.now() - s) / 36e5 : 0 }
	// Horario de sueño propio (de -1 a +2 h); el fin de semana todos se levantan una hora más tarde
	sleepShift(a, wd) { return Math.floor(hash01(a.id, 7) * 4) - 1 + (isWeekend(wd) ? 1 : 0) }
	awake(a, hour, wd = tzNow().wd) { return CURVE[((hour - this.sleepShift(a, wd)) % 24 + 24) % 24] }
	restDays() { const r = getJSON('rest_days', [0]); return Array.isArray(r) ? r : [0] }
	// Ese día habla un poco más o menos (0.7–1.15); los días de descanso, menos
	dayFactor(a, rest, wd) {
		const f = 0.7 + hash01(a.id, this.day) * 0.45
		return rest.includes(wd) ? f * 0.6 : f
	}
	flagged(id) { const f = this.flags[id]; return Boolean(f && f.until > Date.now()) }

	// MODO AUTOMÁTICO: según estado, rechazos, antigüedad, masivos de hoy e intensidad
	autoBase(a, h, camp) {
		if (!h || a.grace) return 0
		if (h.restUntil) return h.rejections24h >= 2 ? 0 : 2 // descanso de masivos: charla ligera para recuperarse
		if (h.level === 'red') return 0
		const age = h.ageDays
		let base
		if (age < 1) base = 2
		else if (age < 3) base = 2 + age
		else if (h.level === 'yellow') base = 3
		else if (age < 7) base = 6
		else base = 8
		if (camp >= 20 && h.level === 'green') base += Math.min(4, 1 + Math.floor(camp / 40))
		return base * INTENSITY[this.s.intensity || 'normal']
	}

	// Madurez 0–100: antigüedad, charlas, con cuántos habla, perfil completo y salud
	maturity(a, vol, recv) {
		const age = Math.min(1, this.ageDays(a) / 14) * 35
		const talk = Math.min(1, ((vol?.n || 0) + (recv || 0)) / 150) * 25
		const peers = Math.min(1, (vol?.peers || 0) / 3) * 10
		const p = this.profiles.get(a.id)
		const known = p && 'picture' in p
		const prof = known ? (p.picture ? 6 : 0) + (p.name ? 4 : 0) + (p.about ? 5 : 0) : 7
		const health = a.level === 'green' ? 15 : a.level === 'yellow' ? 7 : 0
		let score = Math.round(age + talk + peers + prof + health)
		if (this.flagged(a.id)) score = Math.round(score * 0.5)
		const tips = []
		if (this.flagged(a.id)) tips.push('Sus mensajes no les llegan a tus otros números: puede estar restringido')
		if (known && !p.picture) tips.push('Ponle foto de perfil')
		if (known && !p.name) tips.push('Ponle nombre al perfil')
		if (known && !p.about) tips.push('Escribe una info en su perfil')
		if (this.ageDays(a) < 3) tips.push('Aún es nuevo: no lo uses en masivos grandes')
		else if ((vol?.peers || 0) < 2) tips.push('Le falta hablar con más de tus números')
		const gain = 2.5 + 25 * 2 * Math.max(1, a.target) / 150
		const readyIn = score >= 70 ? 0 : Math.min(30, Math.ceil((70 - score) / gain))
		return { score, label: score >= 70 ? 'Listo' : score >= 40 ? 'Templado' : 'Frío', readyIn, tips }
	}

	// Foto del momento: números conectados con su salud, cupo y madurez (se recalcula cada minuto)
	snapshot(force = false) {
		this.loadCounters()
		if (!force && this.snap && Date.now() - this.snap.at < MIN) return this.snap
		const s = this.s
		const now = Date.now()
		const { wd } = tzNow()
		const rest = this.restDays()
		const camp = campaignToday(startOfDay())
		const vol = new Map(q.vol.all(now - 14 * DAY).map(r => [r.id, r]))
		const recv14 = new Map(q.recvSince.all(now - 14 * DAY).map(r => [r.id, r.n]))
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
			if (this.flagged(a.id)) a.target = 0
			a.persona = persona(a.id)
			a.mature = this.maturity(a, vol.get(a.id), recv14.get(a.id))
			list.push(a)
		}
		this.snap = { at: now, list, byId: new Map(list.map(a => [a.id, a])) }
		return this.snap
	}
	live(id) { return this.manager.sessions.get(id)?.status === 'connected' }
	canSpeak(a, continuing) { return !a.grace && a.target > 0 && this.sentToday(a.id) < a.target + (continuing ? OVERFLOW : 0) }
	// ¿Está ocupado en algo real? (un chat con un cliente o un envío masivo en los últimos minutos)
	busyReal(id) {
		const since = Date.now() - 3 * MIN
		if (campaignRecent(id, since)) return true
		try { return q.recentOut.all(id, since).some(r => !isOwnJid(r.jid)) } catch { return false }
	}
	inWindow(hour) {
		const s = this.s
		return s.allDay || (hour >= s.startHour && hour < s.endHour)
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
	group() { return this.groups.find(g => g?.jid) || null }
	available() {
		const m = this.s.media
		return { image: m && library.count('image') > 0, audio: m && library.count('audio') > 0, location: m, contact: m }
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
		const sod = startOfDay()
		const week = Array(7).fill(0)
		try {
			for (const { ts } of q.perDay.all(sod - 6 * DAY)) {
				const i = 6 - Math.floor((sod + DAY - 1 - ts) / DAY)
				if (i >= 0 && i < 7) week[i]++
			}
		} catch {}
		const speakers = list.filter(a => !a.grace && a.target > 0).length
		const g = this.group()
		const files = library.list()
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
			group: g ? { subject: g.subject, members: (g.members || []).length } : null,
			library: { images: files.filter(f => f.kind === 'image').length, audios: files.filter(f => f.kind === 'audio').length, files },
			customCount: this.custom.length,
			numbers: list.map(a => ({
				id: a.id, name: a.name, sentToday: this.sentToday(a.id), receivedToday: this.recvToday(a.id), target: a.target,
				ageDays: this.ageDays(a), asleep: this.awake(a, h, wd) < 0.15, grace: a.grace, resting: a.resting,
				level: a.level, campaignToday: a.campaign, flagged: this.flagged(a.id) ? this.flags[a.id] : null,
				maturity: a.mature,
				inConvo: [...this.convos.values()].some(c => c.members.includes(a.id))
			}))
		}
	}

	// ---- Motor ----
	async tick() {
		if (this.busy || !this.s.enabled) return
		const now = Date.now()
		// Sin nada pendiente no se toca la base de datos
		const due = now >= this.nextConvoAt || now >= this.nextHousekeeping || this.queue.some(e => e.at <= now) || this.checks.some(c => c.at <= now)
		if (!due) return
		this.busy = true
		try {
			const snap = this.snapshot()
			this.runChecks(snap)
			if (snap.list.length < 2) {
				if (now >= this.nextConvoAt) this.nextConvoAt = now + rnd(3, 8) * MIN
				if (now >= this.nextHousekeeping) this.nextHousekeeping = now + 10 * MIN
				return
			}
			// 1) Lecturas y vistas de estados pendientes: el que recibió se conecta y abre el chat
			for (const ev of this.queue.filter(e => (e.kind === 'read' || e.kind === 'view') && e.at <= now)) {
				this.queue = this.queue.filter(e => e !== ev)
				this.dirty = true
				const id = ev.readerId
				const session = this.manager.sessions.get(id)
				if (!session || !this.live(id)) continue
				try {
					await session.online(irnd(12, 40) * 1000)
					if (ev.kind === 'view') await session.viewStatus(ev.poster, ev.msgId)
					else await session.markRead(ev.group || this.chatJid(id, ev.fromPhone))
				} catch {}
			}
			// 2) Un mensaje a la vez, con respiro entre envíos
			let acted = false
			if (Date.now() >= this.lastActionAt) {
				const ev = this.queue.filter(e => e.kind === 'say' && e.at <= Date.now()).sort((a, b) => a.at - b.at)[0]
				if (ev) {
					this.queue = this.queue.filter(e => e !== ev)
					this.dirty = true
					await this.say(ev, snap)
					acted = true
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
			// 4) Tareas de fondo: perfil, grupo y estados (sin cruzarse con un envío)
			if (!acted && Date.now() >= this.nextHousekeeping && Date.now() >= this.lastActionAt) {
				this.nextHousekeeping = Date.now() + rnd(4, 9) * MIN
				await this.housekeeping(snap)
			}
		} finally {
			this.busy = false
			this.persist()
		}
	}

	async housekeeping(snap) {
		const now = Date.now()
		// Perfil (foto, nombre, info) de un número a la vez, cada 12 h
		const stale = snap.list.find(a => (this.profiles.get(a.id)?.at || 0) < now - 12 * 36e5)
		if (stale) {
			try {
				const p = await this.manager.sessions.get(stale.id).getProfile()
				this.profiles.set(stale.id, { at: now, picture: Boolean(p.picture), name: Boolean(p.name), about: Boolean(p.status) })
				this.snap = null
			} catch { this.profiles.set(stale.id, { ...(this.profiles.get(stale.id) || {}), at: now - 11 * 36e5 }) }
		}
		const { h, wd } = tzNow()
		if (!this.inWindow(h) || CURVE[h] < 0.6) return
		await this.ensureGroup(snap).catch(() => {})
		await this.maybeStory(snap, h, wd).catch(() => {})
	}

	// Un grupo entre tus números (los que ya llevan unos días), como el de la familia o los amigos
	async ensureGroup(snap) {
		if (!this.s.groups) return
		const now = Date.now()
		const ok = snap.list.filter(a => !a.grace && a.level !== 'red' && !this.flagged(a.id) && this.ageDays(a) >= 2 && !this.busyReal(a.id))
		let g = this.group()
		if (!g) {
			if (ok.length < 3 || now - (this.lastGroupTry || 0) < 6 * 36e5) return
			this.lastGroupTry = now
			const sorted = [...ok].sort((a, b) => this.since(a) - this.since(b))
			const owner = sorted[0]
			const members = sorted.slice(0, 8)
			const subject = pick(GROUP_NAMES)
			const gid = await this.manager.sessions.get(owner.id).createGroup(subject, members.slice(1).map(a => jidOf(a.phone)))
			if (!gid) return
			g = { jid: gid, owner: owner.id, members: members.map(a => a.id), subject, at: now }
			this.groups = [g]
			setJSON('warmup_groups', this.groups)
			resetOwnCache()
			this.lastActionAt = Date.now() + irnd(20, 60) * 1000
			return
		}
		// Suma a un número nuevo (como máximo uno al día)
		const add = ok.find(a => !g.members.includes(a.id))
		if (add && g.members.length < 12 && now - (g.lastAdd || 0) > DAY && this.live(g.owner)) {
			try {
				await this.manager.sessions.get(g.owner).addToGroup(g.jid, [jidOf(add.phone)])
				g.members.push(add.id)
			} catch {}
			g.lastAdd = now
			setJSON('warmup_groups', this.groups)
		}
	}

	// Estados (historias): cada número publica uno cada 2–4 días; tus otros números lo ven
	async maybeStory(snap, h, wd) {
		if (!this.s.stories || Math.random() > 0.35) return
		const now = Date.now()
		const due = snap.list.filter(a => !a.grace && a.level !== 'red' && !this.flagged(a.id) && this.awake(a, h, wd) >= 0.6 &&
			now - (this.stories[a.id] || 0) > (1.6 + hash01(a.id, this.day) * 2.4) * DAY && !this.busyReal(a.id))
		const a = pick(due)
		if (!a) return
		// Solo lo ven tus otros números vinculados (nunca contactos ni clientes)
		const viewers = snap.list.filter(x => x.id !== a.id && digits(x.phone) && digits(x.phone) !== digits(a.phone) && isOwnJid(jidOf(x.phone)))
		if (!viewers.length) return
		const session = this.manager.sessions.get(a.id)
		const jids = viewers.map(x => jidOf(x.phone))
		const img = this.s.media && Math.random() < 0.4 ? this.pickMedia('image') : null
		const text = () => styleText(vary(pick(STORY_TEXTS)), a.persona)
		const res = img
			? await session.postStatus({ image: fs.readFileSync(img.path), caption: Math.random() < 0.6 ? text() : undefined }, jids)
			: await session.postStatus({ text: text() }, jids, { backgroundColor: pick(STORY_COLORS), font: irnd(0, 4) })
		this.stories[a.id] = now
		setJSON('warmup_stories', this.stories)
		this.log(a.id, null)
		this.lastActionAt = Date.now() + irnd(15, 40) * 1000
		// Los demás lo van viendo a lo largo del día, cuando están despiertos
		if (res?.id) {
			for (const v of viewers) {
				if (Math.random() > 0.75) continue
				const t = this.replyTiming(v, h, wd)
				this.queue.push({ at: now + t.readIn + rnd(1, 120) * MIN, kind: 'view', readerId: v.id, poster: res.from, msgId: res.id })
			}
			this.dirty = true
		}
	}

	pickMedia(kind) {
		const files = library.list().filter(f => f.kind === kind)
		if (!files.length) return null
		const f = weighted(files, x => (this.recentMedia.includes(x.name) ? 0.1 : 1))
		this.recentMedia = [f.name, ...this.recentMedia].slice(0, 6)
		return { ...f, path: path.join(MEDIA_DIR, f.name) }
	}

	// Prueba de entrega: el mensaje debe aparecer en el otro número. Si no le llega varias veces, se pausa.
	runChecks(snap) {
		const now = Date.now()
		const due = this.checks.filter(c => c.at <= now)
		if (!due.length) return
		this.checks = this.checks.filter(c => c.at > now)
		this.dirty = true
		for (const c of due) {
			if (!this.live(c.to)) continue // el otro estaba desconectado: no cuenta
			if (q.hasMsg.get(c.to, c.id)) { this.fails[c.from] = 0; continue }
			this.fails[c.from] = (this.fails[c.from] || 0) + 1
			if (this.fails[c.from] >= FAILS_TO_FLAG && !this.flagged(c.from)) {
				const name = snap.byId.get(c.from)?.name || 'Un número'
				this.flags[c.from] = { until: now + FLAG_HOURS * 36e5, at: now, reason: `${this.fails[c.from]} mensajes seguidos no llegaron a tus otros números` }
				this.snap = null
				sendPush({ title: `⚠️ ${name}: sus mensajes no llegan`, body: 'El calentamiento lo pausó 12 h. Puede estar restringido por WhatsApp: no lo uses en masivos por ahora.', url: '/#/settings' })
				for (const cv of [...this.convos.values()]) if (cv.members.includes(c.from)) this.end(cv.id)
			}
		}
	}

	spawn(snap, hour, wd, force = false) {
		const list = snap.list
		const maxActive = Math.min(MAX_ACTIVE, Math.floor(list.length / 2))
		if (this.convos.size >= maxActive) return 'busy'
		const busyIds = new Set([...this.convos.values()].flatMap(c => c.members))
		const free = a => !busyIds.has(a.id) && this.live(a.id) && !this.flagged(a.id) && !this.busyReal(a.id)
		const ready = list.filter(a => free(a) && this.canSpeak(a, false))
		const mo = moments(hour, wd)
		const fitOf = sc => (!sc.when ? (mo.night ? 0.4 : 1) : mo[sc.when] ? BOOST[sc.when] : 0)
		// A veces la charla es en el grupo de tus números
		const g = this.group()
		if (g && this.s.groups && Math.random() < 0.16) {
			const members = ready.filter(a => g.members.includes(a.id))
			if (members.length >= 3) {
				const people = weightedSample(members, a => 0.2 + this.awake(a, hour, wd), Math.min(members.length, irnd(3, 4)))
				const script = weighted(GROUP_SCRIPTS, sc => fitOf(sc) * (this.recent.includes(keyOf(sc)) ? 0.05 : 1))
				if (script && people.length >= 3) {
					const order = [people[0].id]
					for (let i = 1; i < script.lines.length; i++) order.push(pick(people.filter(p => p.id !== order[i - 1])).id)
					return this.startConvo({ group: g.jid, members: people.map(p => p.id), order, lines: [...script.lines], when: script.when }, script, force)
				}
			}
		}
		// Quién empieza: el que está despierto y aún tiene cupo
		const starter = weighted(ready, a => (force ? 1 : this.awake(a, hour, wd) ** 1.5) * (a.target - this.sentToday(a.id)))
		if (!starter) return list.some(a => busyIds.has(a.id) && this.canSpeak(a, false)) ? 'busy' : 'none'
		// Con quién: quien no ha hablado con él hace tiempo, despierto, y más si hoy hizo masivos
		const partners = list.filter(x => x.id !== starter.id && free(x) && (!x.grace || this.recvToday(x.id) < GRACE_RECEIVE))
		const partner = weighted(partners, x =>
			(0.2 + this.awake(x, hour, wd)) *
			clamp((Date.now() - this.lastPair(starter.id, x.id)) / DAY, 0.15, 1.5) *
			(1 + Math.min(1.5, x.campaign / 40)) *
			(x.grace ? 0.7 : this.canSpeak(x, false) ? 1 : 0.35))
		if (!partner) return this.convos.size ? 'busy' : 'none'
		// Guion según el momento y lo que haya disponible (fotos, audios), sin repetir los recientes
		const av = this.available()
		const pool = [...SCRIPTS, ...this.custom]
		const script = weighted(pool, sc => {
			for (const n of needs(sc)) if (!av[n]) return 0
			return fitOf(sc) * (sc.weight ?? (sc.custom ? 1.5 : 1)) * (this.recent.includes(keyOf(sc)) ? 0.03 : 1)
		})
		if (!script) return 'none'
		let lines = [...script.lines]
		// Recién vinculado: solo recibe (un mensaje, sin respuesta)
		if (partner.grace || !this.canSpeak(partner, true)) lines = lines.slice(0, 1)
		if (!script.when && !script.greets && !script.custom && typeof lines[0] === 'string' && Math.random() < 0.25) {
			lines[0] = `${mo.morning ? GREET.morning : hour >= 12 && hour < 19 ? GREET.afternoon : GREET.night}||${lines[0]}`
		}
		const order = lines.map((_, i) => (i % 2 === 0 ? starter.id : partner.id))
		return this.startConvo({ members: [starter.id, partner.id], order, lines, when: script.when }, script, force)
	}
	startConvo(c, script, force) {
		this.recent = [keyOf(script), ...this.recent].slice(0, 14)
		const id = ++this.seq
		this.convos.set(id, { id, ...c, when: c.when || null, i: 0, n: 0, postponed: 0, lastAt: Date.now() })
		this.queue.push({ at: Date.now() + rnd(force ? 0 : 5, force ? 5 : 40) * 1000, kind: 'say', convoId: id })
		this.dirty = true
		return 'ok'
	}

	end(convoId) {
		// Aprende cuántos mensajes salen de verdad por charla (algunas acaban antes) para planear mejor
		const c = this.convos.get(convoId)
		if (c?.n && !c.group) this.avgLines = clamp(this.avgLines * 0.92 + c.n * 0.08, 1.5, 6)
		this.convos.delete(convoId)
		this.queue = this.queue.filter(e => !(e.kind === 'say' && e.convoId === convoId))
		this.dirty = true
	}

	// Manda una línea del guion (texto, foto, nota de voz, ubicación o contacto). Devuelve los IDs enviados.
	async sendLine(session, speaker, toJid, line, ctx) {
		const p = speaker.persona
		const ids = []
		const typing = async text => {
			await session.setPresence(toJid, 'composing')
			// A veces duda: deja de escribir y vuelve a empezar
			if (text.length > 18 && Math.random() < 0.15) {
				await sleep(irnd(1500, 3500))
				await session.setPresence(toJid, 'paused')
				await sleep(irnd(1500, 5000))
				await session.setPresence(toJid, 'composing')
			}
			await sleep(Math.min(7000, irnd(700, 1300) + text.length * p.speed))
		}
		const sendText = async (raw, quoted) => {
			const parts = bubbles(raw).map(t => styleText(t, p))
			for (let j = 0; j < parts.length; j++) {
				await typing(parts[j])
				const r = await session.send(toJid, { text: parts[j] }, undefined, j === 0 && quoted ? { quoted } : undefined)
				if (r?.id) ids.push(r.id)
				if (j < parts.length - 1) await sleep(irnd(500, 1800))
			}
		}
		if (typeof line === 'string') { await sendText(line, ctx.quoted); return ids }
		let content = null
		if (line.media === 'image') {
			const f = this.pickMedia('image')
			if (f) {
				const caption = line.caption ? styleText(vary(line.caption), p) : ''
				await session.setPresence(toJid, 'composing')
				await sleep(irnd(2500, 6000)) // busca la foto en la galería
				content = { image: fs.readFileSync(f.path), caption: caption || undefined, mimetype: f.name.endsWith('.png') ? 'image/png' : f.name.endsWith('.webp') ? 'image/webp' : 'image/jpeg' }
			}
		} else if (line.media === 'audio') {
			const f = this.pickMedia('audio')
			if (f) {
				const secs = clamp(f.size * 8 / 32000, 2, 25)
				await session.recording(toJid, secs * 1000 + irnd(500, 1500)) // "grabando audio…"
				content = { audio: fs.readFileSync(f.path), mimetype: 'audio/ogg; codecs=opus', ptt: true }
			}
		} else if (line.media === 'location') {
			// Cada número tiene su zona habitual en la ciudad
			const lat = LAT + (hash01(speaker.id, 31) - 0.5) * 0.12 + rnd(-0.004, 0.004)
			const lng = LNG + (hash01(speaker.id, 32) - 0.5) * 0.12 + rnd(-0.004, 0.004)
			await session.setPresence(toJid, 'composing')
			await sleep(irnd(2000, 4500))
			content = { location: { degreesLatitude: Number(lat.toFixed(6)), degreesLongitude: Number(lng.toFixed(6)) } }
		} else if (line.media === 'contact' && ctx.third) {
			// Le pasa la tarjeta de otro de tus números
			const name = pick(CONTACT_NAMES)
			const d = digits(ctx.third.phone)
			await session.setPresence(toJid, 'composing')
			await sleep(irnd(2500, 5000))
			content = { contacts: { displayName: name, contacts: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;waid=${d}:+${d}\nEND:VCARD` }] } }
		}
		if (!content) { await sendText(line.fallback || '{Ok|Va}'); return ids }
		const r = await session.send(toJid, content)
		if (r?.id) ids.push(r.id)
		return ids
	}

	async say(ev, snap) {
		const c = this.convos.get(ev.convoId)
		if (!c) return
		const speaker = snap.byId.get(c.order[c.i])
		const listeners = c.members.filter(id => id !== c.order[c.i]).map(id => snap.byId.get(id)).filter(Boolean)
		if (!speaker || !listeners.length || !this.live(speaker.id) || this.flagged(speaker.id) || !this.canSpeak(speaker, c.i > 0)) return this.end(c.id)
		// Si está atendiendo un chat real o un envío masivo, contesta un poco después
		if (this.busyReal(speaker.id)) {
			if (++c.postponed > 4) return this.end(c.id)
			this.queue.push({ ...ev, at: Date.now() + rnd(2, 6) * MIN })
			return
		}
		const isLast = c.i === c.lines.length - 1
		const session = this.manager.sessions.get(speaker.id)
		const one = c.group ? null : listeners[0]
		const toJid = c.group || jidOf(one.phone)
		const chat = c.group || this.chatJid(speaker.id, one.phone)
		const { h, wd } = tzNow()
		const line = c.lines[c.i]
		let ids = []
		try {
			await session.online(irnd(25, 90) * 1000)
			// El cierre a veces es solo una reacción (👍) en vez de escribir
			if (isLast && c.i > 0 && typeof line === 'string' && Math.random() < 0.3 && await session.reactLast(chat, pick(REACTS))) {
				this.log(speaker.id, one?.id)
				c.n++
				return this.end(c.id)
			}
			// A media charla, a veces reacciona y luego contesta
			if (c.i > 0 && !isLast && Math.random() < 0.1) { await session.reactLast(chat, pick(REACTS)); await sleep(irnd(800, 2500)) }
			// A veces contesta citando el mensaje anterior
			let quoted
			if (c.i > 0 && typeof line === 'string' && Math.random() < (c.group ? 0.15 : 0.08)) {
				const r = q.lastIn.get(speaker.id, chat)
				if (r?.text) quoted = { key: { remoteJid: r.remote_jid, id: r.id, fromMe: false, participant: r.participant || undefined }, message: { conversation: r.text } }
			}
			const third = snap.list.find(a => !c.members.includes(a.id))
			ids = await this.sendLine(session, speaker, toJid, line, { quoted, third })
			for (let k = 0; k < ids.length; k++) this.log(speaker.id, one?.id)
			c.n += ids.length
			await session.setPresence(toJid, 'paused')
		} catch {
			return this.end(c.id)
		} finally {
			this.lastActionAt = Date.now() + irnd(6, 18) * 1000 // respiro antes de cualquier otro envío
		}
		// Prueba de entrega del último mensaje (solo charlas 1 a 1)
		if (one && ids.length) this.checks.push({ at: Date.now() + CHECK_AFTER, id: ids[ids.length - 1], from: speaker.id, to: one.id })
		c.i++
		c.lastAt = Date.now()
		this.dirty = true
		// Los que reciben lo leen cuando pueden
		let next = null
		for (const l of listeners) {
			const t = this.replyTiming(l, h, wd)
			if (!c.group || Math.random() < 0.8) this.queue.push({ at: Date.now() + t.readIn, kind: 'read', readerId: l.id, fromPhone: speaker.phone, group: c.group || undefined })
			if (c.i < c.lines.length && l.id === c.order[c.i]) next = t
		}
		// Fin del guion, o a veces se queda "en visto".
		// Un "buenas noches" a alguien dormido solo se lee en la mañana, no se contesta.
		const nextSpeaker = c.i < c.lines.length ? snap.byId.get(c.order[c.i]) : null
		const asleep = nextSpeaker ? this.awake(nextSpeaker, h, wd) < 0.15 : false
		if (!nextSpeaker || (c.i >= 2 && Math.random() < 0.07) || (asleep && c.when === 'night')) return this.end(c.id)
		next ||= this.replyTiming(nextSpeaker, h, wd)
		this.queue.push({ at: Date.now() + next.readIn + next.replyIn, kind: 'say', convoId: c.id })
	}

	// Cuándo lee y cuándo contesta, según qué tan despierto está y qué tan rápido suele contestar
	replyTiming(a, hour, wd) {
		const w = this.awake(a, hour, wd)
		const pace = a.persona?.pace || 1
		if (w < 0.15) { // dormido: lo verá cuando despierte
			let ahead = 1
			while (ahead < 24 && this.awake(a, (hour + ahead) % 24, wd) < 0.35) ahead++
			const { m } = tzNow()
			return { readIn: ((ahead * 60 - m) + rnd(0, 50)) * MIN, replyIn: rnd(0.3, 5) * MIN }
		}
		if (w < 0.5) return { readIn: rnd(1, 25) * MIN * pace, replyIn: rnd(0.25, 3) * MIN }
		const r = Math.random()
		const readIn = (r < 0.7 ? rnd(4, 45) * 1000 : r < 0.93 ? rnd(1, 8) * MIN : rnd(8, 35) * MIN) * pace
		return { readIn, replyIn: rnd(10, 90) * 1000 * pace }
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
			const daySum = s.allDay ? DAY_SUM : curveSpan(s.startHour, s.endHour)
			const curveRest = curveLeft(h, m, end)
			// Charlas que tocan en lo que queda de hoy (con tope para ponerse al corriente poco a poco)
			const fair = total / this.avgLines * curveRest / daySum * 1.35
			const today = left < 2 ? 0 : Math.min(left / this.avgLines, fair)
			const kToday = curveRest > 0 ? today / curveRest : 0
			const kTomorrow = total / this.avgLines / daySum
			// Proceso de Poisson con ritmo que cambia cada hora: recorre el reloj de 5 en 5 minutos
			// acumulando actividad hasta "gastar" un intervalo aleatorio
			const need = -Math.log(1 - Math.random())
			let acc = 0
			gapMin = 24 * 60
			for (let t = 5; t <= 24 * 60; t += 5) {
				const mins = h * 60 + m + t
				const hour = Math.floor(mins / 60) % 24
				const k = mins < 24 * 60 ? kToday : kTomorrow
				if (this.inWindow(hour)) acc += k * CURVE[hour] * 5 / 60
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
// Elige n elementos distintos según su peso
function weightedSample(list, weightOf, n) {
	const pool = [...list]
	const out = []
	while (out.length < n && pool.length) {
		const x = weighted(pool, weightOf)
		if (!x) break
		out.push(x)
		pool.splice(pool.indexOf(x), 1)
	}
	return out
}
