'use strict'

// ---------- Utilidades ----------
const $ = (sel, el = document) => el.querySelector(sel)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const store = {
	get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
	set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }
}

const COLORS = ['#25D366', '#007AFF', '#FF9500', '#AF52DE', '#FF2D55', '#00B8D9', '#E6B800', '#8E8E93']
const ICONS = { image: '📷 Foto', video: '🎥 Video', audio: '🎤 Audio', document: '📄 Documento', sticker: '🏷️ Sticker' }
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches

const S = {
	token: store.get('token', null),
	accounts: [],
	convs: [],
	labels: [],
	msgs: {},
	more: {},
	campaigns: [],
	templates: {},
	filter: { account: null, label: null, unread: false, waiting: false, reminders: false, archived: false, q: '' },
	replies: [],
	statsDays: 7,
	restDays: [0],
	wsOk: false,
	ws: null,
	active: null,
	recorder: null,
	ai: { review: true }
}

function toast(text, ms = 3500) {
	const t = $('#toast')
	t.textContent = text
	t.hidden = false
	clearTimeout(toast.timer)
	toast.timer = setTimeout(() => { t.hidden = true }, ms)
}

async function api(method, path, body, isForm) {
	const opts = { method, headers: { Authorization: 'Bearer ' + S.token } }
	if (body && !isForm) {
		opts.headers['Content-Type'] = 'application/json'
		opts.body = JSON.stringify(body)
	} else if (body) {
		opts.body = body
	}
	const res = await fetch('/api' + path, opts)
	const data = await res.json().catch(() => ({}))
	if (res.status === 401) { logout(); throw new Error('Sesión expirada') }
	if (!res.ok) throw new Error(data.error || 'Error ' + res.status)
	return data
}

const enc = encodeURIComponent
const mediaURL = m => `/api/media/${m.accountId}/${enc(m.id)}?token=${enc(S.token)}${m.type === 'audio' ? '&format=m4a' : ''}`
const account = id => S.accounts.find(a => a.id === id)
const label = id => S.labels.find(l => l.id === id)
const conv = key => S.convs.find(c => c.key === key)
const keyOf = m => m.accountId + ':' + m.jid
const accOf = key => Number(String(key).split(':')[0])
const jidOf = key => String(key).slice(String(key).indexOf(':') + 1)
// Número con espacios, como lo muestra WhatsApp: +52 1 664 204 7600
function fmtPhone(p) {
	const d = String(p || '').replace(/\D/g, '')
	if (!d) return ''
	if (/^521\d{10}$/.test(d)) return `+52 1 ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}`
	if (/^52\d{10}$/.test(d)) return `+52 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`
	if (/^1\d{10}$/.test(d)) return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`
	return '+' + d
}
// Mostrar el número en lugar del nombre (los grupos sí conservan su nombre)
const convName = c => c?.isGroup ? (c?.name || 'Grupo') : (c?.phone ? fmtPhone(c.phone) : (c?.name || c?.jid || ''))
// Spintax: {a|b|c} → una opción al azar (para la vista previa; el servidor hace lo mismo al enviar)
const spin = text => {
	let s = String(text || '')
	for (let i = 0; i < 6 && /\{[^{}]*\|[^{}]*\}/.test(s); i++) s = s.replace(/\{([^{}]*\|[^{}]*)\}/g, (m, o) => { const a = o.split('|'); return a[Math.floor(Math.random() * a.length)] })
	return s
}
const avatarURL = c => `/api/avatar/${enc(c.key)}?token=${enc(S.token)}`
// Silueta gris como la de WhatsApp cuando no hay foto
const PH_PERSON = '<svg class="ph" viewBox="0 0 212 212" aria-hidden="true"><path fill="currentColor" d="M106 106c21 0 38-17 38-39s-17-39-38-39-38 17-38 39 17 39 38 39Zm0 14c-37 0-80 19-80 44v30h160v-30c0-25-43-44-80-44Z"/></svg>'
const PH_GROUP = '<svg class="ph" viewBox="0 0 212 212" aria-hidden="true"><path fill="currentColor" d="M76 100c17 0 30-13 30-30S93 40 76 40 46 53 46 70s13 30 30 30Zm66 0c17 0 30-13 30-30s-13-30-30-30c-6 0-11 2-16 4 6 7 9 16 9 26s-3 19-9 26c5 3 10 4 16 4ZM76 114c-29 0-62 15-62 35v25h124v-25c0-20-33-35-62-35Zm66 0c-5 0-10 0-15 1 13 9 23 20 23 34v25h48v-25c0-20-29-35-56-35Z"/></svg>'
function avatarHtml(c) {
	const img = c.isGroup ? '' : `<img src="${avatarURL(c)}" alt="" onerror="this.remove()">`
	return `<div class="avatar">${c.isGroup ? PH_GROUP : PH_PERSON}${img}</div>`
}
const totalUnread = () => S.convs.reduce((n, c) => n + (c.unread || 0), 0)

function statusText(a) {
	return { connected: 'Conectado', connecting: 'Conectando…', reconnecting: 'Reconectando…', qr: 'Esperando vinculación', logged_out: 'Sin vincular', error: 'Error de conexión' }[a.status] || 'Desconectado'
}
function statusColor(a) {
	return a.status === 'connected' ? 'var(--accent)' : ['qr', 'connecting', 'reconnecting'].includes(a.status) ? '#f5a623' : 'var(--danger)'
}

function initials(name) {
	const letters = String(name).split(/\s+/).slice(0, 2).map(w => [...w].find(ch => /\p{L}/u.test(ch))).filter(Boolean)
	return letters.length ? letters.join('').toUpperCase() : '#'
}
function avatarColor(s) {
	let h = 0
	for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
	return `hsl(${h % 360} 35% 55%)`
}

function timeLabel(ts) {
	const d = new Date(ts)
	const now = new Date()
	const day = 864e5
	const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
	if (ts >= startToday) return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
	if (ts >= startToday - day) return 'Ayer'
	if (ts >= startToday - 6 * day) return d.toLocaleDateString('es', { weekday: 'long' })
	return d.toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function linkify(text) {
	return esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
}

// ---------- Revisor de mensaje ----------
const RISKY_WORDS = ['urgente', 'último aviso', 'ultimo aviso', 'última oportunidad', 'ultima oportunidad', 'demanda', 'embargo', 'buró', 'buro de credito', 'jurídico', 'juridico', 'abogado', 'legal', 'cárcel', 'carcel', 'policía', 'policia', 'penal', 'denuncia', 'inmediato', 'inmediatamente', 'hoy mismo', 'sanción', 'sancion', 'consecuencias', 'visita domiciliaria', 'requerimiento', 'gratis', 'gana', 'promoción', 'oferta']

function reviewMessage(text) {
	const t = String(text || '')
	const low = t.toLowerCase()
	const issues = []
	if (!t.trim()) return { level: 'none', issues }
	if (/https?:\/\/|www\.|\.(com|mx|net|link|ly)\b/i.test(t)) issues.push(['alto', 'Tiene un link. En el primer mensaje los links hacen que WhatsApp lo marque como spam; mándalo hasta que te contesten.'])
	const words = RISKY_WORDS.filter(w => low.includes(w))
	if (words.length) issues.push(['alto', `Usa palabras que suenan a amenaza o spam: «${words.slice(0, 4).join('», «')}». La gente reporta más y CONDUSEF prohíbe intimidar. Usa un tono amable.`])
	const letters = t.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '')
	const caps = t.replace(/[^A-ZÁÉÍÓÚÑ]/g, '').length
	if (letters.length > 20 && caps / letters.length > 0.3) issues.push(['medio', 'Tiene muchas MAYÚSCULAS; se lee como si gritaras.'])
	if (/!{2,}|\?{2,}/.test(t)) issues.push(['medio', 'Evita «!!» o «??» seguidos.'])
	const emojis = (t.match(/\p{Extended_Pictographic}/gu) || []).length
	if (emojis > 3) issues.push(['medio', 'Tiene muchos emojis; uno o ninguno es mejor.'])
	if (t.length > 400) issues.push(['medio', `Es largo (${t.length} caracteres). Los mensajes cortos (menos de 300) se responden más y se reportan menos.`])
	if (!/\{\{1\}\}|\{nombre\}/i.test(t)) issues.push(['medio', 'No lleva el nombre de la persona ({{1}}). Un mensaje personalizado se reporta mucho menos.'])
	if (!/baja/i.test(t)) issues.push(['bajo', 'Agrega «Si no deseas recibir mensajes, responde BAJA». Mejor que te pidan baja a que te reporten.'])
	if (!/\?/.test(t)) issues.push(['bajo', 'Termina con una pregunta (por ejemplo «¿Te comparto opciones?») para que contesten; las respuestas cuidan tu número.'])
	const level = issues.some(i => i[0] === 'alto') ? 'alto' : issues.some(i => i[0] === 'medio') ? 'medio' : 'bajo'
	return { level, issues }
}

function reviewHTML(text) {
	const r = reviewMessage(text)
	if (r.level === 'none') return ''
	const head = { alto: ['🔴', 'Riesgo alto'], medio: ['🟡', 'Riesgo medio'], bajo: ['🟢', 'Riesgo bajo'] }[r.level]
	return `<div class="review ${r.level}"><b>${head[0]} ${head[1]} de reportes o restricción</b>${r.issues.map(([sev, msg]) => `<div>${sev === 'alto' ? '⛔' : sev === 'medio' ? '⚠️' : '💡'} ${esc(msg)}</div>`).join('')}${!r.issues.length ? '<div>✅ El mensaje se ve bien.</div>' : ''}</div>`
}

const HEALTH = { green: ['🟢', 'Sano'], yellow: ['🟡', 'Con cuidado'], red: ['🔴', 'Descansar'] }
const healthDot = a => a?.health ? `<i class="hdot ${a.health.level}" title="${HEALTH[a.health.level][1]}"></i>` : ''

// Íconos (trazo fino, estilo iOS)
const svg = (d, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const IC = {
	chats: svg('<path d="M4.5 12a7.5 7.5 0 1 1 3.1 6.1L4 19.5l1.3-3.4A7.4 7.4 0 0 1 4.5 12Z"/><path d="M8.5 11h7M8.5 14h4.5"/>'),
	sparkle: svg('<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/>'),
	send: svg('<path d="M21 3 10.5 13.5"/><path d="M21 3 14.5 21l-4-7.5L3 9.5 21 3Z"/>'),
	phone: svg('<rect x="7" y="2.5" width="10" height="19" rx="2.6"/><path d="M11 18.5h2"/>'),
	gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
	compose: svg('<path d="M11 4H5.5A2.5 2.5 0 0 0 3 6.5v12A2.5 2.5 0 0 0 5.5 21h12a2.5 2.5 0 0 0 2.5-2.5V13"/><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8l-3.8.9.9-3.8Z"/>'),
	plus: svg('<path d="M12 5v14M5 12h14"/>'),
	back: svg('<path d="M15 19 8 12l7-7"/>', 'back-ic'),
	more: svg('<circle cx="12" cy="12" r="9"/><circle cx="8" cy="12" r=".6" fill="currentColor"/><circle cx="12" cy="12" r=".6" fill="currentColor"/><circle cx="16" cy="12" r=".6" fill="currentColor"/>'),
	mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
	sendFill: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6V10l12.6 2-12.6 2Z"/></svg>',
	trash: svg('<path d="M4 6.5h16M9 6.5V4.5h6v2M6.5 6.5l1 13h9l1-13M10 10.5v6M14 10.5v6"/>'),
	archive: svg('<rect x="3" y="4" width="18" height="4.5" rx="1.2"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4"/>'),
	unarchive: svg('<rect x="3" y="4" width="18" height="4.5" rx="1.2"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M12 17.5v-5M9.5 15l2.5-2.5 2.5 2.5"/>'),
	note: svg('<path d="M14.5 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V7.5Z"/><path d="M14.5 3v4.5H19M8.5 12.5h7M8.5 16h5"/>'),
	clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>'),
	tag: svg('<path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8a1.4 1.4 0 0 1 0 2l-7 7a1.4 1.4 0 0 1-2 0Z"/><circle cx="8" cy="8" r="1.4"/>'),
	doc: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
	template: svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
	chevron: svg('<path d="m9 6 6 6-6 6"/>', 'chev'),
	copy: svg('<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>'),
	pencil: svg('<path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/><path d="m14.5 5.5 3 3"/>'),
	ban: svg('<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>'),
	user: svg('<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>'),
	call: svg('<path d="M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5V19a1.5 1.5 0 0 1-1.5 1.5A15.5 15.5 0 0 1 3.5 5.5 1.5 1.5 0 0 1 5 4Z"/>'),
	bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
	image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 2.5-2.5L20 19"/>'),
	camera: svg('<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="12.5" r="3.5"/>')
}
const TICK1 = '<svg class="tick" viewBox="0 0 16 11" aria-hidden="true"><path d="M1.5 5.8 5 9.2l6.5-7.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const TICK2 = '<svg class="tick" viewBox="0 0 16 11" aria-hidden="true"><path d="M1.5 5.8 5 9.2l6.5-7.7M7.6 8.4l.8.8 6.1-7.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
// Encabezado grande estilo iOS ("Chats", "Ajustes"…)
const largeBar = (title, right = '', left = '') => `<header class="bar large"><div class="bar-row">${left}<span class="grow"></span>${right}</div></header><h1 class="large-title">${title}</h1>`
// Barra de navegación con regreso (‹ Cuentas) y título centrado
const navBar = (title, backHash, backText, right = '') => `<header class="bar nav"><button class="icon-btn back" data-act="go" data-val="${backHash}" aria-label="Atrás">${IC.back}<span>${backText}</span></button><h1 id="nav-title">${title}</h1><span class="nav-right">${right}</span></header>`

function accountTag(id) {
	const a = account(id)
	return `<span class="tag" style="--c:${esc(a?.color || '#8E8E93')}">${esc(a?.name || '?')}</span>`
}

function updateBadge() {
	const n = totalUnread()
	if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {})
	const b = $('#tab-badge')
	if (b) { b.textContent = n; b.hidden = !n }
	// En el chat, junto a la flecha de regreso: no leídos de los demás chats (como en iPhone)
	const bb = $('#back-badge')
	if (bb) { const others = n - (conv(S.active)?.unread || 0); bb.textContent = others; bb.hidden = others <= 0 }
}

// ---------- Acceso ----------
async function showLogin() {
	const { hasPassword } = await fetch('/auth/status').then(r => r.json())
	$('#app').innerHTML = `
		<form class="login" id="login">
			<img src="/icons/icon-192.png" alt="">
			<h1>MultiWA</h1>
			<p>${hasPassword ? 'Escribe tu contraseña para entrar.' : 'Bienvenido. Crea una contraseña para proteger tu bandeja (mínimo 6 caracteres).'}</p>
			<input type="password" id="pw" placeholder="Contraseña" autocomplete="${hasPassword ? 'current-password' : 'new-password'}" required minlength="6">
			${hasPassword ? '' : '<input type="password" id="pw2" placeholder="Repite la contraseña" autocomplete="new-password" required minlength="6">'}
			<button class="btn primary" type="submit">${hasPassword ? 'Entrar' : 'Crear contraseña'}</button>
		</form>`
	$('#login').onsubmit = async e => {
		e.preventDefault()
		const pw = $('#pw').value
		if (!hasPassword && pw !== $('#pw2').value) return toast('Las contraseñas no coinciden')
		const res = await fetch(hasPassword ? '/auth/login' : '/auth/setup', {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw })
		})
		const data = await res.json().catch(() => ({}))
		if (!res.ok) return toast(data.error || 'Error')
		S.token = data.token
		store.set('token', S.token)
		boot()
	}
}

function logout() {
	S.token = null
	store.set('token', null)
	S.ws?.close()
	showLogin()
}

// ---------- Datos y tiempo real ----------
async function loadAll() {
	const [accounts, convs, labels, replies] = await Promise.all([api('GET', '/accounts'), api('GET', '/conversations'), api('GET', '/labels'), api('GET', '/quick-replies')])
	S.accounts = accounts
	S.convs = convs
	S.labels = labels
	S.replies = replies
	api('GET', '/settings/rest-days').then(d => { S.restDays = d }).catch(() => {})
	api('GET', '/settings/ai').then(d => { S.ai = d }).catch(() => {})
	updateBadge()
}

function connectWS() {
	if (S.ws && S.ws.readyState <= 1) return
	const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${enc(S.token)}`)
	S.ws = ws
	ws.onopen = () => { S.wsOk = true; refreshStatusDot() }
	ws.onclose = () => {
		S.wsOk = false
		refreshStatusDot()
		if (S.ws === ws && S.token) setTimeout(() => { if (S.ws === ws) resync() }, 3000)
	}
	ws.onmessage = e => {
		try { handleEvent(JSON.parse(e.data)) } catch (err) { console.error(err) }
	}
}

async function resync() {
	try {
		await loadAll()
		if (S.active) await loadMessages(S.active)
		render()
	} catch {}
	connectWS()
}

function refreshStatusDot() {
	const d = $('#ws-dot')
	if (d) d.classList.toggle('on', S.wsOk)
}

function upsertConv(c) {
	if (!c) return
	S.convs = S.convs.filter(x => x.key !== c.key)
	// En la vista actual solo caben las que corresponden (archivadas vs normales)
	if (Boolean(c.archived) !== Boolean(S.filter.archived)) return
	const i = S.convs.findIndex(x => x.lastTs < c.lastTs)
	S.convs.splice(i < 0 ? S.convs.length : i, 0, c)
}

// Carga la lista según si estamos viendo archivadas o normales
async function loadConvList() {
	try { S.convs = await api('GET', '/conversations' + (S.filter.archived ? '?archived=1' : '')) } catch (e) { toast(e.message) }
	updateBadge()
	renderInbox(false)
}

function insertMsg(m) {
	const list = S.msgs[keyOf(m)]
	if (!list) return true
	const i = list.findIndex(x => x.id === m.id && x.accountId === m.accountId)
	if (i >= 0) { list[i] = m; return false }
	list.push(m)
	list.sort((a, b) => a.ts - b.ts)
	return true
}

function handleEvent({ type, data }) {
	switch (type) {
		case 'hello':
			S.accounts = data.accounts
			break
		case 'account.update': {
			const i = S.accounts.findIndex(a => a.id === data.id)
			if (i >= 0) S.accounts[i] = data
			else S.accounts.push(data)
			break
		}
		case 'account.removed':
			S.accounts = S.accounts.filter(a => a.id !== data.id)
			break
		case 'qr': {
			const a = account(data.accountId)
			if (a) { a.qr = data.qr; a.status = 'qr' }
			break
		}
		case 'message':
			insertMsg(data)
			break
		case 'message.status':
			for (const list of Object.values(S.msgs)) {
				const m = list.find(x => x.id === data.id && x.accountId === data.accountId)
				if (m) m.status = data.status === 0 ? 0 : Math.max(m.status, data.status)
			}
			break
		case 'conversation.update':
			if (data.key === S.active && data.unread > 0 && document.visibilityState === 'visible') {
				data.unread = 0
				api('POST', `/conversations/${enc(data.key)}/read`).catch(() => {})
			}
			upsertConv(data)
			updateBadge()
			break
		case 'campaign.update': {
			if (!data) return
			const i = S.campaigns.findIndex(c => c.id === data.id)
			if (i >= 0) S.campaigns[i] = data
			else S.campaigns.unshift(data)
			if (route().name === 'campaigns') renderCampaignList()
			return
		}
		case 'reminder':
			toast(`⏰ ${data.name}: ${data.text || 'Recordatorio'}`, 8000)
			return
		case 'conversation.removed':
			S.convs = S.convs.filter(x => x.key !== data.key)
			if (S.active === data.key && route().name === 'chat') go('#/')
			else { updateBadge(); if (route().name === 'inbox') renderInboxList() }
			return
		case 'conversations.changed':
			loadConvList()
			return
	}
	renderSoon(type)
}

