import fs from 'node:fs'
import path from 'node:path'
import { BufferJSON, initAuthCreds, proto } from 'baileys'
import { db } from './db.js'

// Las llaves de WhatsApp se guardan en SQLite en lugar de miles de archivos pequeños,
// que ocupan mucho más disco. Los archivos de versiones anteriores se migran al leerlos.
db.exec(`
CREATE TABLE IF NOT EXISTS auth_keys (
  account_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (account_id, type, id)
);
`)

const q = {
	get: db.prepare('SELECT value FROM auth_keys WHERE account_id = ? AND type = ? AND id = ?'),
	set: db.prepare('INSERT OR REPLACE INTO auth_keys (account_id, type, id, value) VALUES (?, ?, ?, ?)'),
	del: db.prepare('DELETE FROM auth_keys WHERE account_id = ? AND type = ? AND id = ?'),
	clear: db.prepare('DELETE FROM auth_keys WHERE account_id = ?'),
	hasCreds: db.prepare("SELECT 1 FROM auth_keys WHERE account_id = ? AND type = 'creds' AND id = 'creds'")
}

// Mismo nombre de archivo que usaba useMultiFileAuthState
const fileName = file => file.replace(/\//g, '__').replace(/:/g, '-')

export function hasAuth(accountId, folder) {
	return Boolean(q.hasCreds.get(accountId)) || fs.existsSync(path.join(folder, 'creds.json'))
}

export function clearAuth(accountId, folder) {
	q.clear.run(accountId)
	fs.rmSync(folder, { recursive: true, force: true })
}

export function useSqliteAuthState(accountId, folder) {
	const read = (type, id) => {
		const row = q.get.get(accountId, type, id)
		if (row) return JSON.parse(row.value, BufferJSON.reviver)
		// Migración perezosa desde el archivo antiguo
		const file = path.join(folder, fileName(type === 'creds' ? 'creds.json' : `${type}-${id}.json`))
		if (!fs.existsSync(file)) return null
		let raw
		try {
			raw = fs.readFileSync(file, 'utf8')
		} catch {
			return null
		}
		// Si no se puede copiar (por ejemplo, disco lleno) se sigue usando el archivo
		try {
			q.set.run(accountId, type, id, raw)
			fs.rmSync(file, { force: true })
		} catch {}
		try {
			return JSON.parse(raw, BufferJSON.reviver)
		} catch {
			return null
		}
	}

	const write = (type, id, value) => {
		q.set.run(accountId, type, id, JSON.stringify(value, BufferJSON.replacer))
	}

	const remove = (type, id) => {
		q.del.run(accountId, type, id)
		fs.rmSync(path.join(folder, fileName(`${type}-${id}.json`)), { force: true })
	}

	const creds = read('creds', 'creds') || initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data = {}
					for (const id of ids) {
						let value = read(type, id)
						if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
						data[id] = value
					}
					return data
				},
				set: async data => {
					db.transaction(() => {
						for (const type in data) {
							for (const id in data[type]) {
								const value = data[type][id]
								if (value) write(type, id, value)
								else remove(type, id)
							}
						}
					})()
				}
			}
		},
		saveCreds: async () => write('creds', 'creds', creds)
	}
}
