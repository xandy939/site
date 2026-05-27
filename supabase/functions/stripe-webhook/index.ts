// Supabase Edge Function: stripe-webhook
// Recebe eventos da Stripe e actualiza a reserva consoante o estado do pagamento.
//
// Deploy: via tools/deploy-functions.mjs (verify_jwt:false — Stripe não envia JWT)
//
// Secrets necessários:
//   STRIPE_WEBHOOK_SECRET — whsec_... do endpoint configurado em Stripe Dashboard
//
// Eventos a configurar em Stripe Dashboard → Developers → Webhooks:
//   checkout.session.completed              — pagamento imediato (cartão) OK
//   checkout.session.expired                — sessão expirou
//   checkout.session.async_payment_succeeded — Multibanco confirmado
//   checkout.session.async_payment_failed    — Multibanco falhou/timeout

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
    if (req.method !== "POST") return new Response("POST only", { status: 405 });

    const sig = req.headers.get("stripe-signature");
    const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!sig || !secret) return new Response("missing signature/secret", { status: 400 });

    const raw = await req.text();
    const verified = await verifyStripeSignature(raw, sig, secret);
    if (!verified) return new Response("invalid signature", { status: 401 });

    const event = JSON.parse(raw);
    const session = event.data?.object;
    if (!session) return new Response("ok", { status: 200 });

    const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Match: por metadata.reservation_id (mais fiável) OU pelo stripe_session_id
    const reservationId = session.metadata?.reservation_id;
    const sessionId     = session.id;

    async function updateReservation(patch: Record<string, unknown>) {
        let q = sb.from("reservations").update(patch);
        if (reservationId) q = q.eq("id", reservationId);
        else if (sessionId) q = q.eq("stripe_session_id", sessionId);
        else throw new Error("Sem chave para localizar a reserva");
        return q;
    }

    try {
        switch (event.type) {
            case "checkout.session.completed": {
                // Pagamento imediato (cartão, Apple/Google Pay) OU início de async (Multibanco)
                const status = session.payment_status === "paid" ? "confirmed" : "awaiting_payment";
                const method = session.payment_method_types?.[0] ?? null;
                await updateReservation({
                    status,
                    payment_method: method,
                });
                console.log(`✓ session.completed: ${reservationId || sessionId} → ${status}`);
                break;
            }
            case "checkout.session.async_payment_succeeded": {
                // Multibanco/SEPA confirmado depois (até 3 dias)
                const method = session.payment_method_types?.[0] ?? null;
                await updateReservation({ status: "confirmed", payment_method: method });
                console.log(`✓ async_payment_succeeded: ${reservationId || sessionId}`);
                break;
            }
            case "checkout.session.async_payment_failed":
            case "checkout.session.expired": {
                await updateReservation({ status: "cancelled" });
                console.log(`✗ ${event.type}: ${reservationId || sessionId} → cancelled`);
                break;
            }
            default:
                console.log("Evento ignorado:", event.type);
        }
    } catch (e) {
        console.error("Erro a actualizar reserva:", e);
        return new Response("update failed", { status: 500 });
    }

    return new Response("ok", { status: 200 });
});

// --------- HMAC SHA256 verification (sem dependências) ----------------------

async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
    // Formato: "t=<ts>,v1=<sig>,v1=<sig2>,..."
    const parts = Object.fromEntries(
        header.split(",").map(s => s.trim().split("="))
    ) as Record<string, string>;
    const ts  = parts["t"];
    const sigs = header.split(",").filter(s => s.trim().startsWith("v1=")).map(s => s.split("=")[1]);
    if (!ts || sigs.length === 0) return false;

    // Janela de tolerância: 5 minutos
    const age = Math.abs(Date.now() / 1000 - parseInt(ts, 10));
    if (age > 300) {
        console.warn("Webhook fora da janela de 5 min:", age);
        return false;
    }

    const signed = `${ts}.${payload}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw", enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false, ["sign"]
    );
    const expectedBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(signed)));
    const expected = Array.from(expectedBytes).map(b => b.toString(16).padStart(2, "0")).join("");

    // Constant-time comparison
    return sigs.some(s => timingSafeEqual(s, expected));
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
}
