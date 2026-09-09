const fs = require("fs");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");

const HEADER = ["telefono", "mensaje", "estado", "fecha_hora", "error"];

function ensureFile(resultsFile) {
  if (!fs.existsSync(resultsFile)) {
    fs.writeFileSync(resultsFile, stringify([HEADER]));
  }
}

// Devuelve el set de teléfonos que ya quedaron en estado ENVIADO
// en ejecuciones anteriores, para poder reanudar sin reenviar.
function loadSentPhones(resultsFile) {
  ensureFile(resultsFile);
  const content = fs.readFileSync(resultsFile, "utf8");
  const rows = parse(content, { columns: true, skip_empty_lines: true });
  const sent = new Set();
  for (const row of rows) {
    if (row.estado === "ENVIADO") sent.add(row.telefono);
  }
  return sent;
}

function appendResult(resultsFile, { telefono, mensaje, estado, error }) {
  ensureFile(resultsFile);
  const fecha_hora = new Date().toISOString();
  const line = stringify([[telefono, mensaje, estado, fecha_hora, error || ""]]);
  fs.appendFileSync(resultsFile, line);
}

function summarize(resultsFile) {
  ensureFile(resultsFile);
  const content = fs.readFileSync(resultsFile, "utf8");
  const rows = parse(content, { columns: true, skip_empty_lines: true });
  const counts = { ENVIADO: 0, ERROR: 0, NO_ENCONTRADO: 0, PRUEBA: 0 };
  for (const row of rows) {
    if (counts[row.estado] === undefined) counts[row.estado] = 0;
    counts[row.estado] += 1;
  }
  return { total: rows.length, counts, rows };
}

module.exports = { ensureFile, loadSentPhones, appendResult, summarize, HEADER };
