# MultiMail

Bandeja unificada para varias cuentas de correo (IMAP/SMTP), instalable en el iPhone desde Safari, igual que la app de WhatsApp. Lee todos tus correos en una sola lista y responde eligiendo desde qué cuenta.

No usa nada no oficial: se conecta por los protocolos estándar **IMAP** (recibir) y **SMTP** (enviar), así que no hay riesgo de bloqueos.

## Publicar en Railway

Es un proyecto aparte del de WhatsApp, pero vive en el mismo repositorio. En Railway:

1. **New Project** › **Deploy from GitHub repo** › elige **whatsapp**.
2. Abre el servicio › **Settings** › **Source**:
   - **Branch**: `claude/focused-hypatia-thy9kr`
   - **Root Directory**: `mail`  ← importante, para que use esta carpeta y no la de WhatsApp.
3. Agrega un **Volume** montado en `/data` (para no perder la contraseña ni la caché de correos).
4. **Settings › Networking › Generate Domain** (puerto `3000`).
5. Cuando diga **Active**, abre la dirección en Safari, crea tu contraseña y **Compartir ⬆︎ › Añadir a pantalla de inicio**.

## Agregar un correo

En **Cuentas › ＋** escribe el correo y la contraseña. La app detecta el proveedor solo (Gmail, Outlook, Yahoo, Zoho, iCloud) mirando a dónde apunta el dominio. Si hace falta, en **Ajustes avanzados** puedes poner el servidor IMAP/SMTP a mano.

- **Gmail / Outlook / Yahoo / iCloud con verificación en dos pasos:** usa una **contraseña de aplicación**, no tu contraseña normal.
- **Zoho (dominio propio):** tu contraseña de Zoho, o una contraseña de aplicación si activaste 2FA. Servidores `imap.zoho.com` y `smtp.zoho.com`.

## Funciones

- Bandeja unificada de todas las cuentas, con buscador y filtros por cuenta, no leídos y etiquetas.
- Hilos agrupados por asunto; ver correos con HTML e imágenes y descargar adjuntos.
- Responder, responder a todos y reenviar, eligiendo la cuenta.
- Redactar un correo nuevo.
- Notificaciones de correo nuevo (Web Push) aunque la app esté cerrada.
- Etiquetas propias y acceso con contraseña.

## Correr en local

Requiere Node 20+. `cd mail && npm install && npm start`.
