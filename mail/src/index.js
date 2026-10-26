import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer } from 'ws'
import { db } from './db.js'
import { API_TOKEN, PORT } from './config.js'
import { MailManager } from './mailbox.js'
import { guessProvider, guessCustom, guessByMx } from './providers.js'
import { VAPID_PUBLIC_KEY, saveSubscription } from './push.js'
import { changePassword, hasPassword, login, setupPassword } from './auth.js'
import { MailCampaignRunner, optOut, isEmail } from './campaigns.js'

const STARTED_AT = new Date().toISOString()
const manager = new MailManager()
const campaigns = new MailCampaignRunner(manager)
const app = express()
app.use(express.json({ limit: '25mb' }))

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
app.use(express.static(PUBLIC_DIR, { maxAge: 0, etag: true }))

app.get('/health', (req, res) => res.json({ ok: true, volume: process.env.RAILWAY_VOLUME_MOUNT_PATH || null }))

const route = fn => async (req, res) => {
	try {
		const out = await fn(req, res)
		if (out !== undefined && !res.headersSent) res.json(out)
	} catch (e) {
		res.status(e.status || 400).json({ error: e.message })
	}
}

// ---- Acceso ----
app.get('/auth/status', (req, res) => res.json({ hasPassword: hasPassword() }))
app.post('/auth/setup', async (req, res) => {
	try { res.json({ token: setupPassword(req.body.password) }) } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/auth/login', async (req, res) => {
	try { res.json({ token: await login(req.body.password) }) } catch (e) { res.status(e.status || 400).json({ error: e.message }) }
})

const tokenOf = req => req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.query.token
app.use('/api', (req, res, next) => {
	if (tokenOf(req) !== API_TOKEN) return res.status(401).json({ error: 'Token inválido' })
	next()
})

const accountParam = req => {
	const id = Number(req.params.id ?? req.body.accountId ?? req.query.accountId)
	if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) throw Object.assign(new Error('Cuenta no encontrada'), { status: 404 })
	return id
}
const threadParam = key => {
	const i = String(key).indexOf(':')
	const accountId = Number(String(key).slice(0, i))
	const threadKey = decodeURIComponent(String(key).slice(i + 1))
	if (i < 1 || !accountId) throw Object.assign(new Error('Conversación inválida'), { status: 404 })
	return { accountId, threadKey }
}

app.get('/api/info', route(() => ({ unread: manager.totalUnread() })))
app.post('/api/password', route(req => { changePassword(req.body.password); return { ok: true } }))

// ---- Ayuda para configurar una cuenta ----
app.get('/api/guess', route(async req => {
	const email = String(req.query.email || '')
	if (!/@/.test(email)) throw new Error('Escribe el correo completo')
	return guessProvider(email) || (await guessByMx(email)) || guessCustom(email)
}))

// ---- Cuentas ----
app.get('/api/accounts', route(() => manager.accounts()))

const accountBody = async (body, prev = {}) => {
	const email = String(body.email ?? prev.email ?? '').trim().toLowerCase()
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Correo inválido')
	const g = guessProvider(email) || (body.imapHost ? null : await guessByMx(email)) || guessCustom(email)
	return {
		name: String(body.name ?? prev.name ?? email.split('@')[0]).trim().slice(0, 60) || email,
		color: /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : (prev.color || '#007AFF'),
		email,
		imap_host: String(body.imapHost ?? prev.imap_host ?? g.imapHost).trim(),
		imap_port: Number(body.imapPort ?? prev.imap_port ?? g.imapPort) || 993,
		smtp_host: String(body.smtpHost ?? prev.smtp_host ?? g.smtpHost).trim(),
		smtp_port: Number(body.smtpPort ?? prev.smtp_port ?? g.smtpPort) || 465,
		user: String(body.user ?? prev.user ?? email).trim(),
		pass: body.pass !== undefined ? String(body.pass) : prev.pass,
		brevo_key: body.brevoKey !== undefined ? (String(body.brevoKey).trim() || null) : (prev.brevo_key ?? null)
	}
}

app.post('/api/accounts', route(async req => {
	const a = await accountBody(req.body)
	if (!a.pass) throw new Error('Escribe la contraseña')
	const { lastInsertRowid } = db.prepare(`INSERT INTO accounts (name, color, email, imap_host, imap_port, smtp_host, smtp_port, user, pass, brevo_key, created_at)
		VALUES (@name, @color, @email, @imap_host, @imap_port, @smtp_host, @smtp_port, @user, @pass, @brevo_key, ${Date.now()})`).run(a)
	const id = Number(lastInsertRowid)
	await manager.start(id)
	return manager.accountInfo(id)
}))

