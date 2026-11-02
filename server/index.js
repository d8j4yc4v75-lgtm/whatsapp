// Servidor puente: vincula tu WhatsApp con Baileys (solo conexión, no envía mensajes).
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
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

/* ---------- eventos de estado (SSE) ---------- */
const clients = new Set();
const write = (res, data) => res.write(`event: status\ndata: ${JSON.stringify(data)}\n\n`);
const emit = data => { for (const res of clients) write(res, data); };

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

/* ---------- HTTP ---------- */
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-WA-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
