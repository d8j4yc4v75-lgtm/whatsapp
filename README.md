# Simulador de chats (estilo iOS)

App web de una sola página (`index.html`) que simula un chat tipo iPhone. Todo ocurre en el navegador: nada se envía.

- Lista de chats con buscador, nuevo chat por número y **Difusión**: pega una lista de números (`número, nombre` por línea) y una plantilla con `{nombre}`, `{numero}`, `{fecha}`, `{hora}`.
- Estados simulados: reloj → ✓ → ✓✓ → ✓✓ leído (sin respuestas).
- Horario: reparte los envíos entre dos horas (ej. 10:00–15:00). Horas pasadas se registran con esa hora; las futuras se envían a su hora con la página abierta o al volver a abrirla.
- Se guarda en `localStorage`. Modo claro/oscuro, gesto de deslizar desde el borde y márgenes seguros.

Uso: abrir `index.html` o activar GitHub Pages (Settings → Pages → rama `main`, carpeta `/`).

## Conectar tu WhatsApp (Baileys)

La carpeta `server/` contiene un servidor Node que vincula tu WhatsApp con [Baileys](https://github.com/WhiskeySockets/Baileys) y sirve la app.

```bash
cd server
npm install
WA_TOKEN=una-clave npm start   # http://localhost:3000
```

1. Abre la app y toca **Ajustes** (barra inferior) → **Conectar mi WhatsApp**.
2. Escanea el QR desde WhatsApp → Dispositivos vinculados → Vincular un dispositivo.
3. Activa **Enviar por mi WhatsApp**: chats, difusiones y programados salen de verdad, las palomitas son reales y las respuestas entrantes aparecen en sus chats. Desactivado, todo sigue simulado.

Si la app se abre desde GitHub Pages, escribe en Ajustes la URL del servidor (debe ser `https`) y el token.

Variables: `PORT` (3000), `WA_TOKEN` (protege la API; recomendado si el servidor es público), `DEFAULT_CC` (lada para números de 10 dígitos, `52`), `SEND_MIN_MS`/`SEND_MAX_MS` (pausa aleatoria entre envíos, 1500–4000), `AUTH_DIR` (carpeta de la sesión, `server/auth`; usa un volumen persistente al desplegar).
