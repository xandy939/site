// Supabase Edge Function: notify-owner
// Disparada pelo trigger reservations_notify_owner quando uma reserva fica
// confirmed. Envia DOIS emails: um ao dono ("nova reserva paga") e outro
// ao hóspede ("a tua reserva está confirmada"). Envia via Gmail SMTP.
//
// Deploy:  via tools/deploy-functions.mjs
// Secrets necessários (no Supabase dashboard > Edge Functions > Secrets):
//   GMAIL_USER          — endereço Gmail do dono (ex: "miguelpararegistrar@gmail.com")
//   GMAIL_APP_PASSWORD  — App Password (16 chars) de https://myaccount.google.com/apppasswords
//   FROM_NAME           — opcional, nome a mostrar como remetente (default: "By TR Alojamentos")
//   APP_BASE_URL        — opcional, URL do site (para o link "Abrir admin" no email do dono)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient }  from "https://deno.land/x/denomailer@1.6.0/mod.ts";

Deno.serve(async (req) => {
    try {
        const { reservation_id } = await req.json().catch(() => ({}));
        if (!reservation_id) return json({ error: "reservation_id em falta" }, 400);

        const sb = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        const { data: r, error } = await sb
            .from("reservations")
            .select("*, apartments(name)")
            .eq("id", reservation_id)
            .single();
        if (error || !r) return json({ error: "Reserva não encontrada" }, 404);

        const { data: ownerSetting } = await sb
            .from("app_settings").select("value").eq("key", "owner_email").single();
        const ownerEmail = ownerSetting?.value;
        if (!ownerEmail) return json({ error: "owner_email não configurado" }, 500);

        const gmailUser = Deno.env.get("GMAIL_USER");
        const gmailPass = Deno.env.get("GMAIL_APP_PASSWORD");
        if (!gmailUser || !gmailPass) {
            return json({ error: "Gmail SMTP não configurado" }, 500);
        }
        const fromName = Deno.env.get("FROM_NAME") || "By TR Alojamentos";
        const fromAddress = `${fromName} <${gmailUser}>`;

        const noites = Math.round(
            (new Date(r.check_out).getTime() - new Date(r.check_in).getTime()) / 86400000
        );
        const valorEur = r.amount_cents ? (r.amount_cents / 100).toFixed(2) : null;
        const adminUrl = (Deno.env.get("APP_BASE_URL") || "") + "/admin.html";

        // ---- HTMLs --------------------------------------------------------
        const ownerHtml = buildOwnerHtml(r, noites, valorEur, adminUrl);
        const guestHtml = buildGuestHtml(r, noites, valorEur);

        // ---- SMTP client (single connection, dois envios) -----------------
        const client = new SMTPClient({
            connection: {
                hostname: "smtp.gmail.com",
                port: 465,
                tls: true,
                auth: { username: gmailUser, password: gmailPass },
            },
        });

        let ownerSent = false, guestSent = false;
        const errors: Record<string, string> = {};

        try {
            await client.send({
                from: fromAddress,
                to: ownerEmail,
                replyTo: r.guest_email,
                subject: `💰 Reserva paga: ${r.apartments?.name || r.apartment_id} — ${formatDate(r.check_in)} a ${formatDate(r.check_out)}`,
                html: ownerHtml,
            });
            ownerSent = true;
        } catch (e) {
            errors.owner = String(e);
            console.error("SMTP owner falhou:", e);
        }

        try {
            await client.send({
                from: fromAddress,
                to: r.guest_email,
                replyTo: ownerEmail,
                subject: `Reserva confirmada — ${r.apartments?.name || r.apartment_id}`,
                html: guestHtml,
            });
            guestSent = true;
        } catch (e) {
            errors.guest = String(e);
            console.error("SMTP guest falhou:", e);
        }

        await client.close();

        return json({ ok: ownerSent || guestSent, owner_email_sent: ownerSent, guest_email_sent: guestSent, errors });
    } catch (e) {
        console.error(e);
        return json({ error: String(e) }, 500);
    }
});

