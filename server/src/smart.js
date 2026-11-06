import { db } from './db.js'
import { sendPush } from './push.js'

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
	['se_niega', /\b(no (voy|pienso|vamos) a pagar\w*|no (le|les|te) (debo|voy a pagar)|no (les|le|te) pienso (dar|pagar)|no reconozco (esa|la|ninguna) deuda|no pagare|no voy a dar (ni|nada))\b/],
	['pagado', /\b(ya (le |te |les )?(pague|deposite|transferi|liquide|abone|cubri|salde|realice el pago|hice el (pago|deposito)|quedo pagado|esta pagado|quedo liquidado)|pago realizado|(ya )?(te|le) (mande|envie) el comprobante|(aqui|ahi) (esta|va|le va|te va) el comprobante|adjunto (el )?comprobante)\b/],
	['promesa', new RegExp(`\\b(${PAY_VERB}\\b.*\\b${WHEN}\\b|\\b${WHEN}\\b.*\\b${PAY_VERB}\\b|cuando me paguen|en cuanto me paguen)`)],
	['sin_dinero', /\b(no tengo (dinero|lana|trabajo|con que|para pagar)|(me )?(quede|estoy) sin (trabajo|chamba|dinero|lana)|me (corrieron|despidieron)|estoy (desempleado|enfermo|enferma|hospitalizad\w*)|ando (corto|corta|sin lana|bajo de dinero)|no me alcanza|ahorita no (puedo|tengo)|situacion (dificil|complicada)|no he podido pagar)\b/],
	['datos_pago', /\b(a que cuenta|numero de cuenta|clabe|donde (le |te )?(deposito|pago)|datos (para (pagar|depositar)|de pago|bancarios|de la cuenta)|como (le |te )?(pago|deposito)|referencia de pago|en que banco|me (pasa|pasas|da|das) (la cuenta|los datos))\b/],
	['negociar', /\b(descuento|no (puedo|alcanzo a) pagar (todo|eso|tanto)|en partes|pagos? (chiquitos|pequenos|parciales)|abonos|convenio|plazos|mensualidades|quita|cuanto es lo menos)\b/],
	['saldo', /\b(cuanto (debo|le debo|les debo|es|seria|tengo que pagar)|de (que|donde) es (la|esa|esta) deuda|cual es mi (saldo|adeudo|deuda)|mi saldo|saldo pendiente|por que (les|le) debo|de que es)\b/]
]
// Enojo sin llegar a queja formal: se marca además de la intención principal
const ANGRY = /\b(ching\w*|pinche\w*|pendej\w*|cabron\w*|idiota\w*|estupid\w*|imbecil\w*|vergu?\w*|mierda|carajo|fastidi\w*|harto|harta|hartos|que (lata|molestia)|ya (basta|estuvo)|dejen de (chingar|joder|fregar)|no (sean|seas) (necios|necio|encajosos))\b/

export function classify(text) {
	const t = norm(text)
	if (!t) return null
	for (const [intent, re] of RULES) if (re.test(t)) return intent
	// «$1,500 el lunes», «te mando quinientos mañana»: monto + fecha también es promesa
	if (amountOf(text) && new RegExp(`\\b${WHEN}\\b`).test(t)) return 'promesa'
	return ANGRY.test(t) ? 'molesto' : null
}
export const isAngry = text => ANGRY.test(norm(text))

