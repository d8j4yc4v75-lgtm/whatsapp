import { db } from './db.js'

// Corrector de texto local (sin servicios externos ni IA).
// Corrige acentos, abreviaturas, signos y mayúsculas; y propone una versión más cordial.

const setting = key => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value
const TZ_OFFSET_H = Number(process.env.TZ_OFFSET_HOURS || -6)

export const correctorStatus = () => ({ review: setting('ai_review') !== '0' })
export function correctorSave({ review }) {
	if (typeof review === 'boolean') db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('ai_review', ?)").run(review ? '1' : '0')
	return correctorStatus()
}

// Palabras sin ambigüedad (siempre se escriben así)
const WORDS = {
	q: 'que', k: 'que', ke: 'que', xq: 'porque', pq: 'porque', porq: 'porque', xk: 'porque',
	tmb: 'también', tb: 'también', tmbn: 'también', tambien: 'también', tambn: 'también',
	xfa: 'por favor', xfavor: 'por favor', porfa: 'por favor', porfavor: 'por favor', pls: 'por favor', plis: 'por favor',
	ntp: 'no te preocupes', msj: 'mensaje', msjs: 'mensajes', bn: 'bien', grax: 'gracias', grs: 'gracias', graxias: 'gracias', grasias: 'gracias',
	ola: 'hola', aki: 'aquí', aqui: 'aquí', alla: 'allá', aya: 'allá', ahi: 'ahí', ai: 'ahí', asi: 'así', aver: 'a ver', osea: 'o sea',
	nose: 'no sé', enserio: 'en serio', atravez: 'a través', apesar: 'a pesar', nomas: 'nomás', dnd: 'donde', tqm: 'te quiero mucho',
	dia: 'día', dias: 'días', despues: 'después', ademas: 'además', todavia: 'todavía', quizas: 'quizás', segun: 'según',
	algun: 'algún', ningun: 'ningún', estan: 'están', estas: 'estás', rapido: 'rápido', rapida: 'rápida', facil: 'fácil', dificil: 'difícil',
	numero: 'número', numeros: 'números', telefono: 'teléfono', credito: 'crédito', creditos: 'créditos', ultimo: 'último', ultima: 'última',
	minimo: 'mínimo', maximo: 'máximo', unico: 'único', unica: 'única', pagina: 'página', util: 'útil', sabado: 'sábado', miercoles: 'miércoles',
	informacion: 'información', atencion: 'atención', situacion: 'situación', solucion: 'solución', opcion: 'opción', aclaracion: 'aclaración',
	cancelacion: 'cancelación', comunicacion: 'comunicación', direccion: 'dirección', razon: 'razón', ubicacion: 'ubicación', confirmacion: 'confirmación',
	podria: 'podría', podrias: 'podrías', podrian: 'podrían', tendria: 'tendría', habia: 'había', tenia: 'tenía', queria: 'quería',
	gustaria: 'gustaría', haria: 'haría', deberia: 'debería', manana: 'mañana', proxima: 'próxima', proximo: 'próximo',
	cuidate: 'cuídate', disculpa: 'disculpa', perdon: 'perdón', jamas: 'jamás', ahorita: 'ahorita'
}
// Interrogativos: llevan acento al iniciar una pregunta
const ASK = { que: 'qué', como: 'cómo', cuando: 'cuándo', donde: 'dónde', cuanto: 'cuánto', cuanta: 'cuánta', cuantos: 'cuántos', cuantas: 'cuántas', quien: 'quién', quienes: 'quiénes', cual: 'cuál', cuales: 'cuáles' }
const GREETING = /^(hola|buen[oa]s?|saludos|estimad[oa]|que tal|qué tal|hey|disculp\w*|perdon\w*|perdón)\b/i
const CLOSING = /(gracias|saludos|bonito d[ií]a|buen d[ií]a|excelente d[ií]a|quedo (al pendiente|atent[oa])|cu[ií]date|bendiciones)[.!]*\s*$/i

const isUrl = w => /^(https?:\/\/|www\.)|@|\.\w{2,}\//i.test(w)
const keepCase = (src, out) => src === src.toUpperCase() && src.length > 1 ? out.toUpperCase() : /^[A-ZÁÉÍÓÚÑ]/.test(src) ? out[0].toUpperCase() + out.slice(1) : out

function fixWords(line) {
	return line.split(/(\s+)/).map(tok => {
		if (!tok.trim() || isUrl(tok)) return tok
		return tok.replace(/[\p{L}]+/gu, w => {
			const r = WORDS[w.toLowerCase()]
			return r ? keepCase(w, r) : w.replace(/(\p{L})\1{2,}/gu, '$1') // holaaaa → hola
		})
	}).join('')
}

// Divide en oraciones conservando su signo final
const sentences = line => line.match(/[^.!?…]+[.!?…]*|[.!?…]+/g) || [line]

