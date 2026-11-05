import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import QRCode from 'qrcode'
import makeWASocket, {
	Browsers,
	BufferJSON,
	DisconnectReason,
	downloadMediaMessage,
	fetchLatestBaileysVersion,
	getContentType,
	isJidBroadcast,
	isJidGroup,
	isJidNewsletter,
	isLidUser,
	isPnUser,
	jidNormalizedUser,
	makeCacheableSignalKeyStore,
	normalizeMessageContent
} from 'baileys'
import { db } from './db.js'
import { smartIncoming, INTENTS } from './smart.js'
import { DATA_DIR } from './config.js'
import { sendPush } from './push.js'
import { CloudSession, normalizePhone } from './cloud.js'
import { clearAuth, hasAuth, useSqliteAuthState } from './auth-store.js'
import { accountHealth, markLinked, markUnlinked, maybeRest } from './health.js'

// Los avisos de Baileys también se guardan en el diagnóstico
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' }, {
	write(line) {
		process.stdout.write(line)
		try {
			const o = JSON.parse(line)
			note(null, 'baileys-' + (o.level >= 50 ? 'error' : 'warn'), `${o.msg || ''} ${JSON.stringify(o.attrs || o.err?.message || o.error || '')}`)
		} catch {}
	}
})
const AUTH_DIR = path.join(DATA_DIR, 'auth')
export const MEDIA_DIR = path.join(DATA_DIR, 'media')

const MEDIA_TYPES = {
	imageMessage: 'image',
	videoMessage: 'video',
	audioMessage: 'audio',
	documentMessage: 'document',
	stickerMessage: 'sticker'
}

const EXT = {
	'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
	'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
	'audio/mpeg': 'mp3', 'audio/aac': 'aac', 'application/pdf': 'pdf'
}

// Registro de diagnóstico en memoria (sin números ni contenido de mensajes)
export const diag = []
export function note(accountId, event, detail) {
	const clean = detail === undefined ? undefined : String(detail).replace(/\d{5,}/g, '###').slice(0, 300)
	diag.push({ at: new Date().toISOString(), accountId, event, detail: clean })
	if (diag.length > 200) diag.shift()
}

const toMs = ts => (ts ? Number(ts) * 1000 : Date.now())
const safe = s => String(s).replace(/[^A-Za-z0-9_-]/g, '_')

export const stmt = {
	upsertChat: db.prepare(`
		INSERT INTO chats (account_id, jid, name, unread, last_ts) VALUES (@account_id, @jid, @name, @unread, @last_ts)
		ON CONFLICT (account_id, jid) DO UPDATE SET
			name = COALESCE(excluded.name, chats.name),
			unread = chats.unread + excluded.unread,
			last_ts = MAX(chats.last_ts, excluded.last_ts)`),
	setChatUnread: db.prepare('UPDATE chats SET unread = ? WHERE account_id = ? AND jid = ?'),
	insertMessage: db.prepare(`
		INSERT INTO messages (account_id, id, jid, remote_jid, participant, from_me, sender, sender_name, ts, type, text, media_mime, file_name, status, raw)
		VALUES (@account_id, @id, @jid, @remote_jid, @participant, @from_me, @sender, @sender_name, @ts, @type, @text, @media_mime, @file_name, @status, @raw)
		ON CONFLICT (account_id, id) DO NOTHING`),
	setMedia: db.prepare('UPDATE messages SET media_path = ? WHERE account_id = ? AND id = ?'),
	setStatus: db.prepare('UPDATE messages SET status = MAX(status, ?) WHERE account_id = ? AND id = ?'),
	forceStatus: db.prepare('UPDATE messages SET status = ? WHERE account_id = ? AND id = ?'),
	setText: db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE account_id = ? AND id = ?'),
	setDeleted: db.prepare('UPDATE messages SET deleted = 1, text = NULL WHERE account_id = ? AND id = ?'),
	getMessage: db.prepare('SELECT * FROM messages WHERE account_id = ? AND id = ?'),
	upsertContact: db.prepare(`
		INSERT INTO contacts (jid, name, notify) VALUES (@jid, @name, @notify)
		ON CONFLICT (jid) DO UPDATE SET
			name = COALESCE(excluded.name, contacts.name),
			notify = COALESCE(excluded.notify, contacts.notify)`),
	setLid: db.prepare('INSERT OR REPLACE INTO lid_map (lid, pn) VALUES (?, ?)'),
	getLid: db.prepare('SELECT pn FROM lid_map WHERE lid = ?'),
	setAccount: db.prepare('UPDATE accounts SET status = ?, phone = COALESCE(?, phone) WHERE id = ?'),
	getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
	archiveChat: db.prepare('UPDATE chats SET archived = 1, unread = 0 WHERE account_id = ? AND jid = ? AND archived = 0')
}

// JIDs de tus propios números (con su @lid si se conoce), en caché un minuto
let own = { at: 0, set: new Set() }
export function resetOwnCache() { own.at = 0 }
export function isOwnJid(jid) {
	if (Date.now() - own.at > 60000) {
		const set = new Set()
		try {
			for (const { phone } of db.prepare("SELECT phone FROM accounts WHERE phone IS NOT NULL AND phone != ''").all()) {
				const pn = `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`
				set.add(pn)
				for (const { lid } of db.prepare('SELECT lid FROM lid_map WHERE pn = ?').all(pn)) set.add(lid)
			}
			// Grupos que creó el calentamiento entre tus números
			const g = db.prepare("SELECT value FROM app_settings WHERE key = 'warmup_groups'").get()
			for (const x of JSON.parse(g?.value || '[]')) if (x?.jid) set.add(x.jid)
		} catch {}
		own = { at: Date.now(), set }
	}
	return own.set.has(jid)
}

function rememberLid(lid, pn) {
	if (lid && pn && isLidUser(lid) && isPnUser(pn)) stmt.setLid.run(jidNormalizedUser(lid), jidNormalizedUser(pn))
}

