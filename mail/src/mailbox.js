import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import { db } from './db.js'
import { DATA_DIR } from './config.js'
import { sendPush } from './push.js'
import { optOut } from './campaigns.js'
import { classify, freshText, isBounce, promisedDate, amountOf } from './classify.js'
import { imapAccessToken, apiSend, OAUTH } from './oauth.js'

export const ATTACH_DIR = path.join(DATA_DIR, 'attachments')
const SYNC_LIMIT = 60 // correos recientes que se guardan por cuenta

const addr = a => (a ? { name: a.name || '', address: (a.address || '').toLowerCase() } : null)
const addrList = list => (list?.value || []).map(addr).filter(Boolean)
const fmtAddrs = list => addrList(list).map(a => a.name ? `${a.name} <${a.address}>` : a.address)
// Agrupa por asunto normalizado para juntar la conversación (como un hilo)
const normSubject = s => String(s || '(sin asunto)').replace(/^((re|fwd|rv|fw)\s*:\s*)+/i, '').trim().toLowerCase()
const safe = s => String(s).replace(/[^A-Za-z0-9._-]/g, '_')
const snippetOf = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140)

const stmt = {
	account: db.prepare('SELECT * FROM accounts WHERE id = ?'),
	setStatus: db.prepare('UPDATE accounts SET status = ?, error = ? WHERE id = ?'),
	exists: db.prepare('SELECT seen FROM messages WHERE account_id = ? AND uid = ? AND folder = ?'),
	insert: db.prepare(`INSERT OR REPLACE INTO messages
		(account_id, uid, message_id, thread_key, folder, from_name, from_addr, to_addrs, cc_addrs, subject, snippet, body_text, body_html, ts, seen, flagged, answered, from_me, has_attachments, attachments)
		VALUES (@account_id, @uid, @message_id, @thread_key, @folder, @from_name, @from_addr, @to_addrs, @cc_addrs, @subject, @snippet, @body_text, @body_html, @ts, @seen, @flagged, @answered, @from_me, @has_attachments, @attachments)`),
	setIntent: db.prepare('UPDATE messages SET intent = ? WHERE account_id = ? AND uid = ? AND folder = ?'),
	promise: db.prepare('INSERT OR REPLACE INTO mail_promises (account_id, thread_key, email, due_at, due_text, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
	clearPromise: db.prepare('DELETE FROM mail_promises WHERE account_id = ? AND thread_key = ?'),
	setSeen: db.prepare('UPDATE messages SET seen = ? WHERE account_id = ? AND uid = ? AND folder = ?'),
	get: db.prepare('SELECT * FROM messages WHERE account_id = ? AND uid = ? AND folder = ?')
}

class Mailbox {
	constructor(manager, accountId) {
		this.manager = manager
		this.accountId = accountId
		this.status = 'connecting'
		this.stopped = false
		this.client = null
		this.retries = 0
	}

	get account() { return stmt.account.get(this.accountId) }

	setStatus(status, error = null) {
		this.status = status
		stmt.setStatus.run(status, error, this.accountId)
		this.manager.emit('event', { type: 'account.update', data: this.manager.accountInfo(this.accountId) })
	}

	async start() {
		this.stopped = false
		const a = this.account
		let auth
		if (a.provider_type === 'google' || a.provider_type === 'microsoft') {
			try { auth = { user: a.email, accessToken: await imapAccessToken(a) } }
			catch (e) { this.setStatus('error', `No se pudo renovar el permiso de ${OAUTH[a.provider_type].label}. Vuelve a conectar la cuenta. (${e.message})`); if (!this.stopped) this.scheduleReconnect(); return }
		} else {
			auth = { user: a.user, pass: a.pass }
		}
		const host = a.imap_host || (a.provider_type !== 'password' ? OAUTH[a.provider_type].imapHost : '')
		const client = new ImapFlow({
			host,
			port: a.imap_port || 993,
			secure: (a.imap_port || 993) === 993,
			auth,
			logger: false,
			emitLogs: false
		})
		this.client = client
		this.setStatus('connecting')
		client.on('error', () => {})
		try {
			await client.connect()
		} catch (e) {
			this.client = null
			const msg = /auth/i.test(e.message || '') ? 'Usuario o contraseña incorrectos. Si tienes verificación en dos pasos, usa una «contraseña de aplicación».' : e.message
			this.setStatus('error', msg)
			if (!this.stopped) this.scheduleReconnect()
			return
		}
		this.retries = 0
		this.setStatus('connected')
		await this.sync().catch(() => {})
		this.idleLoop()
	}

	async sync() {
		const client = this.client
		if (!client) return
		const lock = await client.getMailboxLock('INBOX')
		try {
			const total = client.mailbox.exists
			if (!total) return
			const from = Math.max(1, total - SYNC_LIMIT + 1)
			const me = this.account.email.toLowerCase()
			let changed = false
			let newest = null
			const bounces = []
			for await (const msg of client.fetch(`${from}:*`, { uid: true, envelope: true, flags: true, bodyStructure: true, source: true })) {
				const prev = stmt.exists.get(this.accountId, msg.uid, 'INBOX')
				const parsed = await simpleParser(msg.source).catch(() => null)
				if (!parsed) continue
				const row = this.toRow(msg, parsed, me)
				// «Mail Delivery Failed» y similares: se borran solos
				if (isBounce(row)) { bounces.push(msg.uid); if (prev) { db.prepare('DELETE FROM messages WHERE account_id = ? AND uid = ? AND folder = ?').run(this.accountId, msg.uid, 'INBOX'); changed = true } continue }
				const keptIntent = prev ? db.prepare('SELECT intent FROM messages WHERE account_id = ? AND uid = ? AND folder = ?').get(this.accountId, msg.uid, 'INBOX')?.intent : null
				stmt.insert.run(row)
				changed = true
				if (!row.from_me) {
					// Qué contestó: solo el texto nuevo, sin el correo citado
					const fresh = freshText(row.body_text || (row.body_html || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '))
					const intent = prev ? keptIntent : classify(fresh)
					if (intent) stmt.setIntent.run(intent, this.accountId, msg.uid, 'INBOX')
					if (!prev && intent === 'promesa') {
						const when = promisedDate(fresh)
						if (when) stmt.promise.run(this.accountId, row.thread_key, row.from_addr, when.at, when.text, amountOf(fresh), Date.now())
					}
					if (!prev && intent === 'pagado') stmt.clearPromise.run(this.accountId, row.thread_key)
				}
				if (!prev && !row.from_me) {
					// Baja automática: el destinatario pide no recibir más correos
					if (/\bbaja\b|darme de baja|no.*(correo|mensaje)|unsubscribe/i.test(`${row.subject} ${row.body_text || ''}`.slice(0, 500))) optOut(row.from_addr)
					if (!row.seen) newest = row
				}
			}
			if (bounces.length) await this.moveToTrash(bounces, true).catch(() => {})
			if (changed) this.manager.emit('event', { type: 'inbox.changed', data: { accountId: this.accountId } })
			if (newest) this.notify(newest)
		} finally {
			lock.release()
		}
	}

	// Manda correos a la papelera del buzón (Gmail/Outlook/…). locked: ya se tiene el candado de INBOX
	async moveToTrash(uids, locked) {
		if (!this.client || !uids.length) return
		if (!this.trashPath) {
			const boxes = await this.client.list().catch(() => [])
			this.trashPath = boxes.find(b => b.specialUse === '\\Trash')?.path
				|| boxes.find(b => /^(\[gmail\]\/)?(trash|papelera|deleted items|elementos eliminados)$/i.test(b.path))?.path || null
		}
		const lock = locked ? null : await this.client.getMailboxLock('INBOX')
		try {
			const range = uids.join(',')
			if (this.trashPath) await this.client.messageMove(range, this.trashPath, { uid: true })
			else await this.client.messageDelete(range, { uid: true })
		} finally { lock?.release() }
	}

	toRow(msg, parsed, me) {
		const flags = msg.flags || new Set()
		const fromAddr = addrList(parsed.from)[0] || { name: '', address: '' }
		const attachments = (parsed.attachments || []).filter(at => at.filename).map(at => {
			const dir = path.join(ATTACH_DIR, String(this.accountId))
			fs.mkdirSync(dir, { recursive: true })
			const file = path.join(dir, `${msg.uid}-${safe(at.filename)}`)
			try { fs.writeFileSync(file, at.content) } catch {}
			return { name: at.filename, mime: at.contentType, size: at.size, path: file }
		})
		const fromMe = fromAddr.address === me ? 1 : 0
		return {
			account_id: this.accountId,
			uid: msg.uid,
			message_id: parsed.messageId || null,
			thread_key: normSubject(parsed.subject),
			folder: 'INBOX',
			from_name: fromAddr.name || fromAddr.address,
			from_addr: fromAddr.address,
			to_addrs: JSON.stringify(fmtAddrs(parsed.to)),
			cc_addrs: JSON.stringify(fmtAddrs(parsed.cc)),
			subject: parsed.subject || '(sin asunto)',
			snippet: snippetOf(parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ')),
			body_text: parsed.text || null,
			body_html: parsed.html || null,
			ts: (parsed.date || new Date()).getTime(),
			seen: flags.has('\\Seen') ? 1 : 0,
			flagged: flags.has('\\Flagged') ? 1 : 0,
			answered: flags.has('\\Answered') ? 1 : 0,
			from_me: fromMe,
			has_attachments: attachments.length ? 1 : 0,
			attachments: attachments.length ? JSON.stringify(attachments) : null
		}
	}

	async idleLoop() {
		const client = this.client
		if (!client) return
		client.on('exists', () => { this.sync().catch(() => {}) })
		try {
			while (!this.stopped && this.client === client) {
				await client.idle()
			}
		} catch {
			if (!this.stopped) { this.client = null; this.scheduleReconnect() }
		}
	}

	scheduleReconnect() {
		const delay = Math.min(60000, 5000 * 2 ** this.retries++)
		setTimeout(() => !this.stopped && this.start().catch(() => {}), delay)
	}

	notify(row) {
		const a = this.account
		sendPush({
			title: `${row.from_name} · ${a.name}`,
			body: row.subject,
			jid: row.thread_key,
			badge: this.manager.totalUnread()
		})
	}

	async markRead(uid, seen) {
		stmt.setSeen.run(seen ? 1 : 0, this.accountId, uid, 'INBOX')
		if (!this.client) return
		const lock = await this.client.getMailboxLock('INBOX')
		try {
			if (seen) await this.client.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true })
			else await this.client.messageFlagsRemove({ uid: String(uid) }, ['\\Seen'], { uid: true })
		} catch {} finally { lock.release() }
	}

	transporter(port) {
		const a = this.account
		const p = port || a.smtp_port
		return nodemailer.createTransport({
			host: a.smtp_host,
			port: p,
			secure: p === 465,
			requireTLS: p === 587,
			auth: { user: a.user, pass: a.pass },
			connectionTimeout: 20000,
			greetingTimeout: 20000
		})
	}

	// El puerto alterno: si falla el 465 por conexión, se prueba el 587 (y viceversa)
	altPort() { return this.account.smtp_port === 465 ? 587 : 465 }
	isConnErr(e) { return /timeout|ETIMEDOUT|ECONNECTION|ECONNREFUSED|ESOCKET|EDNS|getaddrinfo/i.test(`${e.code || ''} ${e.message || ''}`) }

	async withSmtp(fn) {
		try {
			return await fn(this.transporter())
		} catch (e) {
			if (!this.isConnErr(e)) throw e
			const alt = this.altPort()
			const res = await fn(this.transporter(alt))
			// Si el alterno sí jala, se guarda para la próxima
			try { db.prepare('UPDATE accounts SET smtp_port = ? WHERE id = ?').run(alt, this.accountId) } catch {}
			return res
		}
	}

	async send({ to, cc, subject, text, html, inReplyTo, references, attachments, bulk }) {
		const a = this.account
		// Cuentas de Google/Microsoft: envío por su API (puerto 443), sin SMTP
		if (a.provider_type === 'google' || a.provider_type === 'microsoft') {
			return apiSend(a, { to, cc, subject, text, html, inReplyTo, references, attachments, bulk })
		}
		// Si hay clave de Brevo, se envía por API HTTP (puerto 443): la nube no bloquea ese puerto
		if (a.brevo_key) return this.sendViaBrevo({ to, cc, subject, text, html, inReplyTo, references, attachments, bulk })
		const info = await this.withSmtp(t => t.sendMail({
			from: { name: a.name, address: a.email },
			to, cc: cc || undefined, subject, text, html,
			inReplyTo: inReplyTo || undefined,
			references: references || undefined,
			attachments: attachments || undefined,
			headers: bulk ? { 'List-Unsubscribe': `<mailto:${a.email}?subject=BAJA>` } : undefined
		}))
		return info.messageId
	}

	// Envía con la API de Brevo (https://api.brevo.com). Evita el timeout de SMTP en Railway.
	async sendViaBrevo({ to, cc, subject, text, html, attachments, bulk }) {
		const a = this.account
		const list = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim()).filter(Boolean).map(email => ({ email }))
		const body = {
			sender: { name: a.name, email: a.email },
			to: list(to),
			subject: subject || '',
			htmlContent: html || undefined,
			textContent: text || (html ? undefined : ' '),
			headers: bulk ? { 'List-Unsubscribe': `<mailto:${a.email}?subject=BAJA>` } : undefined
		}
		const ccList = list(cc)
		if (ccList.length) body.cc = ccList
		if (attachments?.length) {
			body.attachment = attachments.map(at => ({
				name: at.filename || at.name || 'adjunto',
				content: Buffer.isBuffer(at.content) ? at.content.toString('base64') : Buffer.from(at.content || '').toString('base64')
			}))
		}
		const res = await fetch('https://api.brevo.com/v3/smtp/email', {
			method: 'POST',
			headers: { 'api-key': a.brevo_key, 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(25000)
		})
		const data = await res.json().catch(() => ({}))
		if (!res.ok) throw new Error(data.message || `Brevo ${res.status}: revisa la clave API y que el remitente ${a.email} esté verificado en Brevo`)
		return data.messageId || null
	}

	async verify() {
		const a = this.account
		if (a.provider_type === 'google' || a.provider_type === 'microsoft') { await imapAccessToken(a); return }
		if (a.brevo_key) {
			const res = await fetch('https://api.brevo.com/v3/account', {
				headers: { 'api-key': a.brevo_key, accept: 'application/json' },
				signal: AbortSignal.timeout(20000)
			})
			if (!res.ok) throw new Error(`Clave de Brevo inválida (${res.status})`)
			return
		}
		await this.withSmtp(t => t.verify())
	}

	async stop() {
		this.stopped = true
		try { await this.client?.logout() } catch {}
		this.client = null
	}
}

export class MailManager extends EventEmitter {
	constructor() {
		super()
		this.boxes = new Map()
	}

	async startAll() {
		this.cleanup()
		for (const { id } of db.prepare('SELECT id FROM accounts').all()) {
			await this.start(id).catch(() => {})
		}
	}

	async start(accountId) {
		let b = this.boxes.get(accountId)
		if (!b) { b = new Mailbox(this, accountId); this.boxes.set(accountId, b) }
		if (!b.client) await b.start()
		return b
	}

	// Al arrancar: quita rebotes ya guardados y clasifica respuestas viejas
	cleanup() {
		const del = db.prepare('DELETE FROM messages WHERE account_id = ? AND uid = ? AND folder = ?')
		const set = db.prepare('UPDATE messages SET intent = ? WHERE account_id = ? AND uid = ? AND folder = ?')
		db.transaction(() => {
			for (const r of db.prepare('SELECT account_id, uid, folder, thread_key, from_addr, subject, body_text, body_html, intent, ts FROM messages WHERE from_me = 0 ORDER BY ts').all()) {
				if (isBounce(r)) { del.run(r.account_id, r.uid, r.folder); continue }
				if (r.intent == null) {
					const fresh = freshText(r.body_text || String(r.body_html || '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' '))
					const intent = classify(fresh)
					set.run(intent || '', r.account_id, r.uid, r.folder)
					// Promesas de correos que ya estaban guardados: la fecha se cuenta desde que llegó el correo
					const when = intent === 'promesa' && promisedDate(fresh, r.ts)
					if (when && when.at > Date.now() - 30 * 864e5) stmt.promise.run(r.account_id, r.thread_key, r.from_addr, when.at, when.text, amountOf(fresh), r.ts)
					if (intent === 'pagado') stmt.clearPromise.run(r.account_id, r.thread_key)
				}
			}
		})()
	}

	// Archivar / borrar / marcar no leído (varios hilos a la vez)
	setArchived(accountId, threadKey, on) {
		db.prepare('INSERT INTO thread_state (account_id, thread_key, archived_at) VALUES (?, ?, ?) ON CONFLICT(account_id, thread_key) DO UPDATE SET archived_at = excluded.archived_at')
			.run(accountId, threadKey, on ? Date.now() : null)
	}
	async deleteThread(accountId, threadKey) {
		const uids = db.prepare("SELECT uid FROM messages WHERE account_id = ? AND thread_key = ? AND folder = 'INBOX'").all(accountId, threadKey).map(r => r.uid)
		db.prepare('INSERT INTO thread_state (account_id, thread_key, deleted_at) VALUES (?, ?, ?) ON CONFLICT(account_id, thread_key) DO UPDATE SET deleted_at = excluded.deleted_at')
			.run(accountId, threadKey, Date.now())
		db.prepare('DELETE FROM messages WHERE account_id = ? AND thread_key = ?').run(accountId, threadKey)
		db.prepare('DELETE FROM mail_promises WHERE account_id = ? AND thread_key = ?').run(accountId, threadKey)
		await this.boxes.get(accountId)?.moveToTrash(uids).catch(() => {})
	}
	async markThread(accountId, threadKey, seen) {
		const box = this.boxes.get(accountId)
		const rows = seen
			? db.prepare('SELECT uid FROM messages WHERE account_id = ? AND thread_key = ? AND seen = 0 AND from_me = 0').all(accountId, threadKey)
			: db.prepare('SELECT uid FROM messages WHERE account_id = ? AND thread_key = ? AND from_me = 0 ORDER BY ts DESC LIMIT 1').all(accountId, threadKey)
		for (const { uid } of rows) {
			if (box) await box.markRead(uid, seen).catch(() => {})
			else db.prepare('UPDATE messages SET seen = ? WHERE account_id = ? AND uid = ?').run(seen ? 1 : 0, accountId, uid)
		}
	}

	get(accountId) {
		const b = this.boxes.get(accountId)
		if (!b) throw new Error('Cuenta no conectada')
		return b
	}

	async remove(accountId) {
		const b = this.boxes.get(accountId)
		if (b) await b.stop()
		this.boxes.delete(accountId)
		fs.rmSync(path.join(ATTACH_DIR, String(accountId)), { recursive: true, force: true })
	}

	accountInfo(id) {
		const a = stmt.account.get(id)
		if (!a) return null
		const b = this.boxes.get(id)
		const unread = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND seen = 0 AND from_me = 0').get(id).n
		return { id: a.id, name: a.name, color: a.color, email: a.email, status: b?.status || a.status, error: b?.error || a.error || null, unread, api: Boolean(a.brevo_key), providerType: a.provider_type || 'password' }
	}

	accounts() {
		return db.prepare('SELECT id FROM accounts ORDER BY id').all().map(r => this.accountInfo(r.id))
	}

	totalUnread() {
		return db.prepare('SELECT COUNT(*) AS n FROM messages WHERE seen = 0 AND from_me = 0').get().n
	}

	formatMessage(r, full) {
		const base = {
			id: `${r.account_id}:${r.folder}:${r.uid}`,
			accountId: r.account_id,
			uid: r.uid,
			threadKey: r.thread_key,
			from: r.from_name,
			fromAddr: r.from_addr,
			to: JSON.parse(r.to_addrs || '[]'),
			cc: JSON.parse(r.cc_addrs || '[]'),
			subject: r.subject,
			snippet: r.snippet,
			ts: r.ts,
			seen: Boolean(r.seen),
			fromMe: Boolean(r.from_me),
			hasAttachments: Boolean(r.has_attachments),
			attachments: (JSON.parse(r.attachments || '[]')).map((a, i) => ({ name: a.name, mime: a.mime, size: a.size, index: i })),
			messageId: r.message_id
		}
		if (full) {
			base.html = r.body_html
			base.text = r.body_text
		}
		return base
	}

	threads({ accountId, labelId, unread, q, limit = 400 }) {
		const where = ['NOT EXISTS (SELECT 1 FROM thread_state s WHERE s.account_id = m.account_id AND s.thread_key = m.thread_key AND s.deleted_at IS NOT NULL AND s.deleted_at >= m.ts)']
		const params = {}
		if (accountId) { where.push('m.account_id = @accountId'); params.accountId = accountId }
		if (labelId) { where.push('m.thread_key IN (SELECT thread_key FROM message_labels WHERE label_id = @labelId)'); params.labelId = labelId }
		if (q) { where.push('(m.subject LIKE @q OR m.from_name LIKE @q OR m.from_addr LIKE @q OR m.snippet LIKE @q OR m.body_text LIKE @q OR m.to_addrs LIKE @q)'); params.q = `%${q}%` }
		const rows = db.prepare(`
			SELECT m.account_id, m.thread_key,
				MAX(m.ts) AS last_ts,
				SUM(CASE WHEN m.seen = 0 AND m.from_me = 0 THEN 1 ELSE 0 END) AS unread,
				COUNT(*) AS count
			FROM messages m
			${where.length ? 'WHERE ' + where.join(' AND ') : ''}
			GROUP BY m.account_id, m.thread_key
			${unread ? 'HAVING unread > 0' : ''}
			ORDER BY last_ts DESC LIMIT ${Number(limit)}`).all(params)
		return rows.map(r => this.formatThread(r.account_id, r.thread_key, r))
	}

	formatThread(accountId, threadKey, agg) {
		const last = db.prepare('SELECT * FROM messages WHERE account_id = ? AND thread_key = ? ORDER BY ts DESC LIMIT 1').get(accountId, threadKey)
		const labels = db.prepare('SELECT label_id FROM message_labels WHERE thread_key = ?').all(threadKey).map(l => l.label_id)
		const lastIn = db.prepare('SELECT from_addr, ts, intent FROM messages WHERE account_id = ? AND thread_key = ? AND from_me = 0 ORDER BY ts DESC LIMIT 1').get(accountId, threadKey)
		const intent = db.prepare('SELECT intent FROM messages WHERE account_id = ? AND thread_key = ? AND from_me = 0 AND intent IS NOT NULL AND length(intent) > 0 ORDER BY ts DESC LIMIT 1').get(accountId, threadKey)?.intent || null
		// Respondió a un envío masivo: le escribimos desde un envío y contestó después
		const camp = lastIn && db.prepare(`SELECT c.id, c.name FROM campaign_items i JOIN campaigns c ON c.id = i.campaign_id
			WHERE i.email = ? AND i.status = 'sent' AND i.sent_at <= ? ORDER BY i.sent_at DESC LIMIT 1`).get(lastIn.from_addr, lastIn.ts)
		const st = db.prepare('SELECT archived_at FROM thread_state WHERE account_id = ? AND thread_key = ?').get(accountId, threadKey)
		const pr = db.prepare('SELECT due_at AS at, due_text AS text, amount FROM mail_promises WHERE account_id = ? AND thread_key = ?').get(accountId, threadKey)
		const lastTs = agg?.last_ts || last?.ts || 0
		return {
			email: lastIn?.from_addr || null,
			campaign: camp ? { id: camp.id, name: camp.name } : null,
			intent,
			promise: pr || null,
			archived: Boolean(st?.archived_at && st.archived_at >= lastTs),
			key: `${accountId}:${encodeURIComponent(threadKey)}`,
			accountId,
			threadKey,
			subject: last?.subject || '(sin asunto)',
			from: last?.from_me ? 'Tú' : last?.from_name,
			snippet: last?.snippet || '',
			lastTs: agg?.last_ts || last?.ts || 0,
			unread: agg?.unread ?? 0,
			count: agg?.count ?? 1,
			labelIds: labels
		}
	}

	thread(accountId, threadKey) {
		const rows = db.prepare('SELECT * FROM messages WHERE account_id = ? AND thread_key = ? ORDER BY ts').all(accountId, threadKey)
		return rows.map(r => this.formatMessage(r, true))
	}

	conversationThread(accountId, threadKey) {
		const agg = db.prepare(`SELECT MAX(ts) AS last_ts, SUM(CASE WHEN seen = 0 AND from_me = 0 THEN 1 ELSE 0 END) AS unread, COUNT(*) AS count
			FROM messages WHERE account_id = ? AND thread_key = ?`).get(accountId, threadKey)
		return this.formatThread(accountId, threadKey, agg)
	}
}
