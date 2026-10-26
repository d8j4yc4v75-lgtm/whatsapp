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
	filter: { account: null, label: null, unread: false, waiting: false, reminders: false, q: '' },
	replies: [],
	statsDays: 7,
	restDays: [0],
	wsOk: false,
	ws: null,
	active: null,
	recorder: null
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
const convName = c => c?.name || (c?.isGroup ? 'Grupo' : c?.phone ? '+' + c.phone : c?.jid || '')
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
const healthDot = a => a?.health ? HEALTH[a.health.level][0] : ''

function accountTag(id) {
	const a = account(id)
	return `<span class="tag" style="--c:${esc(a?.color || '#8E8E93')}">${esc(a?.name || '?')}</span>`
}

function updateBadge() {
	const n = totalUnread()
	if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {})
	const b = $('#tab-badge')
	if (b) { b.textContent = n; b.hidden = !n }
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
	const i = S.convs.findIndex(x => x.lastTs < c.lastTs)
	S.convs.splice(i < 0 ? S.convs.length : i, 0, c)
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
		case 'conversations.changed':
			api('GET', '/conversations').then(c => { S.convs = c; updateBadge(); render() }).catch(() => {})
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
		`<a href="${href}" class="${active === name || (name === 'accounts' && active === 'account') ? 'active' : ''}"><span>${icon}</span>${text}${name === 'inbox' ? '<i class="badge" id="tab-badge" hidden></i>' : ''}</a>`
	const sends = S.accounts.length ? t('campaigns', '📤', 'Envíos', '#/campaigns') : ''
	return `<nav class="tabs">${t('inbox', '💬', 'Bandeja', '#/')}${sends}${t('accounts', '📱', 'Cuentas', '#/accounts')}${t('settings', '⚙️', 'Ajustes', '#/settings')}</nav>`
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
			<header class="bar"><i class="dot ${S.wsOk ? 'on' : ''}" id="ws-dot" title="Conexión con el servidor"></i><h1>Bandeja</h1>
				<button class="icon-btn" data-act="new-chat" aria-label="Nuevo chat">✏️</button></header>
			${!isStandalone() && /iPhone|iPad/.test(navigator.userAgent) ? `<div class="install"><b>Instala la app</b>Toca <b style="display:inline">Compartir ⬆︎</b> y luego <b style="display:inline">«Añadir a pantalla de inicio»</b>. Así se abre como app y recibe notificaciones.</div>` : ''}
			<div class="search"><input id="q" type="search" placeholder="Buscar nombre, número o mensaje" value="${esc(S.filter.q)}"></div>
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
		chip('f-unread', '', 'No leídos', f.unread),
		chip('f-waiting', '', `Sin responder${S.convs.filter(c => !c.lastFromMe && !c.isGroup && c.lastTs).length ? ' (' + S.convs.filter(c => !c.lastFromMe && !c.isGroup && c.lastTs).length + ')' : ''}`, f.waiting, '#E5484D'),
		chip('f-reminders', '', `⏰ Recordatorios${S.convs.filter(c => c.reminder).length ? ' (' + S.convs.filter(c => c.reminder).length + ')' : ''}`, f.reminders, '#7C5CFF'),
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
			<div class="avatar" style="background:${avatarColor(c.jid)}">${c.isGroup ? '👥' : esc(initials(convName(c)))}</div>
			<div class="body">
				<div class="top"><span class="name">${esc(convName(c))}</span><span class="time ${c.unread ? 'unread' : ''}">${c.lastTs ? timeLabel(c.lastTs) : ''}</span></div>
				<div class="bottom"><span class="preview">${c.lastFromMe ? 'Tú: ' : ''}${esc(c.lastText)}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
				<div class="tags">${accountTag(c.accountId)}${c.labelIds.map(label).filter(Boolean).map(l => `<span class="tag solid" style="--c:${esc(l.color)}">${esc(l.name)}</span>`).join('')}${c.reminder ? `<span class="tag" style="--c:#7C5CFF">⏰ ${esc(reminderLabel(c.reminder.at))}</span>` : ''}${c.note ? '<span class="tag" style="--c:#B7791F">📝 Nota</span>' : ''}${S.filter.waiting ? `<span class="tag" style="--c:#E5484D">${waitingLabel(c.lastTs)}</span>` : ''}</div>
			</div>
		</a></li>`).join('')
}

// ---------- Chat ----------
async function renderChat(jid, full) {
	if (full) {
		S.active = jid
		$('#app').innerHTML = `
			<header class="bar">
				<button class="icon-btn" data-act="back" aria-label="Atrás">‹</button>
				<div class="title"><b id="c-title"></b><small id="c-sub"></small></div>
				<button class="icon-btn" data-act="note" aria-label="Nota">📝</button>
				<button class="icon-btn" data-act="reminder" aria-label="Recordatorio">⏰</button>
				<button class="icon-btn" data-act="labels" aria-label="Etiquetas">🏷️</button>
			</header>
			<div id="c-banners"></div>
			<div class="msgs" id="msgs"><div class="empty">Cargando…</div></div>
			<footer class="composer">
				<div class="qr-pop" id="qr-pop" hidden></div>
				<div class="from">Enviando desde <span id="from"></span></div>
				<div class="hint24" id="hint24" hidden>Pasaron más de 24 h desde el último mensaje del cliente: solo puedes enviar una <a href="#" data-act="tpl-chat">plantilla 📋</a>.</div>
				<div class="compose-row" id="compose-row"></div>
				<input type="file" id="file" hidden>
			</footer>`
		renderComposer()
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
	$('#c-title').textContent = c ? convName(c) : '+' + jidOf(S.active).split('@')[0]
	const parts = []
	if (c?.phone && c.name) parts.push('+' + c.phone)
	if (c?.labelIds.length) parts.push(c.labelIds.map(label).filter(Boolean).map(l => l.name).join(', '))
	$('#c-sub').textContent = parts.join(' · ')
	const banners = $('#c-banners')
	if (banners) {
		const html = (c?.note ? `<div class="banner note" data-act="note">📝 ${esc(c.note)}</div>` : '')
			+ (c?.reminder ? `<div class="banner reminder" data-act="reminder">⏰ ${esc(reminderLabel(c.reminder.at))}${c.reminder.text ? ' · ' + esc(c.reminder.text) : ''}</div>` : '')
		if (banners.innerHTML !== html) banners.innerHTML = html
	}
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
		${list.length ? `<div class="section">Pendientes</div><div class="group">${list.map(r => `<div class="item"><span class="grow">⏰ ${esc(reminderLabel(r.at))}<small>${esc(r.text || '')}</small></span><button class="icon-btn" data-act="rem-del" data-val="${r.id}" aria-label="Borrar">🗑️</button></div>`).join('')}</div>` : ''}
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
	el.innerHTML = `${accountTag(accOf(S.active))}${a?.phone ? ' <small>+' + esc(a.phone) + '</small>' : ''}${a && a.status !== 'connected' ? ` <b style="color:var(--danger)">· ${statusText(a)}</b>` : ''}`
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
			<button class="round ghost" data-act="rec-cancel" aria-label="Cancelar">🗑️</button>
			<div class="recording"><span style="color:var(--danger)">●</span><span id="rec-time">0:00</span></div>
			<button class="round rec" data-act="rec-send" aria-label="Enviar nota de voz">➤</button>`
		return
	}
	const prev = $('#text')?.value || ''
	const isCloud = account(accOf(S.active))?.kind === 'cloud'
	row.innerHTML = `
		<button class="round ghost" data-act="attach" aria-label="Adjuntar">＋</button>
		${isCloud ? '<button class="round ghost" data-act="tpl-chat" aria-label="Plantilla" style="font-size:22px">📋</button>' : ''}
		<textarea id="text" rows="1" placeholder="Mensaje (escribe / para respuestas rápidas)"></textarea>
		<button class="round" id="send-btn" data-act="send" aria-label="Enviar">🎤</button>`
	const ta = $('#text')
	ta.value = prev
	const sync = () => {
		ta.style.height = 'auto'
		ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'
		$('#send-btn').textContent = ta.value.trim() ? '➤' : '🎤'
	}
	ta.oninput = () => { sync(); renderQuickReplies() }
	sync()
}

