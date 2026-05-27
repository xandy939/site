-- ============================================================================
-- By TR Alojamentos — Payment system (Stripe Checkout)
-- Aplica DEPOIS de 20260525_reservations.sql. Idempotente.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Preço por noite em cêntimos (EUR)
-- ----------------------------------------------------------------------------
alter table public.apartments
  add column if not exists price_per_night_cents int;

update public.apartments set price_per_night_cents = 11000 where id = 'litoral-mar'    and price_per_night_cents is null;
update public.apartments set price_per_night_cents = 9500  where id = 'paraiso-do-sol' and price_per_night_cents is null;

-- ----------------------------------------------------------------------------
-- 2. Reservas: novo status 'awaiting_payment' + stripe_session_id
-- ----------------------------------------------------------------------------
alter table public.reservations
  add column if not exists stripe_session_id text,
  add column if not exists amount_cents int,
  add column if not exists payment_method text;       -- 'card', 'multibanco', 'mb_way', etc.

create unique index if not exists reservations_stripe_session_unique
  on public.reservations (stripe_session_id)
  where stripe_session_id is not null;

-- Substitui o CHECK do status para aceitar 'awaiting_payment'
alter table public.reservations
  drop constraint if exists reservations_status_check;
alter table public.reservations
  add  constraint reservations_status_check
       check (status in ('pending', 'awaiting_payment', 'confirmed', 'cancelled'));

-- ----------------------------------------------------------------------------
-- 3. Constraint de não-sobreposição: agora bloqueia 'awaiting_payment' também
-- ----------------------------------------------------------------------------
alter table public.reservations drop constraint if exists reservations_no_overlap;
alter table public.reservations add constraint reservations_no_overlap
  exclude using gist (
    apartment_id with =,
    daterange(check_in, check_out, '[)') with &&
  ) where (status in ('confirmed', 'awaiting_payment'));

-- ----------------------------------------------------------------------------
-- 4. View de disponibilidade: confirmadas + a aguardar pagamento
-- ----------------------------------------------------------------------------
create or replace view public.availability as
select apartment_id, check_in, check_out
from public.reservations
where status in ('confirmed', 'awaiting_payment');

grant select on public.availability to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. RLS: permitir INSERT com status='awaiting_payment' (vem da Edge Function
-- create-checkout, que corre com service_role, por isso a policy é só
-- defensiva para chamadas directas)
-- ----------------------------------------------------------------------------
drop policy if exists reservations_user_insert on public.reservations;
create policy reservations_user_insert on public.reservations
  for insert with check (
    auth.uid() = user_id
    and source = 'site'
    and status in ('awaiting_payment', 'pending')
  );

-- ----------------------------------------------------------------------------
-- 6. notify-owner: só dispara quando uma reserva fica CONFIRMED (paga),
-- não em 'awaiting_payment' nem 'pending'. Substitui a função.
-- ----------------------------------------------------------------------------
drop trigger if exists reservations_notify_owner on public.reservations;

create or replace function public.notify_owner_on_confirmed_reservation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  edge_url    text;
  service_key text;
begin
  -- só notifica em transições para 'confirmed' (INSERT directo OU UPDATE de awaiting->confirmed)
  if new.status <> 'confirmed' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'confirmed' then
    return new;   -- já era confirmada, não notifica de novo
  end if;

  select value into edge_url    from app_settings where key = 'edge_url';
  select value into service_key from app_settings where key = 'service_key';
  if edge_url is null or service_key is null then return new; end if;

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

create trigger reservations_notify_owner
  after insert or update on public.reservations
  for each row when (new.source = 'site')
  execute function public.notify_owner_on_confirmed_reservation();

-- ----------------------------------------------------------------------------
-- 7. Limpeza automática de 'awaiting_payment' que expiraram
-- (Stripe Checkout sessions duram 30 min, mas o webhook expired pode falhar.
-- Garantia adicional via cron de 5 em 5 minutos.)
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'cleanup_expired_payments') then
    perform cron.unschedule('cleanup_expired_payments');
  end if;
end $$;

select cron.schedule(
  'cleanup_expired_payments',
  '*/5 * * * *',                                    -- cada 5 minutos
  $job$
    update public.reservations
       set status = 'cancelled'
     where status = 'awaiting_payment'
       and created_at < now() - interval '35 minutes';
  $job$
);
