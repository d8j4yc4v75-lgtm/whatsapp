# 5. Plan de desarrollo por etapas

Cada etapa termina con algo que funciona y se puede probar.

| Etapa | Entregable | Estado |
|---|---|---|
| **0** | Evaluación, MVP, arquitectura, base de datos, pantallas (esta carpeta `docs/`) | ✅ |
| **1** | Proyecto Next.js + Supabase · registro/login · menú lateral · clientes (CRUD, búsqueda, historial, notas) · "Seguimientos de hoy" en modo lectura | ✅ |
| **2** | Cotizaciones: crear (con cliente nuevo o existente), listar con filtros, detalle, cambiar estado, motivo de pérdida | ⏳ Siguiente |
| **3** | Seguimientos: marcar hecho, reprogramar, "prometió responder", seguimiento manual, acciones rápidas en "Hoy" | |
| **4** | Plantillas: CRUD, variables, botón WhatsApp con mensaje prellenado, `mailto:` para correo | |
| **5** | Panel de indicadores y ajustes de empresa (intervalos, moneda) | |
| **6** | Suscripciones con Stripe (prueba 14 días, planes, portal, webhooks, bloqueo al vencer) + resumen diario por correo | |
| **7** | Lanzamiento: dominio, términos y aviso de privacidad, landing con precios, analítica, 10 clientes piloto | |
| 8+ | Reportes, equipos/vendedores, versión en inglés, extensión de Chrome | Después de validar |

## Cómo trabajaremos cada etapa

1. Te explico qué vamos a construir y por qué.
2. Escribo el código y lo subo a la rama.
3. Tú lo pruebas localmente (`npm run dev`) siguiendo una lista de verificación.
4. Si hay cambios de base de datos, ejecutas el nuevo archivo de `supabase/migrations/` en Supabase.
5. Despliegas en Vercel (automático al hacer merge a `main`).

## Validación comercial en paralelo (no esperes a terminar)

- Desde la Etapa 3, ofrece el producto gratis a 5 empresas conocidas a cambio de retroalimentación semanal.
- Pregunta: *"¿Cuántas cotizaciones enviaste el mes pasado? ¿A cuántas les diste seguimiento?"*
- Antes de la Etapa 6, pide a esos 5 que se comprometan a pagar al terminar la prueba.
