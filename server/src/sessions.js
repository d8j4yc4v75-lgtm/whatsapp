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
	normalizeMessageContent,
	useMultiFileAuthState
} from 'baileys'
import { db } from './db.js'
import { DATA_DIR } from './config.js'
import { sendPush } from './push.js'

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

const stmt = {
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
	setText: db.prepare('UPDATE messages SET text = ? WHERE account_id = ? AND id = ?'),
	getMessage: db.prepare('SELECT * FROM messages WHERE account_id = ? AND id = ?'),
	upsertContact: db.prepare(`
		INSERT INTO contacts (jid, name, notify) VALUES (@jid, @name, @notify)
		ON CONFLICT (jid) DO UPDATE SET
			name = COALESCE(excluded.name, contacts.name),
			notify = COALESCE(excluded.notify, contacts.notify)`),
	setLid: db.prepare('INSERT OR REPLACE INTO lid_map (lid, pn) VALUES (?, ?)'),
	getLid: db.prepare('SELECT pn FROM lid_map WHERE lid = ?'),
	setAccount: db.prepare('UPDATE accounts SET status = ?, phone = COALESCE(?, phone) WHERE id = ?'),
	getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?')
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
		this.status = status
		stmt.setAccount.run(status, phone, this.accountId)
		this.manager.emit('event', { type: 'account.update', data: this.manager.accountInfo(this.accountId) })
	}

	async start() {
		this.stopped = false
		const { state, saveCreds } = await useMultiFileAuthState(this.authDir)
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
				if (typeof update.status === 'number') {
					note(this.accountId, 'status', `${update.status} ${JSON.stringify(update.messageStubParameters || '')}`)
					if (update.status === 0) stmt.forceStatus.run(0, this.accountId, key.id)
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
			this.setStatus('connected', phone)
		}
		if (connection === 'close') {
			const code = lastDisconnect?.error?.output?.statusCode
			note(this.accountId, 'close', `${code} ${lastDisconnect?.error?.message || ''} ${JSON.stringify(lastDisconnect?.error?.data || '')}`)
			this.sock = null
			if (this.stopped) return
			if (code === DisconnectReason.loggedOut) {
				// A veces WhatsApp responde 401 de forma pasajera: se reintenta una vez antes de dar la sesión por cerrada
				const registered = fs.existsSync(path.join(this.authDir, 'creds.json'))
				if (registered && (this.loggedOutRetries || 0) < 1) {
					this.loggedOutRetries = (this.loggedOutRetries || 0) + 1
					this.setStatus('reconnecting')
					setTimeout(() => !this.stopped && this.start().catch(e => note(this.accountId, 'start-error', e.message)), 5000)
					return
				}
				// Se guarda una copia por si hace falta revisarla, en lugar de borrarla
				if (fs.existsSync(this.authDir)) {
					fs.renameSync(this.authDir, `${this.authDir}-logout-${Date.now()}`)
				}
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
		if (proto) return

		const d = describe(content)
		if (!d) return

		const jid = canonicalJid(key.remoteJid, key.remoteJidAlt)
		const isGroup = isJidGroup(jid)
		const fromMe = Boolean(key.fromMe)
		const sender = fromMe ? null : isGroup ? canonicalJid(key.participant, key.participantAlt) : jid
		const ts = toMs(m.messageTimestamp)

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
			raw: MEDIA_TYPES[getContentType(content)] ? JSON.stringify(m, BufferJSON.replacer) : null
		}
		const inserted = stmt.insertMessage.run(row).changes > 0
		// El estado de error puede llegar fusionado en el mismo evento del mensaje ya guardado
		if (!inserted && fromMe && typeof m.status === 'number') {
			if (m.status === 0) {
				note(this.accountId, 'status', `0 ${JSON.stringify(m.messageStubParameters || '')}`)
				stmt.forceStatus.run(0, this.accountId, key.id)
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
			unread: inserted && live && !fromMe ? 1 : 0,
			last_ts: ts
		})
		if (!inserted) return

		const formatted = this.manager.formatMessage(stmt.getMessage.get(this.accountId, key.id))
		this.manager.emit('event', { type: 'message', data: formatted })
		this.manager.emit('event', { type: 'conversation.update', data: this.manager.conversation(this.accountId, jid) })

		if (live && !fromMe) {
			if (row.raw) this.downloadMedia(key.id).catch(() => {})
			const conv = this.manager.conversation(this.accountId, jid)
			const account = stmt.getAccount.get(this.accountId)
			sendPush({
				title: `${conv?.name || jid.split('@')[0]} · ${account?.name}`,
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

	async send(jid, content, localMedia) {
		const sock = this.requireSocket()
		let sent
		try {
			sent = await sock.sendMessage(jid, content)
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

	async stop() {
		this.stopped = true
		try { this.sock?.end(undefined) } catch {}
		this.sock = null
	}

	async logout() {
		this.stopped = true
		try { await this.sock?.logout() } catch {}
		this.sock = null
		fs.rmSync(this.authDir, { recursive: true, force: true })
		this.qr = null
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
			const linked = fs.existsSync(path.join(AUTH_DIR, String(id), 'creds.json'))
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
		if (!s) {
			s = new Session(this, accountId)
			this.sessions.set(accountId, s)
		}
		if (!s.sock) await s.start()
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
		return { id: a.id, name: a.name, color: a.color, phone: a.phone, status: s?.status || a.status, qr: s?.qr || null }
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
			status: r.status
		}
	}

	/** Cada conversación es la combinación cuenta + contacto; la clave es "cuenta:jid" */
	conversations({ accountId, labelId, unread, q, limit = 500 } = {}) {
		const where = ['(c.last_ts > 0 OR c.unread > 0)']
		const params = {}
		if (accountId) { where.push('c.account_id = @accountId'); params.accountId = accountId }
		if (labelId) { where.push(`(c.account_id || ':' || c.jid) IN (SELECT jid FROM conversation_labels WHERE label_id = @labelId)`); params.labelId = labelId }
		if (unread) where.push('c.unread > 0')
		if (q) {
			where.push('(c.jid LIKE @q OR c.name LIKE @q OR ct.name LIKE @q OR ct.notify LIKE @q)')
			params.q = `%${q}%`
		}
		const rows = db.prepare(`
			SELECT c.account_id, c.jid, c.last_ts, c.unread, COALESCE(ct.name, c.name, ct.notify) AS name
			FROM chats c LEFT JOIN contacts ct ON ct.jid = c.jid
			WHERE ${where.join(' AND ')}
			ORDER BY c.last_ts DESC
			LIMIT ${Number(limit)}`).all(params)
		return rows.map(r => this.formatConversation(r))
	}

	conversation(accountId, jid) {
		const r = db.prepare(`
			SELECT c.account_id, c.jid, c.last_ts, c.unread, COALESCE(ct.name, c.name, ct.notify) AS name
			FROM chats c LEFT JOIN contacts ct ON ct.jid = c.jid
			WHERE c.account_id = ? AND c.jid = ?`).get(accountId, jid)
		return r ? this.formatConversation(r) : null
	}

	formatConversation(r) {
		const key = `${r.account_id}:${r.jid}`
		const last = db.prepare('SELECT * FROM messages WHERE account_id = ? AND jid = ? ORDER BY ts DESC LIMIT 1').get(r.account_id, r.jid)
		const labels = db.prepare('SELECT label_id FROM conversation_labels WHERE jid = ?').all(key).map(l => l.label_id)
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
			unread: r.unread || 0,
			labelIds: labels
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
		const digits = String(phone).replace(/\D/g, '')
		if (!digits) throw new Error('Número inválido')
		const sock = this.get(accountId).requireSocket()
		const [res] = (await sock.onWhatsApp(digits)) || []
		if (!res?.exists) throw new Error('Ese número no tiene WhatsApp')
		return canonicalJid(res.jid)
	}
}