/** Convierte un JID (posiblemente @lid) al formato de número para unificar conversaciones */
export function canonicalJid(jid, alt) {
	if (!jid) return jid
	jid = jidNormalizedUser(jid)
	if (isLidUser(jid)) {
		if (alt && isPnUser(alt)) {
			rememberLid(jid, alt)
			return jidNormalizedUser(alt)
		}
		const row = stmt.getLid.get(jid)
		if (row) return row.pn
	}
	return jid
}

function describe(content) {
	const type = getContentType(content)
	if (!type) return null
	const m = content[type]
	switch (type) {
		case 'conversation':
			return { type: 'text', text: m }
		case 'extendedTextMessage':
			return { type: 'text', text: m.text }
		case 'imageMessage':
		case 'videoMessage':
		case 'audioMessage':
		case 'documentMessage':
		case 'stickerMessage':
			return {
				type: MEDIA_TYPES[type],
				text: m.caption || null,
				media_mime: m.mimetype || null,
				file_name: m.fileName || null
			}
		case 'locationMessage':
		case 'liveLocationMessage':
			return { type: 'location', text: `📍 https://maps.google.com/?q=${m.degreesLatitude},${m.degreesLongitude}` }
		case 'contactMessage':
			return { type: 'contact', text: `👤 ${m.displayName || 'Contacto'}` }
		case 'contactsArrayMessage':
			return { type: 'contact', text: `👤 ${m.contacts?.length || 0} contactos` }
		case 'pollCreationMessage':
		case 'pollCreationMessageV3':
			return { type: 'poll', text: `📊 ${m.name}` }
		case 'buttonsResponseMessage':
			return { type: 'text', text: m.selectedDisplayText }
		case 'listResponseMessage':
			return { type: 'text', text: m.title }
		case 'templateButtonReplyMessage':
			return { type: 'text', text: m.selectedDisplayText }
		default:
			return null
	}
}

export function preview(row) {
	if (!row) return ''
	if (row.deleted) return '🚫 Mensaje eliminado'
	const icons = { image: '📷 Foto', video: '🎥 Video', audio: '🎤 Audio', document: '📄 Documento', sticker: '🏷️ Sticker' }
	if (row.text) return row.text
	return icons[row.type] || row.file_name || ''
}

export class Session {
	constructor(manager, accountId) {
		this.manager = manager
		this.accountId = accountId
		this.sock = null
		this.qr = null
		this.status = 'disconnected'
		this.stopped = false
		this.retries = 0
		this.groupNames = new Map()
	}

	get authDir() {
		return path.join(AUTH_DIR, String(this.accountId))
	}

	setStatus(status, phone = null) {
		const prev = this.status
		this.status = status
		stmt.setAccount.run(status, phone, this.accountId)
		this.manager.emit('event', { type: 'account.update', data: this.manager.accountInfo(this.accountId) })
		// Avisos al teléfono cuando un número deja de funcionar
		const name = stmt.getAccount.get(this.accountId)?.name || 'Un número'
		if (status === 'connected') {
			clearTimeout(this.alertTimer)
		} else if (status === 'logged_out' && prev !== 'logged_out' && !this.userLogout) {
			clearTimeout(this.alertTimer)
			this.alert(`⚠️ ${name} se desvinculó`, 'WhatsApp cerró la sesión. Vuelve a vincularlo en Cuentas.')
		} else if (status === 'reconnecting' && prev === 'connected') {
			clearTimeout(this.alertTimer)
			this.alertTimer = setTimeout(() => {
				if (this.status !== 'connected' && !this.stopped) this.alert(`⚠️ ${name} está desconectado`, 'Lleva más de 10 minutos sin poder conectarse a WhatsApp.')
			}, 10 * 60000)
		}
	}

	alert(title, body) {
		note(this.accountId, 'alert', title)
		sendPush({ title, body, url: '/#/accounts', badge: this.manager.totalUnread() })
	}

	/** Aviso (como máximo cada 6 h) cuando WhatsApp rechaza mensajes de este número */
	rejectionAlert() {
		const name0 = stmt.getAccount.get(this.accountId)?.name || 'Un número'
		if (maybeRest(this.accountId)) {
			note(this.accountId, 'rest', 'auto')
			this.alert(`😴 ${name0} entró en descanso`, 'WhatsApp le rechazó varios mensajes. No se usará en envíos masivos por unos días.')
			this.manager.emit('event', { type: 'account.update', data: this.manager.accountInfo(this.accountId) })
		}
		if (this.lastRejectionAlert && Date.now() - this.lastRejectionAlert < 6 * 3600000) return
		this.lastRejectionAlert = Date.now()
		const name = stmt.getAccount.get(this.accountId)?.name || 'Un número'
		this.alert(`⚠️ WhatsApp rechazó mensajes de ${name}`, 'Puede estar restringido. Deja de enviar desde ese número unos días.')
	}

