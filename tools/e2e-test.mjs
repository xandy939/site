// End-to-end test: cria dados reais, verifica que ficam guardados, depois limpa.
// Mostra cada operação e o estado da BD a cada passo.
import fs from "node:fs";

const token = fs.readFileSync(".supabase-token", "utf8").trim();
const PROJ = "mfrmkkdqmlfuswggqbra";
const API  = `https://api.supabase.com/v1/projects/${PROJ}`;
const FN   = `https://${PROJ}.supabase.co/functions/v1`;

async function sql(q) {
    const r = await fetch(`${API}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
    });
    return r.ok ? await r.json() : { error: r.status + " " + await r.text() };
}

function box(title) { console.log("\n┌─" + "─".repeat(title.length+2) + "─┐"); console.log(`│ ${title}  │`); console.log("└─" + "─".repeat(title.length+2) + "─┘"); }
function ok(m){ console.log("  ✓ " + m); }
function bad(m){ console.log("  ✗ " + m); }
function info(m){ console.log("    " + m); }

let CLEANUP = [];

// ─────────────────────────────────────────────────────────────
box("TESTE 1: criar reserva via create-checkout");
// ─────────────────────────────────────────────────────────────

const r1 = await fetch(`${FN}/create-checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        apartment_id: "litoral-mar",
        check_in:  "2027-07-10",
        check_out: "2027-07-15",
        guests: 2,
        guest_name:  "Hóspede Teste E2E",
        guest_email: "e2e-test@example.com",
        guest_phone: "+351 919 999 999",
    }),
});
const data1 = await r1.json();
if (r1.status !== 200) { bad("create-checkout falhou: " + JSON.stringify(data1)); process.exit(1); }
ok("create-checkout devolveu HTTP 200");
info("reservation_id: " + data1.reservation_id);
info("checkout_url:   " + data1.checkout_url.slice(0, 60) + "...");
info("amount:         €" + (data1.amount_cents/100).toFixed(2) + " (" + data1.nights + " noites)");
CLEANUP.push(data1.reservation_id);

// Verifica que ficou guardada com TODOS os campos certos
const saved1 = await sql(`select id, apartment_id, guest_name, guest_email, guest_phone, guests, check_in::text, check_out::text, status, source, amount_cents, stripe_session_id is not null as has_session_id from reservations where id = '${data1.reservation_id}';`);
if (saved1.length === 1) {
    const r = saved1[0];
    ok("Reserva guardada na BD:");
    info(`  apartment_id    = ${r.apartment_id}`);
    info(`  guest_name      = ${r.guest_name}`);
    info(`  guest_email     = ${r.guest_email}`);
    info(`  guest_phone     = ${r.guest_phone}`);
    info(`  guests          = ${r.guests}`);
    info(`  check_in/out    = ${r.check_in} → ${r.check_out}`);
    info(`  status          = ${r.status}     ${r.status==='awaiting_payment' ? '← bloqueia calendário' : ''}`);
    info(`  source          = ${r.source}`);
    info(`  amount_cents    = ${r.amount_cents}   (€${r.amount_cents/100})`);
    info(`  stripe_session  = ${r.has_session_id ? 'guardado ✓' : 'EM FALTA'}`);
} else { bad("não está na BD"); }

// ─────────────────────────────────────────────────────────────
box("TESTE 2: constraint anti-sobreposição");
// ─────────────────────────────────────────────────────────────

