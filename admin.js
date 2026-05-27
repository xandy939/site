// =============================================================================
// admin.js — painel de administração de reservas
// Acessível só ao email do dono (definido em app_settings.owner_email).
// RLS na BD garante que utilizadores normais não veem reservas que não sejam suas.
// =============================================================================

(() => {
    const SUPABASE_URL      = "https://mfrmkkdqmlfuswggqbra.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mcm1ra2RxbWxmdXN3Z2dxYnJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjM5NDYsImV4cCI6MjA5NDgzOTk0Nn0.T-niRyVa8D8RjXOgKqENbwNoVQFJ95cpfaH--LyfrOE";

    let sb, filtroAtual = "pending", reservasCache = [];

    document.addEventListener("DOMContentLoaded", async () => {
        sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        const { data: { session } } = await sb.auth.getSession();
        if (!session) {
            return mostrarBloqueado();
        }

        // Verifica se este utilizador é dono — chama a função is_owner() na BD
        const { data: ehDono, error } = await sb.rpc("is_owner");
        if (error || !ehDono) {
            return mostrarBloqueado();
        }

        document.getElementById("zona-protegida").style.display = "block";

        document.querySelectorAll(".filtro-btn").forEach(b => {
            b.addEventListener("click", () => {
                document.querySelector(".filtro-btn.active")?.classList.remove("active");
                b.classList.add("active");
                filtroAtual = b.dataset.filtro;
                renderizar();
            });
        });

        await carregarReservas();
    });

    function mostrarBloqueado() {
        document.getElementById("zona-bloqueada").style.display = "block";
    }

    async function carregarReservas() {
        const { data, error } = await sb
            .from("reservations")
            .select("*, apartments(name)")
            .order("check_in", { ascending: true });

        if (error) {
            document.getElementById("lista-reservas").innerHTML =
                `<tr><td colspan="7" class="vazio">Erro ao carregar: ${esc(error.message)}</td></tr>`;
            return;
        }
        reservasCache = data || [];
        atualizarEstatisticas();
        renderizar();
    }

    function atualizarEstatisticas() {
        const hoje = new Date().toISOString().slice(0, 10);
        const stats = {
            pendentes: reservasCache.filter(r => r.status === "pending").length,
            confirmadas: reservasCache.filter(r => r.status === "confirmed").length,
            futuras: reservasCache.filter(r => r.status === "confirmed" && r.check_in >= hoje).length,
            doBooking: reservasCache.filter(r => r.source === "booking").length,
        };
        document.getElementById("estatisticas").innerHTML = `
            <div class="stat-card"><div class="label">Pendentes</div><div class="valor">${stats.pendentes}</div></div>
            <div class="stat-card"><div class="label">Confirmadas</div><div class="valor">${stats.confirmadas}</div></div>
            <div class="stat-card"><div class="label">Estadias futuras</div><div class="valor">${stats.futuras}</div></div>
            <div class="stat-card"><div class="label">Do Booking.com</div><div class="valor">${stats.doBooking}</div></div>
        `;
    }

    function renderizar() {
        const tbody = document.getElementById("lista-reservas");
        const lista = filtroAtual === "todas"
            ? reservasCache
            : reservasCache.filter(r => r.status === filtroAtual);

        if (lista.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="vazio">Sem reservas neste filtro.</td></tr>`;
            return;
        }

        tbody.innerHTML = lista.map(r => {
            const apartamento = esc(r.apartments?.name || r.apartment_id);
            const datas = `${formatDate(r.check_in)} → ${formatDate(r.check_out)}<br><span style="font-size:11px;color:#94a3b8;">${noites(r)} noite(s) · ${r.guests} hóspede(s)</span>`;
            const contacto = `${esc(r.guest_email)}<br>${esc(r.guest_phone || "")}`;
            const acoes = botoesAcao(r);
            return `
                <tr>
                    <td>${apartamento}</td>
                    <td><strong>${esc(r.guest_name)}</strong></td>
                    <td>${datas}</td>
                    <td>${contacto}</td>
                    <td><span class="pill pill-${r.source}">${r.source}</span></td>
                    <td><span class="pill pill-${r.status}">${r.status}</span></td>
                    <td class="acoes">${acoes}</td>
                </tr>
            `;
        }).join("");

        tbody.querySelectorAll("[data-acao]").forEach(b => {
            b.addEventListener("click", () => executarAcao(b.dataset.id, b.dataset.acao));
        });
    }

    function botoesAcao(r) {
        if (r.status === "pending") {
            return `
                <button class="btn-acao btn-confirmar" data-id="${r.id}" data-acao="confirmar">Confirmar</button>
                <button class="btn-acao btn-cancelar"  data-id="${r.id}" data-acao="cancelar">Recusar</button>
            `;
        }
        if (r.status === "confirmed" && r.source !== "booking") {
            return `<button class="btn-acao btn-cancelar" data-id="${r.id}" data-acao="cancelar">Cancelar</button>`;
        }
        return `<span style="color:#cbd5e1; font-size:12px;">—</span>`;
    }

    async function executarAcao(id, acao) {
        const novoStatus = acao === "confirmar" ? "confirmed" : "cancelled";
        if (acao === "cancelar" && !confirm("Cancelar esta reserva?")) return;

        const { error } = await sb
            .from("reservations")
            .update({ status: novoStatus })
            .eq("id", id);

        if (error) {
            if (error.code === "23P01") {
                alert("Não é possível confirmar: as datas chocam com outra reserva já confirmada.");
            } else {
                alert("Erro: " + error.message);
            }
            return;
        }
        await carregarReservas();
    }

    // helpers
    function esc(s) {
        return (s ?? "").toString()
            .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }
    function formatDate(s) {
        const [y, m, d] = s.split("-");
        return `${d}/${m}/${y}`;
    }
    function noites(r) {
        const a = new Date(r.check_in), b = new Date(r.check_out);
        return Math.round((b - a) / (1000 * 60 * 60 * 24));
    }
})();