	async start() {
		this.stopped = false
		this.userLogout = false
		const { state, saveCreds } = useSqliteAuthState(this.accountId, this.authDir)
		const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))
		const sock = makeWASocket({
			version,
			logger,
			auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
			browser: Browsers.macOS('Chrome'),
			syncFullHistory: false,
			markOnlineOnConnect: false,
			getMessage: async key => {
				const row = stmt.getMessage.get(this.accountId, key.id)
				if (row?.raw) return JSON.parse(row.raw, BufferJSON.reviver).message
				return row?.text ? { conversation: row.text } : undefined
			}
		})
		this.sock = sock
		this.setStatus('connecting')

		sock.ev.on('creds.update', saveCreds)
		sock.ev.on('connection.update', u => this.onConnection(u))
		sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
			for (const m of lidPnMappings || []) rememberLid(m.lid, m.pn)
			this.saveContacts(contacts || [])
			db.transaction(() => {
				for (const c of chats || []) this.saveChat(c, true)
				for (const m of messages || []) this.saveMessage(m, false)
			})()
			this.manager.emit('event', { type: 'conversations.changed', data: { accountId: this.accountId } })
		})
		sock.ev.on('lid-mapping.update', m => rememberLid(m.lid, m.pn))
		sock.ev.on('contacts.upsert', c => this.saveContacts(c))
		sock.ev.on('contacts.update', c => this.saveContacts(c))
		sock.ev.on('chats.upsert', chats => chats.forEach(c => this.saveChat(c, false)))
		sock.ev.on('chats.update', chats => {
			for (const c of chats) {
				if (typeof c.unreadCount === 'number' && c.unreadCount === 0) {
					const jid = canonicalJid(c.id)
					stmt.setChatUnread.run(0, this.accountId, jid)
					this.manager.emit('event', { type: 'conversation.update', data: this.manager.conversation(this.accountId, jid) })
				}
			}
		})
		sock.ev.on('messages.upsert', ({ messages, type }) => {
			for (const m of messages) this.saveMessage(m, type === 'notify')
		})
		sock.ev.on('messages.update', updates => {
			for (const { key, update } of updates) {
				// Leído desde el teléfono: WhatsApp avisa con el estado «leído» de un mensaje recibido
				if (!key.fromMe && typeof update.status === 'number' && update.status >= 4 && key.remoteJid) {
					this.clearUnread(canonicalJid(key.remoteJid, key.remoteJidAlt))
					continue
				}
				if (typeof update.status === 'number') {
					note(this.accountId, 'status', `${update.status} ${JSON.stringify(update.messageStubParameters || '')}`)
					if (update.status === 0) { stmt.forceStatus.run(0, this.accountId, key.id); this.rejectionAlert() }
					else stmt.setStatus.run(update.status, this.accountId, key.id)
					this.manager.emit('event', {
						type: 'message.status',
						data: { accountId: this.accountId, id: key.id, status: update.status }
					})
				}
				const edited = update.message && normalizeMessageContent(update.message)?.editedMessage?.message
				if (edited) this.applyEdit(key.id, edited)
			}
		})
	}

	async onConnection({ connection, lastDisconnect, qr }) {
		if (qr) {
			this.qr = await QRCode.toDataURL(qr, { margin: 1, width: 512 })
			this.setStatus('qr')
			this.manager.emit('event', { type: 'qr', data: { accountId: this.accountId, qr: this.qr } })
		}
		if (connection === 'open') {
			this.qr = null
			this.retries = 0
			this.loggedOutRetries = 0
			const phone = this.sock.user?.id ? jidNormalizedUser(this.sock.user.id).split('@')[0] : null
			note(this.accountId, 'open')
			markLinked(this.accountId)
			this.setStatus('connected', phone)
		}
		if (connection === 'close') {
			const code = lastDisconnect?.error?.output?.statusCode
			note(this.accountId, 'close', `${code} ${lastDisconnect?.error?.message || ''} ${JSON.stringify(lastDisconnect?.error?.data || '')}`)
			this.sock = null
			if (this.stopped) return
			if (code === DisconnectReason.loggedOut) {
				// A veces WhatsApp responde 401 de forma pasajera: se reintenta una vez antes de dar la sesión por cerrada
				const registered = hasAuth(this.accountId, this.authDir)
				if (registered && (this.loggedOutRetries || 0) < 1) {
					this.loggedOutRetries = (this.loggedOutRetries || 0) + 1
					this.setStatus('reconnecting')
					setTimeout(() => !this.stopped && this.start().catch(e => note(this.accountId, 'start-error', e.message)), 5000)
					return
				}
				clearAuth(this.accountId, this.authDir)
				markUnlinked(this.accountId)
				this.setStatus('logged_out')
				return
			}
			this.setStatus('reconnecting')
			const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(30000, 2000 * 2 ** this.retries++)
			setTimeout(() => !this.stopped && this.start().catch(e => note(this.accountId, 'start-error', e.message)), delay)
		}
	}

	saveContacts(contacts) {
		for (const c of contacts) {
			if (c.lid && c.phoneNumber) rememberLid(c.lid, c.phoneNumber)
			const jid = canonicalJid(c.phoneNumber || c.id, c.phoneNumber)
			if (!jid || isJidGroup(jid)) continue
			stmt.upsertContact.run({ jid, name: c.name || null, notify: c.notify || c.verifiedName || null })
		}
	}

	saveChat(c, fromHistory) {
		const jid = canonicalJid(c.id, c.pnJid)
		if (!jid || isJidBroadcast(jid) || isJidNewsletter(jid)) return
		if (isJidGroup(jid) && c.name) this.groupNames.set(jid, c.name)
		stmt.upsertChat.run({
			account_id: this.accountId,
			jid,
			name: c.name || null,
			unread: 0,
			last_ts: c.conversationTimestamp ? toMs(c.conversationTimestamp) : 0
		})
		if (fromHistory && c.unreadCount > 0) stmt.setChatUnread.run(c.unreadCount, this.accountId, jid)
	}

	clearUnread(jid) {
		if (!jid) return
		const row = db.prepare('SELECT unread FROM chats WHERE account_id = ? AND jid = ?').get(this.accountId, jid)
		if (!row?.unread) return
		stmt.setChatUnread.run(0, this.accountId, jid)
		this.manager.emit('event', { type: 'conversation.update', data: this.manager.conversation(this.accountId, jid) })
	}

	async groupName(jid) {
		if (this.groupNames.has(jid)) return this.groupNames.get(jid)
		try {
			const meta = await this.sock?.groupMetadata(jid)
			if (meta?.subject) {
				this.groupNames.set(jid, meta.subject)
				stmt.upsertChat.run({ account_id: this.accountId, jid, name: meta.subject, unread: 0, last_ts: 0 })
				this.manager.emit('event', { type: 'conversation.update', data: this.manager.conversation(this.accountId, jid) })
			}
		} catch {}
	}

	applyRevoke(id) {
		stmt.setDeleted.run(this.accountId, id)
		const row = stmt.getMessage.get(this.accountId, id)
		if (row) this.manager.emit('event', { type: 'message', data: this.manager.formatMessage(row) })
	}

	// ---- Editar / eliminar para todos (solo mensajes propios) ----
	ownMessage(id) {
		const row = stmt.getMessage.get(this.accountId, id)
		if (!row || !row.from_me) throw new Error('Solo puedes cambiar tus propios mensajes')
		if (row.deleted) throw new Error('Ese mensaje ya se eliminó')
		return row
	}
	msgKey(row) { return { remoteJid: row.remote_jid, id: row.id, fromMe: true, participant: row.participant || undefined } }

	/** WhatsApp permite editar un mensaje de texto durante 15 minutos después de enviarlo */
	async editMessage(id, text) {
		const sock = this.requireSocket()
		const row = this.ownMessage(id)
		if (row.type !== 'text') throw new Error('Solo se pueden editar mensajes de texto')
		if (Date.now() - row.ts > 15 * 60000) throw new Error('WhatsApp solo deja editar durante los primeros 15 minutos')
		const t = String(text || '').trim()
		if (!t) throw new Error('Escribe el mensaje')
		await sock.sendMessage(row.remote_jid, { text: t, edit: this.msgKey(row) })
		stmt.setText.run(t, this.accountId, id)
		const out = this.manager.formatMessage(stmt.getMessage.get(this.accountId, id))
		this.manager.emit('event', { type: 'message', data: out })
		return out
	}

	/** "Eliminar para todos": WhatsApp lo permite durante unos 2 días */
	async deleteForEveryone(id) {
		const sock = this.requireSocket()
		const row = this.ownMessage(id)
		if (Date.now() - row.ts > 2 * 864e5) throw new Error('WhatsApp solo deja eliminar para todos durante unos 2 días')
		await sock.sendMessage(row.remote_jid, { delete: this.msgKey(row) })
		stmt.setDeleted.run(this.accountId, id)
		const out = this.manager.formatMessage(stmt.getMessage.get(this.accountId, id))
		this.manager.emit('event', { type: 'message', data: out })
		return out
	}

	// ---- Perfil de WhatsApp de este número ----
	async getProfile() {
		const sock = this.requireSocket()
		const me = jidNormalizedUser(sock.user.id)
		const [picture, status] = await Promise.all([
			sock.profilePictureUrl(me, 'image').catch(() => null),
			sock.fetchStatus(me).then(list => { const st = list?.[0]?.status; return typeof st === 'string' ? st : st?.status ?? null }).catch(() => null)
		])
		return { phone: me.split('@')[0], name: sock.user?.name || sock.authState?.creds?.me?.name || '', status: status || '', picture }
	}
	async setProfileName(name) {
		const n = String(name || '').trim()
		if (!n) throw new Error('Escribe un nombre')
		if (n.length > 25) throw new Error('El nombre puede tener máximo 25 caracteres')
		const sock = this.requireSocket()
		await sock.updateProfileName(n)
		if (sock.user) sock.user.name = n
	}
	async setProfileStatus(text) {
		const t = String(text ?? '').trim()
		if (t.length > 139) throw new Error('La info puede tener máximo 139 caracteres')
		await this.requireSocket().updateProfileStatus(t)
	}
	/** La foto ya llega recortada en cuadro y en JPEG desde la app */
	async setProfilePhoto(jpeg) {
		if (!Buffer.isBuffer(jpeg) || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('La foto debe ser JPG')
		const sock = this.requireSocket()
		await sock.query({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'w:profile:picture' }, content: [{ tag: 'picture', attrs: { type: 'image' }, content: jpeg }] })
	}
	async removeProfilePhoto() {
		const sock = this.requireSocket()
		await sock.removeProfilePicture(jidNormalizedUser(sock.user.id))
	}

	applyEdit(id, content) {
		const d = describe(normalizeMessageContent(content))
		if (!d?.text) return
		stmt.setText.run(d.text, this.accountId, id)
		const row = stmt.getMessage.get(this.accountId, id)
		if (row) this.manager.emit('event', { type: 'message', data: this.manager.formatMessage(row) })
	}

	saveMessage(m, live) {
		const key = m.key
		if (!key?.remoteJid || !m.message) return
		const remote = jidNormalizedUser(key.remoteJid)
		if (isJidBroadcast(remote) || isJidNewsletter(remote)) return
		const content = normalizeMessageContent(m.message)
		if (!content) return

		const proto = content.protocolMessage
		if (proto?.editedMessage && proto.key?.id) return this.applyEdit(proto.key.id, proto.editedMessage)
		// "Eliminar para todos" (de tu celular o del cliente)
		if (proto && (proto.type === 0 || proto.type === 'REVOKE') && proto.key?.id) return this.applyRevoke(proto.key.id)
		if (proto) return

		const d = describe(content)
		if (!d) return

		const jid = canonicalJid(key.remoteJid, key.remoteJidAlt)
		const isGroup = isJidGroup(jid)
		const fromMe = Boolean(key.fromMe)
		const sender = fromMe ? null : isGroup ? canonicalJid(key.participant, key.participantAlt) : jid
		const ts = toMs(m.messageTimestamp)
		// Chat entre tus propios números (calentamiento): sin notificación, sin asistente y archivado
		const internal = isOwnJid(jid)

		if (!fromMe && !isGroup && m.pushName) stmt.upsertContact.run({ jid, name: null, notify: m.pushName })
		if (isGroup && live) this.groupName(jid)

		const row = {
			account_id: this.accountId,
			id: key.id,
			jid,
			remote_jid: key.remoteJid,
			participant: key.participant || null,
			from_me: fromMe ? 1 : 0,
			sender,
			sender_name: fromMe ? null : m.pushName || null,
			ts,
			type: d.type,
			text: d.text ?? null,
			media_mime: d.media_mime ?? null,
			file_name: d.file_name ?? null,
			status: fromMe ? Number(m.status ?? 1) : 0,
			raw: MEDIA_TYPES[getContentType(content)] ? JSON.stringify(m, (k, v) => (k === 'jpegThumbnail' || k === 'thumbnailDirectPath' ? undefined : BufferJSON.replacer(k, v))) : null
		}
		const inserted = stmt.insertMessage.run(row).changes > 0
		// El estado de error puede llegar fusionado en el mismo evento del mensaje ya guardado
		if (!inserted && fromMe && typeof m.status === 'number') {
			if (m.status === 0) {
				note(this.accountId, 'status', `0 ${JSON.stringify(m.messageStubParameters || '')}`)
				stmt.forceStatus.run(0, this.accountId, key.id)
				this.rejectionAlert()
			} else {
				stmt.setStatus.run(m.status, this.accountId, key.id)
			}
			const saved = stmt.getMessage.get(this.accountId, key.id)
			if (saved) this.manager.emit('event', { type: 'message.status', data: { accountId: this.accountId, id: key.id, status: saved.status } })
		}
		stmt.upsertChat.run({
			account_id: this.accountId,
			jid,
			name: null,
			unread: inserted && live && !fromMe && !internal ? 1 : 0,
			last_ts: ts
		})
		if (!inserted) return
		if (internal) stmt.archiveChat.run(this.accountId, jid)
		// Si contestaste (desde la app o el teléfono), el chat ya está leído
		if (fromMe) stmt.setChatUnread.run(0, this.accountId, jid)

		const formatted = this.manager.formatMessage(stmt.getMessage.get(this.accountId, key.id))
		this.manager.emit('event', { type: 'message', data: formatted })
		this.manager.emit('event', { type: 'conversation.update', data: this.manager.conversation(this.accountId, jid) })

		if (live && !fromMe && !internal) {
			// Fotos, audios y stickers se descargan al llegar; videos y documentos solo cuando se abren, para no llenar el disco
			if (row.raw && ['image', 'audio', 'sticker'].includes(row.type)) this.downloadMedia(key.id).catch(() => {})
			// Baja: el contacto pide no recibir más mensajes de los envíos masivos
			if (!isGroup && row.type === 'text' && /^\s*(baja|stop|alto|no molestar)\s*[.!]*\s*$/i.test(row.text || '')) {
				db.prepare('INSERT OR REPLACE INTO optouts (phone, at) VALUES (?, ?)').run(jid.split('@')[0], Date.now())
				note(this.accountId, 'optout')
				this.send(jid, { text: 'Listo, ya no te enviaremos más mensajes. Gracias.' }).catch(() => {})
			}
			// Asistente: entiende la respuesta (pagó, promesa, queja, número equivocado…) y actúa solo
			let intent = null
			if (!isGroup && row.text) {
				try { intent = smartIncoming({ accountId: this.accountId, jid, msgId: key.id, text: row.text }) } catch (e) { note(this.accountId, 'smart-error', e.message) }
				if (intent) {
					this.manager.emit('event', { type: 'message', data: this.manager.formatMessage(stmt.getMessage.get(this.accountId, key.id)) })
					this.manager.emit('event', { type: 'conversation.update', data: this.manager.conversation(this.accountId, jid) })
				}
			}
			const conv = this.manager.conversation(this.accountId, jid)
			const account = stmt.getAccount.get(this.accountId)
			if (!conv?.muted) sendPush({
				title: `${intent ? INTENTS[intent].tag + ' · ' : ''}${conv?.name || jid.split('@')[0]} · ${account?.name}`,
				body: (isGroup && row.sender_name ? `${row.sender_name}: ` : '') + preview(row),
				jid: `${this.accountId}:${jid}`,
				badge: this.manager.totalUnread()
			})
		}
	}

	/** Descarga (o reutiliza) el archivo de un mensaje multimedia y devuelve la ruta local */
	async downloadMedia(id) {
		const row = stmt.getMessage.get(this.accountId, id)
		if (!row) throw new Error('Mensaje no encontrado')
		if (row.media_path && fs.existsSync(row.media_path)) return row
		if (!row.raw) throw new Error('El mensaje no tiene multimedia')
		const msg = JSON.parse(row.raw, BufferJSON.reviver)
		const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
			logger,
			reuploadRequest: this.sock?.updateMediaMessage
		})
		const file = this.writeMedia(id, buffer, row.media_mime, row.file_name)
		stmt.setMedia.run(file, this.accountId, id)
		this.manager.emit('event', { type: 'message', data: this.manager.formatMessage(stmt.getMessage.get(this.accountId, id)) })
		return stmt.getMessage.get(this.accountId, id)
	}

	writeMedia(id, buffer, mime, fileName) {
		const dir = path.join(MEDIA_DIR, String(this.accountId))
		fs.mkdirSync(dir, { recursive: true })
		const base = (mime || '').split(';')[0]
		const ext = EXT[base] || path.extname(fileName || '').slice(1) || base.split('/')[1] || 'bin'
		const file = path.join(dir, `${safe(id)}.${safe(ext)}`)
		fs.writeFileSync(file, buffer)
		return file
	}

	/** Código de 8 caracteres para vincular desde WhatsApp › Dispositivos vinculados › Vincular con número */
	async pairingCode(phone) {
		const digits = String(phone).replace(/\D/g, '')
		if (!digits) throw new Error('Número inválido')
		if (!this.sock || this.status !== 'qr') throw new Error('La cuenta debe estar esperando vinculación')
		if (this.sock.authState.creds.registered) throw new Error('La cuenta ya está vinculada')
		return this.sock.requestPairingCode(digits)
	}

	requireSocket() {
		if (!this.sock || this.status !== 'connected') throw new Error('Esta cuenta no está conectada')
		return this.sock
	}

	async send(jid, content, localMedia, opts) {
		const sock = this.requireSocket()
		let sent
		try {
			sent = await sock.sendMessage(jid, content, opts)
		} catch (e) {
			note(this.accountId, 'send-error', e.message)
			throw e
		}
		note(this.accountId, 'sent', Object.keys(content)[0])
		this.saveMessage(sent, false)
		if (localMedia) {
			const file = this.writeMedia(sent.key.id, localMedia.buffer, localMedia.mime, localMedia.fileName)
			stmt.setMedia.run(file, this.accountId, sent.key.id)
		}
		return this.manager.formatMessage(stmt.getMessage.get(this.accountId, sent.key.id))
	}

	async markRead(jid) {
		stmt.setChatUnread.run(0, this.accountId, jid)
		if (!this.sock || this.status !== 'connected') return
		const rows = db.prepare(`
			SELECT id, remote_jid, participant FROM messages
			WHERE account_id = ? AND jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT 20`).all(this.accountId, jid)
		if (!rows.length) return
		await this.sock.readMessages(rows.map(r => ({
			remoteJid: r.remote_jid, id: r.id, participant: r.participant || undefined, fromMe: false
		}))).catch(() => {})
	}

	// Foto de perfil del contacto (URL del CDN de WhatsApp)
	// «Info.» (estado) y perfil de empresa de un contacto
	async contactAbout(jid) {
		if (!this.sock || this.status !== 'connected') return {}
		const [about, biz] = await Promise.all([
			this.sock.fetchStatus(jid).then(list => { const st = list?.[0]?.status; return typeof st === 'string' ? st : st?.status ?? null }).catch(() => null),
			this.sock.getBusinessProfile ? this.sock.getBusinessProfile(jid).catch(() => null) : null
		])
		return { about: about || null, business: biz ? { description: biz.description || null, email: biz.email || null, website: [].concat(biz.website || []).filter(Boolean), address: biz.address || null, category: biz.category || null } : null }
	}

	async profilePictureUrl(jid) {
		if (!this.sock || this.status !== 'connected') return null
		try { return await this.sock.profilePictureUrl(jid, 'image') } catch { return null }
	}

	// Presencia ("en línea", "escribiendo…") para que el calentamiento se vea natural
	async setPresence(jid, state) {
		if (!this.sock || this.status !== 'connected') return
		try { await this.sock.sendPresenceUpdate(state, jid) } catch {}
	}

	// "En línea" un rato (como quien abre WhatsApp) y luego vuelve a desconectado.
	// Si ya estaba en línea, solo alarga el tiempo.
	async online(ms = 45000) {
		if (!this.sock || this.status !== 'connected') return
		if (!this.offlineTimer) { try { await this.sock.sendPresenceUpdate('available') } catch {} }
		clearTimeout(this.offlineTimer)
		this.offlineTimer = setTimeout(() => {
			this.offlineTimer = null
			if (this.sock && this.status === 'connected') this.sock.sendPresenceUpdate('unavailable').catch(() => {})
		}, ms)
	}

	// ---- Para el calentamiento: estados y grupo entre tus números ----
	// Estado visible SOLO para tus números vinculados: la lista de quién lo recibe se arma aquí y solo admite
	// números que son cuentas de esta app. Ningún contacto o cliente recibe el estado (ni puede verlo).
	async postStatus(content, jids, opts = {}) {
		const sock = this.requireSocket()
		const me = jidNormalizedUser(sock.user.id)
		const list = [...new Set((jids || []).map(j => jidNormalizedUser(j)))].filter(j => j && j !== me && isPnUser(j) && isOwnJid(j))
		if (!list.length || list.length !== new Set(jids).size) throw new Error('Estado cancelado: solo se publica para tus números vinculados')
		const sent = await sock.sendMessage('status@broadcast', content, { ...opts, statusJidList: list, broadcast: true })
		return { id: sent?.key?.id, from: jidNormalizedUser(sock.user.id) }
	}
	async viewStatus(posterJid, id) {
		if (!this.sock || this.status !== 'connected') return
		await this.sock.readMessages([{ remoteJid: 'status@broadcast', id, participant: posterJid, fromMe: false }]).catch(() => {})
	}
	async createGroup(subject, jids) {
		const g = await this.requireSocket().groupCreate(subject, jids)
		return g?.id
	}
	async addToGroup(gid, jids) {
		await this.requireSocket().groupParticipantsUpdate(gid, jids, 'add')
	}
	async recording(jid, ms) {
		if (!this.sock || this.status !== 'connected') return
		try { await this.sock.sendPresenceUpdate('recording', jid) } catch {}
		await new Promise(r => setTimeout(r, ms))
		try { await this.sock.sendPresenceUpdate('paused', jid) } catch {}
	}
	myJid() { return this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id) : null }

	// Reacciona (emoji) al último mensaje recibido en una conversación (para el calentamiento)
	async reactLast(jid, emoji) {
		if (!this.sock || this.status !== 'connected') return false
		const row = db.prepare('SELECT id, remote_jid, participant FROM messages WHERE account_id = ? AND jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT 1').get(this.accountId, jid)
		if (!row) return false
		try {
			await this.sock.sendMessage(row.remote_jid, { react: { text: emoji, key: { remoteJid: row.remote_jid, id: row.id, fromMe: false, participant: row.participant || undefined } } })
			return true
		} catch { return false }
	}

	async stop() {
		this.stopped = true
		try { this.sock?.end(undefined) } catch {}
		this.sock = null
	}

	async logout() {
		this.stopped = true
		try { await this.sock?.logout() } catch {}
		this.sock = null
		clearAuth(this.accountId, this.authDir)
		this.qr = null
		this.userLogout = true
		markUnlinked(this.accountId)
		this.setStatus('logged_out')
	}
}

