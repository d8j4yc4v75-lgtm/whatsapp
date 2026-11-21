// «Vida simulada» para el calentamiento: cada número es una persona con nombre, cumpleaños y relaciones
// (familia, amigos, trabajo, conocidos) con los demás. Las relaciones deciden cuándo y de qué platican,
// y hay historias que duran varios días («¿comemos el jueves?» → el jueves «ya llegué» → «gracias por la comida»).
import { hash01 } from './warmup-scripts.js'

const FIRST = ['Juan', 'María', 'Carlos', 'Ana', 'Luis', 'Sofía', 'Jorge', 'Laura', 'Miguel', 'Fernanda', 'José', 'Daniela', 'Alejandro', 'Gabriela',
	'Ricardo', 'Paola', 'Fernando', 'Karla', 'Roberto', 'Mariana', 'Eduardo', 'Valeria', 'Arturo', 'Claudia', 'Raúl', 'Andrea', 'Óscar', 'Lucía',
	'Héctor', 'Diana', 'Iván', 'Mónica', 'Sergio', 'Adriana', 'Pablo', 'Verónica', 'Manuel', 'Patricia', 'Diego', 'Rocío']
const LAST = ['García', 'Hernández', 'Martínez', 'López', 'González', 'Pérez', 'Rodríguez', 'Sánchez', 'Ramírez', 'Cruz', 'Flores', 'Gómez', 'Morales',
	'Vázquez', 'Reyes', 'Jiménez', 'Torres', 'Díaz', 'Gutiérrez', 'Ruiz', 'Mendoza', 'Aguilar', 'Ortiz', 'Castillo', 'Romero', 'Silva']

/** Nombre de persona para cada número (estable y sin repetir entre tus números) */
export function personaNames(ids) {
	const used = new Set()
	const out = new Map()
	for (const id of [...ids].sort((a, b) => a - b)) {
		let k = Math.floor(hash01(id, 51) * FIRST.length)
		while (used.has(k) && used.size < FIRST.length) k = (k + 1) % FIRST.length
		used.add(k)
		out.set(id, { first: FIRST[k], last: LAST[Math.floor(hash01(id, 52) * LAST.length)] })
	}
	return out
}

/** Día del año (0–364) en que «cumple años» cada número */
export const birthdayOf = id => Math.floor(hash01(id, 53) * 365)

// ---- Relaciones entre dos números ----
export const RELS = {
	familia: { label: 'Familia', color: '#FF2D55' },
	amigos: { label: 'Amigos', color: '#FF9500' },
	trabajo: { label: 'Trabajo', color: '#0A84FF' },
	conocidos: { label: 'Conocidos', color: '#8E8E93' }
}
export function relOf(a, b) {
	const h = hash01(Math.min(a, b), Math.max(a, b), 77)
	return h < 0.17 ? 'familia' : h < 0.47 ? 'amigos' : h < 0.77 ? 'trabajo' : 'conocidos'
}
/** Qué tanto platica una relación a esta hora: el trabajo en horario laboral, la familia mañana y noche, los amigos tarde y fin de semana */
export function relWeight(rel, hour, wd) {
	const weekend = wd === 0 || wd === 6
	const work = !weekend && hour >= 9 && hour < 18
	if (rel === 'familia') return 1.5 * (hour >= 7 && hour < 10 ? 1.3 : hour >= 20 ? 1.4 : work ? 0.8 : 1)
	if (rel === 'amigos') return 1.3 * (weekend ? 1.5 : work ? 0.6 : hour >= 18 ? 1.5 : 1)
	if (rel === 'trabajo') return 1.1 * (work ? 1.8 : weekend ? 0.2 : 0.25)
	return 0.6
}

