import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { db } from './db.js'
import { DATA_DIR } from './config.js'
import { accountHealth } from './health.js'
import { vary } from './text.js'
import { sendPush } from './push.js'
import { hasFfmpeg, toOpus, toMp4, toSticker, toSquareJpeg } from './ffmpeg.js'
import { isOwnJid, resetOwnCache } from './sessions.js'
import {
	SCRIPTS, GROUP_SCRIPTS, GROUP_NAMES, STORY_TEXTS, STORY_COLORS, REACTS, GREET, CONTACT_NAMES,
	ABOUTS, WRONG, WRONG_SORRY, LATE_SORRY, CALL_SCRIPTS,
	hash01, parseCustom, persona, styleText
} from './warmup-scripts.js'
import {
	personaNames, birthdayOf, RELS, relOf, relWeight, REL_SCRIPTS, FORWARD_SCRIPTS, GROUP_POLLS, pollConvo,
	STATUS_REPLIES, STATUS_ANSWERS, BIRTHDAY, BIRTHDAY_GROUP, ARCS, buildArc
} from './warmup-life.js'

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
// - Números restringidos por WhatsApp solo contestan (nunca inician) y al terminar la restricción regresan poco a poco.
// - Errores de dedo que se corrigen con «*palabra» o editando el mensaje, como una persona.
// - Seguimiento: días después alguien pregunta «¿cómo te fue en el banco?» sobre una charla anterior.
// - Historial de las últimas charlas para ver qué hizo.
// - Los números maduros platican más con los nuevos (y los nuevos menos entre sí).
// - Padrinos: eliges qué números maduros hablan más con un número nuevo; los padrinos siguen hablando con los demás.
//   Un padrino con problemas (restringido, amarillo/rojo, lento) deja de hablar con su ahijado hasta recuperarse.
// - Preparar para masivo: sube la actividad los días previos a la fecha elegida y da charla de recuperación después.
// - Si los mensajes de un número tardan en llegar a tus otros números, baja su ritmo antes de que lo restrinjan.
// - Stickers, GIFs, mensajes borrados «para todos», respuestas tardías, charlas de llamadas perdidas y cambios de perfil.
// - Madurez diaria por número: aviso cuando uno queda listo y reporte semanal los lunes.
// - Varios números escriben a la vez y cada uno puede estar en 2–3 charlas; si a esta hora hay pocos platicando y va
//   atrasado, arranca más charlas. Cupos más altos (6–35 al día según antigüedad) y más variedad de con quién habla.
// - Vida simulada (v3): cada número tiene nombre, cumpleaños y relaciones (familia, amigos, trabajo, conocidos) que deciden
//   cuándo y de qué platican; historias de varios días con fechas reales; programa por fases (recién vinculado → listo);
//   tus números se guardan como contactos entre sí, fijan chats, destacan mensajes, responden estados, reenvían,
//   hacen encuestas en el grupo y «revisan el celular» sin escribir. Racha sana: si un número va bien, cada día habla un poco más.
//   Mezcla con masivos: un número que está haciendo masivos también platica con tus números.
// - Intensidad Turbo (×2), Máximo (×3) y «sesión intensiva» (×2.5 por 1–6 h): más charlas a la vez, respuestas más rápidas, charlas que
//   cambian de tema y más grupo. Solo acelera a números sanos y nunca pasa el tope diario según su antigüedad.

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
	peersToday: db.prepare('SELECT account_id AS id, COUNT(DISTINCT peer_id) AS n FROM warmup_log WHERE ts > ? AND peer_id IS NOT NULL GROUP BY account_id'),
	prune: db.prepare('DELETE FROM warmup_log WHERE ts < ?'),
	accounts: db.prepare("SELECT id, name, phone, linked_at, rest_ended_at, rest_until, restricted_until FROM accounts WHERE (kind IS NULL OR kind != 'cloud') AND phone IS NOT NULL AND phone != ''"),
	getSetting: db.prepare('SELECT value FROM app_settings WHERE key = ?'),
	setSetting: db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)'),
	lidsOf: db.prepare('SELECT lid FROM lid_map WHERE pn = ?'),
	chatTs: db.prepare('SELECT last_ts FROM chats WHERE account_id = ? AND jid = ?'),
	lastIn: db.prepare('SELECT id, remote_jid, participant, text FROM messages WHERE account_id = ? AND jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT 1'),
	hasMsg: db.prepare('SELECT 1 FROM messages WHERE account_id = ? AND id = ?'),
	recentOut: db.prepare('SELECT jid FROM messages m WHERE account_id = ? AND from_me = 1 AND ts > ? AND NOT EXISTS (SELECT 1 FROM campaign_items c WHERE c.message_id = m.id) ORDER BY ts DESC LIMIT 30'),
	pairs7: db.prepare('SELECT account_id AS a, peer_id AS b, COUNT(*) AS n FROM warmup_log WHERE ts > ? AND peer_id IS NOT NULL GROUP BY account_id, peer_id'),
	recentOwnIn: db.prepare("SELECT id, jid, remote_jid, text FROM messages WHERE account_id = ? AND from_me = 0 AND ts > ? AND type = 'text' AND length(text) > 15 ORDER BY ts DESC LIMIT 40")
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
const NAME_OK = /^(img|aud|stk|gif)-[\w-]+\.(jpg|png|webp|ogg|mp4)$/
const KIND = { img: 'image', aud: 'audio', stk: 'sticker', gif: 'gif' }
const MAX_FILES = 60
export const library = {
	list() {
		try {
			return fs.readdirSync(MEDIA_DIR).filter(f => NAME_OK.test(f)).map(f => {
				const st = fs.statSync(path.join(MEDIA_DIR, f))
				return { name: f, kind: KIND[f.slice(0, 3)], size: st.size, at: st.mtimeMs }
			}).sort((a, b) => b.at - a.at)
		} catch { return [] }
	},
	count(kind) { return this.list().filter(f => f.kind === kind).length },
	async add(buffer, mime, originalName, as) {
		if (!buffer?.length) throw new Error('Falta el archivo')
		if (buffer.length > 8 * 1024 * 1024) throw new Error('El archivo es muy grande (máximo 8 MB)')
		if (this.list().length >= MAX_FILES) throw new Error(`Máximo ${MAX_FILES} archivos; borra alguno`)
		fs.mkdirSync(MEDIA_DIR, { recursive: true })
		const base = String(mime || '').split(';')[0]
		const id = crypto.randomUUID().slice(0, 12)
		// Sticker: se guarda como WebP 512×512
		if (as === 'sticker' && (IMG[base] || base === 'image/gif')) {
			let webp = buffer
			if (base !== 'image/webp') {
				if (!await hasFfmpeg()) throw new Error('Para stickers sube un .webp (falta ffmpeg en el servidor)')
				webp = await toSticker(buffer)
			}
			const name = `stk-${id}.webp`
			fs.writeFileSync(path.join(MEDIA_DIR, name), webp)
			return name
		}
		// GIF: WhatsApp los manda como video MP4 sin sonido que se repite
		if (base === 'image/gif' || base === 'video/mp4' || (as === 'gif' && base.startsWith('video/'))) {
			let mp4 = buffer
			if (base !== 'video/mp4') {
				if (!await hasFfmpeg()) throw new Error('Para GIFs sube un .mp4 (falta ffmpeg en el servidor)')
				mp4 = await toMp4(buffer)
			}
			const name = `gif-${id}.mp4`
			fs.writeFileSync(path.join(MEDIA_DIR, name), mp4)
			return name
		}
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
		throw new Error('Sube una foto (JPG, PNG), sticker, GIF o un audio')
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
const DEFAULTS = { enabled: false, auto: true, allDay: true, perDay: 20, minDelay: 25, maxDelay: 150, startHour: 9, endHour: 21, intensity: 'normal', media: true, stories: true, groups: true, profiles: true, contacts: true, mentors: {}, prep: {} }
const INTENSITY = { suave: 0.6, normal: 1, intenso: 1.4, turbo: 2, maximo: 3 }
const BOOST = 2.5 // «sesión intensiva»: multiplica la actividad por unas horas
// Tope diario por antigüedad que ninguna intensidad puede pasar (para no quemar números nuevos)
const capFor = age => (age < 1 ? 10 : age < 3 ? 25 : age < 7 ? 50 : age < 14 ? 80 : 120)
const GRACE_HOURS = Number(process.env.WARMUP_GRACE_HOURS || 24) // espera tras vincular antes de enviar
const GRACE_RECEIVE = 12 // mensajes que puede recibir al día un número recién vinculado
const MAX_ACTIVE = 12 // charlas a la vez como máximo (en total)
const PER_NUMBER = 2 // charlas a la vez por número (como una persona que platica con dos o tres)
const PARALLEL = 3 // números escribiendo al mismo tiempo
const PAIR_PER_DAY = 3 // charlas al día como máximo entre los mismos dos números
const OVERFLOW = 3 // mensajes extra para terminar una charla ya empezada aunque se acabe el cupo
const FAILS_TO_FLAG = 3
const FLAG_HOURS = 12
const LAT = Number(process.env.WARMUP_LAT || 19.4326)
const LNG = Number(process.env.WARMUP_LNG || -99.1332)
const RECOVER_DAYS = 3 // días de regreso gradual después de una restricción
const MAX_HISTORY = 40

// Error de dedo: intercambia dos letras de una palabra larga ("gracias" → "garcias")
function typo(text) {
	const words = [...text.matchAll(/\p{L}{5,}/gu)]
	if (!words.length) return null
	const w = pick(words)
	const i = irnd(1, w[0].length - 3)
	const chars = [...w[0]]
	;[chars[i], chars[i + 1]] = [chars[i + 1], chars[i]]
	const bad = chars.join('')
	if (bad === w[0]) return null
	return { text: text.slice(0, w.index) + bad + text.slice(w.index + w[0].length), word: w[0] }
}
// Texto corto de la primera línea para el historial ("{Hola|Buenas}" → "Hola")
const previewOf = line => typeof line === 'string'
	? line.replace(/\{([^|}]*)[^}]*\}/g, '$1').replace(/\|\|/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70)
	: { image: '📷 Foto', audio: '🎤 Nota de voz', location: '📍 Ubicación', contact: '👤 Contacto' }[line?.media] || '…'

