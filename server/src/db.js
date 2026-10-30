import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { DATA_DIR } from './config.js'

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(path.join(DATA_DIR, 'multiwa.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#25D366',
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  name TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, jid)
);

CREATE TABLE IF NOT EXISTS messages (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  jid TEXT NOT NULL,
  remote_jid TEXT NOT NULL,
  participant TEXT,
  from_me INTEGER NOT NULL,
  sender TEXT,
  sender_name TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  media_path TEXT,
  media_mime TEXT,
  file_name TEXT,
  status INTEGER NOT NULL DEFAULT 0,
  raw TEXT,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages (jid, ts);
CREATE INDEX IF NOT EXISTS idx_messages_acc_jid_ts ON messages (account_id, jid, ts);

CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  name TEXT,
  notify TEXT
);

CREATE TABLE IF NOT EXISTS lid_map (
  lid TEXT PRIMARY KEY,
  pn TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#8E8E93'
);

CREATE TABLE IF NOT EXISTS conversation_labels (
  jid TEXT NOT NULL,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (jid, label_id)
);

CREATE TABLE IF NOT EXISTS devices (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
`)

// Migraciones para la API oficial (Cloud API) y los envíos masivos
for (const sql of [
	"ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'baileys'",
	'ALTER TABLE accounts ADD COLUMN cloud TEXT',
	'ALTER TABLE messages ADD COLUMN error TEXT'
]) {
	try { db.exec(sql) } catch {}
}

db.exec(`
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  language TEXT NOT NULL,
  per_hour INTEGER NOT NULL DEFAULT 50,
  start_hour INTEGER NOT NULL DEFAULT 9,
  end_hour INTEGER NOT NULL DEFAULT 19,
  status TEXT NOT NULL DEFAULT 'running',
  last_sent_at INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  message_id TEXT,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_campaign ON campaign_items (campaign_id, status);

CREATE TABLE IF NOT EXISTS optouts (
  phone TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
`)

// Herramientas de cobranza: notas, recordatorios y respuestas rápidas
db.exec(`
CREATE TABLE IF NOT EXISTS conversation_notes (
  conv_key TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_key TEXT NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (done, at);

CREATE TABLE IF NOT EXISTS quick_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`)
try { db.exec('ALTER TABLE conversation_labels ADD COLUMN at INTEGER') } catch {}

// Mensajes editados o eliminados para todos
for (const sql of ['ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0']) { try { db.exec(sql) } catch {} }

// Archivar conversaciones y guardar la foto de perfil del contacto
for (const sql of [
	'ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0',
	'ALTER TABLE chats ADD COLUMN avatar_url TEXT',
	'ALTER TABLE chats ADD COLUMN avatar_ts INTEGER'
]) { try { db.exec(sql) } catch {} }