const r2 = await fetch(`${FN}/create-checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        apartment_id: "litoral-mar",
        check_in:  "2027-07-12",  // datas que sobrepõem 10-15
        check_out: "2027-07-14",
        guests: 1,
        guest_name:  "Outro Hóspede",
        guest_email: "e2e-overlap@example.com",
    }),
});
const data2 = await r2.json();
if (r2.status === 409 && data2.overlap) {
    ok("Sobreposição rejeitada com HTTP 409 (correcto)");
    info(`error: "${data2.error}"`);
} else {
    bad("FALHA: devia ter bloqueado a sobreposição, mas " + r2.status + " " + JSON.stringify(data2));
}

// ─────────────────────────────────────────────────────────────
box("TESTE 3: view 'availability' reflecte bloqueio");
// ─────────────────────────────────────────────────────────────

const avail = await sql(`select check_in::text, check_out::text from availability where apartment_id='litoral-mar' and check_in <= '2027-07-15' and check_out >= '2027-07-10';`);
if (avail.find(a => a.check_in === "2027-07-10" && a.check_out === "2027-07-15")) {
    ok("View availability inclui a reserva nova");
    info(`  Encontrei: ${avail.map(a => a.check_in+"→"+a.check_out).join(", ")}`);
} else { bad("View availability NÃO mostra a reserva"); }

// ─────────────────────────────────────────────────────────────
box("TESTE 4: simular pagamento confirmado → trigger dispara");
// ─────────────────────────────────────────────────────────────

const before = await sql(`select count(*)::int as n from net._http_response where created > now() - interval '10 seconds';`);
const beforeN = before[0]?.n || 0;

// Simula o webhook: passa o status para confirmed
await sql(`update reservations set status = 'confirmed', payment_method = 'card' where id = '${data1.reservation_id}';`);
ok("Status actualizado para 'confirmed' via SQL");
info("  Aguarda 4s para o trigger e pg_net responderem...");
await new Promise(r => setTimeout(r, 4500));

const after = await sql(`select status_code, left(content::text, 80) as snippet from net._http_response where created > now() - interval '15 seconds' order by created desc limit 3;`);
if (after.length > beforeN) {
    ok("Trigger disparou: " + (after.length) + " chamada(s) HTTP nos últimos segundos");
    for (const r of after) info("  → HTTP " + r.status_code + " " + r.snippet);
} else { bad("Trigger não disparou — pg_net._http_response sem novos registos"); }

// ─────────────────────────────────────────────────────────────
box("TESTE 5: confirmação de pagamento bloqueia novas reservas");
// ─────────────────────────────────────────────────────────────

const r3 = await fetch(`${FN}/create-checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        apartment_id: "litoral-mar",
        check_in:  "2027-07-11",  // sobrepõe a já confirmed (10-15)
        check_out: "2027-07-13",
        guests: 1,
        guest_name:  "Tarde Demais",
        guest_email: "e2e-tarde@example.com",
    }),
});
const data3 = await r3.json();
if (r3.status === 409 && data3.overlap) {
    ok("Reserva sobreposta a CONFIRMED também é bloqueada (correcto)");
} else { bad("FALHA: " + r3.status + " " + JSON.stringify(data3)); }

// ─────────────────────────────────────────────────────────────
box("TESTE 6: ical-export inclui só CONFIRMED");
// ─────────────────────────────────────────────────────────────

const ical = await fetch(`${FN}/ical-export?apt=litoral-mar`).then(r => r.text());
const has = ical.includes("DTSTART;VALUE=DATE:20270710");
if (has) {
    ok("Feed iCal contém a reserva confirmada (linha DTSTART:20270710)");
    const eventCount = (ical.match(/BEGIN:VEVENT/g) || []).length;
    info(`  Total de eventos no feed: ${eventCount}`);
} else { bad("Reserva confirmada NÃO aparece no .ics"); }

// ─────────────────────────────────────────────────────────────
box("TESTE 7: tabela 'profiles' e trigger handle_new_user");
// ─────────────────────────────────────────────────────────────

const profileCount = await sql(`select count(*)::int as n from auth.users u left join profiles p on p.id = u.id where p.id is null;`);
if (profileCount[0]?.n === 0) {
    ok("Todos os utilizadores em auth.users têm linha em profiles (trigger funciona)");
} else { bad(`${profileCount[0]?.n} utilizadores sem linha em profiles`); }

const totalUsers = await sql(`select count(*)::int as n from auth.users;`);
info(`  Total de users registados: ${totalUsers[0].n}`);

// Mostra os primeiros 5 perfis com dados
const profiles = await sql(`select u.email, p.first_name, p.last_name, p.phone, p.age, p.gender from auth.users u left join profiles p on p.id = u.id order by u.created_at desc limit 5;`);
info("  Últimos 5 utilizadores:");
for (const u of profiles) info(`    ${u.email}: ${u.first_name||'?'} ${u.last_name||'?'}, tel=${u.phone||'-'}, idade=${u.age||'-'}, género=${u.gender||'-'}`);

// ─────────────────────────────────────────────────────────────
box("TESTE 8: estado actual da BD");
// ─────────────────────────────────────────────────────────────

const counts = await sql(`select 'reservations' as tabela, count(*)::int as n from reservations union all select 'apartments', count(*) from apartments union all select 'profiles', count(*) from profiles union all select 'auth.users', count(*) from auth.users union all select 'app_settings', count(*) from app_settings;`);
for (const c of counts) info(`  ${c.tabela}: ${c.n}`);

// ─────────────────────────────────────────────────────────────
box("CLEANUP — apagar dados de teste");
// ─────────────────────────────────────────────────────────────

for (const id of CLEANUP) {
    await sql(`delete from reservations where id = '${id}';`);
    ok("apagada reserva " + id);
}

const finalState = await sql(`select status, count(*)::int as n from reservations group by status order by status;`);
console.log("\nEstado final das reservas:");
for (const r of finalState) console.log(`   ${r.status}: ${r.n}`);

console.log("\n────────────────────────────");
console.log("Teste end-to-end completo.");
