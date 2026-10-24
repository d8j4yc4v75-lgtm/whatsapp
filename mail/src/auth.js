import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API_TOKEN, DATA_DIR } from './config.js'

// La contraseña la crea el dueño la primera vez que abre la web app
const file = path.join(DATA_DIR, 'password.json')

const hash = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex')

export function hasPassword() {
	return fs.existsSync(file)
}

export function setupPassword(password) {
	if (hasPassword()) throw new Error('La contraseña ya fue creada')
	if (String(password || '').length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres')
	const salt = crypto.randomBytes(16).toString('hex')
	fs.writeFileSync(file, JSON.stringify({ salt, hash: hash(String(password), salt) }))
	return API_TOKEN
}

export async function login(password) {
	if (!hasPassword()) throw new Error('Primero crea una contraseña')
	const { salt, hash: expected } = JSON.parse(fs.readFileSync(file, 'utf8'))
	const ok = crypto.timingSafeEqual(Buffer.from(hash(String(password || ''), salt), 'hex'), Buffer.from(expected, 'hex'))
	if (!ok) {
		// Freno simple contra intentos repetidos
		await new Promise(r => setTimeout(r, 1500))
		throw Object.assign(new Error('Contraseña incorrecta'), { status: 401 })
	}
	return API_TOKEN
}

export function changePassword(password) {
	if (String(password || '').length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres')
	const salt = crypto.randomBytes(16).toString('hex')
	fs.writeFileSync(file, JSON.stringify({ salt, hash: hash(String(password), salt) }))
}
