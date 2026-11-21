import https from 'node:https'
import crypto from 'node:crypto'
import { db } from './db.js'
import { sendPush } from './push.js'

// Proxies automáticos: das los proxies una sola vez (una lista o una dirección con sesiones) y la app
// le asigna uno distinto a cada número —también a los nuevos, antes de vincularse—, los revisa cada
// 30 minutos (IP, país, si llegan a WhatsApp, qué tan rápido) y si uno falla cambia al número a otro solo.
// Un número con proxy puesto a mano no se toca.

// (este archivo se carga antes que sessions.js, así que aquí también se crean las columnas que usa)
for (const sql of [
	'ALTER TABLE accounts ADD COLUMN proxy TEXT',
	'ALTER TABLE accounts ADD COLUMN device TEXT',
	'ALTER TABLE accounts ADD COLUMN proxy_auto INTEGER', // NULL = automático si está activo · 1 = automático · 0 = a mano / sin proxy
	'ALTER TABLE accounts ADD COLUMN proxy_session TEXT'
]) { try { db.exec(sql) } catch {} }
// Los proxies que pusiste a mano antes de existir el modo automático se respetan como «a mano»
try { db.exec('UPDATE accounts SET proxy_auto = 0 WHERE proxy IS NOT NULL AND proxy_auto IS NULL') } catch {}

const q = {
	get: db.prepare("SELECT value FROM app_settings WHERE key = 'proxy_pool'"),
	set: db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('proxy_pool', ?)"),
	accounts: db.prepare("SELECT id, name, phone, status, proxy, proxy_auto, proxy_session FROM accounts WHERE kind IS NULL OR kind != 'cloud'"),
	account: db.prepare('SELECT * FROM accounts WHERE id = ?'),
	setProxy: db.prepare('UPDATE accounts SET proxy = ?, proxy_auto = ? WHERE id = ?'),
	setSession: db.prepare('UPDATE accounts SET proxy_session = ? WHERE id = ?')
}
const DEFAULT = { mode: 'off', list: [], gateway: '', fallback: true, checks: {} }
let cache = null
export function proxyConfig() {
	if (!cache) { try { cache = { ...DEFAULT, ...JSON.parse(q.get.get()?.value || '{}') } } catch { cache = { ...DEFAULT } } }
	return cache
}
function save(cfg) { cache = cfg; q.set.run(JSON.stringify(cfg)) }

/**
 * Convierte cualquier formato común a una URL: http://usuario:clave@host:puerto
 * Acepta: esquema://usuario:clave@host:puerto · usuario:clave@host:puerto · host:puerto:usuario:clave · host:puerto
 */
export function parseProxy(line) {
	let v = String(line || '').trim()
	if (!v || v.startsWith('#')) return null
	if (!/^[a-z0-9]+:\/\//i.test(v)) {
		const parts = v.split(':')
		if (!v.includes('@') && parts.length === 4) v = `${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}` // host:puerto:usuario:clave
		v = `http://${v}`
	}
	let u
	try { u = new URL(v) } catch { return null }
	if (!/^(https?|socks[45]h?):$/.test(u.protocol) || !u.hostname || !u.port) return null
	return u.toString().replace(/\/$/, '')
}
export const proxyLabel = v => { try { const u = new URL(v); return `${u.hostname}:${u.port}` } catch { return null } }

/** Una URL de sesión estable para este número (modo «dirección con sesiones») */
function gatewayUrl(template, session) {
	return template.replace(/\{(sesion|sesión|session)\}/gi, session)
}
const newSession = id => `mwa${id}${crypto.randomBytes(3).toString('hex')}`

