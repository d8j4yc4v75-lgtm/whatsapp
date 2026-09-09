# whatsapp-automation

Automatización LOCAL para enviar mensajes desde tu propia sesión de WhatsApp Web usando Playwright.

No evade bloqueos, límites ni CAPTCHA de WhatsApp. No automatiza el inicio de sesión: el QR se escanea manualmente la primera vez.

## Requisitos

- Node.js 18+
- Un teléfono con WhatsApp para escanear el QR la primera vez

## Instalación

```
npm install
```

(`npm install` ya descarga Chromium para Playwright vía `postinstall`).

## Estructura

```
whatsapp-automation/
├── data/contactos.csv     # tu base de contactos (CSV o Excel)
├── logs/resultados.csv    # resultado de cada envío (se genera solo)
├── session/                # perfil persistente del navegador (guarda tu sesión). NO subir a git.
├── src/whatsapp.js         # punto de entrada / menú
├── src/lib/                # módulos internos
├── .env                    # configuración local
└── package.json
```

## Base de contactos

`data/contactos.csv` (o un `.xlsx`/`.xls` con las mismas columnas):

```
telefono,mensaje
5218112345678,"Hola, este es un mensaje de prueba."
5218123456789,"Hola, este es otro mensaje de prueba."
```

- `telefono`: con código de país, solo dígitos (se limpia cualquier símbolo automáticamente).
- `mensaje`: texto a enviar. Admite saltos de línea dentro de las comillas.

Para usar un archivo distinto, cambia `CONTACTS_FILE` en `.env`.

## Configuración (`.env`)

| Variable | Descripción |
|---|---|
| `SEND_MESSAGES` | Debe ser `true` para habilitar la opción de envío real del menú. Con cualquier otro valor, el envío real queda bloqueado. |
| `CONTACTS_FILE` | Ruta al CSV/Excel de contactos. |
| `RESULTS_FILE` | Ruta al CSV de resultados. |
| `SESSION_DIR` | Carpeta del perfil persistente del navegador. |
| `DELAY_MS` | Pausa entre mensajes, en milisegundos. |
| `HEADLESS` | Debe quedar en `false` (necesario para escanear el QR y verificar visualmente). |

## Uso

```
npm start
```

Menú:

```
[1] Modo prueba
[2] Envío real
[3] Ver estado
[4] Salir
```

**Primer uso:** elige cualquier opción; se abrirá el navegador con el QR de WhatsApp Web. Escanéalo con tu teléfono. La sesión queda guardada en `session/` y no se vuelve a pedir el QR mientras esa carpeta exista.

**[1] Modo prueba:** abre cada chat, verifica que corresponde al número de la fila y escribe el mensaje, pero NO presiona enviar. Úsalo siempre primero para validar visualmente que todo funciona. Cada fila queda registrada en `logs/resultados.csv` con estado `PRUEBA`.

**[2] Envío real:** solo se habilita si `SEND_MESSAGES=true` en `.env`. Pide una confirmación adicional (`SI`) antes de empezar. Envía de verdad y registra `ENVIADO`.

**[3] Ver estado:** muestra cuántos registros hay por cada estado en `logs/resultados.csv`.

## Verificación y manejo de errores

- Antes de escribir el mensaje, se abre el panel de información del contacto y se compara el teléfono mostrado ahí contra el de la base. Si no coincide, se registra `ERROR` y se pasa al siguiente contacto (no se envía nada).
- Si un número no existe en WhatsApp, se registra `NO_ENCONTRADO` y continúa con el siguiente.
- Si la interfaz de WhatsApp Web cambia y algún elemento esperado no aparece, el proceso se detiene por completo (no sigue enviando a ciegas). El error queda registrado en el log.

## Reanudación

Al iniciar, se lee `logs/resultados.csv` y se omiten los números que ya tengan estado `ENVIADO`. Si el proceso se detiene (caída, cierre, Ctrl+C) y se vuelve a ejecutar, continúa solo con los contactos pendientes.

## Detener el proceso

`Ctrl+C` una vez: termina el contacto en curso y se detiene limpiamente (el log ya está escrito, no se pierde nada). `Ctrl+C` dos veces: salida forzada inmediata.

## Notas

- Los selectores de la interfaz de WhatsApp Web pueden cambiar con el tiempo; si el script se detiene con "ERROR CRÍTICO", probablemente WhatsApp actualizó su interfaz y hay que revisar los selectores en `src/lib/sender.js` y `src/lib/browser.js`.
- `session/` contiene tu sesión autenticada: no la compartas ni la subas a ningún repositorio (ya está en `.gitignore`).
