# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static HTML/CSS/JS marketing site for **By TR Alojamentos** (short-term rental apartments in Praia da Rocha, Portimão). All content is in Portuguese (pt-PT). The backend is **Supabase** (auth + `profiles` table + `avatars` storage bucket + a `reservations` system with Edge Functions for email and iCal sync). There is no build step or package manager — the static site loads everything from CDNs.

## Running locally

Open any `.html` directly in a browser, or serve the directory with any static server (e.g. `python -m http.server 8000`). Supabase calls work from `file://` because the anon key is public and CORS is permissive.

## High-level architecture

### Page → script wiring

Each page loads the Supabase JS SDK from a CDN and then *one or two* local scripts. The same local script does different things depending on which DOM elements exist on the page (it just early-returns when an element is missing). This is the main "big picture" you need to internalise:

- [index.html](index.html) — landing page with apartment cards. Loads `supabase-auth.js` + [script.js](script.js). On this page, `script.js` runs the **auto-rotating card carousel** AND injects the logged-in user's first name into the `#auth-area` header.
- [login.html](login.html) — loads `supabase-auth.js`. The handler in [supabase-auth.js](supabase-auth.js) binds only to `#login-form` (it no-ops on every other page).
- [registar.html](registar.html) — loads `supabase-auth.js`, **but no handler exists for `#register-form` anywhere**. Sign-up is currently not implemented in JS; the form submits and does nothing useful. If you're asked to "fix registration", this is why.
- [perfil.html](perfil.html) — loads `script.js`. The same `gerirSistemaAutenticacao()` function detects the profile DOM (`#perf-nome` etc.) and fills it in, wires the avatar upload to the `avatars` storage bucket, the password-change button (`supabase.auth.updateUser`), and logout.
- [apartamento-rocha.html](apartamento-rocha.html) / [apartamento-amarilis.html](apartamento-amarilis.html) — detail pages. They use the **manual** `mudarSlide(direcao)` function in `script.js` with prev/next arrows. They also load `reservations.js` for the booking widget (see "Reservation system" below).
- [admin.html](admin.html) + [admin.js](admin.js) — owner-only admin panel. Access is gated by the `is_owner()` DB function which checks `auth.jwt() ->> 'email'` against `app_settings.owner_email`. Lets the owner confirm/cancel pending requests and shows stats.
- [index-auth.js](index-auth.js) — **orphaned**. No HTML references it; do not edit it expecting changes to take effect. It's a stale duplicate of the auth logic now in `script.js`.

### Supabase client creation pattern

`supabase-auth.js`, `script.js`, `reservations.js`, and `admin.js` each create their **own** `supabase.createClient(...)` instance inside their handler, with the URL + anon key **hardcoded as string literals in each file**. There is no shared singleton (despite `index-auth.js` hinting at a `window.supabaseClient`, that variable is never set). If you rotate the anon key or change the project ref, you must edit it in **all four files** plus [.vscode/mcp.json](.vscode/mcp.json) which points the Supabase MCP server at the same project (`mfrmkkdqmlfuswggqbra`).

### Reservation + payment system (added 2026-05-25)

Reservations now go through **Stripe Checkout** (the pivot was mid-build; the older "request → owner approves" flow was scrapped). Guests pay up front, reservations auto-confirm on `checkout.session.completed`. Full setup documented in [SETUP.md](SETUP.md).

**Status state machine:**
- `awaiting_payment` — set when create-checkout is called; blocks the calendar; expires after ~30 min (Stripe session timeout) and is reaped to `cancelled` by the `cleanup_expired_payments` cron every 5 min
- `confirmed` — set by the webhook on `checkout.session.completed` (cards) or `checkout.session.async_payment_succeeded` (Multibanco). Blocks the calendar.
- `cancelled` — terminal. Set by the user cancelling, the webhook on `expired`/`async_payment_failed`, or the cleanup cron.
- `pending` — legacy/unused after the Stripe pivot. Kept in the CHECK constraint for backward compat but no path inserts it any more.

Schema (see [supabase/migrations/20260525_reservations.sql](supabase/migrations/20260525_reservations.sql) and [supabase/migrations/20260525_payments.sql](supabase/migrations/20260525_payments.sql)):
- `apartments(id, name, booking_ical_url, price_per_night_cents)` — two rows: `litoral-mar` (€110), `paraiso-do-sol` (€95)
- `reservations` — adds `stripe_session_id`, `amount_cents`, `payment_method`. GIST exclusion constraint blocks overlap of rows in (`confirmed`, `awaiting_payment`).
- `app_settings(key, value)` — `owner_email`, `edge_url`, `service_key`
- View `availability` — non-cancelled non-expired status only; the calendar reads from this
- Function `is_owner()` SECURITY DEFINER — used by admin RLS policies

