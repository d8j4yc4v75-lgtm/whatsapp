import crypto from 'node:crypto'
import { db } from './db.js'

// Ubicación desde la app:
// - «Ubicación actual»: se manda como ubicación normal de WhatsApp (el cliente ve el mapa en su chat).
// - «En tiempo real»: WhatsApp solo deja compartir la ubicación en tiempo real desde la app del teléfono,
//   no desde dispositivos vinculados (como esta app o WhatsApp Web). Por eso se manda la ubicación actual
//   y un enlace a una página con el mapa que se actualiza mientras la app esté abierta, hasta que termine
//   el tiempo elegido o la detengas. Al terminar, la página ya no muestra la ubicación.

db.exec(`CREATE TABLE IF NOT EXISTS live_locations (
	token TEXT PRIMARY KEY,
	account_id INTEGER NOT NULL,
	jid TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	stopped_at INTEGER,
	lat REAL,
	lng REAL,
	accuracy REAL,
	heading REAL,
	speed REAL,
	updated_at INTEGER
)`)

const DURATIONS = { 15: '15 minutos', 60: '1 hora', 480: '8 horas' }
const num = v => (v === null || v === undefined || v === '' ? null : Number(v))

/** Lee y valida una posición enviada por el navegador */
export function parsePosition(b = {}) {
	const lat = num(b.lat)
	const lng = num(b.lng)
	if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
		throw new Error('Ubicación no válida')
	}
	const opt = (v, max) => { const n = num(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : null }
	return { lat, lng, accuracy: opt(b.accuracy, 100000), heading: opt(b.heading, 360), speed: opt(b.speed, 1000) }
}

const clean = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : undefined)
const isActive = r => r && !r.stopped_at && r.expires_at > Date.now()
const info = r => ({ token: r.token, accountId: r.account_id, jid: r.jid, key: `${r.account_id}:${r.jid}`, startedAt: r.started_at, expiresAt: r.expires_at, updatedAt: r.updated_at })

const q = {
	get: db.prepare('SELECT * FROM live_locations WHERE token = ?'),
	insert: db.prepare(`INSERT INTO live_locations (token, account_id, jid, started_at, expires_at, lat, lng, accuracy, heading, speed, updated_at)
		VALUES (@token, @account_id, @jid, @started_at, @expires_at, @lat, @lng, @accuracy, @heading, @speed, @updated_at)`),
	update: db.prepare('UPDATE live_locations SET lat = @lat, lng = @lng, accuracy = @accuracy, heading = @heading, speed = @speed, updated_at = @updated_at WHERE token = @token'),
	stop: db.prepare('UPDATE live_locations SET stopped_at = ? WHERE token = ? AND stopped_at IS NULL'),
	active: db.prepare('SELECT * FROM live_locations WHERE stopped_at IS NULL AND expires_at > ? ORDER BY started_at DESC'),
	del: db.prepare('DELETE FROM live_locations WHERE token = ?'),
	purge: db.prepare('DELETE FROM live_locations WHERE expires_at < ? OR stopped_at < ?')
}

// Las ubicaciones terminadas se borran del servidor después de un día
const purge = () => { const old = Date.now() - 864e5; try { q.purge.run(old, old) } catch {} }
purge()
setInterval(purge, 3600000).unref?.()

// Dirección pública de la app (detrás del proxy de Railway llega en x-forwarded-*)
const baseUrl = req => `${String(req.get('x-forwarded-proto') || req.protocol).split(',')[0]}://${String(req.get('x-forwarded-host') || req.get('host')).split(',')[0]}`

