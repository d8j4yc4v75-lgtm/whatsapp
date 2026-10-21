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
