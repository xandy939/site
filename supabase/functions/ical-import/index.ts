// Supabase Edge Function: ical-import
// Disparada pelo cron `ical_import_hourly` (ver migration).
// Para cada apartamento que tenha `booking_ical_url` definido, vai buscar o
// feed .ics do Booking.com e faz UPSERT por (apartment_id, external_uid).
//
// Deploy: supabase functions deploy ical-import
//
// Para configurar um apartamento: na tabela `apartments` define
//   update apartments set booking_ical_url = 'https://admin.booking.com/...'
//   where id = 'litoral-mar';

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (_req) => {
    const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: apartments, error } = await sb
        .from("apartments")
        .select("id, booking_ical_url")
        .not("booking_ical_url", "is", null);

    if (error) {
        return json({ error: error.message }, 500);
    }

    const results: Record<string, unknown> = {};
    for (const apt of apartments || []) {
        try {
            results[apt.id] = await syncOne(sb, apt.id, apt.booking_ical_url!);
        } catch (e) {
            results[apt.id] = { error: String(e) };
        }
    }
    return json({ ok: true, results });
});

async function syncOne(sb: any, apartmentId: string, url: string) {
    const resp = await fetch(url, { headers: { "User-Agent": "By TR Alojamentos iCal sync" } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ao buscar feed`);
    const text = await resp.text();
    const events = parseIcs(text);

    let inserted = 0, updated = 0, cancelled = 0, conflicts = 0;
    const seenUids: string[] = [];

    for (const ev of events) {
        if (!ev.uid || !ev.start || !ev.end) continue;
        seenUids.push(ev.uid);

        // Tenta inserir; se já existe (constraint do índice único), faz update
        const row = {
            apartment_id: apartmentId,
            external_uid: ev.uid,
            check_in:  ev.start,
            check_out: ev.end,
            guest_name:  ev.summary || "Booking.com",
            guest_email: "noreply@booking.com",
            source: "booking",
            status: "confirmed",
            guests: 1,
            user_id: null,
        };

        const { error: insErr } = await sb
            .from("reservations")
            .upsert(row, { onConflict: "apartment_id,external_uid" });

        if (insErr) {
            if (insErr.code === "23P01") {
                // Excludes overlap — significa que uma reserva confirmada do site
                // colide com esta do Booking. Marca o evento como conflito.
                conflicts++;
                console.warn(`Conflito iCal: ${apartmentId} ${ev.start}..${ev.end} (uid=${ev.uid})`);
            } else {
                console.error("upsert erro:", insErr);
            }
        } else {
            inserted++;  // upsert não distingue, mas o contador serve
        }
    }

    // Cancelar reservas 'booking' que já não vêm no feed (foram apagadas no Booking)
    if (seenUids.length > 0) {
        const { data: stale } = await sb
            .from("reservations")
            .select("id")
            .eq("apartment_id", apartmentId)
            .eq("source", "booking")
            .eq("status", "confirmed")
            .not("external_uid", "in", `(${seenUids.map(u => `"${u.replaceAll('"', '""')}"`).join(",")})`);

        if (stale && stale.length > 0) {
            const ids = stale.map((s: any) => s.id);
            await sb.from("reservations")
                .update({ status: "cancelled" })
                .in("id", ids);
            cancelled = ids.length;
        }
    }

    return { events: events.length, upserts: inserted, cancelled, conflicts };
}

// ---- Parser iCal mínimo (suporta o que o Booking produz) -------------------
interface IcsEvent { uid?: string; start?: string; end?: string; summary?: string; }

function parseIcs(text: string): IcsEvent[] {
    // Junta linhas continuadas (RFC 5545: linha começa com espaço/tab)
    const unfolded = text.replace(/\r?\n[ \t]/g, "");
    const lines = unfolded.split(/\r?\n/);

    const events: IcsEvent[] = [];
    let cur: IcsEvent | null = null;

    for (const raw of lines) {
        if (raw === "BEGIN:VEVENT") cur = {};
        else if (raw === "END:VEVENT") { if (cur) events.push(cur); cur = null; }
        else if (cur) {
            const colon = raw.indexOf(":");
            if (colon < 0) continue;
            const left  = raw.slice(0, colon);
            const value = unesc(raw.slice(colon + 1));
            const name  = left.split(";")[0].toUpperCase();

            if (name === "UID")     cur.uid = value;
            else if (name === "SUMMARY") cur.summary = value;
            else if (name === "DTSTART") cur.start = parseIcsDate(value);
            else if (name === "DTEND")   cur.end   = parseIcsDate(value);
        }
    }
    return events;
}
function parseIcsDate(s: string): string {
    // Aceita YYYYMMDD ou YYYYMMDDTHHMMSSZ — devolve YYYY-MM-DD
    const m = s.match(/^(\d{4})(\d{2})(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}
function unesc(s: string): string {
    return s.replaceAll("\\n", "\n").replaceAll("\\,", ",").replaceAll("\\;", ";").replaceAll("\\\\", "\\");
}

function json(o: unknown, status = 200) {
    return new Response(JSON.stringify(o), {
        status, headers: { "Content-Type": "application/json" },
    });
}