// Guiones según la relación (se suman a los generales)
export const REL_SCRIPTS = {
	trabajo: [
		{ when: 'work', lines: ['¿{Ya tienes|Me pasas} {el reporte|la lista|lo de ayer}?', '{Ya casi|En un rato te lo mando|Sí, ahorita te lo paso}', '{Va, gracias|Ok, sin prisa|Perfecto}'] },
		{ when: 'work', lines: ['¿A qué hora es la {junta|reunión} {de hoy|de mañana}?', '{A las 10|Como a las 12|A las 4}, ¿{vas a entrar|te conectas}?', '{Sí, ahí estaré|Sí, ahí nos vemos|Llego un poco tarde}', '{Va|Ok} {👍|}'] },
		{ when: 'work', lines: ['{Oye|Fíjate}, ¿{viste|leíste} el correo de {la jefa|Recursos Humanos|administración}?', '{Sí, qué rollo|Todavía no, ¿qué dice?|Ahorita lo veo}', '{Que cambian el horario|Lo del pago de la quincena|Que hay que entregar lo del mes}', '{Ah, ok|Va, gracias por avisar|Uff} {😅|}'] },
		{ when: 'work', lines: ['¿{Vas a ir|Irás} a la oficina {mañana|el lunes}?', '{Sí|No, trabajo desde casa|Todavía no sé}, ¿{y tú|tú}?', '{Yo sí|Yo también|Yo no}', '{Va|Ok, ahí nos vemos}'] },
		{ when: 'work', lines: ['{Ya llegó|Ya está} {el cliente|el proveedor|la entrega}', '{Va, voy para allá|Ok, ahorita bajo|Perfecto, gracias}'] },
		{ lines: ['¿{Mañana|El viernes} {se trabaja|abrimos} normal?', '{Sí, normal|Creo que sí|Medio día nada más}', '{Ok, gracias|Va} {👍|}'] }
	],
	familia: [
		{ when: 'morning', greets: true, lines: ['{Buenos días|Buen día} {❤️|☀️|}, ¿{cómo amaneciste|cómo dormiste}?', '{Bien|Muy bien|Con sueño} {jaja|}, ¿y tú?', '{Bien también|Aquí andamos} {🙏|}', '{Qué bueno|Que tengas buen día} {❤️|}'] },
		{ lines: ['¿{Ya llegaste|Llegaste bien}?', '{Sí, ya llegué|Ya, gracias|Apenas voy llegando} {🙏|}', '{Qué bueno|Ok} {❤️|}'] },
		{ lines: ['¿{Vienes a comer|Vas a venir a comer} {el domingo|mañana|hoy}?', '{Sí|Creo que sí|No puedo, perdón}, ¿{qué vas a hacer|qué hay de comer}?', '{Mole|Pozole|Enchiladas|Carne asada} {😋|}', '{Uy, ahí estaré|Guárdame tantito} {jaja|😋}'] },
		{ lines: ['¿Ya {fuiste por|recogiste a} {los niños|tu hermano|la abuela}?', '{Sí, ya|Voy en camino|Todavía no, ahorita voy}', '{Ok|Va, me avisas}'] },
		{ when: 'night', lines: ['¿{Ya cenaste|Ya estás en casa}?', '{Sí|Ya, gracias|Apenas voy}', '{Ok, descansa|Buenas noches} {❤️|😴|}'] },
		{ lines: ['{Me dijo|Dice} {mi mamá|tu tía|la abuela} que {le marques|te manda saludos}', '{Ok, ahorita le marco|Salúdamela mucho|Gracias, al rato le hablo}', '{Va|Ok} {❤️|}'] }
	],
	amigos: [
		{ when: 'afternoon', lines: ['¿{Qué haces|Qué planes} {hoy|en la noche}?', '{Nada|Aquí en la casa|Trabajando todavía} {jaja|}, ¿por?', '{Para ver si salimos|Para ir por unos tacos|Para ver el partido}', '{Va, avísame|Sale, ¿a qué hora?|Hoy no puedo, otro día} {🙌|}'] },
		{ when: 'weekend', lines: ['¿{Carne asada|Reunión} {el sábado|el domingo}?', '{Va|Obvio|Sale}, ¿{dónde|en tu casa}?', '{En mi casa|Donde siempre|En casa de {Luis|Ana|Jorge}}', '{Ahí nos vemos|Llevo algo} {🍻|🥩|}'] },
		{ lines: ['{Jajaja|Jsjs} ¿{viste|ya viste} lo que {subió|publicó} {Luis|Ana|Jorge|Paola}?', '{Sí|Nooo}, {qué oso|estuvo buenísimo|no lo he visto} {😂|}', '{Luego te enseño|Está buenísimo} {jaja|😂}'] },
		{ lines: ['{Préstame|Pásame} {la contraseña|tu cuenta} {de Netflix|de Spotify|del streaming} {jaja|porfa}', '{Jaja|Ok}, {ahorita te la paso|ni modo|nomás no le cambies nada}', '{Gracias|Eres la mejor persona} {😂|🙌|}'] },
		{ lines: ['¿{Vas al gym|Vas a correr} {hoy|mañana}?', '{Sí|No creo|A ver si me animo} {💪|😅|}', '{Va, ahí nos vemos|Ánimo|Yo tampoco jaja}'] }
	],
	conocidos: [
		{ lines: ['{Hola|Buenas}, ¿{todo bien|cómo va todo}?', '{Todo bien|Bien, gracias}, ¿{y tú|tú}?', '{Bien|Todo bien} {👍|}'] }
	]
}

