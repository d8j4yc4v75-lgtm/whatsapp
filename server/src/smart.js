import { db } from './db.js'

// Asistente: entiende lo que contesta el cliente y actúa solo.
// - Queja / amenaza de denuncia → no volver a escribirle en masivos, etiqueta y aviso.
// - Pide baja o número equivocado → no volver a escribirle en masivos y etiqueta.
// - Dice que ya pagó → etiqueta «Pagó» y quita los recordatorios de promesa.
// - Promete pagar → etiqueta «Promesa de pago» y recordatorio el día que dijo.
// - Pide datos de pago o quiere negociar → etiqueta para atenderlo pronto.
// Funciona con reglas en español de México (sin servicios externos).

const TZ_OFFSET_H = Number(process.env.TZ_OFFSET_HOURS || -6) // México centro (sin horario de verano)

export const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[¿?¡!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim()

const PAY_VERB = '(pago|deposito|transfiero|abono|liquido|cubro|pagare|depositare|transferire|abonare|hago el (pago|deposito)|mando el (pago|deposito)|voy a (pagar|depositar|abonar|transferir|liquidar))'
const WHEN = '(hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|(la )?(proxima|siguiente) semana|quincena|fin de mes|el \\d{1,2}|dia \\d{1,2}|en la tarde|en la noche|al rato|mas tarde|en (\\d+|un|una|dos|tres|cuatro|cinco) dias?)'

// El orden importa: lo más delicado primero
const RULES = [
	['queja', /\b(acoso|acosando|acosar|hostig\w*|denunci\w*|demand\w*|condusef|profeco|redeco|reportar\w*|reporte|amenaz\w*|extorsi\w*|fraude|estafa\w*|policia|abogado|ministerio publico)\b/],
	['baja', /^(baja|stop|alto|no molestar)$|\b(ya no me (escriban|escribas|manden|mandes|envien|molesten|marquen|busquen)|dejen de (escribir\w*|mandar\w*|molestar\w*|marcar\w*)|no me (escriban|escribas|molesten|vuelvan a escribir|manden mensajes)|(eliminen|borren) mi numero|darme de baja|me doy de baja)\b/],
	['equivocado', /\b(numero equivocado|esta equivocad\w*|se equivoc\w*|equivocacion|no soy (yo|esa persona|el|ella|quien busca\w*)|no conozco a|no lo conozco|no la conozco|no se quien es|aqui no vive|no vive aqui|no es mi (deuda|cuenta)|no tengo ninguna deuda|yo no tengo deuda|yo no saque)\b/],
	['pagado', /\b(ya (le |te |les )?(pague|deposite|transferi|liquide|abone|cubri|salde|realice el pago|hice el (pago|deposito)|quedo pagado|esta pagado|quedo liquidado)|pago realizado|(ya )?(te|le) (mande|envie) el comprobante|(aqui|ahi) (esta|va|le va|te va) el comprobante|adjunto (el )?comprobante)\b/],
	['promesa', new RegExp(`\\b(${PAY_VERB}\\b.*\\b${WHEN}\\b|\\b${WHEN}\\b.*\\b${PAY_VERB}\\b|cuando me paguen|en cuanto me paguen)`)],
	['datos_pago', /\b(a que cuenta|numero de cuenta|clabe|donde (le |te )?(deposito|pago)|datos (para (pagar|depositar)|de pago|bancarios|de la cuenta)|como (le |te )?(pago|deposito)|referencia de pago|en que banco|me (pasa|pasas|da|das) (la cuenta|los datos))\b/],
	['negociar', /\b(descuento|no (puedo|alcanzo a) pagar (todo|eso|tanto)|en partes|pagos? (chiquitos|pequenos|parciales)|abonos|convenio|plazos|mensualidades|quita|cuanto es lo menos)\b/]
]

export function classify(text) {
	const t = norm(text)
	if (!t) return null
	for (const [intent, re] of RULES) if (re.test(t)) return intent
	return null
}

// Qué etiqueta y color se pone según lo que contestó
export const INTENTS = {
	queja: { label: 'Queja', color: '#FF3B30', tag: '⚠️ Queja' },
	baja: { label: 'Pidió baja', color: '#8E8E93', tag: '🚫 Pidió baja' },
	equivocado: { label: 'Número equivocado', color: '#FF2D55', tag: '❓ Número equivocado' },
	pagado: { label: 'Pagó', color: '#25D366', tag: '💰 Dice que ya pagó' },
	promesa: { label: 'Promesa de pago', color: '#FF9500', tag: '🤝 Promete pagar' },
	datos_pago: { label: 'Pide datos de pago', color: '#0A84FF', tag: '🏦 Pide datos de pago' },
	negociar: { label: 'Quiere negociar', color: '#AF52DE', tag: '💬 Quiere negociar' }
}

// ---- Fecha prometida ----
const WEEKDAYS = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 }
const NUM = { un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 }

