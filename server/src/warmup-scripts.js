// Guiones, estados y "personalidad" de cada número para el calentamiento

// Número pseudoaleatorio estable entre 0 y 1 (mismo resultado para los mismos datos)
export const hash01 = (...nums) => { let h = 2166136261; for (const n of nums) { h ^= n; h = Math.imul(h, 16777619) } return (h >>> 0) / 4294967296 }

// Guiones 1 a 1: las líneas se alternan entre los dos números (A, B, A, B…).
// {a|b|c} = variantes; opciones vacías ({😅|}) a veces no ponen nada; "||" = dos mensajes seguidos.
// Una línea puede ser multimedia: { media: 'image' | 'audio' | 'location' | 'contact', caption, fallback }.
// when: morning (6–11), lunch (12–16), afternoon (16–20), night (21–2), monday, weekend (vie–dom).
// greets: el guion ya empieza saludando (no se le antepone "Buenas tardes").
export const SCRIPTS = [
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
	{ lines: ['{Oye|Fíjate} que {vi|me acordé de} {algo chistoso|una cosa curiosa|algo bien curioso} {jaja|😂}', '¿{Qué cosa|De qué}?', '{Luego te cuento|Al rato te digo} {jaja|}', '{Va|Ok, me dejas con la duda} {😂|}'] },
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
	{ weight: 0.25, lines: ['{Feliz cumpleaños|Felicidades}!! {🎂|🎉|🥳}', '{Muchas gracias|Gracias}!! {❤️|🙌|}'] },
	// ---- Con fotos, notas de voz, ubicación y contactos ----
	{ lines: ['¿Me {mandas|pasas} la foto {de ayer|que tomaste|que me dijiste}?', { media: 'image', caption: '{Ahí va|Esta|Mira|}', fallback: '{Ahorita te la mando|Al rato te la paso}' }, '{Qué bonita|Gracias|Salió bien|Quedó padre} {😍|🙌|👌|}'] },
	{ lines: [{ media: 'image', caption: '{Mira|Ve esto|Jaja mira} {😂|👀|}', fallback: '{Ahorita te mando una foto|Te debo una foto} {jaja|}' }, '{Jajaja|Qué buena|Nooo} {😂|🤣|}', '{Verdad|Jaja sí} {😂|}'] },
	{ lines: ['{Te mandé un audio|Escucha el audio cuando puedas}', { media: 'audio', fallback: '{Va, ahorita lo escucho|Ok, al rato lo oigo}' }, '{Ok|Va|Entendido}, {gracias|ahí te aviso}'] },
	{ lines: [{ media: 'audio', fallback: '{Oye, luego te marco|Te marco al rato}' }, '{Jaja va|Ok, ahorita lo veo|Va, gracias|Sale}', '{👍|Va}'] },
	{ lines: ['¿{Dónde estás|Dónde quedamos|Me pasas la ubicación}?', { media: 'location', fallback: '{En el centro|Ya casi llego|Aquí en la casa}' }, '{Va, voy para allá|Ok, llego en 15|Perfecto, gracias} {🚗|👍|}'] },
	{ lines: ['¿{Me pasas|Tienes} el número {del que me dijiste|de tu primo|de la señora}?', { media: 'contact', fallback: '{Ahorita te lo paso|Déjame buscarlo}' }, '{Gracias|Mil gracias|Va, le marco} {🙏|}'] }
]

// Charlas en el grupo de tus números: cada línea la dice alguien distinto al anterior
export const GROUP_SCRIPTS = [
	{ lines: ['{Buenos días|Buen día} {a todos|familia|gente} {☀️|}', '{Buenos días|Buen día} {🙌|☕|}', '{Buen día|Igualmente} {👋|}'] },
	{ lines: ['¿{Quién va|Quiénes van} {el sábado|mañana|al rato}?', '{Yo sí|Yo voy|Cuenten conmigo}', '{Yo no puedo|Yo creo que sí|A mí me falta ver}', '{Va|Ok}, {luego confirmamos|ahí nos vemos} {👍|}'] },
	{ lines: ['{Feliz fin de semana|Feliz viernes} {🎉|🍻|}', '{Igualmente|Igual} {🙌|}', '{Descansen|A disfrutar} {😎|}'], when: 'weekend' },
	{ lines: ['{Ya llegué|Ya estoy aquí} {🙌|}', '{Qué bueno|Perfecto}', '{Va|Ok} {👍|}'] },
	{ lines: ['¿{Alguien sabe|Saben} si {mañana hay|habrá} {clases|servicio|tráfico}?', '{Creo que sí|Ni idea|Yo escuché que no}', '{Yo también escuché eso|Hay que checar}', '{Gracias|Va, gracias} {🙏|}'] },
	{ lines: ['{Jajaja|Jaja} {miren esto|vean} {😂|🤣|}', '{Jajaja|Nooo} {😂|}', '{Jaja qué buena|Qué risa} {🤣|}'] },
	{ lines: ['{Buenas noches|Me voy a dormir} {😴|🌙|}', '{Descansen|Buenas noches}', '{Bonita noche|Igualmente} {🌙|}'], when: 'night' }
]
export const GROUP_NAMES = ['Familia 🏡', 'Los de siempre', 'Primos', 'Amigos ⚽', 'La banda', 'Compas', 'Equipo 💪', 'Vecinos']

