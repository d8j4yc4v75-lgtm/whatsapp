import './preboot.js'
import http from 'node:http'
import os from 'node:os'
import express from 'express'
import multer from 'multer'
import { WebSocketServer } from 'ws'
import { db } from './db.js'
import { API_TOKEN, PORT } from './config.js'
import { SessionManager, diag, note } from './sessions.js'
import { VAPID_PUBLIC_KEY, saveSubscription } from './push.js'
import { changePassword, hasPassword, login, setupPassword } from './auth.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasFfmpeg, toM4a, toMp4, toOpus } from './ffmpeg.js'
import { CloudSession, validSignature, webhookVerifyToken } from './cloud.js'
import { CampaignRunner } from './campaigns.js'
import { WarmupManager } from './warmup.js'
import { setupExtras } from './extras.js'
import { diskInfo, startMaintenance } from './maintenance.js'

const STARTED_AT = new Date().toISOString()
const manager = new SessionManager()
const campaigns = new CampaignRunner(manager)
const warmup = new WarmupManager(manager)

process.on('uncaughtException', e => { note(null, 'uncaught', e.stack || e.message); console.error(e) })
process.on('unhandledRejection', e => { note(null, 'unhandled', e?.stack || e); console.error(e) })
const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } })

app.use(express.json({ limit: '5mb', verify: (req, res, buf) => { req.rawBody = buf } }))

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
app.use(express.static(PUBLIC_DIR, { maxAge: 0, etag: true }))

// Railway define RAILWAY_VOLUME_MOUNT_PATH solo cuando hay un volumen conectado
const persistent = () => !process.env.RAILWAY_ENVIRONMENT || Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH)
app.get('/health', (req, res) => res.json({ ok: true, volume: process.env.RAILWAY_VOLUME_MOUNT_PATH || null }))

// Diagnóstico de conexiones (sin datos personales) para depurar desconexiones
app.get('/diag', (req, res) => res.json({
	startedAt: STARTED_AT,
	accounts: manager.accounts().map(a => ({ id: a.id, status: a.status })),
	disk: diskInfo(),
	events: diag
}))

const tokenOf = req => req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.query.token

// ---- Webhook de la API oficial de WhatsApp ----
app.get('/webhook', (req, res) => {
	if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === webhookVerifyToken(API_TOKEN)) {
		note(null, 'webhook-verified')
		return res.type('text').send(String(req.query['hub.challenge'] || ''))
	}
	res.sendStatus(403)
})

app.post('/webhook', (req, res) => {
	const sessions = [...manager.sessions.values()].filter(s => s instanceof CloudSession)
	const secrets = sessions.map(s => s.config.appSecret).filter(Boolean)
	if (!validSignature(req.rawBody, req.get('x-hub-signature-256'), secrets)) {
		note(null, 'webhook-bad-signature')
		return res.sendStatus(401)
	}
	res.sendStatus(200)
	for (const entry of req.body?.entry || []) {
		for (const change of entry.changes || []) {
			const value = change.value || {}
			const pnid = value.metadata?.phone_number_id
			const session = sessions.find(s => s.config.phoneNumberId === pnid)
			if (!session) { note(null, 'webhook-unknown-number'); continue }
			try { session.handleWebhook(value) } catch (e) { note(session.accountId, 'webhook-error', e.message) }
		}
	}
})

// ---- Acceso con contraseña ----
app.get('/auth/status', (req, res) => res.json({ hasPassword: hasPassword() }))
app.post('/auth/setup', express.json(), async (req, res) => {
	try { res.json({ token: setupPassword(req.body.password) }) } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/auth/login', async (req, res) => {
	try { res.json({ token: await login(req.body.password) }) } catch (e) { res.status(e.status || 400).json({ error: e.message }) }
})

app.use('/api', (req, res, next) => {
	if (tokenOf(req) !== API_TOKEN) return res.status(401).json({ error: 'Token inválido' })
	next()
})

