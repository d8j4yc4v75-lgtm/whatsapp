# CotizaFollow

CRM ligero para dar seguimiento a cotizaciones y convertir más oportunidades en ventas.

**Estado:** Etapa 1 de 7 — registro/login, clientes y "Seguimientos de hoy". Ver [plan por etapas](docs/05-plan-por-etapas.md).

## Documentación

1. [Evaluación crítica y MVP](docs/01-evaluacion-y-mvp.md)
2. [Arquitectura y tecnologías](docs/02-arquitectura.md)
3. [Base de datos](docs/03-base-de-datos.md)
4. [Pantallas y UX](docs/04-pantallas-y-ux.md)
5. [Plan por etapas](docs/05-plan-por-etapas.md)

## Puesta en marcha (≈15 minutos)

### Requisitos
- [Node.js 20+](https://nodejs.org)
- Cuenta gratis en [Supabase](https://supabase.com)

### 1. Crear el proyecto en Supabase
1. En Supabase: **New project**. Región recomendada: la más cercana a México (ej. `us-east-1`).
2. Ve a **SQL Editor → New query**, pega todo el contenido de `supabase/migrations/0001_esquema_inicial.sql` y presiona **Run**.
3. Ve a **Authentication → URL Configuration** y agrega en *Redirect URLs*: `http://localhost:3000/auth/confirm`.
4. (Opcional, para pruebas) **Authentication → Sign In / Providers → Email**: desactiva *Confirm email* para entrar sin confirmar el correo.

### 2. Configurar la app
```bash
npm install
```
```bash
cp .env.example .env.local
```
Edita `.env.local` con los datos de **Project Settings → API** (Project URL y publishable key).

### 3. Ejecutar
```bash
npm run dev
```
Abre http://localhost:3000, crea una cuenta y registra tu primer cliente.

## Desplegar en Vercel
1. Sube el repositorio a GitHub e impórtalo en [vercel.com/new](https://vercel.com/new).
2. Agrega las mismas variables de `.env.local` (con `NEXT_PUBLIC_SITE_URL` = tu dominio).
3. En Supabase agrega `https://TU-DOMINIO/auth/confirm` a *Redirect URLs*.

## Comandos
| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Compila para producción (detecta errores de tipos) |
| `npm run lint` | Revisa la calidad del código |
