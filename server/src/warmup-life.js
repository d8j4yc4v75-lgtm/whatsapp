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

// ---- Generador de charlas ----
// Banco de preguntas y respuestas por tema: arma charlas distintas cada vez (pregunta → respuesta → «¿y tú?» →
// comentario → otro tema → despedida). Con las variantes {a|b} salen miles de combinaciones.
const QA = [
	{ q: ['¿Qué haces?', '¿Qué andas haciendo?', '¿En qué andas?'], a: ['Nada, aquí {en la casa|descansando|viendo la tele}', 'Trabajando {todavía|un rato más} {😩|}', 'Haciendo {de comer|limpieza|unos pendientes}', 'Aquí {con los niños|en la calle|en el súper}'], r: ['{Ah, ok|Ya veo|Va} {jaja|}', '{Qué bien|Tranquilo entonces}'] },
	{ q: ['¿Cómo va tu día?', '¿Qué tal tu día?', '¿Cómo te ha ido hoy?'], a: ['{Pesado|Tranquilo|Bien, gracias|Largo} {jaja|😅|}', 'Ahí va, {con mucho trabajo|tranquilo|sin novedades}'], r: ['{Ánimo|Ya mero acaba} {💪|}', '{Qué bueno|Bien} {🙌|}'] },
	{ q: ['¿Cómo has estado?', '¿Qué tal todo?', '¿Cómo te va?'], a: ['{Bien, gracias|Muy bien|Ahí la llevo} {🙌|}', '{Todo bien|Tranquilo}, {con trabajo|sin novedades}'], r: ['{Qué bueno|Me da gusto} {🙌|}'] },
	{ q: ['¿Qué cuentas?', '¿Qué hay de nuevo?', '¿Novedades?'], a: ['Pues nada nuevo, {lo mismo de siempre|todo tranquilo}', '{Nada|Poca cosa} {jaja|}, aquí trabajando'], r: ['{Igual aquí|Jaja igual} {😅|}', '{Ok|Va} {jaja|}'], back: false },
	{ when: 'morning', q: ['¿Cómo amaneciste?', '¿Qué tal dormiste?'], a: ['{Bien|Con sueño|Cansado} {jaja|😴|}', '{Muy bien|Bien, gracias} {☀️|}'], r: ['{Ánimo|A darle} {☕|💪|}', '{Qué bueno|Igual yo} {jaja|}'] },
	{ when: 'morning', q: ['¿Ya desayunaste?', '¿Qué desayunaste?'], a: ['{Sí, unos chilaquiles|Nomás un café|Todavía no|Un pan con café} {☕|}'], r: ['{Qué rico|Provecho} {😋|}', '{Desayuna bien|Igual yo} {jaja|}'] },
	{ when: 'lunch', q: ['¿Ya comiste?', '¿Qué comiste?', '¿Qué hay de comer?'], a: ['{Tacos|Pozole|Una torta|Comida corrida|Pollo|Enchiladas|Sopa de fideo|Milanesa} {😋|}', 'Todavía no, {ahorita voy|en un rato|ando ocupado}'], r: ['{Qué rico|Provecho|Se me antojó} {🤤|😋|}'] },
	{ when: 'night', q: ['¿Qué cenaste?', '¿Ya cenaste?'], a: ['{Unos tacos|Pan con café|Quesadillas|Nada todavía|Cereal} {jaja|}'], r: ['{Qué rico|Provecho} {😋|}', '{Jaja|Igual yo}'] },
	{ q: ['¿Cómo está el clima por allá?', '¿Hace calor por allá?', '¿Está lloviendo por allá?'], a: ['{Hace mucho calor|Está nublado|Está lloviendo|Hace frío|Está bonito} {☀️|🌧️|🥶|}'], r: ['{Aquí igual|Aquí está soleado|Uff} {jaja|}'] },
	{ when: 'afternoon', q: ['¿Ya llegaste a tu casa?', '¿Ya saliste?'], a: ['{Ya|Apenas voy|Todavía no, hay mucho tráfico} {🚗|}'], r: ['{Va, con cuidado|Ok, avísame|Qué bueno} {🙏|}'], back: false },
	{ q: ['¿Hubo mucho tráfico?', '¿Cómo estuvo el tráfico?'], a: ['{Horrible|Normal|Nada, llegué rápido} {😩|}'], r: ['{Uff|Qué bueno|Ni modo}'] },
	{ when: 'work', q: ['¿Mucho trabajo hoy?', '¿Cómo va la chamba?'], a: ['{Uff, bastante|Tranquilo|Normal, lo de siempre} {😅|}'], r: ['{Ánimo|Ya casi es viernes} {💪|😅|}'] },
	{ when: 'work', q: ['¿A qué hora sales hoy?', '¿Sales temprano hoy?'], a: ['{A las 6|Como a las 7|Tarde, hay mucho pendiente}'], r: ['{Ok|Va}, {ánimo|ya falta poco}'] },
	{ when: 'weekend', q: ['¿Qué vas a hacer el fin?', '¿Planes para el fin?'], a: ['{Nada, descansar|Ir con mi familia|Ver el fútbol|Salir a pasear} {😴|⚽|}'], r: ['{Qué bien|Buen plan|Igual yo} {🙌|}'] },
	{ q: ['¿Saliste ayer?', '¿Qué hiciste ayer?'], a: ['{No, me quedé en casa|Fuimos a cenar|Nada, descansar|Fui con mi familia}'], r: ['{Qué bien|Buen plan} {jaja|}'] },
	{ rel: ['familia', 'amigos'], q: ['¿Cómo sigues de {la gripa|la tos|lo de tu espalda}?', '¿Ya te sientes mejor?'], a: ['{Mejor, gracias|Ya casi bien|Todavía un poco mal}'], r: ['{Cuídate|Que te mejores|Qué bueno} {🙏|}'], back: false },
	{ q: ['¿Dónde compraste {tus tenis|el cel|esa chamarra}?', '¿Cuánto te costó {el cel|tu chamarra}?'], a: ['{En el centro|Por internet|En una tienda cerca de mi casa}', '{Como 800|No me acuerdo|Estaba en oferta}'], r: ['{Ah, ok|Están padres|Gracias}'], back: false },
	{ q: ['¿Fuiste al súper?', '¿Ya fuiste al mandado?'], a: ['{Sí, ya|Al rato voy|No, mañana}'], r: ['{Va|Ok} {👍|}'] },
	{ q: ['¿Ya viste que {subieron los precios|cambió WhatsApp|salió el nuevo iPhone}?', '¿Supiste lo de {la gasolina|las lluvias|la luz}?'], a: ['{Sí, qué caro|No, no sabía|Sí, ya vi} {😩|}'], r: ['{Uff|Ni modo|Así está todo} {😅|}'], back: false },
	{ rel: ['familia', 'amigos'], q: ['¿Cómo está tu {perrito|gato}?'], a: ['{Bien, latoso como siempre|Durmiendo todo el día|Bien, ya lo llevé al veterinario}'], r: ['{Jaja|Qué bueno} {🐶|🐱|}'], back: false },
	{ rel: ['familia'], q: ['¿Cómo les fue a los niños en la escuela?', '¿Ya salieron los niños de la escuela?'], a: ['{Bien|Les dejaron mucha tarea|Ya salieron}'], r: ['{Qué bueno|Uff, la tarea} {jaja|}'], back: false },
	{ rel: ['amigos'], q: ['¿Viste el partido?', '¿Viste el gol de anoche?'], a: ['{Sí, qué partidazo|No, me lo perdí|Sí, estuvo malísimo} {⚽|}'], r: ['{Jaja|Ni me digas|Estuvo bueno} {😂|}'] },
	{ rel: ['amigos', 'familia'], q: ['¿Qué estás viendo ahorita?', '¿Qué serie estás viendo?'], a: ['{Una serie coreana|Nada, puro YouTube|Una de policías|Las noticias}'], r: ['{Ah, la voy a buscar|Pásame el nombre|Jaja}'] },
	{ when: 'night', q: ['¿Ya te vas a dormir?', '¿Sigues despierto?'], a: ['{Ya casi|Todavía no|Sí, ya estoy cansado} {😴|}'], r: ['{Descansa|Buenas noches} {🌙|}'], back: false },
	{ when: 'monday', q: ['¿Qué tal el lunes?', '¿Cómo va el lunes?'], a: ['{Pesado|Ni me digas|Tranquilo para ser lunes} {😩|}'], r: ['{Ánimo|Ya pasará} {💪|}'] }
]
const BACK = ['¿Y tú?', '¿Tú qué tal?', '¿Y tú qué?', '¿Y tú cómo vas?']
const TRANS = ['{Oye|Por cierto|Oye, otra cosa|Ah, oye}']
const REACT = ['{Ah, ok|Va|Qué bien|Jaja} {👍|}']
const CLOSE_A = ['{Bueno, te dejo|Va, luego hablamos|Sale, cuídate|Bueno, ahí nos vemos} {👋|}']
const CLOSE_B = ['{Va|Igual|Bye|Cuídate} {👋|🙌|}']
const pickOne = arr => arr[Math.floor(Math.random() * arr.length)]
/** Arma una charla nueva; las líneas se alternan entre los dos números (A, B, A, B…) */
export function generateConvo({ rel = null, mo = {}, name = null } = {}) {
	const pool = QA.filter(t => (!t.when || mo[t.when]) && (!t.rel || !rel || t.rel.includes(rel)))
	const t1 = pickOne(pool)
	const lines = []
	let greets = false
	let open = ''
	if (Math.random() < 0.5) {
		open = mo.morning && Math.random() < 0.3 ? '{Buenos días|Buen día}' : rel === 'trabajo' ? '{Hola|Buen día}' : '{Hola|Qué onda|Buenas|Hey}'
		if (name && Math.random() < 0.4) open += ` ${name}`
		open += '||'
		greets = true
	}
	lines.push(open + pickOne(t1.q))
	const askBack = t1.back !== false && Math.random() < 0.45
	lines.push(pickOne(t1.a) + (askBack ? `||${pickOne(BACK)}` : ''))
	if (askBack) { lines.push(pickOne(t1.a)); lines.push(pickOne(t1.r || REACT)) }
	else lines.push(pickOne(t1.r || REACT))
	if (Math.random() < 0.4) {
		const t2 = pickOne(pool.filter(x => x !== t1))
		if (t2) { lines.push(`${pickOne(TRANS)}||${pickOne(t2.q)}`); lines.push(pickOne(t2.a)); lines.push(pickOne(t2.r || REACT)) }
	}
	if (Math.random() < 0.45) { lines.push(pickOne(CLOSE_A)); lines.push(pickOne(CLOSE_B)) }
	return { lines, greets }
}

