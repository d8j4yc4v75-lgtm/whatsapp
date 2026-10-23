const $ = id => document.getElementById(id)
let token = localStorage.getItem('coach-token')
let today = null
let current = null
let day = null
let info = null
let photoData = null

// ---------- API ----------
async function api(path, opts = {}) {
	const res = await fetch(path, {
		method: opts.method || (opts.body ? 'POST' : 'GET'),
		headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	})
	const data = await res.json().catch(() => ({}))
	if (res.status === 401 && path !== '/api/login') { logout(); throw new Error('Inicia sesión') }
	if (!res.ok) throw new Error(data.error || 'Error de conexión')
	return data
}

function status(id, text, err = false) {
	const el = $(id)
	el.textContent = text
	el.classList.toggle('err', err)
}

// ---------- Fechas ----------
const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d) }
const shift = (k, n) => { const d = parseDay(k); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const longDate = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long' })
function label(k) {
	if (k === today) return 'Hoy'
	if (k === shift(today, -1)) return 'Ayer'
	return longDate.format(parseDay(k))
}
function ago(iso) {
	if (!iso) return null
	const min = Math.round((Date.now() - new Date(iso)) / 60000)
	if (min < 2) return 'hace un momento'
	if (min < 60) return `hace ${min} min`
	if (min < 60 * 24) return `hace ${Math.round(min / 60)} h`
	return new Date(iso).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
const n0 = v => (v == null ? null : Math.round(Number(v)).toLocaleString('es'))
const hm = min => (min == null ? null : `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')}`)

// ---------- Inicio y sesión ----------
async function start() {
	if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
	if (!token) return showLogin()
	try {
		info = await api('/api/state')
	} catch {
		return showLogin()
	}
	today = info.today
	$('login').hidden = true
	$('app').hidden = false
	$('plan').value = info.profile.plan
	$('about').value = info.profile.about
	$('ingestUrl').value = info.ingestUrl
	$('lastHealth').textContent = info.lastHealthAt ? `Último envío del atajo: ${ago(info.lastHealthAt)}` : 'Todavía no llega ningún envío del atajo.'
	$('setupBanner').hidden = !!info.lastHealthAt
	const params = new URLSearchParams(location.search)
	await goTo(params.get('day') || today)
}

async function showLogin() {
	$('app').hidden = true
	$('login').hidden = false
	const { hasPassword } = await fetch('/api/status').then(r => r.json())
	$('loginHint').textContent = hasPassword ? 'Escribe tu contraseña.' : 'Crea una contraseña para proteger tus datos (mínimo 6 caracteres).'
	$('loginBtn').textContent = hasPassword ? 'Entrar' : 'Crear contraseña'
	$('loginBtn').onclick = async () => {
		try {
			const r = await api(hasPassword ? '/api/login' : '/api/setup', { body: { password: $('password').value } })
			token = r.token
			localStorage.setItem('coach-token', token)
			start()
		} catch (e) {
			status('loginStatus', e.message, true)
		}
	}
}

function logout() {
	token = null
	localStorage.removeItem('coach-token')
	showLogin()
}

// ---------- Día ----------
async function goTo(k) {
	current = k
	$('dayLabel').textContent = label(k)
	$('nextDay').disabled = k >= today
	day = await api('/api/day/' + k)
	renderHealth()
	renderReview()
	renderFoods()
}

function renderHealth() {
	const h = day.health || {}
	const items = [
		['Sueño', hm(h.sueno_min), ''],
		['Profundo / REM', h.profundo_min != null || h.rem_min != null ? `${n0(h.profundo_min) ?? '—'} / ${n0(h.rem_min) ?? '—'}` : null, 'min'],
		['Pasos', n0(h.pasos), ''],
		['Kcal activas', n0(h.kcal_activas), 'kcal'],
		['Gasto total', n0(h.kcal_totales), 'kcal'],
		['Ejercicio', n0(h.ejercicio_min), 'min'],
		['FC reposo', n0(h.fc_reposo), 'lpm'],
		['Peso', h.peso_kg != null ? Number(h.peso_kg).toLocaleString('es', { maximumFractionDigits: 1 }) : null, 'kg'],
	]
	$('metrics').replaceChildren(...items.map(([k, v, u]) => {
		const el = document.createElement('div')
		el.className = 'metric'
		const kk = document.createElement('span'); kk.className = 'k'; kk.textContent = k
		const vv = document.createElement('span'); vv.className = 'v' + (v == null ? ' empty' : ''); vv.textContent = v ?? '—'
		if (v != null && u) { const uu = document.createElement('span'); uu.className = 'u'; uu.textContent = ' ' + u; vv.append(uu) }
		el.append(kk, vv)
		return el
	}))
	const w = h.entrenamientos || []
	const sleep = h.hora_dormir && h.hora_despertar ? `Dormiste ${h.hora_dormir} → ${h.hora_despertar}. ` : ''
	$('workouts').textContent = sleep + (w.length ? 'Entrenamientos: ' + w.map(x => `${x.tipo}${x.min ? ` ${Math.round(x.min)} min` : ''}${x.kcal ? `, ${Math.round(x.kcal)} kcal` : ''}`).join(' · ') : '')
	$('healthAt').textContent = day.healthAt ? `Recibido ${ago(day.healthAt)}` : 'Sin datos de este día'
}

function renderReview() {
	const r = day.review
	const box = $('review')
	box.replaceChildren()
	$('analyze').textContent = r ? 'Volver a analizar' : 'Analizar ahora'
	if (!r) {
		const p = document.createElement('p')
		p.className = 'muted'
		p.textContent = `Cada noche, cuando llegan tus datos de Salud, el coach evalúa tu día y te manda una notificación. También puedes analizarlo cuando quieras.`
		box.append(p)
		return
	}
	const color = r.puntuacion >= 7 ? 'var(--good)' : r.puntuacion >= 5 ? 'var(--warn)' : 'var(--bad)'
	const score = document.createElement('div')
	score.className = 'score'
	const b = document.createElement('b'); b.style.color = color; b.textContent = r.puntuacion
	const s = document.createElement('span'); s.textContent = '/ 10'
	score.append(b, s)
	const sum = document.createElement('p'); sum.textContent = r.resumen
	box.append(score, sum)
	if (r.kcal_ingeridas || r.proteina_g) {
		const pill = document.createElement('span')
		pill.className = 'pill'
		pill.textContent = [r.kcal_ingeridas && `≈ ${n0(r.kcal_ingeridas)} kcal comidas`, r.proteina_g && `≈ ${n0(r.proteina_g)} g proteína`].filter(Boolean).join(' · ')
		box.append(pill)
	}
	for (const [title, list, cls] of [['Lo que hiciste bien', r.bien, 'good'], ['Lo que debes mejorar', r.mal, 'bad'], ['Para mañana', r.manana, 'next']]) {
		if (!list?.length) continue
		const h = document.createElement('h3'); h.textContent = title
		const ul = document.createElement('ul'); ul.className = 'points ' + cls
		for (const t of list) { const li = document.createElement('li'); li.textContent = t; ul.append(li) }
		box.append(h, ul)
	}
}

function renderFoods() {
	const foods = [...(day.foods || [])].sort((a, b) => a.time.localeCompare(b.time))
	const ul = $('foods')
	ul.replaceChildren()
	if (!foods.length) {
		const li = document.createElement('li')
		li.className = 'muted'
		li.textContent = 'Sin comidas este día. Toma una foto de tu plato arriba.'
		ul.append(li)
	}
	for (const f of foods) {
		const li = document.createElement('li')
		const meal = document.createElement('div'); meal.className = 'meal'; meal.textContent = `${f.time} · ${f.meal}`
		const text = document.createElement('div'); text.textContent = f.text
		const macros = document.createElement('div'); macros.className = 'macros'
		macros.textContent = [f.kcal != null && `≈ ${n0(f.kcal)} kcal`, f.proteina_g != null && `P ${n0(f.proteina_g)} g`, f.carbohidratos_g != null && `C ${n0(f.carbohidratos_g)} g`, f.grasa_g != null && `G ${n0(f.grasa_g)} g`].filter(Boolean).join(' · ')
		const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Borrar')
		x.onclick = async () => {
			await api(`/api/day/${current}/foods/${f.id}`, { method: 'DELETE' })
			day.foods = day.foods.filter(y => y.id !== f.id)
			renderFoods()
		}
		li.append(meal, x, text, macros)
		ul.append(li)
	}
	const kcal = foods.reduce((s, f) => s + (Number(f.kcal) || 0), 0)
	const prot = foods.reduce((s, f) => s + (Number(f.proteina_g) || 0), 0)
	$('foodTotals').textContent = foods.length ? `≈ ${n0(kcal)} kcal · ${n0(prot)} g proteína` : ''
}

async function renderHistory() {
	const list = await api('/api/days')
	const ul = $('history')
	ul.replaceChildren()
	if (!list.length) {
		const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'Aún no hay días registrados.'
		ul.append(li)
	}
	for (const d of list) {
		const li = document.createElement('li')
		const b = document.createElement('button')
		const n = document.createElement('span'); n.className = 'n'; n.textContent = d.score ?? '—'
		n.style.color = d.score == null ? 'var(--muted)' : d.score >= 7 ? 'var(--good)' : d.score >= 5 ? 'var(--warn)' : 'var(--bad)'
		const t = document.createElement('span')
		const title = document.createElement('b'); title.textContent = label(d.date)
		const s = document.createElement('span'); s.className = 's'; s.textContent = d.summary || `${d.foods} comidas · sin evaluar`
		t.append(title, document.createElement('br'), s)
		b.append(n, t)
		b.onclick = () => { show('hoy'); goTo(d.date) }
		li.append(b)
		ul.append(li)
	}
}

// ---------- Navegación ----------
function show(view) {
	for (const b of document.querySelectorAll('nav.tabs button')) b.toggleAttribute('aria-current', b.dataset.view === view)
	for (const m of document.querySelectorAll('.view')) m.hidden = m.id !== 'view-' + view
	$('daybar').parentElement.hidden = !['hoy', 'comidas'].includes(view)
	if (view === 'historial') renderHistory()
	scrollTo(0, 0)
}
for (const b of document.querySelectorAll('nav.tabs button')) b.onclick = () => show(b.dataset.view)
$('prevDay').onclick = () => goTo(shift(current, -1))
$('nextDay').onclick = () => current < today && goTo(shift(current, 1))

// ---------- Acciones ----------
$('analyze').onclick = async () => {
	$('analyze').disabled = true
	status('analyzeStatus', 'Tu coach está revisando el día… (puede tardar un minuto)')
	try {
		day.review = await api(`/api/day/${current}/review`, { body: {} })
		renderReview()
		status('analyzeStatus', '')
	} catch (e) {
		status('analyzeStatus', e.message, true)
	} finally {
		$('analyze').disabled = false
	}
}

// Reduce la foto en el iPhone antes de subirla (máx. 1280 px, JPEG)
function shrink(file, max = 1280) {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => {
			const k = Math.min(1, max / Math.max(img.width, img.height))
			const c = document.createElement('canvas')
			c.width = Math.round(img.width * k)
			c.height = Math.round(img.height * k)
			c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
			URL.revokeObjectURL(img.src)
			resolve(c.toDataURL('image/jpeg', 0.82))
		}
		img.onerror = reject
		img.src = URL.createObjectURL(file)
	})
}
const readAsDataUrl = file => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file) })