let renderTimer
function renderSoon() {
	clearTimeout(renderTimer)
	renderTimer = setTimeout(render, 60)
}

async function loadMessages(jid, older) {
	const q = new URLSearchParams({ limit: '50' })
	const list = S.msgs[jid]
	if (older && list?.length) q.set('before', String(list[0].ts))
	const page = await api('GET', `/conversations/${enc(jid)}/messages?${q}`)
	S.msgs[jid] = older ? [...page, ...(list || [])] : page
	S.more[jid] = page.length === 50
}

const defaultFrom = key => accOf(key)

// ---------- Navegación ----------
function route() {
	const h = location.hash.replace(/^#\/?/, '')
	const [name, ...rest] = h.split('/')
	return { name: name || 'inbox', arg: rest.length ? decodeURIComponent(rest.join('/')) : null }
}
const go = hash => { location.hash = hash }

let lastRoute = ''
function render() {
	if (!S.token) return
	const r = route()
	const key = r.name + ':' + r.arg
	const changed = key !== lastRoute
	lastRoute = key
	if (r.name !== 'chat' && S.active) S.active = null

	if (r.name === 'chat') return renderChat(r.arg, changed)
	if (changed || !$('#view')) {
		$('#app').innerHTML = `<main class="view" id="view"></main>${tabs(r.name)}`
	}
	updateBadge()
	if (r.name === 'campaigns') renderCampaigns(changed)
	else if (r.name === 'accounts') renderAccounts()
	else if (r.name === 'account') renderAccount(Number(r.arg), changed)
	else if (r.name === 'settings') { if (changed) renderSettings() }
	else renderInbox(changed)
}

function tabs(active) {
	const t = (name, icon, text, href) =>
		`<a href="${href}" class="${active === name || (name === 'accounts' && active === 'account') ? 'active' : ''}">${icon}<span>${text}</span>${name === 'inbox' ? '<i class="badge" id="tab-badge" hidden></i>' : ''}</a>`
	const sends = S.accounts.length ? t('campaigns', IC.send, 'Envíos', '#/campaigns') : ''
	return `<nav class="tabs">${t('inbox', IC.chats, 'Chats', '#/')}${sends}${t('accounts', IC.phone, 'Cuentas', '#/accounts')}${t('settings', IC.gear, 'Ajustes', '#/settings')}</nav>`
}

// ---------- Bandeja ----------
function filteredConvs() {
	const f = S.filter
	const q = f.q.trim().toLowerCase()
	const digits = q.replace(/\D/g, '')
	const list = S.convs.filter(c => {
		if (f.account && c.accountId !== f.account) return false
		if (f.label && !c.labelIds.includes(f.label)) return false
		if (f.unread && !c.unread) return false
		if (f.waiting && (c.lastFromMe || c.isGroup || !c.lastTs)) return false
		if (f.reminders && !c.reminder) return false
		if (q) {
			return convName(c).toLowerCase().includes(q) || (digits && (c.phone || '').includes(digits)) || (c.lastText || '').toLowerCase().includes(q) || (c.note || '').toLowerCase().includes(q)
		}
		return true
	})
	// «Sin responder»: primero quien lleva más tiempo esperando; «Recordatorios»: el más próximo primero
	if (f.waiting) list.sort((a, b) => a.lastTs - b.lastTs)
	if (f.reminders) list.sort((a, b) => a.reminder.at - b.reminder.at)
	return list
}

function waitingLabel(ts) {
	const min = Math.round((Date.now() - ts) / 60000)
	if (min < 60) return `espera hace ${min} min`
	const h = Math.round(min / 60)
	if (h < 24) return `espera hace ${h} h`
	return `espera hace ${Math.round(h / 24)} día(s)`
}

function reminderLabel(at) {
	const d = new Date(at)
	const today = new Date()
	const sameDay = d.toDateString() === today.toDateString()
	const time = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
	if (sameDay) return `hoy ${time}`
	return `${d.toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

function renderInbox(full) {
	const view = $('#view')
	if (full) {
		view.innerHTML = `
			${largeBar('Chats', `<button class="icon-btn" data-act="new-chat" aria-label="Nuevo chat">${IC.compose}</button>`, `<i class="dot ${S.wsOk ? 'on' : ''}" id="ws-dot" title="Conexión con el servidor"></i>`)}
			${!isStandalone() && /iPhone|iPad/.test(navigator.userAgent) ? `<div class="install"><b>Instala la app</b>Toca <b style="display:inline">Compartir ⬆︎</b> y luego <b style="display:inline">«Añadir a pantalla de inicio»</b>. Así se abre como app y recibe notificaciones.</div>` : ''}
			<div class="search"><input id="q" type="search" placeholder="Buscar" value="${esc(S.filter.q)}"></div>
			<div class="chips" id="chips"></div>
			<ul class="list" id="convs"></ul>`
		$('#q').oninput = e => { S.filter.q = e.target.value; renderInboxList() }
	}
	renderChips()
	renderInboxList()
}

function renderChips() {
	const f = S.filter
	const chip = (act, val, text, on, color) =>
		`<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-val="${esc(val)}" ${color ? `style="--c:${esc(color)}"` : ''}>${esc(text)}</button>`
	$('#chips').innerHTML = [
		chip('f-all', '', 'Todos', !f.account && !f.label && !f.unread && !f.waiting && !f.reminders),
		chip('f-archived', '', 'Archivados', f.archived),
		chip('f-unread', '', 'No leídos', f.unread),
		chip('f-waiting', '', `Sin responder${S.convs.filter(c => !c.lastFromMe && !c.isGroup && c.lastTs).length ? ' (' + S.convs.filter(c => !c.lastFromMe && !c.isGroup && c.lastTs).length + ')' : ''}`, f.waiting, '#E5484D'),
		chip('f-reminders', '', `Recordatorios${S.convs.filter(c => c.reminder).length ? ' (' + S.convs.filter(c => c.reminder).length + ')' : ''}`, f.reminders, '#7C5CFF'),
		...S.accounts.map(a => chip('f-account', a.id, a.name, f.account === a.id, a.color)),
		...S.labels.map(l => chip('f-label', l.id, '# ' + l.name, f.label === l.id, l.color))
	].join('')
}

function renderInboxList() {
	const list = filteredConvs()
	const el = $('#convs')
	if (!list.length) {
		el.innerHTML = `<li class="empty"><div class="big">${S.accounts.length ? '📭' : '📱'}</div>
			${S.accounts.length ? 'Sin conversaciones.' : 'Aún no hay cuentas. Ve a <a href="#/accounts">Cuentas</a> y vincula tu primer WhatsApp.'}</li>`
		return
	}
	el.innerHTML = list.map(c => `
		<li><a class="row" href="#/chat/${enc(c.key)}">
			${avatarHtml(c)}
			<div class="body">
				<div class="top"><span class="name">${esc(convName(c))}</span><span class="time ${c.unread ? 'unread' : ''}">${c.lastTs ? timeLabel(c.lastTs) : ''}</span></div>
				<div class="bottom"><span class="preview">${c.lastFromMe ? 'Tú: ' : ''}${esc(c.lastText)}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
				<div class="tags">${accountTag(c.accountId)}${c.labelIds.map(label).filter(Boolean).map(l => `<span class="tag solid" style="--c:${esc(l.color)}">${esc(l.name)}</span>`).join('')}${c.reminder ? `<span class="tag" style="--c:#7C5CFF">${esc(reminderLabel(c.reminder.at))}</span>` : ''}${c.note ? '<span class="tag" style="--c:#B7791F">Nota</span>' : ''}${S.filter.waiting ? `<span class="tag" style="--c:#E5484D">${waitingLabel(c.lastTs)}</span>` : ''}</div>
			</div>
		</a></li>`).join('')
}

// ---------- Chat ----------
async function renderChat(jid, full) {
	if (full) {
		S.active = jid
		$('#app').innerHTML = `
			<header class="bar chat-bar">
				<button class="icon-btn back" data-act="back" aria-label="Atrás">${IC.back}<i class="badge" id="back-badge" hidden></i></button>
				<span id="c-avatar" class="c-avatar" data-act="contact-info"></span>
				<div class="title" data-act="contact-info"><b id="c-title"></b><small id="c-sub"></small></div>
				<button class="icon-btn" data-act="chat-menu" aria-label="Más opciones">${IC.more}</button>
			</header>
			<div id="c-banners"></div>
			<div class="msgs" id="msgs"><div class="empty">Cargando…</div></div>
			<footer class="composer">
				<div class="qr-pop" id="qr-pop" hidden></div>
				<div class="from">Enviando desde <span id="from"></span></div>
				<div class="suggest" id="suggest" hidden></div>
				<div class="hint24" id="hint24" hidden>Pasaron más de 24 h desde el último mensaje del cliente: solo puedes enviar una <a href="#" data-act="tpl-chat">plantilla 📋</a>.</div>
				<div class="compose-row" id="compose-row"></div>
				<input type="file" id="file" hidden>
			</footer>`
		renderComposer()
		bindMsgPress($('#msgs'))
		$('#file').onchange = e => {
			const f = e.target.files[0]
			e.target.value = ''
			if (f) sendFile(f)
		}
		renderChatHeader()
		renderFrom()
		try {
			await loadMessages(jid)
			if (S.active !== jid) return
			renderMessages(true)
			markRead(jid)
		} catch (e) { toast(e.message) }
		return
	}
	renderChatHeader()
	renderFrom()
	renderMessages(false)
}

function renderChatHeader() {
	const c = conv(S.active)
	$('#c-title').textContent = c ? convName(c) : fmtPhone(jidOf(S.active).split('@')[0])
	const av = $('#c-avatar'); if (av && c) av.innerHTML = avatarHtml(c)
	updateBadge()
	const parts = []
	if (c?.name) parts.push(c.name) // si WhatsApp tiene un nombre guardado, va de subtítulo
	const acc = account(accOf(S.active))
	if (acc) parts.push('vía ' + acc.name)
	if (c?.labelIds.length) parts.push(c.labelIds.map(label).filter(Boolean).map(l => l.name).join(', '))
	$('#c-sub').textContent = parts.join(' · ')
	const banners = $('#c-banners')
	if (banners) {
		const html = (c?.note ? `<div class="banner note" data-act="note">${IC.note}<span>${esc(c.note)}</span></div>` : '')
			+ (c?.reminder ? `<div class="banner reminder" data-act="reminder">${IC.clock}<span>${esc(reminderLabel(c.reminder.at))}${c.reminder.text ? ' · ' + esc(c.reminder.text) : ''}</span></div>` : '')
		if (banners.innerHTML !== html) banners.innerHTML = html
	}
}

// ---------- Info. del contacto ----------
async function openContactInfo() {
	const key = S.active
	const c = conv(key)
	if (!key) return
	sheet('Info. del contacto', '<div class="ci-loading">Cargando…</div>')
	$('#sheet .sheet')?.classList.add('full')
	let info
	try { info = await api('GET', `/conversations/${enc(key)}/info`) } catch (e) { const b = $('#sheet .sheet-body'); if (b) b.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return }
	const body = $('#sheet .sheet-body')
	if (!body || S.active !== key) return
	const cc = conv(key) || c || {}
	const date = ts => ts ? new Date(ts).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
	const ago = ts => { if (!ts) return '—'; const d = Math.floor((Date.now() - ts) / 864e5); return d <= 0 ? 'hoy' : d === 1 ? 'ayer' : `hace ${d} días` }
	const title = cc.name || info.name || fmtPhone(info.phone)
	const labels = (cc.labelIds || []).map(label).filter(Boolean)
	const pr = info.promises || []
	const kept = pr.filter(p => p.status === 'kept').length, broken = pr.filter(p => p.status === 'broken').length, pending = pr.filter(p => p.status === 'pending').length
	const PST = { pending: ['Pendiente', '#FF9500'], kept: ['Cumplida', '#25D366'], broken: ['Incumplida', '#D9480F'], replaced: ['Reprogramada', '#8E8E93'] }
	const media = info.media || []
	const thumbs = media.filter(m => m.type === 'image' || m.type === 'video').slice(0, 8)
	const docs = media.filter(m => m.type === 'document')
	const others = (info.otherAccounts || []).map(id => accountTag(id)).join(' ')
	const btn = (act, icon, text, val = '', href = '') => href
		? `<a class="ci-btn" href="${href}">${icon}<span>${text}</span></a>`
		: `<button class="ci-btn" data-act="${act}"${val ? ` data-val="${esc(val)}"` : ''}>${icon}<span>${text}</span></button>`
	body.innerHTML = `
		<div class="ci-head">
			<div class="avatar ci-avatar">${PH_PERSON}${info.picture ? `<img src="${esc(info.picture)}" alt="" data-act="view-img" onerror="this.remove()">` : ''}</div>
			<h2>${esc(title)}</h2>
			${title !== fmtPhone(info.phone) ? `<div class="ci-phone">${esc(fmtPhone(info.phone))}</div>` : ''}
			${info.pushName && info.pushName !== title ? `<div class="ci-push">~${esc(info.pushName)}</div>` : ''}
			<div class="ci-btns">
				${btn('', IC.call, 'Llamar', '', 'tel:+' + info.phone)}
				${btn('ci-copy', IC.copy, 'Copiar', info.phone)}
				${btn('labels', IC.tag, 'Etiquetas')}
				${btn('note', IC.note, 'Nota')}
				${btn('reminder', IC.clock, 'Recordar')}
			</div>
		</div>
		${info.about || info.business ? `<div class="group">
			${info.about ? `<div class="item"><span class="grow"><small>Info.</small>${esc(info.about)}</span></div>` : ''}
			${info.business?.category ? `<div class="item"><span class="grow"><small>Empresa</small>${esc(info.business.category)}${info.business.description ? ' · ' + esc(info.business.description) : ''}</span></div>` : ''}
			${info.business?.email ? `<div class="item"><span class="grow"><small>Correo</small>${esc(info.business.email)}</span></div>` : ''}
			${info.business?.address ? `<div class="item"><span class="grow"><small>Dirección</small>${esc(info.business.address)}</span></div>` : ''}
		</div>` : ''}

		<div class="group">
			<div class="item ci-link"><span class="ci-ic">${IC.image}</span><span class="grow">Archivos, enlaces y documentos</span><span class="muted">${media.length + (info.stats.links || 0)}</span></div>
			${thumbs.length ? `<div class="ci-grid">${thumbs.map(m => `<button class="ci-thumb" data-act="ci-media" data-val="${esc(m.id)}|${m.type}">${m.type === 'image' ? `<img src="${mediaURL({ accountId: info.accountId, id: m.id, type: m.type })}" loading="lazy" alt="" onerror="this.remove()">` : '▶︎'}</button>`).join('')}</div>` : ''}
			${docs.slice(0, 5).map(m => `<button class="item ci-doc" data-act="ci-media" data-val="${esc(m.id)}|document"><span class="ci-ic">${IC.doc}</span><span class="grow">${esc(m.fileName || 'Documento')}<small>${date(m.ts)}</small></span></button>`).join('')}
		</div>

		<div class="section">Etiquetas</div>
		<div class="group"><button class="item" data-act="labels"><span class="grow ci-tags">${labels.length ? labels.map(l => `<span class="tag solid" style="--c:${esc(l.color)}">${esc(l.name)}</span>`).join('') : '<span class="muted">Sin etiquetas</span>'}</span>${IC.chevron}</button></div>

		<div class="section">Nota</div>
		<div class="group"><button class="item" data-act="note"><span class="grow ci-note">${cc.note ? esc(cc.note) : '<span class="muted">Agregar nota</span>'}</span>${IC.chevron}</button></div>

		<div class="section">Promesas de pago</div>
		<div class="group">
			${pr.length ? `<div class="item"><span class="grow ci-stats"><b style="color:#25D366">${kept}</b> cumplidas · <b style="color:#D9480F">${broken}</b> incumplidas · <b style="color:#FF9500">${pending}</b> pendiente${pending === 1 ? '' : 's'}</span></div>
			${pr.slice(0, 6).map(p => `<div class="item"><span class="grow">${p.amount ? `<b>$${Number(p.amount).toLocaleString('es-MX')}</b> · ` : ''}${date(p.at)}<small>${esc((p.text || '').slice(0, 90))}</small></span><span class="tag solid" style="--c:${PST[p.status]?.[1] || '#8E8E93'}">${PST[p.status]?.[0] || p.status}</span></div>`).join('')}`
			: '<div class="item"><span class="grow muted">Sin promesas registradas</span></div>'}
		</div>

		${info.reminders.length ? `<div class="section">Recordatorios</div><div class="group">${info.reminders.map(r => `<button class="item" data-act="reminder"><span class="grow">⏰ ${esc(reminderLabel(r.at))}<small>${esc(r.text || '')}</small></span></button>`).join('')}</div>` : ''}

		<div class="section">Actividad</div>
		<div class="group">
			<div class="item"><span class="grow">Primer mensaje</span><span class="muted">${date(info.stats.first)}</span></div>
			<div class="item"><span class="grow">Última respuesta del cliente</span><span class="muted">${ago(info.stats.lastIn)}</span></div>
			<div class="item"><span class="grow">Mensajes</span><span class="muted">${info.stats.sent} enviados · ${info.stats.received} recibidos</span></div>
			<div class="item"><span class="grow">Atendido desde</span><span>${accountTag(info.accountId)}</span></div>
			${others ? `<div class="item"><span class="grow">También escribe a</span><span>${others}</span></div>` : ''}
			${info.campaigns.length ? `<div class="item"><span class="grow">Envíos masivos recibidos<small>${info.campaigns.slice(0, 3).map(x => esc(x.name)).join(', ')}</small></span><span class="muted">${info.campaigns.length}</span></div>` : ''}
		</div>

		<div class="group" style="margin-top:22px">
			<div class="item"><span class="ci-ic">${IC.bell}</span><span class="grow">Silenciar notificaciones</span><label class="switch"><input type="checkbox" data-act="ci-mute"${cc.muted ? ' checked' : ''}><i></i></label></div>
			<div class="item"><span class="ci-ic">${IC.ban}</span><span class="grow">No enviarle masivos</span><label class="switch"><input type="checkbox" data-act="ci-optout"${info.optedOut ? ' checked' : ''}><i></i></label></div>
		</div>

		<div class="group" style="margin-top:22px">
			<button class="item" data-act="archive-conv"><span class="ci-ic">${cc.archived ? IC.unarchive : IC.archive}</span><span class="grow">${cc.archived ? 'Desarchivar chat' : 'Archivar chat'}</span></button>
			<button class="item danger" data-act="delete-conv"><span class="ci-ic">${IC.trash}</span><span class="grow">Eliminar chat</span></button>
		</div>`
}

// ---------- Notas y recordatorios ----------
function openNote() {
	const key = S.active
	const c = conv(key)
	sheet('Nota del cliente', `
		<div class="group"><div class="item"><textarea id="nt-text" rows="6" placeholder="Ej. Prometió pagar $500 el viernes. Prefiere que le escriban por la tarde."></textarea></div></div>
		<p class="hint">Solo tú la ves. Aparece arriba del chat y puedes buscarla desde la bandeja.</p>
		<div class="pad"><button class="btn primary" id="nt-save">Guardar nota</button></div>`, el => {
		$('#nt-text', el).value = c?.note || ''
		$('#nt-save', el).onclick = async () => {
			try {
				const updated = await api('PUT', `/conversations/${enc(key)}/note`, { text: $('#nt-text', el).value })
				if (updated) upsertConv(updated)
				closeSheet()
				renderChatHeader()
			} catch (e) { toast(e.message) }
		}
	})
}

function localInputValue(d) {
	const p = n => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

async function openReminder() {
	const key = S.active
	let list = []
	try { list = await api('GET', `/conversations/${enc(key)}/reminders`) } catch {}
	const tomorrow = new Date(Date.now() + 864e5)
	tomorrow.setHours(10, 0, 0, 0)
	const quick = [
		['En 1 hora', Date.now() + 3600000],
		['Mañana 10:00', tomorrow.getTime()],
		['En 3 días', (() => { const d = new Date(tomorrow); d.setDate(d.getDate() + 2); return d.getTime() })()],
		['En 1 semana', (() => { const d = new Date(tomorrow); d.setDate(d.getDate() + 6); return d.getTime() })()]
	]
	sheet('Recordatorio', `
		${list.length ? `<div class="section">Pendientes</div><div class="group">${list.map(r => `<div class="item"><span class="grow">⏰ ${esc(reminderLabel(r.at))}<small>${esc(r.text || '')}</small></span><button class="icon-btn" data-act="rem-del" data-val="${r.id}" aria-label="Borrar">${IC.trash}</button></div>`).join('')}</div>` : ''}
		<div class="section">Nuevo recordatorio</div>
		<div class="chips" style="padding:8px 16px">${quick.map(([t, at]) => `<button class="chip" data-rem-at="${at}">${t}</button>`).join('')}</div>
		<div class="group">
			<div class="item"><span class="grow">Fecha y hora</span><input type="datetime-local" id="rm-at" value="${localInputValue(tomorrow)}"></div>
			<div class="item"><input type="text" id="rm-text" placeholder="Qué hacer (ej. Confirmar pago de $500)"></div>
		</div>
		<p class="hint">Te llega una notificación a la hora elegida, aunque la app esté cerrada.</p>
		<div class="pad"><button class="btn primary" id="rm-save">Guardar recordatorio</button></div>`, el => {
		el.querySelectorAll('[data-rem-at]').forEach(b => {
			b.onclick = () => {
				$('#rm-at', el).value = localInputValue(new Date(Number(b.dataset.remAt)))
				el.querySelectorAll('[data-rem-at]').forEach(x => x.classList.toggle('on', x === b))
			}
		})
		$('#rm-save', el).onclick = async () => {
			const at = new Date($('#rm-at', el).value).getTime()
			if (!at) return toast('Elige la fecha y hora')
			try {
				const updated = await api('POST', `/conversations/${enc(key)}/reminders`, { at, text: $('#rm-text', el).value })
				if (updated) upsertConv(updated)
				closeSheet()
				renderChatHeader()
				toast('Recordatorio guardado ⏰')
			} catch (e) { toast(e.message) }
		}
	})
}

// ---------- Respuestas rápidas ----------
function fillReply(text) {
	const c = conv(S.active)
	const first = (c?.name || '').trim().split(/\s+/)[0] || ''
	return text.replace(/\{nombre\}/gi, first).replace(/\s+([,.!?])/g, '$1').replace(/Hola\s*,/i, 'Hola,')
}

function renderQuickReplies() {
	const pop = $('#qr-pop')
	const ta = $('#text')
	if (!pop || !ta) return
	const v = ta.value
	if (!v.startsWith('/')) { pop.hidden = true; return }
	const q = v.slice(1).toLowerCase()
	const list = S.replies.filter(r => r.title.toLowerCase().includes(q) || r.text.toLowerCase().includes(q)).slice(0, 8)
	pop.innerHTML = list.length
		? list.map(r => `<button class="qr-item" data-act="qr-pick" data-val="${r.id}"><b>${esc(r.title)}</b><small>${esc(fillReply(r.text))}</small></button>`).join('')
		: '<div class="hint">No hay respuestas con ese nombre. Créalas en Ajustes › Respuestas rápidas.</div>'
	pop.hidden = false
}

function renderFrom() {
	const el = $('#from')
	if (!el) return
	const a = account(accOf(S.active))
	el.innerHTML = `${accountTag(accOf(S.active))}${a?.phone ? ' <small>' + esc(fmtPhone(a.phone)) + '</small>' : ''}${a && a.status !== 'connected' ? ` <b style="color:var(--danger)">· ${statusText(a)}</b>` : ''}`
	const hint = $('#hint24')
	if (hint) {
		const closed = a?.kind === 'cloud' && !windowOpen(S.active)
		hint.hidden = !closed
	}
}

function renderComposer() {
	const row = $('#compose-row')
	if (S.recorder) {
		row.innerHTML = `
			<button class="round ghost" data-act="rec-cancel" aria-label="Cancelar">${IC.trash}</button>
			<div class="recording"><span class="rec-dot"></span><span id="rec-time">0:00</span></div>
			<button class="round rec" data-act="rec-send" aria-label="Enviar nota de voz">${IC.sendFill}</button>`
		return
	}
	const prev = $('#text')?.value || ''
	const isCloud = account(accOf(S.active))?.kind === 'cloud'
	row.innerHTML = `
		<button class="round ghost" data-act="attach" aria-label="Adjuntar">${IC.plus}</button>
		${isCloud ? `<button class="round ghost" data-act="tpl-chat" aria-label="Plantilla">${IC.template}</button>` : ''}
		<textarea id="text" rows="1" placeholder="Mensaje"></textarea>
		<button class="round ghost ai-btn" id="ai-btn" data-act="ai-fix" aria-label="Corregir texto" hidden>${IC.sparkle}</button>
		<button class="round mic" id="send-btn" data-act="send" aria-label="Enviar">${IC.mic}</button>`
	const ta = $('#text')
	ta.value = prev
	const sync = () => {
		ta.style.height = 'auto'
		ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'
		const btn = $('#send-btn')
		const has = Boolean(ta.value.trim())
		$('#ai-btn').hidden = !has
		if (btn.classList.contains('mic') === has) { btn.classList.toggle('mic', !has); btn.innerHTML = has ? IC.sendFill : IC.mic }
	}
	ta.oninput = () => { sync(); renderQuickReplies() }
	sync()
}

function msgContent(m) {
	if (m.deleted) return `<div class="text deleted">${IC.ban}<span>${m.fromMe ? 'Eliminaste este mensaje' : 'Se eliminó este mensaje'}</span></div>`
	const cap = m.text ? `<div class="text">${linkify(m.text)}</div>` : ''
	switch (m.type) {
		case 'image':
			return `<img src="${mediaURL(m)}" loading="lazy" data-act="view-img" alt="Foto">${cap}`
		case 'sticker':
			return `<img class="sticker" src="${mediaURL(m)}" loading="lazy" alt="Sticker">`
		case 'video':
			return `<video src="${mediaURL(m)}#t=0.1" controls playsinline preload="metadata"></video>${cap}`
		case 'audio':
			return `<audio src="${mediaURL(m)}" controls preload="none"></audio>`
		case 'document':
			return `<a class="doc" href="${mediaURL(m)}" target="_blank" rel="noopener">${IC.doc}<span>${esc(m.fileName || 'Documento')}</span></a>${cap}`
		default:
			return `<div class="text">${linkify(m.text || '')}</div>`
	}
}

function dayLabel(d) {
	const start = t => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
	const diff = Math.round((start(new Date()) - start(d)) / 864e5)
	if (diff === 0) return 'Hoy'
	if (diff === 1) return 'Ayer'
	if (diff < 7) return d.toLocaleDateString('es', { weekday: 'long' })
	return d.toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

function ticks(status) {
	if (status === 0) return '<span class="fail">No enviado</span>'
	if (status === 1) return `<span class="pend">${IC.clock}</span>`
	if (status === 2) return TICK1
	if (status === 3) return TICK2
	return `<span class="read">${TICK2}</span>`
}

function messageItems() {
	const list = S.msgs[S.active]
	const isGroup = conv(S.active)?.isGroup
	const items = []
	if (S.more[S.active]) items.push({ key: 'older', html: '<button class="chip more" data-act="older">Cargar mensajes anteriores</button>' })
	if (!list.length) items.push({ key: 'empty', html: '<div class="empty">Escribe el primer mensaje 👋</div>' })
	let lastDay = ''
	let prev = null
	for (const m of list) {
		const d = new Date(m.ts)
		const day = d.toDateString()
		// Primera burbuja de un grupo (cambia quién escribe, el número o el día): lleva colita y etiqueta
		const first = !prev || prev.fromMe !== m.fromMe || prev.accountId !== m.accountId || day !== lastDay || (isGroup && !m.fromMe && prev.sender !== m.sender)
		const next = list[list.indexOf(m) + 1]
		const last = !next || next.fromMe !== m.fromMe || next.accountId !== m.accountId || new Date(next.ts).toDateString() !== day || (isGroup && !m.fromMe && next.sender !== m.sender)
		prev = m
		if (day !== lastDay) {
			lastDay = day
			items.push({ key: 'day:' + day, html: `<div class="day">${dayLabel(d)}</div>` })
		}
		const a = account(m.accountId)
		const time = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
		items.push({
			key: m.accountId + ':' + m.id,
			meta: `${m.edited && !m.deleted ? '<span class="edited">Editado</span>' : ''}${time} ${m.fromMe ? ticks(m.status) : ''}`,
			last,
			html: `<div data-mid="${esc(m.id)}" data-acc="${m.accountId}" class="msg ${m.fromMe ? 'me' : ''} ${first ? 'first' : ''} ${['image', 'video', 'sticker'].includes(m.type) && !m.text ? 'media' : ''}" style="--c:${esc(a?.color || '#8E8E93')}">
				${first && isGroup && !m.fromMe ? `<div class="head"><span class="sender">${esc(m.senderName || fmtPhone((m.sender || '').split('@')[0]))}</span></div>` : ''}
				${msgContent(m)}
				${m.fromMe && m.error ? `<div class="err">⚠︎ ${esc(m.error)}</div>` : ''}
				<div class="meta"></div>
			</div>`
		})
	}
	return items
}

// ---------- Asistente: qué pidió el cliente y respuesta sugerida ----------
const INTENT_UI = {
	queja: { tag: '⚠️ Queja', note: 'Ya no recibirá masivos. Responde con cuidado.' },
	baja: { tag: '🚫 Pidió baja', note: 'Ya no recibirá masivos.' },
	equivocado: { tag: '❓ Número equivocado', note: 'Ya no recibirá masivos.', reply: /equivocad/i },
	pagado: { tag: '💰 Dice que ya pagó', reply: /comprobante/i, replyIfProof: /gracias/i },
	promesa: { tag: '🤝 Prometió pagar', note: 'Se creó un recordatorio para ese día.', reply: /promesa|compromiso/i },
	datos_pago: { tag: '🏦 Pide datos de pago', reply: /datos|cuenta|pagar/i },
	negociar: { tag: '💬 Quiere negociar', reply: /opciones|convenio|plan/i },
	se_niega: { tag: '✋ Se niega a pagar', note: 'Explícale el adeudo con calma.' },
	sin_dinero: { tag: '🪙 Dice que no tiene dinero', note: 'Ofrécele pagos en partes.' },
	saldo: { tag: '🧾 Pregunta su saldo', reply: /saldo|adeudo/i },
	molesto: { tag: '😠 Está molesto', note: 'Responde con calma; evita insistir hoy.' }
}
function updateSuggestion() {
	const el = $('#suggest')
	if (!el) return
	const list = S.msgs[S.active] || []
	const last = list[list.length - 1]
	const ui = last && !last.fromMe && last.intent ? INTENT_UI[last.intent] : null
	if (!ui) { el.hidden = true; el.innerHTML = ''; return }
	const re = last.intent === 'pagado' && /comprobante/i.test(last.text || '') ? ui.replyIfProof : ui.reply
	const r = re ? (S.replies || []).find(x => re.test(x.title) || re.test(x.text)) : null
	const html = `<span class="sg-tag">${ui.tag}</span>${ui.note ? `<small>${esc(ui.note)}</small>` : ''}${r ? `<button class="chip" data-act="qr-pick" data-val="${r.id}">💡 ${esc(r.title)}</button>` : ''}${last.suggestion ? `<button class="chip" data-act="sg-use">✍️ Respuesta sugerida</button>` : ''}`
	if (el.innerHTML !== html) el.innerHTML = html
	el.hidden = false
}

// ---------- Menú de cada mensaje (mantener presionado) ----------
function bindMsgPress(box) {
	let timer = null, sx = 0, sy = 0
	const open = el => {
		const m = (S.msgs[S.active] || []).find(x => x.id === el.dataset.mid && String(x.accountId) === el.dataset.acc)
		if (!m) return
		el.classList.add('pressed')
		setTimeout(() => el.classList.remove('pressed'), 250)
		openMsgMenu(m)
	}
	box.addEventListener('touchstart', e => {
		const el = e.target.closest('.msg')
		if (!el || e.target.closest('audio, video, a')) return
		sx = e.touches[0].clientX; sy = e.touches[0].clientY
		timer = setTimeout(() => { timer = null; navigator.vibrate?.(10); open(el) }, 450)
	}, { passive: true })
	box.addEventListener('touchmove', e => {
		if (timer && (Math.abs(e.touches[0].clientX - sx) > 8 || Math.abs(e.touches[0].clientY - sy) > 8)) { clearTimeout(timer); timer = null }
	}, { passive: true })
	box.addEventListener('touchend', () => { clearTimeout(timer); timer = null })
	box.addEventListener('contextmenu', e => { const el = e.target.closest('.msg'); if (el) { e.preventDefault(); open(el) } })
}
function openMsgMenu(m) {
	S.menuMsg = m
	const age = Date.now() - m.ts
	const canChange = m.fromMe && !m.deleted && account(m.accountId)?.kind !== 'cloud'
	const acts = []
	if (m.text && !m.deleted) acts.push({ act: 'msg-copy', text: 'Copiar', icon: IC.copy })
	if (canChange && m.type === 'text' && age < 15 * 60000) acts.push({ act: 'msg-edit', text: 'Editar', icon: IC.pencil })
	if (canChange && age < 2 * 864e5) acts.push({ act: 'msg-delete', text: 'Eliminar para todos', icon: IC.trash, danger: true })
	if (!acts.length) return
	const note = canChange && m.type === 'text' && age >= 15 * 60000 ? 'WhatsApp solo deja editar en los primeros 15 minutos' : ''
	actionSheet(note, acts)
}
function openEditMsg(m) {
	sheet('Editar mensaje', `
		<div class="group" style="margin-top:12px"><div class="item"><textarea id="em-text" rows="5"></textarea></div></div>
		<p class="hint">El cliente verá el mensaje corregido con la marca «Editado». Solo se puede durante 15 minutos después de enviarlo.</p>
		<div class="pad"><button class="btn primary" id="em-save">Guardar</button></div>`, el => {
		const ta = $('#em-text', el)
		ta.value = m.text || ''
		setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) }, 300)
		$('#em-save', el).onclick = async () => {
			const text = ta.value.trim()
			if (!text) return toast('Escribe el mensaje')
			if (text === m.text) return closeSheet()
			const btn = $('#em-save', el); btn.disabled = true
			try {
				insertMsg(await api('POST', `/messages/${m.accountId}/${enc(m.id)}/edit`, { text }))
				closeSheet(); renderMessages(false); toast('Mensaje editado')
			} catch (e) { toast(e.message, 6000) } finally { btn.disabled = false }
		}
	})
}

function makeNode(item) {
	const t = document.createElement('template')
	t.innerHTML = item.html.trim()
	const node = t.content.firstElementChild
	if (item.meta !== undefined) node.querySelector('.meta').innerHTML = item.meta
	return node
}

// Actualiza solo lo que cambió para no interrumpir audios o videos en reproducción
function renderMessages(scrollToEnd) {
	const box = $('#msgs')
	if (!box || !S.msgs[S.active]) return
	const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120
	const items = messageItems()
	const prev = box._items || []
	const isAppend = prev.length > 0 && prev.length <= items.length && prev.every((p, i) => p.key === items[i].key)
	if (isAppend) {
		items.forEach((item, i) => {
			const old = prev[i]
			if (!old) {
				item.node = makeNode(item)
				box.appendChild(item.node)
			} else if (old.html !== item.html) {
				item.node = makeNode(item)
				old.node.replaceWith(item.node)
			} else {
				item.node = old.node
				if (old.meta !== item.meta) item.node.querySelector('.meta').innerHTML = item.meta
			}
		})
	} else {
		const prevHeight = box.scrollHeight
		const prevTop = box.scrollTop
		box.textContent = ''
		for (const item of items) {
			item.node = makeNode(item)
			box.appendChild(item.node)
		}
		if (renderMessages.keepOffset) box.scrollTop = box.scrollHeight - prevHeight + prevTop
	}
	updateSuggestion()
	// La colita va en la última burbuja de cada grupo (como en iPhone); se pone sin recrear nodos
	for (const it of items) if (it.last !== undefined && it.node) it.node.classList.toggle('tail', it.last)
	box._items = items
	if (scrollToEnd || (nearBottom && !renderMessages.keepOffset)) box.scrollTop = box.scrollHeight
	renderMessages.keepOffset = false
}

async function markRead(jid) {
	const c = conv(jid)
	if (!c?.unread) return
	c.unread = 0
	updateBadge()
	api('POST', `/conversations/${enc(jid)}/read`).catch(() => {})
}

async function sendText(override, skipReview) {
	const ta = $('#text')
	const text = (override ?? ta.value).trim()
	const from = defaultFrom(S.active)
	if (!text || !from) return
	if (!skipReview && S.ai.review) return aiReview(text)
	ta.value = ''
	ta.dispatchEvent(new Event('input'))
	try {
		const m = await api('POST', '/send', { accountId: from, jid: jidOf(S.active), text })
		insertMsg(m)
		renderMessages(true)
	} catch (e) {
		ta.value = text
		ta.dispatchEvent(new Event('input'))
		toast(e.message)
	}
}

async function sendFile(file, extra = {}) {
	const from = defaultFrom(S.active)
	if (!from) return toast('No hay cuentas conectadas')
	const type = file.type || 'application/octet-stream'
	const kind = extra.kind || (type.startsWith('image/') && !/heic|heif/.test(type) ? 'image' : type.startsWith('video/') ? 'video' : 'document')
	let blob = file
	let name = file.name || 'archivo'
	// Las fotos HEIC del iPhone se convierten a JPEG para que WhatsApp las muestre
	if (/heic|heif/i.test(type) || (kind === 'image' && file.size > 4e6)) {
		try {
			blob = await toJpeg(file)
			name = name.replace(/\.\w+$/, '') + '.jpg'
		} catch {}
	}
	const finalKind = blob.type === 'image/jpeg' ? 'image' : kind
	const fd = new FormData()
	fd.append('accountId', from)
	fd.append('jid', jidOf(S.active))
	fd.append('kind', finalKind)
	fd.append('ptt', extra.ptt ? 'true' : 'false')
	const caption = $('#text')?.value.trim()
	if (caption && finalKind !== 'audio') fd.append('caption', caption)
	fd.append('file', blob, name)
	toast('Enviando…', 60000)
	try {
		const m = await api('POST', '/send-media', fd, true)
		if (caption && finalKind !== 'audio') { $('#text').value = ''; $('#text').dispatchEvent(new Event('input')) }
		insertMsg(m)
		renderMessages(true)
		$('#toast').hidden = true
	} catch (e) { toast(e.message) }
}

async function toJpeg(file) {
	const bmp = await createImageBitmap(file)
	const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height))
	const canvas = document.createElement('canvas')
	canvas.width = Math.round(bmp.width * scale)
	canvas.height = Math.round(bmp.height * scale)
	canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
	return new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('jpeg'))), 'image/jpeg', 0.85))
}

async function startRecording() {
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
		const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => window.MediaRecorder?.isTypeSupported?.(t)) || ''
		const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
		const chunks = []
		rec.ondataavailable = e => e.data.size && chunks.push(e.data)
		rec.start(250)
		const started = Date.now()
		S.recorder = { rec, stream, chunks, mime: rec.mimeType || mime || 'audio/mp4' }
		S.recorder.timer = setInterval(() => {
			const s = Math.floor((Date.now() - started) / 1000)
			const t = $('#rec-time')
			if (t) t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
		}, 500)
		renderComposer()
	} catch {
		toast('Permite el acceso al micrófono para grabar notas de voz')
	}
}

function stopRecording(send) {
	const r = S.recorder
	if (!r) return
	S.recorder = null
	clearInterval(r.timer)
	r.rec.onstop = () => {
		r.stream.getTracks().forEach(t => t.stop())
		if (send && r.chunks.length) {
			const type = r.mime.split(';')[0]
			const blob = new Blob(r.chunks, { type })
			const file = new File([blob], 'nota.' + (type.includes('webm') ? 'webm' : 'm4a'), { type })
			sendFile(file, { kind: 'audio', ptt: true })
		}
	}
	r.rec.stop()
	renderComposer()
}

function openLabelsSheet() {
	const key = S.active
	const c = conv(key)
	if (!S.labels.length) return toast('Primero crea etiquetas en Ajustes')
	if (!c) return toast('Envía o recibe un mensaje antes de etiquetar')
	sheet('Etiquetas', `<div class="group">${S.labels.map(l => `
		<label class="item"><span class="tag solid" style="--c:${esc(l.color)}">${esc(l.name)}</span><span class="grow"></span>
		<input type="checkbox" data-label="${l.id}" ${c.labelIds.includes(l.id) ? 'checked' : ''}></label>`).join('')}</div>`, el => {
		el.querySelectorAll('input[data-label]').forEach(cb => {
			cb.onchange = async () => {
				const ids = [...el.querySelectorAll('input[data-label]:checked')].map(x => Number(x.dataset.label))
				try {
					upsertConv(await api('PUT', `/conversations/${enc(key)}/labels`, { labelIds: ids }))
					renderChatHeader()
				} catch (e) { toast(e.message) }
			}
		})
	})
}

// ---------- Nuevo chat ----------
function openNewChat() {
	const connected = S.accounts.filter(a => a.status === 'connected')
	if (!connected.length) return toast('No hay cuentas conectadas')
	sheet('Nuevo chat', `
		<div class="section">Enviar desde</div>
		<div class="group"><div class="item"><select id="nc-from">${connected.map(a => `<option value="${a.id}">${esc(a.name)}${a.phone ? ' (+' + esc(a.phone) + ')' : ''}${a.kind === 'cloud' ? ' · API' : ''}</option>`).join('')}</select></div></div>
		<div class="section">Número (10 dígitos o con código de país)</div>
		<div class="group"><div class="item"><input type="tel" id="nc-phone" placeholder="Ej. 8112345678" inputmode="tel"></div></div>
		<div id="nc-body"></div>
		<div class="pad"><button class="btn primary" id="nc-go">Enviar</button></div>`, el => {
		const accId = () => Number($('#nc-from', el).value)
		const body = async () => {
			const a = account(accId())
			if (a?.kind === 'cloud') {
				$('#nc-body', el).innerHTML = '<p class="hint">Cargando plantillas…</p>'
				$('#nc-body', el).innerHTML = await templateForm(a.id)
			} else {
				$('#nc-body', el).innerHTML = `<div class="section">Mensaje (opcional)</div>
					<div class="group"><div class="item"><textarea id="nc-text" rows="3" placeholder="Escribe un mensaje"></textarea></div></div>`
			}
			bindTemplateForm(el)
		}
		$('#nc-from', el).onchange = body
		body()
		$('#nc-go', el).onclick = async () => {
			const accountId = accId()
			const phone = $('#nc-phone', el).value
			if (phone.replace(/\D/g, '').length < 10) return toast('Escribe el número completo (10 dígitos)')
			const btn = $('#nc-go', el)
			btn.disabled = true
			try {
				let jid
				if (account(accountId)?.kind === 'cloud') {
					const t = readTemplateForm(el)
					if (!t) return
					const m = await api('POST', '/send-template', { accountId, phone, ...t })
					jid = m.jid
				} else {
					jid = (await api('POST', '/resolve', { accountId, phone })).jid
					const text = $('#nc-text', el)?.value.trim()
					if (text) await api('POST', '/send', { accountId, jid, text })
				}
				closeSheet()
				S.convs = await api('GET', '/conversations')
				go('#/chat/' + enc(accountId + ':' + jid))
			} catch (e) { toast(e.message) } finally { btn.disabled = false }
		}
	})
}

// ---------- Plantillas (API oficial) ----------
function windowOpen(key) {
	const last = [...(S.msgs[key] || [])].reverse().find(m => !m.fromMe)
	return Boolean(last && Date.now() - last.ts < 24 * 3600 * 1000)
}

async function loadTemplates(accountId, refresh) {
	if (!refresh && S.templates[accountId]) return S.templates[accountId]
	S.templates[accountId] = await api('GET', `/accounts/${accountId}/templates${refresh ? '?refresh=1' : ''}`)
	return S.templates[accountId]
}

const TPL_STATUS = { APPROVED: ['Aprobada', 'var(--accent)'], PENDING: ['En revisión', '#f5a623'], REJECTED: ['Rechazada', 'var(--danger)'], PAUSED: ['Pausada', '#f5a623'], DISABLED: ['Desactivada', 'var(--danger)'] }

async function templateForm(accountId) {
	let list
	try { list = (await loadTemplates(accountId)).filter(t => t.status === 'APPROVED') } catch (e) { return `<p class="hint" style="color:var(--danger)">${esc(e.message)}</p>` }
	if (!list.length) return `<p class="hint">No tienes plantillas aprobadas todavía. Créalas en <a href="#/account/${accountId}">Cuentas › esta cuenta › Plantillas</a>. Meta tarda de minutos a horas en aprobarlas.</p>`
	return `<div class="section">Plantilla</div>
		<div class="group"><div class="item"><select id="tpl-name">${list.map((t, i) => `<option value="${i}">${esc(t.name)} (${esc(t.language)})</option>`).join('')}</select></div></div>
		<div id="tpl-fields"></div>
		<textarea hidden id="tpl-data">${esc(JSON.stringify(list))}</textarea>`
}

function bindTemplateForm(el) {
	const sel = $('#tpl-name', el)
	if (!sel) return
	const list = JSON.parse($('#tpl-data', el).textContent)
	const draw = () => {
		const t = list[Number(sel.value)]
		const fields = Array.from({ length: t.params }, (_, i) =>
			`<div class="item"><span style="min-width:44px;color:var(--muted)">{{${i + 1}}}</span><input type="text" class="tpl-p" data-i="${i}" placeholder="Valor ${i + 1}"></div>`).join('')
		$('#tpl-fields', el).innerHTML = `<p class="hint" style="white-space:pre-wrap">${esc(t.body)}</p>${t.params ? `<div class="group">${fields}</div>` : ''}`
	}
	sel.onchange = draw
	draw()
}

function readTemplateForm(el) {
	const sel = $('#tpl-name', el)
	if (!sel) { toast('Necesitas una plantilla aprobada'); return null }
	const t = JSON.parse($('#tpl-data', el).textContent)[Number(sel.value)]
	const params = [...el.querySelectorAll('.tpl-p')].map(i => i.value.trim())
	if (params.some(p => !p)) { toast('Llena todos los valores de la plantilla'); return null }
	return { template: t.name, language: t.language, params }
}

async function openTemplateChat() {
	const key = S.active
	const accountId = accOf(key)
	sheet('Enviar plantilla', '<div id="tc-body"><p class="hint">Cargando plantillas…</p></div><div class="pad"><button class="btn primary" id="tc-go">Enviar</button></div>', async el => {
		$('#tc-body', el).innerHTML = await templateForm(accountId)
		bindTemplateForm(el)
		$('#tc-go', el).onclick = async () => {
			const t = readTemplateForm(el)
			if (!t) return
			try {
				const m = await api('POST', '/send-template', { accountId, jid: jidOf(key), ...t })
				insertMsg(m)
				closeSheet()
				renderMessages(true)
			} catch (e) { toast(e.message) }
		}
	})
}

// ---------- Envíos masivos ----------
const CAMPAIGN_STATUS = { running: ['Enviando', 'var(--accent)'], paused: ['En pausa', '#f5a623'], done: ['Terminado', 'var(--muted)'], cancelled: ['Cancelado', 'var(--danger)'] }

async function renderCampaigns(full) {
	if (full) {
		$('#view').innerHTML = `
			${largeBar('Envíos', `<button class="icon-btn" data-act="new-campaign" aria-label="Nuevo envío">${IC.plus}</button>`)}
			<div class="settings" style="min-height:100%">
			<div class="section">Resultados</div>
			<div class="chips" style="padding:4px 16px 8px">${[[1, 'Hoy'], [7, '7 días'], [30, '30 días']].map(([d, t]) => `<button class="chip ${S.statsDays === d ? 'on' : ''}" data-act="stats-days" data-val="${d}">${t}</button>`).join('')}</div>
			<div id="stats"><p class="hint">Cargando…</p></div>
			<div id="camp-list"></div>
			<p class="hint">Los envíos salen poco a poco y solo en el horario que elijas. En <b>modo seguro</b> cada número manda como máximo su límite diario, con pausas al azar entre mensajes, y deja de usarse si WhatsApp le rechaza mensajes. Quien responda «BAJA» no vuelve a recibir mensajes.</p></div>`
		try { S.campaigns = await api('GET', '/campaigns') } catch (e) { toast(e.message) }
		loadStats()
	}
	renderCampaignList()
}

async function loadStats() {
	const el = $('#stats')
	if (!el) return
	let st
	try { st = await api('GET', `/stats?days=${S.statsDays}`) } catch (e) { el.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return }
	const t = st.total
	const rate = t.campaignSent ? Math.round(t.campaignReplied / t.campaignSent * 100) : 0
	const lbl = name => st.labels.find(l => l.name.toLowerCase() === name.toLowerCase())
	const promise = lbl('Promesa de pago')
	const paid = lbl('Pagó')
	const card = (n, text, color) => `<div class="stat"><b style="color:${color || 'var(--text)'}">${n}</b><small>${text}</small></div>`
	const max = Math.max(1, ...st.series.map(d => Math.max(d.sent, d.received)))
	el.innerHTML = `
		<div class="stats-grid">
			${card(t.sent || 0, 'mensajes enviados')}
			${card(t.people || 0, 'personas escribieron', 'var(--accent)')}
			${card(`${t.campaignReplied || 0} <span style="font-size:13px;color:var(--muted)">(${rate}%)</span>`, 'respondieron a envíos', 'var(--accent)')}
			${card(promise ? promise.recent : 0, 'promesas de pago', '#FF9500')}
			${card(paid ? paid.recent : 0, 'pagaron', '#25D366')}
			${card(t.rejected || 0, 'rechazados por WhatsApp', t.rejected ? 'var(--danger)' : 'var(--muted)')}
		</div>
		${st.series.length > 1 ? `<div class="chart">${st.series.map(d => `
			<div class="col" title="${d.day}: ${d.sent} enviados, ${d.received} recibidos">
				<i class="b sent" style="height:${Math.round(d.sent / max * 100)}%"></i><i class="b recv" style="height:${Math.round(d.received / max * 100)}%"></i>
				<small>${d.day.slice(8)}</small>
			</div>`).join('')}</div>
			<p class="hint" style="padding-top:0"><span style="color:var(--accent)">■</span> enviados &nbsp; <span style="color:#7C5CFF">■</span> recibidos</p>` : ''}
		<div class="group">${st.perAccount.filter(a => a.sent || a.received).map(a => `
			<div class="item" style="display:block"><div style="display:flex;gap:8px;align-items:center">${accountTag(a.accountId)}<span class="grow"></span><small style="display:inline">${a.sent} enviados · ${a.people} escribieron${a.campaignSent ? ` · ${a.campaignReplied}/${a.campaignSent} respondieron` : ''}${a.rejected ? ` · <span style="color:var(--danger)">${a.rejected} rechazados</span>` : ''}</small></div></div>`).join('') || '<p class="hint">Sin actividad en este periodo.</p>'}</div>`
}

function renderCampaignList() {
	const el = $('#camp-list')
	if (!el) return
	if (!S.campaigns.length) {
		el.innerHTML = '<div class="empty"><div class="big">📤</div>Toca <b>＋</b> para crear tu primer envío.</div>'
		return
	}
	el.innerHTML = '<div class="section">Tus envíos</div><div class="group">' + S.campaigns.map(c => {
		const n = c.counts
		const total = n.pending + n.sent + n.failed + n.skipped
		const done = n.sent + n.failed + n.skipped
		const [st, color] = CAMPAIGN_STATUS[c.status] || [c.status, 'var(--muted)']
		const pct = total ? Math.round(done / total * 100) : 0
		const safe = c.kind === 'safe'
		const waiting = c.note === 'limit' || c.note === 'limit-safe' || /^Esperando/.test(c.note || '')
		const why = c.note === 'limit' ? 'Esperando: se alcanzó el límite diario de Meta'
			: c.note === 'limit-safe' ? (c.forced ? 'Esperando a que algún número pueda enviar (conectado y sin rechazos).' : 'Esperando: los números ya enviaron su máximo de hoy. Sigue mañana sola. Si es urgente, toca «⚡ Enviar ya».')
			: c.note || ''
		const tags = safe
			? c.accountIds.map(id => c.disabledIds.includes(id) ? `<span style="opacity:.4;text-decoration:line-through">${accountTag(id)}</span>` : accountTag(id)).join('')
			: accountTag(c.accountId)
		const info = safe
			? `Modo seguro · ${c.autoRamp ? 'sube poco a poco hasta ' : ''}${c.dailyPerNumber} por número al día · ${c.hourlyPerNumber || 8} por hora · pausas de ${Math.round(c.minDelay / 60)}–${Math.round(c.maxDelay / 60)} min · ${c.startHour}:00–${c.endHour}:00`
			: `Plantilla ${esc(c.template)} · ${c.perHour}/hora · ${c.startHour}:00–${c.endHour}:00`
		return `<div class="item" style="display:block">
			<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b class="grow">${esc(c.name)}</b>${c.forced ? '<span class="pill warn">⚡ Urgente</span>' : ''}${tags}<span class="status" style="color:${color}">${st}</span></div>
			<small>${info}</small>
			<div class="bar-progress"><i style="width:${pct}%"></i></div>
			<small>✅ ${n.sent} enviados · 👀 ${n.read} leídos · 💬 ${n.replied} respondieron · ⚠︎ ${n.failed} fallidos · ⏳ ${n.pending} pendientes${n.withChat ? ` · 💬 ${n.withChat} brincados (todos tus números ya tenían chat)` : ''}${n.skipped - (n.withChat || 0) > 0 ? ` · 🚫 ${n.skipped - (n.withChat || 0)} con BAJA` : ''}</small>
			${why ? `<small style="color:${waiting ? 'var(--muted)' : 'var(--danger)'}">${esc(why)}</small>` : ''}
			<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
				${c.status === 'running' ? `<button class="chip" data-act="camp" data-val="${c.id}:pause">Pausar</button>` : ''}
				${c.status === 'paused' ? `<button class="chip" data-act="camp" data-val="${c.id}:resume">Reanudar</button>` : ''}
				${safe && (c.status === 'running' || c.status === 'paused') && n.pending ? `<button class="chip" style="--c:#C77700" data-act="camp-force" data-val="${c.id}">${c.forced ? 'Quitar urgente' : '⚡ Enviar ya (ignorar límites)'}</button>` : ''}
				${c.status === 'running' || c.status === 'paused' ? `<button class="chip" style="--c:var(--danger)" data-act="camp" data-val="${c.id}:cancel">Cancelar</button>` : ''}
				${n.failed ? `<button class="chip" style="--c:#8E8E93" data-act="camp-failed" data-val="${c.id}">Ver fallidos</button>` : ''}
				<a class="chip" style="--c:#1D6F42;text-decoration:none" href="/api/campaigns/${c.id}/export?token=${enc(S.token)}" download>📊 Excel</a>
			</div>
		</div>`
	}).join('') + '</div>'
}

function parseList(text) {
	return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
		const parts = l.split(l.includes('\t') ? '\t' : l.includes(';') ? ';' : ',').map(x => x.trim().replace(/^"|"$/g, ''))
		return { phone: parts[0], params: parts.slice(1) }
	}).filter(r => r.phone.replace(/\D/g, '').length >= 10)
}

// "Número + mensaje por línea": el teléfono al inicio y TODO lo demás es su mensaje
function parseNumMsg(text) {
	return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
		const m = l.match(/^["']?\s*(\+?[\d][\d\s\-().]{8,})[\s,:\-–—]+(.+)$/s)
		if (!m) return null
		const phone = m[1].replace(/\D/g, '')
		const msg = m[2].trim()
		return phone.length >= 10 && msg ? { phone, params: [msg] } : null
	}).filter(Boolean)
}

function openNewCampaign() {
	const normal = S.accounts.filter(a => a.kind !== 'cloud')
	const cloud = S.accounts.filter(a => a.kind === 'cloud')
	if (!cloud.length) return openNewSafeCampaign()
	if (!normal.length) return openNewCloudCampaign()
	sheet('Nuevo envío', `
		<div class="group">
			<button class="btn" data-act="new-safe"><b>🛡️ Modo seguro</b><small style="display:block;color:var(--muted)">Con tus números de WhatsApp normal, gratis, poco a poco.</small></button>
			<button class="btn" data-act="new-cloud"><b>✅ API oficial</b><small style="display:block;color:var(--muted)">Con plantillas aprobadas por Meta.</small></button>
		</div>`)
}

function openNewSafeCampaign() {
	const normal = S.accounts.filter(a => a.kind !== 'cloud')
	if (!normal.length) return toast('Primero vincula un número de WhatsApp en Cuentas')
	sheet('Envío en modo seguro', `
		<div class="section">Nombre del envío</div>
		<div class="group"><div class="item"><input type="text" id="sf-name" placeholder="Ej. Recordatorios lunes"></div></div>
		<div class="group"><label class="item"><input type="checkbox" id="sf-perline"><span class="grow"><b>✏️ Cada línea trae su propio mensaje</b><small>En vez de una plantilla, pega el número y a un lado su mensaje ya escrito. Se reparten entre tus números.</small></span></label></div>
		<div class="section">Números que van a enviar</div>
		<div class="group">${normal.map(a => `<label class="item"><input type="checkbox" class="sf-acc" value="${a.id}" ${a.status !== 'connected' ? 'disabled' : a.reserve ? '' : 'checked'}><span class="grow">${accountTag(a.id)} ${a.phone ? esc(fmtPhone(a.phone)) : ''}${a.reserve ? ' <b style="color:#7C5CFF">· reserva</b>' : ''}${a.health && a.status === 'connected' ? `<small>${healthDot(a)} ${esc(a.health.reason)} · hoy hasta ${a.health.suggestedDaily}</small>` : ''}</span><small style="display:inline;color:${statusColor(a)}">${statusText(a)}</small></label>`).join('')}</div>
		<p class="hint">La lista se reparte entre los números marcados. Los números de <b>reserva</b> entran solos si uno de los marcados se restringe, descansa o se desconecta.</p>
		<div id="sf-msg-wrap">
		<div class="section">Mensaje</div>
		<div class="group"><div class="item"><textarea id="sf-msg" rows="5" placeholder="Hola {{1}}, te escribo por tu saldo pendiente de \${{2}}. ¿Te puedo compartir opciones para ponerte al corriente? Si no deseas recibir mensajes, responde BAJA."></textarea></div></div>
		<div id="sf-review"></div>
		<p class="hint">{{1}} es la 2.ª columna de tu lista (por ejemplo el nombre), {{2}} la 3.ª (el monto), y así. Mensajes cortos, amables y con el nombre de la persona se bloquean menos.<br>Para que no salga idéntico siempre, usa <b>variantes</b> entre llaves separadas por «|»: <i>{Hola|Qué tal|Buen día} {{1}}</i> manda una al azar en cada envío.</p>
		</div>
		<div class="section">Lista de contactos</div>
		<div class="group">
			<div class="item"><textarea id="sf-list" rows="6" placeholder="Un contacto por línea:\nteléfono, nombre, monto\n8112345678, Juan, 1500"></textarea></div>
			<label class="btn">📄 Cargar archivo CSV<input type="file" id="sf-file" accept=".csv,.txt,text/csv" hidden></label>
			<button class="btn" id="sf-validate">✅ Validar lista (quitar números sin WhatsApp)</button>
		</div>
		<p class="hint" id="sf-count"></p>
		<div class="hint" id="sf-invalid"></div>
		<div class="section">Cuidado de los números</div>
		<div class="group">
			<label class="item"><input type="checkbox" id="sf-ramp" checked><span class="grow"><b>Subir el límite poco a poco</b><small>Recomendado. Cada número manda según su salud: 10 al día los primeros días y hasta el máximo cuando ya está sano. Si WhatsApp le rechaza mensajes, baja o se detiene.</small></span></label>
			<label class="item"><input type="checkbox" id="sf-skipchats" checked><span class="grow"><b>Enviar desde un número sin chat</b><small>Si el WhatsApp 1 ya tiene chat con ese cliente, se lo manda el 2; si el 2 también, el 3, y así. Si todos los números que marcaste ya tienen chat con él, se brinca.</small></span></label>
			<label class="item"><input type="checkbox" id="sf-forced"><span class="grow"><b>⚡ Urgente: ignorar los límites</b><small>Para recordatorios obligatorios. Envía aunque los números ya llegaron a su tope del día o de la hora, aunque sea día de descanso o la persona ya haya recibido otro mensaje hoy. Sigue respetando las pausas entre mensajes y nunca usa números a los que WhatsApp les está rechazando mensajes. Úsalo solo cuando sea necesario: sube el riesgo de restricción.</small></span></label>
			<div class="item"><span class="grow">Máximo por número al día</span><input type="number" id="sf-daily" value="30" min="1" max="200" style="text-align:right;max-width:80px"></div>
			<div class="item"><span class="grow">Máximo por número por hora</span><input type="number" id="sf-hourly" value="8" min="1" max="60" style="text-align:right;max-width:80px"></div>
			<div class="item"><span class="grow">Pausa mínima (minutos)</span><input type="number" id="sf-min" value="2" min="1" max="60" style="text-align:right;max-width:80px"></div>
			<div class="item"><span class="grow">Pausa máxima (minutos)</span><input type="number" id="sf-max" value="5" min="1" max="120" style="text-align:right;max-width:80px"></div>
			<div class="item"><span class="grow">Desde (hora)</span><input type="number" id="sf-start" value="9" min="0" max="23" style="text-align:right;max-width:80px"></div>
			<div class="item"><span class="grow">Hasta (hora)</span><input type="number" id="sf-end" value="19" min="1" max="24" style="text-align:right;max-width:80px"></div>
		</div>
		<p class="hint">Recomendado: 20–30 por número al día, máximo 8 por hora y pausas de 2 a 5 minutos. Más rápido aumenta el riesgo de que WhatsApp restrinja el número.</p>
		<div class="pad"><button class="btn primary" id="sf-go">Iniciar envío</button></div>`, el => {
		const perlineOn = () => $('#sf-perline', el).checked
		const rowsNow = () => perlineOn() ? parseNumMsg($('#sf-list', el).value) : parseList($('#sf-list', el).value)
		const phoneOfLine = l => (perlineOn() ? parseNumMsg(l) : parseList(l))[0]?.phone
		const count = () => {
			const perline = perlineOn()
			const rows = rowsNow()
			const accs = el.querySelectorAll('.sf-acc:checked').length
			const daily = Number($('#sf-daily', el).value) || 30
			const msg = perline ? '' : $('#sf-msg', el).value
			$('#sf-review', el).innerHTML = perline ? '' : reviewHTML(msg)
			const days = accs ? Math.ceil(rows.length / (accs * daily)) : 0
			const example = perline ? (rows[0]?.params[0] || '') : (msg && rows[0] ? spin(msg.replace(/\{\{(\d+)\}\}/g, (m, n) => rows[0].params[n - 1] || '')) : '')
			$('#sf-count', el).innerHTML = rows.length
				? `<b>${rows.length}</b> contactos · ${accs} número(s) × ${daily} al día = <b>${accs * daily} al día</b> · terminaría en unos <b>${days} día(s)</b>.${example ? `<br>Ejemplo del primero: <i>${esc(example)}</i>` : ''}`
				: (perline ? 'Pega una línea por contacto: el número y a un lado su mensaje.' : 'Pega la lista o carga un archivo. La primera columna es el teléfono (10 dígitos).')
		}
		$('#sf-perline', el).onchange = () => {
			$('#sf-msg-wrap', el).hidden = perlineOn()
			$('#sf-list', el).placeholder = perlineOn()
				? '6642047600 Hola Luis, te recuerdo tu pago de hoy\n5562096467 Buenas tardes Liliana, no olvides tu compromiso'
				: 'Un contacto por línea:\nteléfono, nombre, monto\n8112345678, Juan, 1500'
			count()
		}
		el.querySelectorAll('input, textarea').forEach(i => { i.addEventListener('input', count); i.addEventListener('change', count) })
		$('#sf-validate', el).onclick = async () => {
			const lines = $('#sf-list', el).value.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
			const rows = rowsNow()
			if (!rows.length) return toast('Primero pega o carga la lista')
			const btn = $('#sf-validate', el)
			btn.disabled = true
			btn.textContent = `Validando ${rows.length} números… (unos ${Math.max(1, Math.ceil(rows.length / 20 * 1.3 / 60))} min)`
			try {
				const accountIds = [...el.querySelectorAll('.sf-acc:checked')].map(i => Number(i.value))
				const { valid, invalid } = await api('POST', '/validate-list', { phones: rows.map(r => r.phone), accountIds })
				const ok = new Set(valid)
				// Se conservan solo las filas con WhatsApp (y las que no parecen teléfono, como encabezados, se quitan)
				$('#sf-list', el).value = lines.filter(l => ok.has(phoneOfLine(l))).join('\n')
				count()
				$('#sf-invalid', el).innerHTML = invalid.length
					? `<details><summary>Se quitaron ${invalid.length} números sin WhatsApp</summary><div style="white-space:pre-wrap">${esc(invalid.join('\n'))}</div></details>`
					: '✅ Todos los números tienen WhatsApp.'
				toast(`${valid.length} con WhatsApp · ${invalid.length} quitados`)
			} catch (e) { toast(e.message, 6000) } finally {
				btn.disabled = false
				btn.textContent = '✅ Validar lista (quitar números sin WhatsApp)'
			}
		}
		$('#sf-file', el).onchange = async e => {
			const f = e.target.files[0]
			if (f) { $('#sf-list', el).value = await f.text(); count() }
		}
		count()
		$('#sf-go', el).onclick = async () => {
			const perline = perlineOn()
			const rows = rowsNow()
			const accountIds = [...el.querySelectorAll('.sf-acc:checked')].map(i => Number(i.value))
			const message = perline ? '{{1}}' : $('#sf-msg', el).value.trim()
			if (!accountIds.length) return toast('Marca al menos un número conectado')
			if (!perline && !message) return toast('Escribe el mensaje')
			if (!rows.length) return toast(perline ? 'Pega los números con su mensaje' : 'La lista está vacía')
			const sample = perline ? (rows[0]?.params[0] || '') : message
			if (reviewMessage(sample).level === 'alto' && !confirm('El revisor marcó el mensaje con riesgo ALTO de reportes o restricción. ¿Enviar de todos modos?')) return
			const daily = Number($('#sf-daily', el).value) || 30
			if (daily > 50 && !confirm(`${daily} mensajes por número al día es mucho y aumenta el riesgo de restricción. ¿Continuar?`)) return
			if ($('#sf-forced', el).checked && !confirm('⚡ Modo urgente: se ignorarán los topes diarios y por hora de tus números. Sube el riesgo de restricción. ¿Continuar?')) return
			if (!confirm(`Se enviará a ${rows.length} contactos desde ${accountIds.length} número(s). ¿Iniciar?`)) return
			try {
				const res = await api('POST', '/campaigns', {
					kind: 'safe',
					accountIds,
					name: $('#sf-name', el).value.trim() || 'Envío seguro',
					message,
					dailyPerNumber: daily,
					hourlyPerNumber: Number($('#sf-hourly', el).value) || 8,
					autoRamp: $('#sf-ramp', el).checked,
				forced: $('#sf-forced', el).checked,
				skipChats: $('#sf-skipchats', el).checked,
					minDelay: Number($('#sf-min', el).value) * 60,
					maxDelay: Number($('#sf-max', el).value) * 60,
					startHour: Number($('#sf-start', el).value),
					endHour: Number($('#sf-end', el).value),
					rows
				})
				closeSheet()
				if (res.invalid?.length) toast(`${res.invalid.length} números no válidos se omitieron`, 5000)
				S.campaigns = [res.campaign, ...S.campaigns.filter(c => c.id !== res.campaign.id)]
				renderCampaignList()
			} catch (e) { toast(e.message) }
		}
	})
}

function openNewCloudCampaign() {
	const cloud = S.accounts.filter(a => a.kind === 'cloud' && a.status === 'connected')
	if (!cloud.length) return toast('Primero conecta una cuenta con la API oficial')
	sheet('Nuevo envío', `
		<div class="section">Nombre del envío</div>
		<div class="group"><div class="item"><input type="text" id="cp-name" placeholder="Ej. Recordatorios lunes"></div></div>
		<div class="section">Enviar desde</div>
		<div class="group"><div class="item"><select id="cp-from">${cloud.map(a => `<option value="${a.id}">${esc(a.name)} (+${esc(a.phone || '')})</option>`).join('')}</select></div></div>
		<div id="cp-tpl"></div>
		<div class="section">Lista de contactos</div>
		<div class="group">
			<div class="item"><textarea id="cp-list" rows="6" placeholder="Un contacto por línea:\nteléfono, valor1, valor2\n8112345678, Juan, 1500"></textarea></div>
			<label class="btn">📄 Cargar archivo CSV / Excel guardado como CSV<input type="file" id="cp-file" accept=".csv,.txt,text/csv" hidden></label>
		</div>
		<p class="hint" id="cp-count">Pega la lista o carga un archivo. La primera columna es el teléfono y las siguientes son los valores {{1}}, {{2}}… de la plantilla.</p>
		<div class="section">Ritmo y horario</div>
		<div class="group">
			<div class="item"><span class="grow">Mensajes por hora</span><input type="number" id="cp-rate" value="50" min="1" max="600" style="text-align:right;max-width:80px"></div>
			<div class="item"><span class="grow">Desde (hora)</span><input type="number" id="cp-start" value="9" min="0" max="23" style="text-align:right;max-width:80px"></div>
			<div class="item"><span class="grow">Hasta (hora)</span><input type="number" id="cp-end" value="19" min="1" max="24" style="text-align:right;max-width:80px"></div>
			<label class="item"><input type="checkbox" id="cp-skipchats" checked><span class="grow"><b>Brincar si ya tiene chat</b><small>Si este número ya tiene chat con ese cliente, no se le manda la plantilla.</small></span></label>
		</div>
		<div class="pad"><button class="btn primary" id="cp-go">Iniciar envío</button></div>`, el => {
		const loadTpl = async () => {
			$('#cp-tpl', el).innerHTML = '<p class="hint">Cargando plantillas…</p>'
			$('#cp-tpl', el).innerHTML = await templateForm(Number($('#cp-from', el).value))
			const sel = $('#tpl-name', el)
			if (sel) {
				const list = JSON.parse($('#tpl-data', el).textContent)
				const show = () => { $('#tpl-fields', el).innerHTML = `<p class="hint" style="white-space:pre-wrap">${esc(list[Number(sel.value)].body)}</p>`; count() }
				sel.onchange = show
				show()
			}
		}
		const count = () => {
			const rows = parseList($('#cp-list', el).value)
			const sel = $('#tpl-name', el)
			const t = sel ? JSON.parse($('#tpl-data', el).textContent)[Number(sel.value)] : null
			const missing = t ? rows.filter(r => r.params.length < t.params).length : 0
			$('#cp-count', el).innerHTML = rows.length
				? `<b>${rows.length}</b> contactos.${t && rows[0] ? `<br>Ejemplo del primero: <i>${esc(t.body.replace(/\{\{(\d+)\}\}/g, (m, n) => rows[0].params[n - 1] || m))}</i>` : ''}${missing ? `<br><span style="color:var(--danger)">${missing} filas no tienen todos los valores de la plantilla.</span>` : ''}`
				: 'Pega la lista o carga un archivo. La primera columna es el teléfono y las siguientes son los valores {{1}}, {{2}}… de la plantilla.'
		}
		$('#cp-from', el).onchange = loadTpl
		$('#cp-list', el).oninput = count
		$('#cp-file', el).onchange = async e => {
			const f = e.target.files[0]
			if (!f) return
			$('#cp-list', el).value = await f.text()
			count()
		}
		loadTpl()
		$('#cp-go', el).onclick = async () => {
			const rows = parseList($('#cp-list', el).value)
			const sel = $('#tpl-name', el)
			if (!sel) return toast('Necesitas una plantilla aprobada')
			if (!rows.length) return toast('La lista está vacía')
			const t = JSON.parse($('#tpl-data', el).textContent)[Number(sel.value)]
			if (rows.some(r => r.params.length < t.params) && !confirm('Algunas filas no tienen todos los valores. Se enviará «-» en los que falten. ¿Continuar?')) return
			if (!confirm(`Se enviará la plantilla «${t.name}» a ${rows.length} contactos. ¿Iniciar?`)) return
			try {
				const res = await api('POST', '/campaigns', {
					accountId: Number($('#cp-from', el).value),
					name: $('#cp-name', el).value.trim() || t.name,
					template: t.name,
					language: t.language,
					perHour: Number($('#cp-rate', el).value),
					startHour: Number($('#cp-start', el).value),
					endHour: Number($('#cp-end', el).value),
					skipChats: $('#cp-skipchats', el).checked,
					rows
				})
				closeSheet()
				if (res.invalid?.length) toast(`${res.invalid.length} números no válidos se omitieron`, 5000)
				S.campaigns = [res.campaign, ...S.campaigns.filter(c => c.id !== res.campaign.id)]
				renderCampaignList()
			} catch (e) { toast(e.message) }
		}
	})
}

async function showFailed(id) {
	try {
		const items = await api('GET', `/campaigns/${id}/items?status=failed`)
		sheet('Envíos fallidos', `<div class="group">${items.map(i => `<div class="item" style="display:block"><b>+${esc(i.phone)}</b><small>${esc(i.error || '')}</small></div>`).join('') || '<p class="hint">Sin fallidos</p>'}</div>`)
	} catch (e) { toast(e.message) }
}

// ---------- Cuentas ----------
function renderAccounts() {
	$('#view').innerHTML = `
		${largeBar('Cuentas', `<button class="icon-btn" data-act="add-account" aria-label="Agregar">${IC.plus}</button>`)}
		<div class="settings" style="min-height:100%">
		${S.accounts.length ? `<div class="section">Tus WhatsApp (${S.accounts.length})</div><div class="group">${S.accounts.map(a => `
			<a class="item" href="#/account/${a.id}">
				<span class="swatch" style="--c:${esc(a.color)};width:16px;height:16px;border:0"></span>
				<span class="grow"><b>${esc(a.name)} ${a.status === 'connected' ? healthDot(a) : ''}${a.reserve ? ' <small style="display:inline;color:#7C5CFF">reserva</small>' : ''}</b><small>${a.phone ? esc(fmtPhone(a.phone)) : 'Sin vincular'}${a.health && a.status === 'connected' ? ' · ' + esc(a.health.reason) : ''}${a.health?.replyRate != null ? ` · le contestan ${a.health.replyRate}%` : ''}</small></span>
				<span class="status" style="color:${statusColor(a)}">${statusText(a)}</span>${IC.chevron}
			</a>`).join('')}</div>` : `<div class="empty"><div class="big">📱</div>Toca <b>＋</b> para agregar tu primer WhatsApp.</div>`}
		<p class="hint">Cada cuenta se vincula como «dispositivo vinculado», igual que WhatsApp Web. El teléfono de cada cuenta no necesita estar encendido, pero debe abrir WhatsApp al menos una vez cada 14 días.</p>
		</div>`
}

function colorPicker(selected) {
	return `<div class="swatches">${COLORS.map(c => `<button type="button" class="swatch ${c === selected ? 'on' : ''}" style="--c:${c}" data-color="${c}" aria-label="${c}"></button>`).join('')}</div>`
}
function bindColorPicker(el, onPick) {
	el.querySelectorAll('[data-color]').forEach(b => {
		b.onclick = () => {
			el.querySelectorAll('[data-color]').forEach(x => x.classList.toggle('on', x === b))
			onPick(b.dataset.color)
		}
	})
}

function openAddAccount() {
	let color = COLORS[S.accounts.length % COLORS.length]
	let kind = 'cloud'
	sheet('Nueva cuenta', `
		<div class="section">Tipo de conexión</div>
		<div class="group">
			<label class="item"><input type="radio" name="na-kind" value="cloud" checked><span class="grow"><b>API oficial de WhatsApp</b><small>Recomendado. Sin riesgo de bloqueo por la app. Necesitas los datos de Meta.</small></span></label>
			<label class="item"><input type="radio" name="na-kind" value="baileys"><span class="grow"><b>WhatsApp normal (código o QR)</b><small>Gratis, pero WhatsApp puede restringir el número.</small></span></label>
		</div>
		<div class="section">Nombre</div>
		<div class="group"><div class="item"><input type="text" id="na-name" placeholder="Ej. Cobranza, Ventas"></div></div>
		<div class="section">Color</div>
		<div class="group">${colorPicker(color)}</div>
		<div id="na-cloud">
			<div class="section">Datos de Meta</div>
			<div class="group">
				<div class="item"><input type="text" id="na-pnid" inputmode="numeric" placeholder="Identificador del número de teléfono"></div>
				<div class="item"><input type="text" id="na-waba" inputmode="numeric" placeholder="Identificador de la cuenta de WhatsApp Business"></div>
				<div class="item"><input type="password" id="na-token" placeholder="Token permanente" autocomplete="off"></div>
				<div class="item"><input type="password" id="na-secret" placeholder="Clave secreta de la app (opcional)" autocomplete="off"></div>
			</div>
			<p class="hint">Los dos identificadores están en developers.facebook.com › tu app › WhatsApp › Configuración de la API. La clave secreta está en Configuración de la app › Básica.</p>
		</div>
		<div class="pad"><button class="btn primary" id="na-go">Crear cuenta</button></div>`, el => {
		bindColorPicker(el, c => { color = c })
		el.querySelectorAll('input[name=na-kind]').forEach(r => {
			r.onchange = () => { kind = r.value; $('#na-cloud', el).hidden = kind !== 'cloud' }
		})
		$('#na-go', el).onclick = async () => {
			const name = $('#na-name', el).value.trim() || `WhatsApp ${S.accounts.length + 1}`
			const body = { name, color, kind }
			if (kind === 'cloud') {
				Object.assign(body, {
					phoneNumberId: $('#na-pnid', el).value.trim(),
					wabaId: $('#na-waba', el).value.trim(),
					token: $('#na-token', el).value.trim(),
					appSecret: $('#na-secret', el).value.trim()
				})
				if (!body.phoneNumberId || !body.wabaId || !body.token) return toast('Llena los dos identificadores y el token')
			}
			const btn = $('#na-go', el)
			btn.disabled = true
			try {
				const a = await api('POST', '/accounts', body)
				if (!account(a.id)) S.accounts.push(a)
				closeSheet()
				go('#/account/' + a.id)
			} catch (e) { toast(e.message) } finally { btn.disabled = false }
		}
	})
}

async function renderCloudAccount(a) {
	const link = $('#ac-link')
	const sig = JSON.stringify([a.status, a.error, a.cloud])
	if (link.dataset.sig === sig) return
	link.dataset.sig = sig
	const c = a.cloud || {}
	const quality = { GREEN: ['Alta', 'var(--accent)'], YELLOW: ['Media', '#f5a623'], RED: ['Baja', 'var(--danger)'] }[c.quality] || null
	let setup = { callbackUrl: '…', verifyToken: '…', privacyUrl: '…' }
	try { setup = await api('GET', '/cloud/setup') } catch {}
	link.innerHTML = `
		${a.error ? `<p class="hint" style="color:var(--danger)">⚠︎ ${esc(a.error)}</p>` : ''}
		<div class="section">API oficial</div>
		<div class="group">
			${c.displayName ? `<div class="item"><span class="grow">Nombre visible</span><span>${esc(c.displayName)}${c.nameStatus && c.nameStatus !== 'APPROVED' ? ` <small style="display:inline;color:#f5a623">(${esc(c.nameStatus)})</small>` : ''}</span></div>` : ''}
			${quality ? `<div class="item"><span class="grow">Calidad del número</span><span style="color:${quality[1]}">${quality[0]}</span></div>` : ''}
			<div class="item"><span class="grow">Límite diario de envíos</span><input type="number" id="cl-limit" value="${c.dailyLimit || 250}" min="1" style="text-align:right;max-width:90px"></div>
			<div class="item"><input type="password" id="cl-token" placeholder="Nuevo token (déjalo vacío para no cambiarlo)" autocomplete="off"></div>
			<div class="item"><input type="password" id="cl-secret" placeholder="${c.hasSecret ? 'Clave secreta guardada ✓ (escribe otra para cambiarla)' : 'Clave secreta de la app (opcional)'}" autocomplete="off"></div>
			<button class="btn" data-act="cl-save">Guardar y reconectar</button>
		</div>

		<div class="section">Conectar los mensajes entrantes (una sola vez)</div>
		<div class="group">
			<div class="item" style="display:block"><small>URL de devolución de llamada</small><code style="user-select:all;word-break:break-all">${esc(setup.callbackUrl)}</code></div>
			<div class="item" style="display:block"><small>Token de verificación</small><code style="user-select:all">${esc(setup.verifyToken)}</code></div>
		</div>
		<p class="hint">En developers.facebook.com › tu app › WhatsApp › <b>Configuración</b> › Webhook › <b>Editar</b>, pega estos dos datos y toca «Verificar y guardar». Luego, en «Campos del webhook», activa <b>messages</b>. Para recibir mensajes reales, la app de Meta debe estar <b>Publicada</b>: usa como política de privacidad <code style="user-select:all;word-break:break-all">${esc(setup.privacyUrl)}</code></p>

		<div class="section">Plantillas <a href="#" data-act="tpl-refresh" style="float:right;text-transform:none">Actualizar</a></div>
		<div class="group" id="tpl-list"><p class="hint">Cargando…</p></div>
		<div class="section">Nueva plantilla</div>
		<div class="group">
			<div class="item"><input type="text" id="nt-name" placeholder="Nombre (ej. recordatorio_pago)"></div>
			<div class="item"><select id="nt-cat"><option value="UTILITY">Utilidad (recordatorios, avisos) · más barata</option><option value="MARKETING">Marketing (promociones, descuentos)</option></select></div>
			<div class="item"><textarea id="nt-body" oninput="document.getElementById('nt-review').innerHTML = reviewHTML(this.value)" rows="5" placeholder="Hola {{1}}, te recordamos que tienes un saldo pendiente de \${{2}}. Responde a este mensaje para revisar opciones de pago. Si no deseas recibir más mensajes, responde BAJA."></textarea></div>
			<div class="item"><input type="text" id="nt-ex" placeholder="Ejemplos separados por coma: Juan, 1500"></div>
			<button class="btn" data-act="tpl-create">Enviar a revisión de Meta</button>
		</div>
		<div id="nt-review"></div>
		<p class="hint">Usa {{1}}, {{2}}… donde va el dato de cada persona (nombre, monto, fecha). Meta revisa la plantilla en minutos u horas. Si el texto ofrece descuentos u ofertas, Meta la cobra como marketing.</p>`
	renderTemplateList(a.id)
}

async function renderTemplateList(accountId, refresh) {
	const el = $('#tpl-list')
	if (!el) return
	try {
		const list = await loadTemplates(accountId, refresh)
		el.innerHTML = list.length ? list.map(t => {
			const [st, color] = TPL_STATUS[t.status] || [t.status, 'var(--muted)']
			return `<div class="item" style="display:block"><div style="display:flex;gap:8px"><b class="grow">${esc(t.name)}</b><small style="display:inline;color:var(--muted)">${t.category === 'MARKETING' ? 'Marketing' : t.category === 'UTILITY' ? 'Utilidad' : esc(t.category)}</small><span class="status" style="color:${color}">${st}</span></div>
				<small style="white-space:pre-wrap">${esc(t.body)}</small>${t.rejectedReason ? `<small style="color:var(--danger)">Motivo: ${esc(t.rejectedReason)}</small>` : ''}</div>`
		}).join('') : '<p class="hint">Aún no tienes plantillas.</p>'
	} catch (e) {
		el.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(e.message)}</p>`
	}
}

