require('dotenv').config();
const path = require('path');
const { createClient } = require('./lib/client');
const { loadContacts } = require('./lib/contacts');
const { scheduleMessages } = require('./lib/scheduler');

const CONTACTS_FILE = process.env.CONTACTS_FILE || path.join(__dirname, '..', 'data', 'contacts.csv');

async function main() {
  const contacts = loadContacts(CONTACTS_FILE);
  if (contacts.length === 0) {
    console.error(`No contacts found in ${CONTACTS_FILE}`);
    process.exit(1);
  }
  console.log(`Loaded ${contacts.length} message(s) from ${CONTACTS_FILE}`);

  const client = createClient();

  client.on('ready', () => {
    console.log('WhatsApp client ready.');
    scheduleMessages(client, contacts);
  });

  client.initialize();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
