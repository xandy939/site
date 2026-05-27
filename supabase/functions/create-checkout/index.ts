// Supabase Edge Function: create-checkout
// Chamada pelo frontend quando o hóspede carrega "Reservar e Pagar".
// Cria uma reserva 'awaiting_payment' + uma Stripe Checkout Session.
// Devolve a URL para onde o cliente deve ser redireccionado.
//
// Deploy:  via tools/deploy-functions.mjs
// Secrets necessários: STRIPE_SECRET_KEY (sk_test_... ou sk_live_...)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface CheckoutBody {
    apartment_id: string;
    check_in:  string;   // YYYY-MM-DD
    check_out: string;   // YYYY-MM-DD
    guests:    number;
    guest_name:  string;
    guest_email: string;
    guest_phone?: string;
}

const CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    let body: CheckoutBody;
    try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

    const required = ["apartment_id", "check_in", "check_out", "guests", "guest_name", "guest_email"];
    for (const k of required) {
        if (!(body as any)[k]) return json({ error: `Falta o campo ${k}` }, 400);
    }

    // user_id (opcional — extraído do JWT se presente)
    const authHeader = req.headers.get("Authorization") || "";
    let userId: string | null = null;
    if (authHeader.startsWith("Bearer ")) {
        const userClient = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_ANON_KEY")!,
            { global: { headers: { Authorization: authHeader } } }
        );
        const { data: { user } } = await userClient.auth.getUser();
        userId = user?.id ?? null;
    }

    const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Carrega o apartamento e o preço
    const { data: apt, error: aptErr } = await sb
        .from("apartments")
        .select("id, name, price_per_night_cents, active")
        .eq("id", body.apartment_id)
        .single();
    if (aptErr || !apt) return json({ error: "Apartamento desconhecido" }, 404);
    if (!apt.active)    return json({ error: "Apartamento indisponível" }, 409);
    if (!apt.price_per_night_cents || apt.price_per_night_cents <= 0) {
        return json({ error: "Apartamento sem preço configurado" }, 500);
    }

    const nights = nightsBetween(body.check_in, body.check_out);
    if (nights < 1) return json({ error: "Datas inválidas" }, 400);
    const totalCents = apt.price_per_night_cents * nights;

    // 2. Cria a reserva 'awaiting_payment' (constraint impede sobreposição)
    const { data: reservation, error: insErr } = await sb
        .from("reservations")
        .insert({
            apartment_id: body.apartment_id,
            user_id:      userId,
            guest_name:   body.guest_name,
            guest_email:  body.guest_email,
            guest_phone:  body.guest_phone ?? null,
            guests:       body.guests,
            check_in:     body.check_in,
            check_out:    body.check_out,
            source:       "site",
            status:       "awaiting_payment",
            amount_cents: totalCents,
        })
        .select()
        .single();
    if (insErr) {
        if (insErr.code === "23P01") {
            return json({ error: "Datas indisponíveis", overlap: true }, 409);
        }
        return json({ error: "Erro ao criar reserva: " + insErr.message }, 500);
    }

    // 3. Cria Stripe Checkout Session
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) {
        // rollback
        await sb.from("reservations").update({ status: "cancelled" }).eq("id", reservation.id);
        return json({ error: "Stripe não configurado" }, 500);
    }

    const baseUrl = Deno.env.get("APP_BASE_URL") || "";

    // form-encoded body para a Stripe API
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", `${baseUrl}/reserva-confirmada.html?session_id={CHECKOUT_SESSION_ID}`);
    params.append("cancel_url",  `${baseUrl}/reserva-cancelada.html?id=${reservation.id}`);
    params.append("customer_email", body.guest_email);
    params.append("expires_at", String(Math.floor(Date.now() / 1000) + 30 * 60)); // 30 min
    params.append("locale", "pt");

    // Métodos: cartões + Multibanco + MB WAY (importantes em PT).
    // Cada método tem de estar activado em Stripe Dashboard > Settings >
    // Payment methods.
    params.append("payment_method_types[0]", "card");
    params.append("payment_method_types[1]", "multibanco");
    params.append("payment_method_types[2]", "mb_way");

    // Line item: noite × N
    params.append("line_items[0][price_data][currency]", "eur");
    params.append("line_items[0][price_data][product_data][name]",
        `Estadia em ${apt.name}`);
    params.append("line_items[0][price_data][product_data][description]",
        `${nights} noite(s) · ${body.check_in} → ${body.check_out} · ${body.guests} hóspede(s)`);
    params.append("line_items[0][price_data][unit_amount]", String(apt.price_per_night_cents));
    params.append("line_items[0][quantity]", String(nights));

    // Metadata para o webhook saber a que reserva pertence
    params.append("metadata[reservation_id]", reservation.id);
    params.append("metadata[apartment_id]",   apt.id);
    params.append("payment_intent_data[metadata][reservation_id]", reservation.id);

    const sResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${stripeKey}`,
            "Content-Type":  "application/x-www-form-urlencoded",
        },
        body: params.toString(),
    });
    const session = await sResp.json();

    if (!sResp.ok) {
        // rollback da reserva
        await sb.from("reservations").update({ status: "cancelled" }).eq("id", reservation.id);
        console.error("Stripe falhou:", session);
        return json({ error: "Stripe falhou", detail: session?.error?.message }, 502);
    }

    // 4. Guarda o session id na reserva
    await sb.from("reservations")
        .update({ stripe_session_id: session.id })
        .eq("id", reservation.id);

    return json({
        ok: true,
        reservation_id: reservation.id,
        checkout_url: session.url,
        amount_cents: totalCents,
        nights,
    });
});

function json(o: unknown, status = 200) {
    return new Response(JSON.stringify(o), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

function nightsBetween(a: string, b: string): number {
    const d1 = new Date(a + "T00:00:00Z");
    const d2 = new Date(b + "T00:00:00Z");
    return Math.round((d2.getTime() - d1.getTime()) / 86400000);
}