// ---------- Perfil de WhatsApp (foto, nombre, info) ----------
async function loadProfile(id) {
	const el = $('#ac-profile'); if (!el) return
	el.innerHTML = '<div class="section">Perfil de WhatsApp</div><div class="group"><div class="item"><span class="grow muted">Cargando perfil…</span></div></div>'
	try { renderProfile(id, await api('GET', `/accounts/${id}/profile`)) }
	catch (e) { el.innerHTML = `<div class="section">Perfil de WhatsApp</div><p class="hint">No se pudo leer el perfil: ${esc(e.message)}</p>` }
}
function renderProfile(id, p) {
	const el = $('#ac-profile'); if (!el) return
	el.innerHTML = `
		<div class="section">Perfil de WhatsApp</div>
		<div class="group">
			<div class="profile-head">
				<button class="profile-photo" data-act="pf-photo" aria-label="Cambiar foto">${p.picture ? `<img src="${esc(p.picture)}" alt="">` : PH_PERSON}<span class="cam">${IC.camera}</span></button>
				<button class="link" data-act="pf-photo">${p.picture ? 'Cambiar foto' : 'Poner foto'}</button>
			</div>
			<div class="item"><span>Nombre</span><input type="text" id="pf-name" maxlength="25" placeholder="Tu nombre" style="text-align:right"></div>
			<div class="item"><span>Info</span><input type="text" id="pf-status" maxlength="139" placeholder="Disponible" style="text-align:right"></div>
			<button class="btn" data-act="pf-save" data-val="${id}">Guardar nombre e info</button>
			${p.picture ? `<button class="btn danger" data-act="pf-photo-del" data-val="${id}">Quitar foto</button>` : ''}
		</div>
		<input type="file" id="pf-file" accept="image/*" hidden>
		<p class="hint">Así te ven tus clientes en WhatsApp. Un perfil con foto, nombre e info se ve más confiable y lo reportan menos.</p>`
	$('#pf-name').value = p.name || ''
	$('#pf-status').value = p.status || ''
	$('#pf-file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadProfilePhoto(id, f) }
}
// Recorta la foto en cuadro de 640×640 y la convierte a JPG (lo que pide WhatsApp)
function squareJpeg(file, size = 640) {
	return new Promise((resolve, reject) => {
		const img = new Image()
		const url = URL.createObjectURL(file)
		img.onload = () => {
			const side = Math.min(img.naturalWidth, img.naturalHeight)
			const c = document.createElement('canvas')
			c.width = c.height = size
			const ctx = c.getContext('2d')
			ctx.fillStyle = '#fff'
			ctx.fillRect(0, 0, size, size)
			ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size)
			URL.revokeObjectURL(url)
			c.toBlob(b => b ? resolve(b) : reject(new Error('No se pudo procesar la foto')), 'image/jpeg', 0.88)
		}
		img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo abrir la foto')) }
		img.src = url
	})
}
async function uploadProfilePhoto(id, file) {
	try {
		toast('Subiendo foto…', 20000)
		const fd = new FormData()
		fd.append('file', await squareJpeg(file), 'perfil.jpg')
		const res = await fetch(`/api/accounts/${id}/profile/photo`, { method: 'POST', headers: { Authorization: 'Bearer ' + S.token }, body: fd })
		const data = await res.json().catch(() => ({}))
		if (!res.ok) throw new Error(data.error || 'Error ' + res.status)
		renderProfile(id, data)
		toast('Foto actualizada ✅')
	} catch (e) { toast(e.message, 6000) }
}

