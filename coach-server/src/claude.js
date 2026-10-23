import Anthropic from '@anthropic-ai/sdk'
import { MODEL } from './config.js'

// Lee ANTHROPIC_API_KEY del entorno
const client = new Anthropic()

const num = { type: ['number', 'null'] }
const str = { type: ['string', 'null'] }
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })

// Una llamada con salida JSON validada por esquema. Si un clasificador rechaza
// la petición, `fallbacks: "default"` la reintenta en otro modelo del lado del servidor.
async function ask({ system, content, schema, effort }) {
	const res = await client.beta.messages.create({
		model: MODEL,
		max_tokens: 16000,
		betas: ['server-side-fallback-2026-07-01'],
		fallbacks: 'default',
		output_config: { effort, format: { type: 'json_schema', schema } },
		system,
		messages: [{ role: 'user', content }],
	})
	if (res.stop_reason === 'refusal') throw new Error('Claude no pudo procesar esta petición')
	const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('')
	return JSON.parse(text)
}

const HEALTH_SCHEMA = obj({
	sueno_min: num, profundo_min: num, rem_min: num, despierto_min: num,
	hora_dormir: str, hora_despertar: str,
	pasos: num, distancia_km: num,
	kcal_activas: num, kcal_reposo: num, kcal_totales: num,
	ejercicio_min: num, fc_reposo: num, vfc_ms: num, peso_kg: num,
	entrenamientos: { type: 'array', items: obj({ tipo: { type: 'string' }, min: num, kcal: num }) },
})

/** Convierte lo que mande el atajo de Atajos (texto o JSON en cualquier forma) en métricas. */
export function parseHealth(raw, day) {
	return ask({
		effort: 'low',
		system: 'Extraes métricas de salud de datos exportados por Apple Salud mediante la app Atajos de iOS. Las etiquetas pueden estar en español o inglés y los números pueden venir con unidades, comas decimales o como listas de muestras. Si llegan varias muestras de una métrica acumulable (pasos, energía, minutos), súmalas; para frecuencia cardiaca y VFC promedia; para peso usa la más reciente. Convierte duraciones a minutos (los valores de duración de Atajos suelen venir en segundos u horas: deduce la unidad por el rango razonable). No inventes: usa null si un dato no aparece. kcal_totales = activas + reposo si ambas existen.',
		content: `Día: ${day}\n\nDatos recibidos:\n${raw.slice(0, 60000)}`,
		schema: HEALTH_SCHEMA,
	})
}

const FOOD_SCHEMA = obj({ descripcion: { type: 'string' }, kcal: num, proteina_g: num, carbohidratos_g: num, grasa_g: num })

/** Estima calorías y macros de una comida a partir de texto y/o una foto (data URL JPEG). */
export function estimateFood(text, photo) {
	const content = []
	if (photo) {
		const [, mediaType, data] = photo.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/) || []
		if (data) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })
	}
	content.push({ type: 'text', text: `Estima esta comida.${text ? `\nDescripción del usuario: ${text}` : ''}\n\n"descripcion": lista breve de alimentos con cantidades aproximadas, en español. Valores totales del plato.` })
	return ask({
		effort: 'low',
		system: 'Eres nutricionista. Estimas porciones, calorías y macros de comidas a partir de fotos y descripciones, con valores realistas de raciones mexicanas/latinoamericanas cuando aplique.',
		content,
		schema: FOOD_SCHEMA,
	})
}

/** Transcribe un plan de entrenamiento de un PDF o una foto (data URL). */
export async function transcribePlan(dataUrl) {
	const [, mediaType, data] = String(dataUrl).match(/^data:([\w/+.-]+);base64,(.+)$/) || []
	if (!data) throw Object.assign(new Error('Archivo no válido'), { status: 400 })
	const block = mediaType === 'application/pdf'
		? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
		: { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
	const r = await ask({
		effort: 'low',
		system: 'Transcribes documentos con fidelidad.',
		content: [block, { type: 'text', text: 'Transcribe el plan de entrenamiento y nutrición de este documento en texto plano ordenado: días, ejercicios, series, repeticiones, cardio, calorías, macros, sueño y notas.' }],
		schema: obj({ texto: { type: 'string' } }),
	})
	return r.texto
}

const REVIEW_SCHEMA = obj({
	puntuacion: { type: 'integer', description: 'Nota del día de 1 a 10 respecto al plan' },
	resumen: { type: 'string' },
	bien: { type: 'array', items: { type: 'string' } },
	mal: { type: 'array', items: { type: 'string' } },
	manana: { type: 'array', items: { type: 'string' } },
	kcal_ingeridas: num,
	proteina_g: num,
})

function dayReport(d) {
	const lines = [`Fecha: ${d.date}`, `Apple Salud: ${JSON.stringify(d.health || {})}`, 'Comidas:']
	if (!d.foods?.length) lines.push('- no registré comidas')
	for (const f of d.foods || []) {
		const est = [f.kcal != null && `${Math.round(f.kcal)} kcal`, f.proteina_g != null && `${Math.round(f.proteina_g)} g proteína`].filter(Boolean).join(', ')
		lines.push(`- ${f.time} [${f.meal}] ${f.text}${est ? ` (≈ ${est})` : ''}`)
	}
	return lines.join('\n')
}

/** Evalúa un día frente al plan, con la tendencia de los días anteriores. */
export function reviewDay(day, profile, previous) {
	const trend = previous.map(p => `${p.date}: nota ${p.review?.puntuacion ?? '—'}, sueño ${p.health?.sueno_min ?? '?'} min, pasos ${p.health?.pasos ?? '?'}, kcal comidas ${p.review?.kcal_ingeridas ?? '?'}, entrenos ${(p.health?.entrenamientos || []).map(w => w.tipo).join('/') || 'ninguno'}`).join('\n')
	return ask({
		effort: 'medium',
		system: [
			{ type: 'text', text: 'Eres mi entrenador personal y nutricionista. Cada día comparas mis datos de Apple Salud (sueño, actividad, entrenamientos) y lo que comí con mi plan de entrenamiento, y me dices con franqueza qué hice bien, qué hice mal y qué hacer mañana. Usa números concretos (horas de sueño, proteína, calorías, pasos) y sé breve. Si faltan datos, dilo; no inventes. Las calorías de comidas son estimaciones. Responde en español.' },
			{ type: 'text', text: `MI PLAN DE ENTRENAMIENTO:\n${profile.plan || '(todavía no lo cargué: evalúa con buenas prácticas generales y pídeme que lo cargue)'}\n\nSOBRE MÍ:\n${profile.about || '(sin datos)'}`, cache_control: { type: 'ephemeral' } },
		],
		content: `ÚLTIMOS DÍAS:\n${trend || '(sin días anteriores)'}\n\nDÍA A EVALUAR:\n${dayReport(day)}`,
		schema: REVIEW_SCHEMA,
	})
}
