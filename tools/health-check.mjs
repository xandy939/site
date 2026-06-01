// Comprehensive site health check
import fs from "node:fs";
import vm from "node:vm";

const token = fs.readFileSync(".supabase-token", "utf8").trim();
const PROJ = "mfrmkkdqmlfuswggqbra";
const BASE_API = `https://api.supabase.com/v1/projects/${PROJ}`;
const FN_BASE  = `https://${PROJ}.supabase.co/functions/v1`;
const REST     = `https://${PROJ}.supabase.co/rest/v1`;
const ANON     = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mcm1ra2RxbWxmdXN3Z2dxYnJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjM5NDYsImV4cCI6MjA5NDgzOTk0Nn0.T-niRyVa8D8RjXOgKqENbwNoVQFJ95cpfaH--LyfrOE";

let nPass = 0, nWarn = 0, nFail = 0;
const log = (k, n, m) => {
    const s = { pass: "✓", warn: "⚠", fail: "✗" }[k];
    if (k === "pass") nPass++; else if (k === "warn") nWarn++; else nFail++;
    console.log(`${s} [${n}] ${m}`);
};

async function sql(q) {
    const r = await fetch(`${BASE_API}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
    });
    return r.ok ? await r.json() : { error: await r.text(), status: r.status };
}

console.log("\n=== HTML pages ===");
const pages = ["index.html","login.html","registar.html","perfil.html","admin.html","apartamento-rocha.html","apartamento-amarilis.html","reserva-confirmada.html","reserva-cancelada.html"];
for (const p of pages) {
    log(fs.existsSync(p) ? "pass" : "fail", "pages", p);
}

console.log("\n=== JS syntax ===");
for (const f of ["script.js","supabase-auth.js","reservations.js","admin.js"]) {
    try { new vm.Script(fs.readFileSync(f, "utf8"), { filename: f }); log("pass", "syntax", f); }
    catch (e) { log("fail", "syntax", `${f} — ${e.message.split("\n")[0]}`); }
}

console.log("\n=== DB tables and views ===");
let r = await sql(`select table_name from information_schema.tables where table_schema='public' and table_name in ('reservations','apartments','app_settings','profiles','availability') order by 1;`);
const expectedTabs = ["apartments","app_settings","availability","profiles","reservations"];
const gotTabs = r.map(x => x.table_name);
for (const t of expectedTabs) log(gotTabs.includes(t) ? "pass" : "fail", "db", t);

console.log("\n=== DB constraints + triggers ===");
r = await sql(`select conname from pg_constraint where conname in ('reservations_no_overlap','reservations_status_check');`);
for (const c of ["reservations_no_overlap","reservations_status_check"])
    log(r.find(x => x.conname === c) ? "pass" : "fail", "constraint", c);

r = await sql(`select tgname from pg_trigger where tgname in ('reservations_notify_owner','on_auth_user_created','reservations_touch_updated_at');`);
for (const t of ["reservations_notify_owner","on_auth_user_created","reservations_touch_updated_at"])
    log(r.find(x => x.tgname === t) ? "pass" : "fail", "trigger", t);

console.log("\n=== DB crons ===");
r = await sql(`select jobname, schedule, active from cron.job order by jobname;`);
for (const exp of [{n:"cleanup_expired_payments",s:"*/2 * * * *"},{n:"ical_import_hourly",s:"7 * * * *"}]) {
    const j = r.find(x => x.jobname === exp.n);
    log(j?.active && j.schedule === exp.s ? "pass" : "fail", "cron", `${exp.n} (${j?.schedule || "MISSING"})`);
}

console.log("\n=== app_settings configured ===");
r = await sql(`select key from app_settings where key in ('owner_email','edge_url','service_key');`);
for (const k of ["owner_email","edge_url","service_key"])
    log(r.find(x => x.key === k) ? "pass" : "fail", "settings", k);

console.log("\n=== Edge Functions ===");
const fns = await fetch(`${BASE_API}/functions`, { headers: { Authorization: `Bearer ${token}` } }).then(x => x.json());
const expectedFns = { "notify-owner": true, "ical-export": false, "ical-import": true, "create-checkout": false, "stripe-webhook": false };
for (const slug of Object.keys(expectedFns)) {
    const fn = fns.find(f => f.slug === slug);
    if (!fn) { log("fail", "edge-fn", `${slug} NOT DEPLOYED`); continue; }
    const ok = fn.verify_jwt === expectedFns[slug];
    log(ok ? "pass" : "warn", "edge-fn", `${slug} v${fn.version} jwt=${fn.verify_jwt}`);
}

console.log("\n=== Edge Functions invocation ===");
// ical-export
let resp = await fetch(`${FN_BASE}/ical-export?apt=litoral-mar`);
let body = await resp.text();
log(resp.status === 200 && body.startsWith("BEGIN:VCALENDAR") ? "pass" : "fail", "invoke",
    `ical-export → ${resp.status}`);

// create-checkout POST
resp = await fetch(`${FN_BASE}/create-checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5500" },
    body: JSON.stringify({ apartment_id: "litoral-mar", check_in: "2028-02-10", check_out: "2028-02-13", guests: 1, guest_name: "HealthCheck", guest_email: "health@test.local" }),
});
let data = await resp.json();
if (resp.status === 200 && data.checkout_url?.startsWith("https://checkout.stripe.com/")) {
    log("pass", "invoke", `create-checkout → Stripe (€${(data.amount_cents / 100).toFixed(2)}, ${data.nights} noites)`);
} else {
    log("fail", "invoke", `create-checkout → ${resp.status} ${JSON.stringify(data)}`);
}