function msgContent(m) {
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
			return `<a class="doc" href="${mediaURL(m)}" target="_blank" rel="noopener">📄 <span>${esc(m.fileName || 'Documento')}</span></a>${cap}`
		default:
			return `<div class="text">${linkify(m.text || '')}</div>`
	}
}

function ticks(status) {
	if (status === 0) return '<span style="color:var(--danger)">⚠︎ No enviado</span>'
	if (status === 1) return '🕓'
	if (status === 2) return '✓'
	if (status === 3) return '✓✓'
	return '<span class="read">✓✓</span>'
}

function messageItems() {
	const list = S.msgs[S.active]
	const isGroup = conv(S.active)?.isGroup
	const items = []
	if (S.more[S.active]) items.push({ key: 'older', html: '<button class="chip more" data-act="older">Cargar mensajes anteriores</button>' })
	if (!list.length) items.push({ key: 'empty', html: '<div class="empty">Escribe el primer mensaje 👋</div>' })
	let lastDay = ''
	for (const m of list) {
		const d = new Date(m.ts)
		const day = d.toDateString()
		if (day !== lastDay) {
			lastDay = day
			items.push({ key: 'day:' + day, html: `<div class="day">${d.toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div>` })
		}
		const a = account(m.accountId)
		const time = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
		items.push({
			key: m.accountId + ':' + m.id,
			meta: `${time} ${m.fromMe ? ticks(m.status) : ''}`,
			html: `<div class="msg ${m.fromMe ? 'me' : ''}" style="--c:${esc(a?.color || '#8E8E93')}">
				<div class="head">${accountTag(m.accountId)}${isGroup && !m.fromMe ? `<span class="sender">${esc(m.senderName || (m.sender || '').split('@')[0])}</span>` : ''}</div>
				${msgContent(m)}
				${m.fromMe && m.error ? `<div class="err">⚠︎ ${esc(m.error)}</div>` : ''}
				<div class="meta"></div>
			</div>`
		})
	}
	return items
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

async function sendText() {
	const ta = $('#text')
	const text = ta.value.trim()
	const from = defaultFrom(S.active)
	if (!text || !from) return
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
			<header class="bar"><h1>Envíos</h1><button class="icon-btn" data-act="new-campaign" aria-label="Nuevo envío">＋</button></header>
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
			: c.note === 'limit-safe' ? 'Esperando: los números ya enviaron su máximo de hoy. Sigue mañana sola.'
			: c.note || ''
		const tags = safe
			? c.accountIds.map(id => c.disabledIds.includes(id) ? `<span style="opacity:.4;text-decoration:line-through">${accountTag(id)}</span>` : accountTag(id)).join('')
			: accountTag(c.accountId)
		const info = safe
			? `Modo seguro · ${c.autoRamp ? 'sube poco a poco hasta ' : ''}${c.dailyPerNumber} por número al día · ${c.hourlyPerNumber || 8} por hora · pausas de ${Math.round(c.minDelay / 60)}–${Math.round(c.maxDelay / 60)} min · ${c.startHour}:00–${c.endHour}:00`
			: `Plantilla ${esc(c.template)} · ${c.perHour}/hora · ${c.startHour}:00–${c.endHour}:00`
		return `<div class="item" style="display:block">
			<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b class="grow">${esc(c.name)}</b>${tags}<span class="status" style="color:${color}">${st}</span></div>
			<small>${info}</small>
			<div class="bar-progress"><i style="width:${pct}%"></i></div>
			<small>✅ ${n.sent} enviados · 👀 ${n.read} leídos · 💬 ${n.replied} respondieron · ⚠︎ ${n.failed} fallidos · ⏳ ${n.pending} pendientes${n.skipped ? ` · 🚫 ${n.skipped} con BAJA` : ''}</small>
			${why ? `<small style="color:${waiting ? 'var(--muted)' : 'var(--danger)'}">${esc(why)}</small>` : ''}
			<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
				${c.status === 'running' ? `<button class="chip" data-act="camp" data-val="${c.id}:pause">Pausar</button>` : ''}
				${c.status === 'paused' ? `<button class="chip" data-act="camp" data-val="${c.id}:resume">Reanudar</button>` : ''}
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
		<div class="section">Números que van a enviar</div>
		<div class="group">${normal.map(a => `<label class="item"><input type="checkbox" class="sf-acc" value="${a.id}" ${a.status !== 'connected' ? 'disabled' : a.reserve ? '' : 'checked'}><span class="grow">${accountTag(a.id)} ${a.phone ? '+' + esc(a.phone) : ''}${a.reserve ? ' <b style="color:#7C5CFF">· reserva</b>' : ''}${a.health && a.status === 'connected' ? `<small>${healthDot(a)} ${esc(a.health.reason)} · hoy hasta ${a.health.suggestedDaily}</small>` : ''}</span><small style="display:inline;color:${statusColor(a)}">${statusText(a)}</small></label>`).join('')}</div>
		<p class="hint">La lista se reparte entre los números marcados. Los números de <b>reserva</b> entran solos si uno de los marcados se restringe, descansa o se desconecta.</p>
		<div class="section">Mensaje</div>
		<div class="group"><div class="item"><textarea id="sf-msg" rows="5" placeholder="Hola {{1}}, te escribo por tu saldo pendiente de \${{2}}. ¿Te puedo compartir opciones para ponerte al corriente? Si no deseas recibir mensajes, responde BAJA."></textarea></div></div>
		<div id="sf-review"></div>
		<p class="hint">{{1}} es la 2.ª columna de tu lista (por ejemplo el nombre), {{2}} la 3.ª (el monto), y así. Mensajes cortos, amables y con el nombre de la persona se bloquean menos.</p>
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
			<div class="item"><span class="grow">Máximo por número al día</span><input type="number" id="sf-daily" value="30" min="1" max="200" style="text-align:right;max-width:80px"></div>
			<div class="item"><span class="grow">Máximo por número por hora</span><input type="number" id="sf-hourly" value="8" min="1" max="60" style="text-align:right;max-width:80px"></div>
			<div class="item"><span class="grow">Pausa mínima (minutos)</span><input type="number" id="sf-min" value="2" min="1" max="60" style="text-align:right;max-width:80px"></div>
			<div class="item"><span class="grow">Pausa máxima (minutos)</span><input type="number" id="sf-max" value="5" min="1" max="120" style="text-align:right;max-width:80px"></div>
			<div class="item"><span class="grow">Desde (hora)</span><input type="number" id="sf-start" value="9" min="0" max="23" style="text-align:right;max-width:80px"></div>
			<div class="item"><span class="grow">Hasta (hora)</span><input type="number" id="sf-end" value="19" min="1" max="24" style="text-align:right;max-width:80px"></div>
		</div>
		<p class="hint">Recomendado: 20–30 por número al día, máximo 8 por hora y pausas de 2 a 5 minutos. Más rápido aumenta el riesgo de que WhatsApp restrinja el número.</p>
		<div class="pad"><button class="btn primary" id="sf-go">Iniciar envío</button></div>`, el => {
		const count = () => {
			const rows = parseList($('#sf-list', el).value)
			const accs = el.querySelectorAll('.sf-acc:checked').length
			const daily = Number($('#sf-daily', el).value) || 30
			const msg = $('#sf-msg', el).value
			$('#sf-review', el).innerHTML = reviewHTML(msg)
			const days = accs ? Math.ceil(rows.length / (accs * daily)) : 0
			$('#sf-count', el).innerHTML = rows.length
				? `<b>${rows.length}</b> contactos · ${accs} número(s) × ${daily} al día = <b>${accs * daily} al día</b> · terminaría en unos <b>${days} día(s)</b>.${msg && rows[0] ? `<br>Ejemplo del primero: <i>${esc(msg.replace(/\{\{(\d+)\}\}/g, (m, n) => rows[0].params[n - 1] || ''))}</i>` : ''}`
				: 'Pega la lista o carga un archivo. La primera columna es el teléfono (10 dígitos).'
		}
		el.querySelectorAll('input, textarea').forEach(i => { i.addEventListener('input', count); i.addEventListener('change', count) })
		$('#sf-validate', el).onclick = async () => {
			const lines = $('#sf-list', el).value.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
			const rows = parseList($('#sf-list', el).value)
			if (!rows.length) return toast('Primero pega o carga la lista')
			const btn = $('#sf-validate', el)
			btn.disabled = true
			btn.textContent = `Validando ${rows.length} números… (unos ${Math.max(1, Math.ceil(rows.length / 20 * 1.3 / 60))} min)`
			try {
				const accountIds = [...el.querySelectorAll('.sf-acc:checked')].map(i => Number(i.value))
				const { valid, invalid } = await api('POST', '/validate-list', { phones: rows.map(r => r.phone), accountIds })
				const ok = new Set(valid)
				// Se conservan solo las filas con WhatsApp (y las que no parecen teléfono, como encabezados, se quitan)
				$('#sf-list', el).value = lines.filter(l => ok.has(parseList(l)[0]?.phone)).join('\n')
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
			const rows = parseList($('#sf-list', el).value)
			const accountIds = [...el.querySelectorAll('.sf-acc:checked')].map(i => Number(i.value))
			const message = $('#sf-msg', el).value.trim()
			if (!accountIds.length) return toast('Marca al menos un número conectado')
			if (!message) return toast('Escribe el mensaje')
			if (reviewMessage(message).level === 'alto' && !confirm('El revisor marcó el mensaje con riesgo ALTO de reportes o restricción. ¿Enviar de todos modos?')) return
			if (!rows.length) return toast('La lista está vacía')
			const daily = Number($('#sf-daily', el).value) || 30
			if (daily > 50 && !confirm(`${daily} mensajes por número al día es mucho y aumenta el riesgo de restricción. ¿Continuar?`)) return
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
		<header class="bar"><h1>Cuentas</h1><button class="icon-btn" data-act="add-account" aria-label="Agregar">＋</button></header>
		<div class="settings" style="min-height:100%">
		${S.accounts.length ? `<div class="section">Tus WhatsApp (${S.accounts.length})</div><div class="group">${S.accounts.map(a => `
			<a class="item" href="#/account/${a.id}">
				<span class="swatch" style="--c:${esc(a.color)};width:16px;height:16px;border:0"></span>
				<span class="grow"><b>${esc(a.name)} ${a.status === 'connected' ? healthDot(a) : ''}${a.reserve ? ' <small style="display:inline;color:#7C5CFF">reserva</small>' : ''}</b><small>${a.phone ? '+' + esc(a.phone) : 'Sin vincular'}${a.health && a.status === 'connected' ? ' · ' + esc(a.health.reason) : ''}</small></span>
				<span class="status" style="color:${statusColor(a)}">${statusText(a)}</span> ›
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

function renderAccount(id, full) {
	const a = account(id)
	const view = $('#view')
	if (!a) {
		view.innerHTML = `<header class="bar"><button class="icon-btn" data-act="go" data-val="#/accounts">‹</button><h1>Cuenta</h1></header><div class="empty">Cuenta no encontrada</div>`
		return
	}
	if (full) {
		view.innerHTML = `
			<header class="bar"><button class="icon-btn" data-act="go" data-val="#/accounts" aria-label="Atrás">‹</button><h1 id="ac-title"></h1></header>
			<div class="settings" style="min-height:100%">
				<div class="group" style="margin-top:16px">
					<div class="item"><span class="grow">Estado</span><span class="status" id="ac-status"></span></div>
					<div class="item" id="ac-phone-row"><span class="grow">Número</span><span id="ac-phone"></span></div>
				</div>
				<div id="ac-link"></div>
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
	$('#ac-phone').textContent = a.phone ? '+' + a.phone : '—'

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
				<div class="item"><span class="grow">Semáforo</span><span>${HEALTH[h.level][0]} ${HEALTH[h.level][1]}</span></div>
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
		<header class="bar"><h1>Ajustes</h1></header>
		<div class="settings" style="min-height:100%">
			<div class="section">Notificaciones</div>
			<div class="group">${notif}</div>
			<p class="hint">${isStandalone() ? 'Recibirás avisos aunque la app esté cerrada.' : 'En iPhone, primero añade la app a la pantalla de inicio (Compartir › Añadir a pantalla de inicio) y ábrela desde ese ícono.'}</p>

			<div class="section">Etiquetas</div>
			<div class="group">
				${S.labels.map(l => `<div class="item"><span class="tag solid" style="--c:${esc(l.color)}">${esc(l.name)}</span><span class="grow"></span><button class="icon-btn" data-act="del-label" data-val="${l.id}" aria-label="Borrar">🗑️</button></div>`).join('')}
				<div class="item"><input type="text" id="nl-name" placeholder="Nueva etiqueta (ej. Cliente, Pendiente)"></div>
				${colorPicker(COLORS[1])}
				<button class="btn" data-act="add-label">Agregar etiqueta</button>
			</div>
			<p class="hint">Asigna etiquetas con el botón 🏷️ dentro de cada chat y filtra por ellas en la bandeja.</p>

			<div class="section">Calentamiento de números</div>
				<div id="warmup-box" class="group"><div class="item"><span class="grow">Cargando…</span></div></div>
				<p class="hint">Tus propios números se escriben entre sí, poco a poco y en horario normal, para que las cuentas nuevas se vean activas y «maduren». Solo son tus números hablando entre ellos. Necesitas al menos <b>2 números conectados</b>.</p>

				<div class="section">Días sin envíos masivos</div>
			<div class="chips" style="padding:8px 16px">${[[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [0, 'Dom']].map(([d, t]) => `<button class="chip ${S.restDays.includes(d) ? 'on' : ''}" style="--c:#7C5CFF" data-act="rest-day" data-val="${d}">${t}</button>`).join('')}</div>
			<p class="hint">Los días marcados no sale ningún envío masivo (los chats normales sí funcionan). Descansar los domingos ayuda a que los números se vean como de una persona real.</p>

			<div class="section">Respuestas rápidas</div>
			<div class="group">
				${S.replies.map(r => `<div class="item"><span class="grow"><b>${esc(r.title)}</b><small style="white-space:pre-wrap">${esc(r.text)}</small></span><button class="icon-btn" data-act="del-reply" data-val="${r.id}" aria-label="Borrar">🗑️</button></div>`).join('')}
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
	const nums = (st.numbers || []).map(n => `<div class="item"><span class="grow">${esc(n.name)}</span><small>${n.sentToday}/${n.target} hoy · ${n.ageDays}d</small></div>`).join('')
	box.innerHTML = `
		<div class="item"><span class="grow">Activar calentamiento</span>
			<button class="btn ${st.enabled ? 'primary' : ''}" data-act="warmup-toggle" style="width:auto;padding:6px 14px">${st.enabled ? 'Activado' : 'Activar'}</button></div>
		<div class="item"><span class="grow">Tope de mensajes por número/día</span><input type="number" id="wu-perday" min="1" max="40" value="${st.perDay}" style="text-align:right;max-width:70px"></div>
		<p class="hint" style="margin:2px 16px 0">Es el máximo. En números nuevos arranca bajo (≈3/día) y sube solo con los días hasta ese tope.</p>
		<div class="item"><span class="grow">Horario (de / a)</span><input type="number" id="wu-start" min="0" max="23" value="${st.startHour}" style="text-align:right;max-width:55px"><span style="margin:0 6px">a</span><input type="number" id="wu-end" min="1" max="24" value="${st.endHour}" style="text-align:right;max-width:55px"></div>
		<div class="item"><span class="grow">Pausa entre mensajes (min)</span><input type="number" id="wu-min" min="5" max="360" value="${st.minDelay}" style="text-align:right;max-width:55px"><span style="margin:0 6px">–</span><input type="number" id="wu-max" min="5" max="720" value="${st.maxDelay}" style="text-align:right;max-width:55px"></div>
		<button class="btn" data-act="warmup-save">Guardar ajustes</button>
		<div class="item"><span class="grow">Estado</span><span>${st.eligible < 2 ? `⚠️ ${st.eligible} conectado(s)` : st.running ? '🟢 Funcionando' : '⏸️ En pausa'}</span></div>
		${nums}`
}
function warmupBody() {
	return {
		perDay: Number($('#wu-perday')?.value) || undefined,
		startHour: Number($('#wu-start')?.value),
		endHour: Number($('#wu-end')?.value),
		minDelay: Number($('#wu-min')?.value) || undefined,
		maxDelay: Number($('#wu-max')?.value) || undefined
	}
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
	bg.innerHTML = `<div class="sheet"><header class="bar"><h1 style="font-size:18px">${esc(title)}</h1><button class="icon-btn" data-act="close-sheet">Cerrar</button></header>${html}</div>`
	bg.addEventListener('click', e => { if (e.target === bg) closeSheet() })
	document.body.appendChild(bg)
	bind?.(bg)
}
function closeSheet() { $('#sheet')?.remove() }

// ---------- Eventos ----------
document.addEventListener('click', async e => {
	const el = e.target.closest('[data-act]')
	if (!el) return
	const act = el.dataset.act
	const val = el.dataset.val
	switch (act) {
		case 'go': return go(val)
		case 'back': return history.length > 1 ? history.back() : go('#/')
		case 'f-all': S.filter.account = null; S.filter.label = null; S.filter.unread = false; S.filter.waiting = false; S.filter.reminders = false; return renderInbox(false)
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

window.addEventListener('hashchange', render)

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
