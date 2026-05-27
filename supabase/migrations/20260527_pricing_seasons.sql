-- ============================================================================
-- Pricing seasons — preço variável por época
-- ============================================================================
-- Cada apartamento tem várias "épocas" com datas e preço.
-- Calendário e checkout consultam: para uma noite X, qual a época que se aplica?
-- Se nenhuma se aplicar, cai para apartments.price_per_night_cents (base).

create table if not exists public.pricing_seasons (
  id            uuid primary key default gen_random_uuid(),
  apartment_id  text not null references public.apartments(id) on delete cascade,
  name          text not null,
  start_date    date not null,
  end_date      date not null,
  price_per_night_cents int not null check (price_per_night_cents > 0),
  created_at    timestamptz not null default now(),
  check (end_date >= start_date)
);

create index if not exists pricing_seasons_apt_dates
  on public.pricing_seasons (apartment_id, start_date, end_date);

alter table public.pricing_seasons enable row level security;

drop policy if exists seasons_public_read on public.pricing_seasons;
create policy seasons_public_read on public.pricing_seasons
  for select using (true);

drop policy if exists seasons_owner_all on public.pricing_seasons;
create policy seasons_owner_all on public.pricing_seasons
  for all using (public.is_owner()) with check (public.is_owner());

-- Seed inicial — épocas padrão para Praia da Rocha (valores típicos do mercado)
-- O dono pode editar via SQL a qualquer momento.
insert into public.pricing_seasons (apartment_id, name, start_date, end_date, price_per_night_cents) values
  -- Litoral Mar (base €110)
  ('litoral-mar',    'Alta — Agosto',     '2026-08-01', '2026-08-31', 16000),  -- €160
  ('litoral-mar',    'Alta — Julho',      '2026-07-01', '2026-07-31', 13500),  -- €135
  ('litoral-mar',    'Média — Junho',     '2026-06-01', '2026-06-30', 11500),  -- €115
  ('litoral-mar',    'Média — Setembro',  '2026-09-01', '2026-09-30', 11000),  -- €110
  ('litoral-mar',    'Páscoa',            '2026-04-01', '2026-04-15',  9500),  -- €95
  -- Paraíso do Sol (base €95)
  ('paraiso-do-sol', 'Alta — Agosto',     '2026-08-01', '2026-08-31', 14000),  -- €140
  ('paraiso-do-sol', 'Alta — Julho',      '2026-07-01', '2026-07-31', 11500),  -- €115
  ('paraiso-do-sol', 'Média — Junho',     '2026-06-01', '2026-06-30', 10000),  -- €100
  ('paraiso-do-sol', 'Média — Setembro',  '2026-09-01', '2026-09-30',  9500),  -- €95
  ('paraiso-do-sol', 'Páscoa',            '2026-04-01', '2026-04-15',  8500)   -- €85
on conflict do nothing;