// Express 5 propaga errores de funciones async; aquí se convierten en JSON
const route = fn => async (req, res) => {
	try {
		const out = await fn(req, res)
		if (out !== undefined && !res.headersSent) res.json(out)
	} catch (e) {
		res.status(e.status || 400).json({ error: e.message })
	}
}

const accountParam = req => {
	const id = Number(req.params.id ?? req.body.accountId ?? req.query.accountId)
	if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) {
		throw Object.assign(new Error('Cuenta no encontrada'), { status: 404 })
	}
	return id
}

app.get('/api/info', route(() => ({ unread: manager.totalUnread(), persistent: persistent() })))

app.post('/api/password', route(req => {
	changePassword(req.body.password)
	return { ok: true }
}))

// ---- Cuentas ----
app.get('/api/accounts', route(() => manager.accounts()))

const cloudConfig = (body, prev = {}) => {
	const cfg = {
		phoneNumberId: String(body.phoneNumberId ?? prev.phoneNumberId ?? '').replace(/\D/g, ''),
		wabaId: String(body.wabaId ?? prev.wabaId ?? '').replace(/\D/g, ''),
		token: String(body.token || prev.token || '').trim(),
		appSecret: body.appSecret !== undefined ? String(body.appSecret).trim() : prev.appSecret || '',
		dailyLimit: Math.max(1, Number(body.dailyLimit ?? prev.dailyLimit ?? 250) || 250)
	}
	if (!cfg.phoneNumberId || !cfg.wabaId || !cfg.token) throw new Error('Faltan datos: identificador del número, de la cuenta y token')
	return cfg
}

app.post('/api/accounts', route(async req => {
	const name = String(req.body.name || '').trim() || 'WhatsApp'
	const color = /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : '#25D366'
	const kind = req.body.kind === 'cloud' ? 'cloud' : 'baileys'
	const cloud = kind === 'cloud' ? JSON.stringify(cloudConfig(req.body)) : null
	if (cloud) {
		const pnid = JSON.parse(cloud).phoneNumberId
		const dup = db.prepare("SELECT cloud FROM accounts WHERE kind = 'cloud'").all().some(r => JSON.parse(r.cloud || '{}').phoneNumberId === pnid)
		if (dup) throw new Error('Ese número ya está agregado como cuenta')
	}
	const { lastInsertRowid } = db.prepare('INSERT INTO accounts (name, color, created_at, kind, cloud) VALUES (?, ?, ?, ?, ?)')
		.run(name, color, Date.now(), kind, cloud)
	const id = Number(lastInsertRowid)
	await manager.start(id)
	return manager.accountInfo(id)
}))

