# whatsapp

Envío masivo y programado de mensajes de WhatsApp usando [whatsapp-web.js](https://wwebjs.dev/).

## Uso

```bash
npm install
cp .env.example .env
npm start
```

Escanea el código QR con WhatsApp (Dispositivos vinculados) la primera vez. La sesión se guarda localmente para no repetir el escaneo.

## Contactos

Edita `data/contacts.csv` (o apunta `CONTACTS_FILE` en `.env` a otro archivo `.csv`/`.json`):

| columna  | descripción                                              |
|----------|-----------------------------------------------------------|
| phone    | número con código de país, solo dígitos (ej. 5215512345678) |
| message  | texto a enviar                                             |
| sendAt   | fecha ISO opcional; vacío = envío inmediato                |

Los mensajes sin `sendAt` se envían en orden con un retardo aleatorio entre ellos (`SEND_DELAY_MIN_MS`/`SEND_DELAY_MAX_MS`) para reducir el riesgo de bloqueo. Los que tienen `sendAt` futuro se programan automáticamente.
