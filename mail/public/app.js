'use strict'
const $ = (sel, el = document) => el.querySelector(sel)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const enc = encodeURIComponent
const store = {
	get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
	set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }
}
const COLORS = ['#0a7cff', '#25D366', '#FF9500', '#AF52DE', '#FF2D55', '#00B8D9', '#E6B800', '#8E8E93']
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches

const S = {
	token: store.get('token', null),
	accounts: [], threads: [], labels: [],
	filter: { account: null, label: null, unread: false, q: '' },
	wsOk: false, ws: null, active: null, statsLoaded: false
}

function toast(text, ms = 3500) {
	const t = $('#toast'); t.textContent = text; t.hidden = false
	clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true }, ms)
}

async function api(method, path, body) {
	const opts = { method, headers: { Authorization: 'Bearer ' + S.token } }
	if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
	const res = await fetch('/api' + path, opts)
	const data = await res.json().catch(() => ({}))
	if (res.status === 401) { logout(); throw new Error('Sesión expirada') }
	if (!res.ok) throw new Error(data.error || 'Error ' + res.status)
	return data
}

const account = id => S.accounts.find(a => a.id === id)
const label = id => S.labels.find(l => l.id === id)
const thread = key => S.threads.find(t => t.key === key)
const accOfKey = key => Number(String(key).split(':')[0])
const totalUnread = () => S.threads.reduce((n, t) => n + (t.unread || 0), 0)

function statusText(a) {
	return { connected: 'Conectado', connecting: 'Conectando…', error: 'Error', disconnected: 'Desconectado' }[a.status] || a.status
}
function statusColor(a) { return a.status === 'connected' ? 'var(--accent)' : a.status === 'connecting' ? '#f5a623' : 'var(--danger)' }
function initials(name) {
	const letters = String(name || '?').split(/\s+/).slice(0, 2).map(w => [...w].find(ch => /\p{L}/u.test(ch))).filter(Boolean)
	return letters.length ? letters.join('').toUpperCase() : '@'
}
function avatarColor(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 45% 50%)` }
function timeLabel(ts) {
	const d = new Date(ts), now = new Date(), day = 864e5
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
	if (ts >= start) return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
	if (ts >= start - day) return 'Ayer'
	if (ts >= start - 6 * day) return d.toLocaleDateString('es', { weekday: 'short' })
	return d.toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: '2-digit' })
}
function accountTag(id) {
	const a = account(id)
	return `<span class="tag" style="--c:${esc(a?.color || '#8E8E93')}">${esc(a?.name || '?')}</span>`
}
function updateBadge() {
	const n = totalUnread()
	if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {})
	const b = $('#tab-badge'); if (b) { b.textContent = n; b.hidden = !n }
}

// ---------- Acceso ----------
async function showLogin() {
	const { hasPassword } = await fetch('/auth/status').then(r => r.json())
	$('#app').innerHTML = `
		<form class="login" id="login">
			<img src="/icons/icon-192.png" alt="">
			<h1>MultiMail</h1>
			<p>${hasPassword ? 'Escribe tu contraseña para entrar.' : 'Bienvenido. Crea una contraseña para proteger tu correo (mínimo 6 caracteres).'}</p>
			<input type="password" id="pw" placeholder="Contraseña" autocomplete="${hasPassword ? 'current-password' : 'new-password'}" required minlength="6">
			${hasPassword ? '' : '<input type="password" id="pw2" placeholder="Repite la contraseña" autocomplete="new-password" required minlength="6">'}
			<button class="btn primary" type="submit">${hasPassword ? 'Entrar' : 'Crear contraseña'}</button>
		</form>`
	$('#login').onsubmit = async e => {
		e.preventDefault()
		const pw = $('#pw').value
		if (!hasPassword && pw !== $('#pw2').value) return toast('Las contraseñas no coinciden')
		const res = await fetch(hasPassword ? '/auth/login' : '/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
		const data = await res.json().catch(() => ({}))
		if (!res.ok) return toast(data.error || 'Error')
		S.token = data.token; store.set('token', S.token); boot()
	}
}
function logout() { S.token = null; store.set('token', null); S.ws?.close(); showLogin() }

// ---------- Datos ----------
async function loadAll() {
	const [accounts, threads, labels] = await Promise.all([api('GET', '/accounts'), api('GET', '/threads'), api('GET', '/labels')])
	S.accounts = accounts; S.threads = threads; S.labels = labels; updateBadge()
}
async function reloadThreads() { S.threads = await api('GET', '/threads'); updateBadge() }

function connectWS() {
	if (S.ws && S.ws.readyState <= 1) return
	const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${enc(S.token)}`)
	S.ws = ws
	ws.onopen = () => { S.wsOk = true; refreshDot() }
	ws.onclose = () => { S.wsOk = false; refreshDot(); if (S.ws === ws && S.token) setTimeout(() => { if (S.ws === ws) resync() }, 3000) }
	ws.onmessage = e => { try { handleEvent(JSON.parse(e.data)) } catch {} }
}
async function resync() { try { await loadAll(); render() } catch {} connectWS() }
function refreshDot() { const d = $('#ws-dot'); if (d) d.classList.toggle('on', S.wsOk) }

