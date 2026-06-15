// Supabase Edge Function: gerar-reserva-iban
// Cria reserva 'awaiting_payment' com payment_method='iban'.
// Envia email ao hóspede com os dados de transferência e ao patrão a avisar
// que tem de verificar o banco e confirmar manualmente no admin.
//
// Deploy:  via tools/deploy-functions.mjs (verify_jwt:false)
//
// Dados bancários hardcoded em baixo (não são confidenciais — o IBAN é
// mostrado a qualquer cliente que escolha transferência bancária).
// Para mudar: edita as constantes BUSINESS_* aqui, depois redeploy.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Fallback caso o frontend não envie os valores (deve sempre enviar).
// IBAN/Titular reais ficam em reservations.js → BANK_INFO[apartment_id]
const BUSINESS_IBAN = "PT50 0269 0168 0020 0794 6527 5";
const BUSINESS_NAME = "TudoParaRegistar, LDA";
const BUSINESS_BANK = "Bankinter";

interface ReservaIbanBody {
    apartment_id: string;
    check_in:  string;
    check_out: string;
    guests:    number;
    guest_name:  string;
    guest_email: string;
    guest_phone?: string;
    business_iban?: string;
    business_name?: string;
    business_bank?: string;
}

const CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST")    return json({ error: "POST only" }, 405);

    let body: ReservaIbanBody;
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

    // 3. Inserir reserva (constraint impede sobreposição)
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
            payment_method: "iban",
        }).select().single();
    if (insErr) {
        if (insErr.code === "23P01") return json({ error: "Datas indisponíveis", overlap: true }, 409);
        return json({ error: "Erro ao criar reserva: " + insErr.message }, 500);
    }

    // 4. Referência curta para o cliente pôr na descrição da transferência
    const shortRef = "TR-" + reservation.id.replace(/-/g, "").slice(0, 8).toUpperCase();

    // 5. Valores efectivos (frontend pode passar; fallback ao hardcoded da função)
    const iban    = body.business_iban || BUSINESS_IBAN;
    const titular = body.business_name || BUSINESS_NAME;
    const banco   = body.business_bank || BUSINESS_BANK;

    // 6. Disparar emails (fire-and-forget — não bloqueia resposta)
    const emailExtras = { business_iban: iban, business_name: titular, business_bank: banco };
    sb.functions.invoke("notify-owner", {
        body: { reservation_id: reservation.id, mode: "iban-reference", ...emailExtras },
    }).catch((e) => console.error("notify iban-reference falhou:", e));

    sb.functions.invoke("notify-owner", {
        body: { reservation_id: reservation.id, mode: "iban-pending" },
    }).catch((e) => console.error("notify iban-pending falhou:", e));

    return json({
        ok: true,
        reservation_id: reservation.id,
        short_ref:   shortRef,
        valor_cents: totalCents,
        valor_eur:   (totalCents / 100).toFixed(2),
        iban,
        titular,
        banco,
    });
});

function json(o: unknown, status = 200) {
    return new Response(JSON.stringify(o), {
        status, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
function nightsBetween(a: string, b: string): number {
    return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
}