export class SessionManager extends EventEmitter {
	constructor() {
		super()
		this.sessions = new Map()
	}

	async startAll() {
		for (const { id } of db.prepare('SELECT id FROM accounts').all()) {
			// Solo se reconectan automáticamente las cuentas ya vinculadas
			if (stmt.getAccount.get(id)?.kind === 'cloud') {
				await this.start(id).catch(e => note(id, 'start-error', e.message))
				continue
			}
			const linked = hasAuth(id, path.join(AUTH_DIR, String(id)))
			note(id, 'boot', linked ? 'linked' : 'not-linked')
			if (linked) {
				await this.start(id).catch(e => logger.error(e))
			} else {
				stmt.setAccount.run('logged_out', null, id)
			}
		}
	}

	async start(accountId) {
		let s = this.sessions.get(accountId)
		const isCloud = stmt.getAccount.get(accountId)?.kind === 'cloud'
		if (!s) {
			s = isCloud ? new CloudSession(this, accountId) : new Session(this, accountId)
			this.sessions.set(accountId, s)
		}
		if (isCloud) await s.start()
		else if (!s.sock) await s.start()
		return s
	}

	get(accountId) {
		const s = this.sessions.get(accountId)
		if (!s) throw new Error('Esta cuenta no está conectada')
		return s
	}