/** Guarda la configuración (modo, lista o dirección con sesiones) y devuelve avisos */
export function saveProxyConfig({ mode, list, gateway, fallback }) {
	const cfg = { ...proxyConfig() }
	if (mode !== undefined) {
		if (!['off', 'list', 'gateway'].includes(mode)) throw new Error('Modo inválido')
		cfg.mode = mode
	}
	if (list !== undefined) {
		const lines = String(Array.isArray(list) ? list.join('\n') : list).split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
		const parsed = [], bad = []
		for (const l of lines) { const p = parseProxy(l); if (p) { if (!parsed.includes(p)) parsed.push(p) } else bad.push(l) }
		if (bad.length) throw new Error(`No entendí ${bad.length === 1 ? 'esta línea' : 'estas líneas'}: ${bad.slice(0, 3).join(' · ')}. Usa http://usuario:clave@host:puerto o host:puerto:usuario:clave`)
		cfg.list = parsed
		// Ya no se revisan los que quitaste
		cfg.checks = Object.fromEntries(Object.entries(cfg.checks || {}).filter(([k]) => parsed.includes(k) || k.startsWith('gw:')))
	}
	if (gateway !== undefined) {
		const g = String(gateway || '').trim()
		if (g) {
			const sample = parseProxy(gatewayUrl(g, 'prueba123'))
			if (!sample) throw new Error('La dirección debe ser como http://usuario-session-{sesion}:clave@host:puerto')
		}
		cfg.gateway = g
	}
	if (fallback !== undefined) cfg.fallback = Boolean(fallback)
	if (cfg.mode === 'list' && !cfg.list.length) throw new Error('Pega al menos un proxy')
	if (cfg.mode === 'gateway' && !cfg.gateway) throw new Error('Pega la dirección del proxy con sesiones')
	save(cfg)
	return cfg
}

// ---- Prueba de un proxy ----
const IP_URL = process.env.PROXY_IP_URL || 'https://api.ipify.org?format=json'
const WA_URL = process.env.PROXY_WA_URL || 'https://web.whatsapp.com/'
async function agentFor(url) {
	if (url.startsWith('socks')) { const { SocksProxyAgent } = await import('socks-proxy-agent'); return new SocksProxyAgent(url) }
	const { HttpsProxyAgent } = await import('https-proxy-agent')
	return new HttpsProxyAgent(url)
}
function getVia(agent, url, timeout = 12000) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { agent, timeout, headers: { 'user-agent': 'Mozilla/5.0' } }, res => {
			let body = ''
			res.on('data', c => { if (body.length < 4000) body += c })
			res.on('end', () => resolve({ status: res.statusCode, body }))
		})
		req.on('timeout', () => req.destroy(new Error('No respondió a tiempo')))
		req.on('error', reject)
	})
}
async function countryOf(ip) {
	try {
		const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(8000) })
		const j = await r.json()
		return j?.success === false ? null : { country: j.country_code || null, city: j.city || null }
	} catch { return null }
}
/** Prueba un proxy: IP de salida, país, si llega a WhatsApp y cuánto tarda */
export async function checkProxy(url) {
	const t0 = Date.now()
	try {
		const agent = await agentFor(url)
		const ipRes = await getVia(agent, IP_URL)
		const ms = Date.now() - t0
		// Si el proxy contesta él mismo (407 = usuario o contraseña, 5xx = no pudo salir), no sirve
		if (ipRes.status === 407) throw new Error('407')
		if (ipRes.status < 200 || ipRes.status >= 300) throw new Error(`El proxy respondió ${ipRes.status}`)
		let ip = null
		try { ip = JSON.parse(ipRes.body).ip } catch { ip = String(ipRes.body).trim().slice(0, 45) || null }
		const wa = await getVia(agent, WA_URL).then(r => r.status >= 200 && r.status < 500 && r.status !== 407).catch(() => false)
		const geo = ip ? await countryOf(ip) : null
		return { ok: wa, ms, ip, country: geo?.country || null, city: geo?.city || null, at: Date.now(), error: wa ? null : 'No llega a WhatsApp' }
	} catch (e) {
		const msg = String(e?.message || e)
		return { ok: false, ms: null, ip: null, at: Date.now(), error: /407/.test(msg) ? 'Usuario o contraseña incorrectos' : /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(msg) ? 'No se pudo conectar al proxy' : msg.slice(0, 80) }
	}
}

// ---- Asignación ----
const usable = (cfg, url) => { const c = cfg.checks?.[url]; return !c || c.ok || (c.fails || 0) < 2 }
/** Elige el proxy para un número: el que funcione, de México si se puede, con menos números y más rápido */
function pickFor(cfg, accountId, avoid = []) {
	if (cfg.mode === 'gateway') return null
	const counts = new Map(cfg.list.map(u => [u, 0]))
	for (const a of q.accounts.all()) if (a.id !== accountId && a.proxy && counts.has(a.proxy)) counts.set(a.proxy, counts.get(a.proxy) + 1)
	// Primero los que funcionan (o aún no se prueban); un proxy que falló solo si no queda otro
	let cands = cfg.list.filter(u => !avoid.includes(u) && cfg.checks?.[u]?.ok !== false)
	if (!cands.length) cands = cfg.list.filter(u => usable(cfg, u) && !avoid.includes(u))
	if (!cands.length) return null
	const score = u => { const c = cfg.checks?.[u]; return counts.get(u) * 1000 + (c?.ok === false ? 500 : 0) + (c?.country && c.country !== 'MX' ? 100 : 0) + (c?.ms ? Math.min(99, c.ms / 100) : 50) }
	return cands.sort((x, y) => score(x) - score(y))[0]
}
const eligible = a => a.proxy_auto == null || a.proxy_auto === 1