app.patch('/api/accounts/:id', route(req => {
	const id = accountParam(req)
	if (req.body.name) db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(String(req.body.name), id)
	if (/^#[0-9a-f]{6}$/i.test(req.body.color)) db.prepare('UPDATE accounts SET color = ? WHERE id = ?').run(req.body.color, id)
	if (typeof req.body.reserve === 'boolean') db.prepare('UPDATE accounts SET reserve = ? WHERE id = ?').run(req.body.reserve ? 1 : 0, id)
	const info = manager.accountInfo(id)
	manager.emit('event', { type: 'account.update', data: info })
	return info
}))

app.put('/api/accounts/:id/cloud', route(async req => {
	const id = accountParam(req)
	const a = db.prepare('SELECT kind, cloud FROM accounts WHERE id = ?').get(id)
	if (a.kind !== 'cloud') throw new Error('Esta cuenta no usa la API oficial')
	db.prepare('UPDATE accounts SET cloud = ? WHERE id = ?').run(JSON.stringify(cloudConfig(req.body, JSON.parse(a.cloud || '{}'))), id)
	await manager.start(id)
	return manager.accountInfo(id)
}))

const cloudSession = id => {
	const s = manager.sessions.get(id)
	if (!(s instanceof CloudSession)) throw new Error('Esta función solo está disponible con la API oficial')
	return s
}

app.get('/api/accounts/:id/templates', route(req => cloudSession(accountParam(req)).listTemplates(req.query.refresh === '1')))

app.post('/api/accounts/:id/templates', route(req => cloudSession(accountParam(req)).createTemplate(req.body)))

app.get('/api/cloud/setup', route(req => ({
	callbackUrl: `https://${req.get('host')}/webhook`,
	verifyToken: webhookVerifyToken(API_TOKEN),
	privacyUrl: `https://${req.get('host')}/privacidad.html`
})))

app.post('/api/accounts/:id/connect', route(async req => {
	const id = accountParam(req)
	await manager.start(id)
	return manager.accountInfo(id)
}))

app.post('/api/accounts/:id/pairing-code', route(async req => {
	const id = accountParam(req)
	const code = await manager.get(id).pairingCode(req.body.phone)
	return { code }
}))

app.post('/api/accounts/:id/logout', route(async req => {
	const id = accountParam(req)
	await manager.get(id).logout()
	return manager.accountInfo(id)
}))

app.delete('/api/accounts/:id', route(async req => {
	const id = accountParam(req)
	await manager.remove(id)
	db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
	// Las conversaciones que quedaron sin ninguna cuenta pierden sus etiquetas
	db.prepare('DELETE FROM conversation_labels WHERE jid LIKE ?').run(`${id}:%`)
	manager.emit('event', { type: 'account.removed', data: { id } })
	return { ok: true }
}))

// ---- Bandeja unificada ----
app.get('/api/conversations', route(req => manager.conversations({
	accountId: Number(req.query.accountId) || null,
	labelId: Number(req.query.labelId) || null,
	unread: req.query.unread === '1',
	q: req.query.q ? String(req.query.q) : null
})))

// La clave de conversación es "cuenta:jid"
const convKey = key => {
	const i = String(key).indexOf(':')
	const accountId = Number(String(key).slice(0, i))
	const jid = String(key).slice(i + 1)
	if (i < 1 || !accountId || !jid) throw Object.assign(new Error('Conversación inválida'), { status: 404 })
	return { accountId, jid, key: `${accountId}:${jid}` }
}

app.get('/api/conversations/:key', route(req => {
	const { accountId, jid } = convKey(req.params.key)
	const conv = manager.conversation(accountId, jid)
	if (!conv) throw Object.assign(new Error('Conversación no encontrada'), { status: 404 })
	return conv
}))

app.get('/api/conversations/:key/messages', route(req => {
	const { accountId, jid } = convKey(req.params.key)
	return manager.messages(accountId, jid, { before: req.query.before, limit: Math.min(200, Number(req.query.limit) || 50) })
}))

app.post('/api/conversations/:key/read', route(async req => {
	const { accountId, jid } = convKey(req.params.key)
	await manager.markRead(accountId, jid)
	return { ok: true }
}))

app.put('/api/conversations/:key/labels', route(req => {
	const { accountId, jid, key } = convKey(req.params.key)
	const ids = (req.body.labelIds || []).map(Number).filter(Boolean)
	// Se conserva la fecha de las etiquetas que ya tenía, para los resultados
	db.transaction(() => {
		const keep = ids.length ? ids.map(() => '?').join(',') : 'NULL'
		db.prepare(`DELETE FROM conversation_labels WHERE jid = ? AND label_id NOT IN (${keep})`).run(key, ...ids)
		const ins = db.prepare('INSERT OR IGNORE INTO conversation_labels (jid, label_id, at) SELECT ?, id, ? FROM labels WHERE id = ?')
		for (const id of ids) ins.run(key, Date.now(), id)
	})()
	const conv = manager.conversation(accountId, jid)
	manager.emit('event', { type: 'conversation.update', data: conv })
	return conv
}))

// ---- Envío ----
app.post('/api/send-template', route(async req => {
	const accountId = accountParam(req)
	const { message } = await cloudSession(accountId).sendTemplate(req.body.jid || req.body.phone, {
		name: req.body.template, language: req.body.language, params: req.body.params || []
	})
	return message
}))

// ---- Envíos masivos ----
// ---- Calentamiento (tus números se escriben entre sí) ----
app.get('/api/warmup', route(() => warmup.status()))
app.post('/api/warmup', route(req => { warmup.save(req.body || {}); return warmup.status() }))

app.get('/api/campaigns', route(() => campaigns.list()))

app.post('/api/campaigns', route(req => {
	if (req.body.kind === 'safe') {
		const ids = [...new Set((req.body.accountIds || []).map(Number))]
		for (const id of ids) {
			const a = db.prepare('SELECT kind FROM accounts WHERE id = ?').get(id)
			if (!a) throw new Error('Cuenta no encontrada')
			if (a.kind === 'cloud') throw new Error('El modo seguro es para números de WhatsApp normal; para la API usa plantillas')
		}
		return campaigns.create({ ...req.body, kind: 'safe', accountIds: ids })
	}
	const accountId = accountParam(req)
	cloudSession(accountId)
	return campaigns.create({ ...req.body, kind: 'cloud', accountId })
}))

app.get('/api/campaigns/:cid/items', route(req => campaigns.items(Number(req.params.cid), req.query.status || null)))

app.post('/api/campaigns/:cid/:action', route(req => {
	const id = Number(req.params.cid)
	const c = campaigns.get(id)
	if (!c) throw Object.assign(new Error('Envío no encontrado'), { status: 404 })
	const next = { pause: 'paused', resume: 'running', cancel: 'cancelled' }[req.params.action]
	if (!next) throw new Error('Acción inválida')
	if (c.status === 'done' || c.status === 'cancelled') throw new Error('Este envío ya terminó')
	// Al reanudar se vuelven a usar los números que se habían apartado por rechazos
	if (next === 'running') db.prepare('UPDATE campaigns SET disabled = NULL WHERE id = ?').run(id)
	campaigns.setStatus(id, next)
	return campaigns.get(id)
}))

app.post('/api/resolve', route(async req => {
	const jid = await manager.resolvePhone(accountParam(req), req.body.phone)
	return { jid }
}))

app.post('/api/send', route(async req => {
	const accountId = accountParam(req)
	const text = String(req.body.text || '').trim()
	if (!text) throw new Error('El mensaje está vacío')
	const jid = req.body.jid || await manager.resolvePhone(accountId, req.body.phone)
	return manager.get(accountId).send(jid, { text })
}))

app.post('/api/send-media', upload.single('file'), route(async req => {
	const accountId = accountParam(req)
	const file = req.file
	if (!file) throw new Error('Falta el archivo')
	const jid = req.body.jid || await manager.resolvePhone(accountId, req.body.phone)
	let mime = file.mimetype || 'application/octet-stream'
	const caption = req.body.caption ? String(req.body.caption) : undefined
	const fileName = file.originalname || 'archivo'
	const kind = req.body.kind || mime.split('/')[0]
	let content
	if (kind === 'image') content = { image: file.buffer, caption, mimetype: mime }
	else if (kind === 'video') {
		if (mime !== 'video/mp4' && await hasFfmpeg()) {
			file.buffer = await toMp4(file.buffer)
			mime = 'video/mp4'
		}
		content = { video: file.buffer, caption, mimetype: mime }
	}
	else if (kind === 'audio') {
		// Las notas de voz se envían como ogg/opus si ffmpeg está instalado
		if (req.body.ptt === 'true' && await hasFfmpeg()) {
			const ogg = await toOpus(file.buffer)
			content = { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true }
		} else {
			content = { audio: file.buffer, mimetype: mime, ptt: false }
		}
	} else content = { document: file.buffer, mimetype: mime, fileName, caption }
	return manager.get(accountId).send(jid, content, { buffer: file.buffer, mime, fileName })
}))

app.get('/api/media/:id/:msgId', route(async (req, res) => {
	const id = accountParam(req)
	const session = manager.sessions.get(id)
	let row = db.prepare('SELECT * FROM messages WHERE account_id = ? AND id = ?').get(id, req.params.msgId)
	if (!row) throw Object.assign(new Error('Mensaje no encontrado'), { status: 404 })
	if (!row.media_path) {
		if (!session) throw new Error('La cuenta no está conectada para descargar el archivo')
		row = await session.downloadMedia(row.id)
	}
	const mime = row.media_mime?.split(';')[0] || 'application/octet-stream'
	if (req.query.format === 'm4a' && mime === 'audio/ogg' && await hasFfmpeg()) {
		return res.type('audio/mp4').sendFile(await toM4a(row.media_path))
	}
	res.type(mime)
	res.sendFile(row.media_path)
}))

setupExtras({ app, route, manager })

// ---- Etiquetas ----
app.get('/api/labels', route(() => db.prepare('SELECT * FROM labels ORDER BY name').all()))

app.post('/api/labels', route(req => {
	const name = String(req.body.name || '').trim()
	if (!name) throw new Error('Nombre requerido')
	const color = /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : '#8E8E93'
	const { lastInsertRowid } = db.prepare('INSERT INTO labels (name, color) VALUES (?, ?)').run(name, color)
	return db.prepare('SELECT * FROM labels WHERE id = ?').get(lastInsertRowid)
}))

app.delete('/api/labels/:id', route(req => {
	db.prepare('DELETE FROM labels WHERE id = ?').run(Number(req.params.id))
	return { ok: true }
}))

// ---- Notificaciones push (Web Push) ----
app.get('/api/push/key', route(() => ({ key: VAPID_PUBLIC_KEY })))

app.post('/api/push/subscribe', route(req => {
	saveSubscription(req.body)
	return { ok: true }
}))

// ---- WebSocket de eventos en tiempo real ----
const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

const onUpgrade = (req, socket, head) => {
	const url = new URL(req.url, 'http://localhost')
	if (url.pathname !== '/ws' || url.searchParams.get('token') !== API_TOKEN) {
		socket.destroy()
		return
	}
	wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws))
}
server.on('upgrade', onUpgrade)