// Reenviar algo que le mandaron en otro chat («Mira lo que me mandaron»)
export const FORWARD_SCRIPTS = [
	{ forward: true, lines: [{ media: 'forward', fallback: '{Mira esto|Checa esto} {jaja|}' }, '{Mira lo que me mandaron|Me llegó esto} {😂|jaja|}', '{Jajaja|No manches|Qué buena} {😂|}'] }
]

// Encuestas en el grupo
export const GROUP_POLLS = [
	{ name: '¿Qué día nos vemos?', values: ['Viernes', 'Sábado', 'Domingo'] },
	{ name: '¿Qué pedimos?', values: ['Pizza', 'Tacos', 'Sushi', 'Hamburguesas'] },
	{ name: '¿A qué hora?', values: ['6 pm', '7 pm', '8 pm'] },
	{ name: '¿Quién va a la carne asada?', values: ['Yo sí', 'No puedo', 'A lo mejor'] },
	{ name: '¿Qué película vemos?', values: ['Acción', 'Comedia', 'Terror'] }
]
export function pollConvo(poll) {
	const opt = poll.values[Math.floor(Math.random() * poll.values.length)]
	return [{ media: 'poll', poll, fallback: poll.name }, `{Yo|Voto por|Yo digo} ${opt}`, '{Yo también|Igual|Va}', `{Va, entonces|Quedamos en} ${opt} {👍|🙌|}`]
}

// Respuestas a estados de tus otros números
export const STATUS_REPLIES = ['{Qué bonito|Qué padre} {😍|}', '{Jajaja|Jaja} {😂|}', '¿Dónde es eso?', '{Qué rico|Se ve bien} {😋|}', '{Uff|Wow} {🔥|}', '{Me encanta|Qué bien} {❤️|}']
export const STATUS_ANSWERS = ['{Jaja sí|Gracias} {😊|}', '¿{Verdad|Verdad que sí}? {jaja|}', '{En {Puebla|el centro|casa de mi tía}|Cerca de mi casa}', '{Gracias|Jaja} {🙌|}']

// Felicitaciones de cumpleaños
export const BIRTHDAY = n => [`¡Feliz cumpleaños${n ? ` ${n}` : ''}! {🎉|🎂|🥳} {Que te la pases increíble|Que cumplas muchos más|Un abrazo enorme}`, '¡Muchas gracias! {🙏|❤️|😊}', '{Disfrútalo|Pásatela bien} {🎉|}']
export const BIRTHDAY_GROUP = n => [`¡Feliz cumpleaños ${n}! {🎂|🎉|🥳}`, '{¡Feliz cumple!|¡Felicidades!} {🎉|🥳|}', '¡Gracias a todos! {❤️|🙏|}']