app.patch('/api/accounts/:id', route(async req => {
	const id = accountParam(req)
	const prev = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)
	const a = await accountBody(req.body, prev)
	db.prepare(`UPDATE accounts SET name=@name, color=@color, email=@email, imap_host=@imap_host, imap_port=@imap_port,
		smtp_host=@smtp_host, smtp_port=@smtp_port, user=@user, pass=@pass, brevo_key=@brevo_key WHERE id=${id}`).run(a)
	const changedConn = ['imap_host', 'imap_port', 'user', 'pass', 'email'].some(k => a[k] !== prev[k])
	if (changedConn) { await manager.boxes.get(id)?.stop(); manager.boxes.delete(id); await manager.start(id) }
	return manager.accountInfo(id)
}))

app.post('/api/accounts/:id/reconnect', route(async req => {
	const id = accountParam(req)
	await manager.boxes.get(id)?.stop()
	manager.boxes.delete(id)
	await manager.start(id)
	return manager.accountInfo(id)
}))

app.delete('/api/accounts/:id', route(async req => {
	const id = accountParam(req)
	await manager.remove(id)
	db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
	manager.emit('event', { type: 'account.removed', data: { id } })
	return { ok: true }
}))

// ---- Bandeja ----
app.get('/api/threads', route(req => manager.threads({
	accountId: Number(req.query.accountId) || null,
	labelId: Number(req.query.labelId) || null,
	unread: req.query.unread === '1',
	q: req.query.q ? String(req.query.q) : null
})))

app.get('/api/threads/:key', route(req => {
	const { accountId, threadKey } = threadParam(req.params.key)
	return { thread: manager.conversationThread(accountId, threadKey), messages: manager.thread(accountId, threadKey) }
}))

app.post('/api/threads/:key/read', route(async req => {
	const { accountId, threadKey } = threadParam(req.params.key)
	const box = manager.boxes.get(accountId)
	const uids = db.prepare('SELECT uid FROM messages WHERE account_id = ? AND thread_key = ? AND seen = 0 AND from_me = 0').all(accountId, threadKey)
	for (const { uid } of uids) {
		if (box) await box.markRead(uid, true).catch(() => {})
		else db.prepare('UPDATE messages SET seen = 1 WHERE account_id = ? AND uid = ?').run(accountId, uid)
	}
	manager.emit('event', { type: 'thread.update', data: manager.conversationThread(accountId, threadKey) })
	return { ok: true }
}))

app.put('/api/threads/:key/labels', route(req => {
	const { accountId, threadKey } = threadParam(req.params.key)
	const ids = (req.body.labelIds || []).map(Number).filter(Boolean)
	db.transaction(() => {
		db.prepare('DELETE FROM message_labels WHERE thread_key = ?').run(threadKey)
		const ins = db.prepare('INSERT OR IGNORE INTO message_labels (thread_key, label_id) SELECT ?, id FROM labels WHERE id = ?')
		for (const id of ids) ins.run(threadKey, id)
	})()
	const t = manager.conversationThread(accountId, threadKey)
	manager.emit('event', { type: 'thread.update', data: t })
	return t
}))

// ---- Adjuntos ----
app.get('/api/attachments/:accountId/:uid/:index', route((req, res) => {
	const row = db.prepare('SELECT attachments FROM messages WHERE account_id = ? AND uid = ? AND folder = ?').get(Number(req.params.accountId), Number(req.params.uid), 'INBOX')
	const at = (JSON.parse(row?.attachments || '[]'))[Number(req.params.index)]
	if (!at || !fs.existsSync(at.path)) throw Object.assign(new Error('Adjunto no encontrado'), { status: 404 })
	res.type(at.mime || 'application/octet-stream')
	res.setHeader('Content-Disposition', `inline; filename="${at.name.replace(/"/g, '')}"`)
	res.sendFile(at.path)
}))