// Railway asigna su propio PORT; también se escucha en 3000 por si el dominio apunta ahí
if (PORT !== 3000) {
	const extra = http.createServer(app)
	extra.on('upgrade', onUpgrade)
	extra.on('error', () => {})
	extra.listen(3000, '0.0.0.0')
}

wss.on('connection', ws => {
	ws.isAlive = true
	ws.on('pong', () => { ws.isAlive = true })
	ws.send(JSON.stringify({ type: 'hello', data: { accounts: manager.accounts() } }))
})

setInterval(() => {
	for (const ws of wss.clients) {
		if (!ws.isAlive) { ws.terminate(); continue }
		ws.isAlive = false
		ws.ping()
	}
}, 25000)

manager.on('event', evt => {
	if (!evt.data) return
	const payload = JSON.stringify(evt)
	for (const ws of wss.clients) if (ws.readyState === 1) ws.send(payload)
})

server.listen(PORT, '0.0.0.0', async () => {
	const ips = Object.values(os.networkInterfaces()).flat()
		.filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
	console.log('\nMultiWA servidor activo')
	for (const ip of ips) console.log(`  URL: http://${ip}:${PORT}`)
	console.log(`  Abre esa dirección en Safari y crea tu contraseña.\n`)
	startMaintenance()
	await manager.startAll()
})

const shutdown = async () => {
	for (const s of manager.sessions.values()) await s.stop()
	process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
