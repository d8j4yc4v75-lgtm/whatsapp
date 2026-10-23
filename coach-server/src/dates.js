import { TZ } from './config.js'

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

// Fecha (YYYY-MM-DD) y hora local en la zona del usuario
export function localNow(date = new Date()) {
	const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]))
	return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) }
}

export const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