// ---- Grupos por tipo: familia, trabajo y amigos ----
export const GROUP_KINDS = {
	amigos: { names: ['Los de siempre', 'La banda', 'Compas ⚽', 'Amigos 🍻', 'Los cuates'], rel: 'amigos' },
	familia: { names: ['Familia 🏡', 'Familia ❤️', 'Los primos', 'La familia'], rel: 'familia' },
	trabajo: { names: ['Equipo de trabajo 💼', 'Oficina', 'Pendientes 📋', 'Equipo ventas'], rel: 'trabajo' }
}
export const GROUP_KIND_SCRIPTS = {
	trabajo: [
		{ when: 'work', lines: ['{Buenos días|Buen día} equipo {☀️|💪|}', '{Buenos días|Buen día} {👋|}', '{Buen día|Igualmente} {🙌|}'] },
		{ when: 'work', lines: ['¿A qué hora es la junta {de hoy|de mañana}?', '{A las 10|A las 12|A las 4}', '{Gracias|Va}', '{Ahí estaré|Ok} {👍|}'] },
		{ when: 'work', lines: ['Recuerden {mandar el reporte|subir lo del mes|llenar el formato} {antes del viernes|hoy|mañana}', '{Va|Enterado|Ok} {👍|}', '{Ya lo mandé|Al rato lo subo}'] },
		{ when: 'work', lines: ['¿Alguien tiene {el archivo|la lista|el número} de {proveedores|clientes|la junta}?', '{Yo lo tengo, ahorita lo paso|Déjame buscar}', '{Gracias|Te lo encargo}'] },
		{ lines: ['{Mañana|El viernes} {no hay junta|salimos temprano|es día de pago} {🎉|💸|}', '{Excelente|Qué bien|Por fin} {🙌|}', '{Jaja sí|Ya era hora} {😂|}'] }
	],
	familia: [
		{ when: 'morning', lines: ['{Buenos días|Buen día} familia {☀️|❤️|}', '{Buenos días|Buen día} {❤️|🙏|}', '{Buen día a todos|Bendiciones} {🙏|}'] },
		{ lines: ['¿Quién viene a comer el domingo?', '{Yo|Nosotros} {sí vamos|llegamos como a las 2}', '{Yo también|Yo creo que sí}', '{Va, hago {mole|pozole|carne asada}|Perfecto, los espero} {😋|❤️|}'] },
		{ lines: ['¿Ya vieron {la foto|el video} que mandó {la tía|mi mamá|el primo}?', '{Jaja sí|Qué bonito|Ahorita lo veo} {😂|❤️|}', '{Está buenísimo|Qué grandes están los niños} {😍|}'] },
		{ when: 'weekend', lines: ['{Feliz domingo|Feliz fin de semana} familia {❤️|🙏|}', '{Igualmente|Igual} {❤️|}', '{Bendiciones|Descansen} {🙏|}'] },
		{ lines: ['¿Cómo sigue {la abuela|mi tío|mi mamá}?', '{Mejor, gracias a Dios|Ya está mejor|Ahí va}', '{Qué bueno|Gracias a Dios} {🙏|}'] }
	],
	amigos: [
		{ lines: ['¿Qué onda con el sábado?', '{Yo puedo|Yo sí voy|Yo hasta la noche}', '{Va, ¿dónde?|¿A qué hora?}', '{En mi casa|Donde siempre} {🍻|}'] },
		{ lines: ['{Jajaja|Jsjs} {miren esto|ya vieron esto} {😂|}', '{Jajaja|No manches} {😂|🤣}', '{Estoy llorando|Qué buena} {😂|}'] }
	]
}
export const GROUP_KIND_POLLS = {
	familia: [{ name: '¿Qué hacemos el domingo?', values: ['Comida en casa', 'Salir a comer', 'Ir al parque'] }, { name: '¿Qué llevamos?', values: ['Postre', 'Refrescos', 'Tortillas'] }],
	trabajo: [{ name: '¿A qué hora la junta?', values: ['10 am', '12 pm', '4 pm'] }, { name: '¿Qué día entregamos?', values: ['Jueves', 'Viernes', 'Lunes'] }]
}
/** Qué tanto platica cada tipo de grupo a esta hora */
export const groupWeight = (kind, hour, wd) => relWeight(GROUP_KINDS[kind]?.rel || 'amigos', hour, wd)