	async remove(accountId) {
		const s = this.sessions.get(accountId)
		if (s) await s.logout()
		this.sessions.delete(accountId)
		fs.rmSync(path.join(MEDIA_DIR, String(accountId)), { recursive: true, force: true })
	}

	accountInfo(id) {
		const a = stmt.getAccount.get(id)
		if (!a) return null
		const s = this.sessions.get(id)
		const info = { id: a.id, name: a.name, color: a.color, phone: a.phone, status: s?.status || a.status, qr: s?.qr || null, kind: a.kind || 'baileys' }
		if (a.kind !== 'cloud') {
			info.health = accountHealth(id, info.status)
			info.reserve = Boolean(a.reserve)
		}
		if (a.kind === 'cloud') {
			const cfg = JSON.parse(a.cloud || '{}')
			info.error = s?.error || null
			info.cloud = {
				phoneNumberId: cfg.phoneNumberId,
				wabaId: cfg.wabaId,
				hasSecret: Boolean(cfg.appSecret),
				dailyLimit: cfg.dailyLimit || 250,
				displayName: s?.info?.verified_name || null,
				nameStatus: s?.info?.name_status || null,
				quality: s?.info?.quality_rating || null,
				tier: s?.info?.messaging_limit_tier || null
			}
		}
		return info
	}

