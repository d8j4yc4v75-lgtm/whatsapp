const path = require("path");
const { chromium } = require("playwright");

const WHATSAPP_URL = "https://web.whatsapp.com";

// Selectores que indican que la sesión YA está iniciada (lista de chats visible).
const LOGGED_IN_SELECTORS = [
  'div[aria-label="Lista de chats"]',
  'div[aria-label="Chat list"]',
  '#pane-side',
];

// Selectores del código QR (sesión NO iniciada).
const QR_SELECTORS = ['canvas[aria-label="Scan me!"]', "canvas", 'div[data-testid="qrcode"]'];

async function launchWhatsApp({ sessionDir, headless }) {
  const userDataDir = path.resolve(sessionDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: ["--start-maximized"],
    viewport: null,
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(WHATSAPP_URL, { waitUntil: "domcontentloaded" });

  await waitForSession(page);

  return { context, page };
}

async function isLoggedIn(page) {
  for (const sel of LOGGED_IN_SELECTORS) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function isShowingQr(page) {
  for (const sel of QR_SELECTORS) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

// Espera indefinidamente (sin automatizar nada) a que la sesión quede iniciada.
// La primera vez, el usuario escanea el QR manualmente; las siguientes veces
// el perfil persistente ya trae la sesión y esto retorna casi de inmediato.
async function waitForSession(page) {
  console.log("Abriendo WhatsApp Web...");
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min de margen para escanear el QR
  let avisado = false;

  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) {
      console.log("Sesión de WhatsApp Web iniciada.");
      return;
    }
    if (!avisado && (await isShowingQr(page))) {
      console.log("Escanea el código QR con tu teléfono para iniciar sesión...");
      avisado = true;
    }
    await page.waitForTimeout(1500);
  }

  throw new Error(
    "No se detectó el inicio de sesión en WhatsApp Web dentro del tiempo de espera."
  );
}

module.exports = { launchWhatsApp, isLoggedIn };
