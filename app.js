const KEY = 'chatsim-v1';
const colors = ['#25a18e','#e76f51','#6a4c93','#1982c4','#ff595e','#8ac926'];
const replies = ['¡Genial!','Jaja 😂','Ok, lo veo luego','¿En serio?','Perfecto 👍','Te llamo más tarde','Claro que sí','Mmm, déjame pensarlo'];

const defaults = [
  { id: 1, name: 'Ana', msgs: [{ t: 'Hola, ¿cómo estás?', me: false, ts: Date.now() - 3600e3, st: 3 }] },
  { id: 2, name: 'Carlos', msgs: [] },
  { id: 3, name: 'Familia', msgs: [] }
];

let chats = load();
let current = null;
const $ = id => document.getElementById(id);

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || defaults; } catch { return defaults; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(chats)); } catch {}
}
const fmt = ts => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ticks = st => st === 0 ? '🕓' : st === 1 ? '✓' : `<span class="tick${st === 3 ? ' read' : ''}">✓✓</span>`;

function avatar(el, c) {
  el.textContent = c.name[0].toUpperCase();
  el.style.background = colors[c.id % colors.length];
}

function renderList() {
  const q = $('search').value.toLowerCase();
  $('chatList').innerHTML = '';
  chats.filter(c => c.name.toLowerCase().includes(q)).forEach(c => {
    const li = document.createElement('li');
    if (current && c.id === current.id) li.className = 'active';
    const last = c.msgs[c.msgs.length - 1];
    li.innerHTML = `<div class="avatar"></div><div class="meta"><div>${esc(c.name)}</div><div class="last">${last ? esc(last.t) : ''}</div></div>`;
    avatar(li.querySelector('.avatar'), c);
    li.onclick = () => open(c.id);
    $('chatList').appendChild(li);
  });
}

function renderMsgs() {
  const box = $('messages');
  box.innerHTML = current.msgs.map(m =>
    `<div class="msg ${m.me ? 'out' : 'in'}">${esc(m.t)}<span class="time">${fmt(m.ts)}${m.me ? ' ' + ticks(m.st) : ''}</span></div>`
  ).join('');
  box.scrollTop = box.scrollHeight;
}

function open(id) {
  current = chats.find(c => c.id === id);
  $('headName').textContent = current.name;
  $('headStatus').textContent = 'en línea';
  avatar($('headAvatar'), current);
  document.querySelector('.app').classList.add('open');
  renderMsgs(); renderList();
  $('input').focus();
}

// Simula el ciclo de entrega: pendiente → enviado → entregado → leído. Nada sale del navegador.
function simulate(chat, msg) {
  const step = (st, ms) => setTimeout(() => {
    msg.st = st; save();
    if (current === chat) renderMsgs();
  }, ms);
  step(1, 500); step(2, 1200); step(3, 2500);

  setTimeout(() => {
    if (current === chat) $('headStatus').textContent = 'escribiendo...';
  }, 3000);
  setTimeout(() => {
    chat.msgs.push({ t: replies[Math.floor(Math.random() * replies.length)], me: false, ts: Date.now() });
    save();
    if (current === chat) { $('headStatus').textContent = 'en línea'; renderMsgs(); }
    renderList();
  }, 4500 + Math.random() * 1500);
}

$('composer').onsubmit = e => {
  e.preventDefault();
  const t = $('input').value.trim();
  if (!t || !current) return;
  const msg = { t, me: true, ts: Date.now(), st: 0 };
  current.msgs.push(msg);
  $('input').value = '';
  save(); renderMsgs(); renderList();
  simulate(current, msg);
};

$('newChat').onclick = () => {
  const name = prompt('Nombre del contacto:');
  if (!name || !name.trim()) return;
  const c = { id: Date.now(), name: name.trim(), msgs: [] };
  chats.unshift(c); save(); open(c.id);
};

$('clearChat').onclick = () => {
  if (current && confirm('¿Vaciar este chat?')) { current.msgs = []; save(); renderMsgs(); renderList(); }
};

$('back').onclick = () => document.querySelector('.app').classList.remove('open');
$('search').oninput = renderList;

renderList();
if (window.innerWidth > 700) open(chats[0].id);
