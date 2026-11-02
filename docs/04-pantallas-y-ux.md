# 4. Pantallas y experiencia de usuario

## Principios

1. **La app abre en "Seguimientos de hoy".** Responde una sola pregunta: *¿a quién le escribo ahora?*
2. **Una acción principal por pantalla**, en azul. Lo demás, secundario.
3. **Móvil primero.** Los técnicos trabajan desde el celular; menú lateral se convierte en menú hamburguesa.
4. **Cero jerga de CRM.** "Cotización", no "deal"; "Seguimiento", no "task".
5. **Máximo 4 campos obligatorios** en cualquier formulario.

## Mapa de pantallas

| Ruta | Pantalla | Estado |
|---|---|---|
| `/` | Landing con propuesta de valor | ✅ Etapa 1 |
| `/registro`, `/login` | Crear cuenta / entrar | ✅ Etapa 1 |
| `/hoy` | **Seguimientos de hoy**: indicadores (hoy, atrasados, valor) + lista con botón WhatsApp | ✅ Etapa 1 (lectura) · acciones en Etapa 3 |
| `/clientes` | Tabla con buscador | ✅ Etapa 1 |
| `/clientes/nuevo`, `/clientes/[id]/editar` | Formulario de cliente | ✅ Etapa 1 |
| `/clientes/[id]` | Ficha: contacto, cotizaciones, historial + registrar actividad | ✅ Etapa 1 |
| `/cotizaciones` | Tabla con filtros por estado + embudo simple | Etapa 2 |
| `/cotizaciones/nueva` | Cliente (existente o nuevo) + concepto + importe + fecha | Etapa 2 |
| `/cotizaciones/[id]` | Detalle, cambiar estado, seguimientos, historial | Etapa 2 |
| `/plantillas` | Biblioteca de mensajes con vista previa de variables | Etapa 4 |
| `/panel` | Indicadores: abiertas, valor, ganadas, perdidas, conversión, actividad reciente | Etapa 5 |
| `/ajustes` | Empresa, intervalos de seguimiento, suscripción | Etapa 6 |

## Flujo clave: del seguimiento a la venta (Etapa 3)

```
Seguimientos de hoy
 └─ Tarjeta: "Juan Pérez · Minisplit 2 ton · $18,500 · 2 días de atraso"
     ├─ [WhatsApp]  → elige plantilla → se abre WhatsApp con el texto listo
     │                → al volver: "¿Lo enviaste?" [Sí] → registra actividad y marca hecho
     ├─ [Hecho ▾]   → Respondió / No contestó / Prometió responder el [fecha]
     ├─ [Reprogramar] → +1 día / +3 días / elegir fecha
     └─ [Ganada] [Perdida → motivo]
```
