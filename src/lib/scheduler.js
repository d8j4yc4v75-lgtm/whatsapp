const schedule = require('node-schedule');
const { sendMessage } = require('./sender');

const MIN_DELAY_MS = Number(process.env.SEND_DELAY_MIN_MS || 3000);
const MAX_DELAY_MS = Number(process.env.SEND_DELAY_MAX_MS || 8000);

function scheduleMessages(client, contacts) {
  const now = new Date();
  const immediate = contacts.filter((c) => !c.sendAt || c.sendAt <= now);
  const future = contacts.filter((c) => c.sendAt && c.sendAt > now);

  future.forEach((contact) => {
    schedule.scheduleJob(contact.sendAt, () => sendMessage(client, contact));
    console.log(`Scheduled message to ${contact.phone} at ${contact.sendAt.toISOString()}`);
  });

  sendQueueSequentially(client, immediate);
}

async function sendQueueSequentially(client, queue) {
  for (const contact of queue) {
    await sendMessage(client, contact);
    await sleep(randomDelay(MIN_DELAY_MS, MAX_DELAY_MS));
  }
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { scheduleMessages };
