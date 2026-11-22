import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { hasFfmpeg } from './ffmpeg.js'

// Miniatura del mapa (JPEG) que acompaña a las ubicaciones, como la que manda la app del teléfono.
// Sin ella, en algunos teléfonos la burbuja se ve con el mapa gris. Si algo falla (sin internet, sin ffmpeg,
// mosaicos lentos) se manda sin miniatura: nunca impide mandar la ubicación.

const ZOOM = 16
const SIZE = 200
const cache = new Map()

const proj = (lat, lng, z) => {
	const n = 2 ** z * 256, r = lat * Math.PI / 180
	return { x: (lng + 180) / 360 * n, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n }
}

async function tile(z, x, y, signal) {
	const n = 2 ** z
	const res = await fetch(`https://tile.openstreetmap.org/${z}/${((x % n) + n) % n}/${Math.max(0, Math.min(n - 1, y))}.png`, {
		headers: { 'User-Agent': 'MultiWA/1.0 (vista previa de ubicacion)' },
		signal
	})
	if (!res.ok) throw new Error(`mosaico ${res.status}`)
	return Buffer.from(await res.arrayBuffer())
}

function ffmpeg(args) {
	return new Promise((resolve, reject) => execFile('ffmpeg', ['-y', '-loglevel', 'error', ...args], { timeout: 5000 }, err => (err ? reject(err) : resolve())))
}

async function build(lat, lng) {
	if (!(await hasFfmpeg())) return null
	const p = proj(Math.max(-85, Math.min(85, lat)), lng, ZOOM)
	const tx = Math.floor(p.x / 256), ty = Math.floor(p.y / 256)
	// 2×2 mosaicos con el punto lo más al centro posible
	const x0 = p.x - tx * 256 < 128 ? tx - 1 : tx
	const y0 = p.y - ty * 256 < 128 ? ty - 1 : ty
	const signal = AbortSignal.timeout(4000)
	const tiles = await Promise.all([[x0, y0], [x0 + 1, y0], [x0, y0 + 1], [x0 + 1, y0 + 1]].map(([x, y]) => tile(ZOOM, x, y, signal)))
	const cx = Math.round(p.x - x0 * 256), cy = Math.round(p.y - y0 * 256)
	const half = SIZE / 2
	const left = Math.max(0, Math.min(512 - SIZE, cx - half)), top = Math.max(0, Math.min(512 - SIZE, cy - half))
	const tmp = path.join(os.tmpdir(), `multiwa-map-${crypto.randomUUID()}`)
	const files = tiles.map((b, i) => { const f = `${tmp}-${i}.png`; fs.writeFileSync(f, b); return f })
	const out = `${tmp}.jpg`
	// Pin: círculo rojo con borde blanco en el punto exacto
	const R = 9, B = 12, D = B * 2
	const pin = `color=c=black@0:s=${D}x${D},format=rgba,geq=r='if(lte(hypot(X-${B},Y-${B}),${R}),234,255)':g='if(lte(hypot(X-${B},Y-${B}),${R}),67,255)':b='if(lte(hypot(X-${B},Y-${B}),${R}),53,255)':a='if(lte(hypot(X-${B},Y-${B}),${B}),255,0)'`
	try {
		await ffmpeg([
			...files.flatMap(f => ['-i', f]),
			'-f', 'lavfi', '-i', pin,
			'-filter_complex',
			`[0:v][1:v]hstack[t];[2:v][3:v]hstack[b];[t][b]vstack,format=rgba,crop=${SIZE}:${SIZE}:${left}:${top}[m];[m][4:v]overlay=${cx - left - B}:${cy - top - B}:shortest=1,format=yuvj420p`,
			'-frames:v', '1', '-q:v', '5', out
		])
		return fs.readFileSync(out)
	} finally {
		for (const f of [...files, out]) fs.rmSync(f, { force: true })
	}
}

/** Miniatura JPEG del mapa con el pin en el punto, o null si no se pudo hacer a tiempo */
export async function mapThumbnail(lat, lng) {
	const key = `${lat.toFixed(5)},${lng.toFixed(5)}`
	if (cache.has(key)) return cache.get(key)
	let jpeg = null
	// Como máximo 5 s: si tarda más, se manda sin miniatura
	try { jpeg = await Promise.race([build(lat, lng), new Promise(r => setTimeout(r, 5000).unref?.()).then(() => null)]) } catch { jpeg = null }
	if (jpeg && jpeg.length < 60000) {
		cache.set(key, jpeg)
		if (cache.size > 100) cache.delete(cache.keys().next().value)
		return jpeg
	}
	return null
}
