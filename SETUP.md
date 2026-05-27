# Setup — Sistema de Reservas

Este documento explica como pôr o sistema de reservas a funcionar. Algumas partes correm sozinhas (já estão no código), outras precisam de configuração manual da tua parte.

> Convenção: `<PROJ>` = `mfrmkkdqmlfuswggqbra` (o teu projeto Supabase).

---

## Fase 1 — Base de dados e calendário (essencial)

### 1.1. Correr a migration SQL

1. Abre o **Supabase Studio** → `https://supabase.com/dashboard/project/<PROJ>/sql/new`
2. Cola o conteúdo de [`supabase/migrations/20260525_reservations.sql`](supabase/migrations/20260525_reservations.sql)
3. Carrega em **Run**. Deve passar sem erros.

Isto cria:
- Tabelas `apartments`, `reservations`, `app_settings`
- View `availability` (lida pelo calendário do site, sem PII)
- Constraint que impede sobreposição de reservas confirmadas
- Função `is_owner()` que verifica se o email do JWT bate certo com `app_settings.owner_email` (já está pré-definido como `mfralmeida.2008@gmail.com` — muda em `app_settings` se for outro)
- Trigger que chama a Edge Function `notify-owner` em cada reserva nova
- Cron `ical_import_hourly` que corre todas as horas (uma vez configurado o resto)

### 1.2. Testar localmente

Abre [`apartamento-rocha.html`](apartamento-rocha.html) num browser. Deves ver o calendário Litepicker quando clicas no campo "Datas". Se não estiveres autenticado, ao submeter o formulário és redirecionado para `login.html` e voltas à página do apartamento depois do login.

Confirma uma reserva manualmente no Supabase SQL Editor:
```sql
update reservations set status = 'confirmed' where id = '<uuid-da-reserva>';
```
Recarrega a página do apartamento — essas datas ficam bloqueadas no calendário.

✅ **Fase 1 termina aqui — já tens reservas a funcionar no site.**

---

## Fase 2 — Email ao dono (precisa de uma conta Resend)

### 2.1. Criar conta Resend e obter API key

1. Vai a https://resend.com e regista-te (gratuito até 3000 emails/mês)
2. **Onboarding > API Keys** → cria uma key. Guarda-a.
3. (Opcional, recomendado) **Domains** → adiciona o teu domínio e segue as instruções DNS. Sem isto, os emails saem de `onboarding@resend.dev` e podem cair em spam.

### 2.2. Configurar secrets no Supabase

No dashboard do Supabase: **Edge Functions > Manage Secrets** (ou via CLI):

```
supabase secrets set \
  RESEND_API_KEY=re_xxxxxxxxxxxxxxxx \
  RESEND_FROM="Reservas By TR <reservas@teu-dominio.pt>" \
  APP_BASE_URL="https://o-teu-site.pt"
```

Se ainda não tens domínio verificado:
```
RESEND_FROM="By TR Alojamentos <onboarding@resend.dev>"
```

### 2.3. Deploy da Edge Function

