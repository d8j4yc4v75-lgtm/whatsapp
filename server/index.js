// Servidor puente: conecta tu WhatsApp con Baileys y lo expone al simulador (index.html).
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
const MIN_GAP = Number(process.env.SEND_MIN_MS) || 1500;
const MAX_GAP = Number(process.env.SEND_MAX_MS) || 4000;
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

/* ---------- eventos (SSE con buffer para reconexión) ---------- */
let seq = 0;
const buffer = [];
const clients = new Set();
function emit(type, data) {
  const ev = { id: ++seq, type, data };
  buffer.push(ev); if (buffer.length > 500) buffer.shift();
  for (const res of clients) write(res, ev);
}
const write = (res, ev) => res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);

/* ---------- conexión WhatsApp ---------- */
let sock = null;
let wa = { status: 'disconnected', qr: null, me: null, error: null };
function setStatus(patch) { wa = { ...wa, ...patch }; emit('status', wa); }

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
  // palomitas: 2 servidor, 3 entregado, 4 leído, 5 reproducido
  s.ev.on('messages.update', ups => {
    for (const { key, update } of ups) {
      if (!key.fromMe || update.status == null) continue;
      const st = update.status >= 4 ? 3 : update.status === 3 ? 2 : update.status === 2 ? 1 : null;
      if (st) emit('ack', { waId: key.id, status: st });
    }
  });
  s.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const k = m.key;
      if (k.fromMe || !m.message) continue;
      const jid = [k.remoteJidAlt, k.senderPn, k.remoteJid].find(j => j && j.endsWith('@s.whatsapp.net'));
      if (!jid) continue; // grupos, estados, lid sin número
      const msg = m.message.ephemeralMessage?.message || m.message;
      const text = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption ||
        (msg.imageMessage ? '📷 Foto' : msg.videoMessage ? '🎥 Video' : msg.audioMessage ? '🎤 Audio' : msg.stickerMessage ? 'Sticker' : msg.documentMessage ? '📄 Documento' : null);
      if (!text) continue;
      emit('message', { waId: k.id, number: '+' + jid.split('@')[0].split(':')[0], name: m.pushName || '', text, ts: Number(m.messageTimestamp) * 1000 || Date.now() });
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

/* ---------- envío con cola y pausa aleatoria ---------- */
function toDigits(n) {
  let d = String(n).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.slice(1);
  if (d.startsWith('00')) return d.slice(2);
  return d.length <= 10 ? DEFAULT_CC + d : d;
}
let chain = Promise.resolve();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function send(number, text) {
  const job = chain.then(async () => {
    if (!sock || wa.status !== 'open') throw new Error('WhatsApp no está conectado');
    const digits = toDigits(number);
    const [r] = await sock.onWhatsApp(digits);
    if (!r?.exists) throw new Error('El número no tiene WhatsApp');
    const sent = await sock.sendMessage(r.jid, { text });
    await sleep(MIN_GAP + Math.random() * (MAX_GAP - MIN_GAP));
    return { waId: sent.key.id, jid: r.jid };
  });
  chain = job.catch(() => {});
  return job;
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
app.post('/api/send', async (req, res) => {
  const { number, text } = req.body || {};
  if (!number || !text) return res.status(400).json({ error: 'Falta número o texto' });
  try { res.json(await send(number, String(text))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let since = Number(req.get('Last-Event-ID') || req.query.since) || 0;
  if (since > seq) since = 0; // el servidor se reinició
  for (const ev of buffer) if (ev.id > since && ev.type !== 'status') write(res, ev);
  write(res, { id: seq, type: 'status', data: wa });
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

app.listen(PORT, () => console.log(`Chats + WhatsApp en http://localhost:${PORT}`));

// reconectar si ya hay una sesión guardada
fs.access(path.join(AUTH_DIR, 'creds.json')).then(() => connect()).catch(() => {});
