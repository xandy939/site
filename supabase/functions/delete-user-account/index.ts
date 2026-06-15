// Supabase Edge Function: delete-user-account
// Apaga a conta de um utilizador (auth.users + profiles).
// Só o dono (is_owner=true) pode invocar.
//
// Body: { email: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "POST")    return json({ error: "POST only" }, 405);

    // 1. Verificar que o caller é owner via JWT
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "Sem autorização" }, 401);

    const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: auth } } }
    );
    const { data: ehDono, error: eDono } = await userClient.rpc("is_owner");
    if (eDono || !ehDono) return json({ error: "Apenas o dono pode apagar contas" }, 403);

    // 2. Body
    let body: { email?: string };
    try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
    const email = (body.email || "").trim().toLowerCase();
    if (!email) return json({ error: "Email em falta" }, 400);

    // 3. Encontrar utilizador
    const adminClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: lista, error: eList } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (eList) return json({ error: "Erro a listar utilizadores: " + eList.message }, 500);
    const user = lista.users.find(u => (u.email || "").toLowerCase() === email);

    // 4. Apagar todas as reservas com este email (independente de ter conta ou não)
    const { error: eRes, count: nRes } = await adminClient
        .from("reservations")
        .delete({ count: "exact" })
        .ilike("guest_email", email);
    if (eRes) return json({ error: "Erro ao apagar reservas: " + eRes.message }, 500);

    // 5. Se tinha conta, apagar também a conta (perfil cai em cascata)
    if (user) {
        const { error: eDel } = await adminClient.auth.admin.deleteUser(user.id);
        if (eDel) return json({ error: "Reservas apagadas, mas erro ao apagar conta: " + eDel.message }, 500);
        return json({ ok: true, deleted_user_id: user.id, deleted_reservations: nRes, email, had_account: true });
    }

    return json({ ok: true, deleted_reservations: nRes, email, had_account: false });
});

function json(o: unknown, status = 200) {
    return new Response(JSON.stringify(o), {
        status, headers: { "Content-Type": "application/json", ...CORS },
    });
}
