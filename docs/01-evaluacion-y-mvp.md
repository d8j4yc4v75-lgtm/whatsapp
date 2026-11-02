# 1. Evaluación crítica y alcance del MVP

## Lo que está bien

- **Problema real y concreto.** Las PyMEs de servicios pierden ventas por no dar seguimiento. Es medible: "¿cuántas cotizaciones enviaste el mes pasado y cuántas seguiste?".
- **Nicho claro.** Empresas que cotizan por WhatsApp. Los CRM grandes (HubSpot, Pipedrive, Zoho) son caros, en inglés o demasiado complejos para un técnico de aire acondicionado.
- **Ciclo corto de valor.** El usuario ve el beneficio el primer día: una lista de a quién escribir hoy.

## Debilidades y riesgos (y cómo mitigarlos)

| Riesgo | Por qué importa | Mitigación |
|---|---|---|
| **Fricción de captura** | Si registrar una cotización toma más de 30 s, el usuario vuelve a su libreta o a WhatsApp. Es la causa nº 1 de abandono de CRMs. | Formulario de cotización de 4 campos (cliente, concepto, importe, fecha). Crear cliente y cotización en un solo paso. |
| **Competencia "gratis"** | Excel, Google Sheets, recordatorios del celular, etiquetas de WhatsApp Business. | Diferenciarse en lo que Excel no hace: avisar, preparar el mensaje y medir conversión. |
| **WhatsApp Business ya tiene etiquetas** | Muchos usuarios creen que "ya lo tienen". | Vender el resultado ("recuperaste $X en cotizaciones olvidadas"), no las funciones. |
| **El usuario no abre la app** | Si nadie entra, no hay seguimiento. | Resumen diario por correo (Etapa 6) y, después, notificaciones. La pantalla de inicio es "Seguimientos de hoy", no un dashboard. |
| **Precio bajo = churn alto** | A $149 MXN, perder un cliente cuesta poco al cliente; cancelan fácil. | Venta anual con descuento; enfocarse en el plan Profesional. |
| **Dispersión de mercado** | 7 verticales a la vez diluye el mensaje. | Empezar con **1 vertical** (recomendado: aire acondicionado/refrigeración) para mensajes, plantillas y canales de venta específicos. |
| **Extensión de Chrome prematura** | Los técnicos trabajan desde el celular, no desde Chrome. | Posponer hasta validar. Priorizar que la web funcione perfecto en móvil. |
| **WhatsApp API oficial** | Envío automático requiere Meta Business, plantillas aprobadas y costo por conversación. | MVP con enlaces `wa.me` (gratis, sin aprobación). Evaluar API solo con clientes pagando. |

## Recomendación de precios

Los precios propuestos son razonables. Ajustes sugeridos:

- **Prueba gratis 14 días sin tarjeta** (ya implementado en el esquema: `trial_ends_at`).
- **Inicial $149** · 1 usuario · 50 cotizaciones activas.
- **Profesional $299** · 1 usuario · ilimitado · resumen diario por correo · reportes. ← el plan a empujar.
- **Equipo $499** · hasta 5 usuarios · asignación por vendedor · rendimiento de vendedores.
- Anual = 10 meses (2 gratis).

## MVP definitivo

Tu lista es correcta. Ajustes: se **agregan** dos cosas pequeñas de alto impacto y se **simplifican** otras.

| # | Función | Incluido en MVP | Nota |
|---|---|---|---|
| 1 | Registro / inicio de sesión | ✅ | Correo + contraseña. |
| 2 | Clientes | ✅ | Alta, edición, borrado, búsqueda, historial. |
| 3 | Cotizaciones | ✅ | Folio, concepto, importe, fecha de envío, vigencia. Sin PDF ni partidas. |
| 4 | Estados | ✅ | Borrador → Enviada → Negociación → Ganada / Perdida (+ motivo). |
| 5 | Recordatorios | ✅ | Automáticos a 3/7/14 días, configurables; reprogramar; "prometió responder el…". |
| 6 | Actividades | ✅ | Llamada, WhatsApp, correo, nota. Automáticas en cambios de estado. |
| 7 | Plantillas WhatsApp | ✅ | Variables `{cliente}`, `{importe}`… y botón "Abrir WhatsApp". |
| 8 | Seguimientos de hoy | ✅ | Pantalla principal. |
| + | **Indicadores básicos** | ✅ | Abiertas, valor en juego, ganadas, perdidas, conversión. Una sola consulta. |
| + | **Suscripción (cobro)** | ✅ | Sin cobro no se valida que paguen. Stripe Checkout. |
| – | Reportes avanzados, embudo visual | ❌ | Etapa posterior. |
| – | Equipos / multiusuario | ❌ | El esquema ya lo soporta; la UI se agrega después. |
| – | Correo integrado | ❌ | Solo `mailto:` con texto prellenado. |
| – | Extensión de Chrome | ❌ | Después de validar. |
| – | PDF de cotización | ❌ | La mayoría ya tiene su cotización en PDF/Excel. |

**Criterio de validación:** 10 empresas pagando durante 2 meses seguidos antes de construir funciones fuera del MVP.
