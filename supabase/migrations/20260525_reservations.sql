-- ============================================================================
-- By TR Alojamentos — Reservations schema
-- Run this in Supabase Studio > SQL Editor (or via `supabase db push`)
-- Idempotent: safe to re-run.
-- ============================================================================

-- gist index over date ranges so we can use an EXCLUDE constraint for overlap
create extension if not exists btree_gist;

-- ----------------------------------------------------------------------------
-- 1. apartments lookup (tiny, but lets us avoid magic strings everywhere)
-- ----------------------------------------------------------------------------
create table if not exists public.apartments (
  id text primary key,
  name text not null,
  active boolean not null default true,
  booking_ical_url text,                  -- the .ics URL the owner gets from Booking Extranet
  created_at timestamptz not null default now()
);

insert into public.apartments (id, name, active) values
  ('litoral-mar',     'By TR — Litoral Mar',    true),
  ('paraiso-do-sol',  'By TR — Paraíso do Sol', false)
on conflict (id) do nothing;

alter table public.apartments enable row level security;

drop policy if exists apartments_public_read on public.apartments;
create policy apartments_public_read on public.apartments
  for select using (true);

-- ----------------------------------------------------------------------------
-- 2. reservations
-- ----------------------------------------------------------------------------
create table if not exists public.reservations (
  id          uuid primary key default gen_random_uuid(),
  apartment_id text not null references public.apartments(id),
  user_id     uuid references auth.users(id) on delete set null,

  guest_name  text not null,
  guest_email text not null,
  guest_phone text,
  guests      int  not null default 1 check (guests > 0 and guests <= 20),

  check_in    date not null,
  check_out   date not null,

  status      text not null default 'pending'
                check (status in ('pending', 'confirmed', 'cancelled')),
  source      text not null default 'site'
                check (source in ('site', 'booking')),
  external_uid text,                       -- iCal UID from Booking, for idempotent imports
  notes       text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  check (check_out > check_in)
);

-- One row per Booking iCal UID per apartment (prevents duplicate imports)
create unique index if not exists reservations_external_uid_unique
  on public.reservations (apartment_id, external_uid)
  where external_uid is not null;

-- Fast availability lookups
create index if not exists reservations_apartment_dates
  on public.reservations (apartment_id, check_in, check_out)
  where status = 'confirmed';

-- Prevent overlapping CONFIRMED reservations on the same apartment.
-- `[)` = check_in inclusive, check_out exclusive (standard hotel convention).
-- Pending requests do NOT block, so multiple guests can request the same dates
-- and the owner decides which to confirm.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'reservations_no_overlap'
  ) then
    alter table public.reservations add constraint reservations_no_overlap
      exclude using gist (
        apartment_id with =,
        daterange(check_in, check_out, '[)') with &&
      ) where (status = 'confirmed');
  end if;
end $$;

-- updated_at trigger
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists reservations_touch_updated_at on public.reservations;
create trigger reservations_touch_updated_at
  before update on public.reservations
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 3. owner role — uses an env-driven email allowlist
-- The Edge Functions and admin page check this. Stored in a settings table
-- so it can be changed without redeploying.
-- ----------------------------------------------------------------------------
create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);

insert into public.app_settings (key, value) values
  ('owner_email', 'mfralmeida.2008@gmail.com')
on conflict (key) do nothing;

alter table public.app_settings enable row level security;
-- no public read; only service_role (Edge Functions) accesses this

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (auth.jwt() ->> 'email') = (select value from public.app_settings where key = 'owner_email'),
    false
  );
$$;

-- ----------------------------------------------------------------------------
-- 4. RLS for reservations
-- ----------------------------------------------------------------------------
alter table public.reservations enable row level security;

-- a) Owners see/manage everything
drop policy if exists reservations_owner_all on public.reservations;
create policy reservations_owner_all on public.reservations
  for all using (public.is_owner()) with check (public.is_owner());

-- b) Logged-in users see and cancel their own reservations
drop policy if exists reservations_user_select on public.reservations;
create policy reservations_user_select on public.reservations
  for select using (auth.uid() = user_id);

drop policy if exists reservations_user_insert on public.reservations;
create policy reservations_user_insert on public.reservations
  for insert with check (
    auth.uid() = user_id
    and source = 'site'
    and status = 'pending'
  );

drop policy if exists reservations_user_cancel on public.reservations;
create policy reservations_user_cancel on public.reservations
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id and status in ('pending', 'cancelled'));

-- ----------------------------------------------------------------------------
-- 5. Public availability view — exposes ONLY blocked dates, no PII
-- This is what the calendar widget reads from to know what to grey out.
-- ----------------------------------------------------------------------------
create or replace view public.availability as
select apartment_id, check_in, check_out
from public.reservations
where status = 'confirmed';

grant select on public.availability to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. notify-owner webhook trigger
-- When a new reservation is inserted from the site, call the Edge Function.
-- The function URL and service key are stored in app_settings so we don't
-- hardcode them. Set these after deploying the Edge Function:
--
--   insert into app_settings (key, value) values
--     ('edge_url', 'https://<project>.supabase.co/functions/v1'),
--     ('service_key', '<service-role-key>')
--   on conflict (key) do update set value = excluded.value;
-- ----------------------------------------------------------------------------
create extension if not exists pg_net;

create or replace function public.notify_owner_on_new_reservation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  edge_url    text;
  service_key text;
begin
  select value into edge_url    from app_settings where key = 'edge_url';
  select value into service_key from app_settings where key = 'service_key';

  if edge_url is null or service_key is null then
    return new;   -- not configured yet; skip silently
  end if;

  perform net.http_post(
    url     := edge_url || '/notify-owner',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body    := jsonb_build_object('reservation_id', new.id)
  );
  return new;
end $$;

drop trigger if exists reservations_notify_owner on public.reservations;
create trigger reservations_notify_owner
  after insert on public.reservations
  for each row when (new.source = 'site')
  execute function public.notify_owner_on_new_reservation();

-- ----------------------------------------------------------------------------
-- 7. Hourly cron to pull Booking.com iCal feeds
-- Requires pg_cron extension (enable in Supabase dashboard > Database > Extensions)
-- ----------------------------------------------------------------------------
create extension if not exists pg_cron;

-- Drop any previous schedule with the same name (idempotent re-runs)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'ical_import_hourly') then
    perform cron.unschedule('ical_import_hourly');
  end if;
end $$;

select cron.schedule(
  'ical_import_hourly',
  '7 * * * *',                                       -- every hour at minute 7
  $job$
    select net.http_post(
      url     := (select value from public.app_settings where key = 'edge_url') || '/ical-import',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (select value from public.app_settings where key = 'service_key')
      ),
      body    := '{}'::jsonb
    ) where exists (select 1 from public.app_settings where key in ('edge_url','service_key'));
  $job$
);
