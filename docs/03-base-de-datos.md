# 3. Base de datos

El SQL completo está en [`supabase/migrations/0001_esquema_inicial.sql`](../supabase/migrations/0001_esquema_inicial.sql).

## Tablas

```
organizations ──< memberships >── auth.users ── profiles
      │
      ├──< clients ──< quotes ──< followups
      │        │          │
      │        └──< activities >┘
      │
      └──< message_templates
```

| Tabla | Para qué | Campos principales |
|---|---|---|
| `organizations` | La empresa cliente de CotizaFollow | `name`, `currency`, `timezone`, `followup_days` (ej. `{3,7,14}`), `plan`, `trial_ends_at` |
| `memberships` | Qué usuarios pertenecen a qué empresa y su rol | `org_id`, `user_id`, `role` (owner/admin/vendedor) |
| `profiles` | Datos del usuario | `full_name` |
| `clients` | Prospectos y clientes | `name`, `company`, `phone`, `email`, `notes` |
| `quotes` | Cotizaciones (= oportunidades) | `folio`, `title`, `amount`, `status`, `sent_at`, `sent_via`, `valid_until`, `lost_reason` |
| `followups` | Recordatorios programados | `due_date`, `kind` (automático/manual/promesa), `status` (pendiente/hecho/cancelado) |
| `activities` | Historial de contacto | `type` (llamada, whatsapp, nota, cambio_estado…), `body` |
| `message_templates` | Plantillas de mensajes | `name`, `channel`, `body` con variables |

Vista `followups_due`: seguimientos pendientes con datos de cliente y cotización, lista para la pantalla "Seguimientos de hoy".

## Automatizaciones (triggers)

| Evento | Qué hace |
|---|---|
| Usuario se registra | Crea perfil, organización, membresía y 4 plantillas de WhatsApp de ejemplo. |
| Cotización pasa a **enviada** | Fija `sent_at` (si falta) y crea seguimientos a +3, +7 y +14 días. |
| Cotización pasa a **ganada/perdida** | Fija `closed_at` y cancela seguimientos pendientes. |
| Cualquier cambio de estado | Registra una actividad `cambio_estado` (ej. "enviada → perdida (Precio)"). |
| Insertar cotización/seguimiento/actividad | Verifica que los registros relacionados sean de la misma organización. |

## Seguridad

- RLS activado en todas las tablas.
- `org_id` se llena solo (`default current_org_id()`): la app nunca lo envía, lo que evita errores.
- Probado: un segundo usuario consulta `clients` y obtiene 0 filas de la otra organización.

## Pendiente para etapas futuras

- `subscriptions` (Etapa 6): `stripe_customer_id`, `stripe_subscription_id`, `status`, `current_period_end`.
- `lost_reasons` catálogo configurable (hoy es texto libre).
- Índices de búsqueda de texto si un cliente supera ~10,000 registros.