function renderAccount(id, full) {
	const a = account(id)
	const view = $('#view')
	if (!a) {
		view.innerHTML = `${navBar('Cuenta', '#/accounts', 'Cuentas')}<div class="empty">Cuenta no encontrada</div>`
		return
	}
	if (full) {
		view.innerHTML = `
			${navBar('', '#/accounts', 'Cuentas').replace('id="nav-title"', 'id="ac-title"')}
			<div class="settings" style="min-height:100%">
				<div class="group" style="margin-top:16px">
					<div class="item"><span class="grow">Estado</span><span class="status" id="ac-status"></span></div>
					<div class="item" id="ac-phone-row"><span class="grow">Número</span><span id="ac-phone"></span></div>
				</div>
				<div id="ac-link"></div>
				<div id="ac-profile"></div>
				<div id="ac-health"></div>
				<div id="ac-reserve"></div>
				<div class="section">Personalizar</div>
				<div class="group">
					<div class="item"><span>Nombre</span><input type="text" id="ac-name" style="text-align:right"></div>
					${colorPicker(a.color)}
					<button class="btn" data-act="ac-save">Guardar cambios</button>
				</div>
				<div class="section">Sesión</div>
				<div class="group" id="ac-actions"></div>
				<div style="height:30px"></div>
			</div>`
		$('#ac-name').value = a.name
		view.dataset.color = a.color
		bindColorPicker(view, c => { view.dataset.color = c })
	}
	$('#ac-title').textContent = a.name
	$('#ac-status').textContent = statusText(a)
	$('#ac-status').style.color = statusColor(a)
	$('#ac-phone').textContent = a.phone ? fmtPhone(a.phone) : '—'

	if (a.kind === 'cloud') {
		renderCloudAccount(a)
		const actionsEl = $('#ac-actions')
		if (actionsEl.dataset.sig !== 'cloud') {
			actionsEl.dataset.sig = 'cloud'
			actionsEl.innerHTML = '<button class="btn" data-act="ac-connect">Reconectar</button><button class="btn danger" data-act="ac-delete">Eliminar cuenta</button>'
		}
		return
	}
	const link = $('#ac-link')
	const mode = a.status === 'qr' ? 'qr' : a.status === 'connecting' || a.status === 'reconnecting' ? 'wait' : 'none'
	if (link.dataset.mode !== mode) {
		link.dataset.mode = mode
		if (mode === 'qr') {
			link.innerHTML = `
				<div class="section">Opción 1 · Código (recomendado en iPhone)</div>
				<div class="group">
					<div class="item"><input type="tel" id="ac-pair-phone" inputmode="tel" placeholder="Número de esta cuenta, ej. 5215512345678"></div>
					<button class="btn" data-act="ac-pair">Obtener código</button>
					<div class="code" id="ac-code" hidden></div>
				</div>
				<p class="hint">En el teléfono de esa cuenta abre WhatsApp › Ajustes › Dispositivos vinculados › Vincular un dispositivo › <b>Vincular con número de teléfono</b> y escribe el código.</p>
				<div class="section">Opción 2 · Escanear QR</div>
				<div class="group"><img class="qr" id="ac-qr" alt="Código QR"></div>
				<p class="hint">Escanéalo desde otro teléfono en WhatsApp › Dispositivos vinculados › Vincular un dispositivo. El código se renueva solo.</p>`
		} else if (mode === 'wait') {
			link.innerHTML = '<p class="hint">Conectando con WhatsApp…</p>'
		} else {
			link.innerHTML = ''
		}
	}
	const qr = $('#ac-qr')
	if (qr && a.qr && qr.getAttribute('src') !== a.qr) qr.src = a.qr

	const pEl = $('#ac-profile')
	if (pEl) {
		const sig = a.status === 'connected' ? 'on' : 'off'
		if (pEl.dataset.sig !== sig) {
			pEl.dataset.sig = sig
			if (sig === 'on') loadProfile(a.id)
			else pEl.innerHTML = ''
		}
	}

	const rEl = $('#ac-reserve')
	if (rEl) {
		const html = `<div class="section">Número de reserva</div>
			<div class="group"><label class="item"><input type="checkbox" id="ac-reserve-cb" ${a.reserve ? 'checked' : ''}><span class="grow"><b>Usar como reserva</b><small>No se usa en los envíos masivos hasta que otro número se restrinja, descanse o se desconecte; entonces entra solo, empezando con pocos mensajes.</small></span></label></div>`
		if (rEl.dataset.sig !== String(a.reserve)) {
			rEl.dataset.sig = String(a.reserve)
			rEl.innerHTML = html
			$('#ac-reserve-cb').onchange = async e => {
				try {
					Object.assign(account(a.id), await api('PATCH', `/accounts/${a.id}`, { reserve: e.target.checked }))
					toast(e.target.checked ? 'Ahora es número de reserva' : 'Ya no es de reserva')
				} catch (err) { toast(err.message) }
			}
		}
	}
	const hEl = $('#ac-health')
	if (hEl) {
		const h = a.health
		const html = h && a.status === 'connected' ? `
			<div class="section">Salud del número</div>
			<div class="group">
				<div class="item"><span class="grow">Semáforo</span><span>${healthDot(a)} ${HEALTH[h.level][1]}</span></div>
				<div class="item"><span class="grow">Rechazos de WhatsApp</span><span>${h.rejections24h} en 24 h · ${h.rejections72h} en 3 días</span></div>
				<div class="item"><span class="grow">Días vinculado</span><span>${h.ageDays}</span></div>
				<div class="item"><span class="grow">Envíos sugeridos hoy</span><span><b>${h.suggestedDaily}</b></span></div>
			</div>
			<div class="group">${h.restUntil
				? '<button class="btn" data-act="rest" data-val="0">Terminar descanso ahora</button>'
				: [3, 5, 7].map(d => `<button class="btn" data-act="rest" data-val="${d}">😴 Poner a descansar ${d} días</button>`).join('')}</div>
			<p class="hint">${esc(h.reason)} Si WhatsApp le rechaza 2 mensajes en un día, el número descansa 5 días solo. Al volver, el límite sube otra vez poco a poco (10 → 15 → 20 → 30).</p>` : ''
		if (hEl.innerHTML.trim() !== html.trim()) hEl.innerHTML = html
	}

	const actions = []
	const actionsEl = $('#ac-actions')
	if (a.status === 'logged_out' || a.status === 'disconnected') actions.push('<button class="btn" data-act="ac-connect">Vincular este WhatsApp</button>')
	if (a.status === 'connected') actions.push('<button class="btn danger" data-act="ac-logout">Cerrar sesión</button>')
	actions.push('<button class="btn danger" data-act="ac-delete">Eliminar cuenta</button>')
	if (actionsEl.dataset.sig !== a.status) {
		actionsEl.dataset.sig = a.status
		actionsEl.innerHTML = actions.join('')
	}
}

