function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

// Compara dos números tolerando formatos distintos (+52 1 81..., espacios,
// prefijo "1" agregado por WhatsApp, etc.) comparando el sufijo de dígitos.
function phonesMatch(a, b) {
  const da = onlyDigits(a);
  const db = onlyDigits(b);
  if (da.length < 8 || db.length < 8) return false;
  const shortLen = Math.min(da.length, db.length);
  const suffixLen = Math.max(8, shortLen);
  return da.slice(-suffixLen) === db.slice(-suffixLen);
}

module.exports = { onlyDigits, phonesMatch };
