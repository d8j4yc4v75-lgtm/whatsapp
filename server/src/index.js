import './preboot.js'
import http from 'node:http'
import os from 'node:os'
import express from 'express'
import multer from 'multer'
import { WebSocketServer } from 'ws'
import { db } from './db.js'
import { API_TOKEN, PORT } from './config.js'
import { SessionManager, diag, note, accountHistory } from './sessions.js'
import { VAPID_PUBLIC_KEY, saveSubscription, sendPush } from './push.js'
import { changePassword, hasPassword, login, setupPassword } from './auth.js'
import { checkToken, createDevice, listDevices, pruneDevices, removeDevice, removeOthers, touch, touchNow } from './devices.js'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'
import { hasFfmpeg, toM4a, toMp4, toOpus } from './ffmpeg.js'
import { CloudSession, validSignature, webhookVerifyToken } from './cloud.js'
import { CampaignRunner } from './campaigns.js'
import { WarmupManager, library as warmupLibrary } from './warmup.js'
import { smartEnabled, setSmartEnabled } from './smart.js'
import { correctorStatus, correctorSave, rewrite } from './corrector.js'
import { setupExtras } from './extras.js'
import { diskInfo, startMaintenance, mediaDays, setMediaDays, chatMonths, setChatMonths } from './maintenance.js'

const STARTED_AT = new Date().toISOString()
const manager = new SessionManager()
const campaigns = new CampaignRunner(manager)
const warmup = new WarmupManager(manager)

process.on('uncaughtException', e => { note(null, 'uncaught', e.stack || e.message); console.error(e) })
process.on('unhandledRejection', e => { note(null, 'unhandled', e?.stack || e); console.error(e) })
const app = express()

// ---- Correos: la app de correos corre dentro de este mismo servidor, en /correo ----
// (misma contraseña y mismo disco; si algo falla al cargarla, WhatsApp sigue funcionando)
let mail = null
try {
	const here = path.dirname(fileURLToPath(import.meta.url))
	const file = [path.join(here, '..', 'mail', 'src', 'index.js'), path.join(here, '..', '..', 'mail', 'src', 'index.js')].find(f => fs.existsSync(f))
	if (file) {
		mail = await import(pathToFileURL(file).href)
		mail.setTokenCheck(t => !!checkToken(t))
		mail.setPushSender(({ title, body }) => sendPush({ title: `✉️ ${title}`, body, url: '/#/mail' }))
		app.use('/correo', mail.mailApp)
	}
} catch (e) { mail = null; console.error('No se pudo cargar la app de correos:', e.message) }
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
	try { setupPassword(req.body.password); res.json({ token: createDevice(req) }) } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/auth/login', async (req, res) => {
	try { await login(req.body.password); res.json({ token: createDevice(req) }) } catch (e) { res.status(e.status || 400).json({ error: e.message }) }
})