// ---- Tarjetas generadas (imágenes tipo «Buenos días») ----
const pk = arr => arr[Math.floor(Math.random() * arr.length)]
const CARD_SUBS = {
	morning: ['Que tengas un excelente día', 'Dios te bendiga', 'A darle con todo', 'Bendiciones para hoy', 'Que todo te salga bien', 'Sonríe, hoy es un gran día'],
	night: ['Que descanses', 'Dios te cuide', 'Hasta mañana', 'Que sueñes bonito'],
	blessing: ['Para ti y tu familia', 'Dios te cuide hoy y siempre', 'Que nunca te falte nada'],
	weekend: ['A disfrutar en familia', 'Descansa y disfruta', 'Te lo ganaste'],
	birthday: ['Que cumplas muchos más', 'Que Dios te bendiga', 'Pásala increíble', 'Con mucho cariño']
}
/** Qué dice y de qué color es una tarjeta, según el tipo, el día y la hora */
export function cardSpec(kind, { name = '', wd = 1, holiday = null } = {}) {
	if (kind === 'holiday' && holiday) return { title: holiday.title, subtitle: holiday.sub, palette: holiday.palette }
	if (kind === 'birthday') return { title: `Feliz cumpleaños${name ? ` ${name}` : ''}`, subtitle: pk(CARD_SUBS.birthday), palette: pk(['amor', 'morado', 'oro']) }
	if (kind === 'night') return { title: pk(['Buenas noches', 'Dulces sueños', 'Descansa']), subtitle: pk(CARD_SUBS.night), palette: pk(['noche', 'morado']) }
	if (kind === 'weekend') return { title: wd === 5 ? pk(['Feliz viernes', 'Feliz fin de semana']) : wd === 0 ? pk(['Feliz domingo', 'Feliz fin de semana']) : 'Feliz fin de semana', subtitle: pk(CARD_SUBS.weekend), palette: pk(['cielo', 'verde', 'oro']) }
	if (kind === 'blessing') return { title: 'Bendiciones', subtitle: pk(CARD_SUBS.blessing), palette: pk(['oro', 'cielo', 'rosa']) }
	const title = wd === 1 && Math.random() < 0.5 ? 'Feliz lunes' : wd === 5 && Math.random() < 0.5 ? 'Feliz viernes' : pk(['¡Buenos días!', 'Buenos días', 'Feliz día'])
	return { title, subtitle: pk(CARD_SUBS.morning), palette: pk(['amanecer', 'cielo', 'oro', 'verde', 'rosa']) }
}
/** Texto del sticker según lo que iba a contestar */
export function stickerTextFor(line, hour = 12) {
	const t = String(line).toLowerCase()
	if (/ja|😂|🤣|jsjs/.test(t)) return pk(['Jajaja', 'JAJAJA', 'Me muero', 'XD'])
	if (/gracias/.test(t)) return pk(['Gracias', 'Mil gracias'])
	if (/noche|dorm|descans/.test(t) || hour >= 22) return pk(['Buenas noches', 'A dormir'])
	if (/buenos d|buen d/.test(t)) return 'Buenos días'
	if (/ánimo|animo|fuerza|💪/.test(t)) return pk(['Ánimo', 'Tú puedes', 'Fuerza'])
	if (/❤️|abrazo|quiero/.test(t)) return pk(['Un abrazo', 'Te quiero'])
	return pk(['Ok', 'Va', 'Sale', 'Okis', 'Listo', 'Ni modo', 'Órale'])
}

