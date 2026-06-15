// Supabase Edge Function: ifthenpay-callback
// Recebe notificação de pagamento da IfthenPay (callback Multibanco).
// Verifica anti-phishing key e marca reserva como confirmed.
//
// Deploy: via tools/deploy-functions.mjs (verify_jwt:false — IfthenPay chama sem JWT)
//
// Secrets:
//   IFTHENPAY_ANTI_PHISHING_KEY — para verificar autenticidade do callback
//
// URL para configurar no backoffice IfthenPay:
//   https://mfrmkkdqmlfuswggqbra.supabase.co/functions/v1/ifthenpay-callback
//
// IfthenPay normalmente envia GET com query params:
//   ?Key=<antiPhishingKey>&Reference=<ref>&Entity=<entidade>&Amount=<valor>&Datetime=...&RequestId=...
// (Formato pode variar — esta função aceita também POST + JSON body)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
    const expectedKey = Deno.env.get("IFTHENPAY_ANTI_PHISHING_KEY");
    if (!expectedKey) {
        console.error("IFTHENPAY_ANTI_PHISHING_KEY não configurado");
        return new Response("Server misconfigured", { status: 500 });
    }

    const url = new URL(req.url);
    let params: Record<string, string> = {};
    if (req.method === "GET") {
        params = Object.fromEntries(url.searchParams);
    } else if (req.method === "POST") {
        const ct = req.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
            const body = await req.json().catch(() => ({}));
            params = body;
        } else {
            const text = await req.text();
            const usp = new URLSearchParams(text);
            params = Object.fromEntries(usp);
        }
    }

    // IfthenPay envia: key, orderId, amount, requestId, entity, reference, payment_datetime
    // (todos lowercase para Multibanco — ver https://ifthenpay.com/docs/en/guides/callback/)
    const receivedKey = params.key || params.Key || params.AntiPhishingKey;
    if (receivedKey !== expectedKey) {
        console.warn("Anti-phishing key inválida:", receivedKey ? receivedKey.slice(0, 4) + "..." : "(vazia)");
        return new Response("Invalid key", { status: 401 });
    }

    const reference = params.reference || params.Reference;
    const entity    = params.entity    || params.Entity;
    const amount    = params.amount    || params.Amount;
    const requestId = params.requestId || params.RequestId;
    const orderId   = params.orderId   || params.OrderId;
    const paymentDate = params.payment_datetime || params.PaymentDatetime;

    if (!reference || !entity) {
        return new Response("Missing reference/entity", { status: 400 });
    }

    const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Encontrar a reserva — primeiro tenta por requestId (mais fiável),
    // depois fallback por entity+reference, depois orderId
    let q = sb.from("reservations").select("id, status, amount_cents");
    if (requestId)         q = q.eq("ifthenpay_request_id", requestId);
    else if (reference)    q = q.eq("ifthenpay_reference", reference).eq("ifthenpay_entity", entity);
    else if (orderId)      q = q.eq("id", orderId);
    else return new Response("Missing identifier", { status: 400 });

    const { data: rows } = await q;

    if (!rows || rows.length === 0) {
        console.warn(`Callback IfthenPay sem reserva correspondente: ent=${entity} ref=${reference}`);
        return new Response("Reservation not found", { status: 404 });
    }

    const reservation = rows[0];
    if (reservation.status === "confirmed") {
        // Idempotente — já estava confirmada
        return new Response("Already confirmed", { status: 200 });
    }

    // Validar valor pago (opcional mas recomendado)
    if (amount) {
        const paidCents = Math.round(parseFloat(amount.toString().replace(",", ".")) * 100);
        if (Math.abs(paidCents - (reservation.amount_cents || 0)) > 1) {
            console.warn(`Valor diferente: esperado ${reservation.amount_cents}c, pago ${paidCents}c`);
            // Não bloqueia — só regista. Banco já recebeu o dinheiro.
        }
    }

    const { error: upErr } = await sb.from("reservations")
        .update({ status: "confirmed" })
        .eq("id", reservation.id);
    if (upErr) {
        console.error("Erro ao confirmar reserva:", upErr);
        return new Response("DB error", { status: 500 });
    }

    console.log(`✓ Reserva ${reservation.id} confirmed via IfthenPay (ref=${reference})`);
    return new Response("OK", { status: 200 });
});