// ---- Enviar ----
app.post('/api/send', route(async req => {
	const accountId = accountParam(req)
	const box = manager.get(accountId)
	const to = String(req.body.to || '').trim()
	if (!to) throw new Error('Escribe el destinatario')
	const attachments = (req.body.attachments || []).slice(0, 10).map(a => ({
		filename: a.name, content: Buffer.from(String(a.data || ''), 'base64'), contentType: a.mime
	}))
	await box.send({
		to, cc: req.body.cc, subject: req.body.subject || '(sin asunto)',
		text: req.body.text, html: req.body.html,
		inReplyTo: req.body.inReplyTo, references: req.body.references, attachments
	})
	return { ok: true }
}))

app.post('/api/accounts/:id/test', route(async req => {
	const id = accountParam(req)
	await manager.get(id).verify()
	return { ok: true }
}))

// ---- Etiquetas ----
app.get('/api/labels', route(() => db.prepare('SELECT * FROM labels ORDER BY name').all()))
app.post('/api/labels', route(req => {
	const name = String(req.body.name || '').trim()
	if (!name) throw new Error('Nombre requerido')
	const color = /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : '#8E8E93'
	const { lastInsertRowid } = db.prepare('INSERT INTO labels (name, color) VALUES (?, ?)').run(name, color)
	return db.prepare('SELECT * FROM labels WHERE id = ?').get(lastInsertRowid)
}))
app.delete('/api/labels/:id', route(req => { db.prepare('DELETE FROM labels WHERE id = ?').run(Number(req.params.id)); return { ok: true } }))

// ---- Envíos masivos ----
app.get('/api/campaigns', route(() => campaigns.list()))
app.post('/api/campaigns', route(req => {
	const ids = [...new Set((req.body.accountIds || []).map(Number))]
	for (const id of ids) if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) throw new Error('Cuenta no encontrada')
	return campaigns.create({ ...req.body, accountIds: ids })
}))
app.get('/api/campaigns/:cid/items', route(req => campaigns.items(Number(req.params.cid), req.query.status || null)))
app.post('/api/campaigns/:cid/retry', route(req => {
	const id = Number(req.params.cid)
	if (!campaigns.get(id)) throw Object.assign(new Error('Envío no encontrado'), { status: 404 })
	const n = campaigns.retryFailed(id)
	return { retried: n, campaign: campaigns.get(id) }
}))
app.post('/api/campaigns/:cid/:action', route(req => {
	const id = Number(req.params.cid); const c = campaigns.get(id)
	if (!c) throw Object.assign(new Error('Envío no encontrado'), { status: 404 })
	const next = { pause: 'paused', resume: 'running', cancel: 'cancelled' }[req.params.action]
	if (!next) throw new Error('Acción inválida')
	if (c.status === 'done' || c.status === 'cancelled') throw new Error('Este envío ya terminó')
	campaigns.setStatus(id, next)
	return campaigns.get(id)
}))
app.post('/api/optout', route(req => { optOut(req.body.email); return { ok: true } }))

// ---- Notificaciones ----
app.get('/api/push/key', route(() => ({ key: VAPID_PUBLIC_KEY })))
app.post('/api/push/subscribe', route(req => { saveSubscription(req.body); return { ok: true } }))

// ---- WebSocket ----
const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })
const onUpgrade = (req, socket, head) => {
	const url = new URL(req.url, 'http://localhost')
	if (url.pathname !== '/ws' || url.searchParams.get('token') !== API_TOKEN) return socket.destroy()
	wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws))
}
server.on('upgrade', onUpgrade)
if (PORT !== 3000) { const extra = http.createServer(app); extra.on('upgrade', onUpgrade); extra.on('error', () => {}); extra.listen(3000, '0.0.0.0') }

wss.on('connection', ws => {
	ws.isAlive = true
	ws.on('pong', () => { ws.isAlive = true })
	ws.send(JSON.stringify({ type: 'hello', data: { accounts: manager.accounts() } }))
})
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue } ws.isAlive = false; ws.ping() } }, 25000)
manager.on('event', evt => {
	if (!evt.data) return
	const payload = JSON.stringify(evt)
	for (const ws of wss.clients) if (ws.readyState === 1) ws.send(payload)
})

process.on('uncaughtException', e => console.error(e))
process.on('unhandledRejection', e => console.error(e))

server.listen(PORT, '0.0.0.0', async () => {
	const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
	console.log('\nMultiMail servidor activo')
	for (const ip of ips) console.log(`  URL: http://${ip}:${PORT}`)
	console.log('  Abre esa dirección en Safari y crea tu contraseña.\n')
	await manager.startAll()
})

const shutdown = async () => { for (const b of manager.boxes.values()) await b.stop(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