app.use('/api', (req, res, next) => {
	const who = checkToken(tokenOf(req))
	if (!who) return res.status(401).json({ error: 'Token inválido' })
	req.deviceId = who.id
	touch(who.id, req)
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

// Dirección de la app de correos (se muestra en la pestaña «Correos»)
const mailUrl = () => mail ? '/correo/' : (db.prepare("SELECT value FROM app_settings WHERE key = 'mail_url'").get()?.value || process.env.MAIL_URL || '')
app.get('/api/info', route(() => ({ unread: manager.totalUnread(), persistent: persistent(), mailUrl: mailUrl() })))
app.put('/api/settings/mail-url', route(req => {
	let u = String(req.body.url || '').trim()
	if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u
	if (u) { try { u = new URL(u).origin } catch { throw new Error('Esa dirección no es válida') } }
	db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('mail_url', ?)").run(u)
	return { mailUrl: u }
}))

// ---- Dispositivos con la sesión abierta ----
const onlineDevices = () => new Set([...wss.clients].filter(ws => ws.readyState === 1 && ws.deviceId).map(ws => ws.deviceId))
const kick = ids => { for (const ws of wss.clients) if (ids.includes(ws.deviceId)) ws.close(4001, 'sesion cerrada') }
app.get('/api/devices', route(req => listDevices(req.deviceId, onlineDevices())))
// Los dispositivos que entraron antes de esta función cambian su llave por una propia
app.post('/api/devices/upgrade', route(req => req.deviceId ? { ok: true } : { token: createDevice(req) }))
app.post('/api/devices/logout-others', route(req => {
	if (!req.deviceId) throw new Error('Vuelve a abrir la app e inténtalo de nuevo')
	const ids = removeOthers(req.deviceId)
	for (const ws of wss.clients) if (ws.deviceId !== req.deviceId) ws.close(4001, 'sesion cerrada')
	return { ok: true, closed: ids.length }
}))
app.post('/api/logout', route(req => {
	if (req.deviceId) { removeDevice(req.deviceId); kick([req.deviceId]) }
	return { ok: true }
}))
app.delete('/api/devices/:id', route(req => {
	const id = Number(req.params.id)
	if (!removeDevice(id)) throw Object.assign(new Error('Ese dispositivo ya no tiene sesión'), { status: 404 })
	kick([id])
	return { ok: true }
}))
pruneDevices()
setInterval(pruneDevices, 864e5).unref()

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
	if (req.body.restAllow !== undefined) db.prepare('UPDATE accounts SET rest_allow = ? WHERE id = ?').run(Math.max(0, Math.min(50, Math.floor(Number(req.body.restAllow) || 0))), id)
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
	const s = manager.sessions.get(id)
	if (s) s.forbidden = 0 // reintento pedido por ti: vuelve a contar desde cero
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

// Historial de lo que le ha pasado a un número (conexiones, rechazos, avisos)
app.get('/api/accounts/:id/history', route(req => accountHistory(accountParam(req))))

// Borra los chats y archivos de un número que ya no está vinculado (la cuenta se conserva)
app.delete('/api/accounts/:id/chats', route(req => {
	const id = accountParam(req)
	if (manager.accountInfo(id)?.status === 'connected') throw new Error('Solo se puede con números que no están conectados')
	manager.clearChats(id)
	return { ok: true }
}))

// ---- Avisos automáticos ----
const getSetting = k => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k)?.value
const putSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(k, String(v))
const mxNow = () => new Date(Date.now() + Number(process.env.TZ_OFFSET_HOURS || -6) * 3600e3)
const alertsInfo = () => ({ waitingMinutes: Number(getSetting('waiting_minutes')) || 0, dailySummary: getSetting('daily_summary') !== '0' })
app.get('/api/settings/alerts', route(() => alertsInfo()))
app.put('/api/settings/alerts', route(req => {
	if (req.body.waitingMinutes !== undefined) putSetting('waiting_minutes', Math.max(0, Math.min(720, Math.floor(Number(req.body.waitingMinutes) || 0))))
	if (req.body.dailySummary !== undefined) putSetting('daily_summary', req.body.dailySummary ? '1' : '0')
	return alertsInfo()
}))

// Clientes que llevan más de X minutos sin respuesta (un aviso por cada espera, de 8 a 22 h)
const waitingNotified = new Map()
export function waitingAlert(now = Date.now()) {
	const min = alertsInfo().waitingMinutes
	const h = mxNow().getUTCHours()
	if (!min || h < 8 || h >= 22) return null
	const rows = db.prepare(`
		SELECT c.account_id, c.jid FROM chats c
		WHERE c.last_ts > ? AND c.archived = 0 AND c.muted = 0 AND c.jid NOT LIKE '%@g.us'
		AND c.jid NOT IN (SELECT phone || '@s.whatsapp.net' FROM accounts WHERE phone IS NOT NULL)`).all(now - 24 * 3600e3)
	const last = db.prepare('SELECT ts, from_me FROM messages WHERE account_id = ? AND jid = ? ORDER BY ts DESC LIMIT 1')
	const fresh = []
	for (const r of rows) {
		const m = last.get(r.account_id, r.jid)
		const key = `${r.account_id}:${r.jid}`
		if (!m || m.from_me || now - m.ts < min * 60000) continue
		if (waitingNotified.get(key) === m.ts) continue
		waitingNotified.set(key, m.ts)
		fresh.push(key)
	}
	if (!fresh.length) return null
	const msg = { title: '⏳ Clientes esperando respuesta', body: fresh.length === 1 ? `1 cliente lleva más de ${min} min sin respuesta` : `${fresh.length} clientes llevan más de ${min} min sin respuesta` }
	sendPush({ ...msg, url: '/#/', jid: fresh.length === 1 ? fresh[0] : undefined, badge: manager.totalUnread() })
	return msg
}

// Resumen de la mañana (9 am): cómo están tus números
export function numbersSummary() {
	const mx = mxNow()
	const day = mx.toISOString().slice(0, 10)
	if (!alertsInfo().dailySummary || mx.getUTCHours() < 9 || getSetting('numbers_summary') === day) return null
	putSetting('numbers_summary', day)
	const list = manager.accounts().filter(a => a.kind !== 'cloud')
	if (!list.length) return null
	const n = { ok: 0, rest: 0, blocked: 0, off: 0, other: 0 }
	for (const a of list) {
		if (a.status === 'blocked') n.blocked++
		else if (a.status === 'logged_out' || a.status === 'disconnected') n.off++
		else if (a.status !== 'connected') n.other++
		else if (a.health?.restUntil) n.rest++
		else n.ok++
	}
	const parts = [`${n.ok} listo${n.ok === 1 ? '' : 's'}`]
	if (n.rest) parts.push(`${n.rest} descansando`)
	if (n.blocked) parts.push(`${n.blocked} bloqueado${n.blocked === 1 ? '' : 's'}`)
	if (n.off) parts.push(`${n.off} por vincular`)
	if (n.other) parts.push(`${n.other} reconectando`)
	const msg = { title: '📱 Tus números hoy', body: parts.join(' · ') }
	sendPush({ ...msg, url: '/#/accounts' })
	return msg
}
setInterval(() => { try { waitingAlert(); numbersSummary() } catch (e) { note(null, 'alert-error', e.message) } }, 5 * 60e3).unref()

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
	archived: req.query.archived === '1',
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

app.get('/api/conversations/:key/info', route(req => {
	const { accountId, jid } = convKey(req.params.key)
	return manager.contactInfo(accountId, jid)
}))

app.put('/api/conversations/:key/mute', route(req => {
	const { accountId, jid } = convKey(req.params.key)
	db.prepare('UPDATE chats SET muted = ? WHERE account_id = ? AND jid = ?').run(req.body.muted ? 1 : 0, accountId, jid)
	const conv = manager.conversation(accountId, jid)
	manager.emit('event', { type: 'conversation.update', data: conv })
	return conv
}))

app.put('/api/conversations/:key/optout', route(req => {
	const { jid } = convKey(req.params.key)
	const phone = jid.split('@')[0]
	if (req.body.optedOut) db.prepare('INSERT OR REPLACE INTO optouts (phone, at) VALUES (?, ?)').run(phone, Date.now())
	else db.prepare('DELETE FROM optouts WHERE phone = ?').run(phone)
	return { optedOut: Boolean(req.body.optedOut) }
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

app.post('/api/conversations/:key/archive', route(req => {
	const { accountId, jid } = convKey(req.params.key)
	return manager.setArchived(accountId, jid, req.body.archived !== false)
}))

app.delete('/api/conversations/:key', route(req => {
	const { accountId, jid } = convKey(req.params.key)
	return manager.deleteConversation(accountId, jid)
}))

// Foto de perfil del contacto (redirige a la imagen del CDN de WhatsApp)
app.get('/api/avatar/:key', route(async (req, res) => {
	const { accountId, jid } = convKey(req.params.key)
	const url = await manager.avatarUrl(accountId, jid, req.query.fresh === '1')
	if (!url) { res.status(404).end(); return }
	res.redirect(url)
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
// ---- Asistente inteligente (entiende las respuestas de los clientes) ----
app.get('/api/settings/smart', route(() => ({ enabled: smartEnabled() })))
app.put('/api/settings/smart', route(req => { setSmartEnabled(req.body.enabled !== false); return { enabled: smartEnabled() } }))

// ---- Corrección de texto (local, sin IA) ----
app.get('/api/settings/ai', route(() => correctorStatus()))
app.put('/api/settings/ai', route(req => correctorSave(req.body || {})))
app.post('/api/ai/rewrite', route(req => rewrite(req.body || {})))

// ---- Calentamiento (tus números se escriben entre sí) ----
app.get('/api/warmup', route(() => warmup.status()))
app.post('/api/warmup', route(req => { warmup.save(req.body || {}); return warmup.status() }))
app.post('/api/warmup/now', route(() => { warmup.kick(); return warmup.status() }))
app.post('/api/warmup/unflag/:id', route(req => { warmup.unflag(Number(req.params.id)); return warmup.status() }))
app.get('/api/warmup/scripts', route(() => ({ text: warmup.customText(), count: warmup.custom.length })))
app.put('/api/warmup/scripts', route(req => warmup.saveCustom(req.body?.text)))
app.post('/api/warmup/media', upload.single('file'), route(async req => {
	await warmupLibrary.add(req.file?.buffer, req.file?.mimetype, req.file?.originalname)
	return warmup.status()
}))
app.delete('/api/warmup/media/:name', route(req => { warmupLibrary.remove(req.params.name); return warmup.status() }))
app.get('/api/warmup/media/:name', (req, res) => {
	const file = warmupLibrary.file(req.params.name)
	if (!file) return res.sendStatus(404)
	res.sendFile(file)
})

// ---- Buscar dentro de los mensajes ----
app.get('/api/search', route(req => {
	const q = String(req.query.q || '').trim()
	if (q.length < 3) return []
	const rows = db.prepare(`
		SELECT m.account_id, m.jid, m.id, m.text, m.ts, m.from_me FROM messages m
		WHERE m.text LIKE ? ESCAPE '\\' AND m.jid NOT LIKE '%@g.us' ORDER BY m.ts DESC LIMIT 40`).all('%' + q.replace(/[\\%_]/g, '\\$&') + '%')
	return rows.map(r => {
		const c = manager.conversation(r.account_id, r.jid)
		return { key: `${r.account_id}:${r.jid}`, accountId: r.account_id, phone: r.jid.split('@')[0], name: c?.name || null, text: r.text, ts: r.ts, fromMe: Boolean(r.from_me) }
	})
}))

// ---- Contactos guardados en tus teléfonos (se sincronizan al vincular) ----
app.get('/api/contacts', route(req => {
	const q = String(req.query.q || '').trim()
	if (q.length < 2) return []
	const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%'
	const digits = q.replace(/\D/g, '')
	return db.prepare(`
		SELECT jid, COALESCE(name, notify) AS name FROM contacts
		WHERE jid LIKE '%@s.whatsapp.net' AND (name LIKE @like ESCAPE '\\' OR notify LIKE @like ESCAPE '\\' ${digits.length >= 3 ? "OR jid LIKE @num" : ''})
		AND jid NOT IN (SELECT phone || '@s.whatsapp.net' FROM accounts WHERE phone IS NOT NULL)
		ORDER BY name IS NULL, name LIMIT 30`).all(digits.length >= 3 ? { like, num: `%${digits}%` } : { like })
		.map(r => ({ phone: r.jid.split('@')[0], name: r.name || null }))
}))

// ---- Tablero de promesas de pago ----
app.get('/api/promises', route(() => {
	let rows = []
	try {
		rows = db.prepare(`SELECT * FROM promises WHERE status = 'pending' OR (status IN ('kept', 'broken') AND closed_at > ?) ORDER BY at`).all(Date.now() - 14 * 864e5)
	} catch {}
	return rows.map(p => {
		const i = p.conv_key.indexOf(':')
		const accountId = Number(p.conv_key.slice(0, i)), jid = p.conv_key.slice(i + 1)
		const c = manager.conversation(accountId, jid)
		return { id: p.id, key: p.conv_key, accountId, phone: jid.split('@')[0], name: c?.name || null, at: p.at, amount: p.amount, text: p.text, status: p.status, closedAt: p.closed_at }
	})
}))

// ---- Almacenamiento: cuántos días se guardan fotos, audios y documentos ----
const storageInfo = () => { const d = diskInfo(); return { days: mediaDays(), chatMonths: chatMonths(), mediaMb: d.parts.media?.mb || 0, dbMb: d.parts['multiwa.db']?.mb || 0, freeMb: d.freeMb, totalMb: d.totalMb } }
app.get('/api/settings/storage', route(() => storageInfo()))
app.put('/api/settings/storage', route(req => {
	if (req.body.chatMonths !== undefined) setChatMonths(req.body.chatMonths)
	if (req.body.days !== undefined) setMediaDays(req.body.days)
	manager.emit('event', { type: 'conversations.changed', data: {} })
	return storageInfo()
}))

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

app.delete('/api/campaigns/:cid', route(req => {
	const id = Number(req.params.cid)
	const c = campaigns.get(id)
	if (!c) throw Object.assign(new Error('Envío no encontrado'), { status: 404 })
	if (c.status === 'running') throw new Error('Primero pausa o cancela el envío')
	campaigns.remove(id)
	return { ok: true }
}))

app.post('/api/campaigns/:cid/retry', route(req => {
	const id = Number(req.params.cid)
	if (!campaigns.get(id)) throw Object.assign(new Error('Envío no encontrado'), { status: 404 })
	const retried = campaigns.retryFailed(id)
	return { retried, campaign: campaigns.get(id) }
}))

app.post('/api/campaigns/:cid/force', route(req => {
	const id = Number(req.params.cid)
	const c = campaigns.get(id)
	if (!c) throw Object.assign(new Error('Envío no encontrado'), { status: 404 })
	if (c.kind !== 'safe') throw new Error('Solo aplica al modo seguro')
	return campaigns.setForced(id, req.body.forced !== false)
}))

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

// ---- Editar / eliminar para todos ----
const baileysSession = req => {
	const s = manager.get(accountParam(req))
	if (!s.editMessage) throw new Error('Esto no está disponible en cuentas de la API oficial')
	return s
}
app.post('/api/messages/:id/:msgId/edit', route(req => baileysSession(req).editMessage(req.params.msgId, req.body.text)))
app.post('/api/messages/:id/:msgId/delete', route(req => baileysSession(req).deleteForEveryone(req.params.msgId)))

// ---- Perfil de WhatsApp de cada número (foto, nombre, info) ----
app.get('/api/accounts/:id/profile', route(req => baileysSession(req).getProfile()))
app.put('/api/accounts/:id/profile', route(async req => {
	const s = baileysSession(req)
	if (req.body.name !== undefined) await s.setProfileName(req.body.name)
	if (req.body.status !== undefined) await s.setProfileStatus(req.body.status)
	return s.getProfile()
}))
app.post('/api/accounts/:id/profile/photo', upload.single('file'), route(async req => {
	const s = baileysSession(req)
	if (!req.file) throw new Error('Elige una foto')
	await s.setProfilePhoto(req.file.buffer)
	return s.getProfile()
}))
app.delete('/api/accounts/:id/profile/photo', route(async req => {
	const s = baileysSession(req)
	await s.removeProfilePhoto()
	return s.getProfile()
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
	if (mail && url.pathname === '/correo/ws') return mail.mailUpgrade(req, socket, head)
	const who = url.pathname === '/ws' ? checkToken(url.searchParams.get('token')) : null
	if (!who) {
		socket.destroy()
		return
	}
	wss.handleUpgrade(req, socket, head, ws => { ws.deviceId = who.id; touchNow(who.id); wss.emit('connection', ws) })
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
	ws.on('pong', () => { ws.isAlive = true; touch(ws.deviceId) })
	ws.on('close', () => touchNow(ws.deviceId))
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
	mail?.startMail().catch(e => note(null, 'mail-error', e.message))
	await manager.startAll()
})

const shutdown = async () => {
	for (const s of manager.sessions.values()) await s.stop()
	await mail?.stopMail().catch(() => {})
	process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