$('photo').onchange = async e => {
	const file = e.target.files[0]
	if (!file) return
	photoData = await shrink(file)
	$('photoPreview').src = photoData
	$('photoPreview').hidden = false
	$('photoLabel').textContent = 'Cambiar foto'
}

$('addFood').onclick = async () => {
	const text = $('foodText').value.trim()
	if (!text && !photoData) return status('foodStatus', 'Toma una foto o escribe qué comiste.', true)
	$('addFood').disabled = true
	status('foodStatus', 'Calculando calorías…')
	try {
		const food = await api(`/api/day/${current}/foods`, { body: { meal: $('meal').value, time: $('time').value, text, photo: photoData } })
		day.foods.push(food)
		renderFoods()
		$('foodText').value = ''
		photoData = null
		$('photo').value = ''
		$('photoPreview').hidden = true
		$('photoLabel').textContent = '📷 Tomar foto del plato'
		status('foodStatus', `Guardado: ${food.text}`)
	} catch (e) {
		status('foodStatus', e.message, true)
	} finally {
		$('addFood').disabled = false
	}
}

$('planFile').onchange = async e => {
	const file = e.target.files[0]
	if (!file) return
	status('planStatus', 'Leyendo tu plan…')
	try {
		const data = file.type === 'application/pdf' ? await readAsDataUrl(file) : await shrink(file, 2000)
		const { text } = await api('/api/plan/transcribe', { body: { file: data } })
		$('plan').value = ($('plan').value.trim() ? $('plan').value.trim() + '\n\n' : '') + text
		status('planStatus', 'Listo. Revisa el texto y toca «Guardar plan».')
	} catch (err) {
		status('planStatus', err.message, true)
	}
	e.target.value = ''
}

