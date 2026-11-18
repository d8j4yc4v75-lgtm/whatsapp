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