export function setupLocation({ app, route, manager, accountParam }) {
	const nativeLocation = p => ({ location: { degreesLatitude: p.lat, degreesLongitude: p.lng } })

	// Ubicación actual, como en WhatsApp
	app.post('/api/send-location', route(async req => {
		const accountId = accountParam(req)
		const p = parsePosition(req.body)
		const jid = req.body.jid || await manager.resolvePhone(accountId, req.body.phone)
		const content = nativeLocation(p)
		if (clean(req.body.name)) content.location.name = clean(req.body.name)
		if (clean(req.body.address)) content.location.address = clean(req.body.address)
		return manager.get(accountId).send(jid, content)
	}))

	// Burbuja de «ubicación en tiempo real» de WhatsApp (sin actualizaciones: ver sessions.js)
	app.post('/api/send-live-location', route(async req => {
		const accountId = accountParam(req)
		const p = parsePosition(req.body)
		const jid = req.body.jid || await manager.resolvePhone(accountId, req.body.phone)
		const session = manager.get(accountId)
		if (typeof session.sendLiveLocation !== 'function') throw new Error('La API oficial de WhatsApp no permite mandar ubicación en tiempo real. Usa «Enviar mi ubicación actual».')
		return session.sendLiveLocation(jid, { ...p, caption: clean(req.body.caption) })
	}))

	// Empezar a compartir en tiempo real: ubicación actual + enlace al mapa que se actualiza
	app.post('/api/live-location', route(async req => {
		const accountId = accountParam(req)
		const p = parsePosition(req.body)
		const minutes = DURATIONS[Number(req.body.minutes)] ? Number(req.body.minutes) : 60
		const jid = req.body.jid || await manager.resolvePhone(accountId, req.body.phone)
		const session = manager.get(accountId)
		const now = Date.now()
		const row = { token: crypto.randomBytes(18).toString('base64url'), account_id: accountId, jid, started_at: now, expires_at: now + minutes * 60000, ...p, updated_at: now }
		q.insert.run(row)
		const url = `${baseUrl(req)}/ubicacion/${row.token}`
		const messages = []
		try {
			try { messages.push(await session.send(jid, nativeLocation(p))) } catch {}
			messages.push(await session.send(jid, { text: `📍 Mi ubicación en tiempo real (durante ${DURATIONS[minutes]}):\n${url}` }))
		} catch (e) {
			q.del.run(row.token)
			throw e
		}
		return { share: info(row), url, messages }
	}))

	app.get('/api/live-location', route(() => q.active.all(Date.now()).map(info)))

	// Nueva posición desde la app (mientras está abierta)
	app.post('/api/live-location/:token', route(req => {
		const row = q.get.get(String(req.params.token))
		if (!row) throw Object.assign(new Error('Esa ubicación en tiempo real ya no existe'), { status: 404 })
		if (!isActive(row)) return { active: false }
		const p = parsePosition(req.body)
		q.update.run({ token: row.token, ...p, updated_at: Date.now() })
		return { active: true, expiresAt: row.expires_at }
	}))

	app.post('/api/live-location/:token/stop', route(req => {
		q.stop.run(Date.now(), String(req.params.token))
		return { ok: true }
	}))

	// ---- Página pública del enlace (la abre el cliente) ----
	app.get('/ubicacion/:token/data', (req, res) => {
		res.set('Cache-Control', 'no-store')
		const row = q.get.get(String(req.params.token))
		if (!row) return res.status(404).json({ active: false, missing: true })
		// Cuando termina ya no se muestra dónde estabas
		if (!isActive(row)) return res.json({ active: false, endedAt: row.stopped_at || row.expires_at })
		res.json({ active: true, lat: row.lat, lng: row.lng, accuracy: row.accuracy, heading: row.heading, speed: row.speed, updatedAt: row.updated_at, expiresAt: row.expires_at, now: Date.now() })
	})
	app.get('/ubicacion/:token', (req, res) => {
		res.set('Cache-Control', 'no-store')
		res.set('X-Robots-Tag', 'noindex, nofollow')
		res.type('html').send(PAGE)
	})
}