/** Antes de conectar: si el número usa el modo automático y aún no tiene proxy, se le asigna uno. Devuelve si cambió. */
export function ensureAssigned(accountId) {
	const cfg = proxyConfig()
	const a = q.account.get(accountId)
	if (!a || a.kind === 'cloud' || !eligible(a)) return false
	if (cfg.mode === 'off') {
		// Se apagó el automático: los que tenía asignados se quedan sin proxy
		if (a.proxy_auto === 1 && a.proxy) { q.setProxy.run(null, null, accountId); return true }
		return false
	}
	if (cfg.mode === 'gateway') {
		let session = a.proxy_session
		if (!session) { session = newSession(accountId); q.setSession.run(session, accountId) }
		const url = parseProxy(gatewayUrl(cfg.gateway, session))
		if (url && url !== a.proxy) { q.setProxy.run(url, 1, accountId); return true }
		return false
	}
	if (a.proxy && cfg.list.includes(a.proxy) && usable(cfg, a.proxy)) return false
	const url = pickFor(cfg, accountId)
	if (url) { q.setProxy.run(url, 1, accountId); return true }
	if (a.proxy && !cfg.list.includes(a.proxy)) { q.setProxy.run(null, 1, accountId); return true } // su proxy ya no está en la lista
	return false
}

/**
 * La conexión de un número falló varias veces seguidas por el proxy (no por WhatsApp).
 * Cambia a otro proxy (o a otra sesión) y, si no hay ninguno que sirva, a conexión directa si así lo elegiste.
 * Devuelve el texto de lo que hizo, o null si no cambió nada.
 */
export function onProxyFailure(accountId, reason) {
	const cfg = proxyConfig()
	const a = q.account.get(accountId)
	if (!a || !eligible(a) || cfg.mode === 'off' || !a.proxy) return null
	const now = Date.now()
	let did = null
	if (cfg.mode === 'gateway') {
		const session = newSession(accountId)
		q.setSession.run(session, accountId)
		q.setProxy.run(parseProxy(gatewayUrl(cfg.gateway, session)), 1, accountId)
		did = 'le asigné otra IP del proxy'
	} else {
		const prev = cfg.checks[a.proxy] || {}
		cfg.checks[a.proxy] = { ...prev, ok: false, fails: (prev.fails || 0) + 1, at: now, error: String(reason || 'La conexión falló').slice(0, 80) }
		save(cfg)
		const next = pickFor(cfg, accountId, [a.proxy])
		if (next) { q.setProxy.run(next, 1, accountId); did = `lo cambié a ${proxyLabel(next)}` }
		else if (cfg.fallback) { q.setProxy.run(null, 1, accountId); did = 'no hay otro proxy que funcione: se conecta sin proxy mientras' }
	}
	if (did) {
		const label = proxyLabel(a.proxy)
		try { sendPush({ title: `🌐 ${a.name}: su proxy falló`, body: `El proxy ${label} no respondió; ${did}.`, url: '/#/proxies' }) } catch {}
	}
	return did
}
/** La conexión por el proxy funcionó: queda marcado como bueno */
export function onProxyOk(accountId) {
	const cfg = proxyConfig()
	const a = q.account.get(accountId)
	if (!a?.proxy || cfg.mode !== 'list' || !cfg.list.includes(a.proxy)) return
	const c = cfg.checks[a.proxy]
	if (c && c.ok && !c.fails) return
	cfg.checks[a.proxy] = { ...(c || {}), ok: true, fails: 0, at: Date.now(), error: null }
	save(cfg)
}

