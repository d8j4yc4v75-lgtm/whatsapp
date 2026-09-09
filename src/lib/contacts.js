const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

function loadContacts(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Contacts file not found: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, 'utf8');

  let rows;
  if (ext === '.json') {
    rows = JSON.parse(raw);
  } else if (ext === '.csv') {
    rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  } else {
    throw new Error(`Unsupported contacts file type: ${ext}`);
  }

  return rows
    .filter((row) => row.phone && row.message)
    .map((row) => ({
      phone: normalizePhone(row.phone),
      message: row.message,
      sendAt: row.sendAt ? new Date(row.sendAt) : null,
    }));
}

function normalizePhone(phone) {
  const digits = String(phone).replace(/[^\d]/g, '');
  return `${digits}@c.us`;
}

module.exports = { loadContacts, normalizePhone };