// Mapa que se actualiza cada pocos segundos (Leaflet + OpenStreetMap)
const PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Ubicación en tiempo real</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
	:root { --bg: #f2f2f7; --card: rgba(255,255,255,.9); --text: #111; --muted: #6b6b70; --accent: #1dab61; --danger: #e5484d; }
	@media (prefers-color-scheme: dark) { :root { --bg: #000; --card: rgba(28,28,30,.88); --text: #fff; --muted: #9a9aa0; --accent: #21c063; } }
	* { box-sizing: border-box; }
	html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 16px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
	#map { position: fixed; inset: 0; }
	.card { position: fixed; left: 12px; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); z-index: 1000; max-width: 520px; margin: 0 auto;
		background: var(--card); -webkit-backdrop-filter: blur(20px) saturate(180%); backdrop-filter: blur(20px) saturate(180%);
		border-radius: 22px; padding: 14px 16px; box-shadow: 0 10px 30px rgba(0,0,0,.18); }
	.card b { display: block; font-size: 17px; }
	.card small { color: var(--muted); display: block; margin-top: 2px; }
	.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--accent); margin-right: 6px; animation: p 1.6s infinite; }
	.dot.off { background: var(--muted); animation: none; }
	@keyframes p { 50% { opacity: .35; } }
	.row { display: flex; gap: 8px; margin-top: 10px; }
	.btn { flex: 1; text-align: center; text-decoration: none; padding: 10px; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; font-size: 15px; border: 0; }
	.btn.ghost { background: rgba(118,118,128,.16); color: var(--text); }
	.ended { position: fixed; inset: 0; display: grid; place-items: center; text-align: center; padding: 30px; z-index: 1001; background: var(--bg); }
	.ended[hidden] { display: none; }
	.ended .big { font-size: 46px; }
	.ended small { color: var(--muted); }
</style>
</head>
<body>
<div id="map"></div>
<div class="card" id="card"><b><span class="dot" id="dot"></span>Ubicación en tiempo real</b><small id="st">Cargando…</small>
	<div class="row"><a class="btn" id="open" target="_blank" rel="noopener">Abrir en Maps</a><button class="btn ghost" id="center">Centrar</button></div></div>
<div class="ended" id="ended" hidden><div><div class="big">📍</div><b>La ubicación en tiempo real terminó</b><br><small>Ya no se comparte esta ubicación.</small></div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
(function () {
	var token = location.pathname.split('/').filter(Boolean).pop()
	var map = L.map('map', { zoomControl: false, attributionControl: false }).setView([19.4326, -99.1332], 5)
	L.control.attribution({ position: 'topright', prefix: false }).addTo(map)
	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map)
	var marker = null, circle = null, follow = true, first = true, last = null, skew = 0
	map.on('dragstart', function () { follow = false })
	document.getElementById('center').onclick = function () { follow = true; if (last) map.setView([last.lat, last.lng], Math.max(map.getZoom(), 16)) }
	function ago(ms) {
		var s = Math.max(0, Math.round(ms / 1000))
		if (s < 10) return 'hace un momento'
		if (s < 60) return 'hace ' + s + ' s'
		var m = Math.round(s / 60)
		if (m < 60) return 'hace ' + m + ' min'
		return 'hace ' + Math.round(m / 60) + ' h'
	}
	function hm(t) { return new Date(t).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' }) }
	function paint() {
		if (!last) return
		var now = Date.now() + skew
		var stale = now - last.updatedAt > 120000
		document.getElementById('dot').className = 'dot' + (stale ? ' off' : '')
		document.getElementById('st').textContent = 'Actualizada ' + ago(now - last.updatedAt) + (last.accuracy ? ' · precisión ' + Math.round(last.accuracy) + ' m' : '') + ' · termina a las ' + hm(last.expiresAt)
	}
	function show(d) {
		last = d
		skew = d.now ? d.now - Date.now() : 0
		var ll = [d.lat, d.lng]
		if (!marker) {
			marker = L.circleMarker(ll, { radius: 9, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(map)
			circle = L.circle(ll, { radius: d.accuracy || 0, color: '#1a73e8', weight: 1, fillOpacity: 0.12 }).addTo(map)
		} else { marker.setLatLng(ll); circle.setLatLng(ll); circle.setRadius(d.accuracy || 0) }
		if (first || follow) map.setView(ll, first ? 16 : map.getZoom())
		first = false
		document.getElementById('open').href = 'https://www.google.com/maps/search/?api=1&query=' + d.lat + ',' + d.lng
		paint()
	}
	function end() {
		document.getElementById('ended').hidden = false
		clearInterval(timer)
	}
	function load() {
		fetch('/ubicacion/' + encodeURIComponent(token) + '/data', { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (d) {
			if (!d.active) return end()
			show(d)
		}).catch(function () {})
	}
	load()
	var timer = setInterval(function () { if (!document.hidden) load() }, 5000)
	setInterval(paint, 1000)
	document.addEventListener('visibilitychange', function () { if (!document.hidden) load() })
})()
</script>
</body>
</html>`
