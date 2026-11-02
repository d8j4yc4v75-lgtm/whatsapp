export function formatMoney(amount: number, currency = "MXN", locale = "es-MX") {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
}

export function formatDate(value: string | null, locale = "es-MX") {
  if (!value) return "—";
  // Fechas "YYYY-MM-DD" se interpretan como locales (evita desfase de un día).
  const date = value.length === 10 ? new Date(`${value}T00:00:00`) : new Date(value);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export const STATUS_LABEL: Record<string, string> = {
  borrador: "Borrador",
  enviada: "Enviada",
  negociacion: "En negociación",
  ganada: "Ganada",
  perdida: "Perdida",
};

export const STATUS_STYLE: Record<string, string> = {
  borrador: "bg-slate-100 text-slate-700",
  enviada: "bg-blue-50 text-blue-700",
  negociacion: "bg-amber-50 text-amber-700",
  ganada: "bg-emerald-50 text-emerald-700",
  perdida: "bg-rose-50 text-rose-700",
};

// Convierte un teléfono a formato wa.me (solo dígitos, con lada de país).
// Si tiene 10 dígitos asumimos México (+52).
export function toWhatsAppNumber(phone: string | null) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `52${digits}`;
  return digits.length >= 11 ? digits : null;
}

// Fecha de hoy (YYYY-MM-DD) en la zona horaria de la empresa.
export function todayISO(timeZone = "America/Mexico_City") {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
