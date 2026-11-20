# Coach — entrenador personal con Apple Health + Claude

Tu entrenador personal: lee tus datos de Apple Salud, registra lo que comes (con texto o foto) y tu entreno, arma tu rutina y cada día evalúa con Claude qué hiciste bien, qué hiciste mal y qué hacer mañana.

- **Hoy**: evaluación del día, registro rápido («desayuné 3 huevos, entrené pierna, peso 103.5»), datos de Salud contra tus metas, entreno del día con casillas y pesos usados, y chat con el coach.
- **Comidas**: calorías y macros estimadas por foto o texto, contra tu meta del día.
- **Rutina**: semana de entrenamiento y metas diarias que el coach ajusta con tus resultados; tu plan base.
- **Cuerpo**: peso, IMC, cintura, % grasa y gráfica de tu peso.
- **Historial**: notas de los últimos 14 días y promedios de la semana.

## Instalar en el iPhone con una Mac (gratis)

La app de iPhone lee Salud directamente y muestra Coach Diario (la página de Claude) con tus datos. No usa correo ni atajos.

1. Instala **Xcode** desde la App Store de la Mac y ábrelo una vez.
2. En Xcode: **Settings › Accounts › +** › inicia sesión con tu Apple ID (sirve la cuenta gratis).
3. Conecta el iPhone con cable, desbloquéalo y toca **Confiar**. Si el iPhone lo pide, activa **Ajustes › Privacidad y seguridad › Modo de desarrollador**.
4. En la Terminal de la Mac, dentro de esta carpeta: `bash mac/instalar.sh`
5. La primera vez, en el iPhone: **Ajustes › General › VPN y gestión de dispositivos** › tu Apple ID › **Confiar**.
6. Abre **Coach**, permite el acceso a Salud e inicia sesión en Claude dentro de la app (con «Continuar con Apple» o con tu correo).

Con la cuenta gratis de Apple la app deja de abrir a los 7 días: vuelve a correr `bash mac/instalar.sh` con el iPhone conectado. Tus datos no se pierden; viven en tu cuenta de Claude.

## Detalles técnicos

- `web/coach.html`: la app (página de Claude). Guarda en tu cuenta de Claude y usa tu plan de Claude para las evaluaciones.
- `Coach/App/HealthReader.swift`: lee los totales del día de Salud (sin contar doble iPhone y Apple Watch) y el sueño de una sola fuente.
- `Coach/App/CoachApp.swift`: abre la página con los datos en el `#ancla` (`#salud~d20261120_t1415_p6240_…`) cada vez que abres la app o deslizas hacia abajo.
- `mac/instalar.sh`: compila e instala en el iPhone conectado.
