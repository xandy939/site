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
        const body = await req.json().catch(() => ({}));
        const { reservation_id, mode, business_iban, business_name, business_bank } = body;
        if (!reservation_id) return json({ error: "reservation_id em falta" }, 400);
        // mode: undefined (default) = email ao dono + email ao hóspede (reserva confirmada)
        //       "reference"          = email só ao hóspede com a referência Multibanco
        //       "iban-reference"     = email ao hóspede com IBAN (usa business_* do payload)
        //       "iban-pending"       = email ao dono a avisar de reserva por transferência

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

        const client = new SMTPClient({
            connection: {
                hostname: "smtp.gmail.com",
                port: 465,
                tls: true,
                auth: { username: gmailUser, password: gmailPass },
            },
        });

        const errors: Record<string, string> = {};

        // ---- Modo "iban-reference": email ao hóspede com dados de transferência
        if (mode === "iban-reference") {
            let sent = false;
            try {
                await client.send({
                    from: fromAddress,
                    to: r.guest_email,
                    replyTo: ownerEmail,
                    subject: `📩 Dados para transferência — ${r.apartments?.name || r.apartment_id}`,
                    html: buildIbanReferenceHtml(r, noites, valorEur, { business_iban, business_name, business_bank }),
                });
                sent = true;
            } catch (e) { errors.guest = String(e); console.error("SMTP iban-reference falhou:", e); }
            await client.close();
            return json({ ok: sent, iban_reference_sent: sent, errors });
        }

        // ---- Modo "iban-pending": email ao patrão a avisar de reserva por transferência
        if (mode === "iban-pending") {
            let sent = false;
            try {
                await client.send({
                    from: fromAddress,
                    to: ownerEmail,
                    replyTo: r.guest_email,
                    subject: `💳 Nova reserva por transferência — ${r.apartments?.name || r.apartment_id}`,
                    html: buildIbanPendingHtml(r, noites, valorEur, adminUrl),
                });
                sent = true;
            } catch (e) { errors.owner = String(e); console.error("SMTP iban-pending falhou:", e); }
            await client.close();
            return json({ ok: sent, iban_pending_sent: sent, errors });
        }

        // ---- Modo "reference": email ao hóspede com a referência Multibanco
        if (mode === "reference") {
            let referenceSent = false;
            try {
                await client.send({
                    from: fromAddress,
                    to: r.guest_email,
                    replyTo: ownerEmail,
                    subject: `📩 Referência de pagamento — ${r.apartments?.name || r.apartment_id}`,
                    html: buildReferenceHtml(r, noites, valorEur),
                });
                referenceSent = true;
            } catch (e) {
                errors.guest = String(e);
                console.error("SMTP reference falhou:", e);
            }
            await client.close();
            return json({ ok: referenceSent, reference_email_sent: referenceSent, errors });
        }

        // ---- Modo default: confirmação (dono + hóspede) -------------------
        const ownerHtml = buildOwnerHtml(r, noites, valorEur, adminUrl);
        const guestHtml = buildGuestHtml(r, noites, valorEur);

        let ownerSent = false, guestSent = false;

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

// Dados bancários (não confidenciais — mostrados a qualquer cliente IBAN).
// Para mudar: edita aqui e redeploy.
// Fallback caso o frontend não envie os valores (deve sempre enviar).
// IBAN/Titular reais ficam em reservations.js → BANK_INFO[apartment_id]
const BUSINESS_IBAN = "PT50 0269 0168 0020 0794 6527 5";
const BUSINESS_NAME = "TudoParaRegistar, LDA";
const BUSINESS_BANK = "Bankinter";

