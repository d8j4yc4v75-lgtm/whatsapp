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
	reply: store.get('reply', {}),
	filter: { account: null, label: null, unread: false, q: '' },
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
const conv = jid => S.convs.find(c => c.jid === jid)
const convName = c => c?.name || (c?.isGroup ? 'Grupo' : c?.phone ? '+' + c.phone : c?.jid || '')
const totalUnread = () => S.convs.reduce((n, c) => n + (c.unread || 0), 0)

function statusText(a) {
	return { connected: 'Conectado', connecting: 'Conectando…', reconnecting: 'Reconectando…', qr: 'Esperando vinculación', logged_out: 'Sin vincular' }[a.status] || 'Desconectado'
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
	const [accounts, convs, labels] = await Promise.all([api('GET', '/accounts'), api('GET', '/conversations'), api('GET', '/labels')])
	S.accounts = accounts
	S.convs = convs
	S.labels = labels
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
	S.convs = S.convs.filter(x => x.jid !== c.jid)
	const i = S.convs.findIndex(x => x.lastTs < c.lastTs)
	S.convs.splice(i < 0 ? S.convs.length : i, 0, c)
}

function insertMsg(m) {
	const list = S.msgs[m.jid]
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
				if (m) m.status = Math.max(m.status, data.status)
			}
			break
		case 'conversation.update':
			if (data.jid === S.active && data.unread > 0 && document.visibilityState === 'visible') {
				data.unread = 0
				api('POST', `/conversations/${enc(data.jid)}/read`).catch(() => {})
			}
			upsertConv(data)
			updateBadge()
			break
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

function defaultFrom(jid) {
	const ok = id => account(id)?.status === 'connected'
	if (S.reply[jid] && account(S.reply[jid])) return S.reply[jid]
	const last = [...(S.msgs[jid] || [])].reverse().find(m => ok(m.accountId))
	if (last) return last.accountId
	const c = conv(jid)
	const fromConv = c?.accountIds.find(ok)
	if (fromConv) return fromConv
	return S.accounts.find(a => ok(a.id))?.id ?? S.accounts[0]?.id ?? null
}

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
	if (r.name === 'accounts') renderAccounts()
	else if (r.name === 'account') renderAccount(Number(r.arg), changed)
	else if (r.name === 'settings') { if (changed) renderSettings() }
	else renderInbox(changed)
}

function tabs(active) {
	const t = (name, icon, text, href) =>
		`<a href="${href}" class="${active === name || (name === 'accounts' && active === 'account') ? 'active' : ''}"><span>${icon}</span>${text}${name === 'inbox' ? '<i class="badge" id="tab-badge" hidden></i>' : ''}</a>`
	return `<nav class="tabs">${t('inbox', '💬', 'Bandeja', '#/')}${t('accounts', '📱', 'Cuentas', '#/accounts')}${t('settings', '⚙️', 'Ajustes', '#/settings')}</nav>`
}