function upsertThread(t) {
	if (!t) return
	S.threads = S.threads.filter(x => x.key !== t.key)
	const i = S.threads.findIndex(x => x.lastTs < t.lastTs)
	S.threads.splice(i < 0 ? S.threads.length : i, 0, t)
	updateBadge()
}
function handleEvent({ type, data }) {
	switch (type) {
		case 'hello': S.accounts = data.accounts; break
		case 'account.update': { const i = S.accounts.findIndex(a => a.id === data.id); if (i >= 0) S.accounts[i] = data; else S.accounts.push(data); break }
		case 'account.removed': S.accounts = S.accounts.filter(a => a.id !== data.id); break
		case 'thread.update': upsertThread(data); break
		case 'inbox.changed': reloadThreads().then(() => { if (route().name === 'inbox') renderInboxList() }); if (S.active) openThread(S.active, true); return
	}
	renderSoon()
}
let rt
function renderSoon() { clearTimeout(rt); rt = setTimeout(render, 60) }

// ---------- Navegación ----------
function route() {
	const h = location.hash.replace(/^#\/?/, ''); const [name, ...rest] = h.split('/')
	return { name: name || 'inbox', arg: rest.length ? decodeURIComponent(rest.join('/')) : null }
}
const go = h => { location.hash = h }
let lastRoute = ''
function render() {
	if (!S.token) return
	const r = route(); const key = r.name + ':' + r.arg; const changed = key !== lastRoute; lastRoute = key
	if (r.name !== 't' && S.active) S.active = null
	if (r.name === 't') return renderThread(r.arg, changed)
	if (r.name === 'compose') return renderCompose(r.arg, changed)
	if (changed || !$('#view')) $('#app').innerHTML = `<main class="view" id="view"></main>${tabs(r.name)}`
	updateBadge()
	if (r.name === 'accounts') renderAccounts()
	else if (r.name === 'account') renderAccount(Number(r.arg), changed)
	else if (r.name === 'settings') { if (changed) renderSettings() }
	else renderInbox(changed)
}
function tabs(active) {
	const t = (n, i, txt, href) => `<a href="${href}" class="${active === n || (n === 'accounts' && active === 'account') ? 'active' : ''}"><span>${i}</span>${txt}${n === 'inbox' ? '<i class="badge" id="tab-badge" hidden></i>' : ''}</a>`
	return `<nav class="tabs">${t('inbox', '📥', 'Bandeja', '#/')}${t('accounts', '✉️', 'Cuentas', '#/accounts')}${t('settings', '⚙️', 'Ajustes', '#/settings')}</nav>`
}

// ---------- Bandeja ----------
function filtered() {
	const f = S.filter, q = f.q.trim().toLowerCase()
	return S.threads.filter(t => {
		if (f.account && t.accountId !== f.account) return false
		if (f.label && !t.labelIds.includes(f.label)) return false
		if (f.unread && !t.unread) return false
		if (q) return (t.subject || '').toLowerCase().includes(q) || (t.from || '').toLowerCase().includes(q) || (t.snippet || '').toLowerCase().includes(q)
		return true
	})
}
function renderInbox(full) {
	const view = $('#view')
	if (full) {
		view.innerHTML = `
			<header class="bar"><i class="dot ${S.wsOk ? 'on' : ''}" id="ws-dot"></i><h1>Bandeja</h1>
				<button class="icon-btn" data-act="compose" aria-label="Redactar">✍️</button></header>
			${!isStandalone() && /iPhone|iPad/.test(navigator.userAgent) ? `<div class="install"><b>Instala la app</b>Toca <b style="display:inline">Compartir ⬆︎</b> y luego <b style="display:inline">«Añadir a pantalla de inicio»</b>.</div>` : ''}
			<div class="search"><input id="q" type="search" placeholder="Buscar correo, remitente o asunto" value="${esc(S.filter.q)}"></div>
			<div class="chips" id="chips"></div>
			<ul class="list" id="threads"></ul>`
		$('#q').oninput = e => { S.filter.q = e.target.value; renderInboxList() }
	}
	renderChips(); renderInboxList()
}
function renderChips() {
	const f = S.filter
	const chip = (act, val, text, on, color) => `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-val="${esc(val)}" ${color ? `style="--c:${esc(color)}"` : ''}>${esc(text)}</button>`
	$('#chips').innerHTML = [
		chip('f-all', '', 'Todos', !f.account && !f.label && !f.unread),
		chip('f-unread', '', 'No leídos', f.unread),
		...S.accounts.map(a => chip('f-account', a.id, a.name, f.account === a.id, a.color)),
		...S.labels.map(l => chip('f-label', l.id, '# ' + l.name, f.label === l.id, l.color))
	].join('')
}
function renderInboxList() {
	const list = filtered(), el = $('#threads')
	if (!list.length) {
		el.innerHTML = `<li class="empty"><div class="big">${S.accounts.length ? '📭' : '✉️'}</div>${S.accounts.length ? 'Sin correos.' : 'Aún no hay cuentas. Ve a <a href="#/accounts">Cuentas</a> y agrega tu primer correo.'}</li>`
		return
	}
	el.innerHTML = list.map(t => `
		<li><a class="row ${t.unread ? 'unread' : ''}" href="#/t/${enc(t.key)}">
			<div class="avatar" style="background:${avatarColor(t.from)}">${esc(initials(t.from))}</div>
			<div class="body">
				<div class="top"><span class="from">${esc(t.from)}${t.count > 1 ? ` <span class="count">(${t.count})</span>` : ''}</span><span class="time ${t.unread ? 'u' : ''}">${timeLabel(t.lastTs)}</span></div>
				<div class="subject">${esc(t.subject)}</div>
				<div class="top"><span class="snippet">${esc(t.snippet)}</span>${t.unread ? '<span class="dotu"></span>' : ''}</div>
				<div class="tags">${accountTag(t.accountId)}${t.labelIds.map(label).filter(Boolean).map(l => `<span class="tag solid" style="--c:${esc(l.color)}">${esc(l.name)}</span>`).join('')}</div>
			</div>
		</a></li>`).join('')
}

// ---------- Hilo ----------
async function renderThread(key, full) {
	if (full) {
		S.active = key
		$('#app').innerHTML = `
			<header class="bar">
				<button class="icon-btn" data-act="back" aria-label="Atrás">‹</button>
				<div class="title"><b id="t-title"></b><small id="t-sub"></small></div>
				<button class="icon-btn" data-act="labels" aria-label="Etiquetas">🏷️</button>
			</header>
			<div class="thread" id="thread"><div class="empty">Cargando…</div></div>
			<div class="thread-actions">
				<button class="btn primary" data-act="reply">↩︎ Responder</button>
				<button class="btn" data-act="reply-all" style="background:var(--bg);border-radius:12px">↩︎ A todos</button>
				<button class="btn" data-act="forward" style="background:var(--bg);border-radius:12px">↪︎ Reenviar</button>
			</div>`
	}
	await openThread(key)
}
async function openThread(key, silent) {
	const { accountId, threadKey } = { accountId: accOfKey(key), threadKey: key.slice(key.indexOf(':') + 1) }
	let data
	try { data = await api('GET', `/threads/${enc(key)}`) } catch (e) { if (!silent) toast(e.message); return }
	S.threadData = data
	upsertThread(data.thread)
	const t = $('#t-title'); if (t) t.textContent = data.thread.subject
	const sub = $('#t-sub'); if (sub) sub.textContent = `${accountTag ? '' : ''}${account(accountId)?.name || ''}${data.thread.labelIds.length ? ' · ' + data.thread.labelIds.map(label).filter(Boolean).map(l => l.name).join(', ') : ''}`
	const box = $('#thread'); if (!box) return
	box.innerHTML = data.messages.map(m => mailHTML(m)).join('')
	box.querySelectorAll('iframe[data-html]').forEach(f => {
		const doc = f.contentDocument
		doc.open(); doc.write(`<!doctype html><meta name="viewport" content="width=device-width"><base target="_blank"><style>body{font:15px -apple-system,sans-serif;margin:8px;color:#111;word-wrap:break-word}img{max-width:100%;height:auto}</style>${f.dataset.html}`); doc.close()
		const fit = () => { f.style.height = Math.min(1600, doc.body.scrollHeight + 20) + 'px' }
		setTimeout(fit, 60); doc.querySelectorAll('img').forEach(im => im.addEventListener('load', fit))
	})
	box.scrollTop = box.scrollHeight
	if (!silent) api('POST', `/threads/${enc(key)}/read`).catch(() => {})
}
function mailHTML(m) {
	const a = account(m.accountId)
	const d = new Date(m.ts)
	const who = m.fromMe ? 'Tú' : m.from
	const body = m.html
		? `<iframe data-html="${esc(m.html)}" scrolling="no"></iframe>`
		: `<div class="text">${esc(m.text || m.snippet || '')}</div>`
	const atts = m.attachments.map(at => `<a class="attach" href="/api/attachments/${m.accountId}/${m.uid}/${at.index}?token=${enc(S.token)}" target="_blank">📎 ${esc(at.name)}</a>`).join('')
	return `<div class="mail" style="--c:${esc(a?.color || '#8E8E93')}">
		<div class="head"><div class="who"><b>${esc(who)}</b><small>${esc(m.subject)}</small><small>para ${esc((m.to || []).join(', ') || '—')}</small></div><span class="when">${d.toLocaleDateString('es', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</span></div>
		<div class="content">${body}${atts}</div>
	</div>`
}

// ---------- Redacción ----------
function renderCompose(mode, full) {
	const d = S.composeDraft || {}
	const connected = S.accounts.filter(a => a.status === 'connected')
	$('#app').innerHTML = `
		<header class="bar"><button class="icon-btn" data-act="back" aria-label="Atrás">✕</button><h1 style="font-size:18px">${d.subject ? (mode === 'forward' ? 'Reenviar' : 'Responder') : 'Nuevo correo'}</h1><button class="icon-btn" data-act="do-send" aria-label="Enviar">➤</button></header>
		<div class="compose">
			<div class="fields">
				<div class="fld"><label>De</label><select id="cp-from">${connected.map(a => `<option value="${a.id}" ${a.id === d.accountId ? 'selected' : ''}>${esc(a.name)} &lt;${esc(a.email)}&gt;</option>`).join('') || '<option>Sin cuentas conectadas</option>'}</select></div>
				<div class="fld"><label>Para</label><input id="cp-to" type="email" placeholder="correo@destino.com" value="${esc(d.to || '')}"></div>
				<div class="fld"><label>CC</label><input id="cp-cc" type="text" placeholder="opcional" value="${esc(d.cc || '')}"></div>
				<div class="fld"><label>Asunto</label><input id="cp-subject" placeholder="Asunto" value="${esc(d.subject || '')}"></div>
			</div>
			<textarea id="cp-body" placeholder="Escribe tu mensaje…">${esc(d.body || '')}</textarea>
		</div>`
}
function openCompose({ accountId, to, cc, subject, body, inReplyTo, references } = {}) {
	S.composeDraft = { accountId: accountId || S.accounts.find(a => a.status === 'connected')?.id, to, cc, subject, body, inReplyTo, references }
	go('#/compose')
}
async function doSend() {
	const accountId = Number($('#cp-from').value)
	const to = $('#cp-to').value.trim()
	if (!accountId || !to) return toast('Falta la cuenta o el destinatario')
	const body = $('#cp-body').value
	const d = S.composeDraft || {}
	try {
		await api('POST', '/send', {
			accountId, to, cc: $('#cp-cc').value.trim() || undefined,
			subject: $('#cp-subject').value.trim() || '(sin asunto)',
			text: body, inReplyTo: d.inReplyTo, references: d.references
		})
		S.composeDraft = null
		toast('Correo enviado ✅')
		history.length > 1 ? history.back() : go('#/')
	} catch (e) { toast(e.message, 6000) }
}
function quote(m) {
	const d = new Date(m.ts)
	return `\n\n\n--------\nEl ${d.toLocaleDateString('es')}, ${esc ? m.from : m.from} escribió:\n> ${(m.text || m.snippet || '').replace(/\n/g, '\n> ')}`
}
function startReply(all) {
	const data = S.threadData; if (!data) return
	const last = [...data.messages].reverse().find(m => !m.fromMe) || data.messages[data.messages.length - 1]
	const me = account(data.messages[0].accountId)?.email
	let to = last.fromMe ? (last.to[0] || '') : `${last.from} <${last.fromAddr}>`
	let cc = ''
	if (all) cc = [...last.to, ...last.cc].filter(a => a && !a.includes(me)).join(', ')
	openCompose({
		accountId: last.accountId, to, cc,
		subject: /^re:/i.test(last.subject) ? last.subject : 'Re: ' + last.subject,
		body: quote(last), inReplyTo: last.messageId, references: last.messageId
	})
}
function startForward() {
	const data = S.threadData; if (!data) return
	const last = data.messages[data.messages.length - 1]
	openCompose({
		accountId: last.accountId, to: '',
		subject: /^(fwd|rv):/i.test(last.subject) ? last.subject : 'Fwd: ' + last.subject,
		body: `\n\n\n--------- Mensaje reenviado ---------\nDe: ${last.from}\nAsunto: ${last.subject}\n\n${last.text || last.snippet || ''}`
	})
}

// ---------- Cuentas ----------
function renderAccounts() {
	$('#view').innerHTML = `
		<header class="bar"><h1>Cuentas</h1><button class="icon-btn" data-act="add-account" aria-label="Agregar">＋</button></header>
		<div style="min-height:100%">
		${S.accounts.length ? `<div class="section">Tus correos (${S.accounts.length})</div><div class="group">${S.accounts.map(a => `
			<a class="item" href="#/account/${a.id}">
				<span class="swatch" style="--c:${esc(a.color)};width:16px;height:16px;border:0"></span>
				<span class="grow"><b>${esc(a.name)}</b><small>${esc(a.email)}</small></span>
				${a.unread ? `<span class="tag solid" style="--c:var(--accent)">${a.unread}</span>` : ''}
				<span class="status" style="color:${statusColor(a)}">${statusText(a)}</span> ›
			</a>`).join('')}</div>` : `<div class="empty"><div class="big">✉️</div>Toca <b>＋</b> para agregar tu primer correo.</div>`}
		<p class="hint">Se conecta por IMAP/SMTP. Para Gmail, Outlook o Yahoo con verificación en dos pasos, usa una «contraseña de aplicación», no tu contraseña normal.</p>
		</div>`
}
function colorPicker(sel) { return `<div class="swatches">${COLORS.map(c => `<button type="button" class="swatch ${c === sel ? 'on' : ''}" style="--c:${c}" data-color="${c}"></button>`).join('')}</div>` }
function bindColor(el, cb) { el.querySelectorAll('[data-color]').forEach(b => { b.onclick = () => { el.querySelectorAll('[data-color]').forEach(x => x.classList.toggle('on', x === b)); cb(b.dataset.color) } }) }

function openAddAccount() {
	let color = COLORS[S.accounts.length % COLORS.length]
	let advanced = false
	sheet('Agregar correo', `
		<div class="section">Datos</div>
		<div class="group">
			<div class="item"><input type="email" id="aa-email" placeholder="tucorreo@dominio.com" inputmode="email" autocapitalize="off"></div>
			<div class="item"><input type="text" id="aa-name" placeholder="Nombre que verás (ej. Cobranza)"></div>
			<div class="item"><input type="password" id="aa-pass" placeholder="Contraseña (o contraseña de aplicación)" autocomplete="off"></div>
		</div>
		<div id="aa-help" class="hint"></div>
		<div class="section">Color</div>
		<div class="group">${colorPicker(color)}</div>
		<button class="btn" id="aa-advanced" type="button">⚙️ Ajustes avanzados (servidor manual)</button>
		<div id="aa-adv" hidden>
			<div class="group">
				<div class="item"><span class="grow">Servidor IMAP</span><input type="text" id="aa-imap" style="text-align:right" placeholder="imap.dominio.com"></div>
				<div class="item"><span class="grow">Puerto IMAP</span><input type="number" id="aa-imapport" style="text-align:right;max-width:80px" value="993"></div>
				<div class="item"><span class="grow">Servidor SMTP</span><input type="text" id="aa-smtp" style="text-align:right" placeholder="smtp.dominio.com"></div>
				<div class="item"><span class="grow">Puerto SMTP</span><input type="number" id="aa-smtpport" style="text-align:right;max-width:80px" value="465"></div>
			</div>
		</div>
		<div class="pad"><button class="btn primary" id="aa-go">Conectar</button></div>`, el => {
		bindColor(el, c => { color = c })
		let guessed = null
		const guess = async () => {
			const email = $('#aa-email', el).value.trim()
			if (!/@.+\./.test(email)) return
			try {
				guessed = await api('GET', `/guess?email=${enc(email)}`)
				$('#aa-help', el).innerHTML = `Proveedor: <b>${esc(guessed.provider)}</b>. ${guessed.help ? esc(guessed.help) : ''}`
				$('#aa-imap', el).value = guessed.imapHost; $('#aa-imapport', el).value = guessed.imapPort
				$('#aa-smtp', el).value = guessed.smtpHost; $('#aa-smtpport', el).value = guessed.smtpPort
			} catch {}
		}
		$('#aa-email', el).onblur = guess
		$('#aa-advanced', el).onclick = () => { advanced = !advanced; $('#aa-adv', el).hidden = !advanced; if (advanced) guess() }
		$('#aa-go', el).onclick = async () => {
			const email = $('#aa-email', el).value.trim()
			const pass = $('#aa-pass', el).value
			if (!email || !pass) return toast('Escribe el correo y la contraseña')
			const btn = $('#aa-go', el); btn.disabled = true; btn.textContent = 'Conectando…'
			const body = {
				email, pass, color,
				name: $('#aa-name', el).value.trim() || undefined,
				imapHost: $('#aa-imap', el).value.trim() || undefined,
				imapPort: Number($('#aa-imapport', el).value) || undefined,
				smtpHost: $('#aa-smtp', el).value.trim() || undefined,
				smtpPort: Number($('#aa-smtpport', el).value) || undefined
			}
			try {
				const a = await api('POST', '/accounts', body)
				if (!account(a.id)) S.accounts.push(a)
				closeSheet()
				go('#/account/' + a.id)
			} catch (e) { toast(e.message, 7000) } finally { btn.disabled = false; btn.textContent = 'Conectar' }
		}
	})
}

function renderAccount(id, full) {
	const a = account(id); const view = $('#view')
	if (!a) { view.innerHTML = `<header class="bar"><button class="icon-btn" data-act="go" data-val="#/accounts">‹</button><h1>Cuenta</h1></header><div class="empty">Cuenta no encontrada</div>`; return }
	if (full || view.dataset.acc !== String(id)) {
		view.dataset.acc = String(id)
		view.innerHTML = `
			<header class="bar"><button class="icon-btn" data-act="go" data-val="#/accounts" aria-label="Atrás">‹</button><h1 id="ac-title"></h1></header>
			<div style="min-height:100%">
				<div class="group" style="margin-top:16px">
					<div class="item"><span class="grow">Correo</span><span>${esc(a.email)}</span></div>
					<div class="item"><span class="grow">Estado</span><span class="status" id="ac-status"></span></div>
				</div>
				<div id="ac-err"></div>
				<div class="section">Personalizar</div>
				<div class="group">
					<div class="item"><span>Nombre</span><input type="text" id="ac-name" style="text-align:right" value="${esc(a.name)}"></div>
					${colorPicker(a.color)}
					<div class="item"><span class="grow">Cambiar contraseña</span><input type="password" id="ac-pass" placeholder="(dejar vacío)" style="text-align:right" autocomplete="off"></div>
					<button class="btn" data-act="ac-save">Guardar</button>
				</div>
				<div class="group">
					<button class="btn" data-act="ac-reconnect">Reconectar</button>
					<button class="btn danger" data-act="ac-delete">Eliminar cuenta</button>
				</div>
			</div>`
		view.dataset.color = a.color
		bindColor(view, c => { view.dataset.color = c })
	}
	$('#ac-title').textContent = a.name
	$('#ac-status').textContent = statusText(a); $('#ac-status').style.color = statusColor(a)
	const err = $('#ac-err')
	const html = a.error ? `<p class="hint" style="color:var(--danger)">⚠︎ ${esc(a.error)}</p>` : ''
	if (err.innerHTML !== html) err.innerHTML = html
}
async function accountAction(act) {
	const id = Number(route().arg)
	try {
		if (act === 'ac-save') {
			const body = { name: $('#ac-name').value.trim(), color: $('#view').dataset.color }
			if ($('#ac-pass').value) body.pass = $('#ac-pass').value
			Object.assign(account(id), await api('PATCH', `/accounts/${id}`, body)); toast('Guardado'); render()
		} else if (act === 'ac-reconnect') {
			Object.assign(account(id), await api('POST', `/accounts/${id}/reconnect`)); render()
		} else if (act === 'ac-delete') {
			if (!confirm('Se quitará esta cuenta y sus correos guardados. ¿Continuar?')) return
			await api('DELETE', `/accounts/${id}`); S.accounts = S.accounts.filter(a => a.id !== id); await reloadThreads(); go('#/accounts')
		}
	} catch (e) { toast(e.message, 6000) }
}

// ---------- Ajustes ----------
function renderSettings() {
	const perm = 'Notification' in window ? Notification.permission : 'unsupported'
	$('#view').innerHTML = `
		<header class="bar"><h1>Ajustes</h1></header>
		<div style="min-height:100%">
			<div class="section">Notificaciones</div>
			<div class="group">${perm === 'granted' ? '<div class="item"><span class="grow">Notificaciones</span><span style="color:var(--accent)">Activadas</span></div>' : '<button class="btn" data-act="push">Activar notificaciones</button>'}</div>
			<p class="hint">${isStandalone() ? 'Recibirás avisos de correos nuevos aunque la app esté cerrada.' : 'En iPhone, primero añade la app a la pantalla de inicio y ábrela desde ahí.'}</p>
			<div class="section">Etiquetas</div>
			<div class="group">
				${S.labels.map(l => `<div class="item"><span class="tag solid" style="--c:${esc(l.color)}">${esc(l.name)}</span><span class="grow"></span><button class="icon-btn" data-act="del-label" data-val="${l.id}">🗑️</button></div>`).join('')}
				<div class="item"><input type="text" id="nl-name" placeholder="Nueva etiqueta (ej. Cliente, Pendiente)"></div>
				${colorPicker(COLORS[1])}
				<button class="btn" data-act="add-label">Agregar etiqueta</button>
			</div>
			<div class="section">Seguridad</div>
			<div class="group">
				<button class="btn" data-act="change-pw">Cambiar contraseña</button>
				<button class="btn danger" data-act="logout">Salir en este dispositivo</button>
			</div>
			<div style="height:30px"></div>
		</div>`
	$('#view').dataset.labelColor = COLORS[1]
	bindColor($('#view'), c => { $('#view').dataset.labelColor = c })
}
function b64ToUint8(b64) { const pad = '='.repeat((4 - b64.length % 4) % 4); const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)) }
async function enablePush() {
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('Añade la app a la pantalla de inicio y ábrela desde ahí.', 6000)
	const perm = await Notification.requestPermission()
	if (perm !== 'granted') return toast('Actívalas en Ajustes del iPhone › Notificaciones › MultiMail', 6000)
	try {
		const reg = await navigator.serviceWorker.ready
		const { key } = await api('GET', '/push/key')
		let sub = await reg.pushManager.getSubscription()
		if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) })
		await api('POST', '/push/subscribe', sub.toJSON()); toast('Notificaciones activadas ✅'); render()
	} catch (e) { toast('No se pudo activar: ' + e.message) }
}