async function accountAction(act) {
	const id = Number(route().arg)
	try {
		if (act === 'ac-save') {
			const name = $('#ac-name').value.trim()
			const updated = await api('PATCH', `/accounts/${id}`, { name, color: $('#view').dataset.color })
			Object.assign(account(id), updated)
			toast('Guardado')
			render()
		} else if (act === 'ac-connect') {
			Object.assign(account(id), await api('POST', `/accounts/${id}/connect`))
			render()
		} else if (act === 'ac-logout') {
			if (!confirm('¿Cerrar la sesión de este WhatsApp?')) return
			Object.assign(account(id), await api('POST', `/accounts/${id}/logout`))
			render()
		} else if (act === 'ac-delete') {
			if (!confirm('Se borrará la cuenta y sus mensajes guardados. ¿Continuar?')) return
			await api('DELETE', `/accounts/${id}`)
			S.accounts = S.accounts.filter(a => a.id !== id)
			S.convs = await api('GET', '/conversations')
			go('#/accounts')
		} else if (act === 'cl-save') {
			const body = { dailyLimit: Number($('#cl-limit').value) || 250 }
			const token = $('#cl-token').value.trim()
			const secret = $('#cl-secret').value.trim()
			if (token) body.token = token
			if (secret) body.appSecret = secret
			Object.assign(account(id), await api('PUT', `/accounts/${id}/cloud`, body))
			toast(account(id).status === 'connected' ? 'Conectado ✅' : 'Guardado')
			render()
		} else if (act === 'tpl-refresh') {
			renderTemplateList(id, true)
		} else if (act === 'tpl-create') {
			const examples = $('#nt-ex').value.split(',').map(x => x.trim()).filter(Boolean)
			const res = await api('POST', `/accounts/${id}/templates`, {
				name: $('#nt-name').value, category: $('#nt-cat').value, body: $('#nt-body').value, examples, language: 'es_MX'
			})
			toast(`Plantilla «${res.name}» enviada a revisión`)
			$('#nt-name').value = ''; $('#nt-body').value = ''; $('#nt-ex').value = ''
			renderTemplateList(id, true)
		} else if (act === 'ac-pair') {
			const phone = $('#ac-pair-phone').value
			if (phone.replace(/\D/g, '').length < 8) return toast('Escribe el número completo con código de país')
			const { code } = await api('POST', `/accounts/${id}/pairing-code`, { phone })
			const el = $('#ac-code')
			el.textContent = code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code
			el.hidden = false
		}
	} catch (e) { toast(e.message) }
}

