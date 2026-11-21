# MultiWA

Tus 5–8 WhatsApp en una sola app de iPhone. Todos los chats aparecen en una sola bandeja, y en cada conversación eliges desde qué número responder.

No necesitas Xcode ni saber programar. La app vive en internet (Railway) y la instalas desde Safari.

> ⚠️ Usa una conexión no oficial a WhatsApp (como WhatsApp Web). Va contra sus términos y existe riesgo de que bloqueen los números. No la uses para enviar mensajes masivos.

---

## Paso 1 · Publicar la app en Railway (una sola vez, unos 10 minutos)

Costo: plan Hobby de Railway, unos 5 USD al mes.

1. Entra en **https://railway.com** y toca **Login** › **Continue with GitHub** (usa la misma cuenta de GitHub donde está este proyecto).
2. Toca **New Project** › **Deploy from GitHub repo** › elige **whatsapp**.
   - Si no aparece, toca **Configure GitHub App** y dale acceso al repositorio `whatsapp`.
   - Si te pide plan, elige **Hobby**.
3. Cuando aparezca el cuadro del servicio en pantalla, **agrega el disco** donde se guardan tus sesiones (sin esto, cada actualización te obliga a vincular de nuevo):
   - Haz clic derecho sobre el cuadro (en el teléfono, toca el botón **+** o **Create**) › **Volume**.
   - En *Mount path* escribe: `/data` › **Create**.
4. Toca el cuadro del servicio › pestaña **Settings**:
   - En **Source › Branch** elige `claude/focused-hypatia-thy9kr` (ahí está la app). No hace falta si ya está en `main`.
   - En **Networking** toca **Generate Domain**. Si te pide el puerto, escribe `3000`.
5. Espera a que diga **Active** (2–4 minutos). Copia la dirección que aparece, por ejemplo `https://whatsapp-production-1234.up.railway.app`.

## Paso 2 · Instalar en el iPhone

1. Abre esa dirección en **Safari**.
2. **Crea tu contraseña** (hazlo de inmediato: la primera persona que entre es la que la crea).
3. Toca el botón **Compartir** (cuadro con flecha ⬆︎) › **Añadir a pantalla de inicio** › **Añadir**.
4. Abre **MultiWA** desde el ícono nuevo › **Ajustes** › **Activar notificaciones** › **Permitir**.

## Paso 3 · Vincular tus WhatsApp

En la pestaña **Cuentas** toca **＋**, ponle un nombre (Ventas, Personal…) y un color. Después vincúlala de una de estas dos formas:

- **Con código** (lo más fácil si ese WhatsApp está en el mismo iPhone): escribe el número de esa cuenta con código de país, toca **Obtener código** y en WhatsApp ve a **Ajustes › Dispositivos vinculados › Vincular un dispositivo › Vincular con número de teléfono** y escribe el código.
- **Con QR**: escanéalo desde el teléfono de esa cuenta en *Dispositivos vinculados*.

Repite el proceso con cada número.

## Uso diario

- **Bandeja**: todos los chats juntos. Filtra por cuenta, por no leídos o por etiqueta.
- **Dentro de un chat**: cada mensaje lleva el color y el nombre de la cuenta. Abajo, en **«Enviar desde»**, eliges con qué número responder.
- **＋** adjunta fotos, videos o documentos; **🎤** graba una nota de voz.
- **✏️** abre un chat nuevo con cualquier número.
- **🏷️** etiqueta un chat; las etiquetas se crean en Ajustes.

## Si algo falla

- **La app no carga**: en Railway revisa que el servicio diga *Active*. Si dice *Crashed*, toca **Redeploy**.
- **Una cuenta dice «Sin vincular»**: entra en ella y toca **Vincular este WhatsApp**. WhatsApp cierra un dispositivo vinculado si el teléfono principal pasa unos 14 días sin conectarse.
- **No llegan notificaciones**: la app tiene que estar instalada desde «Añadir a pantalla de inicio» (iOS 16.4 o más reciente) y con permiso en Ajustes del iPhone › Notificaciones › MultiWA.

---

<details>
<summary>Detalles técnicos</summary>

- `server/`: Node.js + [Baileys](https://github.com/WhiskeySockets/Baileys) (sesiones multi-dispositivo), SQLite, Express y WebSocket. Las notificaciones usan Web Push con claves VAPID que se generan solas.
- `server/public/`: la web app (PWA) sin paso de compilación.
- `Dockerfile` + `railway.json`: despliegue. Los datos se guardan en `DATA_DIR` (`/data` en Docker).
- Para correrlo en local: `cd server && npm install && npm start` (requiere Node 20+ y ffmpeg).

</details>
