# Coach — entrenador personal con Apple Health + Claude

App de iPhone (SwiftUI, iOS 17+) que lee tus datos de Apple Health, te deja anotar lo que comes y, cada día, le pide a Claude que compare todo con tu plan de entrenamiento y te diga qué hiciste bien, qué hiciste mal y qué hacer mañana.

## Qué hace

- **Hoy**: sueño (total, profundo, REM, hora de dormir/despertar), pasos, calorías activas y totales, minutos de ejercicio, FC en reposo, VFC, peso y entrenamientos del día. Botón **Analizar mi día** → nota del 1 al 10, resumen, lo bueno, lo malo y acciones para mañana.
- **Comidas**: registro por día (desayuno, almuerzo, cena, snack, pre/post-entreno), con calorías y proteína opcionales. Si no pones cantidades, Claude las estima.
- **Plan**: pega tu plan de entrenamiento o impórtalo desde `.txt`, `.md` o `.pdf`. Se envía en cada análisis.
- **Historial**: todas las evaluaciones diarias.
- **Automático**: al abrir la app, si el día anterior no tiene evaluación, la genera sola. Recordatorio diario a las 21:00 para anotar comidas.

## Instalación sin Mac (desde el iPhone)

La app se compila en un Mac en la nube (GitHub Actions) y llega a tu iPhone por **TestFlight**.

1. **Apple Developer Program** (99 USD/año): inscríbete en https://developer.apple.com/programs/enroll desde el iPhone.
2. **Bundle ID**: en https://developer.apple.com/account/resources/identifiers crea un App ID, por ejemplo `com.tunombre.coach`, y marca **HealthKit**.
3. **App en App Store Connect**: en https://appstoreconnect.apple.com → Apps → **+** → Nueva app, con ese Bundle ID.
4. **Clave de API**: App Store Connect → Usuarios y acceso → Integraciones → **Claves de API del App Store Connect** → genera una con rol **Administrador**. Anota el *Issuer ID* y el *Key ID* y descarga el archivo `.p8`.
5. **Team ID**: en https://developer.apple.com/account → Membresía.
6. **Secretos en GitHub**: en este repositorio → Settings → Secrets and variables → Actions → *New repository secret*:
   - `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (el contenido completo del `.p8`), `APPLE_TEAM_ID`, `BUNDLE_ID`.
7. **Compilar y subir**: pestaña **Actions** → **iOS** → *Run workflow*. Unos 15 minutos después la build aparece en TestFlight.
8. Instala **TestFlight** desde el App Store, entra con tu Apple ID y instala **Coach**.
9. En la app: acepta los permisos de Salud, pega tu API key de Anthropic en **Ajustes** (créala en https://platform.claude.com) y carga tu plan en **Plan**.

### Con Mac (opcional)

```bash
brew install xcodegen && xcodegen generate && open Coach.xcodeproj
```

## Detalles técnicos

- Modelo: `claude-opus-5-5` vía HTTP (`/v1/messages`), salida JSON estructurada, `fallbacks: "default"` para reintentar en otro modelo si un clasificador rechaza la petición.
- La API key se guarda en el llavero (Keychain); comidas y evaluaciones en SwiftData, todo local en el iPhone. Solo se envía a Anthropic el informe del día y tu plan.
- Código: `Coach/Services/HealthKitManager.swift` (lectura de Salud), `DayReviewer.swift` (informe diario), `ClaudeService.swift` (llamada a Claude), `Coach/Views/` (pantallas).