// Más guiones con tarjetas (se suman a los de cada relación y tipo de grupo)
REL_SCRIPTS.familia.push(
	{ when: 'morning', lines: [{ media: 'card', card: 'morning', fallback: '{Buenos días|Buen día} {☀️|❤️}' }, '{Buenos días|Buen día} {🙏|❤️|☀️|}', '{Que tengas bonito día|Bendiciones} {🙏|}'] },
	{ when: 'night', lines: [{ media: 'card', card: 'night', fallback: 'Buenas noches {🌙|}' }, '{Buenas noches|Descansa} {🙏|😴|}'] }
)
REL_SCRIPTS.amigos.push({ when: 'weekend', lines: [{ media: 'card', card: 'weekend', fallback: '¡Feliz fin de semana! {🎉|}' }, '{Igualmente|Igual} {🍻|🙌|}'] })
GROUP_KIND_SCRIPTS.familia.push({ when: 'morning', lines: [{ media: 'card', card: 'morning', fallback: '{Buenos días|Buen día} familia ☀️' }, '{Buenos días|Buen día} {❤️|🙏}', '{Buen día a todos|Bendiciones} {🙏|}'] })
GROUP_KIND_SCRIPTS.amigos.push({ when: 'weekend', lines: [{ media: 'card', card: 'weekend', fallback: '¡Feliz fin de semana! 🍻' }, '{Igualmente|Igual} {🍻|🎉}', '{A disfrutar|Descansen} {😎|}'] })

