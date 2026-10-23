import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

// Todo cabe en un JSON pequeño: un solo usuario, un registro por día
fs.mkdirSync(DATA_DIR, { recursive: true })
const file = path.join(DATA_DIR, 'coach.json')

const initial = () => ({
	password: null,
	token: crypto.randomBytes(24).toString('hex'),
	ingestKey: crypto.randomBytes(12).toString('hex'),
	profile: { plan: '', about: '' },
	days: {},
	pushSubs: [],
	vapid: null,
})

export const state = fs.existsSync(file) ? { ...initial(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : initial()

export function save() {
	const tmp = file + '.tmp'
	fs.writeFileSync(tmp, JSON.stringify(state))
	fs.renameSync(tmp, file)
}
save()

export function getDay(day) {
	state.days[day] ??= { date: day, health: {}, healthRaw: [], foods: [], review: null }
	return state.days[day]
}
