import crypto from 'node:crypto'
import { state, save } from './store.js'

const hash = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex')

export const hasPassword = () => !!state.password

export function setupPassword(password) {
	if (hasPassword()) throw Object.assign(new Error('La contraseña ya fue creada'), { status: 400 })
	if (String(password || '').length < 6) throw Object.assign(new Error('La contraseña debe tener al menos 6 caracteres'), { status: 400 })
	const salt = crypto.randomBytes(16).toString('hex')
	state.password = { salt, hash: hash(String(password), salt) }
	save()
	return state.token
}

export async function login(password) {
	if (!hasPassword()) throw Object.assign(new Error('Primero crea una contraseña'), { status: 400 })
	const { salt, hash: expected } = state.password
	const ok = crypto.timingSafeEqual(Buffer.from(hash(String(password || ''), salt), 'hex'), Buffer.from(expected, 'hex'))
	if (!ok) {
		// Freno simple contra intentos repetidos
		await new Promise(r => setTimeout(r, 1500))
		throw Object.assign(new Error('Contraseña incorrecta'), { status: 401 })
	}
	return state.token
}

const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function requireAuth(req, res, next) {
	const token = (req.get('authorization') || '').replace(/^Bearer /, '')
	if (token && same(token, state.token)) return next()
	res.status(401).json({ error: 'Inicia sesión' })
}

export function requireIngestKey(req, res, next) {
	const key = String(req.query.key || req.get('x-coach-key') || '')
	if (key && same(key, state.ingestKey)) return next()
	res.status(401).json({ error: 'Clave del atajo incorrecta' })
}