// ---- Fechas especiales de México ----
const MD_FMT = new Intl.DateTimeFormat('en-US', { timeZone: process.env.TZ_CAMPAIGNS || 'America/Mexico_City', month: 'numeric', day: 'numeric', weekday: 'short' })
const HOLIDAYS = [
	{ m: 1, d: 1, key: 'anionuevo', title: '¡Feliz Año Nuevo!', sub: 'Que este año venga lleno de bendiciones', palette: 'oro', greet: ['¡Feliz Año Nuevo! {🎉|🥂|🎆} {Que te vaya increíble este año|Un abrazo|Lo mejor para ti y tu familia}'], reply: ['¡Igualmente! {🎉|🙏|❤️} {Feliz año|Un abrazo}'] },
	{ m: 2, d: 14, key: 'amistad', title: 'Feliz día del amor y la amistad', sub: 'Gracias por tu amistad', palette: 'amor', greet: ['¡Feliz día del amor y la amistad! {❤️|🌹|🤗}'], reply: ['¡Igualmente! {❤️|🤗}'] },
	{ m: 4, d: 30, key: 'nino', title: 'Feliz Día del Niño', sub: 'Que nunca se nos quite lo niño', palette: 'cielo', greet: ['¡Feliz día del niño! {🎈|🧸|😄} {jaja|}'], reply: ['{Jaja|Gracias}, ¡igualmente! {🎈|}'] },
	{ m: 5, d: 10, key: 'madres', title: 'Feliz Día de las Madres', sub: 'Con todo el cariño', palette: 'rosa', greet: ['¡Feliz día de las madres! {🌹|💐|❤️} Un abrazo para tu mamá', '¿Ya felicitaste a tu mamá? {🌹|💐}'], reply: ['¡Gracias! {❤️|🙏} Igualmente para la tuya', 'Sí, ya fuimos a comer con ella {❤️|}'] },
	{ fathers: true, key: 'padres', title: 'Feliz Día del Padre', sub: 'Gracias por todo', palette: 'cielo', greet: ['¡Feliz día del padre! {👔|🍻|🙌}', '¿Ya felicitaste a tu papá? {👔|}'], reply: ['¡Gracias! {🙌|🙏}', 'Sí, hoy comemos con él {🍻|}'] },
	{ m: 9, d: 15, key: 'patrias', title: '¡Viva México!', sub: 'Felices fiestas patrias', palette: 'mexico', greet: ['¡Viva México! {🇲🇽|🎉} ¿Qué van a cenar?', '¡Felices fiestas patrias! {🇲🇽|}'], reply: ['¡Viva! {🇲🇽|} {Pozole|Tostadas|Enchiladas} {😋|}'] },
	{ m: 9, d: 16, key: 'patrias', title: '¡Viva México!', sub: 'Felices fiestas patrias', palette: 'mexico', greet: ['¡Felices fiestas patrias! {🇲🇽|🎉}'], reply: ['¡Igualmente! {🇲🇽|} ¿Viste el desfile?'] },
	{ m: 11, d: 2, key: 'muertos', title: 'Día de Muertos', sub: 'Recordando a los que ya no están', palette: 'oro', greet: ['¿Ya pusieron su ofrenda? {🕯️|🌼}', '¿Van a ir al panteón? {🌼|}'], reply: ['{Sí, ya quedó|Hoy la ponemos|Sí, con pan de muerto} {🕯️|🌼}'] },
	{ m: 12, d: 12, key: 'guadalupe', title: 'Felicidades a todas las Lupitas', sub: 'Día de la Virgen de Guadalupe', palette: 'cielo', greet: ['¿Van a ir a la Villa? {🙏|🌹}'], reply: ['{No, aquí desde casa|Sí, en la mañana|Este año no} {🙏|}'] },
	{ m: 12, d: 24, key: 'nochebuena', title: 'Feliz Nochebuena', sub: 'Que la pasen bonito en familia', palette: 'navidad', greet: ['¡Feliz Nochebuena! {🎄|⭐|❤️}'], reply: ['¡Igualmente! {🎄|🙏} Pásala bonito'] },
	{ m: 12, d: 25, key: 'navidad', title: '¡Feliz Navidad!', sub: 'Paz y amor en tu hogar', palette: 'navidad', greet: ['¡Feliz Navidad! {🎄|🎅|❤️} Un abrazo'], reply: ['¡Feliz Navidad! {🎄|🙏}'] },
	{ m: 12, d: 31, key: 'finanio', title: 'Feliz fin de año', sub: 'Gracias por todo este año', palette: 'oro', greet: ['¡Feliz fin de año! {🥂|🎆} Que te vaya muy bien en el año nuevo'], reply: ['¡Igualmente! {🥂|🎉} Un abrazo'] }
]
/** La fecha especial de hoy (o null) */
export function holidayOf(t = Date.now()) {
	const p = {}
	for (const x of MD_FMT.formatToParts(new Date(t))) p[x.type] = x.value
	const m = Number(p.month), d = Number(p.day)
	// Día del Padre: tercer domingo de junio
	if (m === 6 && p.weekday === 'Sun' && d >= 15 && d <= 21) return HOLIDAYS.find(h => h.fathers)
	return HOLIDAYS.find(h => h.m === m && h.d === d) || null
}