// ---- Historias de varios días ----
const PLACES = ['Puebla', 'Querétaro', 'Guanajuato', 'la playa', 'Acapulco', 'Oaxaca', 'Monterrey', 'Veracruz', 'Valle de Bravo', 'San Miguel']
const DAYS = ['el domingo', 'el lunes', 'el martes', 'el miércoles', 'el jueves', 'el viernes', 'el sábado']
// at: momento de cada paso — 'now', o relativo al evento: 'event', 'event-2h', 'event+4h', 'event+1d'…
export const ARCS = [
	{
		key: 'comida', rels: ['amigos', 'trabajo', 'familia'], days: [1, 3], hour: [13, 15],
		steps: [
			{ at: 'now', lines: ['¿{Comemos|Vamos a comer} {DIA}?', '{Va|Sale|Claro}, ¿a qué hora?', '{Como a las|Tipo} {HORA}, ¿te parece?', '{Perfecto|Va}, ahí nos vemos {👍|}'] },
			{ at: 'event-2h', starter: 'b', lines: ['¿Sigue en pie lo de hoy?', '{Sí, claro|Sí, ahí nos vemos|Sí, nomás que llego 10 min tarde}', '{Va|Perfecto} {👍|}'] },
			{ at: 'event', starter: 'b', lines: ['{Ya llegué|Ya estoy aquí} {🙌|}', '{Voy en 5|Ya casi llego|Ya te vi}'] },
			{ at: 'event+20h', starter: 'a', lines: ['{Gracias por la comida de ayer|Qué buena comida ayer} {😋|}', '{Igual|A ti}, {se repite|hay que repetirlo} {🙌|}'] }
		]
	},
	{
		key: 'paquete', rels: ['amigos', 'familia'], days: [2, 3], hour: [11, 18],
		steps: [
			{ at: 'now', lines: ['Ya te mandé {el paquete|la caja|lo que te dije}', '{Gracias|Va, gracias}, ¿cuándo llega?', '{En unos dos días|Dicen que {DIA}|Esta semana}', '{Va, te aviso|Ok, te aviso cuando llegue}'] },
			{ at: 'event-1d', starter: 'a', lines: ['¿Ya te llegó {el paquete|la caja}?', '{Todavía no|Aún no} {😕|}', '{Ahorita reviso la guía|Ok, a ver mañana}'] },
			{ at: 'event', starter: 'b', lines: ['Ya llegó {el paquete|la caja}, {gracias|muchas gracias} {🙌|}', '{Qué bueno|Perfecto} {👍|}'] }
		]
	},
	{
		key: 'doctor', rels: ['familia', 'amigos'], days: [1, 2], hour: [9, 12],
		steps: [
			{ at: 'now', lines: ['{DIA} tengo {cita con el doctor|que ir al dentista|que hacerme unos estudios}', '{Suerte|Que te vaya bien}, ¿{es algo grave|todo bien}?', '{No, nada grave|Es revisión de rutina|Ya te contaré}', '{Va, me cuentas|Ok, me avisas} {🙏|}'] },
			{ at: 'event+4h', starter: 'b', lines: ['¿Cómo te fue {con el doctor|en el dentista|en tus estudios}?', '{Bien, nada grave|Bien, todo salió bien|Me mandaron medicina, pero bien}', '{Qué bueno|Me da gusto} {🙏|🙌|}'] }
		]
	},
	{
		key: 'viaje', rels: ['familia', 'amigos'], days: [2, 4], hour: [9, 11],
		steps: [
			{ at: 'now', lines: ['{DIA} {nos vamos|me voy} a {LUGAR} {🎉|😎|}', '{Qué padre|Qué envidia|Llévame} {jaja|😂|}, ¿cuántos días?', '{Nomás el fin|Tres días|Unos días}', '{Diviértete|Que les vaya bien|Manda fotos} {🙌|}'] },
			{ at: 'event+6h', starter: 'a', lines: [{ media: 'image', caption: '{Mira qué bonito|Aquí andamos} {😎|}', fallback: '{Aquí andamos|Ya llegamos} {😎|}' }, '{Qué bonito|Qué padre|Disfruta} {😍|🙌|}'] },
			{ at: 'event+3d', starter: 'b', lines: ['¿Qué tal {el viaje|te fue en {LUGAR}}?', '{Muy bien|Increíble|Cansado pero bien} {jaja|}', '{Qué bueno|Me alegra} {🙌|}'] }
		]
	},
	{
		key: 'partido', rels: ['amigos'], days: [1, 3], hour: [17, 20], weekendEvent: true,
		steps: [
			{ at: 'now', lines: ['¿{Vas a ver|Verás} el partido {DIA}?', '{Claro|Obvio|Si me da tiempo}', '{Va, luego comentamos|Ya veremos quién gana} {⚽|}'] },
			{ at: 'event+2h', starter: 'a', lines: ['{Qué partidazo|Qué mal partido|Qué robo} {⚽|😂|😡}', '{Sí, verdad|Ni me digas|Estuvo increíble} {jaja|}'] }
		]
	},
	{
		key: 'reporte', rels: ['trabajo'], days: [1, 2], hour: [10, 12], weekdayEvent: true,
		steps: [
			{ at: 'now', lines: ['¿Me {pasas|mandas} el {reporte|pendiente|archivo} {DIA}?', '{Sí, claro|Va, te lo mando|Sí, en la mañana}', '{Gracias|Perfecto}'] },
			{ at: 'event', starter: 'b', lines: ['{Ya te mandé|Te acabo de mandar} el {reporte|archivo} {👍|}', '{Gracias|Recibido}, {lo reviso|ahorita lo veo}'] },
			{ at: 'event+3h', starter: 'a', lines: ['{Ya lo revisé, todo bien|Todo bien con el reporte} {👌|}', '{Perfecto|Va, gracias}'] }
		]
	}
]

