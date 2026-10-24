import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { DATA_DIR } from './config.js'

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(path.join(DATA_DIR, 'multimail.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#007AFF',
  email TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL DEFAULT 993,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL DEFAULT 465,
  user TEXT NOT NULL,
  pass TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected',
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  uid INTEGER NOT NULL,
  message_id TEXT,
  thread_key TEXT,
  folder TEXT NOT NULL DEFAULT 'INBOX',
  from_name TEXT,
  from_addr TEXT,
  to_addrs TEXT,
  cc_addrs TEXT,
  subject TEXT,
  snippet TEXT,
  body_text TEXT,
  body_html TEXT,
  ts INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  from_me INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  attachments TEXT,
  PRIMARY KEY (account_id, uid, folder)
);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_key, ts);

CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#8E8E93'
);

CREATE TABLE IF NOT EXISTS message_labels (
  thread_key TEXT NOT NULL,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_key, label_id)
);
`)
