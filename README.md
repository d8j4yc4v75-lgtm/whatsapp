# Coach — entrenador personal con Apple Health + Claude

App de iPhone (SwiftUI, iOS 17+) que lee tus datos de Apple Health, te deja anotar lo que comes y, cada día, le pide a Claude que compare todo con tu plan de entrenamiento y te diga qué hiciste bien, qué hiciste mal y qué hacer mañana.

## Qué hace

- **Hoy**: sueño (total, profundo, REM, hora de dormir/despertar), pasos, calorías activas y totales, minutos de ejercicio, FC en reposo, VFC, peso y entrenamientos del día. Botón **Analizar mi día** → nota del 1 al 10, resumen, lo bueno, lo malo y acciones para mañana.
- **Comidas**: registro por día (desayuno, almuerzo, cena, snack, pre/post-entreno), con calorías y proteína opcionales. Si no pones cantidades, Claude las estima.
- **Plan**: pega tu plan de entrenamiento o impórtalo desde `.txt`, `.md` o `.pdf`. Se envía en cada análisis.
- **Historial**: todas las evaluaciones diarias.
- **Automático**: al abrir la app, si el día anterior no tiene evaluación, la genera sola. Recordatorio diario a las 21:00 para anotar comidas.

## Instalación

Necesitas un Mac con Xcode 15+ y tu iPhone (HealthKit no tiene datos en el simulador).

```bash
brew install xcodegen
xcodegen generate
open Coach.xcodeproj
```

1. En Xcode → target **Coach** → *Signing & Capabilities*: elige tu equipo (sirve el Apple ID gratuito) y cambia el Bundle ID si hace falta.
2. Conecta el iPhone y pulsa ▶︎.
3. En la app: acepta los permisos de Salud, ve a **Ajustes** y pega tu API key de Anthropic (créala en https://platform.claude.com).
4. Ve a **Plan** y carga tu plan de entrenamiento.

## Detalles técnicos

- Modelo: `claude-opus-5-5` vía HTTP (`/v1/messages`), salida JSON estructurada, `fallbacks: "default"` para reintentar en otro modelo si un clasificador rechaza la petición.
- La API key se guarda en el llavero (Keychain); comidas y evaluaciones en SwiftData, todo local en el iPhone. Solo se envía a Anthropic el informe del día y tu plan.
- Código: `Coach/Services/HealthKitManager.swift` (lectura de Salud), `DayReviewer.swift` (informe diario), `ClaudeService.swift` (llamada a Claude), `Coach/Views/` (pantallas).