const WORDNUM = { cien: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400, quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900, mil: 1000 }
/** Monto que menciona el cliente: «$1,500», «500 pesos», «2 mil», «quinientos» */
export function amountOf(text) {
	const raw = String(text || '')
	const t = norm(raw.replace(/\$/g, ' $ '))
	let m = raw.match(/\$\s?(\d{1,3}(?:[,.]\d{3})+|\d+)(?:\.\d{1,2})?/)
	if (m) return Number(m[1].replace(/[,.]/g, ''))
	m = t.match(/\b(\d+(?:\.\d+)?)\s?(mil|k)\b/)
	if (m) return Math.round(Number(m[1]) * 1000)
	m = t.match(/\b(\d{1,3}(?:,\d{3})+|\d{2,6})\s?(pesos|varos|baros|mxn)\b/) || t.match(/\b(?:abono|abonar|deposito|depositar|pago|pagar|doy|dar|mando|transfiero|liquido|cubro)\w* (?:de |los |unos )?(\d{1,3}(?:,\d{3})+|\d{3,6})\b/)
	if (m) return Number(m[1].replace(/,/g, ''))
	m = t.match(/\b(cien|doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos|mil)( pesos)?\b/)
	if (m && (m[2] || /\b(pag|deposit|abon|transfer|doy|dar|mando)\w*/.test(t))) return WORDNUM[m[1]]
	return null
}
export const money = n => '$' + Number(n).toLocaleString('es-MX')

// Qué etiqueta y color se pone según lo que contestó
export const INTENTS = {
	queja: { label: 'Queja', color: '#FF3B30', tag: '⚠️ Queja' },
	baja: { label: 'Pidió baja', color: '#8E8E93', tag: '🚫 Pidió baja' },
	equivocado: { label: 'Número equivocado', color: '#FF2D55', tag: '❓ Número equivocado' },
	pagado: { label: 'Pagó', color: '#25D366', tag: '💰 Dice que ya pagó' },
	promesa: { label: 'Promesa de pago', color: '#FF9500', tag: '🤝 Promete pagar' },
	datos_pago: { label: 'Pide datos de pago', color: '#0A84FF', tag: '🏦 Pide datos de pago' },
	negociar: { label: 'Quiere negociar', color: '#AF52DE', tag: '💬 Quiere negociar' },
	se_niega: { label: 'Se niega a pagar', color: '#C0392B', tag: '✋ Se niega a pagar' },
	sin_dinero: { label: 'Sin dinero', color: '#A2845E', tag: '🪙 Dice que no tiene dinero' },
	saldo: { label: 'Pregunta saldo', color: '#5AC8FA', tag: '🧾 Pregunta su saldo' },
	molesto: { label: 'Molesto', color: '#FF6B35', tag: '😠 Está molesto' },
	incumplida: { label: 'Promesa incumplida', color: '#D9480F', tag: '⏰ Promesa incumplida' }
}

