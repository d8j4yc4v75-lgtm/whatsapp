const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const XLSX = require("xlsx");
const { onlyDigits } = require("./phone");

function normalizeKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // quita acentos: "telefono" (sin tilde) coincide igual
}

function rowsFromCsv(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return parse(content, { columns: true, skip_empty_lines: true, trim: true });
}

function rowsFromExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

// Lee el archivo de contactos (CSV o Excel) y devuelve [{ telefono, mensaje }]
function loadContacts(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`No se encontró el archivo de contactos: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  const rawRows = ext === ".csv" ? rowsFromCsv(filePath) : rowsFromExcel(filePath);

  const contacts = [];
  for (const raw of rawRows) {
    const normalized = {};
    for (const [key, value] of Object.entries(raw)) {
      normalized[normalizeKey(key)] = value;
    }
    const telefonoRaw = normalized["telefono"];
    const mensaje = String(normalized["mensaje"] || "").trim();
    const telefono = onlyDigits(telefonoRaw);

    if (!telefono || !mensaje) continue; // fila incompleta, se ignora
    contacts.push({ telefono, mensaje });
  }
  return contacts;
}

module.exports = { loadContacts };
