import crypto from 'node:crypto'
import path from 'node:path'
import express from 'express'
import { PORT, REVIEW_HOUR } from './config.js'
import { state, save, getDay } from './store.js'
import { hasPassword, setupPassword, login, requireAuth, requireIngestKey } from './auth.js'
import { publicKey, subscribe, notify } from './push.js'
import { parseHealth, estimateFood, transcribePlan, reviewDay } from './claude.js'
import { localNow, isDay } from './dates.js'

const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '15mb' }))
app.use(express.urlencoded({ extended: true, limit: '5mb' }))
// Cualquier otro cuerpo (p. ej. «Archivo» de Atajos) llega como texto
app.use(express.text({ type: () => true, limit: '5mb' }))

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const dayParam = req => {
	if (!isDay(req.params.day)) throw Object.assign(new Error('Fecha inválida'), { status: 400 })
	return req.params.day
}

app.get('/health', (_req, res) => res.json({ ok: true }))

// ---------- Sesión ----------
app.get('/api/status', (_req, res) => res.json({ hasPassword: hasPassword() }))
app.post('/api/setup', (req, res) => res.json({ token: setupPassword(req.body.password) }))
app.post('/api/login', wrap(async (req, res) => res.json({ token: await login(req.body.password) })))

// ---------- Atajo de Apple Salud ----------
// El atajo manda lo que tenga (texto, formulario o JSON); Claude lo convierte en métricas.
app.post('/api/ingest/health', requireIngestKey, wrap(async (req, res) => {
	const now = localNow()
	const day = isDay(req.query.date) ? req.query.date : now.day
	const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
	if (!raw || raw === '{}') return res.status(400).json({ error: 'El atajo no envió datos' })

	const d = getDay(day)
	d.healthRaw = [raw.slice(0, 60000)]
	d.health = await parseHealth(raw, day)
	d.healthAt = new Date().toISOString()
	save()
	res.json({ ok: true, day, health: d.health })

	// Por la noche (o si es un día pasado) el envío del atajo cierra el día: evaluar y avisar
	if (day < now.day || now.hour >= REVIEW_HOUR - 2) runReview(day, true).catch(e => console.error('review', e))
}))

// ---------- App ----------
app.use('/api', requireAuth)

app.get('/api/state', (req, res) => {
	const base = `${req.protocol}://${req.get('host')}`
	res.json({
		today: localNow().day,
		profile: state.profile,
		ingestUrl: `${base}/api/ingest/health?key=${state.ingestKey}`,
		vapidPublicKey: publicKey(),
		reviewHour: REVIEW_HOUR,
		lastHealthAt: Object.values(state.days).map(d => d.healthAt).filter(Boolean).sort().pop() || null,
	})
})

app.get('/api/days', (_req, res) => {
	const list = Object.values(state.days)
		.filter(d => d.review || d.foods.length || Object.keys(d.health || {}).length)
		.sort((a, b) => b.date.localeCompare(a.date))
		.map(d => ({ date: d.date, score: d.review?.puntuacion ?? null, summary: d.review?.resumen || '', foods: d.foods.length, hasHealth: !!d.healthAt }))
	res.json(list)
})

app.get('/api/day/:day', (req, res) => res.json(state.days[dayParam(req)] || { date: req.params.day, health: {}, foods: [], review: null }))

app.post('/api/day/:day/foods', wrap(async (req, res) => {
	const day = dayParam(req)
	const { meal, time, text, photo } = req.body
	if (!String(text || '').trim() && !photo) return res.status(400).json({ error: 'Escribe la comida o toma una foto' })
	const est = await estimateFood(String(text || '').trim(), photo)
	const food = {
		id: crypto.randomBytes(6).toString('hex'),
		meal: String(meal || 'Comida'),
		time: String(time || localNow().hour + ':00'),
		text: String(text || '').trim() || est.descripcion,
		detail: est.descripcion,
		kcal: est.kcal, proteina_g: est.proteina_g, carbohidratos_g: est.carbohidratos_g, grasa_g: est.grasa_g,
	}
	getDay(day).foods.push(food)
	save()
	res.json(food)
}))

app.delete('/api/day/:day/foods/:id', (req, res) => {
	const d = getDay(dayParam(req))
	d.foods = d.foods.filter(f => f.id !== req.params.id)
	save()
	res.json({ ok: true })
})

app.post('/api/day/:day/review', wrap(async (req, res) => res.json(await runReview(dayParam(req), false))))

app.put('/api/profile', (req, res) => {
	state.profile = { plan: String(req.body.plan || ''), about: String(req.body.about || '') }
	save()
	res.json(state.profile)
})

app.post('/api/plan/transcribe', wrap(async (req, res) => res.json({ text: await transcribePlan(req.body.file) })))

app.post('/api/ingest-key/rotate', (_req, res) => {
	state.ingestKey = crypto.randomBytes(12).toString('hex')
	save()
	res.json({ ok: true })
})

app.post('/api/push/subscribe', (req, res) => {
	subscribe(req.body)
	res.json({ ok: true })
})
app.post('/api/push/test', wrap(async (_req, res) => {
	await notify('Coach', 'Las notificaciones funcionan.')
	res.json({ ok: true })
}))

// ---------- Evaluación ----------
const running = new Map()
function runReview(day, push) {
	if (running.has(day)) return running.get(day)
	const job = (async () => {
		const d = getDay(day)
		const previous = Object.values(state.days).filter(p => p.date < day).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7)
		const review = await reviewDay(d, state.profile, previous)
		d.review = { ...review, at: new Date().toISOString() }
		save()
		if (push) await notify(`Tu día: ${review.puntuacion}/10`, review.resumen, `/?day=${day}`)
		return d.review
	})().finally(() => running.delete(day))
	running.set(day, job)
	return job
}

// Respaldo: si a la hora de evaluación el día tiene datos y no se evaluó, evaluarlo
setInterval(() => {
	const now = localNow()
	if (now.hour !== REVIEW_HOUR || now.minute !== 30) return
	const d = state.days[now.day]
	if (d && !d.review && (d.foods.length || d.healthAt)) runReview(now.day, true).catch(e => console.error('review', e))
	// Y un recordatorio si hoy no llegó nada
	if (!d || (!d.foods.length && !d.healthAt)) notify('Coach', 'Hoy no tengo datos tuyos. Revisa que el atajo de Salud se haya ejecutado y anota tus comidas.').catch(() => {})
}, 60_000)

// ---------- Web app ----------
app.use(express.static(path.resolve('public'), { index: 'index.html' }))

app.use((err, _req, res, _next) => {
	console.error(err)
	const status = err.status || (err instanceof SyntaxError ? 400 : 500)
	res.status(status).json({ error: status === 500 ? 'Error del servidor: ' + (err.message || 'desconocido') : err.message })
})

app.listen(PORT, () => console.log(`Coach escuchando en el puerto ${PORT}`))
