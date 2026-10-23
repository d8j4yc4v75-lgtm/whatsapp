# Coach

Tu entrenador personal en el iPhone. Lee tu sueño, pasos, calorías y entrenamientos de **Apple Salud** todos los días, sin capturas ni escribir: un atajo de la app Atajos los manda solo cada noche. Tú solo tomas foto de lo que comes. Cada noche Claude compara tu día con tu plan de entrenamiento y te llega una notificación con tu nota, qué hiciste bien, qué hiciste mal y qué hacer mañana.

Funciona igual que MultiWA: vive en Railway y se instala desde Safari. No necesitas Mac ni PC.

---

## Paso 1 · Publicar en Railway (una vez, unos 10 minutos)

1. Entra en **https://railway.com** con tu cuenta de GitHub. Abre el proyecto donde ya tienes MultiWA (o crea uno con **New Project**).
2. Toca **+ Create** › **GitHub Repo** › elige **whatsapp**.
3. Toca el cuadro nuevo › **Settings**:
   - **Source › Branch**: `claude/pensive-faraday-9aicmz`.
   - **Source › Root Directory**: `coach-server`.
   - **Networking › Generate Domain** (puerto `3000`).
4. Pestaña **Variables** › **New Variable**:
   - `ANTHROPIC_API_KEY` = tu clave de https://platform.claude.com (Settings › API keys).
   - Opcional: `REVIEW_HOUR` = hora de la evaluación diaria (por defecto `22`), `TZ_USUARIO` (por defecto `America/Monterrey`).
5. Clic derecho en el cuadro (en el teléfono: **+ Create**) › **Volume** › Mount path `/data`. Sin esto se borran tus datos en cada actualización.
6. Espera a que diga **Active** y copia la dirección, por ejemplo `https://coach-production-1234.up.railway.app`.

## Paso 2 · Instalar en el iPhone

1. Abre la dirección en **Safari** y **crea tu contraseña** de inmediato.
2. **Compartir** ⬆︎ › **Añadir a pantalla de inicio** › **Añadir**.
3. Abre **Coach** desde el ícono › **Ajustes** › **Activar notificaciones**.
4. **Plan**: sube tu plan de entrenamiento en PDF o foto, revisa el texto y toca **Guardar plan**.

## Paso 3 · Conectar Apple Salud (una vez)

En la app, **Ajustes › Conectar Apple Salud** tiene tu dirección secreta y los pasos para crear el atajo **Coach Salud** y su automatización diaria a las 21:30. A partir de ahí los datos llegan solos cada noche y la evaluación te llega como notificación.

## Uso diario

- **Comidas**: toca **Tomar foto del plato** y **Guardar**. El coach calcula calorías, proteína, carbohidratos y grasa. Puedes añadir texto para corregir.
- **Hoy**: tus métricas de Salud y la evaluación del día. **Analizar ahora** la genera cuando quieras.
- **Historial**: la nota de cada día.

## Costos

- Railway: el mismo plan que ya usas para MultiWA (este servicio consume muy poco).
- Claude API: se cobra por uso a tu clave; cada evaluación o foto de comida cuesta unos centavos de dólar.

<details>
<summary>Detalles técnicos</summary>

- Node.js + Express, sin base de datos: todo se guarda en `DATA_DIR/coach.json`.
- `POST /api/ingest/health?key=…` recibe cualquier formato del atajo (texto, formulario o JSON) y Claude lo convierte en métricas.
- Claude (`claude-opus-5-5`, salidas JSON con esquema, `fallbacks: "default"`) estima comidas por foto, transcribe el plan (PDF o imagen) y evalúa el día con la tendencia de los 7 días anteriores.
- Notificaciones con Web Push (claves VAPID generadas solas).
- Local: `npm install && ANTHROPIC_API_KEY=… npm start`.

</details>