// ---------- Ajustes ----------
function renderSettings() {
	const view = $('#view')
	const perm = 'Notification' in window ? Notification.permission : 'unsupported'
	const notif = perm === 'granted'
		? '<div class="item"><span class="grow">Notificaciones</span><span style="color:var(--accent)">Activadas</span></div><button class="btn" data-act="push">Volver a registrar este dispositivo</button>'
		: '<button class="btn" data-act="push">Activar notificaciones</button>'
	const prevLabel = $('#nl-name')?.value || ''
	view.innerHTML = `
		${largeBar('Ajustes')}
		<div class="settings" style="min-height:100%">
			<div class="section">Notificaciones</div>
			<div class="group">${notif}</div>
			<p class="hint">${isStandalone() ? 'Recibirás avisos aunque la app esté cerrada.' : 'En iPhone, primero añade la app a la pantalla de inicio (Compartir › Añadir a pantalla de inicio) y ábrela desde ese ícono.'}</p>

			<div class="section">Etiquetas</div>
			<div class="group">
				${S.labels.map(l => `<div class="item"><span class="tag solid" style="--c:${esc(l.color)}">${esc(l.name)}</span><span class="grow"></span><button class="icon-btn" data-act="del-label" data-val="${l.id}" aria-label="Borrar">${IC.trash}</button></div>`).join('')}
				<div class="item"><input type="text" id="nl-name" placeholder="Nueva etiqueta (ej. Cliente, Pendiente)"></div>
				${colorPicker(COLORS[1])}
				<button class="btn" data-act="add-label">Agregar etiqueta</button>
			</div>
			<p class="hint">Asigna etiquetas desde el menú ⋯ de cada chat y filtra por ellas en la bandeja.</p>

			<div class="section">Asistente inteligente</div>
			<div class="group"><div class="item"><span class="grow">Entender respuestas de clientes<small>Etiqueta, da de baja, crea recordatorios y sugiere respuestas</small></span><label class="switch"><input type="checkbox" data-act="smart-toggle" id="smart-cb" checked><i></i></label></div></div>
			<p class="hint">Cuando un cliente contesta, la app lo entiende y actúa sola: «ya pagué» → etiqueta <b>Pagó</b>; «mañana le deposito» → <b>Promesa de pago</b> y recordatorio ese día; «número equivocado», «baja» o una queja → ya no recibe masivos; «¿a qué cuenta deposito?» → te sugiere tu respuesta de datos de pago. También detecta el monto prometido, si dice que no tiene dinero, si se niega, si pregunta su saldo o si está molesto; lleva el historial de promesas (si pasa un día de la fecha sin que diga que pagó, la marca <b>Promesa incumplida</b> y te avisa) y te deja una respuesta sugerida en cada caso. Además los masivos respetan la hora local del cliente (según su lada) y el horario legal de 7 a 22 h.</p>

			<div class="section">Corrección de texto</div>
			<div class="group"><div class="item"><span class="grow">Revisar antes de enviar<small>Corrige ortografía y propone una respuesta mejorada</small></span><label class="switch"><input type="checkbox" data-act="ai-review-toggle" id="ai-review-cb"${S.ai.review ? ' checked' : ''}><i></i></label></div></div>
			<p class="hint">Al tocar enviar se abre una revisión con el texto corregido (acentos, abreviaturas, signos y mayúsculas) y una versión más cordial; eliges cuál mandar o la editas. También puedes usar el botón ✨ junto al mensaje. Todo se hace en tu servidor, sin IA ni servicios externos.</p>

			<div class="section">Calentamiento de números</div>
				<div id="warmup-box" class="group"><div class="item"><span class="grow">Cargando…</span></div></div>
				<p class="hint">Tus números conversan entre sí con charlas naturales (saludos, pendientes, comida, clima…), a cualquier hora pero como una persona: mucho de día y casi nada de madrugada. Reparte los mensajes del día según la hora, contesta en uno o dos mensajes, a veces citando o con una reacción, y da más charla a los números que hicieron masivos. Los recién vinculados solo reciben sus primeras 24 h y los que están en descanso charlan poquito. Cada número escribe a su manera (risa, emojis, acentos, rapidez). Si los mensajes de un número dejan de llegarle a tus otros números, lo pausa y te avisa. Estos chats se archivan solos y no te mandan notificaciones. Necesitas al menos <b>2 números conectados</b>.</p>

				<div class="section">Días sin envíos masivos</div>
			<div class="chips" style="padding:8px 16px">${[[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [0, 'Dom']].map(([d, t]) => `<button class="chip ${S.restDays.includes(d) ? 'on' : ''}" style="--c:#7C5CFF" data-act="rest-day" data-val="${d}">${t}</button>`).join('')}</div>
			<p class="hint">Los días marcados no sale ningún envío masivo (los chats normales sí funcionan). Descansar los domingos ayuda a que los números se vean como de una persona real.</p>

			<div class="section">Respuestas rápidas</div>
			<div class="group">
				${S.replies.map(r => `<div class="item"><span class="grow"><b>${esc(r.title)}</b><small style="white-space:pre-wrap">${esc(r.text)}</small></span><button class="icon-btn" data-act="del-reply" data-val="${r.id}" aria-label="Borrar">${IC.trash}</button></div>`).join('')}
				<div class="item"><input type="text" id="qr-title" placeholder="Nombre (ej. Datos de pago)"></div>
				<div class="item"><textarea id="qr-text" rows="3" placeholder="Texto. Usa {nombre} para poner el nombre del cliente."></textarea></div>
				<button class="btn" data-act="add-reply">Agregar respuesta rápida</button>
			</div>
			<p class="hint">En cualquier chat escribe <b>/</b> y elige una respuesta. {nombre} se cambia por el nombre del cliente.</p>

			<div class="section">Almacenamiento</div>
			<div class="group"><div class="item"><span class="grow">Datos guardados</span><span id="storage">…</span></div></div>

			<div class="section">Seguridad</div>
			<div class="group">
				<button class="btn" data-act="change-pw">Cambiar contraseña</button>
				<button class="btn danger" data-act="logout">Salir en este dispositivo</button>
			</div>
			<div style="height:30px"></div>
		</div>`
	$('#nl-name').value = prevLabel
	loadWarmup()
	api('GET', '/settings/smart').then(r => { const cb = $('#smart-cb'); if (cb) cb.checked = r.enabled }).catch(() => {})
	api('GET', '/settings/ai').then(r => { S.ai = r; const cb = $('#ai-review-cb'); if (cb) cb.checked = r.review }).catch(() => {})
	api('GET', '/info').then(info => {
		const el = $('#storage')
		if (el) el.innerHTML = info.persistent
			? '<span style="color:var(--accent)">Permanentes ✅</span>'
			: '<span style="color:var(--danger)">Temporales ⚠️ falta el disco /data</span>'
	}).catch(() => {})
	view.dataset.labelColor = COLORS[1]
	bindColorPicker(view, c => { view.dataset.labelColor = c })
}

