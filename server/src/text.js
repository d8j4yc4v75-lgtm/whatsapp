// Utilidades de texto compartidas por el modo seguro y el calentamiento

// Spintax: {hola|qué tal|buenas} elige una opción al azar (admite llaves anidadas y opciones vacías).
// Así los mensajes no salen idénticos siempre (WhatsApp bloquea menos lo que se ve variado).
export function spin(text) {
	let s = String(text || '')
	for (let i = 0; i < 8 && /\{[^{}]*\|[^{}]*\}/.test(s); i++) {
		s = s.replace(/\{([^{}]*\|[^{}]*)\}/g, (m, opts) => { const a = opts.split('|'); return a[Math.floor(Math.random() * a.length)] })
	}
	return s
}

// Limpia espacios que dejan las opciones vacías: "Hola  ," → "Hola,"
export function tidy(text) {
	return String(text || '')
		.split('\n').map(l => l.replace(/[ \t]+/g, ' ').replace(/ +([,.!?;:])/g, '$1').trim()).join('\n')
		.replace(/\n{3,}/g, '\n\n').trim()
}

export const vary = text => tidy(spin(text))