// ---- Revisión periódica ----
let running = false
export const timing = { stagger: () => 20000 + Math.random() * 20000 }
/** Prueba todos los proxies y reacomoda a los números que lo necesiten (sin cortar conexiones que funcionan) */
export async function checkAll(manager, { restartAll = false } = {}) {
	if (running) return proxyConfig()
	running = true
	try {
		const cfg = proxyConfig()
		const urls = cfg.mode === 'list' ? cfg.list : cfg.mode === 'gateway' ? [...new Set(q.accounts.all().filter(a => eligible(a) && a.proxy).map(a => a.proxy))] : []
		for (const u of urls) {
			const r = await checkProxy(u)
			const prev = cfg.checks[cfg.mode === 'gateway' ? `gw:${u}` : u] || {}
			const entry = { ...r, fails: r.ok ? 0 : (prev.fails || 0) + 1 }
			proxyConfig().checks[cfg.mode === 'gateway' ? `gw:${u}` : u] = entry
			save(proxyConfig())
		}
		// En modo sesiones se olvidan las pruebas de sesiones que ya nadie usa
		if (cfg.mode === 'gateway') {
			const live = new Set(urls.map(u => `gw:${u}`))
			for (const k of Object.keys(proxyConfig().checks)) if (k.startsWith('gw:') && !live.has(k)) delete proxyConfig().checks[k]
			save(proxyConfig())
		}
		rebalance(manager, { restartAll })
		return proxyConfig()
	} finally { running = false }
}
/** Asigna proxy a quien no tiene y saca de los proxies caídos a los números que no están conectados */
export function rebalance(manager, { restartAll = false } = {}) {
	const restart = []
	for (const a of q.accounts.all()) {
		if (!eligible(a)) continue
		const s = manager?.sessions?.get(a.id)
		const open = s?.status === 'connected'
		const cfg = proxyConfig()
		// Una conexión que funciona por un proxy que sigue en tu lista no se corta (aunque la prueba diga otra cosa)
		if (open && !restartAll && a.proxy && cfg.mode === 'list' && cfg.list.includes(a.proxy)) continue
		if (ensureAssigned(a.id) && s && s.status !== 'logged_out') restart.push(s)
	}
	// Reconecta escalonado (20–40 s entre uno y otro) para no mover todos tus números al mismo tiempo
	restart.forEach((s, i) => setTimeout(() => {
		if (s.sock) s.sock.end(new Error('Cambio de proxy'))
		else if (s.status !== 'logged_out') s.start().catch(() => {})
	}, i * timing.stagger()))
	return restart.length
}
export function startProxyMonitor(manager) {
	setTimeout(() => checkAll(manager).catch(() => {}), 60000).unref?.()
	setInterval(() => checkAll(manager).catch(() => {}), 30 * 60000).unref?.()
}

/** Estado para la pantalla */
export function proxyState() {
	const cfg = proxyConfig()
	const accounts = q.accounts.all().map(a => ({
		id: a.id, name: a.name, status: a.status,
		mode: a.proxy_auto === 0 ? (a.proxy ? 'manual' : 'none') : 'auto',
		proxy: a.proxy ? proxyLabel(a.proxy) : null,
		check: a.proxy ? cfg.checks?.[cfg.mode === 'gateway' ? `gw:${a.proxy}` : a.proxy] || null : null
	}))
	const list = cfg.list.map(u => ({ url: u, label: proxyLabel(u), check: cfg.checks?.[u] || null, used: accounts.filter(a => a.proxy === proxyLabel(u)).map(a => a.name) }))
	const autoCount = accounts.filter(a => a.mode === 'auto').length
	const warnings = []
	const working = list.filter(p => !p.check || p.check.ok).length
	if (cfg.mode === 'list' && working < autoCount) warnings.push(`Tienes ${autoCount} números en automático y ${working} proxies que funcionan: algunos números comparten IP. Lo ideal es uno por número.`)
	const foreign = list.filter(p => p.check?.country && p.check.country !== 'MX')
	if (foreign.length) warnings.push(`${foreign.length} proxy(s) salen fuera de México (${[...new Set(foreign.map(p => p.check.country))].join(', ')}). Para números de México conviene que salgan de México.`)
	const dead = list.filter(p => p.check && !p.check.ok)
	if (dead.length) warnings.push(`${dead.length} proxy(s) no funcionan ahora; los números se pasan solos a otros.`)
	if (cfg.mode === 'gateway' && cfg.gateway && !/\{(sesion|sesión|session)\}/i.test(cfg.gateway)) warnings.push('La dirección no tiene {sesion}: todos tus números saldrían por la misma IP rotativa. Agrega {sesion} donde tu proveedor pone el número de sesión.')
	return { mode: cfg.mode, list, listText: cfg.list.join('\n'), gateway: cfg.gateway, fallback: cfg.fallback, accounts, warnings, checking: running }
}
