import readXlsxFile from 'read-excel-file/node'
import { db } from './db.js'

const HEADERS = ['NOMBRE', 'MONTO', 'TELEFONO', 'FECHA']
const DAY = 86_400_000

const headerName = value => String(value ?? '').trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase()
const dateKey = date => date.toISOString().slice(0, 10)

function dueDate(value) {
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? dateKey(value) : null
	const text = String(value ?? '').trim()
	const iso = text.match(/^(\d{4})-(\d\d)-(\d\d)$/)
	const local = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
	if (!iso && !local) return null
	const [year, month, day] = iso ? iso.slice(1) : [local[3], local[2], local[1]]
	const key = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
	const parsed = new Date(`${key}T00:00:00Z`)
	return Number.isFinite(parsed.getTime()) && dateKey(parsed) === key ? key : null
}

function moneyAmount(value) {
	if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
	const text = String(value ?? '').trim()
	if (!/^\$?\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null
	const amount = Number(text.replace(/[$,\s]/g, ''))
	return Number.isFinite(amount) ? amount : null
}

function phoneKey(value) {
	const text = String(value ?? '').trim()
	if (!/^\+?[\d\s().-]+$/.test(text)) return null
	const digits = text.replace(/\D/g, '')
	if (digits.length === 10 && !text.startsWith('+')) return `52${digits}`
	if (/^521\d{10}$/.test(digits)) return `52${digits.slice(3)}`
	return /^\d{11,15}$/.test(digits) ? digits : null
}

function matchChats(phones) {
	const matches = new Map()
	if (!phones.size) return matches
	const pending = new Set(db.prepare('SELECT DISTINCT conv_key FROM reminders WHERE done = 0').pluck().all())
	const inbound = db.prepare('SELECT 1 FROM messages WHERE account_id = ? AND jid = ? AND from_me = 0 AND deleted = 0 LIMIT 1')
	const rows = db.prepare(`
		SELECT account_id, jid FROM chats WHERE jid LIKE '%@s.whatsapp.net'
		ORDER BY last_ts DESC, account_id`).all()
	for (const row of rows) {
		const phone = phoneKey(row.jid.split('@')[0])
		if (!phones.has(phone)) continue
		const previous = matches.get(phone)
		const key = `${row.account_id}:${row.jid}`
		matches.set(phone, {
			chatKey: previous?.chatKey || key,
			replied: Boolean(previous?.replied || inbound.get(row.account_id, row.jid)),
			followup: Boolean(previous?.followup || pending.has(key))
		})
	}
	return matches
}

export async function previewPaymentExcel(buffer, now = Date.now()) {
	if (!buffer) throw new Error('Selecciona un archivo .xlsx')
	let cells
	try { cells = await readXlsxFile(buffer) } catch { throw new Error('No se pudo leer el archivo .xlsx') }
	const headerRow = cells.findIndex(row => row.some(value => value !== null && String(value).trim()))
	const headings = (cells[headerRow] || []).map(headerName)
	const column = HEADERS.map(header => headings.indexOf(header))
	if (column.some((index, i) => index === -1 || index !== headings.lastIndexOf(HEADERS[i]))) {
		throw new Error('La primera hoja debe incluir una columna de cada tipo: NOMBRE, MONTO, TELEFONO y FECHA')
	}
	let total = 0
	let invalid = 0
	const rows = []
	for (let i = headerRow + 1; i < cells.length; i++) {
		const fields = column.map(index => cells[i][index])
		if (fields.every(value => value == null || String(value).trim() === '')) continue
		total++
		const name = String(fields[0] ?? '').trim()
		const amount = moneyAmount(fields[1])
		const phone = phoneKey(fields[2])
		const due = dueDate(fields[3])
		if (!name || amount === null || !phone || !due) { invalid++; continue }
		rows.push({ row: i + 1, name, amount, phone, due })
	}
	const matches = matchChats(new Set(rows.map(row => row.phone)))
	const localNow = now + Number(process.env.TZ_OFFSET_HOURS || -6) * 3_600_000
	const today = dateKey(new Date(localNow))
	const nextWeek = dateKey(new Date(localNow + 7 * DAY))
	const dates = { past: 0, today: 0, next7: 0 }
	let matched = 0
	let replied = 0
	let followups = 0
	for (const row of rows) {
		if (row.due < today) dates.past++
		else if (row.due === today) dates.today++
		else if (row.due <= nextWeek) dates.next7++
		Object.assign(row, matches.get(row.phone) || { chatKey: null, replied: false, followup: false })
		matched += Number(Boolean(row.chatKey))
		replied += Number(row.replied)
		followups += Number(row.followup)
	}
	rows.sort((a, b) => a.due.localeCompare(b.due) || a.row - b.row)
	return { total, invalid, matched, replied, followups, dates, rows: rows.slice(0, 100) }
}