	accounts() {
		return db.prepare('SELECT id FROM accounts ORDER BY id').all().map(r => this.accountInfo(r.id))
	}

	formatMessage(r) {
		return {
			id: r.id,
			accountId: r.account_id,
			jid: r.jid,
			fromMe: Boolean(r.from_me),
			sender: r.sender,
			senderName: r.sender_name,
			ts: r.ts,
			type: r.type,
			text: r.text,
			mime: r.media_mime,
			fileName: r.file_name,
			hasMedia: Boolean(r.raw || r.media_path),
			error: r.error || null,
			status: r.status,
			edited: Boolean(r.edited),
			intent: r.intent || null,
			suggestion: r.suggestion || null,
			deleted: Boolean(r.deleted)
		}
	}

	/** Cada conversación es la combinación cuenta + contacto; la clave es "cuenta:jid" */
	conversations({ accountId, labelId, unread, q, archived, limit = 500 } = {}) {
		const where = ['(c.last_ts > 0 OR c.unread > 0)', archived ? 'c.archived = 1' : 'c.archived = 0']
		const params = {}
		if (accountId) { where.push('c.account_id = @accountId'); params.accountId = accountId }
		if (labelId) { where.push(`(c.account_id || ':' || c.jid) IN (SELECT jid FROM conversation_labels WHERE label_id = @labelId)`); params.labelId = labelId }
		if (unread) where.push('c.unread > 0')
		if (q) {
			where.push('(c.jid LIKE @q OR c.name LIKE @q OR ct.name LIKE @q OR ct.notify LIKE @q)')
			params.q = `%${q}%`
		}
		const rows = db.prepare(`
			SELECT c.account_id, c.jid, c.last_ts, c.unread, c.archived, c.avatar_url, COALESCE(ct.name, c.name, ct.notify) AS name
			FROM chats c LEFT JOIN contacts ct ON ct.jid = c.jid
			WHERE ${where.join(' AND ')}
			ORDER BY c.last_ts DESC
			LIMIT ${Number(limit)}`).all(params)
		return rows.map(r => this.formatConversation(r))
	}