function moments(h, wd) {
	return {
		morning: h >= 6 && h < 12,
		lunch: h >= 12 && h < 16,
		afternoon: h >= 16 && h < 21,
		night: h >= 21 || h < 3,
		monday: wd === 1 && h < 14,
		weekend: wd === 5 ? h >= 14 : wd === 6 || wd === 0,
		work: wd >= 1 && wd <= 5 && h >= 9 && h < 18
	}
}
const MOMENT_BOOST = { morning: 2, lunch: 2, afternoon: 1.5, night: 3, monday: 2, weekend: 1.5, work: 1.5 }
// Programa por fases de cada número
const PHASES = [
	{ label: 'Recién vinculado', desc: 'Solo recibe mensajes de tus números maduros y ve sus estados', next: 'Al cumplir 24 h' },
	{ label: 'Primeros pasos', desc: 'Platica solo con números maduros (o sus padrinos); solo texto', next: 'Al cumplir 3 días' },
	{ label: 'Socializando', desc: 'Habla con todos: fotos, audios, stickers, grupo e historias de varios días', next: 'Al cumplir 7 días' },
	{ label: 'Activo', desc: 'Estados, encuestas, reenvíos y más volumen', next: '14 días, madurez 70 y en verde' },
	{ label: 'Listo', desc: 'Volumen completo; recomendado para envíos masivos', next: '' }
]
const DOY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: process.env.TZ_CAMPAIGNS || 'America/Mexico_City', month: 'numeric', day: 'numeric' })
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
function dayOfYear(t = Date.now()) {
	const p = {}
	for (const x of DOY_FMT.formatToParts(new Date(t))) p[x.type] = x.value
	return MONTH_START[Number(p.month) - 1] + Number(p.day) - 1
}
const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`)
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
		this.speaking = new Set() // números escribiendo en este momento
		this.nextFree = {} // cuándo puede volver a escribir cada número
		this.nextFillAt = 0
		this.arcs = [] // historias de varios días en curso
		this.bdays = {} // felicitaciones de cumpleaños ya enviadas (día:de:para)
		this.streak = {} // días seguidos sanos por número
		this.nextPing = {} // cuándo «revisa el celular» cada número
		this.memo = new Map() // textos enviados hace poco por número (para no repetirse)
		this.names = new Map()
		this.saved = getJSON('warmup_contacts', {}) // contactos guardados entre tus números
		this.pinned = getJSON('warmup_pinned', {}) // chats fijados por número
		this.muted = {}
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
		this.follows = [] // seguimientos pendientes { from, to, lines, at }
		this.history = getJSON('warmup_history', []) // últimas charlas
		this.quality = {} // últimas pruebas de entrega por número: ok | slow | fail
		this.profileLog = getJSON('warmup_profile', {}) // cambios de perfil hechos por el calentamiento
		this.matHist = getJSON('warmup_maturity', {}) // madurez de cada número por día
		const readyInit = getJSON('warmup_ready', null)
		this.readyNotified = readyInit || {}
		this.readyInit = Boolean(readyInit)
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
		s.perDay = clamp(Number(s.perDay) || DEFAULTS.perDay, 1, 150)
		s.minDelay = clamp(Number(s.minDelay) || DEFAULTS.minDelay, 5, 360)
		s.maxDelay = clamp(Number(s.maxDelay) || DEFAULTS.maxDelay, s.minDelay, 720)
		s.startHour = clamp(Math.floor(Number(s.startHour) || 0), 0, 23)
		s.endHour = clamp(Math.floor(Number(s.endHour) || 24), s.startHour + 1, 24)
		for (const k of ['enabled', 'auto', 'allDay', 'media', 'stories', 'groups', 'profiles', 'contacts']) s[k] = s[k] === undefined ? DEFAULTS[k] : Boolean(s[k])
		if (!INTENSITY[s.intensity]) s.intensity = 'normal'
		s.boostUntil = Number(s.boostUntil) > Date.now() ? Math.min(Number(s.boostUntil), Date.now() + 12 * 36e5) : 0
		// Padrinos: { númeroNuevo: [números maduros que hablan con él] }
		const m = {}
		for (const [k, v] of Object.entries(s.mentors && typeof s.mentors === 'object' ? s.mentors : {})) {
			const id = Number(k)
			const list = [...new Set((Array.isArray(v) ? v : []).map(Number).filter(x => x && x !== id))].slice(0, 12)
			if (id && list.length) m[id] = list
		}
		s.mentors = m
		// Preparar para masivo: { número: fecha en que se va a usar }
		const pr = {}
		for (const [k, v] of Object.entries(s.prep && typeof s.prep === 'object' ? s.prep : {})) {
			const t = Number(v)
			if (Number(k) && t > Date.now() - 2 * DAY && t < Date.now() + 60 * DAY) pr[Number(k)] = t
		}
		s.prep = pr
		setJSON('warmup', s)
		const wasOn = this.s.enabled
		this.s = s
		this.snap = null
		if (s.enabled && !wasOn) this.nextConvoAt = Date.now() + rnd(0.5, 3) * MIN
		if (s.enabled) this.nextConvoAt = Math.min(this.nextConvoAt, Date.now() + (s.boostUntil ? 0.5 : 20) * MIN)
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
			nextConvoAt: this.nextConvoAt, recent: this.recent, seq: this.seq, avgLines: this.avgLines, follows: this.follows, quality: this.quality,
			arcs: this.arcs, bdays: this.bdays, streak: this.streak
		})
		setJSON('warmup_history', this.history.slice(0, MAX_HISTORY))
	}
	restore() {
		const st = getJSON('warmup_state', null)
		if (!st) return
		const now = Date.now()
		this.fails = st.fails || {}
		this.follows = (st.follows || []).filter(f => f?.lines?.length && now - f.at < 5 * DAY)
		this.quality = st.quality && typeof st.quality === 'object' ? st.quality : {}
		this.streak = st.streak && typeof st.streak === 'object' ? st.streak : {}
		this.bdays = st.bdays && typeof st.bdays === 'object' ? Object.fromEntries(Object.entries(st.bdays).filter(([k]) => Number(k.split(':')[0]) >= dayKey() - 1)) : {}
		this.arcs = (st.arcs || []).filter(a => a?.steps?.length && a.i < a.steps.length && now - a.steps[a.steps.length - 1].at < 2 * DAY)
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
		// Al cambiar de día: suma un día a la racha de los que fueron sanos ayer (o la reinicia)
		if (this.day != null && this.lastList) this.updateStreaks(this.lastList, d)
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
		if (h.restrictedUntil) return 4 // restringido: no puede iniciar chats nuevos, solo contesta un poco
		if (h.restUntil) return h.rejections24h >= 2 ? 0 : 4 // descanso de masivos: charla ligera para recuperarse
		if (h.level === 'red') return 0
		const age = h.ageDays
		let base
		if (age < 3) base = 6 + 3 * age
		else if (h.level === 'yellow') base = 8
		else if (age < 7) base = 18
		else if (age < 14) base = 25
		else if (age < 30 || h.level !== 'green') base = 30
		else base = 35
		// Mezcla con masivos: por cada 4 mensajes de masivo, uno de charla con tus números (hasta 15 más)
		if (camp >= 10 && h.level === 'green') base += Math.min(15, Math.round(camp * 0.25))
		if (a.recovering) base *= 0.5 // acaba de salir de una restricción: regresa poco a poco
		return base * this.prepFactor(a) * this.multiplierFor(a) * this.streakBonus(a)
	}
	boostActive() { return Number(this.s.boostUntil) > Date.now() }
	// ¿Modo acelerado? (Turbo o sesión intensiva)
	hot() { return this.s.intensity === 'turbo' || this.s.intensity === 'maximo' || this.boostActive() }
	// Solo se acelera a los números sanos; a los demás nunca se les sube de lo normal
	multiplierFor(a) {
		const m = INTENSITY[this.s.intensity || 'normal'] * (this.boostActive() ? BOOST : 1)
		const healthy = a.level === 'green' && !a.restricted && !a.slow && !a.recovering && !a.resting
		return healthy ? m : Math.min(1, m)
	}
	// Racha sana: +4% por cada día seguido sin problemas (hasta +50%)
	streakBonus(a) {
		const healthy = a.level === 'green' && !a.restricted && !a.slow && !a.resting
		return healthy ? 1 + Math.min(0.5, 0.04 * (this.streak[a.id]?.n || 0)) : 1
	}
	updateStreaks(list, d) {
		for (const a of list) {
			const st = this.streak[a.id] ||= { n: 0, day: null }
			if (st.day === d) continue
			const healthy = a.level === 'green' && !a.restricted && !a.slow && !this.flagged(a.id) && !a.resting
			st.n = healthy ? st.n + 1 : 0
			st.day = d
		}
		this.dirty = true
	}
	// Fase del programa: 0 recién vinculado · 1 primeros pasos · 2 socializando · 3 activo · 4 listo
	phaseOf(a) {
		if (a.grace) return 0
		const age = this.ageDays(a)
		if (age < 3) return 1
		if (age < 7) return 2
		if (age < 14 || (a.mature?.score ?? 0) < 70 || a.level !== 'green') return 3
		return 4
	}
	phaseProgress(a) {
		const hrs = this.ageHours(a)
		switch (a.phase) {
			case 0: return clamp(hrs / GRACE_HOURS, 0, 1)
			case 1: return clamp((hrs - 24) / 48, 0, 1)
			case 2: return clamp((hrs / 24 - 3) / 4, 0, 1)
			case 3: return clamp(Math.min(this.ageDays(a) / 14, (a.mature?.score ?? 0) / 70), 0, 1)
			default: return 1
		}
	}

	// Preparar para masivo: los 5 días previos sube poco a poco (hasta ×1.75); 2 días después, charla de recuperación
	prepFactor(a) {
		const t = this.s.prep?.[a.id]
		if (!t) return 1
		const d = (t - Date.now()) / DAY
		if (d > 5) return 1
		if (d > 0) return 1 + (5 - d) * 0.15
		if (d > -2) return 1.3
		return 1
	}
	// Señales de lentitud: la mitad o más de las últimas pruebas llegaron tarde o no llegaron
	isSlow(id) {
		const last = (this.quality[id] || []).slice(-8)
		return last.length >= 4 && last.filter(x => x !== 'ok').length / last.length >= 0.5
	}
	addQuality(id, r, snap) {
		const was = this.isSlow(id)
		this.quality[id] = [...(this.quality[id] || []), r].slice(-10)
		this.dirty = true
		if (!was && this.isSlow(id) && !this.flagged(id)) {
			this.snap = null
			const name = snap?.byId.get(id)?.name || 'Un número'
			sendPush({ title: `🐢 ${name}: sus mensajes tardan en llegar`, body: 'El calentamiento bajó su ritmo a la mitad para cuidarlo. Evita usarlo en masivos hasta que se normalice.', url: '/#/settings' })
		}
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
		if (this.flagged(a.id) || a.restricted) score = Math.round(score * 0.5)
		const tips = []
		if (this.flagged(a.id)) tips.push('Sus mensajes no les llegan a tus otros números: puede estar restringido')
		if (a.restricted) tips.push('WhatsApp lo restringió: solo contesta, no inicia charlas')
		if (a.recovering) tips.push('Saliendo de una restricción: habla a la mitad unos días')
		if (a.slow) tips.push('Sus mensajes tardan en llegar: habla a la mitad hasta que se normalice')
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
		const rows = q.accounts.all()
		this.names = personaNames(rows.map(r => r.id))
		for (const row of rows) {
			if (this.manager.sessions.get(row.id)?.status !== 'connected') continue
			const a = { ...row, grace: this.ageHours(row) < GRACE_HOURS, campaign: camp.get(row.id) || 0 }
			let h = null
			try { h = accountHealth(a.id, 'connected') } catch {}
			a.level = h?.level || 'red'
			a.resting = Boolean(h?.restUntil || (a.rest_until && a.rest_until > now))
			a.restricted = Boolean(h?.restrictedUntil)
			a.restrictedUntil = h?.restrictedUntil || null
			a.slow = this.isSlow(a.id)
			a.recovering = !a.restricted && Boolean(a.restricted_until && a.restricted_until <= now && now - a.restricted_until < RECOVER_DAYS * DAY)
			let base
			if (s.auto) base = this.autoBase(a, h, a.campaign)
			else base = a.grace || a.level === 'red' ? 0 : a.restricted ? Math.min(s.perDay, 3) : Math.min(s.perDay, 3 + 2 * this.ageDays(a)) * (a.recovering ? 0.5 : 1) * this.prepFactor(a) * this.multiplierFor(a)
			a.target = base ? Math.max(1, Math.round(base * this.dayFactor(a, rest, wd))) : 0
			if (!s.auto) a.target = Math.min(Math.round(s.perDay * this.multiplierFor(a)), a.target)
			a.cap = capFor(this.ageDays(a))
			a.target = Math.min(a.target, a.cap)
			if (a.slow && a.target) a.target = Math.max(1, Math.round(a.target * 0.5))
			if (this.flagged(a.id)) a.target = 0
			a.persona = persona(a.id)
			a.mature = this.maturity(a, vol.get(a.id), recv14.get(a.id))
			a.phase = this.phaseOf(a)
			list.push(a)
		}
		this.snap = { at: now, list, byId: new Map(list.map(a => [a.id, a])) }
		this.lastList = list
		this.trackMaturity(list)
		return this.snap
	}
	// Guarda la madurez del día y avisa cuando un número queda listo para masivos
	trackMaturity(list) {
		const d = String(dayKey())
		const day = this.matHist[d] ||= {}
		for (const a of list) {
			day[a.id] = a.mature.score
			if (a.mature.score >= 70 && !this.readyNotified[a.id]) {
				this.readyNotified[a.id] = Date.now()
				if (this.readyInit && this.s.enabled) sendPush({ title: `✅ ${a.name} ya está listo para masivos`, body: `Madurez ${a.mature.score}/100 en el calentamiento.`, url: '/#/settings' })
			} else if (a.mature.score < 60 && this.readyNotified[a.id]) delete this.readyNotified[a.id]
		}
		if (!this.readyInit) this.readyInit = true // la primera vez no avisa de los que ya estaban listos
		if (Date.now() - (this.matSavedAt || 0) > 10 * MIN) {
			this.matSavedAt = Date.now()
			for (const k of Object.keys(this.matHist)) if (Number(k) < Number(d) - 35) delete this.matHist[k]
			setJSON('warmup_maturity', this.matHist)
			setJSON('warmup_ready', this.readyNotified)
		}
	}
	// Cuánto subió (o bajó) la madurez en los últimos 7 días
	weekDelta(id, score) {
		const d = dayKey()
		for (const back of [7, 6, 8, 5, 9, 4, 3, 2, 1]) {
			const v = this.matHist[String(d - back)]?.[id]
			if (v != null) return score - v
		}
		return null
	}
	live(id) { return this.manager.sessions.get(id)?.status === 'connected' }
	canSpeak(a, continuing) { return !a.grace && a.target > 0 && this.sentToday(a.id) < a.target + (continuing ? OVERFLOW : 0) }
	// ¿Está ocupado en algo real? (un chat con un cliente o un envío masivo en los últimos minutos)
	// (los masivos ya no cuentan: un número que hace masivos también platica con tus números, como una persona)
	busyReal(id) {
		const since = Date.now() - 3 * MIN
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
		return { image: m && library.count('image') > 0, audio: m && library.count('audio') > 0, sticker: m && library.count('sticker') > 0, gif: m && library.count('gif') > 0, location: m, contact: m }
	}

	// Red de quién platica con quién (últimos 7 días) con su relación
	network(list) {
		const ids = new Set(list.map(a => a.id))
		const agg = new Map()
		try {
			for (const r of q.pairs7.all(Date.now() - 7 * DAY)) {
				if (!ids.has(r.a) || !ids.has(r.b)) continue
				const k = pairKey(r.a, r.b)
				agg.set(k, (agg.get(k) || 0) + r.n)
			}
		} catch {}
		return {
			nodes: list.map(a => ({ id: a.id, name: a.name, phase: a.phase, score: a.mature?.score ?? 0 })),
			edges: [...agg].map(([k, n]) => { const [a, b] = k.split(':').map(Number); return { a, b, n, rel: relOf(a, b) } })
		}
	}
	hourlyToday(sod) {
		const out = Array(24).fill(0)
		try { for (const { ts } of q.perDay.all(sod)) out[tzNow(ts).h]++ } catch {}
		return out
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
		let peers = new Map()
		try { peers = new Map(q.peersToday.all(sod).map(r => [r.id, r.n])) } catch {}
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
				typingNow: this.speaking.size,
				startHour: s.allDay ? 0 : s.startHour,
				endHour: s.allDay ? 24 : s.endHour,
				week,
				dayLeft: Math.round(curveLeft(h, m) / DAY_SUM * 100)
			},
			group: g ? { subject: g.subject, members: (g.members || []).length } : null,
			library: { images: files.filter(f => f.kind === 'image').length, audios: files.filter(f => f.kind === 'audio').length, stickers: files.filter(f => f.kind === 'sticker').length, gifs: files.filter(f => f.kind === 'gif').length, files },
			customCount: this.custom.length,
			pendingFollows: this.follows.length,
			boostUntil: this.boostActive() ? this.s.boostUntil : 0,
			hot: this.hot(),
			history: this.history.slice(0, 15),
			network: this.network(list),
			hourly: this.hourlyToday(sod),
			phases: PHASES.map(x => ({ label: x.label, desc: x.desc })),
			rels: RELS,
			arcs: this.arcs.slice(0, 12).map(x => ({ key: x.key, a: x.a, b: x.b, eventAt: x.eventAt, step: x.i, steps: x.steps.length, nextAt: x.steps[x.i]?.at || null })),
			birthdays: list.filter(a => birthdayOf(a.id) === dayOfYear()).map(a => a.id),
			contactsSaved: Object.values(this.saved).filter(x => x?.ok).length,
			numbers: list.map(a => ({
				id: a.id, name: a.name, sentToday: this.sentToday(a.id), receivedToday: this.recvToday(a.id), target: a.target,
				ageDays: this.ageDays(a), asleep: this.awake(a, h, wd) < 0.15, grace: a.grace, resting: a.resting,
				level: a.level, campaignToday: a.campaign, flagged: this.flagged(a.id) ? this.flags[a.id] : null,
				restrictedUntil: a.restrictedUntil, recovering: a.recovering,
				mentors: this.mentorsOf(a.id), godchildren: this.godchildrenOf(a.id), mentorsPaused: this.mentorsOf(a.id).filter(m => !this.mentorOk(m)),
				slow: a.slow, prepAt: this.s.prep?.[a.id] || null, cap: a.cap, atCap: a.target >= a.cap,
				peersToday: peers.get(a.id) || 0, convos: this.convCount(a.id), busyReal: this.busyReal(a.id), weekDelta: this.weekDelta(a.id, a.mature.score),
				maturity: a.mature,
				inConvo: [...this.convos.values()].some(c => c.members.includes(a.id)),
				persona: this.names.get(a.id) || null,
				phase: a.phase, phaseLabel: PHASES[a.phase]?.label, phaseDesc: PHASES[a.phase]?.desc, phaseNext: PHASES[a.phase]?.next, phaseProgress: this.phaseProgress(a),
				streak: this.streak[a.id]?.n || 0, streakBonus: Math.round((this.streakBonus(a) - 1) * 100),
				contacts: Object.entries(this.saved).filter(([k, v]) => v?.ok && k.startsWith(`${a.id}>`)).length
			}))
		}
	}

	// ---- Motor ----
	async tick() {
		if (this.busy || !this.s.enabled) return
		const now = Date.now()
		// Sin nada pendiente no se toca la base de datos
		const due = now >= this.nextConvoAt || now >= this.nextFillAt || now >= this.nextHousekeeping || this.queue.some(e => e.at <= now) || this.checks.some(c => c.at <= now)
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
			// 0) «Revisa el celular»: cada número se conecta un momento varias veces al día, sin escribir
			{
				const { h: hh, wd: wdd } = tzNow()
				for (const a of snap.list) {
					if (this.nextPing[a.id] == null) { this.nextPing[a.id] = now + rnd(1, 40) * MIN; continue }
					if (this.nextPing[a.id] > now) continue
					const w = this.awake(a, hh, wdd)
					this.nextPing[a.id] = now + (w < 0.3 ? rnd(90, 240) : rnd(25, 100) / Math.max(w, 0.3)) * MIN
					if (w >= 0.3 && !this.speaking.has(a.id)) this.manager.sessions.get(a.id)?.online(irnd(15, 60) * 1000)?.catch?.(() => {})
				}
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
					if (ev.kind === 'view') {
						await session.viewStatus(ev.poster, ev.msgId)
						// A veces contesta el estado («¿Dónde es eso?») y el otro le responde
						const viewer = snap.byId.get(id), poster = snap.byId.get(ev.posterId)
						if (viewer && poster && (viewer.phase ?? 4) >= 2 && Math.random() < 0.12 && this.convCount(id) < PER_NUMBER && this.convCount(poster.id) < PER_NUMBER + 1 && !this.inConvoWith(id, poster.id) && this.allowedPair(id, poster.id)) {
							const lines = [{ media: 'statusReply', statusId: ev.msgId, poster: ev.poster, statusText: ev.text || '' }, pick(STATUS_ANSWERS)]
							this.startConvo({ members: [id, poster.id], order: [id, poster.id], lines, statusReply: true }, { lines }, false)
						}
					} else {
						const chat = ev.group || this.chatJid(id, ev.fromPhone)
						await session.markRead(chat)
						// De vez en cuando destaca (⭐) un mensaje, sobre todo fotos, ubicaciones o contactos
						if (ev.msgId && !ev.group && Math.random() < (ev.media ? 0.12 : 0.02)) await session.starMessage(chat, ev.msgId, false).catch(() => {})
					}
				} catch {}
			}
			// 2) Varios números pueden escribir a la vez (cada uno en su teléfono), pero cada número un mensaje a la vez
			let acted = false
			const maxPar = this.hot() ? PARALLEL + 2 : PARALLEL
			for (const ev of this.queue.filter(e => e.kind === 'say' && e.at <= Date.now()).sort((a, b) => a.at - b.at)) {
				if (this.speaking.size >= maxPar) break
				const c = this.convos.get(ev.convoId)
				if (!c) { this.queue = this.queue.filter(e => e !== ev); this.dirty = true; continue }
				const sp = c.order[c.i]
				if (this.speaking.has(sp) || (this.nextFree[sp] || 0) > Date.now()) continue
				this.queue = this.queue.filter(e => e !== ev)
				this.dirty = true
				this.speaking.add(sp)
				acted = true
				this.say(ev, snap).catch(() => {}).finally(() => {
					this.speaking.delete(sp)
					this.nextFree[sp] = Date.now() + irnd(4, 12) * 1000 // respiro de ese número antes de su siguiente mensaje
					this.dirty = true
					this.persist()
				})
			}
			// 3) ¿Empieza otra charla? Además del ritmo planeado, si hay pocos platicando a esta hora y va atrasado, arranca otra
			const { h, m, wd } = tzNow()
			let fill = false
			if (Date.now() >= this.nextFillAt) {
				this.nextFillAt = Date.now() + rnd(0.5, 1.5) * MIN
				fill = this.needsFill(snap, h, m, wd)
			}
			const regular = Date.now() >= this.nextConvoAt
			if (regular || fill) {
				const force = this.forceNext
				this.forceNext = false
				const go = force || fill || (!this.replanOnly && this.inWindow(h))
				const r = go ? this.spawn(snap, h, wd, force) : 'skip'
				if (fill && !regular) this.nextFillAt = Date.now() + rnd(1, 4) * MIN
				// Si todos están ocupados en otras charlas, la nueva solo se pospone unos minutos
				else if (r === 'busy') { this.nextConvoAt = Date.now() + rnd(2, 6) * MIN; this.replanOnly = false }
				else this.scheduleNextConvo(snap)
				this.dirty = true
			}
			// 4) Tareas de fondo: perfil, grupo y estados
			if (!acted && Date.now() >= this.nextHousekeeping) {
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
		try { this.weeklyReport(snap) } catch {}
		const { h, wd } = tzNow()
		if (!this.inWindow(h) || CURVE[h] < 0.6) return
		await this.maybeProfileChange(snap).catch(() => {})
		await this.maybeSaveContact(snap).catch(() => {})
		await this.maybePinChat(snap).catch(() => {})
		await this.maybeMuteGroup(snap).catch(() => {})
		await this.ensureGroup(snap).catch(() => {})
		await this.maybeStory(snap, h, wd).catch(() => {})
	}

	// Un grupo entre tus números (los que ya llevan unos días), como el de la familia o los amigos
	async ensureGroup(snap) {
		if (!this.s.groups) return
		const now = Date.now()
		const ok = snap.list.filter(a => !a.grace && (a.phase ?? 4) >= 2 && a.level !== 'red' && !this.flagged(a.id) && this.ageDays(a) >= 2 && !this.busyReal(a.id))
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
		const due = snap.list.filter(a => !a.grace && (a.phase ?? 4) >= 2 && a.level !== 'red' && !this.flagged(a.id) && this.awake(a, h, wd) >= 0.6 &&
			now - (this.stories[a.id] || 0) > (1.6 + hash01(a.id, this.day) * 2.4) * DAY && !this.busyReal(a.id))
		const a = pick(due)
		if (!a) return
		// Solo lo ven tus otros números vinculados (nunca contactos ni clientes)
		const viewers = snap.list.filter(x => x.id !== a.id && digits(x.phone) && digits(x.phone) !== digits(a.phone) && isOwnJid(jidOf(x.phone)))
		if (!viewers.length) return
		const session = this.manager.sessions.get(a.id)
		const jids = viewers.map(x => jidOf(x.phone))
		const img = this.s.media && Math.random() < 0.4 ? this.pickMedia('image') : null
		let storyText = ''
		const text = () => (storyText = styleText(vary(pick(STORY_TEXTS)), a.persona))
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
				this.queue.push({ at: now + t.readIn + rnd(1, 120) * MIN, kind: 'view', readerId: v.id, poster: res.from, posterId: a.id, msgId: res.id, text: storyText })
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
			// Primera revisión a los 3 min; si aún no llega, otra a los 10 min (llegó tarde = señal de lentitud)
			if (q.hasMsg.get(c.to, c.id)) { this.fails[c.from] = 0; this.addQuality(c.from, c.stage === 1 ? 'ok' : c.stage === 2 ? 'slow' : 'ok', snap); continue }
			if (c.stage === 1) { this.checks.push({ ...c, at: now + 7 * MIN, stage: 2 }); continue }
			this.fails[c.from] = (this.fails[c.from] || 0) + 1
			if (this.fails[c.from] >= FAILS_TO_FLAG && !this.flagged(c.from)) {
				const name = snap.byId.get(c.from)?.name || 'Un número'
				this.flags[c.from] = { until: now + FLAG_HOURS * 36e5, at: now, reason: `${this.fails[c.from]} mensajes seguidos no llegaron a tus otros números` }
				this.snap = null
				sendPush({ title: `⚠️ ${name}: sus mensajes no llegan`, body: 'El calentamiento lo pausó 12 h. Puede estar restringido por WhatsApp: no lo uses en masivos por ahora.', url: '/#/settings' })
				for (const cv of [...this.convos.values()]) if (cv.members.includes(c.from)) this.end(cv.id, 'pausada')
			}
			this.addQuality(c.from, 'fail', snap)
		}
	}

	// ---- Padrinos y emparejamiento por madurez ----
	mentorsOf(id) { return (this.s.mentors?.[id] || []).map(Number) }
	// Un padrino solo cuenta si está sano: conectado, en verde, sin restricción, sin descanso y sin señales de lentitud
	mentorOk(id) {
		const a = this.snap?.byId.get(id)
		return Boolean(a && a.level === 'green' && !a.restricted && !a.resting && !a.slow && !this.flagged(id))
	}
	godchildrenOf(id) { return Object.keys(this.s.mentors || {}).map(Number).filter(t => this.mentorsOf(t).includes(id)) }
	// Un número con padrinos solo habla con sus padrinos sanos. Si ninguno está sano, habla con cualquier número sano y templado.
	allowedPair(a, b) {
		// Dos números en sus primeras fases no platican entre sí (salvo que uno sea padrino del otro)
		const A = this.snap?.byId.get(a), B = this.snap?.byId.get(b)
		const linked = this.mentorsOf(a).includes(b) || this.mentorsOf(b).includes(a)
		if (A && B && (A.phase ?? 4) <= 1 && (B.phase ?? 4) <= 1 && !linked) return false
		const check = (t, other) => {
			const M = this.mentorsOf(t)
			if (!M.length) return true
			const ok = M.filter(m => this.mentorOk(m))
			if (ok.length) return ok.includes(other)
			const o = this.snap?.byId.get(other)
			return Boolean(o && o.level === 'green' && !o.restricted && !o.slow && (o.mature?.score ?? 0) >= 40)
		}
		return check(a, b) && check(b, a)
	}
	pairBoost(a, b) {
		// Padrino ↔ ahijado: bastante más seguido, pero sin acaparar al padrino (sigue hablando con los demás)
		if ((this.mentorsOf(a.id).includes(b.id) && this.mentorOk(b.id)) || (this.mentorsOf(b.id).includes(a.id) && this.mentorOk(a.id))) return this.lastPair(a.id, b.id) > Date.now() - 3 * 36e5 ? 1.2 : 3
		const sa = a.mature?.score ?? 0, sb = b.mature?.score ?? 0
		const newA = sa < 40 || this.ageDays(a) < 7, newB = sb < 40 || this.ageDays(b) < 7
		if ((sa >= 70 && newB) || (sb >= 70 && newA)) return 2.5 // maduro con nuevo
		if (sa >= 40 && sb >= 40 && (newA || newB)) return 1.5 // templado con nuevo
		if (newA && newB) return 0.5 // dos nuevos entre sí, poco
		return 1
	}

	// Charlas que «deberían» ir en curso a esta hora: ~30% de los números despiertos con cupo (50% acelerado).
	// Solo rellena si va atrasado respecto a la curva del día, para que el cupo alcance hasta la noche.
	needsFill(snap, h, m, wd) {
		if (!this.inWindow(h) || CURVE[h] < 0.4) return false
		const awake = snap.list.filter(a => this.canSpeak(a, false) && this.awake(a, h, wd) >= 0.5)
		const desired = Math.floor(awake.length * (this.hot() ? 0.5 : 0.3) * CURVE[h])
		if (this.convos.size >= desired) return false
		const total = snap.list.reduce((n, a) => n + a.target, 0)
		if (!total) return false
		const sent = snap.list.reduce((n, a) => n + Math.min(a.target, this.sentToday(a.id)), 0)
		const end = this.s.allDay ? 24 : this.s.endHour
		const daySum = this.s.allDay ? DAY_SUM : curveSpan(this.s.startHour, this.s.endHour)
		const expected = 1 - curveLeft(h, m, end) / daySum
		return sent / total < expected + 0.08
	}
	convCount(id) { let n = 0; for (const c of this.convos.values()) if (c.members.includes(id)) n++; return n }
	inConvoWith(a, b) { for (const c of this.convos.values()) if (c.members.includes(a) && c.members.includes(b)) return true; return false }
	pairToday(a, b) {
		const d = dayKey()
		if (this.pairDay !== d) { this.pairDay = d; this.pairCount = {} }
		return this.pairCount[a < b ? `${a}:${b}` : `${b}:${a}`] || 0
	}
	countPair(a, b) { this.pairToday(a, b); const k = a < b ? `${a}:${b}` : `${b}:${a}`; this.pairCount[k] = (this.pairCount[k] || 0) + 1 }

	spawn(snap, hour, wd, force = false) {
		const list = snap.list
		const hot = this.hot()
		const maxActive = Math.min(hot ? MAX_ACTIVE + 6 : MAX_ACTIVE, list.length * (hot ? 1.5 : 1))
		if (this.convos.size >= maxActive) return 'busy'
		const perNumber = hot ? PER_NUMBER + 1 : PER_NUMBER
		const busyIds = new Set([...this.convos.values()].flatMap(c => c.members).filter(id => this.convCount(id) >= perNumber))
		const free = a => !busyIds.has(a.id) && this.live(a.id) && !this.flagged(a.id) && !this.busyReal(a.id)
		const ready = list.filter(a => free(a) && this.canSpeak(a, false) && !a.restricted) // un restringido no inicia charlas
		const mo = moments(hour, wd)
		const now = Date.now()
		// 1) Pasos de historias de varios días que ya tocan («¿sigue en pie lo de hoy?», «ya llegué»)
		for (const arc of this.arcs) {
			const st = arc.steps[arc.i]
			if (!st) continue
			if (now > st.at + (st.event ? 1.5 : 8) * 36e5) { arc.i++; this.dirty = true; continue } // se pasó la hora: ese paso ya no
			if (now < st.at) continue
			const A = snap.byId.get(arc.a), B = snap.byId.get(arc.b)
			if (!A || !B || !free(A) || !free(B) || this.inConvoWith(arc.a, arc.b)) continue
			const first = st.starter === 'a' ? A : B
			if (first.restricted || !this.canSpeak(first, true) || this.awake(first, hour, wd) < 0.35) continue
			return this.runArcStep(arc, force)
		}
		this.arcs = this.arcs.filter(a => a.i < a.steps.length)
		// 2) Cumpleaños: sus amigos y familia lo felicitan (y en el grupo)
		if (hour >= 8 && hour <= 21) {
			const doy = dayOfYear(now)
			const d = dayKey()
			for (const b of list.filter(x => birthdayOf(x.id) === doy && x.phase >= 1 && free(x))) {
				const name = this.names.get(b.id)?.first
				const g = this.group()
				if (g && this.s.groups && g.members.includes(b.id) && !this.bdays[`${d}:g:${b.id}`]) {
					const others = ready.filter(x => x.id !== b.id && g.members.includes(x.id) && x.phase >= 2)
					if (others.length >= 2) {
						this.bdays[`${d}:g:${b.id}`] = 1
						const two = weightedSample(others, () => 1, 2)
						const lines = BIRTHDAY_GROUP(name)
						return this.startConvo({ group: g.jid, members: [...two.map(x => x.id), b.id], order: [two[0].id, two[1].id, b.id], lines, birthday: true }, { lines }, force)
					}
				}
				const friends = ready.filter(x => x.id !== b.id && ['familia', 'amigos'].includes(relOf(x.id, b.id)) && !this.bdays[`${d}:${x.id}:${b.id}`] && this.allowedPair(x.id, b.id) && !this.inConvoWith(x.id, b.id))
				const x = pick(friends)
				if (x && Math.random() < 0.6) {
					this.bdays[`${d}:${x.id}:${b.id}`] = 1
					const lines = BIRTHDAY(name)
					return this.startConvo({ members: [x.id, b.id], order: [x.id, b.id, x.id], lines, birthday: true }, { lines }, force)
				}
			}
		}
		// 3) Seguimiento de una charla de días anteriores («¿cómo te fue en el banco?»)
		this.follows = this.follows.filter(f => now - f.at < 5 * DAY)
		const fu = this.follows.find(f => f.at <= now && this.allowedPair(f.from, f.to) && ready.some(a => a.id === f.from) && list.some(x => x.id === f.to && free(x)) && this.awake(snap.byId.get(f.from), hour, wd) >= 0.5)
		if (fu && Math.random() < 0.7) {
			this.follows = this.follows.filter(f => f !== fu)
			const to = snap.byId.get(fu.to)
			let lines = [...fu.lines]
			if (to.grace || !this.canSpeak(to, true)) lines = lines.slice(0, 1)
			return this.startConvo({ members: [fu.from, fu.to], order: lines.map((_, i) => (i % 2 === 0 ? fu.from : fu.to)), lines, followUp: true }, { lines }, force)
		}
		const fitOf = sc => (!sc.when ? (mo.night ? 0.4 : 1) : mo[sc.when] ? MOMENT_BOOST[sc.when] : 0)
		// A veces la charla es en el grupo de tus números
		const g = this.group()
		if (g && this.s.groups && Math.random() < (this.hot() ? 0.32 : 0.16)) {
			const members = ready.filter(a => g.members.includes(a.id) && !this.mentorsOf(a.id).length && a.phase >= 2)
			if (members.length >= 3) {
				const people = weightedSample(members, a => 0.2 + this.awake(a, hour, wd), Math.min(members.length, irnd(3, 4)))
				// A veces es una encuesta («¿Qué pedimos?») y los demás contestan
				if (people.length >= 3 && Math.random() < 0.25) {
					const lines = pollConvo(pick(GROUP_POLLS))
					const order = [people[0].id, people[1].id, people[2].id, people[0].id]
					return this.startConvo({ group: g.jid, members: people.map(p => p.id), order, lines, poll: true }, { lines }, force)
				}
				const script = weighted(GROUP_SCRIPTS, sc => fitOf(sc) * (this.recent.includes(keyOf(sc)) ? 0.05 : 1))
				if (script && people.length >= 3) {
					const order = [people[0].id]
					for (let i = 1; i < script.lines.length; i++) order.push(pick(people.filter(p => p.id !== order[i - 1])).id)
					return this.startConvo({ group: g.jid, members: people.map(p => p.id), order, lines: [...script.lines], when: script.when }, script, force)
				}
			}
		}
		// Con quién puede hablar cada uno (respeta los padrinos que elegiste)
		const partnersOf = st => list.filter(x => x.id !== st.id && free(x) && !this.inConvoWith(st.id, x.id) && this.allowedPair(st.id, x.id) && (!x.grace || this.recvToday(x.id) < GRACE_RECEIVE))
		// Quién empieza: el que está despierto y aún tiene cupo; los padrinos con su ahijado libre, más
		const starter = weighted(ready, a => {
			if (!partnersOf(a).length) return 0
			const kids = (this.mentorOk(a.id) ? this.godchildrenOf(a.id) : []).filter(k => { const x = snap.byId.get(k); return x && free(x) && (!x.grace || this.recvToday(x.id) < GRACE_RECEIVE) })
			return (force ? 1 : this.awake(a, hour, wd) ** 1.5) * (a.target - this.sentToday(a.id)) * (kids.length ? 1.5 : 1) *
				(campaignRecent(a.id, Date.now() - 30 * MIN) ? 1.6 : 1) // si está haciendo masivos, platica entre envíos
		})
		if (!starter) return list.some(a => busyIds.has(a.id) && this.canSpeak(a, false)) ? 'busy' : 'none'
		// Con quién: quien no ha hablado con él hace tiempo, despierto, y más si hoy hizo masivos.
		// Los maduros platican más con los nuevos y los nuevos menos entre sí; con padrinos, mucho más.
		const partners = partnersOf(starter)
		// Variedad: los que nunca han platicado, mucho más; los que ya platicaron 3 veces hoy, casi nada
		const partner = weighted(partners, x =>
			(0.2 + this.awake(x, hour, wd)) *
			(this.lastPair(starter.id, x.id) ? clamp((Date.now() - this.lastPair(starter.id, x.id)) / DAY, 0.15, 1.5) : 2.5) *
			(this.pairToday(starter.id, x.id) >= PAIR_PER_DAY ? 0.08 : 1) *
			relWeight(relOf(starter.id, x.id), hour, wd) * // la familia en la mañana y noche, el trabajo en horario laboral…
			(1 + Math.min(1.5, x.campaign / 40)) *
			(x.grace ? 0.7 : this.canSpeak(x, false) ? 1 : 0.35) *
			this.pairBoost(starter, x))
		if (!partner) return this.convos.size ? 'busy' : 'none'
		const rel = relOf(starter.id, partner.id)
		const minPhase = Math.min(starter.phase ?? 4, partner.phase ?? 4)
		// A veces empieza una historia de varios días («¿comemos el jueves?»)
		if (minPhase >= 2 && this.arcs.length < 30 && Math.random() < 0.2 && !this.arcs.some(x => pairKey(x.a, x.b) === pairKey(starter.id, partner.id))) {
			const def = pick(ARCS.filter(x => x.rels.includes(rel)))
			if (def) {
				const built = buildArc(def, startOfDay(), wd)
				const arc = { id: ++this.seq, a: starter.id, b: partner.id, key: built.key, steps: built.steps, i: 0, eventAt: built.eventAt }
				this.arcs.push(arc)
				this.countPair(starter.id, partner.id)
				return this.runArcStep(arc, force)
			}
		}
		// Guion según el momento, su relación y lo que haya disponible (fotos, audios), sin repetir los recientes
		const script = this.pickScript(hour, wd, rel, minPhase)
		if (!script) return 'none'
		let lines = [...script.lines]
		// A veces lo saluda por su nombre
		const nm = this.names.get(partner.id)?.first
		let named = false
		if (nm && !script.greets && !script.forward && rel !== 'conocidos' && typeof lines[0] === 'string' && Math.random() < 0.2) {
			lines[0] = rel === 'trabajo' ? `{Hola|Buen día|Oye} ${nm}||${lines[0]}` : `{Hola|Qué onda|Oye|Hey} ${nm}||${lines[0]}`
			named = true
		}
		// Recién vinculado: solo recibe (un mensaje, sin respuesta)
		if (partner.grace || !this.canSpeak(partner, true)) lines = lines.slice(0, 1)
		if (!named && !script.when && !script.greets && !script.custom && !script.forward && typeof lines[0] === 'string' && Math.random() < 0.25) {
			lines[0] = `${mo.morning ? GREET.morning : hour >= 12 && hour < 19 ? GREET.afternoon : GREET.night}||${lines[0]}`
		}
		const order = lines.map((_, i) => (i % 2 === 0 ? starter.id : partner.id))
		this.countPair(starter.id, partner.id)
		return this.startConvo({ members: [starter.id, partner.id], order, lines, when: script.when }, script, force)
	}
	// Arranca el paso que toca de una historia (cada paso es una charla corta)
	runArcStep(arc, force) {
		const st = arc.steps[arc.i]
		const first = st.starter === 'a' ? arc.a : arc.b
		const second = first === arc.a ? arc.b : arc.a
		const lines = [...st.lines]
		arc.i++
		this.dirty = true
		return this.startConvo({ members: [first, second], order: lines.map((_, k) => (k % 2 === 0 ? first : second)), lines, arc: arc.key }, { lines }, force)
	}

	// Guion según el momento, la relación de los dos (trabajo, familia, amigos…) y su fase
	pickScript(hour, wd, rel = null, phase = 4) {
		const mo = moments(hour, wd)
		const fitOf = sc => (!sc.when ? (mo.night ? 0.4 : 1) : mo[sc.when] ? MOMENT_BOOST[sc.when] : 0)
		const av = this.available()
		const pool = [...SCRIPTS, ...CALL_SCRIPTS.map(x => ({ ...x, weight: 0.6 })), ...this.custom,
			...(rel ? (REL_SCRIPTS[rel] || []).map(x => ({ ...x, weight: 1.6 })) : []),
			...(phase >= 3 ? FORWARD_SCRIPTS.map(x => ({ ...x, weight: 0.35 })) : [])]
		return weighted(pool, sc => {
			if (phase < 2 && needs(sc).size) return 0 // en las primeras fases, solo texto
			for (const n of needs(sc)) if (n !== 'forward' && !av[n]) return 0
			return fitOf(sc) * (sc.weight ?? (sc.custom ? 1.5 : 1)) * (this.recent.includes(keyOf(sc)) ? 0.03 : 1)
		})
	}
	startConvo(c, script, force) {
		this.recent = [keyOf(script), ...this.recent].slice(0, 14)
		const id = ++this.seq
		this.convos.set(id, { id, ...c, when: c.when || null, follow: script.follow || null, preview: previewOf(c.lines[0]), startedAt: Date.now(), i: 0, n: 0, postponed: 0, lastAt: Date.now() })
		this.queue.push({ at: Date.now() + rnd(force ? 0 : 5, force ? 5 : 40) * 1000, kind: 'say', convoId: id })
		this.dirty = true
		return 'ok'
	}

	end(convoId, reason = 'cortada') {
		// Aprende cuántos mensajes salen de verdad por charla (algunas acaban antes) para planear mejor
		const c = this.convos.get(convoId)
		if (c?.n && !c.group) this.avgLines = clamp(this.avgLines * 0.92 + c.n * 0.08, 1.5, 6)
		if (c) {
			// Si la charla terminó bien y tiene seguimiento, el que escuchaba pregunta en 1–2 días
			if (c.follow && !c.group && (reason === 'completa' || reason === 'reacción') && c.members.length === 2 && this.follows.length < 20) {
				this.follows.push({ from: c.members[1], to: c.members[0], lines: c.follow, at: Date.now() + rnd(18, 50) * 36e5 })
			}
			if (c.n || reason !== 'cortada') {
				let chat = null
				try {
					const other = this.snap?.byId.get(c.members[1])
					chat = c.group ? `${c.members[0]}:${c.group}` : other ? `${c.members[0]}:${this.chatJid(c.members[0], other.phone)}` : null
				} catch {}
				this.history.unshift({ at: Date.now(), startedAt: c.startedAt || null, members: c.members, group: Boolean(c.group), preview: c.preview || '', n: c.n, reason, followUp: Boolean(c.followUp), chat })
				this.history = this.history.slice(0, MAX_HISTORY)
			}
		}
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
			// No repite el mismo texto que mandó en los últimos días (vuelve a sortear las variantes)
			const memo = this.memo.get(speaker.id) || new Map()
			const recentText = t => t.length > 12 && Date.now() - (memo.get(t.toLowerCase()) || 0) < 3 * DAY
			let parts = bubbles(raw).map(t => styleText(t, p))
			for (let k = 0; k < 4 && parts.some(recentText); k++) parts = bubbles(raw).map(t => styleText(t, p))
			for (const t of parts) memo.set(t.toLowerCase(), Date.now())
			if (memo.size > 400) for (const k of [...memo.keys()].slice(0, 100)) memo.delete(k)
			this.memo.set(speaker.id, memo)
			for (let j = 0; j < parts.length; j++) {
				await typing(parts[j])
				// A veces se le va un error de dedo y luego lo corrige
				const bad = Math.random() < (p.typos ?? 0.05) ? typo(parts[j]) : null
				const r = await session.send(toJid, { text: bad ? bad.text : parts[j] }, undefined, j === 0 && quoted ? { quoted } : undefined)
				if (r?.id) ids.push(r.id)
				if (bad && r?.id) {
					if (Math.random() < 0.55) {
						await sleep(irnd(1200, 3500))
						await session.setPresence(toJid, 'composing')
						await sleep(irnd(800, 1800))
						const fix = await session.send(toJid, { text: `*${p.noAccent ? bad.word.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : bad.word}` })
						if (fix?.id) ids.push(fix.id)
					} else {
						await sleep(irnd(3000, 9000))
						await session.editMessage(r.id, parts[j]).catch(() => {})
					}
				}
				if (j < parts.length - 1) await sleep(irnd(500, 1800))
			}
		}
		// En las primeras fases solo manda texto
		if (typeof line === 'object' && (speaker.phase ?? 4) < 2 && !['statusReply'].includes(line.media)) line = line.fallback || '{Ok|Va}'
		if (typeof line === 'string') {
			const av = (speaker.phase ?? 4) >= 2 ? this.available() : {}
			// Respuesta corta → a veces solo un sticker
			if (ctx.reply && av.sticker && line.replace(/\{[^}]*\}/g, 'xx').length <= 30 && Math.random() < 0.05 + 0.08 * (p.emoji || 0)) {
				const f = this.pickMedia('sticker')
				if (f) {
					await session.setPresence(toJid, 'composing')
					await sleep(irnd(1500, 3500))
					const r = await session.send(toJid, { sticker: fs.readFileSync(f.path) })
					if (r?.id) { ids.push(r.id); return ids }
				}
			}
			await sendText(line, ctx.quoted)
			// Si se ríe, a veces manda un GIF después
			if (av.gif && /(ja){2,}|😂|🤣|jsjs/i.test(line) && Math.random() < 0.18) {
				const f = this.pickMedia('gif')
				if (f) {
					await sleep(irnd(1500, 4000))
					const r = await session.send(toJid, { video: fs.readFileSync(f.path), gifPlayback: true, mimetype: 'video/mp4' })
					if (r?.id) ids.push(r.id)
				}
			}
			return ids
		}
		let content = null
		if (line.media === 'poll' && line.poll) {
			// Encuesta en el grupo
			await session.setPresence(toJid, 'composing')
			await sleep(irnd(3000, 7000))
			content = { poll: { name: line.poll.name, values: line.poll.values, selectableCount: 1 } }
		} else if (line.media === 'forward') {
			// Reenvía algo que le mandó otro de tus números en otro chat
			try {
				const rows = q.recentOwnIn.all(speaker.id, Date.now() - 3 * DAY).filter(r => isOwnJid(r.jid) && r.jid !== toJid && !/^\*/.test(r.text))
				const r = pick(rows)
				if (r) {
					await sleep(irnd(1500, 4000))
					content = { forward: { key: { remoteJid: r.remote_jid, id: r.id, fromMe: false }, message: { conversation: r.text } } }
				}
			} catch {}
		} else if (line.media === 'statusReply' && line.statusId) {
			// Contesta un estado: el mensaje sale citando el estado, como en WhatsApp
			const text = styleText(vary(pick(STATUS_REPLIES)), p)
			await typing(text)
			const quoted = { key: { remoteJid: 'status@broadcast', id: line.statusId, participant: line.poster, fromMe: false }, message: { conversation: line.statusText || '📷' } }
			const r = await session.send(toJid, { text }, undefined, { quoted })
			if (r?.id) ids.push(r.id)
			return ids
		} else if (line.media === 'image') {
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
			if (++c.postponed > 4) return this.end(c.id, 'ocupado')
			this.queue.push({ ...ev, at: Date.now() + rnd(2, 6) * MIN })
			return
		}
		const isLast = c.i === c.lines.length - 1
		const session = this.manager.sessions.get(speaker.id)
		const one = c.group ? null : listeners[0]
		const toJid = c.group || jidOf(one.phone)
		const chat = c.group || this.chatJid(speaker.id, one.phone)
		const { h, wd } = tzNow()
		let line = c.lines[c.i]
		// Contesta tarde: empieza disculpándose
		if (c.late && typeof line === 'string') line = LATE_SORRY + line
		c.late = false
		let ids = []
		try {
			await session.online(irnd(25, 90) * 1000)
			// El cierre a veces es solo una reacción (👍) en vez de escribir
			if (isLast && c.i > 0 && typeof line === 'string' && Math.random() < 0.3 && await session.reactLast(chat, pick(REACTS))) {
				this.log(speaker.id, one?.id)
				c.n++
				return this.end(c.id, 'reacción')
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
			// Muy de vez en cuando manda algo que era para otro chat y lo borra para todos
			if (!c.group && (speaker.phase ?? 4) >= 3 && Math.random() < 0.015) ids.push(...await this.wrongMessage(session, speaker, toJid))
			ids.push(...await this.sendLine(session, speaker, toJid, line, { quoted, third, reply: c.i > 0 }))
			for (let k = 0; k < ids.length; k++) this.log(speaker.id, one?.id)
			c.n += ids.length
			await session.setPresence(toJid, 'paused')
		} catch {
			return this.end(c.id, 'error')
		} finally {
			this.lastActionAt = Date.now() + irnd(6, 18) * 1000 // respiro antes de cualquier otro envío
		}
		// Prueba de entrega del último mensaje (solo charlas 1 a 1)
		if (one && ids.length) this.checks.push({ at: Date.now() + 3 * MIN, stage: 1, id: ids[ids.length - 1], from: speaker.id, to: one.id })
		c.i++
		c.lastAt = Date.now()
		this.dirty = true
		// Los que reciben lo leen cuando pueden
		let next = null
		for (const l of listeners) {
			const t = this.replyTiming(l, h, wd)
			if (!c.group || Math.random() < 0.8) this.queue.push({ at: Date.now() + t.readIn, kind: 'read', readerId: l.id, fromPhone: speaker.phone, group: c.group || undefined, msgId: ids[ids.length - 1], media: typeof line === 'object' })
			if (c.i < c.lines.length && l.id === c.order[c.i]) next = t
		}
		// Fin del guion, o a veces se queda "en visto".
		// Un "buenas noches" a alguien dormido solo se lee en la mañana, no se contesta.
		// En modo acelerado, a veces la charla sigue con otro tema («Oye, otra cosa…») en vez de terminar
		if (c.i >= c.lines.length && !c.group && (c.chained || 0) < (this.hot() ? 3 : 1) && Math.random() < (this.hot() ? 0.6 : 0.3)) {
			const other = c.members.find(id => id !== speaker.id)
			const o = snap.byId.get(other)
			const sc = o && this.canSpeak(o, true) && this.canSpeak(speaker, true) && this.awake(o, h, wd) >= 0.5 ? this.pickScript(h, wd, relOf(speaker.id, other), Math.min(speaker.phase ?? 4, o.phase ?? 4)) : null
			if (sc && !sc.greets) {
				const extra = [...sc.lines]
				if (typeof extra[0] === 'string') extra[0] = `{Oye|Por cierto|Otra cosa|Oye, cambiando de tema}||${extra[0]}`
				this.recent = [keyOf(sc), ...this.recent].slice(0, 14)
				extra.forEach((l, k) => { c.lines.push(l); c.order.push(k % 2 === 0 ? other : speaker.id) })
				c.follow = sc.follow || c.follow
				c.chained = (c.chained || 0) + 1
				next = null
				for (const l of listeners) if (l.id === other) next = this.replyTiming(l, h, wd)
			}
		}
		const nextSpeaker = c.i < c.lines.length ? snap.byId.get(c.order[c.i]) : null
		const asleep = nextSpeaker ? this.awake(nextSpeaker, h, wd) < 0.15 : false
		if (!nextSpeaker || (asleep && c.when === 'night')) return this.end(c.id, 'completa')
		if (c.i >= 2 && Math.random() < (this.hot() ? 0.03 : 0.07)) return this.end(c.id, 'en visto')
		next ||= this.replyTiming(nextSpeaker, h, wd)
		// A veces lo ve horas después y contesta disculpándose
		let late = 0
		if (!c.group && this.awake(nextSpeaker, h, wd) >= 0.5 && Math.random() < 0.05) { late = rnd(60, 240) * MIN; c.late = true }
		this.queue.push({ at: Date.now() + next.readIn + next.replyIn + late, kind: 'say', convoId: c.id })
	}

	// Manda un mensaje que «era para otro chat», lo borra para todos y a veces se disculpa
	async wrongMessage(session, speaker, toJid) {
		const ids = []
		const p = speaker.persona
		try {
			const w = await session.send(toJid, { text: styleText(vary(pick(WRONG)), p) })
			if (!w?.id) return ids
			ids.push(w.id)
			await sleep(irnd(4000, 15000))
			await session.deleteForEveryone(w.id)
			if (Math.random() < 0.5) {
				await sleep(irnd(1000, 3000))
				const r = await session.send(toJid, { text: styleText(vary(pick(WRONG_SORRY)), p) })
				if (r?.id) ids.push(r.id)
			}
			await sleep(irnd(1500, 4000))
		} catch {}
		return ids
	}

	// De vez en cuando cambia la info del perfil (cada 10–22 días) o la foto (cada 35–65 días, o si no tiene)
	async maybeProfileChange(snap) {
		if (!this.s.profiles || Math.random() > 0.3) return
		const now = Date.now()
		const cands = snap.list.filter(a => !a.grace && a.level !== 'red' && !a.restricted && !this.flagged(a.id) && !this.busyReal(a.id))
		for (const a of cands.sort(() => Math.random() - 0.5)) {
			if ((a.phase ?? 4) < 2 && this.profiles.get(a.id)?.picture !== false) continue // en las primeras fases solo se le pone foto si no tiene
			const log = this.profileLog[a.id] ||= {}
			const session = this.manager.sessions.get(a.id)
			if (now - (log.about || this.since(a)) > (10 + hash01(a.id, 41) * 12) * DAY) {
				const text = pick(ABOUTS.filter(x => x !== log.aboutText))
				await session.setProfileStatus(text)
				Object.assign(log, { about: now, aboutText: text })
				setJSON('warmup_profile', this.profileLog)
				this.profiles.set(a.id, { ...(this.profiles.get(a.id) || {}), about: true })
				this.lastActionAt = Date.now() + irnd(15, 40) * 1000
				return
			}
			const prof = this.profiles.get(a.id)
			const photoDue = (prof && prof.picture === false) || now - (log.photo || this.since(a)) > (35 + hash01(a.id, 42) * 30) * DAY
			if (this.s.media && photoDue && await hasFfmpeg()) {
				const used = new Set(Object.values(this.profileLog).map(x => x?.photoName).filter(Boolean))
				const img = pick(library.list().filter(f => f.kind === 'image' && !used.has(f.name)))
				if (!img) continue
				const jpeg = await toSquareJpeg(fs.readFileSync(path.join(MEDIA_DIR, img.name)))
				await session.setProfilePhoto(jpeg)
				Object.assign(log, { photo: now, photoName: img.name })
				setJSON('warmup_profile', this.profileLog)
				this.profiles.set(a.id, { ...(prof || {}), picture: true })
				this.snap = null
				this.lastActionAt = Date.now() + irnd(15, 40) * 1000
				return
			}
		}
	}

	// Tus números se guardan como contactos entre sí (después de haber platicado), con el nombre que les pusiste
	async maybeSaveContact(snap) {
		if (!this.s.contacts || Math.random() > 0.6) return
		const now = Date.now()
		const cands = []
		for (const a of snap.list) {
			if ((a.phase ?? 4) < 1 || this.busyReal(a.id)) continue
			for (const b of snap.list) {
				if (b.id === a.id || !this.lastPair(a.id, b.id)) continue
				const k = `${a.id}>${b.id}`
				const st = this.saved[k]
				if (st?.ok || (st && now - st.at < 3 * DAY)) continue
				cands.push([a, b, k])
			}
		}
		const c = pick(cands)
		if (!c) return
		const [a, b, k] = c
		try {
			await this.manager.sessions.get(a.id).saveContact(jidOf(b.phone), b.name || this.names.get(b.id)?.first || 'Contacto')
			this.saved[k] = { at: now, ok: true }
		} catch (e) { this.saved[k] = { at: now, ok: false, error: String(e?.message || e).slice(0, 80) } }
		setJSON('warmup_contacts', this.saved)
		this.lastActionAt = Date.now() + irnd(10, 30) * 1000
	}
	// Cada número fija el chat con quien más platica de su familia o amigos (una vez)
	async maybePinChat(snap) {
		if (Math.random() > 0.25) return
		const a = pick(snap.list.filter(x => (x.phase ?? 4) >= 2 && !this.pinned[x.id] && !this.busyReal(x.id)))
		if (!a) return
		const close = snap.list.filter(b => b.id !== a.id && ['familia', 'amigos'].includes(relOf(a.id, b.id)) && this.lastPair(a.id, b.id))
			.sort((x, y) => this.lastPair(a.id, y.id) - this.lastPair(a.id, x.id))[0]
		if (!close) return
		try { await this.manager.sessions.get(a.id).pinChat(this.chatJid(a.id, close.phone), true); this.pinned[a.id] = { at: Date.now(), peer: close.id } }
		catch { this.pinned[a.id] = { at: Date.now(), failed: true } }
		setJSON('warmup_pinned', this.pinned)
	}
	// A veces alguien silencia el grupo unas horas, como cuando hay mucho mensaje
	async maybeMuteGroup(snap) {
		const g = this.group()
		if (!g || Math.random() > 0.05) return
		const d = dayKey()
		const m = pick(snap.list.filter(x => g.members.includes(x.id) && (this.muted[x.id] == null || d - this.muted[x.id] >= 3) && (x.phase ?? 4) >= 2))
		if (!m) return
		this.muted[m.id] = d
		await this.manager.sessions.get(m.id).muteChat(g.jid, irnd(2, 8) * 36e5)
	}

	// Reporte semanal (lunes después de las 9): cuánto subió la madurez y cuáles ya están listos
	weeklyReport(snap) {
		const { h, wd } = tzNow()
		const wk = String(Math.floor(dayKey() / 7))
		if (wd !== 1 || h < 9 || getJSON('warmup_report', null) === wk || !snap.list.length) return
		setJSON('warmup_report', wk)
		const rows = snap.list.map(a => ({ a, d: this.weekDelta(a.id, a.mature.score) }))
		const up = rows.filter(r => r.d > 0).length
		const ready = snap.list.filter(a => a.mature.score >= 70).map(a => a.name)
		const best = rows.filter(r => r.d > 0).sort((x, y) => y.d - x.d)[0]
		sendPush({
			title: '📈 Reporte semanal del calentamiento',
			body: `${up} de ${snap.list.length} números subieron de madurez.${best ? ` El que más: ${best.a.name} (+${best.d}).` : ''} Listos para masivos: ${ready.length ? ready.join(', ') : 'ninguno aún'}.`,
			url: '/#/settings'
		})
	}

	// Cuándo lee y cuándo contesta, según qué tan despierto está y qué tan rápido suele contestar
	replyTiming(a, hour, wd) {
		const w = this.awake(a, hour, wd)
		const pace = (a.persona?.pace || 1) * (this.hot() ? 0.5 : 1)
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
		this.nextConvoAt = Date.now() + clamp(gapMin, this.hot() ? 1.5 : 4, 120) * MIN
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
