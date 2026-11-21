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