function buildIbanReferenceHtml(r: any, noites: number, valorEur: string | null, overrides?: { business_iban?: string, business_name?: string, business_bank?: string }) {
    const aptName = r.apartments?.name || r.apartment_id;
    const iban    = overrides?.business_iban || BUSINESS_IBAN;
    const titular = overrides?.business_name || BUSINESS_NAME;
    const banco   = overrides?.business_bank || BUSINESS_BANK;
    const shortRef = "TR-" + (r.id as string).replace(/-/g, "").slice(0, 8).toUpperCase();
    return `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:580px;margin:auto;color:#1a365d;">
          <div style="text-align:center;margin-bottom:24px;">
            <h2 style="margin:0 0 6px;">Dados para transferência bancária</h2>
            <p style="color:#64748b;margin:0;">Olá ${esc(r.guest_name?.split(' ')[0] || 'hóspede')}, falta só pagar para confirmares a tua reserva no <strong>${esc(aptName)}</strong>.</p>
          </div>

          <div style="background:#1a2540;color:#fff;border-radius:12px;padding:24px;margin-bottom:24px;">
            <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:.75;margin-bottom:8px;">Titular</div>
            <div style="font-size:18px;font-weight:600;margin-bottom:18px;">${esc(titular)}</div>

            ${banco ? `
            <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:.75;margin-bottom:8px;">Banco</div>
            <div style="font-size:18px;font-weight:600;margin-bottom:18px;">${esc(banco)}</div>
            ` : ""}

            <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:.75;margin-bottom:8px;">IBAN</div>
            <div style="font-size:22px;font-weight:700;letter-spacing:2px;margin-bottom:18px;font-family:'SF Mono',Consolas,monospace;word-break:break-all;">${esc(iban)}</div>

            <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:.75;margin-bottom:8px;">Valor a transferir</div>
            <div style="font-size:32px;font-weight:700;color:#c9a875;margin-bottom:18px;">€ ${esc(valorEur || "")}</div>

            <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:.75;margin-bottom:8px;">Descrição/Referência</div>
            <div style="font-size:22px;font-weight:700;letter-spacing:2px;font-family:'SF Mono',Consolas,monospace;">${esc(shortRef)}</div>
          </div>

          <div style="background:#fff8e1;border:1px solid #f0d97f;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
            <div style="font-weight:700;color:#8a6d00;margin-bottom:6px;">⚠ Põe a referência <code style="background:#fff;padding:2px 8px;border-radius:4px;font-size:13px;">${esc(shortRef)}</code> na descrição da transferência</div>
            <div style="font-size:13.5px;color:#5d4d00;">Sem isto não conseguimos associar a transferência à tua reserva. As datas ficam reservadas para ti até o pagamento ser confirmado.</div>
          </div>

          <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:10px;overflow:hidden;margin-bottom:20px;">
            <tr><td style="padding:12px 16px;font-weight:700;width:140px;">Check-in</td>
                <td style="padding:12px 16px;">${esc(formatDate(r.check_in))}</td></tr>
            <tr><td style="padding:12px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Check-out</td>
                <td style="padding:12px 16px;border-top:1px solid #e2e8f0;">${esc(formatDate(r.check_out))}</td></tr>
            <tr><td style="padding:12px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Estadia</td>
                <td style="padding:12px 16px;border-top:1px solid #e2e8f0;">${noites} noite(s) · ${r.guests} hóspede(s)</td></tr>
          </table>

          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:20px;">
            <h3 style="margin:0 0 12px;font-size:15px;">Próximos passos</h3>
            <ol style="margin:0;padding-left:20px;font-size:14px;color:#475569;line-height:1.7;">
              <li>Faz a transferência com o valor exacto e a referência ${esc(shortRef)}</li>
              <li>Quando recebermos o dinheiro (1-2 dias úteis), confirmamos a reserva</li>
              <li>Recebes um email "Reserva confirmada" com as instruções de chegada</li>
            </ol>
            <p style="margin:14px 0 0;font-size:13.5px;color:#64748b;">Se quiseres acelerar, podes responder a este email com o comprovativo.</p>
          </div>

          <p style="color:#cbd5e1;font-size:12px;margin-top:24px;text-align:center;">
            By TR Alojamentos · Portimão, Algarve
          </p>
        </div>
    `;
}

function buildIbanPendingHtml(r: any, noites: number, valorEur: string | null, adminUrl: string) {
    const aptName = r.apartments?.name || r.apartment_id;
    const shortRef = "TR-" + (r.id as string).replace(/-/g, "").slice(0, 8).toUpperCase();
    return `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:580px;margin:auto;color:#1a365d;">
          <h2 style="margin:0 0 6px;">Nova reserva por transferência 💳</h2>
          <p style="color:#64748b;margin:0 0 24px;">${esc(aptName)} · à espera que confirmes manualmente</p>

          <div style="background:#fff8e1;border:1px solid #f0d97f;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
            <div style="font-weight:700;color:#8a6d00;margin-bottom:6px;">⚠ Acção necessária</div>
            <div style="font-size:13.5px;color:#5d4d00;">Quando vires a transferência de <strong>€ ${esc(valorEur || "")}</strong> com a descrição <code style="background:#fff;padding:2px 8px;border-radius:4px;font-size:13px;">${esc(shortRef)}</code> no extracto do banco, entra no painel de admin e clica em "Confirmar pagamento".</div>
          </div>

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
            <tr><td style="padding:12px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Referência da transferência</td>
                <td style="padding:12px 16px;border-top:1px solid #e2e8f0;font-family:'SF Mono',Consolas,monospace;font-weight:700;">${esc(shortRef)}</td></tr>
            <tr><td style="padding:12px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Valor esperado</td>
                <td style="padding:12px 16px;border-top:1px solid #e2e8f0;font-weight:700;color:#137333;">€ ${esc(valorEur || "")}</td></tr>
          </table>

          <p style="margin-top:20px;font-size:13.5px;color:#64748b;">As datas já estão bloqueadas no calendário. Quando confirmares, o hóspede recebe automaticamente um email "Reserva confirmada".</p>

          <div style="margin-top:24px;text-align:center;">
            <a href="${esc(adminUrl)}" style="display:inline-block;background:#0073e6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:700;">Abrir painel de admin →</a>
          </div>
        </div>
    `;
}