async function loadWarmup() {
	const box = $('#warmup-box'); if (!box) return
	try { renderWarmupBox(await api('GET', '/warmup')) } catch { box.innerHTML = '<div class="item"><span class="grow">No se pudo cargar</span></div>' }
}
function renderWarmupBox(st) {
	const box = $('#warmup-box'); if (!box) return
	S.warmup = st
	const p = st.plan || {}
	const sw = (act, on) => `<label class="switch"><input type="checkbox" data-act="${act}" ${on ? 'checked' : ''}><i></i></label>`
	const state = st.eligible < 2 ? `<span class="pill warn">${st.eligible} conectado(s) · faltan números</span>`
		: !st.enabled ? '<span class="pill">En pausa</span>'
			: '<span class="pill ok">Funcionando</span>'
	const numState = n => n.flagged ? `⚠️ Pausado: ${esc(n.flagged.reason)}`
		: n.grace ? 'Recién vinculado: solo recibe sus primeras 24 h'
			: n.resting && n.target > 0 ? `En descanso de masivos: charla ligera · ${n.sentToday} de ${n.target} hoy`
				: n.target > 0 ? `${n.sentToday} de ${n.target} hoy · recibió ${n.receivedToday} · ${n.ageDays} día(s)${n.campaignToday ? ` · ${n.campaignToday} masivos hoy` : ''}`
					: 'Hoy no envía (rechazos o mensajes sin entregar); solo recibe'
	const bar = (v, max, color = 'var(--accent)') => `<div style="height:4px;border-radius:2px;background:var(--fill);margin-top:6px;overflow:hidden"><div style="height:100%;width:${Math.min(100, max ? Math.round(v / max * 100) : 0)}%;background:${color}"></div></div>`
	const matColor = sc => sc >= 70 ? 'var(--accent)' : sc >= 40 ? 'var(--warn)' : 'var(--danger)'
	const nums = (st.numbers || []).map(n => {
		const m = n.maturity || { score: 0, label: '—', tips: [] }
		return `<div class="item" style="align-items:flex-start"><span class="grow">${esc(n.name)}
			<small>${numState(n)}</small>
			${n.target > 0 ? bar(n.sentToday, n.target) : ''}
			<small style="margin-top:6px">Madurez <b style="color:${matColor(m.score)}">${m.score}/100 · ${m.label}</b>${m.score < 70 && m.readyIn ? ` · lista en ~${m.readyIn} día(s)` : ''}</small>
			${bar(m.score, 100, matColor(m.score))}
			${m.tips?.length ? `<small style="margin-top:4px">💡 ${m.tips.map(esc).join(' · ')}</small>` : ''}
			${n.flagged ? `<button class="btn" style="margin-top:8px" data-act="warmup-unflag" data-val="${n.id}">Reanudar ya</button>` : ''}
		</span>${n.inConvo ? '<span class="pill ok">💬 charlando</span>' : n.asleep ? '<span class="pill">😴 durmiendo</span>' : ''}</div>`
	}).join('')
	const wk = p.week || []
	const wkMax = Math.max(1, ...wk)
	const days = ['D', 'L', 'M', 'M', 'J', 'V', 'S']
	const today = new Date().getDay()
	const chart = wk.length ? `<div class="item" style="display:block"><span class="muted" style="font-size:13px">Mensajes de los últimos 7 días</span>
		<div style="display:flex;align-items:flex-end;gap:6px;height:56px;margin-top:8px">${wk.map((v, i) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px"><span class="muted" style="font-size:10px">${v || ''}</span><div style="width:100%;max-width:26px;height:${Math.max(2, Math.round(v / wkMax * 34))}px;border-radius:3px;background:${i === 6 ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 40%, transparent)'}"></div><span class="muted" style="font-size:10px">${days[(today - 6 + i + 7) % 7]}</span></div>`).join('')}</div></div>` : ''
	const manual = st.auto ? `<div class="item" style="display:block"><span class="grow">Intensidad</span>
		<div class="chips" style="padding:8px 0 0">${[['suave', 'Suave'], ['normal', 'Normal'], ['intenso', 'Intenso']].map(([k, t]) => `<button class="chip ${st.intensity === k ? 'on' : ''}" style="--c:#25D366" data-act="warmup-intensity" data-val="${k}">${t}</button>`).join('')}</div></div>` : `
		<div class="item"><span class="grow">Tope por número al día</span><input type="number" id="wu-perday" min="1" max="40" value="${st.perDay}" class="num"></div>
		${st.allDay ? '' : `<div class="item"><span class="grow">Horario</span><input type="number" id="wu-start" min="0" max="23" value="${st.startHour}" class="num"><span class="muted">a</span><input type="number" id="wu-end" min="1" max="24" value="${st.endHour}" class="num"></div>`}
		<div class="item"><span class="grow">Pausa entre charlas (min)</span><input type="number" id="wu-min" min="5" max="360" value="${st.minDelay}" class="num"><span class="muted">–</span><input type="number" id="wu-max" min="5" max="720" value="${st.maxDelay}" class="num"></div>
		<button class="btn" data-act="warmup-save">Guardar</button>`
	const act = { alta: 'Alta', media: 'Media', baja: 'Baja (noche)', fuera: 'Fuera de horario' }
	const lib = st.library || { files: [] }
	const tk = enc(S.token)
	const libHtml = `
		<div class="item sub-head"><span class="grow">Fotos y notas de voz</span></div>
		<div class="item"><span class="grow muted" style="font-size:13px">Las usa en charlas («¿me mandas la foto?», audios) y en estados.</span></div>
		${lib.files.length ? `<div class="item" style="display:flex;flex-wrap:wrap;gap:8px">${lib.files.map(f => f.kind === 'image'
		? `<div style="position:relative;width:64px;height:64px"><img src="/api/warmup/media/${enc(f.name)}?token=${tk}" style="width:64px;height:64px;object-fit:cover;border-radius:8px" loading="lazy" alt=""><button class="icon-btn" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;min-width:0;padding:0;font-size:11px;line-height:20px;background:var(--fill);border-radius:50%" data-act="warmup-media-del" data-val="${esc(f.name)}" aria-label="Borrar">✕</button></div>`
		: `<div style="position:relative;height:64px;padding:0 12px;display:flex;align-items:center;border-radius:8px;background:var(--fill)">🎤 ${Math.max(1, Math.round(f.size * 8 / 32000))} s<button class="icon-btn" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;min-width:0;padding:0;font-size:11px;line-height:20px;background:var(--fill);border-radius:50%" data-act="warmup-media-del" data-val="${esc(f.name)}" aria-label="Borrar">✕</button></div>`).join('')}</div>` : '<div class="item"><span class="grow muted" style="font-size:13px">Aún no hay. Sube fotos casuales (comida, paisajes, mascotas) y audios cortos tipo «ya voy» o «ahorita te marco».</span></div>'}
		<label class="btn">➕ Subir foto o audio<input type="file" id="wu-media" accept="image/jpeg,image/png,image/webp,audio/*" multiple hidden></label>`
	box.innerHTML = `
		<div class="item"><span class="grow">Calentamiento</span>${sw('warmup-toggle', st.enabled)}</div>
		<div class="item"><span class="grow">Automático<small>Decide solo cuánto y cuándo según cada número</small></span>${sw('warmup-auto', st.auto)}</div>
		<div class="item"><span class="grow">Las 24 horas<small>De noche casi no habla, como una persona</small></span>${sw('warmup-allday', st.allDay)}</div>
		${manual}
		<div class="item"><span class="grow">Fotos, audios, ubicación y contactos<small>Mensajes variados, no solo texto</small></span>${sw('warmup-media-t', st.media)}</div>
		<div class="item"><span class="grow">Estados<small>Cada número publica un estado cada 2–4 días. Solo lo ven tus números vinculados, nunca tus contactos ni clientes</small></span>${sw('warmup-stories', st.stories)}</div>
		<div class="item"><span class="grow">Grupo entre tus números<small>${st.group ? `«${esc(st.group.subject)}» · ${st.group.members} números` : 'Se crea solo cuando hay 3 números con 2+ días'}</small></span>${sw('warmup-groups', st.groups)}</div>
		<div class="item"><span class="grow">Estado</span>${state}</div>
		${st.enabled && st.eligible >= 2 ? `
		<div class="item"><span class="grow">Hoy<small>${p.sentToday || 0} de ${p.totalPerDay || 0} mensajes · queda ${p.dayLeft ?? 0}% de la actividad del día</small>${bar(p.sentToday || 0, p.totalPerDay || 0)}</span></div>
		<div class="item"><span class="grow">Actividad en este momento</span><span class="muted">${act[p.activity] || '—'}</span></div>
		<div class="item"><span class="grow">Próxima charla</span><span class="muted">${p.nextConvoIn == null ? '—' : p.nextConvoIn < 1 ? 'en un momento' : p.nextConvoIn >= 90 ? `en ~${Math.round(p.nextConvoIn / 60)} h` : `en ~${p.nextConvoIn} min`}${p.activeConvos ? ` · ${p.activeConvos} en curso` : ''}</span></div>
		${chart}
		<button class="btn" data-act="warmup-now">Iniciar una charla ahora</button>` : ''}
		${nums ? `<div class="item sub-head"><span class="grow">Números</span></div>${nums}` : ''}
		${libHtml}
		<div class="item sub-head"><span class="grow">Guiones propios${st.customCount ? ` · ${st.customCount}` : ''}</span></div>
		<div class="item"><span class="grow muted" style="font-size:13px">Una línea por mensaje (se alternan los dos números); deja una línea en blanco entre charlas. Usa {opción1|opción2} para variar.</span></div>
		<div class="item"><textarea id="wu-scripts" rows="6" placeholder="¿Ya llegó el pedido?\nSí, hace rato {👍|}\nPerfecto, gracias\n\n¿Vas a ir al gym hoy?\n{Sí|No creo}, ¿y tú?"></textarea></div>
		<button class="btn" data-act="warmup-scripts-save">Guardar guiones</button>`
	const ta = $('#wu-scripts')
	if (ta && S.warmupScripts != null) ta.value = S.warmupScripts
	else api('GET', '/warmup/scripts').then(r => { S.warmupScripts = r.text || ''; const t = $('#wu-scripts'); if (t && !t.value) t.value = S.warmupScripts }).catch(() => {})
	if (ta) ta.oninput = () => { S.warmupScripts = ta.value }
	const fileIn = $('#wu-media')
	if (fileIn) fileIn.onchange = async () => {
		const files = [...fileIn.files]
		let last = null
		for (const f of files) {
			const fd = new FormData()
			fd.append('file', f)
			try { last = await api('POST', '/warmup/media', fd, true) } catch (err) { toast(err.message) }
		}
		if (last) { renderWarmupBox(last); toast(files.length > 1 ? `${files.length} archivos subidos` : 'Archivo subido') }
	}
	clearTimeout(S.warmupTimer)
	// Se actualiza solo (sin pisar lo que estés escribiendo en los guiones)
	if (st.enabled) S.warmupTimer = setTimeout(() => { const t = $('#wu-scripts'); if ($('#warmup-box') && document.activeElement !== t) loadWarmup() }, 30000)
}
function warmupBody() {
	const v = id => { const el = $(id); return el && el.value !== '' ? Number(el.value) : undefined }
	const b = { perDay: v('#wu-perday'), startHour: v('#wu-start'), endHour: v('#wu-end'), minDelay: v('#wu-min'), maxDelay: v('#wu-max') }
	for (const k of Object.keys(b)) if (b[k] === undefined || Number.isNaN(b[k])) delete b[k]
	return b
}

function b64ToUint8(b64) {
	const pad = '='.repeat((4 - (b64.length % 4)) % 4)
	const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
	return Uint8Array.from(raw, c => c.charCodeAt(0))
}

async function enablePush() {
	if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
		return toast('Para recibir notificaciones en iPhone, añade la app a la pantalla de inicio y ábrela desde ahí.', 6000)
	}
	const perm = await Notification.requestPermission()
	if (perm !== 'granted') return toast('Notificaciones no permitidas. Actívalas en Ajustes del iPhone › Notificaciones › MultiWA.', 6000)
	try {
		const reg = await navigator.serviceWorker.ready
		const { key } = await api('GET', '/push/key')
		let sub = await reg.pushManager.getSubscription()
		if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) })
		await api('POST', '/push/subscribe', sub.toJSON())
		toast('Notificaciones activadas ✅')
		render()
	} catch (e) { toast('No se pudo activar: ' + e.message) }
}

// ---------- Hojas modales ----------
function sheet(title, html, bind) {
	closeSheet()
	const bg = document.createElement('div')
	bg.className = 'sheet-bg'
	bg.id = 'sheet'
	bg.innerHTML = `<div class="sheet"><div class="grabber"></div><header class="sheet-bar"><span></span><h1>${esc(title)}</h1><button class="link" data-act="close-sheet">Listo</button></header><div class="sheet-body">${html}</div></div>`
	bg.addEventListener('click', e => { if (e.target === bg) closeSheet() })
	document.body.appendChild(bg)
	bind?.(bg)
}
function closeSheet() { $('#sheet')?.remove() }