// "Hoy" en México: año, mes, día y día de la semana
function mxToday(now = Date.now()) {
	const d = new Date(now + TZ_OFFSET_H * 3600e3)
	return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours() }
}
// Hora local de México → marca de tiempo
const mxTime = (y, m, d, h) => Date.UTC(y, m, d, h) - TZ_OFFSET_H * 3600e3
const lastDayOf = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

/** Devuelve { at, text } con el día que el cliente dijo que paga (a las 10 am; si es hoy, a las 6 pm) */
export function promisedDate(text, now = Date.now()) {
	const t = norm(text)
	const today = mxToday(now)
	let addDays = null
	let day = null
	if (/\bpasado manana\b/.test(t)) addDays = 2
	else if (/\bmanana\b/.test(t)) addDays = 1
	else if (/\b(hoy|al rato|mas tarde|en la tarde|en la noche)\b/.test(t)) addDays = 0
	else {
		const n = t.match(/\ben (\d+|un|una|dos|tres|cuatro|cinco) dias?\b/)
		if (n) addDays = Number(n[1]) || NUM[n[1]] || null
	}
	if (addDays === null) {
		const w = t.match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/)
		if (w) addDays = (WEEKDAYS[w[1]] - today.wd + 7) % 7
	}
	if (addDays === null && /\b(proxima|siguiente) semana\b/.test(t)) addDays = ((1 - today.wd + 7) % 7) || 7
	if (addDays === null) {
		const dm = t.match(/\b(?:el|dia) (\d{1,2})\b/)
		if (dm && Number(dm[1]) >= 1 && Number(dm[1]) <= 31) day = Number(dm[1])
		else if (/\bquincena\b|cuando me paguen|en cuanto me paguen/.test(t)) day = today.d < 15 ? 15 : lastDayOf(today.y, today.m)
		else if (/\bfin de mes\b/.test(t)) day = lastDayOf(today.y, today.m)
	}
	let y = today.y, m = today.m, d
	if (addDays !== null) {
		const base = new Date(Date.UTC(today.y, today.m, today.d + addDays))
		y = base.getUTCFullYear(); m = base.getUTCMonth(); d = base.getUTCDate()
	} else if (day !== null) {
		if (day < today.d) { m += 1; if (m > 11) { m = 0; y += 1 } }
		d = Math.min(day, lastDayOf(y, m))
	} else return null
	const isToday = y === today.y && m === today.m && d === today.d
	const at = mxTime(y, m, d, isToday ? Math.max(18, today.h + 2) : 10)
	const label = new Date(at).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'America/Mexico_City' })
	return { at, text: isToday ? 'hoy' : label }
}

