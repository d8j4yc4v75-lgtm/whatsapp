const { phonesMatch } = require("./phone");

// Error crítico: algo en la interfaz de WhatsApp Web no coincide con lo
// esperado (posible cambio de UI). Ante esto se debe ABORTAR todo el
// proceso en vez de seguir enviando mensajes a ciegas.
class CriticalError extends Error {}

const SEARCH_BOX_SELECTORS = [
  'div[contenteditable="true"][data-tab="3"]',
  'div[aria-label="Cuadro de texto de búsqueda"]',
  'div[aria-label="Search input textbox"]',
];

const SEARCH_RESULT_ITEM_SELECTOR = '#pane-side div[role="listitem"]';

const MESSAGE_BOX_SELECTORS = [
  'div[contenteditable="true"][data-tab="10"]',
  'footer div[contenteditable="true"]',
  'div[aria-label="Escribe un mensaje"]',
  'div[aria-label="Type a message"]',
];

const CHAT_HEADER_SELECTOR = "#main header";

async function firstVisible(page, selectors, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await page.waitForTimeout(300);
  }
  return null;
}

async function openSearch(page) {
  const box = await firstVisible(page, SEARCH_BOX_SELECTORS);
  if (!box) {
    throw new CriticalError(
      "No se encontró el cuadro de búsqueda de WhatsApp Web (posible cambio de interfaz)."
    );
  }
  await box.click();
  await box.fill("");
  return box;
}

// Busca el número, abre el chat si aparece en los resultados.
// Devuelve { found: false } si no existe, o { found: true } si se abrió un chat.
async function findAndOpenChat(page, phoneDigits) {
  const box = await openSearch(page);
  await box.type(`+${phoneDigits}`, { delay: 30 });
  await page.waitForTimeout(1200);

  const items = page.locator(SEARCH_RESULT_ITEM_SELECTOR);
  const count = await items.count().catch(() => 0);

  if (count === 0) {
    await page.keyboard.press("Escape");
    return { found: false };
  }

  await items.first().click();
  await page.waitForTimeout(800);

  const header = await firstVisible(page, [CHAT_HEADER_SELECTOR]);
  if (!header) {
    throw new CriticalError(
      "No se encontró el encabezado del chat tras abrirlo (posible cambio de interfaz)."
    );
  }
  return { found: true };
}

// Verifica que el chat abierto corresponde realmente al número indicado,
// abriendo el panel de datos del contacto y leyendo el teléfono mostrado ahí.
async function verifyOpenChatPhone(page, phoneDigits) {
  const header = await firstVisible(page, [CHAT_HEADER_SELECTOR]);
  if (!header) {
    throw new CriticalError("No se encontró el encabezado del chat para verificar el número.");
  }

  await header.click();
  await page.waitForTimeout(800);

  const panel = await firstVisible(
    page,
    ['div[data-testid="drawer-right"]', 'div[aria-label="Información del contacto"]', "#app"],
    8000
  );
  if (!panel) {
    throw new CriticalError("No se pudo abrir el panel de datos del contacto para verificar.");
  }

  const panelText = (await panel.innerText().catch(() => "")) || "";
  const matches = panelText.match(/\+?\d[\d\s-]{7,}\d/g) || [];

  let verified = matches.some((candidate) => phonesMatch(candidate, phoneDigits));

  // Cierra el panel de info para dejar la UI lista para el siguiente contacto.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  return verified;
}

// Escribe el mensaje en el cuadro de texto. Si `send` es true, presiona Enter.
async function typeMessage(page, mensaje, { send }) {
  const box = await firstVisible(page, MESSAGE_BOX_SELECTORS);
  if (!box) {
    throw new CriticalError(
      "No se encontró el cuadro para escribir el mensaje (posible cambio de interfaz)."
    );
  }
  await box.click();

  const lines = String(mensaje).split("\n");
  for (let i = 0; i < lines.length; i++) {
    await page.keyboard.type(lines[i], { delay: 15 });
    if (i < lines.length - 1) await page.keyboard.press("Shift+Enter");
  }

  if (send) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);
  }
}

module.exports = { CriticalError, findAndOpenChat, verifyOpenChatPhone, typeMessage };
