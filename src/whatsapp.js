require("dotenv").config();
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");

const { loadContacts } = require("./lib/contacts");
const { launchWhatsApp } = require("./lib/browser");
const { loadSentPhones, appendResult, summarize } = require("./lib/logger");
const { CriticalError, findAndOpenChat, verifyOpenChatPhone, typeMessage } = require("./lib/sender");

const CONTACTS_FILE = process.env.CONTACTS_FILE || "data/contactos.csv";
const RESULTS_FILE = process.env.RESULTS_FILE || "logs/resultados.csv";
const SESSION_DIR = process.env.SESSION_DIR || "session";
const DELAY_MS = Number(process.env.DELAY_MS || 8000);
const HEADLESS = String(process.env.HEADLESS || "false").toLowerCase() === "true";
const SEND_MESSAGES = String(process.env.SEND_MESSAGES || "false").toLowerCase() === "true";

let stopRequested = false;
process.on("SIGINT", () => {
  if (stopRequested) process.exit(1); // segundo Ctrl+C: salida forzada
  console.log("\nDeteniendo tras el contacto actual... (Ctrl+C de nuevo para forzar)");
  stopRequested = true;
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCampaign({ send }) {
  const contactsPath = path.resolve(CONTACTS_FILE);
  const resultsPath = path.resolve(RESULTS_FILE);

  const contacts = loadContacts(contactsPath);
  if (contacts.length === 0) {
    console.log("No hay contactos válidos en", CONTACTS_FILE);
    return;
  }

  const alreadySent = loadSentPhones(resultsPath);
  const pending = contacts.filter((c) => !alreadySent.has(c.telefono));

  console.log(`Total en base: ${contacts.length}. Ya enviados antes: ${contacts.length - pending.length}. Pendientes: ${pending.length}.`);
  console.log(send ? "MODO: ENVÍO REAL" : "MODO: PRUEBA (no se presionará enviar)");

  if (pending.length === 0) {
    console.log("No quedan contactos pendientes por procesar.");
    return;
  }

  const { context, page } = await launchWhatsApp({ sessionDir: SESSION_DIR, headless: HEADLESS });

  try {
    for (let i = 0; i < pending.length; i++) {
      if (stopRequested) {
        console.log("Proceso detenido por el usuario. Registro conservado.");
        break;
      }

      const { telefono, mensaje } = pending[i];
      console.log(`\n[${i + 1}/${pending.length}] ${telefono}`);

      try {
        const { found } = await findAndOpenChat(page, telefono);
        if (!found) {
          console.log("  -> NO_ENCONTRADO");
          appendResult(resultsPath, { telefono, mensaje, estado: "NO_ENCONTRADO" });
          continue;
        }

        const verified = await verifyOpenChatPhone(page, telefono);
        if (!verified) {
          console.log("  -> ERROR: el chat abierto no coincide con el número indicado");
          appendResult(resultsPath, {
            telefono,
            mensaje,
            estado: "ERROR",
            error: "El chat abierto no coincide con el número de la base",
          });
          continue;
        }

        await typeMessage(page, mensaje, { send });

        if (send) {
          console.log("  -> ENVIADO");
          appendResult(resultsPath, { telefono, mensaje, estado: "ENVIADO" });
        } else {
          console.log("  -> PRUEBA_OK (mensaje escrito, no enviado)");
          appendResult(resultsPath, { telefono, mensaje, estado: "PRUEBA" });
        }
      } catch (err) {
        if (err instanceof CriticalError) {
          console.error("\nERROR CRÍTICO: la interfaz de WhatsApp Web no respondió como se esperaba.");
          console.error(err.message);
          console.error("Se detiene todo el proceso para no enviar mensajes de forma incorrecta.");
          appendResult(resultsPath, {
            telefono,
            mensaje,
            estado: "ERROR",
            error: `CRÍTICO: ${err.message}`,
          });
          break; // aborta la campaña completa
        }

        console.log("  -> ERROR:", err.message);
        appendResult(resultsPath, { telefono, mensaje, estado: "ERROR", error: err.message });
      }

      if (!stopRequested && i < pending.length - 1) {
        await sleep(DELAY_MS);
      }
    }
  } finally {
    await context.close();
    stopRequested = false;
  }
}

function printStatus() {
  const resultsPath = path.resolve(RESULTS_FILE);
  const { total, counts } = summarize(resultsPath);
  console.log("\n--- Estado de envíos ---");
  console.log("Registros totales:", total);
  for (const [estado, n] of Object.entries(counts)) {
    console.log(`  ${estado}: ${n}`);
  }
  console.log("------------------------\n");
}

async function menu() {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      console.log("\n=== WhatsApp Web Automation ===");
      console.log("[1] Modo prueba (no envía, solo escribe)");
      console.log("[2] Envío real");
      console.log("[3] Ver estado");
      console.log("[4] Salir");
      const choice = (await rl.question("Elige una opción: ")).trim();

      if (choice === "1") {
        await runCampaign({ send: false });
      } else if (choice === "2") {
        if (!SEND_MESSAGES) {
          console.log(
            '\nEnvío real bloqueado: define SEND_MESSAGES=true en el archivo .env para habilitarlo.\n' +
              "Valida primero con el modo prueba [1]."
          );
          continue;
        }
        const confirm = (
          await rl.question("Vas a ENVIAR mensajes reales. Escribe SI para confirmar: ")
        ).trim();
        if (confirm.toUpperCase() !== "SI") {
          console.log("Cancelado.");
          continue;
        }
        await runCampaign({ send: true });
      } else if (choice === "3") {
        printStatus();
      } else if (choice === "4") {
        console.log("Hasta luego.");
        break;
      } else {
        console.log("Opción inválida.");
      }
    }
  } finally {
    rl.close();
  }
}

menu().catch((err) => {
  console.error("Error inesperado:", err);
  process.exit(1);
});
