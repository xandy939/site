// Supabase Edge Function: ical-export
// Devolve um feed iCalendar (.ics) com todas as reservas CONFIRMADAS de um
// apartamento. O Booking.com vai puxar este URL periodicamente (cada ~2-4h).
//
// Deploy: supabase functions deploy ical-export --no-verify-jwt
// (importante: --no-verify-jwt porque o Booking não envia JWT)
//
// URL: https://<project>.supabase.co/functions/v1/ical-export?apt=litoral-mar
//
// Cola este URL no Booking Extranet > Rates & Availability > Sync Calendars
// > Import Calendar.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
    const url  = new URL(req.url);
    const apt  = url.searchParams.get("apt");
    if (!apt) return new Response("?apt=<apartment_id> em falta", { status: 400 });

    const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: aptRow } = await sb
        .from("apartments")
        .select("name")
        .eq("id", apt)
        .single();
    if (!aptRow) return new Response("Apartamento desconhecido", { status: 404 });

    const { data: reservas, error } = await sb
        .from("reservations")
        .select("id, check_in, check_out, guest_name, source, external_uid, created_at")
        .eq("apartment_id", apt)
        .eq("status", "confirmed");

    if (error) return new Response("Erro: " + error.message, { status: 500 });

    const now = utcStamp(new Date());
    const aptName = aptRow.name;

    const events = (reservas || []).map((r) => {
        // UID estável: se vier do Booking usa o uid original, caso contrário usa o id da reserva
        const uid = r.external_uid || `${r.id}@bytralojamentos`;
        const summary = r.source === "site"
            ? `Reservado (Site) — ${r.guest_name || "Hóspede"}`
            : `Reservado (Booking.com)`;
        return [
            "BEGIN:VEVENT",
            `UID:${escIcs(uid)}`,
            `DTSTAMP:${utcStamp(new Date(r.created_at))}`,
            `DTSTART;VALUE=DATE:${r.check_in.replaceAll("-", "")}`,
            `DTEND;VALUE=DATE:${r.check_out.replaceAll("-", "")}`,
            `SUMMARY:${escIcs(summary)}`,
            "TRANSP:OPAQUE",
            "END:VEVENT",
        ].join("\r\n");
    });

    const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//By TR Alojamentos//Reservations//PT",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        `X-WR-CALNAME:${escIcs(aptName)}`,
        `X-WR-TIMEZONE:Europe/Lisbon`,
        ...events,
        "END:VCALENDAR",
    ].join("\r\n");

    return new Response(ics, {
        status: 200,
        headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": `inline; filename="${apt}.ics"`,
            "Cache-Control": "public, max-age=300", // 5 min
        },
    });
});

function utcStamp(d: Date): string {
    // YYYYMMDDTHHMMSSZ
    const pad = (n: number) => String(n).padStart(2, "0");
    return d.getUTCFullYear().toString()
        + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
        + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds())
        + "Z";
}
function escIcs(s: string): string {
    // RFC 5545: escapar ; , \ e quebras de linha
    return (s ?? "")
        .replaceAll("\\", "\\\\")
        .replaceAll(";", "\\;")
        .replaceAll(",", "\\,")
        .replaceAll("\n", "\\n");
}