$('savePlan').onclick = async () => {
	try {
		await api('/api/profile', { method: 'PUT', body: { plan: $('plan').value, about: $('about').value } })
		status('planStatus', 'Plan guardado.')
	} catch (e) {
		status('planStatus', e.message, true)
	}
}

$('copyUrl').onclick = async () => {
	try {
		await navigator.clipboard.writeText($('ingestUrl').value)
		$('copyUrl').textContent = 'Copiado'
	} catch {
		$('ingestUrl').select()
	}
}

$('enablePush').onclick = async () => {
	try {
		if (!('PushManager' in window)) throw new Error('Instala la app con «Añadir a pantalla de inicio» y ábrela desde el ícono.')
		const perm = await Notification.requestPermission()
		if (perm !== 'granted') throw new Error('Permiso denegado. Actívalo en Ajustes del iPhone › Notificaciones › Coach.')
		const reg = await navigator.serviceWorker.ready
		const b64 = info.vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/')
		const key = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), c => c.charCodeAt(0))
		const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
		await api('/api/push/subscribe', { body: sub.toJSON() })
		await api('/api/push/test', { body: {} })
		status('pushStatus', 'Listo. Te llegó una notificación de prueba.')
	} catch (e) {
		status('pushStatus', e.message, true)
	}
}

$('logout').onclick = logout

// Hora y comida por defecto según la hora actual
const now = new Date()
$('time').value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
const h = now.getHours()
$('meal').value = h < 11 ? 'Desayuno' : h < 13 ? 'Media mañana' : h < 17 ? 'Comida' : h < 20 ? 'Merienda' : 'Cena'

start()
