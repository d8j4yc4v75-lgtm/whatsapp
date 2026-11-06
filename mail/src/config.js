import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Carga simple de server/.env (KEY=VALUE por línea) sin dependencias
const envFile = path.join(root, '.env')
if (fs.existsSync(envFile)) {
	for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
		if (m && process.env[m[1]] === undefined) {
			process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
		}
	}
}

export const DATA_DIR = path.resolve(root, process.env.DATA_DIR || 'data')
export const PORT = Number(process.env.PORT || 3000)

// Si no hay token configurado se genera uno y se guarda en data/token.txt
fs.mkdirSync(DATA_DIR, { recursive: true })
const tokenFile = path.join(DATA_DIR, 'token.txt')
let token = process.env.API_TOKEN
if (!token) {
	if (!fs.existsSync(tokenFile)) {
		fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('hex'))
	}
	token = fs.readFileSync(tokenFile, 'utf8').trim()
}
export const API_TOKEN = token
