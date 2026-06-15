// Supabase Edge Function: gerar-referencia-mb
// Chamada pelo frontend quando o hóspede carrega "Reservar e Pagar".
// Insere uma reserva 'awaiting_payment' e chama a API IfthenPay para
// obter Entidade + Referência + Valor Multibanco.
//
// Deploy:  via tools/deploy-functions.mjs (verify_jwt:false — convidados anónimos)
// Secrets:
//   IFTHENPAY_MB_KEY  — chave Multibanco (Backoffice Key) do backoffice ifthenpay
//
// Doc IfthenPay: https://ifthenpay.com/docs/en/api/multibanco/

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface CheckoutBody {
    apartment_id: string;
    check_in:  string;
    check_out: string;
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
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST")    return json({ error: "POST only" }, 405);

    let body: CheckoutBody;
    try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

    const required = ["apartment_id", "check_in", "check_out", "guests", "guest_name", "guest_email"];
    for (const k of required) if (!(body as any)[k]) return json({ error: `Falta ${k}` }, 400);

    // 1. JWT opcional para vincular reserva ao utilizador
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

    // 2. Apartamento + taxas + épocas → calcular total
    const { data: apt, error: aptErr } = await sb
        .from("apartments")
        .select("id, name, price_per_night_cents, active, cleaning_fee_cents, towel_fee_cents, linen_fee_cents, tourist_tax_per_person_cents")
        .eq("id", body.apartment_id).single();
    if (aptErr || !apt) return json({ error: "Apartamento desconhecido" }, 404);
    if (!apt.active)    return json({ error: "Apartamento indisponível" }, 409);

    const nights = nightsBetween(body.check_in, body.check_out);
    if (nights < 1) return json({ error: "Datas inválidas" }, 400);

    const { data: seasons } = await sb
        .from("pricing_seasons")
        .select("start_date, end_date, price_per_night_cents")
        .eq("apartment_id", body.apartment_id);
    const seasonList = seasons || [];
    const priceForDate = (iso: string) => {
        for (const s of seasonList) {
            if (iso >= s.start_date && iso <= s.end_date) return s.price_per_night_cents;
        }
        return apt.price_per_night_cents!;
    };

    let accommodationCents = 0;
    const cursor = new Date(body.check_in + "T00:00:00Z");
    const end    = new Date(body.check_out + "T00:00:00Z");
    while (cursor < end) {
        accommodationCents += priceForDate(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const cleaningCents = apt.cleaning_fee_cents ?? 0;
    const towelCents    = apt.towel_fee_cents ?? 0;
    const linenCents    = apt.linen_fee_cents ?? 0;
    const touristCents  = (apt.tourist_tax_per_person_cents ?? 0) * body.guests * nights;
    const subtotalCents = accommodationCents + cleaningCents + towelCents + linenCents + touristCents;

    // Desconto site (vs Booking.com) — manter sincronizado com reservations.js
    const DISCOUNT_PERCENT = 10;
    const discountCents = DISCOUNT_PERCENT > 0 ? Math.round(subtotalCents * DISCOUNT_PERCENT / 100) : 0;
    const totalCents = subtotalCents - discountCents;
    if (totalCents <= 0) return json({ error: "Total inválido" }, 500);

    // 3. Inserir reserva 'awaiting_payment' (constraint impede sobreposição)
    const { data: reservation, error: insErr } = await sb
        .from("reservations")
        .insert({
            apartment_id: body.apartment_id, user_id: userId,
            guest_name: body.guest_name, guest_email: body.guest_email,
            guest_phone: body.guest_phone ?? null,
            guests: body.guests,
            check_in: body.check_in, check_out: body.check_out,
            source: "site", status: "awaiting_payment",
            amount_cents: totalCents,
        }).select().single();
    if (insErr) {
        if (insErr.code === "23P01") return json({ error: "Datas indisponíveis", overlap: true }, 409);
        return json({ error: "Erro ao criar reserva: " + insErr.message }, 500);
    }

    // 4. Chamar API IfthenPay para gerar a referência Multibanco
    const mbKey = Deno.env.get("IFTHENPAY_MB_KEY");
    if (!mbKey) {
        await sb.from("reservations").update({ status: "cancelled" }).eq("id", reservation.id);
        return json({ error: "IFTHENPAY_MB_KEY não configurado" }, 500);
    }

    // Referência expira em 3 dias (típico para Multibanco)
    const expiryDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    try {
        const ifthenResp = await fetch("https://ifthenpay.com/api/multibanco/reference/init", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mbKey,
                orderId: reservation.id.replace(/-/g, "").slice(0, 15), // IfthenPay limita
                amount: (totalCents / 100).toFixed(2),       // string em euros
                customerName: body.guest_name,
                customerEmail: body.guest_email,
                customerPhone: body.guest_phone ?? "",
                description: `Reserva ${apt.name} ${body.check_in} a ${body.check_out}`,
                expiryDate,
            }),
        });
        const mbData = await ifthenResp.json();

        if (!ifthenResp.ok || mbData.Status !== "0") {
            // rollback
            await sb.from("reservations").update({ status: "cancelled" }).eq("id", reservation.id);
            console.error("IfthenPay erro:", mbData);
            return json({ error: "Falha a gerar referência", detail: mbData?.Message }, 502);
        }

        // 5. Guardar referência na reserva (campos novos)
        await sb.from("reservations").update({
            ifthenpay_entity:    mbData.Entity ?? mbData.EntityCode,
            ifthenpay_reference: mbData.Reference ?? mbData.ReferenceCode,
            ifthenpay_request_id: mbData.RequestId,
            payment_method:      "multibanco",
        }).eq("id", reservation.id);

        // 6. Enviar email ao hóspede com a referência (fire-and-forget)
        sb.functions.invoke("notify-owner", {
            body: { reservation_id: reservation.id, mode: "reference" },
        }).catch((e) => console.error("notify-owner reference falhou:", e));

        return json({
            ok: true,
            reservation_id: reservation.id,
            entidade:   mbData.Entity ?? mbData.EntityCode,
            referencia: mbData.Reference ?? mbData.ReferenceCode,
            valor_cents: totalCents,
            valor_eur:  (totalCents / 100).toFixed(2),
            expira_em:  expiryDate,
        });
    } catch (e) {
        await sb.from("reservations").update({ status: "cancelled" }).eq("id", reservation.id);
        console.error("Erro fetch IfthenPay:", e);
        return json({ error: "Erro de ligação a IfthenPay" }, 502);
    }
});

function json(o: unknown, status = 200) {
    return new Response(JSON.stringify(o), {
        status, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
function nightsBetween(a: string, b: string): number {
    return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
}
