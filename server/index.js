// Servidor puente: vincula tu WhatsApp con Baileys. No envía mensajes: solo verifica números y obtiene fotos de perfil.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from 'baileys';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.WA_TOKEN || '';
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth');
const DEFAULT_CC = (process.env.DEFAULT_CC || '52').replace(/\D/g, '');
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

/* ---------- eventos de estado (SSE) ---------- */
const clients = new Set();
const write = (res, data, type = 'status') => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
const emit = (data, type) => { for (const res of clients) write(res, data, type); };

/* ---------- chats compartidos entre dispositivos ---------- */
const STATE_FILE = process.env.STATE_FILE || path.join(path.dirname(AUTH_DIR), 'state.json');
let shared = { rev: 0, state: null };
const loaded = fs.readFile(STATE_FILE, 'utf8').then(t => { shared = JSON.parse(t); }).catch(() => {});
let writing = Promise.resolve();
function saveShared() {
  writing = writing.then(async () => {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE + '.tmp', JSON.stringify(shared));
    await fs.rename(STATE_FILE + '.tmp', STATE_FILE);
  }).catch(e => logger.error(e));
}

/* ---------- conexión WhatsApp ---------- */
let sock = null;
let wa = { status: 'disconnected', qr: null, me: null, error: null };
function setStatus(patch) { wa = { ...wa, ...patch }; emit(wa); }

async function connect() {
  if (sock && wa.status !== 'disconnected') return;
  setStatus({ status: 'connecting', qr: null, error: null });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
  const s = makeWASocket({ auth: state, version, logger, browser: Browsers.macOS('Chats'), markOnlineOnConnect: false, syncFullHistory: false });
  sock = s;
  s.ev.on('creds.update', saveCreds);
  s.ev.on('connection.update', async u => {
    if (s !== sock) return;
    if (u.qr) setStatus({ status: 'qr', qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 280 }) });
    if (u.connection === 'open') setStatus({ status: 'open', qr: null, me: { id: s.user?.id, name: s.user?.name || '' } });
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      sock = null;
      if (code === DisconnectReason.loggedOut) {
        await fs.rm(AUTH_DIR, { recursive: true, force: true });
        setStatus({ status: 'disconnected', qr: null, me: null, error: 'Sesión cerrada desde el teléfono' });
      } else {
        setStatus({ status: 'disconnected', qr: null });
        setTimeout(() => connect().catch(e => logger.error(e)), code === DisconnectReason.restartRequired ? 0 : 3000);
      }
    }
  });
}

async function logout() {
  const s = sock; sock = null;
  try { await s?.logout(); } catch {}
  try { s?.end(); } catch {}
  await fs.rm(AUTH_DIR, { recursive: true, force: true });
  setStatus({ status: 'disconnected', qr: null, me: null, error: null });
}

/* ---------- verificación de números (sin enviar nada) ---------- */
function toDigits(n) {
  const d = String(n).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.slice(1);
  if (d.startsWith('00')) return d.slice(2);
  return d.length <= 10 ? DEFAULT_CC + d : d;
}
async function photoOf(jid) {
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    if (!url) return null;
    const r = await fetch(url); if (!r.ok) return null;
    return `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  } catch { return null; } // sin foto o privacidad restringida
}
const cache = new Map();
let chain = Promise.resolve();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function lookup(number) {
  const digits = toDigits(number), hit = cache.get(digits);
  if (hit && Date.now() - hit.t < 36e5) return Promise.resolve(hit.v);
  const job = chain.then(async () => {
    if (!sock || wa.status !== 'open') throw new Error('WhatsApp no está conectado');
    const [r] = await sock.onWhatsApp(digits);
    const v = r?.exists ? { exists: true, photo: await photoOf(r.jid) } : { exists: false, photo: null };
    cache.set(digits, { t: Date.now(), v });
    await sleep(400 + Math.random() * 500); // pausa para no saturar
    return v;
  });
  chain = job.catch(() => {});
  return job;
}

/* ---------- HTTP ---------- */
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-WA-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));
app.use('/api', (req, res, next) => {
  if (TOKEN && (req.get('X-WA-Token') || req.query.token) !== TOKEN) return res.status(401).json({ error: 'Token inválido' });
  next();
});
app.get('/api/status', (req, res) => res.json(wa));
app.post('/api/connect', (req, res) => { connect().catch(e => setStatus({ status: 'disconnected', error: e.message })); res.json(wa); });
app.post('/api/logout', async (req, res) => { await logout(); res.json(wa); });
app.get('/api/lookup', async (req, res) => {
  if (!req.query.number) return res.status(400).json({ error: 'Falta número' });
  try { res.json(await lookup(req.query.number)); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get('/api/state', async (req, res) => { await loaded; res.json(shared); });
app.put('/api/state', async (req, res) => {
  await loaded;
  const { state, from } = req.body || {};
  if (!state || !Array.isArray(state.chats)) return res.status(400).json({ error: 'Datos inválidos' });
  shared = { rev: shared.rev + 1, state };
  saveShared();
  emit({ rev: shared.rev, from }, 'sync');
  res.json({ rev: shared.rev });
});
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  write(res, wa);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

app.listen(PORT, () => console.log(`Chats + WhatsApp en http://localhost:${PORT}`));

// reconectar si ya hay una sesión guardada
fs.access(path.join(AUTH_DIR, 'creds.json')).then(() => connect()).catch(() => {});