// Al detectar una intención se quitan las etiquetas que ya no aplican
const CLEARS = {
	pagado: ['promesa', 'incumplida', 'datos_pago', 'saldo', 'negociar', 'sin_dinero', 'se_niega'],
	promesa: ['se_niega', 'sin_dinero', 'saldo', 'negociar'],
	negociar: ['se_niega'],
	datos_pago: ['se_niega', 'saldo']
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
function removeLabel(key, intent) {
	db.prepare('DELETE FROM conversation_labels WHERE jid = ? AND label_id IN (SELECT id FROM labels WHERE lower(name) = lower(?))').run(key, INTENTS[intent].label)
}

// ---- Historial de promesas ----
db.exec(`CREATE TABLE IF NOT EXISTS promises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_key TEXT NOT NULL,
  at INTEGER NOT NULL,
  amount INTEGER,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_promises_conv ON promises (conv_key, status);`)
try { db.exec('ALTER TABLE messages ADD COLUMN suggestion TEXT') } catch {}

export function promiseHistory(key) {
	const rows = db.prepare('SELECT status, COUNT(*) n FROM promises WHERE conv_key = ? GROUP BY status').all(key)
	const c = Object.fromEntries(rows.map(r => [r.status, r.n]))
	return { total: rows.reduce((a, r) => a + r.n, 0), kept: c.kept || 0, broken: c.broken || 0, pending: c.pending || 0 }
}
const ord = n => n + 'ª'
const setBotNote = (key, text) => {
	const note = db.prepare('SELECT text FROM conversation_notes WHERE conv_key = ?').get(key)
	if (!note || note.text.startsWith('🤖')) db.prepare('INSERT OR REPLACE INTO conversation_notes (conv_key, text, updated_at) VALUES (?, ?, ?)').run(key, text, Date.now())
}

// ---- Respuesta sugerida (de usted, lista para editar) ----
function suggestionFor(intent, text, { date, amount, hist } = {}) {
	const t = norm(text)
	switch (intent) {
		case 'queja': return 'Lamento mucho la molestia. Tomamos nota de su comentario y no volveremos a enviarle mensajes masivos. Si desea revisar su cuenta, con gusto le atiendo por este medio.'
		case 'baja': return 'Listo, ya no le enviaremos más mensajes. Gracias.'
		case 'equivocado': return 'Una disculpa por la molestia. Corregimos nuestro registro y no volveremos a escribirle. Que tenga buen día.'
		case 'se_niega': return 'Entiendo. Con gusto le explico el detalle del adeudo y las opciones que tenemos para regularizarlo. ¿Le comparto la información?'
		case 'pagado': return /comprobante|adjunt/.test(t)
			? '¡Muchas gracias! Recibimos su comprobante; en cuanto se vea reflejado el pago se lo confirmo.'
			: '¡Gracias por su pago! ¿Me podría compartir su comprobante para registrarlo?'
		case 'promesa': {
			const what = `${amount ? `de ${money(amount)} ` : ''}${date ? (date === 'hoy' ? 'para hoy' : `para el ${date}`) : ''}`.trim()
			const again = hist?.broken ? ' Le pido de favor que esta vez se pueda cumplir para mantener su cuenta en orden.' : ''
			return `Perfecto, queda registrado su compromiso de pago${what ? ' ' + what : ''}.${again} Al realizarlo, por favor compártame su comprobante. ¡Gracias!`
		}
		case 'sin_dinero': return 'Entiendo su situación. Podemos buscar una opción que se ajuste a sus posibilidades, como pagos en partes. ¿Cuánto podría abonar y en qué fecha?'
		case 'datos_pago': return 'Con gusto, en un momento le comparto los datos para realizar su pago.'
		case 'negociar': return 'Claro, podemos revisar opciones. ¿Qué monto podría cubrir y en qué fecha? Con eso le propongo un plan.'
		case 'saldo': return 'Con gusto le comparto el detalle de su saldo. Permítame un momento.'
		case 'molesto': return 'Una disculpa si nuestros mensajes le causaron molestia. Mi intención es ayudarle a encontrar una solución. ¿Le parece si lo revisamos juntos?'
	}
	return null
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
	let intent = classify(text)
	if (!intent) return null
	const key = `${accountId}:${jid}`
	// «No les debo nada» después de pagar no es negarse a pagar
	if (intent === 'se_niega' && db.prepare('SELECT 1 FROM conversation_labels c JOIN labels l ON l.id = c.label_id WHERE c.jid = ? AND lower(l.name) = lower(?)').get(key, INTENTS.pagado.label)) return null
	const phone = jid.split('@')[0]
	const now = Date.now()
	addLabel(key, intent)
	for (const old of CLEARS[intent] || []) removeLabel(key, old)
	if (intent !== 'molesto' && isAngry(text)) addLabel(key, 'molesto')
	if (intent === 'queja' || intent === 'baja' || intent === 'equivocado') optOut(phone)
	const amount = amountOf(text)
	let extra = {}
	if (intent === 'pagado') {
		// Ya pagó: sus promesas quedan cumplidas y los recordatorios automáticos ya no hacen falta
		db.prepare("UPDATE promises SET status = 'kept', closed_at = ? WHERE conv_key = ? AND status = 'pending'").run(now, key)
		db.prepare("UPDATE reminders SET done = 1 WHERE conv_key = ? AND done = 0 AND text LIKE '🤖%'").run(key)
		const h = promiseHistory(key)
		setBotNote(key, `🤖 Dice que pagó${amount ? ' ' + money(amount) : ''} (${new Date(now).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'America/Mexico_City' })})${h.total ? ` · promesas: ${h.kept} cumplida(s), ${h.broken} incumplida(s)` : ''}`)
	}
	if (intent === 'promesa') {
		const p = promisedDate(text)
		// La promesa anterior que ya venció sin pago cuenta como incumplida
		const prev = db.prepare("SELECT id, at FROM promises WHERE conv_key = ? AND status = 'pending' ORDER BY at DESC").all(key)
		for (const r of prev) db.prepare("UPDATE promises SET status = ?, closed_at = ? WHERE id = ?").run(r.at < now ? 'broken' : 'replaced', now, r.id)
		if (p) {
			db.prepare('INSERT INTO promises (conv_key, at, amount, text, created_at) VALUES (?, ?, ?, ?, ?)').run(key, p.at, amount, String(text).slice(0, 300), now)
			const h = promiseHistory(key)
			const n = h.total - (db.prepare("SELECT COUNT(*) n FROM promises WHERE conv_key = ? AND status = 'replaced'").get(key).n)
			const what = `${amount ? money(amount) + ' ' : ''}${p.text}`
			const reminderText = `🤖 ${n > 1 ? ord(n) + ' promesa: ' : 'Prometió '}pagar ${what}${h.broken ? ` (${h.broken} incumplida${h.broken > 1 ? 's' : ''})` : ''}: «${String(text).slice(0, 120)}»`
			const existing = db.prepare("SELECT id FROM reminders WHERE conv_key = ? AND done = 0 AND text LIKE '🤖%'").get(key)
			if (existing) db.prepare('UPDATE reminders SET at = ?, text = ? WHERE id = ?').run(p.at, reminderText, existing.id)
			else db.prepare('INSERT INTO reminders (conv_key, at, text, created_at) VALUES (?, ?, ?, ?)').run(key, p.at, reminderText, now)
			setBotNote(key, `🤖 ${n > 1 ? ord(n) + ' promesa' : 'Promesa'}: pagar ${what}${h.broken ? ` · ${h.broken} incumplida${h.broken > 1 ? 's' : ''} antes` : ''}`)
			extra = { date: p.text, amount, hist: h }
		} else extra = { amount }
	}
	if (intent === 'negociar' || intent === 'sin_dinero') {
		if (amount) setBotNote(key, `🤖 Ofrece ${money(amount)}${intent === 'sin_dinero' ? ' (dice que no tiene dinero)' : ''}`)
	}
	const suggestion = suggestionFor(intent, text, extra)
	db.prepare('UPDATE messages SET intent = ?, suggestion = ? WHERE account_id = ? AND id = ?').run(intent, suggestion, accountId, msgId)
	return intent
}

// ---- Promesas vencidas: si pasó un día de la fecha y no dijo que pagó, se marca incumplida ----
export function checkBrokenPromises(now = Date.now()) {
	const due = db.prepare("SELECT * FROM promises WHERE status = 'pending' AND at < ?").all(now - 24 * 3600e3)
	for (const p of due) {
		db.prepare("UPDATE promises SET status = 'broken', closed_at = ? WHERE id = ?").run(now, p.id)
		removeLabel(p.conv_key, 'promesa')
		addLabel(p.conv_key, 'incumplida')
		const h = promiseHistory(p.conv_key)
		setBotNote(p.conv_key, `🤖 No cumplió su promesa${p.amount ? ' de ' + money(p.amount) : ''} · ${h.broken} incumplida${h.broken > 1 ? 's' : ''}, ${h.kept} cumplida${h.kept === 1 ? '' : 's'}`)
		const name = db.prepare('SELECT name FROM chats WHERE account_id = ? AND jid = ?').get(Number(p.conv_key.split(':')[0]), p.conv_key.slice(p.conv_key.indexOf(':') + 1))?.name
		try { sendPush({ title: `${INTENTS.incumplida.tag} · ${name || '+' + p.conv_key.split(':')[1].split('@')[0]}`, body: `No avisó su pago${p.amount ? ' de ' + money(p.amount) : ''}. Dale seguimiento.`, jid: p.conv_key }) } catch {}
	}
	return due.length
}
setInterval(() => { try { if (smartEnabled()) checkBrokenPromises() } catch {} }, 30 * 60e3).unref()

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