// ---------- Etiquetas del hilo ----------
function openLabels() {
	const key = S.active, t = thread(key)
	if (!S.labels.length) return toast('Crea etiquetas en Ajustes')
	if (!t) return
	sheet('Etiquetas', `<div class="group">${S.labels.map(l => `<label class="item"><span class="tag solid" style="--c:${esc(l.color)}">${esc(l.name)}</span><span class="grow"></span><input type="checkbox" data-label="${l.id}" ${t.labelIds.includes(l.id) ? 'checked' : ''}></label>`).join('')}</div>`, el => {
		el.querySelectorAll('input[data-label]').forEach(cb => cb.onchange = async () => {
			const ids = [...el.querySelectorAll('input[data-label]:checked')].map(x => Number(x.dataset.label))
			try { upsertThread(await api('PUT', `/threads/${enc(key)}/labels`, { labelIds: ids })); const sub = $('#t-sub'); if (sub && S.threadData) sub.textContent = `${account(accOfKey(key))?.name || ''}${ids.length ? ' · ' + ids.map(label).filter(Boolean).map(l => l.name).join(', ') : ''}` } catch (e) { toast(e.message) }
		})
	})
}

// ---------- Hojas ----------
function sheet(title, html, bind) {
	closeSheet()
	const bg = document.createElement('div'); bg.className = 'sheet-bg'; bg.id = 'sheet'
	bg.innerHTML = `<div class="sheet"><header class="bar"><h1 style="font-size:18px">${esc(title)}</h1><button class="icon-btn" data-act="close-sheet">Cerrar</button></header>${html}</div>`
	bg.addEventListener('click', e => { if (e.target === bg) closeSheet() })
	document.body.appendChild(bg); bind?.(bg)
}
function closeSheet() { $('#sheet')?.remove() }

