# 2. Arquitectura y tecnologías

## Stack elegido

| Capa | Tecnología | Por qué |
|---|---|---|
| Aplicación web | **Next.js 16** (React, TypeScript) | Estándar de la industria; frontend y backend en un solo proyecto; la IA lo conoce muy bien. |
| Estilos | **Tailwind CSS 4** | Diseño profesional sin escribir CSS a mano. |
| Base de datos + login | **Supabase** (PostgreSQL + Auth) | Postgres real (tus datos son portables), autenticación lista, seguridad por filas (RLS). Plan gratis generoso. |
| Hosting | **Vercel** | Despliegue automático con cada `git push`. Sin servidores que mantener. |
| Pagos | **Stripe** (Billing + Checkout) | Suscripciones recurrentes en MXN y USD, portal de cliente incluido. Alternativa en MX: Mercado Pago. |
| Correo transaccional | **Resend** (después) | Resumen diario de seguimientos. |
| Extensión | Chrome Manifest V3 (después) | Usará la misma API y la misma sesión de Supabase. |

**Sin dependencia cerrada:** todo el código vive en tu repositorio de GitHub. Supabase es Postgres estándar: si mañana quieres moverte, exportas la base y cambias el hosting.

## Diagrama

```
 Navegador / Celular ──┐
                       ├──► Vercel (Next.js) ──► Supabase (Postgres + Auth + RLS)
 Extensión Chrome ─────┘          │
                                  ├──► Stripe (suscripciones, webhooks)
                                  └──► Resend (correos)  [cron diario]
```

## Cómo está organizado el código

```
src/
  proxy.ts                 Protege rutas privadas y refresca la sesión
  app/
    page.tsx               Página pública (landing)
    (auth)/                Login y registro (+ actions.ts)
    auth/confirm/          Destino del correo de confirmación
    (app)/                 Todo lo que requiere sesión (menú lateral)
      hoy/                 Seguimientos de hoy  ← pantalla principal
      clientes/            Lista, alta, detalle, edición (+ actions.ts)
  components/              Piezas visuales reutilizables
  lib/
    supabase/              Conexión a Supabase (servidor y proxy)
    auth.ts                Usuario y organización actual
    format.ts              Dinero, fechas, WhatsApp
    types.ts               Tipos de datos
supabase/migrations/       Esquema de base de datos (SQL)
docs/                      Esta documentación
```

## Decisiones clave

1. **Server Components + Server Actions.** Las páginas consultan la base desde el servidor y los formularios llaman funciones del servidor (`actions.ts`). No hay API REST que mantener.
2. **Seguridad en la base de datos (RLS).** Cada tabla tiene `org_id` y políticas que solo permiten ver/editar datos de tu organización. Aunque el código tenga un error, un cliente nunca verá datos de otro.
3. **Multi-organización desde el día 1.** Hoy 1 usuario = 1 organización. El plan Equipo solo requiere una pantalla para invitar usuarios; el esquema no cambia.
4. **Lógica crítica en la base.** Programar seguimientos al enviar una cotización y cancelarlos al ganar/perder se hace con triggers. Funciona igual desde la web, la extensión o una futura app móvil.
5. **Migraciones versionadas.** Cada cambio de base de datos es un archivo nuevo en `supabase/migrations/` (`0002_...sql`). Nunca se edita uno ya aplicado en producción.

## Costos estimados (mensual)

| Servicio | Inicio (0–50 clientes) | Crecimiento |
|---|---|---|
| Vercel Hobby → Pro | $0 → US$20 | Pro es obligatorio para uso comercial al cobrar. |
| Supabase Free → Pro | $0 → US$25 | Free pausa proyectos inactivos; pasar a Pro al lanzar. |
| Dominio | ~US$12/año | |
| Stripe | 3.6% + $3 MXN por cobro | Sin mensualidad. |
| Resend | $0 (3,000 correos/mes) | |
| **Total al lanzar** | **≈ US$45/mes** | Se cubre con ~3 clientes Profesional. |

Presupuesto restante (de US$1,000) → dominio, logo, 2–3 meses de servicios y anuncios de prueba.