// ---------- Bandeja ----------
function filteredConvs() {
	const f = S.filter
	const q = f.q.trim().toLowerCase()
	const digits = q.replace(/\D/g, '')
	return S.convs.filter(c => {
		if (f.account && !c.accountIds.includes(f.account)) return false
		if (f.label && !c.labelIds.includes(f.label)) return false
		if (f.unread && !c.unread) return false
		if (q) {
			return convName(c).toLowerCase().includes(q) || (digits && (c.phone || '').includes(digits)) || (c.lastText || '').toLowerCase().includes(q)
		}
		return true
	})
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
		chip('f-all', '', 'Todos', !f.account && !f.label && !f.unread),
		chip('f-unread', '', 'No leídos', f.unread),
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
		<li><a class="row" href="#/chat/${enc(c.jid)}">
			<div class="avatar" style="background:${avatarColor(c.jid)}">${c.isGroup ? '👥' : esc(initials(convName(c)))}</div>
			<div class="body">
				<div class="top"><span class="name">${esc(convName(c))}</span><span class="time ${c.unread ? 'unread' : ''}">${c.lastTs ? timeLabel(c.lastTs) : ''}</span></div>
				<div class="bottom"><span class="preview">${c.lastFromMe ? 'Tú: ' : ''}${esc(c.lastText)}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
				<div class="tags">${c.accountIds.map(accountTag).join('')}${c.labelIds.map(label).filter(Boolean).map(l => `<span class="tag solid" style="--c:${esc(l.color)}">${esc(l.name)}</span>`).join('')}</div>
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
				<button class="icon-btn" data-act="labels" aria-label="Etiquetas">🏷️</button>
			</header>
			<div class="msgs" id="msgs"><div class="empty">Cargando…</div></div>
			<footer class="composer">
				<div class="from">Enviar desde <select id="from"></select></div>
				<div class="compose-row" id="compose-row"></div>
				<input type="file" id="file" hidden>
			</footer>`
		renderComposer()
		$('#from').onchange = e => {
			S.reply[jid] = Number(e.target.value)
			store.set('reply', S.reply)
			renderFrom()
		}
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
	$('#c-title').textContent = c ? convName(c) : '+' + S.active.split('@')[0]
	const parts = []
	if (c?.phone && c.name) parts.push('+' + c.phone)
	if (c?.labelIds.length) parts.push(c.labelIds.map(label).filter(Boolean).map(l => l.name).join(', '))
	$('#c-sub').textContent = parts.join(' · ')
}

function renderFrom() {
	const sel = $('#from')
	if (!sel) return
	const current = defaultFrom(S.active)
	const sig = current + '|' + S.accounts.map(a => a.id + a.name + a.status + a.color).join(',')
	if (sel.dataset.sig === sig) return
	sel.dataset.sig = sig
	sel.innerHTML = S.accounts.length
		? S.accounts.map(a => `<option value="${a.id}" ${a.id === current ? 'selected' : ''} ${a.status !== 'connected' ? 'disabled' : ''}>${esc(a.name)}${a.phone ? ' (+' + esc(a.phone) + ')' : ''}${a.status !== 'connected' ? ' · ' + statusText(a) : ''}</option>`).join('')
		: '<option>Sin cuentas</option>'
	sel.style.setProperty('--c', account(current)?.color || 'var(--line)')
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
	row.innerHTML = `
		<button class="round ghost" data-act="attach" aria-label="Adjuntar">＋</button>
		<textarea id="text" rows="1" placeholder="Mensaje"></textarea>
		<button class="round" id="send-btn" data-act="send" aria-label="Enviar">🎤</button>`
	const ta = $('#text')
	ta.value = prev
	const sync = () => {
		ta.style.height = 'auto'
		ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'
		$('#send-btn').textContent = ta.value.trim() ? '➤' : '🎤'
	}
	ta.oninput = sync
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
	if (status === 0) return '<span style="color:var(--danger)">⚠︎</span>'
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
		const m = await api('POST', '/send', { accountId: from, jid: S.active, text })
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
	fd.append('jid', S.active)
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
	const jid = S.active
	const c = conv(jid)
	if (!S.labels.length) return toast('Primero crea etiquetas en Ajustes')
	if (!c) return toast('Envía o recibe un mensaje antes de etiquetar')
	sheet('Etiquetas', `<div class="group">${S.labels.map(l => `
		<label class="item"><span class="tag solid" style="--c:${esc(l.color)}">${esc(l.name)}</span><span class="grow"></span>
		<input type="checkbox" data-label="${l.id}" ${c.labelIds.includes(l.id) ? 'checked' : ''}></label>`).join('')}</div>`, el => {
		el.querySelectorAll('input[data-label]').forEach(cb => {
			cb.onchange = async () => {
				const ids = [...el.querySelectorAll('input[data-label]:checked')].map(x => Number(x.dataset.label))
				try {
					upsertConv(await api('PUT', `/conversations/${enc(jid)}/labels`, { labelIds: ids }))
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
		<div class="group"><div class="item"><select id="nc-from">${connected.map(a => `<option value="${a.id}">${esc(a.name)}${a.phone ? ' (+' + esc(a.phone) + ')' : ''}</option>`).join('')}</select></div></div>
		<div class="section">Número con código de país</div>
		<div class="group"><div class="item"><input type="tel" id="nc-phone" placeholder="Ej. 5215512345678" inputmode="tel"></div></div>
		<div class="section">Mensaje (opcional)</div>
		<div class="group"><div class="item"><textarea id="nc-text" rows="3" placeholder="Escribe un mensaje"></textarea></div></div>
		<div class="pad"><button class="btn primary" id="nc-go">Abrir chat</button></div>`, el => {
		$('#nc-go', el).onclick = async () => {
			const accountId = Number($('#nc-from', el).value)
			const phone = $('#nc-phone', el).value
			const text = $('#nc-text', el).value.trim()
			if (phone.replace(/\D/g, '').length < 8) return toast('Escribe el número completo con código de país')
			try {
				const { jid } = await api('POST', '/resolve', { accountId, phone })
				if (text) await api('POST', '/send', { accountId, jid, text })
				S.reply[jid] = accountId
				store.set('reply', S.reply)
				closeSheet()
				S.convs = await api('GET', '/conversations')
				go('#/chat/' + enc(jid))
			} catch (e) { toast(e.message) }
		}
	})
}