Edge Functions ([supabase/functions/](supabase/functions/)):
- `create-checkout` — called by the frontend with apartment + dates + guest info. Inserts an `awaiting_payment` reservation, creates a Stripe Checkout Session with `card`+`multibanco` payment methods, returns the redirect URL. Rolls back the row to `cancelled` if Stripe fails. **verify_jwt=false** so anonymous guests can checkout; user_id is extracted from the optional Authorization header.
- `stripe-webhook` — called by Stripe on payment events. **verify_jwt=false** (Stripe doesn't send JWT — instead we HMAC-SHA256 verify the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET`). Updates the matching reservation's status. Matches by `metadata.reservation_id` first, falls back to `stripe_session_id`.
- `notify-owner` — invoked by a DB trigger but **only on transitions into `confirmed`** (post-Stripe-pivot). Sends a "💰 Reserva paga" email via Resend with the amount and payment method.
- `ical-export?apt=<id>` — public, `--no-verify-jwt`; returns an `.ics` feed of confirmed reservations for the Booking.com Extranet to import. Also includes `awaiting_payment` via the `availability` view? **No** — the view does include them, but ical-export specifically filters `status='confirmed'` only, so Booking.com doesn't see in-flight checkouts.
- `ical-import` — invoked by `pg_cron` job `ical_import_hourly`; pulls each apartment's `booking_ical_url`, upserts rows with `source='booking'`. **Currently disabled** — no `booking_ical_url` populated. User dropped Booking.com sync mid-setup; functions stay deployed and ready.

**Webhook race condition handled by `awaiting_payment`:** two guests starting checkout for the same dates simultaneously — only the first INSERT succeeds (exclusion constraint), the second gets `23P01` and the JS shows "Datas indisponíveis". Without this status, both could pay and one would have to be refunded.

**Refunds are NOT automated.** When `admin.html` cancels a confirmed reservation, the row is updated but the Stripe charge stays. Documented in [SETUP.md](SETUP.md) §2.5.5; revisit if user wants automation (would need to call Stripe `refunds.create` from a new Edge Function triggered by the status transition).

**Frontend money flow** ([reservations.js](reservations.js)):
1. Build calendar from `availability` view (excludes cancelled).
2. On submit, POST to `/functions/v1/create-checkout` with optional `Authorization: Bearer <jwt>`.
3. Receive `{checkout_url}`, `location.href = url`.
4. Stripe redirects to `reserva-confirmada.html?session_id=cs_test_...` which polls `reservations` until status becomes `confirmed` (handles the few-second webhook delay). Multibanco bookings stay `awaiting_payment` for up to 3 days — the page detects this and tells the user.
5. On cancel, Stripe redirects to `reserva-cancelada.html?id=<reservation_id>`; the page tries to set status `cancelled` but RLS blocks it, so it falls back to the cleanup cron / webhook `expired` event.

**Calendar locking logic** (in `reservations.js`): builds a `Set<YYYY-MM-DD>` of all *nights* occupied by `confirmed`+`awaiting_payment` reservations (expands each `[check_in, check_out)` range). The Litepicker `lockDaysFilter` uses this set with different rules for check-in vs check-out picks — a date that is itself an *existing* `check_in` is **selectable as a check-out** because the new reservation `[new_in, that_date)` doesn't overlap. Don't simplify this to "lock all occupied dates as both endpoints" — it breaks back-to-back bookings.

**Edge Functions deploy quirk:** Supabase's `POST /v1/projects/{ref}/functions` (JSON body) silently truncates the first 4 bytes of every uploaded function. **Use the multipart `/functions/deploy?slug=X` endpoint** (in [tools/deploy-functions.mjs](tools/deploy-functions.mjs)) which is what the official CLI uses. Don't switch back to the JSON endpoint without understanding the truncation; functions deployed via it boot-error.

### Profiles table — schema and the JS-vs-DB-name confusion

[supabase-setup.sql](supabase-setup.sql) defines `profiles(id, first_name, last_name, phone, age, gender)` and installs `handle_new_user` (an `auth.users` AFTER INSERT trigger) that copies `raw_user_meta_data->>'first_name'` etc. into the row. Those column names are still authoritative — the live DB matches this SQL exactly. An `avatar_url` column was added by us on 2026-05-27 (no migration file — applied via Management API; if you need a clean rebuild add it to the SQL).

Earlier copies of [script.js](script.js) and [reservations.js](reservations.js) queried Portuguese names (`nome`, `telefone`, `genero`/`sexo`) which were silently failing because those columns never existed. That was a pre-existing bug, not schema drift. Both files were fixed to use the real column names (`first_name`, `last_name`, `phone`, `gender`, `avatar_url`).

If you need to write JS that touches profiles, the **canonical column set** is: `id, first_name, last_name, phone, age, gender, avatar_url, created_at`. For registration: `auth.signUp({ options: { data: { first_name, last_name, phone, age, gender } } })` — the trigger handles the rest.

The newer [supabase/migrations/20260525_reservations.sql](supabase/migrations/20260525_reservations.sql) and [20260525_payments.sql](supabase/migrations/20260525_payments.sql) are authoritative for the reservation tables.

### Styling

- [style.css](style.css) is the shared stylesheet — used by `index.html` and the two apartment pages.
- `login.html`, `registar.html`, and `perfil.html` each carry their **own inline `<style>` block** and do not link `style.css`. CSS variables (`--primary`, `--brand-blue`, etc.) are redeclared inline per page with slightly different palettes — when adjusting brand colours, edit each page's `:root` block.
- `index.html` also has a massive inline `<style>` that uses `!important` heavily to override `style.css`. Expect specificity battles; prefer editing the inline block over the shared file for index-only tweaks.

## Conventions

- **Language**: keep all user-facing strings, IDs, and CSS class names in Portuguese (e.g. `caixa-login`, `btn-voltar`, `mudarSlide`). Mixing English would clash with the existing codebase.
- **No framework**: no React, no bundler, no TypeScript. Plain DOM APIs and `document.addEventListener('DOMContentLoaded', ...)` / `window.addEventListener('load', ...)`.
- **Defensive DOM access**: scripts that run on multiple pages should `if (el)` before touching each element, matching the existing pattern in `script.js`.
