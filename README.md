# Simulador de chats (estilo iOS)

App web de una sola página (`index.html`) que simula un chat tipo iPhone. Todo ocurre en el navegador: nada se envía.

- Lista de chats con buscador, nuevo chat por número y **Difusión**: pega una lista de números (`número, nombre` por línea) y una plantilla con `{nombre}`, `{numero}`, `{fecha}`, `{hora}`.
- Estados simulados: reloj → ✓ → ✓✓ → ✓✓ leído, con respuestas automáticas al azar.
- Se guarda en `localStorage`. Modo claro/oscuro, gesto de deslizar desde el borde y márgenes seguros.

Uso: abrir `index.html` o activar GitHub Pages (Settings → Pages → rama `main`, carpeta `/`).