function buildReferenceHtml(r: any, noites: number, valorEur: string | null) {
    const aptName = r.apartments?.name || r.apartment_id;
    const ref = r.ifthenpay_reference || "";
    const refFmt = ref.length === 9 ? `${ref.slice(0,3)} ${ref.slice(3,6)} ${ref.slice(6,9)}` : ref;
    const expiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const expiryFmt = `${String(expiry.getDate()).padStart(2,"0")}/${String(expiry.getMonth()+1).padStart(2,"0")}/${expiry.getFullYear()}`;
    return `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:580px;margin:auto;color:#1a365d;">
          <div style="text-align:center;margin-bottom:24px;">
            <h2 style="margin:0 0 6px;">Referência de pagamento Multibanco</h2>
            <p style="color:#64748b;margin:0;">Olá ${esc(r.guest_name?.split(' ')[0] || 'hóspede')}, falta só pagar para confirmares a tua reserva no <strong>${esc(aptName)}</strong>.</p>
          </div>

          <div style="background:#1a2540;color:#fff;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
            <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:.75;margin-bottom:8px;">Entidade</div>
            <div style="font-size:32px;font-weight:700;letter-spacing:2px;margin-bottom:18px;">${esc(r.ifthenpay_entity || "")}</div>

            <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:.75;margin-bottom:8px;">Referência</div>
            <div style="font-size:28px;font-weight:700;letter-spacing:3px;margin-bottom:18px;font-family:'SF Mono',Consolas,monospace;">${esc(refFmt)}</div>

            <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:.75;margin-bottom:8px;">Valor</div>
            <div style="font-size:32px;font-weight:700;color:#c9a875;">€ ${esc(valorEur || "")}</div>
          </div>

          <div style="background:#fff8e1;border:1px solid #f0d97f;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
            <div style="font-weight:700;color:#8a6d00;margin-bottom:6px;">⏰ Prazo: até ${expiryFmt}</div>
            <div style="font-size:13.5px;color:#5d4d00;">A referência expira em 3 dias. Se não pagares até lá, as datas voltam a ficar disponíveis para outras pessoas.</div>
          </div>

          <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:10px;overflow:hidden;margin-bottom:20px;">
            <tr><td style="padding:12px 16px;font-weight:700;width:140px;">Check-in</td>
                <td style="padding:12px 16px;">${esc(formatDate(r.check_in))}</td></tr>
            <tr><td style="padding:12px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Check-out</td>
                <td style="padding:12px 16px;border-top:1px solid #e2e8f0;">${esc(formatDate(r.check_out))}</td></tr>
            <tr><td style="padding:12px 16px;font-weight:700;border-top:1px solid #e2e8f0;">Estadia</td>
                <td style="padding:12px 16px;border-top:1px solid #e2e8f0;">${noites} noite(s) · ${r.guests} hóspede(s)</td></tr>
          </table>

          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:20px;">
            <h3 style="margin:0 0 12px;font-size:15px;">Como pagar</h3>
            <ul style="margin:0;padding-left:20px;font-size:14px;color:#475569;line-height:1.7;">
              <li><strong>Multibanco / ATM:</strong> Pagamentos → Pagamentos de Serviços → Entidade + Referência + Valor</li>
              <li><strong>Homebanking:</strong> Pagamentos → Serviços → introduzir Entidade, Referência e Valor</li>
              <li><strong>MB WAY:</strong> Pagar Serviços / Compras → Entidade + Referência + Valor</li>
            </ul>
            <p style="margin:14px 0 0;font-size:13.5px;color:#64748b;">Assim que pagares, recebes outro email a confirmar a reserva. Não é preciso enviar comprovativo.</p>
          </div>

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