/**
 * Arma una historia con fechas reales: el día del evento, la hora y el lugar quedan fijos en todos los pasos.
 * sodTs: inicio del día de hoy (hora de México); wdToday: día de la semana de hoy.
 */
export function buildArc(arc, sodTs, wdToday, now = Date.now()) {
	let offset = arc.days[0] + Math.floor(Math.random() * (arc.days[1] - arc.days[0] + 1))
	const wdOf = o => (wdToday + o) % 7
	if (arc.weekendEvent) { while (![0, 6].includes(wdOf(offset)) && offset < 7) offset++ }
	if (arc.weekdayEvent) { while ([0, 6].includes(wdOf(offset)) && offset < 7) offset++ }
	const hour = arc.hour[0] + Math.floor(Math.random() * (arc.hour[1] - arc.hour[0] + 1))
	const half = Math.random() < 0.35 ? 30 : 0
	const eventAt = sodTs + offset * 864e5 + hour * 36e5 + half * 60000
	const dia = offset === 1 ? 'mañana' : offset === 2 && Math.random() < 0.4 ? 'pasado mañana' : DAYS[wdOf(offset)]
	const h12 = hour > 12 ? hour - 12 : hour
	const slots = { DIA: dia, HORA: `${h12}${half ? ':30' : ''}`, LUGAR: PLACES[Math.floor(Math.random() * PLACES.length)] }
	const fill = l => {
		const f = t => t.replace(/\{(DIA|HORA|LUGAR)\}/g, (m, k) => slots[k]).replace(/^([a-záéíóú])/, c => (t.startsWith('{DIA}') ? c.toUpperCase() : c))
		return typeof l === 'string' ? f(l) : { ...l, caption: l.caption ? f(l.caption) : l.caption, fallback: l.fallback ? f(l.fallback) : l.fallback }
	}
	const when = at => {
		if (at === 'now') return now
		const m = at.match(/^event([+-]\d+)?([hd])?$/)
		const n = m?.[1] ? Number(m[1]) : 0
		return eventAt + n * (m?.[2] === 'd' ? 864e5 : 36e5)
	}
	return {
		key: arc.key,
		steps: arc.steps.map(s => ({ at: when(s.at), starter: s.starter || 'a', event: s.at.startsWith('event'), lines: s.lines.map(fill) })),
		eventAt
	}
}
