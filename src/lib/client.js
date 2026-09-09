const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

function createClient() {
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', (qr) => {
    console.log('Scan this QR code with WhatsApp (Linked Devices):');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => console.log('Authenticated.'));
  client.on('auth_failure', (msg) => console.error('Authentication failure:', msg));
  client.on('disconnected', (reason) => console.warn('Client disconnected:', reason));

  return client;
}

module.exports = { createClient };
