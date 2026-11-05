import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { db } from './db.js'
import { MEDIA_DIR, note, preview, stmt } from './sessions.js'
import { sendPush } from './push.js'
import { smartIncoming, INTENTS } from './smart.js'

// API oficial de WhatsApp (Cloud API de Meta)
const GRAPH = `${process.env.GRAPH_BASE || 'https://graph.facebook.com'}/${process.env.GRAPH_VERSION || 'v23.0'}`

const EXT = {
	'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/3gpp': '3gp',
	'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac', 'audio/amr': 'amr',
	'application/pdf': 'pdf'
}

// Mensajes de error de Meta traducidos a algo entendible
const ERRORS = {
	131047: 'Ya pasaron más de 24 h desde el último mensaje del cliente. Envía una plantilla.',
	131026: 'No se pudo entregar: el número no tiene WhatsApp o no acepta mensajes de empresas.',
	131049: 'Meta no entregó este mensaje para no saturar al cliente con mensajes de marketing. Intenta más tarde.',
	131050: 'El cliente pidió dejar de recibir mensajes de marketing de tu número.',
	131056: 'Demasiados mensajes seguidos al mismo número. Espera unos segundos.',
	131048: 'Meta limitó tus envíos porque muchas personas reportaron o bloquearon tu número.',
	130429: 'Estás enviando demasiado rápido. Espera un momento.',
	131021: 'No puedes enviarte mensajes a tu propio número.',
	132000: 'La cantidad de datos no coincide con los espacios {{ }} de la plantilla.',
	132001: 'La plantilla no existe o aún no está aprobada en ese idioma.',
	132015: 'La plantilla está pausada por baja calidad.',
	132016: 'La plantilla fue desactivada por baja calidad.',
	133010: 'El número de la API aún no está registrado. Termina el registro en Meta.',
	190: 'El token ya no es válido. Genera uno nuevo en Meta y actualízalo en la cuenta.',
	10: 'El token no tiene permisos suficientes (whatsapp_business_messaging y whatsapp_business_management).',
	200: 'El token no tiene permisos suficientes (whatsapp_business_messaging y whatsapp_business_management).',
	100: 'Meta rechazó un dato. Revisa el identificador del número, el de la cuenta y el token.'
}

export class GraphError extends Error {
	constructor(err) {
		const code = err?.code
		super(ERRORS[code] || err?.error_user_msg || err?.error_data?.details || err?.message || 'Error de Meta')
		this.code = code
		this.status = 400
	}
}

/** Normaliza un teléfono: solo dígitos y, si son 10 dígitos, se asume México (+52) */
export function normalizePhone(input) {
	let d = String(input || '').replace(/\D/g, '')
	if (d.length === 10) d = '52' + d
	if (d.length < 11 || d.length > 15) throw new Error(`Número inválido: ${input}`)
	return d
}

const jidOf = waId => `${waId}@s.whatsapp.net`
const safe = s => String(s).replace(/[^A-Za-z0-9_-]/g, '_')

const fillTemplate = (text, params) => String(text || '').replace(/\{\{(\d+)\}\}/g, (m, n) => params[Number(n) - 1] ?? m)

export class CloudSession {
	constructor(manager, accountId) {
		this.manager = manager
		this.accountId = accountId
		this.status = 'connecting'
		this.qr = null
		this.error = null
		this.info = null
		this.templates = null
		this.templatesAt = 0
		this.sock = true // compatibilidad con el gestor de sesiones
	}

	get config() {
		return JSON.parse(stmt.getAccount.get(this.accountId)?.cloud || '{}')
	}

	setStatus(status, phone = null) {
		this.status = status
		stmt.setAccount.run(status, phone, this.accountId)
		this.manager.emit('event', { type: 'account.update', data: this.manager.accountInfo(this.accountId) })
	}

	async graph(pathname, { method = 'GET', body, form, raw } = {}) {
		const { token } = this.config
		const headers = { Authorization: `Bearer ${token}` }
		let payload
		if (form) payload = form
		else if (body) {
			headers['Content-Type'] = 'application/json'
			payload = JSON.stringify(body)
		}
		const res = await fetch(pathname.startsWith('http') ? pathname : `${GRAPH}/${pathname}`, { method, headers, body: payload })
		if (raw) {
			if (!res.ok) throw new Error('No se pudo descargar el archivo de Meta')
			return Buffer.from(await res.arrayBuffer())
		}
		const data = await res.json().catch(() => ({}))
		if (!res.ok || data.error) {
			note(this.accountId, 'graph-error', `${pathname.split('?')[0]} ${data.error?.code} ${data.error?.message}`)
			throw new GraphError(data.error)
		}
		return data
	}