function buildOwnerHtml(r: any, noites: number, valorEur: string | null, adminUrl: string) {
    const aptName = r.apartments?.name || r.apartment_id;
    return `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:580px;margin:auto;color:#1a365d;">
          <h2 style="margin:0 0 6px;">Nova reserva paga 💰</h2>
          <p style="color:#64748b;margin:0 0 24px;">${esc(aptName)}</p>

          <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:10px;overflow:hidden;">
            <tr><td style="padding:12px 16px;font-weight:700;width:140px;">Hóspede</td>
                <td style="padding:12px 16px;">${esc(r.guest_name)}</td></tr>
            <tr><td style="padding:12px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Email</td>
                <td style="padding:12px 16px;border-top:1px solid #e2e8f0;"><a href="mailto:${esc(r.guest_email)}">${esc(r.guest_email)}</a></td></tr>
            <tr><td style="padding:12px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Telefone</td>
                <td style="padding:12px 16px;border-top:1px solid #e2e8f0;">${esc(r.guest_phone || "—")}</td></tr>
            <tr><td style="padding:12px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Check-in</td>
                <td style="padding:12px 16px;border-top:1px solid #e2e8f0;">${esc(formatDate(r.check_in))}</td></tr>
            <tr><td style="padding:12px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Check-out</td>
                <td style="padding:12px 16px;border-top:1px solid #e2e8f0;">${esc(formatDate(r.check_out))}</td></tr>
            <tr><td style="padding:12px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Estadia</td>
                <td style="padding:12px 16px;border-top:1px solid #e2e8f0;">${noites} noite(s) · ${r.guests} hóspede(s)</td></tr>
            ${valorEur ? `
            <tr><td style="padding:12px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Valor pago</td>
                <td style="padding:12px 16px;border-top:1px solid #e2e8f0;font-weight:700;color:#137333;">€ ${valorEur}${r.payment_method ? ' · ' + esc(r.payment_method) : ''}</td></tr>
            ` : ''}
          </table>

          <div style="margin-top:24px;text-align:center;">
            <a href="${esc(adminUrl)}" style="display:inline-block;background:#0073e6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:700;">Abrir painel de reservas →</a>
          </div>
        </div>
    `;
}

function buildGuestHtml(r: any, noites: number, valorEur: string | null) {
    const aptName = r.apartments?.name || r.apartment_id;
    return `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:580px;margin:auto;color:#1a365d;">
          <div style="text-align:center;margin-bottom:24px;">
            <div style="display:inline-block;width:72px;height:72px;border-radius:50%;background:#e6f4ea;color:#137333;line-height:72px;font-size:36px;">✓</div>
            <h2 style="margin:18px 0 6px;">A tua reserva está confirmada!</h2>
            <p style="color:#64748b;margin:0;">Olá ${esc(r.guest_name?.split(' ')[0] || 'hóspede')}, recebemos a tua reserva no apartamento <strong>${esc(aptName)}</strong>.</p>
          </div>

          <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:10px;overflow:hidden;">
            <tr><td style="padding:14px 16px;font-weight:700;width:140px;">Check-in</td>
                <td style="padding:14px 16px;">${esc(formatDate(r.check_in))} (a partir das 15:00)</td></tr>
            <tr><td style="padding:14px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Check-out</td>
                <td style="padding:14px 16px;border-top:1px solid #e2e8f0;">${esc(formatDate(r.check_out))} (até às 11:00)</td></tr>
            <tr><td style="padding:14px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Estadia</td>
                <td style="padding:14px 16px;border-top:1px solid #e2e8f0;">${noites} noite(s) · ${r.guests} hóspede(s)</td></tr>
            ${valorEur ? `
            <tr><td style="padding:14px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Valor pago</td>
                <td style="padding:14px 16px;border-top:1px solid #e2e8f0;font-weight:700;color:#137333;">€ ${valorEur}</td></tr>
            ` : ''}
          </table>

          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin-top:20px;">
            <h3 style="margin:0 0 12px;font-size:15px;">Antes da chegada</h3>
            <ul style="margin:0;padding-left:20px;font-size:14px;color:#475569;line-height:1.7;">
              <li>Vais receber instruções de acesso por email/WhatsApp 1-2 dias antes</li>
              <li>Estacionamento privado disponível (vamos enviar-te a localização)</li>
              <li>Wi-Fi grátis no apartamento</li>
            </ul>
          </div>

          <p style="margin-top:24px;color:#64748b;font-size:13.5px;text-align:center;line-height:1.6;">
            Se tiveres alguma questão, responde directamente a este email.<br>
            Boa estadia em Praia da Rocha! 🌅
          </p>
          <p style="color:#cbd5e1;font-size:12px;margin-top:24px;text-align:center;">
            By TR Alojamentos · Portimão, Algarve
          </p>
        </div>
    `;
}

function json(o: unknown, status = 200) {
    return new Response(JSON.stringify(o), {
        status, headers: { "Content-Type": "application/json" },
    });
}
function esc(s: string) {
    return (s ?? "").toString()
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function formatDate(s: string) {
    const [y, m, d] = s.split("-");
    return `${d}/${m}/${y}`;
}