function fixSentence(s) {
	const lead = s.match(/^\s*/)[0]
	let body = s.slice(lead.length)
	if (!body) return s
	// «Hola que tal…» → «Hola, que tal…»
	body = body.replace(/^(hola|oye|disculpa|disculpe|perdón|buen[oa]s? (días|tardes|noches))\s+(?=\p{L})/iu, '$1, ')
	const end = body.match(/[?!]+\s*$/)?.[0]?.trim()
	if (end?.startsWith('?') && !body.includes('¿')) {
		// La pregunta empieza en el primer interrogativo al inicio de la oración o después de una coma
		const re = /(^|,\s*)(por que|porque|que tal|\p{L}+)\b/giu
		let at = -1, m
		while ((m = re.exec(body))) {
			const w = m[2].toLowerCase()
			if (ASK[w] || w === 'por que' || w === 'porque' || w === 'que tal') { at = m.index + m[1].length; break }
		}
		if (at < 0) at = 0
		let q = body.slice(at)
			.replace(/^(por que|porque)\b/i, m => keepCase(m, 'por qué'))
			.replace(/^(\p{L}+)/u, w => ASK[w.toLowerCase()] ? keepCase(w, ASK[w.toLowerCase()]) : w)
			.replace(/,\s*(por que|porque)\b/gi, (m, w) => ', ' + keepCase(w, 'por qué'))
		body = body.slice(0, at) + '¿' + q
	} else if (end?.startsWith('!') && !body.startsWith('¡')) body = '¡' + body
	body = body.replace(/^([¿¡]?)(\p{Ll})/u, (m, p, c) => p + c.toUpperCase())
	return lead + body
}

function fixLine(line) {
	if (!line.trim()) return line
	const urls = []
	let t = fixWords(line.replace(/\S*(https?:\/\/|www\.)\S+|\S+@\S+\.\S+/gi, u => `\u0000${urls.push(u) - 1}\u0000`))
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/\besta bien\b/gi, m => keepCase(m, 'está bien'))
		.replace(/\bya quedo\b/gi, m => keepCase(m, 'ya quedó'))
		.replace(/!{2,}/g, '!').replace(/\?{2,}/g, '?').replace(/([?!]){2,}/g, '$1').replace(/\.{4,}/g, '...').replace(/,{2,}/g, ',')
		.replace(/\s+([,.;:?!])/g, '$1')
		.replace(/([,;:])(?=[\p{L}])/gu, '$1 ')
		.replace(/([.?!])(?=[\p{Lu}¿¡])/gu, '$1 ')
		.replace(/\bi\b(?=\s)/g, 'y')
	t = t.replace(/(\p{L}) (gracias)\b/giu, (m, a, g, i, all) => /(muchas|mil|las|de|dar|doy|y)$/i.test(all.slice(0, i + 1).split(/\s/).pop() + '') ? m : `${a}, ${g}`)
	return sentences(t).map(fixSentence).join('').trim().replace(/\u0000(\d+)\u0000/g, (m, i) => urls[i])
}

export function correct(text) {
	const lines = String(text).replace(/\r/g, '').split('\n').map(fixLine)
	let out = lines.join('\n').trim()
	if (/[\p{L}\p{N})]$/u.test(out) && (out.split(/\s+/).length > 3 || /\n/.test(out))) out += '.'
	return out
}

function greeting(now = Date.now()) {
	const h = new Date(now + TZ_OFFSET_H * 3600e3).getUTCHours()
	return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'
}

const SHORT = [
	[/^(ok|oki|okey|okay|va|sale|vale|ta bien|está bien|de acuerdo)[.!]?$/i, 'De acuerdo, muchas gracias.'],
	[/^(s[ií]|simon|sip|claro)[.!]?$/i, 'Sí, claro.'],
	[/^(gracias|muchas gracias|mil gracias)[.!]?$/i, '¡Muchas gracias! Que tenga un excelente día.'],
	[/^(no te preocupes|no se preocupe)[.!]?$/i, 'No se preocupe, con gusto.'],
	[/^(un momento|espera|esp[eé]rame|deja (ver|checo|reviso))[.!]?$/i, 'Permítame un momento, por favor.'],
	[/^(listo|ya qued[oó]|hecho)[.!]?$/i, 'Listo, ya quedó. Gracias por su paciencia.']
]

export function improve(text, { greet = true } = {}) {
	let t = correct(text)
	for (const [re, out] of SHORT) if (re.test(t)) return out
	t = t.replace(/\bno te preocupes\b/gi, m => keepCase(m, 'no se preocupe'))
		.replace(/\bporfa\b/gi, 'por favor')
	if (greet && !GREETING.test(t.replace(/^[¿¡]/, ''))) t = `${greeting()}. ${t}`
	const asks = /\?\s*$/.test(t)
	if (!asks && !CLOSING.test(t)) {
		if (!/[.!?…]$/.test(t)) t += '.'
		t += /\b(pag\w*|deposit\w*|transfer\w*|abon\w*|saldo|cuenta)\b/i.test(t) ? '\nQuedo al pendiente, gracias.' : '\nGracias, saludos.'
	} else if (!/[.!?…]$/.test(t)) t += '.'
	return t
}

export function rewrite({ text, accountId, jid }) {
	text = String(text || '').trim()
	if (!text) throw new Error('Escribe un mensaje')
	// Solo saluda si es el primer mensaje mío del día en ese chat
	let greet = true
	if (accountId && jid) {
		const last = db.prepare('SELECT ts FROM messages WHERE account_id = ? AND jid = ? AND from_me = 1 ORDER BY ts DESC LIMIT 1').get(Number(accountId), jid)
		if (last && Date.now() - last.ts < 6 * 3600e3) greet = false
	}
	return { original: text, corregido: correct(text), mejorado: improve(text, { greet }) }
}
