// Copia de las reglas del asistente de WhatsApp (server/src/smart.js), sin base de datos.
// Entiende lo que contesta el cliente por correo: pagó, promesa, negociar, queja, baja…
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
	const raw = String(text || '').replace(/(\d)[,.](?=\d{3}\b)/g, '$1') // 1,500 → 1500
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

// Solo lo nuevo que escribió el cliente: sin el correo citado de abajo
export function freshText(text) {
	const t = String(text || '')
	const m = t.match(/^\s*>|^\s*(El|On)\b[^\n]{0,300}(\n[^\n]{0,200})?(escribi[oó]|wrote)\s*:|^-{2,}\s*(Mensaje original|Original Message|Forwarded)|^_{5,}\s*$|^\s*(De|From):\s.+\n\s*(Enviado|Sent|Fecha|Date):/im)
	return (m ? t.slice(0, m.index) : t).trim().slice(0, 2000)
}

// Avisos de «no se pudo entregar» (rebotes)
export function isBounce({ from_addr, subject }) {
	return /mailer-daemon|postmaster|mail-daemon|mailerdaemon/i.test(from_addr || '')
		|| /(mail delivery (failed|failure|subsystem)|delivery status notification|undeliver(able|ed)|returned mail|delivery (has )?failed|failure notice|message not delivered|no se (pudo|ha podido) entregar|error de entrega|notificaci[oó]n de estado de (la )?entrega|mensaje no entregado)/i.test(subject || '')
}
