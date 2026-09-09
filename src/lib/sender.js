async function sendMessage(client, contact) {
  try {
    await client.sendMessage(contact.phone, contact.message);
    console.log(`Sent to ${contact.phone}`);
  } catch (err) {
    console.error(`Failed to send to ${contact.phone}:`, err.message);
  }
}

module.exports = { sendMessage };