// CORS preflight
resp = await fetch(`${FN_BASE}/create-checkout`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:5500", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
});
log(resp.status === 204 && resp.headers.get("access-control-allow-origin") ? "pass" : "fail", "invoke",
    `CORS preflight create-checkout → ${resp.status}`);

// notify-owner without Gmail creds
const serviceKey = fs.readFileSync(".supabase-service-key", "utf8").trim();
resp = await fetch(`${FN_BASE}/notify-owner`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ reservation_id: "00000000-0000-0000-0000-000000000000" }),
});
data = await resp.json();
const expectedErr = data.error === "Gmail SMTP não configurado" || data.error === "Reserva não encontrada";
log(expectedErr ? "warn" : "fail", "invoke",
    `notify-owner → ${data.error || "OK"} (esperado: sem GMAIL_APP_PASSWORD)`);

console.log("\n=== Anon REST (public reads) ===");
resp = await fetch(`${REST}/availability?apartment_id=eq.litoral-mar&select=check_in,check_out`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
});
log(resp.ok ? "pass" : "fail", "rest", `availability view → ${resp.status}`);

resp = await fetch(`${REST}/apartments?select=id,name,active,price_per_night_cents`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
});
data = await resp.json();
if (resp.ok && data.length === 2) {
    const lm = data.find(a => a.id === "litoral-mar");
    const ps = data.find(a => a.id === "paraiso-do-sol");
    log("pass", "rest", `apartments: Litoral Mar €${lm.price_per_night_cents/100} (active=${lm.active}), Paraíso €${ps.price_per_night_cents/100} (active=${ps.active})`);
} else log("fail", "rest", `apartments → ${resp.status}`);

// Cleanup test data
await sql(`delete from reservations where guest_email = 'health@test.local';`);

console.log("\n=== Reservas actuais ===");
r = await sql(`select status, count(*)::int as n from reservations group by status order by status;`);
for (const row of r) console.log(`   ${row.status}: ${row.n}`);

console.log("\n────────────────────────");
console.log(`Resumo: ${nPass} OK · ${nWarn} avisos · ${nFail} falhas`);
process.exit(nFail > 0 ? 1 : 0);