// Estados (historias) de texto
export const STORY_TEXTS = [
	'{Buenos días|Buen día} {☀️|🌤️|} {Bendiciones|Excelente día} {🙏|}',
	'{Feliz|Bonito} {lunes|inicio de semana} {💪|}',
	'{Feliz viernes|Por fin viernes} {🎉|🙌|}',
	'{Agradecido|Agradecida} {por un día más|con la vida} {🙏|❤️|}',
	'{A darle con todo|Trabajando} {💪|🔥|}',
	'{Qué bonito día|Qué día tan bonito} {☀️|😊|}',
	'{Domingo de descanso|Domingo familiar} {😌|🏡|}',
	'{Todo pasa por algo|Paso a paso} {✨|🙏|}',
	'{Café y a trabajar|Primero el café} {☕|}'
]
export const STORY_COLORS = ['#128C7E', '#25D366', '#34B7F1', '#7C5CFF', '#FF6B6B', '#F4A261', '#2A9D8F', '#E76F51', '#264653']

export const REACTS = ['👍', '❤️', '😂', '🙌', '👌', '🔥', '😅', '🙏']
export const GREET = { morning: '{Buenos días|Buen día}', afternoon: '{Buenas tardes|Buenas}', night: '{Buenas noches|Buenas}' }
export const CONTACT_NAMES = ['Juan', 'Carlos', 'Luis', 'Miguel', 'Jorge', 'Ana', 'María', 'Laura', 'Sofía', 'Lupita', 'Don Pepe', 'Sra. Rosa', 'Toño', 'Paco']

// Convierte texto de "Guiones propios": cada charla separada por una línea en blanco, una línea por mensaje
export function parseCustom(text) {
	const out = []
	for (const block of String(text || '').split(/\r?\n\s*\r?\n/)) {
		const lines = block.split(/\r?\n/).map(l => l.trim().slice(0, 300)).filter(Boolean)
		if (lines.length >= 2) out.push({ lines: lines.slice(0, 10), custom: true })
		if (out.length >= 60) break
	}
	return out
}

// ---- Personalidad: cada número escribe a su manera (estable para siempre) ----
const LAUGHS = ['jaja', 'jajaja', 'jajaj', 'jsjs', 'JAJAJA', 'jeje', 'jajajaja']
export function persona(id) {
	const r = k => hash01(id, k)
	return {
		laugh: LAUGHS[Math.floor(r(11) * LAUGHS.length)],
		lower: r(12) < 0.3, // empieza en minúscula
		noAccent: r(13) < 0.2, // no pone acentos
		noInvQ: r(14) < 0.45, // no usa ¿ ni ¡
		emoji: Math.min(1, 0.35 + r(15) * 0.9), // qué tanto usa emojis
		abbrev: r(16) < 0.3, // q, xq, tmb, porfa
		speed: 28 + r(17) * 45, // ms por letra al escribir
		dropPeriod: r(18) < 0.6,
		pace: 0.6 + r(19) * 0.9 // qué tan rápido contesta (menos = más rápido)
	}
}
const EMOJI = /\p{Extended_Pictographic}️?/gu
const ACC = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U' }
export function styleText(text, p) {
	if (!p) return text
	let t = String(text)
	t = t.replace(/\b(ja){2,}j?\b/gi, () => p.laugh)
	const stripped = t.replace(EMOJI, m => (Math.random() < p.emoji ? m : ''))
	if (stripped.replace(/\s/g, '')) t = stripped // si solo era un emoji, se queda
	if (p.noInvQ) t = t.replace(/[¿¡]/g, '')
	if (p.abbrev) {
		t = t.replace(/\btambién\b/gi, 'tmb').replace(/\bporque\b/gi, 'xq').replace(/\bpor favor\b/gi, 'porfa')
			.replace(/\bque\b/g, m => (Math.random() < 0.5 ? 'q' : m))
	}
	if (p.noAccent) t = t.replace(/[áéíóúÁÉÍÓÚ]/g, c => ACC[c])
	if (p.lower) t = t.replace(/^([¿¡]?)(\p{Lu})/u, (m, a, b) => a + b.toLowerCase())
	if (p.dropPeriod) t = t.replace(/\.$/, '')
	return t.replace(/[ \t]+/g, ' ').replace(/ +([,.!?])/g, '$1').trim() || text
}
