-- =====================================================================
-- CotizaFollow - Esquema inicial (MVP)
-- Ejecutar en Supabase: SQL Editor > New query > pegar todo > Run
-- =====================================================================
-- Conceptos clave:
--   * Multi-empresa desde el día 1: todo dato pertenece a una "organización".
--     Hoy cada usuario tiene una organización; mañana se agregan vendedores
--     (plan Equipo) sin cambiar el esquema.
--   * Row Level Security (RLS): la base de datos garantiza que un usuario
--     solo ve los datos de su organización, aunque haya errores en la app.
--   * Los seguimientos se programan automáticamente al marcar una
--     cotización como "enviada" (trigger en la base de datos).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------
create type public.quote_status as enum ('borrador', 'enviada', 'negociacion', 'ganada', 'perdida');
create type public.send_channel as enum ('whatsapp', 'email', 'presencial', 'otro');
create type public.followup_status as enum ('pendiente', 'hecho', 'cancelado');
create type public.followup_kind as enum ('automatico', 'manual', 'promesa');
create type public.activity_type as enum (
  'nota', 'llamada', 'whatsapp', 'email', 'reunion',
  'cambio_estado', 'seguimiento_hecho', 'seguimiento_reprogramado'
);
create type public.member_role as enum ('owner', 'admin', 'vendedor');

-- ---------------------------------------------------------------------
-- Organizaciones y usuarios
-- ---------------------------------------------------------------------
create table public.organizations (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  currency           text not null default 'MXN',
  locale             text not null default 'es-MX',
  timezone           text not null default 'America/Mexico_City',
  followup_days      int[] not null default '{3,7,14}',
  plan               text not null default 'prueba',
  trial_ends_at      timestamptz not null default (now() + interval '14 days'),
  created_at         timestamptz not null default now()
);

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  created_at  timestamptz not null default now()
);