// ---------- Corrección de texto antes de enviar ----------
async function aiReview(text) {
	const key = S.active
	sheet('Revisar mensaje', `<div id="ai-box" class="ai-box"><div class="ai-loading">${IC.sparkle}<span>Revisando…</span></div></div>`)
	let r
	try {
		r = await api('POST', '/ai/rewrite', { text, accountId: accOf(key), jid: jidOf(key) })
	} catch (e) {
		const box = $('#ai-box'); if (!box) return
		box.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(e.message)}</p>
			<div class="group"><button class="btn primary" data-act="ai-pick" data-val="original">Enviar sin corregir</button></div>`
		S.aiOpts = { original: text, key }
		return
	}
	const box = $('#ai-box')
	if (!box || S.active !== key) return
	S.aiOpts = { ...r, key }
	const opt = (id, title, body, checked) => `<label class="ai-opt"><input type="radio" name="ai-opt" value="${id}"${checked ? ' checked' : ''}><span><b>${title}</b><span class="ai-text">${esc(body)}</span></span></label>`
	const same = r.corregido === r.original
	box.innerHTML = `
		${same ? '<p class="hint">✅ No se encontraron errores de ortografía.</p>' : ''}
		<div class="group">
			${opt('corregido', 'Ortografía corregida', r.corregido, true)}
			${r.mejorado !== r.corregido ? opt('mejorado', 'Respuesta mejorada', r.mejorado) : ''}
			${same ? '' : opt('original', 'Original', r.original)}
		</div>
		<div class="group"><button class="btn primary" data-act="ai-send">Enviar</button><button class="btn" data-act="ai-edit">Editar antes de enviar</button></div>`
}

// Menú de acciones que sube desde abajo (como el de iOS)
function actionSheet(title, actions) {
	closeSheet()
	const bg = document.createElement('div')
	bg.className = 'sheet-bg action'
	bg.id = 'sheet'
	bg.innerHTML = `<div class="actions">
		<div class="as-group">${title ? `<div class="as-title">${esc(title)}</div>` : ''}${actions.map(a => `<button class="as-btn ${a.danger ? 'danger' : ''}" data-act="${a.act}"${a.val != null ? ` data-val="${esc(a.val)}"` : ''}><span>${esc(a.text)}</span>${a.icon || ''}</button>`).join('')}</div>
		<div class="as-group"><button class="as-btn cancel" data-act="close-sheet">Cancelar</button></div>
	</div>`
	bg.addEventListener('click', e => { if (e.target === bg) closeSheet() })
	document.body.appendChild(bg)
}

// ---------- Eventos ----------
document.addEventListener('click', async e => {
	const el = e.target.closest('[data-act]')
	if (!el) return
	const act = el.dataset.act
	const val = el.dataset.val
	if (el.classList.contains('as-btn')) closeSheet()
	switch (act) {
		case 'msg-copy': {
			const m = S.menuMsg; if (!m?.text) return
			try { await navigator.clipboard.writeText(m.text); toast('Copiado') } catch { toast('No se pudo copiar') }
			return
		}
		case 'msg-edit': return S.menuMsg && openEditMsg(S.menuMsg)
		case 'msg-delete': {
			const m = S.menuMsg; if (!m) return
			if (!confirm('¿Eliminar este mensaje para todos? El cliente verá «Se eliminó este mensaje».')) return
			try { insertMsg(await api('POST', `/messages/${m.accountId}/${enc(m.id)}/delete`)); renderMessages(false); toast('Mensaje eliminado') } catch (err) { toast(err.message, 6000) }
			return
		}
		case 'pf-photo': return $('#pf-file')?.click()
		case 'pf-save': {
			const id = Number(val)
			const btn = el; btn.disabled = true
			try { renderProfile(id, await api('PUT', `/accounts/${id}/profile`, { name: $('#pf-name').value, status: $('#pf-status').value })); toast('Perfil actualizado ✅') }
			catch (err) { toast(err.message, 6000) } finally { btn.disabled = false }
			return
		}
		case 'pf-photo-del': {
			const id = Number(val)
			if (!confirm('¿Quitar la foto de perfil de este número?')) return
			try { renderProfile(id, await api('DELETE', `/accounts/${id}/profile/photo`)); toast('Foto quitada') } catch (err) { toast(err.message, 6000) }
			return
		}
		case 'contact-info': return openContactInfo()
		case 'ci-copy': { try { await navigator.clipboard.writeText('+' + val); toast('Número copiado') } catch { toast('+' + val) } return }
		case 'ci-mute': {
			try { const c = await api('PUT', `/conversations/${enc(S.active)}/mute`, { muted: el.checked }); if (c) upsertConv(c); toast(el.checked ? 'Notificaciones silenciadas 🔕' : 'Notificaciones activadas 🔔') } catch (err) { toast(err.message); el.checked = !el.checked }
			return
		}
		case 'ci-optout': {
			try { await api('PUT', `/conversations/${enc(S.active)}/optout`, { optedOut: el.checked }); toast(el.checked ? 'Ya no recibirá envíos masivos' : 'Volverá a recibir envíos masivos') } catch (err) { toast(err.message); el.checked = !el.checked }
			return
		}
		case 'ci-media': {
			const [id, type] = val.split('|')
			const url = mediaURL({ accountId: accOf(S.active), id, type })
			if (type === 'image') {
				const v = document.createElement('div'); v.className = 'viewer'
				v.innerHTML = `<img src="${url}" alt=""><button aria-label="Cerrar">✕</button>`
				v.onclick = () => v.remove(); return document.body.appendChild(v)
			}
			return window.open(url, '_blank')
		}
		case 'chat-menu': {
			const c = conv(S.active)
			return actionSheet(c ? convName(c) : '', [
				{ act: 'contact-info', text: 'Info. del contacto', icon: IC.user },
				{ act: 'note', text: c?.note ? 'Editar nota' : 'Agregar nota', icon: IC.note },
				{ act: 'reminder', text: 'Recordatorio', icon: IC.clock },
				{ act: 'labels', text: 'Etiquetas', icon: IC.tag },
				{ act: 'archive-conv', text: c?.archived ? 'Desarchivar chat' : 'Archivar chat', icon: c?.archived ? IC.unarchive : IC.archive },
				{ act: 'delete-conv', text: 'Eliminar chat', icon: IC.trash, danger: true }
			])
		}
		case 'go': return go(val)
		case 'back': return history.length > 1 ? history.back() : go('#/')
		case 'f-all': { const wasArch = S.filter.archived; S.filter.account = null; S.filter.label = null; S.filter.unread = false; S.filter.waiting = false; S.filter.reminders = false; S.filter.archived = false; return wasArch ? loadConvList() : renderInbox(false) }
		case 'f-archived': S.filter.archived = !S.filter.archived; S.filter.unread = false; S.filter.waiting = false; S.filter.reminders = false; return loadConvList()
		case 'archive-conv': {
			const c = conv(S.active); if (!c) return
			try { await api('POST', `/conversations/${enc(c.key)}/archive`, { archived: !c.archived }); toast(c.archived ? 'Desarchivada' : 'Archivada 🗄️'); S.convs = S.convs.filter(x => x.key !== c.key); go('#/') } catch (err) { toast(err.message) }
			return
		}
		case 'delete-conv': {
			const c = conv(S.active); if (!c) return
			if (!confirm('¿Eliminar esta conversación y sus mensajes? No se puede deshacer.')) return
			try { await api('DELETE', `/conversations/${enc(c.key)}`); S.convs = S.convs.filter(x => x.key !== c.key); toast('Conversación eliminada'); go('#/') } catch (err) { toast(err.message) }
			return
		}
		case 'f-waiting': S.filter.waiting = !S.filter.waiting; if (S.filter.waiting) S.filter.reminders = false; return renderInbox(false)
		case 'f-reminders': S.filter.reminders = !S.filter.reminders; if (S.filter.reminders) S.filter.waiting = false; return renderInbox(false)
		case 'f-unread': S.filter.unread = !S.filter.unread; return renderInbox(false)
		case 'f-account': S.filter.account = S.filter.account === Number(val) ? null : Number(val); return renderInbox(false)
		case 'f-label': S.filter.label = S.filter.label === Number(val) ? null : Number(val); return renderInbox(false)
		case 'new-chat': return openNewChat()
		case 'close-sheet': return closeSheet()
		case 'labels': return openLabelsSheet()
		case 'note': return openNote()
		case 'reminder': return openReminder()
		case 'rem-del': {
			try {
				const updated = await api('DELETE', `/reminders/${val}`)
				if (updated?.key) upsertConv(updated)
				closeSheet()
				renderChatHeader()
			} catch (err) { toast(err.message) }
			return
		}
		case 'qr-pick': {
			const r = S.replies.find(x => x.id === Number(val))
			const ta = $('#text')
			if (r && ta) {
				ta.value = fillReply(r.text)
				ta.dispatchEvent(new Event('input'))
				ta.focus()
			}
			return
		}
		case 'add-reply': {
			const title = $('#qr-title').value.trim()
			const text = $('#qr-text').value.trim()
			if (!title || !text) return toast('Escribe el nombre y el texto')
			try {
				S.replies.push(await api('POST', '/quick-replies', { title, text }))
				S.replies.sort((a, b) => a.title.localeCompare(b.title))
				renderSettings()
			} catch (err) { toast(err.message) }
			return
		}
		case 'del-reply': {
			if (!confirm('¿Borrar esta respuesta rápida?')) return
			await api('DELETE', `/quick-replies/${val}`).catch(err => toast(err.message))
			S.replies = S.replies.filter(r => r.id !== Number(val))
			return renderSettings()
		}
		case 'attach': return $('#file').click()
		case 'send': return $('#text').value.trim() ? sendText() : startRecording()
		case 'sg-use': {
			const list = S.msgs[S.active] || []
			const last = list[list.length - 1]
			const ta = $('#text')
			if (!last?.suggestion || !ta) return
			ta.value = last.suggestion
			ta.dispatchEvent(new Event('input'))
			ta.focus()
			return
		}
		case 'ai-fix': { const v = $('#text')?.value.trim(); if (v) aiReview(v); return }
		case 'ai-send': case 'ai-edit': case 'ai-pick': {
			const o = S.aiOpts; if (!o) return
			const choice = act === 'ai-pick' ? val : ($('input[name="ai-opt"]:checked')?.value || 'corregido')
			const text = o[choice] || o.original
			closeSheet()
			if (o.key !== S.active) return
			if (act === 'ai-edit') { const ta = $('#text'); ta.value = text; ta.dispatchEvent(new Event('input')); ta.focus(); return }
			return sendText(text, true)
		}
		case 'ai-review-toggle': {
			try { S.ai = await api('PUT', '/settings/ai', { review: el.checked }); toast(S.ai.review ? 'Revisión antes de enviar activada' : 'Revisión antes de enviar desactivada') } catch (e) { toast(e.message); el.checked = !el.checked }
			return
		}
		case 'rec-send': return stopRecording(true)
		case 'rec-cancel': return stopRecording(false)
		case 'older': {
			renderMessages.keepOffset = true
			await loadMessages(S.active, true).catch(err => toast(err.message))
			return renderMessages(false)
		}
		case 'view-img': {
			const v = document.createElement('div')
			v.className = 'viewer'
			v.innerHTML = `<img src="${el.src}" alt=""><button aria-label="Cerrar">✕</button>`
			v.onclick = () => v.remove()
			return document.body.appendChild(v)
		}
		case 'add-account': return openAddAccount()
		case 'tpl-chat': e.preventDefault(); return openTemplateChat()
		case 'new-campaign': return openNewCampaign()
		case 'new-safe': return openNewSafeCampaign()
		case 'new-cloud': return openNewCloudCampaign()
		case 'camp': {
			const [id, action] = val.split(':')
			if (action === 'cancel' && !confirm('¿Cancelar este envío? Los pendientes ya no se mandarán.')) return
			try {
				const c = await api('POST', `/campaigns/${id}/${action}`)
				S.campaigns = S.campaigns.map(x => x.id === c.id ? c : x)
				renderCampaignList()
			} catch (err) { toast(err.message) }
			return
		}
		case 'camp-failed': return showFailed(Number(val))
		case 'camp-force': {
			const c = S.campaigns.find(x => x.id === Number(val)); if (!c) return
			if (!c.forced && !confirm('⚡ Enviar ya: este envío ignorará los topes diarios y por hora de tus números (y los días de descanso) para terminar los recordatorios. Sube el riesgo de restricción. ¿Continuar?')) return
			try {
				let upd = await api('POST', `/campaigns/${c.id}/force`, { forced: !c.forced })
				if (!c.forced && upd.status === 'paused') upd = await api('POST', `/campaigns/${c.id}/resume`)
				S.campaigns = S.campaigns.map(x => x.id === upd.id ? upd : x)
				renderCampaignList()
				toast(upd.forced ? '⚡ Enviando sin límites (con pausas entre mensajes)' : 'Volvió a los límites normales')
			} catch (err) { toast(err.message) }
			return
		}
		case 'rest': {
			const id = Number(route().arg)
			const days = Number(val)
			if (days && !confirm(`Este número no se usará en envíos masivos durante ${days} días. ¿Continuar?`)) return
			try {
				Object.assign(account(id), await api('POST', `/accounts/${id}/rest`, { days }))
				render()
			} catch (err) { toast(err.message) }
			return
		}
		case 'rest-day': {
			const d = Number(val)
			S.restDays = S.restDays.includes(d) ? S.restDays.filter(x => x !== d) : [...S.restDays, d]
			try { S.restDays = await api('PUT', '/settings/rest-days', { days: S.restDays }) } catch (err) { toast(err.message) }
			document.querySelectorAll('[data-act=rest-day]').forEach(b => b.classList.toggle('on', S.restDays.includes(Number(b.dataset.val))))
			return
		}
		case 'stats-days': {
			S.statsDays = Number(val)
			document.querySelectorAll('[data-act=stats-days]').forEach(b => b.classList.toggle('on', Number(b.dataset.val) === S.statsDays))
			return loadStats()
		}
		case 'cl-save': case 'tpl-refresh': case 'tpl-create':
			e.preventDefault()
			return accountAction(act)
		case 'ac-save': case 'ac-connect': case 'ac-logout': case 'ac-delete': case 'ac-pair':
			return accountAction(act)
		case 'warmup-toggle': {
			try { renderWarmupBox(await api('POST', '/warmup', { ...warmupBody(), enabled: !(S.warmup?.enabled) })) }
			catch (err) { toast(err.message) }
			return
		}
		case 'smart-toggle': {
			try { const r = await api('PUT', '/settings/smart', { enabled: el.checked }); toast(r.enabled ? 'Asistente activado' : 'Asistente desactivado') }
			catch (err) { toast(err.message) }
			return
		}
		case 'warmup-allday': {
			try { renderWarmupBox(await api('POST', '/warmup', { ...warmupBody(), enabled: S.warmup?.enabled, allDay: !(S.warmup?.allDay) })) }
			catch (err) { toast(err.message) }
			return
		}
		case 'warmup-auto': {
			try { renderWarmupBox(await api('POST', '/warmup', { ...warmupBody(), enabled: S.warmup?.enabled, auto: !(S.warmup?.auto) })) }
			catch (err) { toast(err.message) }
			return
		}
		case 'warmup-intensity': {
			try { renderWarmupBox(await api('POST', '/warmup', { enabled: S.warmup?.enabled, intensity: val })) }
			catch (err) { toast(err.message) }
			return
		}
		case 'warmup-media-t': case 'warmup-stories': case 'warmup-groups': {
			const key = { 'warmup-media-t': 'media', 'warmup-stories': 'stories', 'warmup-groups': 'groups' }[act]
			try { renderWarmupBox(await api('POST', '/warmup', { enabled: S.warmup?.enabled, [key]: !(S.warmup?.[key]) })) }
			catch (err) { toast(err.message) }
			return
		}
		case 'warmup-unflag': {
			try { renderWarmupBox(await api('POST', `/warmup/unflag/${val}`)); toast('Reanudado') }
			catch (err) { toast(err.message) }
			return
		}
		case 'warmup-media-del': {
			try { renderWarmupBox(await api('DELETE', `/warmup/media/${enc(val)}`)) }
			catch (err) { toast(err.message) }
			return
		}
		case 'warmup-scripts-save': {
			const text = $('#wu-scripts')?.value || ''
			try { const r = await api('PUT', '/warmup/scripts', { text }); S.warmupScripts = r.text; toast(`${r.count} guion(es) guardado(s)`); loadWarmup() }
			catch (err) { toast(err.message) }
			return
		}
		case 'warmup-now': {
			try { renderWarmupBox(await api('POST', '/warmup/now')); toast('Empezando una charla…') }
			catch (err) { toast(err.message) }
			return
		}
		case 'warmup-save': {
			try { renderWarmupBox(await api('POST', '/warmup', { ...warmupBody(), enabled: S.warmup?.enabled })); toast('Guardado') }
			catch (err) { toast(err.message) }
			return
		}
		case 'push': return enablePush()
		case 'add-label': {
			const name = $('#nl-name').value.trim()
			if (!name) return toast('Escribe un nombre para la etiqueta')
			try {
				S.labels.push(await api('POST', '/labels', { name, color: $('#view').dataset.labelColor }))
				S.labels.sort((a, b) => a.name.localeCompare(b.name))
				$('#nl-name').value = ''
				renderSettings()
			} catch (err) { toast(err.message) }
			return
		}
		case 'del-label': {
			const id = Number(val)
			if (!confirm('¿Borrar esta etiqueta?')) return
			await api('DELETE', `/labels/${id}`).catch(err => toast(err.message))
			S.labels = S.labels.filter(l => l.id !== id)
			S.convs.forEach(c => { c.labelIds = c.labelIds.filter(x => x !== id) })
			if (S.filter.label === id) S.filter.label = null
			return renderSettings()
		}
		case 'change-pw': {
			const pw = prompt('Nueva contraseña (mínimo 6 caracteres):')
			if (!pw) return
			try { await api('POST', '/password', { password: pw }); toast('Contraseña cambiada') } catch (err) { toast(err.message) }
			return
		}
		case 'logout': return confirm('¿Salir de MultiWA en este dispositivo?') && logout()
	}
})

document.addEventListener('keydown', e => {
	// En computadora: Enter envía y Shift+Enter hace salto de línea
	if (e.target.id === 'text' && e.key === 'Enter' && !e.shiftKey && !/iPhone|iPad|Android/.test(navigator.userAgent)) {
		e.preventDefault()
		sendText()
	}
})

window.addEventListener('hashchange', () => { if ($('#sheet')) closeSheet(); render() })

document.addEventListener('visibilitychange', () => {
	// iOS suspende la conexión en segundo plano: al volver se resincroniza
	if (document.visibilityState === 'visible' && S.token) {
		if (!S.ws || S.ws.readyState !== 1) resync()
		else if (S.active) markRead(S.active)
	}
})

navigator.serviceWorker?.addEventListener('message', e => {
	if (e.data?.type === 'open' && e.data.url) location.href = e.data.url
	else if (e.data?.type === 'open' && e.data.jid) go('#/chat/' + enc(e.data.jid))
})

async function boot() {
	if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
	if (!S.token) return showLogin()
	try {
		await loadAll()
	} catch (e) {
		if (!S.token) return
		$('#app').innerHTML = `<div class="empty"><div class="big">⚠️</div>No se pudo conectar con el servidor.<br><br><button class="btn primary" onclick="location.reload()">Reintentar</button></div>`
		return
	}
	lastRoute = ''
	render()
	connectWS()
}

boot()
