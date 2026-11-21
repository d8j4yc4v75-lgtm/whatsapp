import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

// Limpieza de emergencia antes de abrir la base de datos: si el disco está lleno, el servidor no puede arrancar
const free = () => {
	try {
		const s = fs.statfsSync(DATA_DIR)
		return s.bavail / s.blocks
	} catch {
		return 1
	}
}

const rmOlder = (dir, maxAgeMs) => {
	if (!fs.existsSync(dir)) return 0
	let n = 0
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name)
		if (entry.isDirectory()) { n += rmOlder(p, maxAgeMs); continue }
		try {
			if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) { fs.rmSync(p, { force: true }); n++ }
		} catch {}
	}
	return n
}

const before = free()
if (before < 0.1) {
	const auth = path.join(DATA_DIR, 'auth')
	if (fs.existsSync(auth)) {
		for (const name of fs.readdirSync(auth)) {
			if (name.includes('-logout-')) fs.rmSync(path.join(auth, name), { recursive: true, force: true })
		}
	}
	const media = path.join(DATA_DIR, 'media')
	let removed = rmOlder(media, 864e5)
	if (free() < 0.05) removed += rmOlder(media, 0)
	console.log(`Limpieza de emergencia: libre ${(before * 100).toFixed(1)}% -> ${(free() * 100).toFixed(1)}%, ${removed} archivos multimedia borrados`)
}