// ---------- Eventos ----------
document.addEventListener('click', async e => {
	const el = e.target.closest('[data-act]'); if (!el) return
	const act = el.dataset.act, val = el.dataset.val
	switch (act) {
		case 'go': return go(val)
		case 'back': return history.length > 1 ? history.back() : go('#/')
		case 'f-all': S.filter.account = null; S.filter.label = null; S.filter.unread = false; return renderInbox(false)
		case 'f-unread': S.filter.unread = !S.filter.unread; return renderInbox(false)
		case 'f-account': S.filter.account = S.filter.account === Number(val) ? null : Number(val); return renderInbox(false)
		case 'f-label': S.filter.label = S.filter.label === Number(val) ? null : Number(val); return renderInbox(false)
		case 'compose': return S.accounts.some(a => a.status === 'connected') ? openCompose() : toast('Primero agrega un correo')
		case 'do-send': return doSend()
		case 'reply': return startReply(false)
		case 'reply-all': return startReply(true)
		case 'forward': return startForward()
		case 'labels': return openLabels()
		case 'close-sheet': return closeSheet()
		case 'add-account': return openAddAccount()
		case 'ac-save': case 'ac-reconnect': case 'ac-delete': return accountAction(act)
		case 'push': return enablePush()
		case 'add-label': {
			const name = $('#nl-name').value.trim(); if (!name) return toast('Escribe un nombre')
			try { S.labels.push(await api('POST', '/labels', { name, color: $('#view').dataset.labelColor })); S.labels.sort((a, b) => a.name.localeCompare(b.name)); renderSettings() } catch (err) { toast(err.message) }
			return
		}
		case 'del-label': {
			if (!confirm('¿Borrar esta etiqueta?')) return
			await api('DELETE', `/labels/${val}`).catch(err => toast(err.message))
			S.labels = S.labels.filter(l => l.id !== Number(val)); if (S.filter.label === Number(val)) S.filter.label = null
			return renderSettings()
		}
		case 'change-pw': { const pw = prompt('Nueva contraseña (mínimo 6):'); if (!pw) return; try { await api('POST', '/password', { password: pw }); toast('Contraseña cambiada') } catch (err) { toast(err.message) } return }
		case 'logout': return confirm('¿Salir de MultiMail en este dispositivo?') && logout()
	}
})
window.addEventListener('hashchange', render)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.token) { if (!S.ws || S.ws.readyState !== 1) resync(); else reloadThreads().then(() => { if (route().name === 'inbox') renderInboxList() }) } })
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'open' && e.data.url) location.href = e.data.url })

async function boot() {
	if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
	if (!S.token) return showLogin()
	try { await loadAll() } catch (e) {
		if (!S.token) return
		$('#app').innerHTML = `<div class="empty"><div class="big">⚠️</div>No se pudo conectar con el servidor.<br><br><button class="btn primary" onclick="location.reload()">Reintentar</button></div>`
		return
	}
	lastRoute = ''; render(); connectWS()
}
boot()