	conversation(accountId, jid) {
		const r = db.prepare(`
			SELECT c.account_id, c.jid, c.last_ts, c.unread, c.archived, c.avatar_url, COALESCE(ct.name, c.name, ct.notify) AS name
			FROM chats c LEFT JOIN contacts ct ON ct.jid = c.jid
			WHERE c.account_id = ? AND c.jid = ?`).get(accountId, jid)
		return r ? this.formatConversation(r) : null
	}

	// Archiva / desarchiva una conversación
	setArchived(accountId, jid, archived) {
		db.prepare('UPDATE chats SET archived = ? WHERE account_id = ? AND jid = ?').run(archived ? 1 : 0, accountId, jid)
		const conv = this.conversation(accountId, jid)
		this.emit('event', { type: 'conversation.update', data: conv })
		return conv
	}

	// Borra una conversación (mensajes, chat, notas, recordatorios y etiquetas)
	deleteConversation(accountId, jid) {
		const key = `${accountId}:${jid}`
		db.transaction(() => {
			db.prepare('DELETE FROM messages WHERE account_id = ? AND jid = ?').run(accountId, jid)
			db.prepare('DELETE FROM chats WHERE account_id = ? AND jid = ?').run(accountId, jid)
			db.prepare('DELETE FROM conversation_notes WHERE conv_key = ?').run(key)
			db.prepare('DELETE FROM reminders WHERE conv_key = ?').run(key)
			db.prepare('DELETE FROM conversation_labels WHERE jid = ?').run(key)
		})()
		this.emit('event', { type: 'conversation.removed', data: { key } })
		return { ok: true }
	}

