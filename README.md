# MultiWA

App para iPhone con una **bandeja unificada** para 5–8 cuentas de WhatsApp: todos los chats en una sola lista y, dentro de cada conversación, eliges desde qué WhatsApp enviar (puedes responder desde el 1 y luego desde el 2 en el mismo hilo).

```
iPhone (app MultiWA)  ⇄  servidor en tu computadora (Node.js)  ⇄  WhatsApp (dispositivos vinculados)
```

Cada cuenta se conecta como un **dispositivo vinculado** (igual que WhatsApp Web), con QR o con código de 8 caracteres. El servidor mantiene las sesiones abiertas y guarda los mensajes; la app se conecta a él.

> ⚠️ Usa la biblioteca no oficial [Baileys](https://github.com/WhiskeySockets/Baileys). Va contra los términos de WhatsApp y existe riesgo de que bloqueen los números. Evita mensajes masivos o spam.

## Funciones

- Bandeja unificada de todas las cuentas, con buscador.
- Una conversación por contacto que junta los mensajes de todas tus cuentas; cada mensaje muestra la etiqueta de color de la cuenta que lo envió o recibió.
- Selector **«Enviar desde»** en cada chat.
- Texto, fotos, videos, documentos y notas de voz (enviar y recibir).
- Filtros por cuenta, por no leídos y por etiquetas propias.
- Iniciar chats nuevos con cualquier número, desde la cuenta que elijas.
- Notificaciones locales y, opcionalmente, push (APNs).
- Confirmaciones de entrega y lectura.

## 1. Servidor (en tu computadora)

Requisitos: Node.js 20 o más reciente y, recomendado, `ffmpeg` (sirve para enviar notas de voz y para reproducir en el iPhone los audios recibidos).

```bash
# macOS
brew install node ffmpeg

cd server
npm install
npm start
```

La terminal mostrará algo así:

```
MultiWA servidor activo
  URL:   http://192.168.1.10:3000
  Token: 3f9c...e1
  QR en el navegador: http://localhost:3000/?token=3f9c...e1
```

- La computadora tiene que estar encendida y sin suspenderse (en macOS: `caffeinate -i npm start`).
- Los datos (sesiones, mensajes y archivos) se guardan en `server/data/`. **No compartas esa carpeta**: contiene tus sesiones de WhatsApp.
- Opcional: crea `server/.env` con `PORT=3000` o `API_TOKEN=tu_token`.

## 2. App de iPhone

Requisitos: Mac con Xcode 16 o más reciente; iPhone con iOS 17 o más reciente.

1. Abre `ios/MultiWA.xcodeproj` en Xcode.
2. Elige el target **MultiWA** › *Signing & Capabilities* › en **Team** selecciona tu Apple ID y cambia el *Bundle Identifier* por uno único (ej. `com.tunombre.multiwa`).
3. Conecta el iPhone, selecciónalo arriba y pulsa ▶︎. La primera vez, en el iPhone ve a *Ajustes › General › VPN y gestión de dispositivos* y confía en tu certificado.
4. En la app, escribe la **URL** y el **Token** que mostró el servidor y pulsa *Guardar*.

Con un Apple ID gratuito la app caduca cada 7 días y hay que volver a instalarla desde Xcode. Con la cuenta de desarrollador (99 USD/año) dura un año y se pueden activar las notificaciones push.

## 3. Vincular las cuentas

En la pestaña **Cuentas** › **+** pon un nombre y un color, y luego:

- **QR:** desde el teléfono de esa cuenta, en WhatsApp › Ajustes › Dispositivos vinculados › Vincular un dispositivo, escanea el código. Puedes verlo en la app o en el navegador de la computadora (`http://localhost:3000/?token=...`).
- **Código (sin escanear):** útil si ese WhatsApp está en el mismo iPhone. Escribe el número de la cuenta, pulsa *Obtener código* y en WhatsApp elige *Vincular con número de teléfono*.

Repite el proceso con cada número. Los teléfonos no necesitan quedarse encendidos, pero WhatsApp cierra un dispositivo vinculado si el teléfono principal pasa unos 14 días sin conectarse.

## Acceso fuera de casa

En la misma red Wi‑Fi basta con la URL local. Para usarla desde cualquier lugar, instala [Tailscale](https://tailscale.com) en la computadora y en el iPhone (es gratis) y usa la IP de Tailscale de la computadora: `http://100.x.y.z:3000`.

## Notificaciones push (opcional)

Sin push, solo recibes avisos mientras la app está abierta. Para recibirlos con la app cerrada necesitas la cuenta de desarrollador:

1. En Xcode › *Signing & Capabilities* › **+ Capability** › *Push Notifications*.
2. En [developer.apple.com](https://developer.apple.com/account/resources/authkeys/list) crea una **Key** con APNs y descarga el `.p8`.
3. Crea `server/.env`:

```
APNS_KEY_FILE=/ruta/AuthKey_XXXXXXXXXX.p8
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=YYYYYYYYYY
APNS_BUNDLE_ID=com.tunombre.multiwa
# false si instalas desde Xcode; true para TestFlight o App Store
APNS_PRODUCTION=false
```

4. Reinicia el servidor y abre la app (ella registra el dispositivo sola).

## API del servidor

Todas las rutas usan el encabezado `Authorization: Bearer <token>`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/accounts` | Cuentas y su estado |
| POST | `/api/accounts` | `{name, color}` crea una cuenta y genera su QR |
| POST | `/api/accounts/:id/pairing-code` | `{phone}` código de vinculación |
| POST | `/api/accounts/:id/connect` · `/logout` | Volver a vincular / cerrar sesión |
| DELETE | `/api/accounts/:id` | Eliminar la cuenta |
| GET | `/api/conversations` | Bandeja unificada (`?accountId=&labelId=&unread=1&q=`) |
| GET | `/api/conversations/:jid/messages` | Mensajes de todas las cuentas (`?before=&limit=`) |
| POST | `/api/conversations/:jid/read` | Marcar como leído |
| PUT | `/api/conversations/:jid/labels` | `{labelIds}` |
| POST | `/api/send` | `{accountId, jid \| phone, text}` |
| POST | `/api/send-media` | multipart: `accountId, jid, file, kind, caption, ptt` |
| GET | `/api/media/:accountId/:msgId` | Descargar un archivo |
| GET/POST/DELETE | `/api/labels` | Etiquetas |
| WS | `/ws?token=` | Eventos en tiempo real |
