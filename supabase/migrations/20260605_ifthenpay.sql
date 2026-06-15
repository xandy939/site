-- ============================================================================
-- IfthenPay Multibanco — colunas para guardar referência por reserva
-- ============================================================================

alter table public.reservations
  add column if not exists ifthenpay_entity     text,
  add column if not exists ifthenpay_reference  text,
  add column if not exists ifthenpay_request_id text;

create unique index if not exists reservations_ifthenpay_ref_unique
  on public.reservations (ifthenpay_entity, ifthenpay_reference)
  where ifthenpay_reference is not null;
