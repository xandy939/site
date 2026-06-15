// =============================================================================
// admin.js — painel de administração de reservas
// Acessível só ao email do dono (definido em app_settings.owner_email).
// =============================================================================

(() => {
    const SUPABASE_URL      = "https://mfrmkkdqmlfuswggqbra.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mcm1ra2RxbWxmdXN3Z2dxYnJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjM5NDYsImV4cCI6MjA5NDgzOTk0Nn0.T-niRyVa8D8RjXOgKqENbwNoVQFJ95cpfaH--LyfrOE";

    // Mapa de país → bandeira emoji (apenas os mais comuns na Algarve)
    const FLAGS = {
        PT: "🇵🇹", ES: "🇪🇸", FR: "🇫🇷", DE: "🇩🇪", GB: "🇬🇧", UK: "🇬🇧",
        IE: "🇮🇪", NL: "🇳🇱", BE: "🇧🇪", IT: "🇮🇹", CH: "🇨🇭", AT: "🇦🇹",
        SE: "🇸🇪", NO: "🇳🇴", DK: "🇩🇰", FI: "🇫🇮", PL: "🇵🇱", CZ: "🇨🇿",
        US: "🇺🇸", CA: "🇨🇦", BR: "🇧🇷", AU: "🇦🇺", IL: "🇮🇱", LU: "🇱🇺",
    };
    const COUNTRY_NAMES = {
        PT: "Portugal", ES: "Espanha", FR: "França", DE: "Alemanha",
        GB: "Reino Unido", UK: "Reino Unido", IE: "Irlanda",
        NL: "Holanda", BE: "Bélgica", IT: "Itália", CH: "Suíça",
        AT: "Áustria", SE: "Suécia", NO: "Noruega", DK: "Dinamarca",
        FI: "Finlândia", PL: "Polónia", CZ: "Chéquia", US: "EUA",
        CA: "Canadá", BR: "Brasil", AU: "Austrália", IL: "Israel", LU: "Luxemburgo",
    };

    let sb, filtroAtual = "pending", reservasCache = [];

    document.addEventListener("DOMContentLoaded", async () => {
        sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        const { data: { session } } = await sb.auth.getSession();
        if (!session) return mostrarBloqueado();

        const { data: ehDono, error } = await sb.rpc("is_owner");
        if (error || !ehDono) return mostrarBloqueado();

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
        await carregarClientes();
        await carregarPrecos();

        // ---- Filtro de apartamento na tabela de preços ----
        const seletorApt = document.getElementById("filtro-apt-precos");
        if (seletorApt) seletorApt.addEventListener("change", carregarPrecos);

        // ---- Botão adicionar nova época ----
        const btnAdd = document.getElementById("btn-add-epoca");
        if (btnAdd) btnAdd.addEventListener("click", () => abrirModalEpoca());
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
            pendentes:   reservasCache.filter(r => r.status === "pending").length,
            aPagar:      reservasCache.filter(r => r.status === "awaiting_payment").length,
            confirmadas: reservasCache.filter(r => r.status === "confirmed").length,
            futuras:     reservasCache.filter(r => r.status === "confirmed" && r.check_in >= hoje).length,
            doBooking:   reservasCache.filter(r => r.source === "booking").length,
        };
        document.getElementById("estatisticas").innerHTML = `
            <div class="stat-card"><div class="label">A pagar</div><div class="valor">${stats.aPagar}</div></div>
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
            const hospede = renderHospede(r);
            const datas = `${formatDate(r.check_in)} → ${formatDate(r.check_out)}<br><span style="font-size:11px;color:var(--muted);">${noites(r)} noite(s) · ${r.guests} hóspede(s)</span>`;
            const contacto = renderContacto(r);
            return `
                <tr>
                    <td>${apartamento}</td>
                    <td>${hospede}</td>
                    <td>${datas}</td>
                    <td>${contacto}</td>
                    <td><span class="pill pill-${r.source}">${r.source}</span></td>
                    <td><span class="pill pill-${r.status}">${labelStatus(r.status)}</span></td>
                    <td class="acoes">${botoesAcao(r)}</td>
                </tr>
            `;
        }).join("");

        tbody.querySelectorAll("[data-acao]").forEach(b => {
            b.addEventListener("click", () => executarAcao(b.dataset.id, b.dataset.acao));
        });
    }

    function renderHospede(r) {
        const generico = !r.guest_name || r.guest_name === "Booking.com" || r.guest_name === "CLOSED - Not available";
        const flag = r.nationality ? (FLAGS[r.nationality.toUpperCase()] || "") : "";
        const country = r.nationality ? (COUNTRY_NAMES[r.nationality.toUpperCase()] || r.nationality) : "";
        const subtitulo = country ? `<span style="font-size:11px; color:var(--muted);">${flag} ${esc(country)}</span>` : "";

        if (generico && r.source === "booking") {
            return `
                <span style="color:var(--muted); font-style:italic;">Booking.com</span>
                ${subtitulo ? `<br>${subtitulo}` : ""}
            `;
        }
        return `<strong>${esc(r.guest_name)}</strong>${subtitulo ? `<br>${subtitulo}` : ""}`;
    }

    function renderContacto(r) {
        const generico = r.guest_email === "noreply@booking.com";
        if (generico) {
            return `<span style="color:var(--muted); font-size:12px;">via Booking Extranet</span>`;
        }
        return `${esc(r.guest_email)}<br><span style="font-size:11px; color:var(--muted);">${esc(r.guest_phone || "")}</span>`;
    }

    function botoesAcao(r) {
        const editar = `<button class="btn-acao" style="background: var(--cream-warm); color: var(--ink-soft);" data-id="${r.id}" data-acao="editar">Editar</button>`;
        if (r.status === "pending") {
            return `
                <button class="btn-acao btn-confirmar" data-id="${r.id}" data-acao="confirmar">Confirmar</button>
                <button class="btn-acao btn-cancelar"  data-id="${r.id}" data-acao="cancelar">Recusar</button>
                ${editar}
            `;
        }
        if (r.status === "confirmed") {
            return `${editar}<button class="btn-acao btn-cancelar" data-id="${r.id}" data-acao="cancelar">Cancelar</button>`;
        }
        if (r.status === "awaiting_payment") {
            const isIban = r.payment_method === "iban";
            if (isIban) {
                const shortRef = "TR-" + (r.id || "").replace(/-/g, "").slice(0, 8).toUpperCase();
                return `
                    <button class="btn-acao btn-confirmar" data-id="${r.id}" data-acao="confirmar" title="Quando vires a transferência no banco com a referência ${shortRef}">Confirmar pagamento</button>
                    <button class="btn-acao btn-cancelar"  data-id="${r.id}" data-acao="cancelar">Cancelar</button>
                    ${editar}
                `;
            }
            return `<span style="color: var(--muted); font-size: 11px;">A aguardar pagamento</span>`;
        }
        return `<span style="color: var(--muted);">—</span>`;
    }

    async function executarAcao(id, acao) {
        if (acao === "editar") return abrirModalEdicao(id);
        const novoStatus = acao === "confirmar" ? "confirmed" : "cancelled";
        if (acao === "cancelar" && !confirm("Cancelar esta reserva? (Se foi paga, terás de fazer o reembolso manualmente.)")) return;
        if (acao === "confirmar") {
            const r = reservasCache.find(x => x.id === id);
            if (r?.payment_method === "iban" && !confirm("Confirmas que recebeste a transferência bancária no extracto? O hóspede vai receber email a dizer que a reserva está garantida.")) return;
        }

        const { error } = await sb.from("reservations").update({ status: novoStatus }).eq("id", id);
        if (error) {
            if (error.code === "23P01") alert("Não é possível confirmar: as datas chocam com outra reserva já confirmada.");
            else alert("Erro: " + error.message);
            return;
        }
        await carregarReservas();
    }

    // ---- MODAL DE EDIÇÃO ---------------------------------------------------
    function abrirModalEdicao(id) {
        const r = reservasCache.find(x => x.id === id);
        if (!r) return;

        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.style.cssText = `
            position: fixed; inset: 0; background: rgba(14,23,41,0.55);
            display: flex; align-items: center; justify-content: center;
            z-index: 100; padding: 20px;
        `;
        overlay.innerHTML = `
            <div style="background: var(--white); border-radius: var(--radius-lg); max-width: 520px; width: 100%; box-shadow: var(--sh-3);">
                <div style="padding: var(--s-5) var(--s-6); border-bottom: 1px solid var(--line-soft);">
                    <h3 style="font-family: var(--font-serif); font-size: 22px; color: var(--navy); font-weight: 600;">Editar reserva</h3>
                    <p style="font-size: 12.5px; color: var(--muted); margin-top: 4px;">${esc(r.apartments?.name || r.apartment_id)} · ${formatDate(r.check_in)} → ${formatDate(r.check_out)}</p>
                </div>
                <form id="edit-form" style="padding: var(--s-5) var(--s-6);">
                    <div class="field">
                        <label>Nome do hóspede</label>
                        <input type="text" name="guest_name" value="${escAttr(r.guest_name === 'CLOSED - Not available' ? '' : (r.guest_name || ''))}" placeholder="Ex: João Silva">
                    </div>
                    <div class="field">
                        <label>País / Nacionalidade <span style="font-weight:400; color:var(--muted); text-transform:none; letter-spacing:0;">(código ISO 2 letras: PT, ES, FR, DE, GB...)</span></label>
                        <input type="text" name="nationality" value="${escAttr(r.nationality || '')}" placeholder="PT" maxlength="2" style="text-transform: uppercase;">
                    </div>
                    <div class="field-row">
                        <div class="field">
                            <label>Email</label>
                            <input type="email" name="guest_email" value="${escAttr(r.guest_email === 'noreply@booking.com' ? '' : (r.guest_email || ''))}" placeholder="email@dominio.com">
                        </div>
                        <div class="field">
                            <label>Telefone</label>
                            <input type="tel" name="guest_phone" value="${escAttr(r.guest_phone || '')}" placeholder="+351 9xx xxx xxx">
                        </div>
                    </div>
                    <div class="field">
                        <label>Notas internas</label>
                        <input type="text" name="notes" value="${escAttr(r.notes || '')}" placeholder="Ex: chega tarde, traz cão, etc.">
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: var(--s-4); justify-content: flex-end;">
                        <button type="button" id="cancelar-edicao" class="btn btn-ghost btn-sm">Cancelar</button>
                        <button type="submit" class="btn btn-primary btn-sm">Guardar</button>
                    </div>
                </form>
            </div>
        `;
        document.body.appendChild(overlay);

        const fechar = () => overlay.remove();
        overlay.addEventListener("click", e => { if (e.target === overlay) fechar(); });
        overlay.querySelector("#cancelar-edicao").addEventListener("click", fechar);

        overlay.querySelector("#edit-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            const patch = {
                guest_name:  fd.get("guest_name")?.toString().trim() || null,
                nationality: fd.get("nationality")?.toString().trim().toUpperCase() || null,
                guest_email: fd.get("guest_email")?.toString().trim() || null,
                guest_phone: fd.get("guest_phone")?.toString().trim() || null,
                notes:       fd.get("notes")?.toString().trim() || null,
            };

            const { error } = await sb.from("reservations").update(patch).eq("id", id);
            if (error) { alert("Erro: " + error.message); return; }
            fechar();
            await carregarReservas();
        });
    }

    // ============================================================
    // CLIENTES — agregação de reservas por email
    // ============================================================
    async function carregarClientes() {
        const tbody = document.getElementById("lista-clientes");
        if (!tbody) return;

        const { data, error } = await sb
            .from("reservations")
            .select("guest_name, guest_email, guest_phone, check_in, check_out, status, apartment_id, created_at, id, apartments(name)")
            .neq("source", "booking")
            .order("created_at", { ascending: false });

        if (error) {
            tbody.innerHTML = `<tr><td colspan="6" class="vazio">Erro: ${esc(error.message)}</td></tr>`;
            return;
        }

        const porEmail = new Map();
        for (const r of data || []) {
            if (!r.guest_email) continue;
            const key = r.guest_email.toLowerCase();
            if (!porEmail.has(key)) porEmail.set(key, { email: r.guest_email, name: r.guest_name, phone: r.guest_phone, reservas: [] });
            const c = porEmail.get(key);
            c.reservas.push(r);
            if (r.guest_name && !c.name) c.name = r.guest_name;
            if (r.guest_phone && !c.phone) c.phone = r.guest_phone;
        }

        const clientes = [...porEmail.values()].sort((a, b) => (b.reservas[0]?.created_at || "").localeCompare(a.reservas[0]?.created_at || ""));

        if (clientes.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="vazio">Ainda sem clientes do site.</td></tr>`;
            return;
        }

        tbody.innerHTML = clientes.map(c => {
            const ultima = c.reservas[0];
            return `
                <tr>
                    <td><strong>${esc(c.name || "—")}</strong></td>
                    <td><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></td>
                    <td>${esc(c.phone || "—")}</td>
                    <td>${c.reservas.length}</td>
                    <td>${formatDate(ultima.check_in)} → ${formatDate(ultima.check_out)}</td>
                    <td>
                        <button class="btn-acao" data-acao="ver" data-email="${escAttr(c.email)}" style="background:var(--cream-warm); color:var(--ink-soft);">Ver reservas</button>
                        <button class="btn-acao btn-cancelar" data-acao="apagar" data-email="${escAttr(c.email)}" title="Apagar conta deste cliente">Apagar conta</button>
                    </td>
                </tr>
            `;
        }).join("");

        tbody.querySelectorAll("button[data-acao]").forEach(b => {
            b.addEventListener("click", () => {
                const email = b.dataset.email;
                const cli = clientes.find(c => c.email.toLowerCase() === email.toLowerCase());
                if (b.dataset.acao === "ver") abrirReservasCliente(email, cli);
                else if (b.dataset.acao === "apagar") apagarConta(email);
            });
        });
    }

    async function apagarConta(email) {
        if (!confirm(`Apagar TUDO de ${email}?\n\n• Conta de utilizador (se existir) → eliminada\n• Todas as reservas com este email → eliminadas\n\nEsta acção é irreversível.`)) return;
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return alert("Sessão expirou. Faz login outra vez.");

        const resp = await fetch("https://mfrmkkdqmlfuswggqbra.supabase.co/functions/v1/delete-user-account", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
            body: JSON.stringify({ email }),
        });
        const r = await resp.json();
        if (!resp.ok) return alert("Erro: " + (r.error || resp.status));
        const partes = [];
        if (r.had_account) partes.push("conta de utilizador");
        if (r.deleted_reservations > 0) partes.push(`${r.deleted_reservations} reserva(s)`);
        alert(partes.length ? `Apagado: ${partes.join(" + ")}.` : "Nada para apagar.");
        await carregarClientes();
    }

    function abrirReservasCliente(email, cliente) {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed; inset:0; background:rgba(14,23,41,0.55); display:flex; align-items:center; justify-content:center; z-index:100; padding:20px;";
        const linhas = cliente.reservas.map(r => `
            <tr>
                <td>${esc(r.apartments?.name || r.apartment_id)}</td>
                <td>${formatDate(r.check_in)} → ${formatDate(r.check_out)}</td>
                <td><span class="pill pill-${r.status}">${labelStatus(r.status)}</span></td>
            </tr>
        `).join("");
        overlay.innerHTML = `
            <div style="background:var(--white); border-radius: var(--radius-lg); max-width:640px; width:100%; box-shadow: var(--sh-3); max-height:80vh; overflow:auto;">
                <div style="padding: var(--s-5) var(--s-6); border-bottom:1px solid var(--line-soft);">
                    <h3 style="font-family: var(--font-serif); font-size:22px; color:var(--navy); font-weight:600;">Reservas de ${esc(cliente.name || cliente.email)}</h3>
                    <p style="font-size:12.5px; color:var(--muted); margin-top:4px;">${esc(email)} · ${esc(cliente.phone || "sem telefone")}</p>
                </div>
                <div style="padding: var(--s-4) var(--s-6);">
                    <table class="admin-table">
                        <thead><tr><th>Apartamento</th><th>Datas</th><th>Estado</th></tr></thead>
                        <tbody>${linhas}</tbody>
                    </table>
                </div>
                <div style="padding: var(--s-3) var(--s-6) var(--s-5); text-align:right;">
                    <button id="fechar-cliente" class="btn btn-ghost btn-sm">Fechar</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const fechar = () => overlay.remove();
        overlay.addEventListener("click", e => { if (e.target === overlay) fechar(); });
        overlay.querySelector("#fechar-cliente").addEventListener("click", fechar);
    }

    // ============================================================
    // GESTÃO DE PREÇOS — pricing_seasons
    // ============================================================
    async function carregarPrecos() {
        const apt = document.getElementById("filtro-apt-precos")?.value || "litoral-mar";
        const tbody = document.getElementById("lista-precos");
        if (!tbody) return;

        const { data, error } = await sb
            .from("pricing_seasons")
            .select("*")
            .eq("apartment_id", apt)
            .order("start_date", { ascending: true });

        if (error) {
            tbody.innerHTML = `<tr><td colspan="5" class="vazio">Erro: ${esc(error.message)}</td></tr>`;
            return;
        }

        if (!data || data.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="vazio">Sem épocas definidas para este apartamento. Usa o preço base.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(s => `
            <tr>
                <td><strong>${esc(s.name)}</strong></td>
                <td>${formatDate(s.start_date)}</td>
                <td>${formatDate(s.end_date)}</td>
                <td style="font-weight:600; color:var(--navy);">€ ${(s.price_per_night_cents/100).toFixed(2)}</td>
                <td class="acoes">
                    <button class="btn-acao" data-id="${s.id}" data-acao="editar-epoca" style="background:var(--cream-warm); color:var(--ink-soft);">Editar</button>
                    <button class="btn-acao btn-cancelar" data-id="${s.id}" data-acao="apagar-epoca">Apagar</button>
                </td>
            </tr>
        `).join("");

        tbody.querySelectorAll("[data-acao]").forEach(b => {
            b.addEventListener("click", () => {
                const id = b.dataset.id;
                const acao = b.dataset.acao;
                if (acao === "editar-epoca") abrirModalEpoca(data.find(x => x.id == id));
                else if (acao === "apagar-epoca") apagarEpoca(id);
            });
        });
    }

    function abrirModalEpoca(season) {
        const apt = season?.apartment_id || document.getElementById("filtro-apt-precos")?.value || "litoral-mar";
        const aptNome = apt === "paraiso-do-sol" ? "Paraíso do Sol" : "Litoral Mar";
        const isEdit = !!season;
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed; inset:0; background:rgba(14,23,41,0.55); display:flex; align-items:center; justify-content:center; z-index:100; padding:20px;";
        overlay.innerHTML = `
            <div style="background:var(--white); border-radius: var(--radius-lg); max-width:480px; width:100%; box-shadow: var(--sh-3);">
                <div style="padding: var(--s-5) var(--s-6); border-bottom:1px solid var(--line-soft);">
                    <h3 style="font-family: var(--font-serif); font-size:22px; color:var(--navy); font-weight:600;">${isEdit ? 'Editar época' : 'Nova época'}</h3>
                    <p style="font-size:12.5px; color:var(--muted); margin-top:4px;">Apartamento: <strong style="color:var(--navy);">${esc(aptNome)}</strong></p>
                </div>
                <form id="form-epoca" style="padding: var(--s-5) var(--s-6);">
                    <div class="field">
                        <label>Nome da época</label>
                        <input type="text" name="name" placeholder="Ex: Julho 1-15" value="${escAttr(season?.name || '')}" required>
                    </div>
                    <div class="field-row">
                        <div class="field">
                            <label>Início</label>
                            <input type="date" name="start_date" value="${season?.start_date || ''}" required>
                        </div>
                        <div class="field">
                            <label>Fim</label>
                            <input type="date" name="end_date" value="${season?.end_date || ''}" required>
                        </div>
                    </div>
                    <div class="field">
                        <label>Preço por noite (€)</label>
                        <input type="number" name="price" step="1" min="1" placeholder="125" value="${season ? (season.price_per_night_cents/100).toFixed(0) : ''}" required>
                    </div>
                    <div style="display:flex; gap:8px; margin-top: var(--s-4); justify-content:flex-end;">
                        <button type="button" id="cancelar-epoca" class="btn btn-ghost btn-sm">Cancelar</button>
                        <button type="submit" class="btn btn-primary btn-sm">Guardar</button>
                    </div>
                </form>
            </div>
        `;
        document.body.appendChild(overlay);

        const fechar = () => overlay.remove();
        overlay.addEventListener("click", e => { if (e.target === overlay) fechar(); });
        overlay.querySelector("#cancelar-epoca").addEventListener("click", fechar);

        overlay.querySelector("#form-epoca").addEventListener("submit", async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            const payload = {
                apartment_id: apt,
                name: fd.get("name").toString().trim(),
                start_date: fd.get("start_date"),
                end_date: fd.get("end_date"),
                price_per_night_cents: Math.round(parseFloat(fd.get("price")) * 100),
            };
            const { error } = isEdit
                ? await sb.from("pricing_seasons").update(payload).eq("id", season.id)
                : await sb.from("pricing_seasons").insert(payload);
            if (error) { alert("Erro: " + error.message); return; }
            fechar();
            await carregarPrecos();
        });
    }

    async function apagarEpoca(id) {
        if (!confirm("Apagar esta época? As datas dentro dela voltam a usar o preço base.")) return;
        const { error } = await sb.from("pricing_seasons").delete().eq("id", id);
        if (error) { alert("Erro: " + error.message); return; }
        await carregarPrecos();
    }

    // ---- Helpers -----------------------------------------------------------
    function esc(s) {
        return (s ?? "").toString()
            .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }
    function escAttr(s) { return esc(s); }
    function formatDate(s) {
        const [y, m, d] = s.split("-");
        return `${d}/${m}/${y}`;
    }
    function noites(r) {
        const a = new Date(r.check_in), b = new Date(r.check_out);
        return Math.round((b - a) / (1000 * 60 * 60 * 24));
    }
    function labelStatus(s) {
        return {
            pending: "Pendente",
            awaiting_payment: "A pagar",
            confirmed: "Confirmada",
            cancelled: "Cancelada",
        }[s] || s;
    }
})();