	/** Todo lo que se sabe de un cliente, para la pantalla «Info. del contacto» */
	async contactInfo(accountId, jid) {
		const key = `${accountId}:${jid}`
		const phone = jid.split('@')[0]
		const contact = db.prepare('SELECT name, notify FROM contacts WHERE jid = ?').get(jid) || {}
		const s = this.sessions.get(accountId)
		const [picture, extra] = await Promise.all([
			this.avatarUrl(accountId, jid).catch(() => null),
			s?.contactAbout ? s.contactAbout(jid).catch(() => ({})) : {}
		])
		const counts = db.prepare(`SELECT SUM(from_me = 1) sent, SUM(from_me = 0) received, MIN(ts) first, MAX(CASE WHEN from_me = 0 THEN ts END) lastIn
			FROM messages WHERE account_id = ? AND jid = ?`).get(accountId, jid)
		const media = db.prepare(`SELECT id, type, file_name, media_mime, ts, text FROM messages WHERE account_id = ? AND jid = ? AND deleted IS NOT 1
			AND type IN ('image', 'video', 'document', 'audio') ORDER BY ts DESC LIMIT 60`).all(accountId, jid)
		const links = db.prepare(`SELECT COUNT(*) n FROM messages WHERE account_id = ? AND jid = ? AND text LIKE '%http%'`).get(accountId, jid).n
		let promises = []
		try { promises = db.prepare('SELECT at, amount, status, text FROM promises WHERE conv_key = ? ORDER BY created_at DESC LIMIT 20').all(key) } catch {}
		const reminders = db.prepare('SELECT id, at, text FROM reminders WHERE conv_key = ? AND done = 0 ORDER BY at').all(key)
		const optedOut = Boolean(db.prepare('SELECT 1 FROM optouts WHERE phone = ?').get(phone))
		let campaigns = []
		try {
			campaigns = db.prepare(`SELECT c.name, i.status, i.sent_at FROM campaign_items i JOIN campaigns c ON c.id = i.campaign_id
				WHERE i.phone = ? OR i.phone = ? ORDER BY i.id DESC LIMIT 10`).all(phone, phone.replace(/^521/, '52'))
		} catch {}
		const others = db.prepare('SELECT account_id FROM chats WHERE jid = ? AND account_id != ?').all(jid, accountId).map(r => r.account_id)
		return {
			key, accountId, jid, phone, picture,
			name: this.conversation(accountId, jid)?.name || contact.name || null,
			pushName: contact.notify || null,
			about: extra.about || null,
			business: extra.business || null,
			stats: { sent: counts.sent || 0, received: counts.received || 0, first: counts.first || null, lastIn: counts.lastIn || null, links },
			media: media.map(m => ({ id: m.id, type: m.type, fileName: m.file_name, mime: m.media_mime, ts: m.ts, caption: m.text })),
			promises, reminders, optedOut, campaigns, otherAccounts: others
		}
	}

	// Devuelve la URL de la foto de perfil, guardándola en caché un día
	async avatarUrl(accountId, jid) {
		const row = db.prepare('SELECT avatar_url, avatar_ts FROM chats WHERE account_id = ? AND jid = ?').get(accountId, jid)
		if (row && row.avatar_ts && Date.now() - row.avatar_ts < 864e5) return row.avatar_url || null
		const s = this.sessions.get(accountId)
		const url = s ? await s.profilePictureUrl(jid).catch(() => null) : null
		try { db.prepare('UPDATE chats SET avatar_url = ?, avatar_ts = ? WHERE account_id = ? AND jid = ?').run(url, Date.now(), accountId, jid) } catch {}
		return url
	}

	formatConversation(r) {
		const key = `${r.account_id}:${r.jid}`
		const last = db.prepare('SELECT * FROM messages WHERE account_id = ? AND jid = ? ORDER BY ts DESC LIMIT 1').get(r.account_id, r.jid)
		const labels = db.prepare('SELECT label_id FROM conversation_labels WHERE jid = ?').all(key).map(l => l.label_id)
		const note = db.prepare('SELECT text FROM conversation_notes WHERE conv_key = ?').get(key)
		const reminder = db.prepare('SELECT at, text FROM reminders WHERE conv_key = ? AND done = 0 ORDER BY at LIMIT 1').get(key)
		return {
			key,
			accountId: r.account_id,
			jid: r.jid,
			name: r.name || null,
			phone: isJidGroup(r.jid) ? null : r.jid.split('@')[0],
			isGroup: Boolean(isJidGroup(r.jid)),
			lastTs: Math.max(r.last_ts, last?.ts || 0),
			lastText: preview(last),
			lastFromMe: Boolean(last?.from_me),
			lastId: last?.id || null,
			lastStatus: last?.from_me ? (last.status ?? null) : null,
			unread: r.unread || 0,
			archived: Boolean(r.archived),
			muted: Boolean(r.muted),
			hasAvatar: Boolean(r.avatar_url),
			labelIds: labels,
			note: note?.text || null,
			reminder: reminder ? { at: reminder.at, text: reminder.text } : null
		}
	}

	messages(accountId, jid, { before, limit = 50 } = {}) {
		const rows = db.prepare(`
			SELECT * FROM messages WHERE account_id = @accountId AND jid = @jid ${before ? 'AND ts < @before' : ''}
			ORDER BY ts DESC LIMIT @limit`).all({ accountId, jid, before: Number(before) || 0, limit: Number(limit) })
		return rows.reverse().map(r => this.formatMessage(r))
	}

	totalUnread() {
		return db.prepare('SELECT COALESCE(SUM(unread), 0) AS n FROM chats').get().n
	}

	async markRead(accountId, jid) {
		const s = this.sessions.get(accountId)
		if (s) await s.markRead(jid)
		else stmt.setChatUnread.run(0, accountId, jid)
		this.emit('event', { type: 'conversation.update', data: this.conversation(accountId, jid) })
	}

	/** Resuelve un número de teléfono a JID verificando que tenga WhatsApp */
	async resolvePhone(accountId, phone) {
		const session = this.get(accountId)
		if (session instanceof CloudSession) return `${normalizePhone(phone)}@s.whatsapp.net`
		const digits = String(phone).replace(/\D/g, '')
		if (!digits) throw new Error('Número inválido')
		const sock = session.requireSocket()
		const [res] = (await sock.onWhatsApp(digits)) || []
		if (!res?.exists) throw new Error('Ese número no tiene WhatsApp')
		return canonicalJid(res.jid)
	}
}
