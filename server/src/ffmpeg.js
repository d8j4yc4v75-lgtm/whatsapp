import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

let available
export function hasFfmpeg() {
	if (available === undefined) {
		available = new Promise(resolve => execFile('ffmpeg', ['-version'], err => resolve(!err)))
	}
	return available
}

function run(args) {
	return new Promise((resolve, reject) =>
		execFile('ffmpeg', ['-y', '-loglevel', 'error', ...args], err => (err ? reject(err) : resolve())))
}

/** Convierte audio (p. ej. m4a grabado en el iPhone) a ogg/opus, el formato de las notas de voz de WhatsApp */
export async function toOpus(buffer) {
	const tmp = path.join(os.tmpdir(), `multiwa-${crypto.randomUUID()}`)
	fs.writeFileSync(`${tmp}.in`, buffer)
	try {
		await run(['-i', `${tmp}.in`, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', `${tmp}.ogg`])
		return fs.readFileSync(`${tmp}.ogg`)
	} finally {
		fs.rmSync(`${tmp}.in`, { force: true })
		fs.rmSync(`${tmp}.ogg`, { force: true })
	}
}

/** Convierte un archivo a m4a/aac para que el iPhone pueda reproducirlo (iOS no reproduce ogg/opus) */
export async function toM4a(file) {
	const out = file.replace(/\.[^.]+$/, '') + '.play.m4a'
	if (!fs.existsSync(out)) await run(['-i', file, '-vn', '-c:a', 'aac', '-b:a', '64k', out])
	return out
}

/** Convierte un video (p. ej. .mov HEVC del iPhone) a MP4 H.264, el formato que acepta WhatsApp */
export async function toMp4(buffer) {
	const tmp = path.join(os.tmpdir(), `multiwa-${crypto.randomUUID()}`)
	fs.writeFileSync(`${tmp}.in`, buffer)
	try {
		await run(['-i', `${tmp}.in`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
			'-vf', 'scale=trunc(min(iw\\,1280)/2)*2:-2', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', `${tmp}.mp4`])
		return fs.readFileSync(`${tmp}.mp4`)
	} finally {
		fs.rmSync(`${tmp}.in`, { force: true })
		fs.rmSync(`${tmp}.mp4`, { force: true })
	}
}

/** Imagen → sticker de WhatsApp (WebP 512×512 con fondo transparente) */
export async function toSticker(buffer) {
	const tmp = path.join(os.tmpdir(), `multiwa-${crypto.randomUUID()}`)
	fs.writeFileSync(`${tmp}.in`, buffer)
	try {
		await run(['-i', `${tmp}.in`, '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
			'-frames:v', '1', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '80', `${tmp}.webp`])
		return fs.readFileSync(`${tmp}.webp`)
	} finally {
		fs.rmSync(`${tmp}.in`, { force: true })
		fs.rmSync(`${tmp}.webp`, { force: true })
	}
}

/** Imagen → JPEG cuadrado 640×640 para foto de perfil */
export async function toSquareJpeg(buffer) {
	const tmp = path.join(os.tmpdir(), `multiwa-${crypto.randomUUID()}`)
	fs.writeFileSync(`${tmp}.in`, buffer)
	try {
		await run(['-i', `${tmp}.in`, '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=640:640", '-frames:v', '1', '-q:v', '4', `${tmp}.jpg`])
		return fs.readFileSync(`${tmp}.jpg`)
	} finally {
		fs.rmSync(`${tmp}.in`, { force: true })
		fs.rmSync(`${tmp}.jpg`, { force: true })
	}
}

// ---- Versiones únicas para el calentamiento ----
// WhatsApp reconoce un archivo idéntico enviado desde varios números. Cada envío sale con pequeñas
// diferencias (recorte, brillo, velocidad, calidad) que no se notan, así ningún archivo se repite.
const rf = (a, b) => a + Math.random() * (b - a)
async function withTmp(buffer, outExt, args) {
	const tmp = path.join(os.tmpdir(), `multiwa-${crypto.randomUUID()}`)
	fs.writeFileSync(`${tmp}.in`, buffer)
	try {
		await new Promise((resolve, reject) => execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${tmp}.in`, ...args, `${tmp}.${outExt}`], { timeout: 25000 }, err => (err ? reject(err) : resolve())))
		const out = fs.readFileSync(`${tmp}.${outExt}`)
		if (!out.length) throw new Error('vacío')
		return out
	} finally {
		fs.rmSync(`${tmp}.in`, { force: true })
		fs.rmSync(`${tmp}.${outExt}`, { force: true })
	}
}
/** Foto: recorte de 1–4 %, brillo/contraste/saturación ligeramente distintos, JPEG sin metadatos */
export function variantImage(buffer) {
	const c = rf(0.96, 0.99), x = rf(0, 1 - c), y = rf(0, 1 - c)
	const vf = `crop=trunc(iw*${c.toFixed(3)}/2)*2:trunc(ih*${c.toFixed(3)}/2)*2:trunc(iw*${x.toFixed(3)}):trunc(ih*${y.toFixed(3)}),` +
		`eq=brightness=${rf(-0.03, 0.03).toFixed(3)}:contrast=${rf(0.97, 1.04).toFixed(3)}:saturation=${rf(0.94, 1.08).toFixed(3)}`
	return withTmp(buffer, 'jpg', ['-vf', vf, '-frames:v', '1', '-q:v', String(2 + Math.floor(Math.random() * 4)), '-map_metadata', '-1'])
}
/** Nota de voz: velocidad y volumen apenas distintos */
export function variantAudio(buffer) {
	return withTmp(buffer, 'ogg', ['-vn', '-af', `atempo=${rf(0.96, 1.04).toFixed(3)},volume=${rf(0.9, 1.08).toFixed(3)}`, '-ac', '1', '-ar', '48000',
		'-c:a', 'libopus', '-b:a', `${24 + Math.floor(Math.random() * 17)}k`, '-map_metadata', '-1', '-f', 'ogg'])
}
/** Sticker: misma imagen con otra calidad de compresión */
export function variantSticker(buffer) {
	return withTmp(buffer, 'webp', ['-frames:v', '1', '-c:v', 'libwebp', '-q:v', String(70 + Math.floor(Math.random() * 21)), '-map_metadata', '-1'])
}
/** GIF (video sin sonido): brillo y calidad un poco distintos */
export function variantGif(buffer) {
	return withTmp(buffer, 'mp4', ['-an', '-vf', `eq=brightness=${rf(-0.02, 0.02).toFixed(3)},scale=trunc(iw/2)*2:trunc(ih/2)*2`, '-c:v', 'libx264', '-preset', 'veryfast',
		'-crf', String(23 + Math.floor(Math.random() * 7)), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1'])
}

// ---- Imágenes y stickers generados (sin subir nada) ----
// Tarjetas tipo «Buenos días», «Feliz viernes» o «Feliz cumpleaños» y stickers de texto. Cada una sale con
// colores, posición y adornos distintos, así nunca se repite el mismo archivo.
const FONTS = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
	'/usr/share/fonts/truetype/freefont/FreeSansBold.ttf', '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf']
let fontPath
export function cardFont() {
	if (fontPath === undefined) fontPath = FONTS.find(f => { try { return fs.existsSync(f) } catch { return false } }) || null
	return fontPath
}
// Parte un texto en renglones de hasta n letras (sin cortar palabras)
function wrap(text, n) {
	const out = []
	for (const para of String(text).split('\n')) {
		let line = ''
		for (const w of para.split(/\s+/).filter(Boolean)) {
			if (line && (line + ' ' + w).length > n) { out.push(line); line = w } else line = line ? `${line} ${w}` : w
		}
		if (line) out.push(line)
	}
	return out
}
const PALETTES = {
	amanecer: [[255, 153, 102], [255, 94, 98]], cielo: [[86, 204, 242], [47, 128, 237]], noche: [[20, 30, 70], [110, 60, 160]],
	verde: [[17, 153, 142], [56, 239, 125]], amor: [[255, 81, 47], [221, 36, 118]], oro: [[247, 151, 30], [255, 210, 0]],
	morado: [[131, 58, 180], [253, 29, 29]], mexico: [[0, 104, 71], [206, 17, 38]], navidad: [[178, 34, 34], [0, 100, 0]], rosa: [[238, 156, 167], [255, 221, 225]]
}
/** Tarjeta 720×720: degradado, título grande, frase abajo y adornos (★ ♥ ✿) en lugares al azar */
export async function makeCard({ title, subtitle = '', palette = 'amanecer' }) {
	const font = cardFont()
	if (!font) throw new Error('No hay fuente para dibujar texto')
	const tmp = path.join(os.tmpdir(), `multiwa-${crypto.randomUUID()}`)
	const [c1, c2] = (PALETTES[palette] || PALETTES.amanecer).map(c => c.map(v => Math.max(0, Math.min(255, Math.round(v + rf(-18, 18))))))
	const lines = wrap(title, 13)
	lines.forEach((l, i) => fs.writeFileSync(`${tmp}.t${i}.txt`, l))
	if (subtitle) fs.writeFileSync(`${tmp}.s.txt`, wrap(subtitle, 30).join('\n'))
	const size = lines.some(l => l.length > 10) ? 70 : 86
	const lh = Math.round(size * 1.22)
	const diag = Math.random() < 0.5 ? '(X+Y)/(W+H)' : 'Y/H'
	const g = (a, b) => `${a}+(${b - a})*${diag}`
	const src = `nullsrc=s=720x720,format=rgb24,geq=r='${g(c1[0], c2[0])}':g='${g(c1[1], c2[1])}':b='${g(c1[2], c2[2])}'`
	const deco = ['★', '♥', '✿', '✦', '☀', '♪'][Math.floor(Math.random() * 6)]
	fs.writeFileSync(`${tmp}.d.txt`, deco)
	const decos = Array.from({ length: 6 }, () => `drawtext=fontfile=${font}:textfile=${tmp}.d.txt:fontsize=${30 + Math.floor(Math.random() * 40)}:fontcolor=white@${rf(0.25, 0.6).toFixed(2)}:x=${Math.floor(rf(20, 660))}:y=${Math.floor(rf(20, 660))}`)
	const ty = Math.round(rf(-80, -30))
	const vf = [...decos, 'vignette=PI/5',
		// cada renglón centrado por separado
		...lines.map((_, i) => `drawtext=fontfile=${font}:textfile=${tmp}.t${i}.txt:fontsize=${size}:fontcolor=white:borderw=4:bordercolor=black@0.35:x=(w-text_w)/2:y=(h-${lines.length * lh})/2+${i * lh}${ty >= 0 ? '+' : ''}${ty}`),
		subtitle ? `drawtext=fontfile=${font}:textfile=${tmp}.s.txt:fontsize=34:fontcolor=white:borderw=2:bordercolor=black@0.3:line_spacing=8:x=(w-text_w)/2:y=h-text_h-${Math.round(rf(70, 110))}` : null
	].filter(Boolean).join(',')
	try {
		await new Promise((resolve, reject) => execFile('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-vf', vf, '-frames:v', '1', '-q:v', String(2 + Math.floor(Math.random() * 3)), `${tmp}.jpg`], { timeout: 25000 }, err => (err ? reject(err) : resolve())))
		return fs.readFileSync(`${tmp}.jpg`)
	} finally {
		for (const ext of [...lines.map((_, i) => `t${i}.txt`), 's.txt', 'd.txt', 'jpg']) fs.rmSync(`${tmp}.${ext}`, { force: true })
	}
}
/** Sticker de texto 512×512 con fondo transparente («Jajaja», «Va», «Gracias»…) */
export async function makeTextSticker(text) {
	const font = cardFont()
	if (!font) throw new Error('No hay fuente para dibujar texto')
	const tmp = path.join(os.tmpdir(), `multiwa-${crypto.randomUUID()}`)
	const lines = wrap(text, 9)
	fs.writeFileSync(`${tmp}.t.txt`, lines.join('\n'))
	const colors = ['white', 'yellow', '0xFFD1DC', '0xB5FFB5', '0xADD8FF']
	const vf = `drawtext=fontfile=${font}:textfile=${tmp}.t.txt:fontsize=${lines.some(l => l.length > 6) ? 92 : 120}:fontcolor=${colors[Math.floor(Math.random() * colors.length)]}:borderw=${10 + Math.floor(Math.random() * 5)}:bordercolor=black:line_spacing=6:x=(w-text_w)/2:y=(h-text_h)/2,rotate=${rf(-0.15, 0.15).toFixed(3)}:c=none`
	try {
		await new Promise((resolve, reject) => execFile('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black@0.0:s=512x512,format=rgba', '-vf', vf, '-frames:v', '1', '-c:v', 'libwebp', '-pix_fmt', 'yuva420p', '-q:v', '80', `${tmp}.webp`], { timeout: 20000 }, err => (err ? reject(err) : resolve())))
		return fs.readFileSync(`${tmp}.webp`)
	} finally {
		fs.rmSync(`${tmp}.t.txt`, { force: true })
		fs.rmSync(`${tmp}.webp`, { force: true })
	}
}