	async start() {
		const { phoneNumberId, wabaId } = this.config
		try {
			this.info = await this.graph(`${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,name_status,messaging_limit_tier`)
			this.error = null
			// Suscribe la app a la cuenta para recibir los mensajes por webhook
			await this.graph(`${wabaId}/subscribed_apps`, { method: 'POST' }).catch(e => note(this.accountId, 'subscribe-error', e.message))
			note(this.accountId, 'open', 'cloud')
			this.setStatus('connected', String(this.info.display_phone_number || '').replace(/\D/g, ''))
		} catch (e) {
			this.error = e.message
			note(this.accountId, 'cloud-error', e.message)
			this.setStatus('error')
		}
	}

	async stop() {}

	async logout() {
		this.setStatus('logged_out')
	}

	requireSocket() {
		if (this.status !== 'connected') throw new Error(this.error || 'Esta cuenta no está conectada')
		return this
	}

	// ---- Plantillas ----
	async listTemplates(force) {
		if (!force && this.templates && Date.now() - this.templatesAt < 60000) return this.templates
		const { wabaId } = this.config
		const data = await this.graph(`${wabaId}/message_templates?fields=name,language,status,category,components,rejected_reason&limit=200`)
		this.templates = (data.data || []).map(t => {
			const body = t.components?.find(c => c.type === 'BODY')?.text || ''
			const vars = [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))]
			return {
				name: t.name,
				language: t.language,
				status: t.status,
				category: t.category,
				body,
				params: vars.length ? Math.max(...vars) : 0,
				rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null
			}
		})
		this.templatesAt = Date.now()
		return this.templates
	}

	async createTemplate({ name, category, language, body, examples }) {
		const { wabaId } = this.config
		const clean = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
		if (!clean) throw new Error('Escribe un nombre para la plantilla')
		if (!String(body || '').trim()) throw new Error('Escribe el texto de la plantilla')
		const count = [...String(body).matchAll(/\{\{(\d+)\}\}/g)].length
		const component = { type: 'BODY', text: String(body).trim() }
		if (count) component.example = { body_text: [Array.from({ length: count }, (_, i) => String(examples?.[i] || `ejemplo${i + 1}`))] }
		const res = await this.graph(`${wabaId}/message_templates`, {
			method: 'POST',
			body: { name: clean, category: category === 'MARKETING' ? 'MARKETING' : 'UTILITY', language: language || 'es_MX', components: [component] }
		})
		this.templatesAt = 0
		return { id: res.id, status: res.status, category: res.category, name: clean }
	}

	// ---- Envío ----
	async sendPayload(to, payload, record) {
		this.requireSocket()
		const res = await this.graph(`${this.config.phoneNumberId}/messages`, {
			method: 'POST',
			body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }
		})
		const id = res.messages?.[0]?.id
		const waId = res.contacts?.[0]?.wa_id || to
		const jid = jidOf(waId)
		note(this.accountId, 'sent', payload.type)
		const row = {
			account_id: this.accountId,
			id,
			jid,
			remote_jid: jid,
			participant: null,
			from_me: 1,
			sender: null,
			sender_name: null,
			ts: Date.now(),
			type: record.type,
			text: record.text ?? null,
			media_mime: record.mime ?? null,
			file_name: record.fileName ?? null,
			status: 1,
			raw: null
		}
		this.saveRow(row, false)
		return { id, jid }
	}

	toFromJid(jid) {
		return String(jid).split('@')[0]
	}

	async send(jid, content, localMedia) {
		const to = this.toFromJid(jid)
		if (content.text) {
			const { id } = await this.sendPayload(to, { type: 'text', text: { body: content.text, preview_url: true } }, { type: 'text', text: content.text })
			return this.manager.formatMessage(stmt.getMessage.get(this.accountId, id))
		}
		const kind = content.image ? 'image' : content.video ? 'video' : content.audio ? 'audio' : 'document'
		const buffer = content[kind]
		const mime = String(content.mimetype || localMedia?.mime || 'application/octet-stream').split(';')[0]
		const form = new FormData()
		form.append('messaging_product', 'whatsapp')
		form.append('type', mime)
		form.append('file', new Blob([buffer], { type: mime }), localMedia?.fileName || `archivo.${EXT[mime] || 'bin'}`)
		const { id: mediaId } = await this.graph(`${this.config.phoneNumberId}/media`, { method: 'POST', form })
		const media = { id: mediaId }
		if (content.caption && kind !== 'audio') media.caption = content.caption
		if (kind === 'document') media.filename = content.fileName || localMedia?.fileName
		const { id } = await this.sendPayload(to, { type: kind, [kind]: media }, {
			type: kind, text: content.caption, mime, fileName: kind === 'document' ? media.filename : null
		})
		if (localMedia) {
			const file = this.writeMedia(id, localMedia.buffer, localMedia.mime, localMedia.fileName)
			stmt.setMedia.run(file, this.accountId, id)
		}
		return this.manager.formatMessage(stmt.getMessage.get(this.accountId, id))
	}

	async sendTemplate(phoneOrJid, { name, language, params = [] }) {
		const to = String(phoneOrJid).includes('@') ? this.toFromJid(phoneOrJid) : normalizePhone(phoneOrJid)
		const templates = await this.listTemplates()
		const tpl = templates.find(t => t.name === name && (!language || t.language === language))
		if (!tpl) throw new Error('La plantilla no existe')
		if (tpl.status !== 'APPROVED') throw new Error('La plantilla aún no está aprobada por Meta')
		const values = params.map(p => String(p ?? '').trim() || '-')
		const template = { name, language: { code: tpl.language } }
		if (tpl.params) {
			template.components = [{ type: 'body', parameters: Array.from({ length: tpl.params }, (_, i) => ({ type: 'text', text: values[i] || '-' })) }]
		}
		const { id, jid } = await this.sendPayload(to, { type: 'template', template }, { type: 'text', text: fillTemplate(tpl.body, values) })
		return { id, jid, message: this.manager.formatMessage(stmt.getMessage.get(this.accountId, id)) }
	}

	async markRead(jid) {
		stmt.setChatUnread.run(0, this.accountId, jid)
		if (this.status !== 'connected') return
		const last = db.prepare('SELECT id FROM messages WHERE account_id = ? AND jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT 1').get(this.accountId, jid)
		if (!last) return
		await this.graph(`${this.config.phoneNumberId}/messages`, {
			method: 'POST', body: { messaging_product: 'whatsapp', status: 'read', message_id: last.id }
		}).catch(() => {})
	}

	// ---- Recepción (webhook) ----
	handleWebhook(value) {
		const names = new Map((value.contacts || []).map(c => [c.wa_id, c.profile?.name]))
		for (const [waId, name] of names) {
			if (name) stmt.upsertContact.run({ jid: jidOf(waId), name: null, notify: name })
		}
		for (const m of value.messages || []) this.receive(m, names.get(m.from))
		for (const s of value.statuses || []) this.status_(s)
	}

	receive(m, name) {
		const jid = jidOf(m.from)
		let type = 'text'
		let text = null
		let mime = null
		let fileName = null
		let raw = null
		switch (m.type) {
			case 'text': text = m.text?.body; break
			case 'image': case 'video': case 'audio': case 'document': case 'sticker': {
				const media = m[m.type]
				type = m.type
				text = media.caption || null
				mime = media.mime_type || null
				fileName = media.filename || null
				raw = JSON.stringify({ cloudMediaId: media.id })
				break
			}
			case 'location': text = `📍 https://maps.google.com/?q=${m.location.latitude},${m.location.longitude}`; type = 'location'; break
			case 'contacts': text = `👤 ${m.contacts?.[0]?.name?.formatted_name || 'Contacto'}`; type = 'contact'; break
			case 'button': text = m.button?.text; break
			case 'interactive': text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title; break
			case 'reaction': return
			default: text = '(Mensaje no compatible)'
		}
		const row = {
			account_id: this.accountId, id: m.id, jid, remote_jid: jid, participant: null, from_me: 0,
			sender: jid, sender_name: name || null, ts: Number(m.timestamp) * 1000 || Date.now(),
			type, text, media_mime: mime, file_name: fileName, status: 0, raw
		}
		if (this.saveRow(row, true)) {
			if (raw && ['image', 'audio', 'sticker'].includes(type)) this.downloadMedia(m.id).catch(() => {})
			// Baja automática: el cliente pide no recibir más mensajes
			if (type === 'text' && /^\s*(baja|stop|alto|no molestar)\s*[.!]*\s*$/i.test(text || '')) {
				db.prepare('INSERT OR REPLACE INTO optouts (phone, at) VALUES (?, ?)').run(m.from, Date.now())
				note(this.accountId, 'optout')
				this.send(jid, { text: 'Listo, ya no te enviaremos más mensajes. Gracias.' }).catch(() => {})
			}
		}
	}

	status_(s) {
		const map = { sent: 2, delivered: 3, read: 4, failed: 0 }
		const status = map[s.status]
		if (status === undefined) return
		if (status === 0) {
			const err = s.errors?.[0]
			const text = ERRORS[err?.code] || err?.error_data?.details || err?.title || 'No se pudo enviar'
			note(this.accountId, 'status', `0 ${err?.code} ${err?.title || ''}`)
			db.prepare('UPDATE messages SET status = 0, error = ? WHERE account_id = ? AND id = ?').run(text, this.accountId, s.id)
			db.prepare("UPDATE campaign_items SET status = 'failed', error = ? WHERE message_id = ?").run(text, s.id)
		} else {
			stmt.setStatus.run(status, this.accountId, s.id)
		}
		const row = stmt.getMessage.get(this.accountId, s.id)
		if (row) this.manager.emit('event', { type: 'message', data: this.manager.formatMessage(row) })
	}

	saveRow(row, live) {
		const inserted = stmt.insertMessage.run(row).changes > 0
		stmt.upsertChat.run({ account_id: this.accountId, jid: row.jid, name: null, unread: inserted && live ? 1 : 0, last_ts: row.ts })
		if (!inserted) return false
		this.manager.emit('event', { type: 'message', data: this.manager.formatMessage(stmt.getMessage.get(this.accountId, row.id)) })
		this.manager.emit('event', { type: 'conversation.update', data: this.manager.conversation(this.accountId, row.jid) })
		if (live) {
			let intent = null
			if (!row.from_me && row.text) {
				try { intent = smartIncoming({ accountId: this.accountId, jid: row.jid, msgId: row.id, text: row.text }) } catch {}
				if (intent) {
					this.manager.emit('event', { type: 'message', data: this.manager.formatMessage(stmt.getMessage.get(this.accountId, row.id)) })
					this.manager.emit('event', { type: 'conversation.update', data: this.manager.conversation(this.accountId, row.jid) })
				}
			}
			const conv = this.manager.conversation(this.accountId, row.jid)
			const account = stmt.getAccount.get(this.accountId)
			if (!conv?.muted) sendPush({
				title: `${intent ? INTENTS[intent].tag + ' · ' : ''}${conv?.name || '+' + row.jid.split('@')[0]} · ${account?.name}`,
				body: preview(row),
				jid: `${this.accountId}:${row.jid}`,
				badge: this.manager.totalUnread()
			})
		}
		return true
	}

	async downloadMedia(id) {
		const row = stmt.getMessage.get(this.accountId, id)
		if (!row) throw new Error('Mensaje no encontrado')
		if (row.media_path && fs.existsSync(row.media_path)) return row
		const mediaId = row.raw ? JSON.parse(row.raw).cloudMediaId : null
		if (!mediaId) throw new Error('El mensaje no tiene multimedia')
		const info = await this.graph(mediaId)
		const buffer = await this.graph(info.url, { raw: true })
		const file = this.writeMedia(id, buffer, row.media_mime || info.mime_type, row.file_name)
		stmt.setMedia.run(file, this.accountId, id)
		const saved = stmt.getMessage.get(this.accountId, id)
		this.manager.emit('event', { type: 'message', data: this.manager.formatMessage(saved) })
		return saved
	}

	writeMedia(id, buffer, mime, fileName) {
		const dir = path.join(MEDIA_DIR, String(this.accountId))
		fs.mkdirSync(dir, { recursive: true })
		const base = String(mime || '').split(';')[0]
		const ext = EXT[base] || path.extname(fileName || '').slice(1) || base.split('/')[1] || 'bin'
		const file = path.join(dir, `${safe(id)}.${safe(ext)}`)
		fs.writeFileSync(file, buffer)
		return file
	}
}

/** Token para que Meta confirme el webhook; se deriva del token interno para no tener que configurarlo */
export function webhookVerifyToken(apiToken) {
	return crypto.createHash('sha256').update(`webhook:${apiToken}`).digest('hex').slice(0, 24)
}

/** Verifica la firma de Meta si la cuenta tiene configurada la clave secreta de la app */
export function validSignature(rawBody, header, secrets) {
	if (!secrets.length) return true
	if (!header || !rawBody) return false
	return secrets.some(secret => {
		const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
		return expected.length === header.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header))
	})
}