create table public.memberships (
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.member_role not null default 'owner',
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Funciones auxiliares (security definer evita recursión en RLS)
create or replace function public.is_org_member(p_org uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where org_id = p_org and user_id = auth.uid()
  );
$$;

-- Organización "actual" del usuario (MVP: la primera a la que pertenece).
-- Se usa como valor por defecto de org_id, así la app no tiene que enviarlo.
create or replace function public.current_org_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select org_id from public.memberships
  where user_id = auth.uid()
  order by created_at
  limit 1;
$$;

-- ---------------------------------------------------------------------
-- Clientes
-- ---------------------------------------------------------------------
create table public.clients (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.current_org_id() references public.organizations (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  company     text,
  phone       text,
  email       text,
  notes       text,
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index clients_org_idx on public.clients (org_id, created_at desc);

-- ---------------------------------------------------------------------
-- Cotizaciones (= oportunidades en el MVP)
-- ---------------------------------------------------------------------
create table public.quotes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.current_org_id() references public.organizations (id) on delete cascade,
  client_id     uuid not null references public.clients (id) on delete cascade,
  owner_id      uuid default auth.uid() references auth.users (id) on delete set null,
  folio         text,
  title         text not null check (length(trim(title)) > 0),
  description   text,
  amount        numeric(14, 2) not null default 0 check (amount >= 0),
  currency      text not null default 'MXN',
  status        public.quote_status not null default 'borrador',
  sent_at       date,
  sent_via      public.send_channel,
  valid_until   date,
  closed_at     date,
  lost_reason   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index quotes_org_status_idx on public.quotes (org_id, status);
create index quotes_client_idx on public.quotes (client_id);

-- ---------------------------------------------------------------------
-- Seguimientos programados
-- ---------------------------------------------------------------------
create table public.followups (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.current_org_id() references public.organizations (id) on delete cascade,
  quote_id      uuid not null references public.quotes (id) on delete cascade,
  assigned_to   uuid default auth.uid() references auth.users (id) on delete set null,
  due_date      date not null,
  kind          public.followup_kind not null default 'manual',
  status        public.followup_status not null default 'pendiente',
  note          text,
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index followups_due_idx on public.followups (org_id, status, due_date);
create index followups_quote_idx on public.followups (quote_id);

-- ---------------------------------------------------------------------
-- Actividades (historial: llamadas, mensajes, notas, cambios de estado)
-- ---------------------------------------------------------------------
create table public.activities (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.current_org_id() references public.organizations (id) on delete cascade,
  client_id   uuid not null references public.clients (id) on delete cascade,
  quote_id    uuid references public.quotes (id) on delete cascade,
  user_id     uuid default auth.uid() references auth.users (id) on delete set null,
  type        public.activity_type not null,
  body        text,
  created_at  timestamptz not null default now()
);
create index activities_org_idx on public.activities (org_id, created_at desc);
create index activities_client_idx on public.activities (client_id, created_at desc);

-- ---------------------------------------------------------------------
-- Plantillas de mensajes
-- Variables: {cliente} {empresa} {cotizacion} {importe} {folio} {mi_empresa}
-- ---------------------------------------------------------------------
create table public.message_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.current_org_id() references public.organizations (id) on delete cascade,
  name        text not null,
  channel     public.send_channel not null default 'whatsapp',
  body        text not null,
  position    int not null default 0,
  created_at  timestamptz not null default now()
);

-- =====================================================================
-- Automatizaciones (triggers)
-- =====================================================================

-- updated_at automático
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger clients_touch before update on public.clients
  for each row execute function public.touch_updated_at();
create trigger quotes_touch before update on public.quotes
  for each row execute function public.touch_updated_at();

-- Al cambiar el estado de una cotización:
--   * a 'enviada'  -> programa seguimientos (ej. +3, +7, +14 días)
--   * a 'ganada' / 'perdida' -> cancela seguimientos pendientes y fija closed_at
--   * siempre -> registra la actividad 'cambio_estado'

-- Paso 1 (BEFORE): ajusta fechas en la propia fila.
create or replace function public.quote_status_dates()
returns trigger language plpgsql as $$
begin
  if new.status = 'enviada' then
    new.sent_at := coalesce(new.sent_at, current_date);
  end if;
  if new.status in ('ganada', 'perdida') then
    new.closed_at := coalesce(new.closed_at, current_date);
  else
    new.closed_at := null;
  end if;
  return new;
end;
$$;

create trigger quotes_status_before
  before insert or update of status on public.quotes
  for each row execute function public.quote_status_dates();

-- Paso 2 (AFTER): crea/cancela seguimientos y registra la actividad.
create or replace function public.quote_status_effects()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_days int[];
  v_day  int;
begin
  if tg_op = 'UPDATE' and new.status = old.status then
    return null;
  end if;

  if new.status = 'enviada' and not exists (
    select 1 from public.followups
    where quote_id = new.id and kind = 'automatico'
  ) then
    select followup_days into v_days from public.organizations where id = new.org_id;
    foreach v_day in array coalesce(v_days, '{3,7,14}') loop
      insert into public.followups (org_id, quote_id, assigned_to, due_date, kind)
      values (new.org_id, new.id, new.owner_id, new.sent_at + v_day, 'automatico');
    end loop;
  end if;

  if new.status in ('ganada', 'perdida') then
    update public.followups
       set status = 'cancelado'
     where quote_id = new.id and status = 'pendiente';
  end if;

  insert into public.activities (org_id, client_id, quote_id, user_id, type, body)
  values (
    new.org_id, new.client_id, new.id, auth.uid(), 'cambio_estado',
    case when tg_op = 'INSERT' then 'Cotización creada: ' || new.status::text
         else old.status::text || ' → ' || new.status::text end ||
    case when new.status = 'perdida' and new.lost_reason is not null
         then ' (' || new.lost_reason || ')' else '' end
  );

  return null;
end;
$$;

create trigger quotes_status_after
  after insert or update of status on public.quotes
  for each row execute function public.quote_status_effects();

-- Al registrarse un usuario: crea perfil, organización, membresía y
-- plantillas de mensajes de ejemplo.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_org uuid;
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');

  insert into public.organizations (name)
  values (coalesce(nullif(new.raw_user_meta_data ->> 'company', ''), 'Mi empresa'))
  returning id into v_org;

  insert into public.memberships (org_id, user_id, role)
  values (v_org, new.id, 'owner');

  insert into public.message_templates (org_id, name, channel, body, position) values
  (v_org, 'Envío de cotización', 'whatsapp',
   'Hola {cliente}, le comparto la cotización {folio} de {cotizacion} por {importe}. Quedo atento a cualquier duda. Saludos, {mi_empresa}.', 1),
  (v_org, 'Primer seguimiento (3 días)', 'whatsapp',
   'Hola {cliente}, ¿tuvo oportunidad de revisar la cotización de {cotizacion}? Con gusto le resuelvo cualquier duda.', 2),
  (v_org, 'Segundo seguimiento (7 días)', 'whatsapp',
   'Hola {cliente}, le escribo para dar seguimiento a la cotización de {cotizacion} por {importe}. ¿Le gustaría que agendemos el servicio o ajustamos algo de la propuesta?', 3),
  (v_org, 'Último seguimiento (14 días)', 'whatsapp',
   'Hola {cliente}, no quiero insistir de más. ¿Sigue interesado en {cotizacion}? Si por ahora no es buen momento, dígame y lo contacto más adelante.', 4);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.organizations     enable row level security;
alter table public.profiles          enable row level security;
alter table public.memberships       enable row level security;
alter table public.clients           enable row level security;
alter table public.quotes            enable row level security;
alter table public.followups         enable row level security;
alter table public.activities        enable row level security;
alter table public.message_templates enable row level security;

create policy "org: ver la propia" on public.organizations
  for select using (public.is_org_member(id));
create policy "org: editar la propia" on public.organizations
  for update using (public.is_org_member(id)) with check (public.is_org_member(id));

create policy "perfil: ver propio" on public.profiles
  for select using (id = auth.uid());
create policy "perfil: editar propio" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy "membresias: ver las de mi org" on public.memberships
  for select using (public.is_org_member(org_id));

-- Mismo patrón para todas las tablas de negocio
do $$
declare t text;
begin
  foreach t in array array['clients', 'quotes', 'followups', 'activities', 'message_templates'] loop
    execute format('create policy "%1$s: select" on public.%1$I for select using (public.is_org_member(org_id))', t);
    execute format('create policy "%1$s: insert" on public.%1$I for insert with check (public.is_org_member(org_id))', t);
    execute format('create policy "%1$s: update" on public.%1$I for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))', t);
    execute format('create policy "%1$s: delete" on public.%1$I for delete using (public.is_org_member(org_id))', t);
  end loop;
end;
$$;

-- Los vínculos (cliente de una cotización, cotización de un seguimiento)
-- deben pertenecer a la misma organización.
create or replace function public.check_same_org()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_table_name = 'quotes' then
    if not exists (select 1 from public.clients where id = new.client_id and org_id = new.org_id) then
      raise exception 'El cliente no pertenece a la organización';
    end if;
  elsif tg_table_name = 'followups' then
    if not exists (select 1 from public.quotes where id = new.quote_id and org_id = new.org_id) then
      raise exception 'La cotización no pertenece a la organización';
    end if;
  elsif tg_table_name = 'activities' then
    if not exists (select 1 from public.clients where id = new.client_id and org_id = new.org_id) then
      raise exception 'El cliente no pertenece a la organización';
    end if;
    if new.quote_id is not null and not exists (
      select 1 from public.quotes where id = new.quote_id and org_id = new.org_id
    ) then
      raise exception 'La cotización no pertenece a la organización';
    end if;
  end if;
  return new;
end;
$$;

create trigger quotes_same_org before insert or update on public.quotes
  for each row execute function public.check_same_org();
create trigger followups_same_org before insert or update on public.followups
  for each row execute function public.check_same_org();
create trigger activities_same_org before insert or update on public.activities
  for each row execute function public.check_same_org();

-- =====================================================================
-- Vista para el panel "Seguimientos de hoy"
-- security_invoker = respeta RLS del usuario que consulta
-- =====================================================================
create view public.followups_due with (security_invoker = true) as
select
  f.id            as followup_id,
  f.org_id,
  f.due_date,
  f.kind,
  f.note,
  f.assigned_to,
  (current_date - f.due_date) as days_overdue,
  q.id            as quote_id,
  q.folio,
  q.title         as quote_title,
  q.amount,
  q.currency,
  q.status        as quote_status,
  q.sent_at,
  c.id            as client_id,
  c.name          as client_name,
  c.company       as client_company,
  c.phone         as client_phone,
  c.email         as client_email
from public.followups f
join public.quotes  q on q.id = f.quote_id
join public.clients c on c.id = q.client_id
where f.status = 'pendiente'
  and q.status in ('enviada', 'negociacion');