Precisas do [Supabase CLI](https://supabase.com/docs/guides/cli) instalado.

```
supabase login
supabase link --project-ref mfrmkkdqmlfuswggqbra
supabase functions deploy notify-owner
```

### 2.4. Configurar `app_settings` (para o trigger SQL chamar a função)

No SQL Editor:
```sql
insert into app_settings (key, value) values
  ('edge_url',    'https://mfrmkkdqmlfuswggqbra.supabase.co/functions/v1'),
  ('service_key', '<o-service-role-key-do-projeto>')
on conflict (key) do update set value = excluded.value;
```

> O `service_role_key` está em **Settings > API**. **Nunca** o exponhas no frontend — fica só na BD.

### 2.5. Testar

Faz uma reserva no site logado. Verifica:
- A reserva aparece em [`admin.html`](admin.html) com estado `pending`
- Recebes o email no `owner_email`

Se não receber email, vai a **Edge Functions > notify-owner > Logs** no dashboard e vê o erro.

✅ **Fase 2 termina aqui — recebes email a cada reserva nova.**

---

## Fase 2.5 — Pagamentos com Stripe

Esta fase activa o checkout com Stripe (cartões, Multibanco, MB WAY). Sem isto, o botão "Reservar e Pagar" devolve "Stripe não configurado".

### 2.5.1. Conta Stripe + chaves de teste

1. Cria conta em https://stripe.com (gratuita; só pagas comissão quando recebes dinheiro real)
2. No dashboard, **mantém-te em modo TESTE** (toggle no canto superior — deve estar laranja "Test mode")
3. Vai a **Developers > API keys**:
   - Copia a **Secret key** (`sk_test_...`) — é esta que metes nos secrets
   - A Publishable key (`pk_test_...`) não é precisa porque usamos Checkout hospedado
4. Mete a chave no Supabase (substitui `sk_test_xxx` pelo valor real):

```bash
# via supabase CLI (se tiveres) OU pelo dashboard > Edge Functions > Secrets
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxx
```

Ou pela Management API (já que estás a usar este projecto, é o que o Claude usa):

```bash
node -e "
fetch('https://api.supabase.com/v1/projects/mfrmkkdqmlfuswggqbra/secrets', {
  method:'POST',
  headers:{'Authorization':'Bearer '+require('fs').readFileSync('.supabase-token','utf8').trim(),'Content-Type':'application/json'},
  body: JSON.stringify([{name:'STRIPE_SECRET_KEY',value:'sk_test_xxxxxxxxxx'}])
}).then(r=>r.text()).then(console.log);
"
```

### 2.5.2. Configurar webhook

Para a Stripe avisar o site quando um pagamento for confirmado:

1. Dashboard Stripe > **Developers > Webhooks > Add endpoint**
2. URL: `https://mfrmkkdqmlfuswggqbra.supabase.co/functions/v1/stripe-webhook`
3. **Listen to:** seleciona estes 4 eventos:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
4. **Add endpoint**
5. Na página do endpoint criado, carrega em **"Reveal"** ao lado de **Signing secret** — copia o `whsec_...`
6. Mete no Supabase como secret `STRIPE_WEBHOOK_SECRET`

### 2.5.3. Preços

Os preços já estão pré-configurados na BD (€110 Litoral Mar, €95 Paraíso do Sol). Para alterar:

```sql
update apartments set price_per_night_cents = 12000 where id = 'litoral-mar';   -- €120
update apartments set price_per_night_cents = 10500 where id = 'paraiso-do-sol'; -- €105
```

(Os valores são sempre em **cêntimos** — €1.00 = 100.)

### 2.5.4. Testar com cartão de teste

1. Faz login no site, abre `apartamento-rocha.html`, escolhe datas, submete
2. És redireccionado para a Stripe Checkout
3. Usa um destes cartões de teste:
   - ✓ Sucesso: `4242 4242 4242 4242` (qualquer data futura, qualquer CVC)
   - ✗ Recusa: `4000 0000 0000 0002`
   - Multibanco: escolhe "Multibanco" no checkout — a Stripe simula a referência
4. Vais ser redireccionado para `reserva-confirmada.html`
5. O dono recebe email com "💰 Reserva paga"

### 2.5.5. Passar para produção (live mode)

Quando estiveres pronto para receber dinheiro real:

1. No Stripe dashboard, completa **Activate payments** (preenche dados fiscais, IBAN, etc.)
2. Volta o toggle para **Live mode** (canto superior — fica preto)
3. Em **Developers > API keys**, copia a Secret key de produção (`sk_live_...`)
4. **Adiciona um webhook em live mode também** (passos 2.5.2 mas em live) — gera um novo `whsec_...`
5. Substitui os secrets no Supabase:
   - `STRIPE_SECRET_KEY` → `sk_live_...`
   - `STRIPE_WEBHOOK_SECRET` → o novo `whsec_...`

⚠️ **Refunds não são automáticos.** Quando cancelas uma reserva confirmada no `admin.html`, a linha fica `cancelled` mas o dinheiro não é devolvido. Tens de ir manualmente ao Stripe dashboard > Payments > [a payment] > Refund. Posso automatizar isto depois se quiseres.

---

## Fase 3 — Sincronização iCal com Booking.com

Esta sincronização é **bidirecional mas não em tempo real**. O Booking sondaa o teu feed e tu sondas o do Booking — o atraso ronda 2-4 horas em cada direção.

### 3.1. Deploy das funções iCal

```
supabase functions deploy ical-export --no-verify-jwt
supabase functions deploy ical-import
```

**Importante:** `ical-export` precisa de `--no-verify-jwt` porque o Booking.com não envia JWT quando vai buscar o feed. A URL fica pública mas só revela datas (sem nomes nem emails — usa apenas o campo `status='confirmed'` da view, mas com summaries genéricos).

### 3.2. Dar ao Booking o teu URL .ics (site → Booking)

Para cada apartamento na tua Extranet do Booking:

1. **Rates & Availability > Sync Calendars > Import Calendar**
2. Cola um destes URLs:
   - **Litoral Mar:** `https://mfrmkkdqmlfuswggqbra.supabase.co/functions/v1/ical-export?apt=litoral-mar`
   - **Paraíso do Sol:** `https://mfrmkkdqmlfuswggqbra.supabase.co/functions/v1/ical-export?apt=paraiso-do-sol`
3. Dá um nome (ex: "Reservas Site By TR") e Save.

O Booking começa a sondar este URL a cada poucas horas. Reservas confirmadas no site passam a bloquear datas no Booking.

### 3.3. Apanhar o URL .ics do Booking (Booking → site)

Ainda na mesma página da Extranet:

1. **Rates & Availability > Sync Calendars > Export Calendar**
2. Copia o URL do calendário (algo como `https://admin.booking.com/hotel/hoteladmin/ical.html?t=...`)
3. Vai ao Supabase SQL Editor e regista esse URL na tabela `apartments`:

```sql
update apartments
   set booking_ical_url = 'https://admin.booking.com/hotel/hoteladmin/ical.html?t=...'
 where id = 'litoral-mar';

-- Repete para 'paraiso-do-sol' se aplicável
```

### 3.4. Confirmar que o cron está activo

```sql
select * from cron.job where jobname = 'ical_import_hourly';
```

Deve devolver uma linha com schedule `7 * * * *`. Para forçar uma sync imediata sem esperar pela hora:

```sql
select net.http_post(
  url     := (select value from app_settings where key = 'edge_url') || '/ical-import',
  headers := jsonb_build_object('Authorization', 'Bearer ' || (select value from app_settings where key = 'service_key'),
                                 'Content-Type', 'application/json'),
  body    := '{}'::jsonb
);
```

Depois vê em **Edge Functions > ical-import > Logs**.

### 3.5. Conflitos

Se uma reserva confirmada no site e uma do Booking se sobrepuserem (raro mas possível na janela de polling), a `ical-import` regista no log `Conflito iCal: ...` mas **não** sobrepõe à força. Resolve manualmente:

1. Abre [`admin.html`](admin.html)
2. Decide qual manter; cancela a outra
3. No Booking, cancela manualmente também

✅ **Fase 3 termina aqui — sincronização bidirecional activa.**

---

## Estrutura de ficheiros adicionados

```
supabase/
  migrations/
    20260525_reservations.sql        ← schema, RLS, trigger, cron
  functions/
    notify-owner/index.ts             ← email via Resend
    ical-export/index.ts              ← .ics público para o Booking puxar
    ical-import/index.ts              ← lê .ics do Booking, faz upsert
admin.html, admin.js                  ← painel do dono
reservations.js                       ← lógica do calendário + form
```

Modificados:
- `apartamento-rocha.html` — formulário substituiu o botão Booking
- `apartamento-amarilis.html` — mesmo, em modo "lista de espera"
- `supabase-auth.js` — login agora respeita `?next=` para voltar à página de origem
- `CLAUDE.md` — actualizado para a nova arquitectura

---

## Manutenção

- **Mudar o email do dono:**
  `update app_settings set value = 'novo@email.pt' where key = 'owner_email';`
- **Adicionar um terceiro apartamento:**
  insert em `apartments`, criar nova página HTML com `data-apartment-id="<id>"`, configurar `booking_ical_url` se aplicável.
- **Desativar a sync iCal de um apartamento:**
  `update apartments set booking_ical_url = null where id = '...';`
- **Ver todas as reservas:** usa [`admin.html`](admin.html) ou
  `select * from reservations order by check_in desc;` no SQL Editor.
