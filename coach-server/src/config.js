import path from 'node:path'

export const PORT = Number(process.env.PORT || 3000)
export const DATA_DIR = process.env.DATA_DIR || path.resolve('data')
// Zona horaria del usuario: decide qué "día" es cada dato y a qué hora se hace la evaluación
export const TZ = process.env.TZ_USUARIO || 'America/Monterrey'
// Hora local (0-23) a la que se evalúa el día si el atajo no lo disparó antes
export const REVIEW_HOUR = Number(process.env.REVIEW_HOUR || 22)
export const MODEL = 'claude-opus-5-5'