// ---------- Cuentas ----------
function renderAccounts() {
	$('#view').innerHTML = `
		<header class="bar"><h1>Cuentas</h1><button class="icon-btn" data-act="add-account" aria-label="Agregar">＋</button></header>
		<div class="settings" style="min-height:100%">
		${S.accounts.length ? `<div class="section">Tus WhatsApp (${S.accounts.length})</div><div class="group">${S.accounts.map(a => `
			<a class="item" href="#/account/${a.id}">
				<span class="swatch" style="--c:${esc(a.color)};width:16px;height:16px;border:0"></span>
				<span class="grow"><b>${esc(a.name)}</b><small>${a.phone ? '+' + esc(a.phone) : 'Sin vincular'}</small></span>
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
	sheet('Nueva cuenta', `
		<div class="section">Nombre</div>
		<div class="group"><div class="item"><input type="text" id="na-name" placeholder="Ej. Ventas, Personal, Soporte"></div></div>
		<div class="section">Color</div>
		<div class="group">${colorPicker(color)}</div>
		<div class="pad"><button class="btn primary" id="na-go">Crear y vincular</button></div>`, el => {
		bindColorPicker(el, c => { color = c })
		$('#na-go', el).onclick = async () => {
			const name = $('#na-name', el).value.trim() || `WhatsApp ${S.accounts.length + 1}`
			try {
				const a = await api('POST', '/accounts', { name, color })
				if (!account(a.id)) S.accounts.push(a)
				closeSheet()
				go('#/account/' + a.id)
			} catch (e) { toast(e.message) }
		}
	})
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
	api('GET', '/info').then(info => {
		const el = $('#storage')
		if (el) el.innerHTML = info.persistent
			? '<span style="color:var(--accent)">Permanentes ✅</span>'
			: '<span style="color:var(--danger)">Temporales ⚠️ falta el disco /data</span>'
	}).catch(() => {})
	view.dataset.labelColor = COLORS[1]
	bindColorPicker(view, c => { view.dataset.labelColor = c })
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
		case 'f-all': S.filter.account = null; S.filter.label = null; S.filter.unread = false; return renderInbox(false)
		case 'f-unread': S.filter.unread = !S.filter.unread; return renderInbox(false)
		case 'f-account': S.filter.account = S.filter.account === Number(val) ? null : Number(val); return renderInbox(false)
		case 'f-label': S.filter.label = S.filter.label === Number(val) ? null : Number(val); return renderInbox(false)
		case 'new-chat': return openNewChat()
		case 'close-sheet': return closeSheet()
		case 'labels': return openLabelsSheet()
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
		case 'ac-save': case 'ac-connect': case 'ac-logout': case 'ac-delete': case 'ac-pair':
			return accountAction(act)
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
	if (e.data?.type === 'open' && e.data.jid) go('#/chat/' + enc(e.data.jid))
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
