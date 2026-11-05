import { db } from './db.js'

// Corrección de texto con IA (Claude): corrige ortografía y propone una versión mejorada
// antes de enviar. La clave se toma de ANTHROPIC_API_KEY o de Ajustes (app_settings).

const setting = key => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value
const save = (key, value) => db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value)

const MODEL = process.env.AI_MODEL || 'claude-haiku-5-5'
const apiKey = () => process.env.ANTHROPIC_API_KEY || setting('ai_key') || ''

export const aiStatus = () => ({
	configured: Boolean(apiKey()),
	fromEnv: Boolean(process.env.ANTHROPIC_API_KEY),
	review: setting('ai_review') !== '0'
})

export function aiSave({ key, review }) {
	if (typeof key === 'string') save('ai_key', key.trim())
	if (typeof review === 'boolean') save('ai_review', review ? '1' : '0')
	return aiStatus()
}

const SYSTEM = `Eres un asistente que revisa mensajes de WhatsApp en español (México) antes de enviarlos.
Devuelve SOLO un JSON con dos campos:
- "corregido": el mismo mensaje con ortografía, acentos, puntuación y gramática corregidos. No cambies el sentido, el tono ni las palabras salvo errores. Conserva emojis, montos, fechas, nombres, enlaces y saltos de línea.
- "mejorado": una versión más clara, cordial y profesional del mismo mensaje, breve y natural para WhatsApp, sin inventar datos (montos, fechas, cuentas) que no estén en el mensaje. Usa el contexto de la conversación solo para entender, no lo repitas.
Sin explicaciones, sin comillas extra, sin markdown.`

function context(accountId, jid) {
	if (!accountId || !jid) return ''
	const rows = db.prepare(`SELECT from_me, text FROM messages WHERE account_id = ? AND jid = ? AND text IS NOT NULL AND text != ''
		ORDER BY ts DESC LIMIT 8`).all(accountId, jid).reverse()
	return rows.map(r => `${r.from_me ? 'Yo' : 'Cliente'}: ${String(r.text).slice(0, 400)}`).join('\n')
}

export async function aiRewrite({ text, accountId, jid }) {
	text = String(text || '').trim()
	if (!text) throw new Error('Escribe un mensaje')
	if (text.length > 4000) throw new Error('El mensaje es muy largo')
	const key = apiKey()
	if (!key) throw Object.assign(new Error('Configura tu clave de IA en Ajustes'), { status: 412 })
	const ctx = context(Number(accountId), jid)
	const user = (ctx ? `Conversación reciente:\n${ctx}\n\n` : '') + `Mensaje a revisar:\n${text}`
	const r = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
		body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
		signal: AbortSignal.timeout(30000)
	}).catch(() => { throw new Error('No se pudo conectar con la IA') })
	const data = await r.json().catch(() => ({}))
	if (!r.ok) {
		if (r.status === 401) throw new Error('La clave de IA no es válida')
		throw new Error(data?.error?.message || `Error de IA (${r.status})`)
	}
	const out = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim()
	const m = out.match(/\{[\s\S]*\}/)
	let parsed = {}
	try { parsed = JSON.parse(m ? m[0] : out) } catch {}
	const corregido = String(parsed.corregido || '').trim() || text
	const mejorado = String(parsed.mejorado || '').trim() || corregido
	return { original: text, corregido, mejorado }
}