// ---- Acciones automáticas ----
const setting = key => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value
export const smartEnabled = () => setting('smart') !== '0'
export function setSmartEnabled(on) { db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('smart', ?)").run(on ? '1' : '0') }

try { db.exec('ALTER TABLE messages ADD COLUMN intent TEXT') } catch {}

function ensureLabel(name, color) {
	const row = db.prepare('SELECT id FROM labels WHERE lower(name) = lower(?)').get(name)
	if (row) return row.id
	return Number(db.prepare('INSERT INTO labels (name, color) VALUES (?, ?)').run(name, color).lastInsertRowid)
}
function addLabel(key, intent) {
	const { label, color } = INTENTS[intent]
	db.prepare('INSERT OR IGNORE INTO conversation_labels (jid, label_id, at) VALUES (?, ?, ?)').run(key, ensureLabel(label, color), Date.now())
}
function optOut(phone) {
	db.prepare('INSERT OR REPLACE INTO optouts (phone, at) VALUES (?, ?)').run(String(phone).replace(/\D/g, ''), Date.now())
}

/**
 * Se llama con cada mensaje que escribe un cliente (no grupos). Devuelve la intención detectada.
 * key = "cuenta:jid" de la conversación.
 */
export function smartIncoming({ accountId, jid, msgId, text }) {
	if (!smartEnabled() || !text) return null
	const intent = classify(text)
	if (!intent) return null
	const key = `${accountId}:${jid}`
	const phone = jid.split('@')[0]
	db.prepare('UPDATE messages SET intent = ? WHERE account_id = ? AND id = ?').run(intent, accountId, msgId)
	addLabel(key, intent)
	if (intent === 'queja' || intent === 'baja' || intent === 'equivocado') optOut(phone)
	if (intent === 'pagado') {
		// Ya pagó: los recordatorios de su promesa ya no hacen falta
		db.prepare("UPDATE reminders SET done = 1 WHERE conv_key = ? AND done = 0 AND text LIKE '🤖%'").run(key)
	}
	if (intent === 'promesa') {
		const p = promisedDate(text)
		if (p) {
			const reminderText = `🤖 Prometió pagar ${p.text}: «${String(text).slice(0, 120)}»`
			const existing = db.prepare("SELECT id FROM reminders WHERE conv_key = ? AND done = 0 AND text LIKE '🤖%'").get(key)
			if (existing) db.prepare('UPDATE reminders SET at = ?, text = ? WHERE id = ?').run(p.at, reminderText, existing.id)
			else db.prepare('INSERT INTO reminders (conv_key, at, text, created_at) VALUES (?, ?, ?, ?)').run(key, p.at, reminderText, Date.now())
			// Nota automática solo si no tienes una tuya
			const note = db.prepare('SELECT text FROM conversation_notes WHERE conv_key = ?').get(key)
			if (!note || note.text.startsWith('🤖')) {
				db.prepare('INSERT OR REPLACE INTO conversation_notes (conv_key, text, updated_at) VALUES (?, ?, ?)').run(key, `🤖 Prometió pagar ${p.text}`, Date.now())
			}
		}
	}
	return intent
}

// ---- Hora local del cliente según su lada (México) ----
const LADA_TZ = [
	[/^(664|665|686|646|661|616|658)/, 'America/Tijuana'], // Baja California
	[/^(612|613|615|624)/, 'America/Mazatlan'], // Baja California Sur
	[/^(662|644|631|642|653|622|623|632|633|634|637|638|641|643|645|647)/, 'America/Hermosillo'], // Sonora
	[/^(667|668|669|672|673|687|694|696|697|698)/, 'America/Mazatlan'], // Sinaloa
	[/^(311|319|323|324|325|327|389)/, 'America/Mazatlan'], // Nayarit
	[/^656/, 'America/Ciudad_Juarez'], // Ciudad Juárez
	[/^(998|984|983|987)/, 'America/Cancun'] // Quintana Roo
]
export function zoneFor(phone) {
	const digits = String(phone || '').replace(/\D/g, '')
	if (!digits.startsWith('52')) return null
	const national = digits.replace(/^521?/, '').slice(-10)
	for (const [re, zone] of LADA_TZ) if (re.test(national)) return zone
	return 'America/Mexico_City'
}
export function localHour(phone, now = Date.now()) {
	const zone = zoneFor(phone) || 'America/Mexico_City'
	try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now))) % 24 }
	catch { return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', hour: 'numeric', hourCycle: 'h23' }).format(new Date(now))) % 24 }
}
/** ¿Es buena hora para escribirle a este cliente? Su hora local dentro del horario del envío y del horario legal (7 a 22 h) */
export function goodLocalTime(phone, startHour, endHour, now = Date.now()) {
	const h = localHour(phone, now)
	if (h < 7 || h >= 22) return false
	if (startHour <= endHour) return h >= startHour && h < endHour
	return true
}

