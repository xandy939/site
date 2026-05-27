// =============================================================================
// reservations.js — calendário + formulário + Stripe Checkout
// Carregado por apartamento-rocha.html e apartamento-amarilis.html.
// =============================================================================

(() => {
    const SUPABASE_URL      = "https://mfrmkkdqmlfuswggqbra.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mcm1ra2RxbWxmdXN3Z2dxYnJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjM5NDYsImV4cCI6MjA5NDgzOTk0Nn0.T-niRyVa8D8RjXOgKqENbwNoVQFJ95cpfaH--LyfrOE";
    const CHECKOUT_URL      = SUPABASE_URL + "/functions/v1/create-checkout";

    document.addEventListener("DOMContentLoaded", async () => {
        const caixa = document.querySelector("[data-apartment-id]");
        if (!caixa) return;
        if (typeof Litepicker === "undefined" || !window.supabase) {
            console.warn("Litepicker ou supabase-js não disponíveis.");
            return;
        }

        const apartmentId = caixa.dataset.apartmentId;
        const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        const inputDatas   = document.getElementById("datas-reserva");
        const inputNome    = document.getElementById("nome-hospede");
        const inputEmail   = document.getElementById("email-hospede");
        const inputTel     = document.getElementById("tel-hospede");
        const selHospedes  = document.getElementById("hospedes");
        const form         = document.getElementById("form-reserva");
        const btn          = form.querySelector("button[type=submit]");
        const msg          = document.getElementById("msg-reserva");

        // ---- 1. Buscar preço do apartamento + disponibilidade -------------
        const [aptInfo, blockedNights] = await Promise.all([
            loadApartment(sb, apartmentId),
            loadBlockedNights(sb, apartmentId),
        ]);
        const pricePerNight = aptInfo?.price_per_night_cents ?? 0;

        // Apartamento inactivo (ex: Paraíso do Sol) — bloqueia o submit
        if (aptInfo && aptInfo.active === false) {
            const msg = document.getElementById("msg-reserva");
            msg.className = "msg-reserva show aviso";
            msg.textContent = "Este apartamento ainda não está aberto a reservas. Volta brevemente.";
            btn.disabled = true;
            btn.textContent = "Indisponível";
            // não impede de ver o calendário, mas o submit fica bloqueado
            form.addEventListener("submit", (e) => e.preventDefault(), true);
        }

        // ---- 2. Inicializar Litepicker ------------------------------------
        const picker = new Litepicker({
            element: inputDatas,
            singleMode: false,
            numberOfMonths: window.matchMedia("(max-width: 700px)").matches ? 1 : 2,
            numberOfColumns: window.matchMedia("(max-width: 700px)").matches ? 1 : 2,
            minDate: new Date(),
            minDays: 2,
            tooltipText: { one: "noite", other: "noites" },
            tooltipNumber: (n) => Math.max(0, n - 1),
            format: "YYYY-MM-DD",
            lang: "pt-PT",
            lockDaysFilter: (day1, _day2, pickedDates) => {
                const key = day1.format("YYYY-MM-DD");
                if (!pickedDates || pickedDates.length === 0) {
                    return blockedNights.has(key);
                }
                if (pickedDates.length === 1) {
                    const checkIn = pickedDates[0];
                    if (day1.toJSDate() <= checkIn.toJSDate()) return true;
                    const cursor = new Date(checkIn.toJSDate());
                    const target = day1.toJSDate();
                    while (cursor < target) {
                        if (blockedNights.has(isoDate(cursor))) return true;
                        cursor.setDate(cursor.getDate() + 1);
                    }
                }
                return false;
            },
            setup: (picker) => {
                picker.on("selected", () => atualizarPrecoVisual(picker, pricePerNight));
            },
        });

        // ---- 3. Pré-preencher com dados do utilizador ---------------------
        const { data: { session } } = await sb.auth.getSession();
        if (session && session.user) {
            inputEmail.value = session.user.email || "";
            try {
                const { data: profile } = await sb
                    .from("profiles")
                    .select("nome, telefone")
                    .eq("id", session.user.id)
                    .single();
                if (profile?.nome)     inputNome.value = profile.nome;
                if (profile?.telefone) inputTel.value  = profile.telefone;
            } catch (_) { /* sem profile, ignora */ }
        }

        // ---- 4. Submissão → Stripe Checkout -------------------------------
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            showMsg(null);

            const range = picker.getStartDate() && picker.getEndDate()
                ? { start: picker.getStartDate(), end: picker.getEndDate() }
                : null;

            if (!range) {
                showMsg("erro", "Escolhe as datas de check-in e check-out.");
                return;
            }
            if (!inputNome.value.trim() || !inputEmail.value.trim()) {
                showMsg("erro", "Preenche o nome e o email.");
                return;
            }

            btn.disabled = true;
            btn.textContent = "A processar...";

            // Buscar token de sessão (opcional)
            const { data: { session: liveSession } } = await sb.auth.getSession();
            const authHeader = liveSession
                ? { Authorization: "Bearer " + liveSession.access_token }
                : {};

            const payload = {
                apartment_id: apartmentId,
                guest_name:   inputNome.value.trim(),
                guest_email:  inputEmail.value.trim(),
                guest_phone:  inputTel.value.trim() || null,
                guests:       parseInt(selHospedes.value, 10),
                check_in:     range.start.format("YYYY-MM-DD"),
                check_out:    range.end.format("YYYY-MM-DD"),
            };

            try {
                const resp = await fetch(CHECKOUT_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", ...authHeader },
                    body: JSON.stringify(payload),
                });
                const data = await resp.json();

                if (!resp.ok) {
                    if (data.overlap) {
                        showMsg("erro", "Estas datas já foram reservadas. Recarrega a página e escolhe outras.");
                    } else {
                        showMsg("erro", data.error || "Erro inesperado a criar a sessão de pagamento.");
                    }
                    btn.disabled = false;
                    btn.textContent = "Reservar e Pagar";
                    return;
                }

                // Redirect para Stripe Checkout
                location.href = data.checkout_url;
            } catch (err) {
                console.error(err);
                showMsg("erro", "Erro de ligação. Tenta novamente.");
                btn.disabled = false;
                btn.textContent = "Reservar e Pagar";
            }
        });

        function showMsg(tipo, texto) {
            msg.className = "msg-reserva";
            if (!tipo) { msg.textContent = ""; return; }
            msg.classList.add("show", tipo);
            msg.textContent = texto;
        }
    });

    // ---- Preço dinâmico ----------------------------------------------------

    function atualizarPrecoVisual(picker, pricePerNight) {
        const el = document.getElementById("preco-total");
        if (!el) return;
        const s = picker.getStartDate();
        const e = picker.getEndDate();
        if (!s || !e) { el.style.display = "none"; return; }
        const nights = Math.round((e.toJSDate() - s.toJSDate()) / 86400000);
        if (nights < 1) { el.style.display = "none"; return; }
        const total = (pricePerNight * nights) / 100;
        const noite = (pricePerNight / 100).toFixed(2);
        el.style.display = "block";
        el.innerHTML = `
            <div style="display:flex; justify-content:space-between; font-size:13.5px; color:#475569;">
                <span>€ ${noite} × ${nights} noite(s)</span>
                <span>€ ${total.toFixed(2)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:8px; padding-top:8px; border-top:1px solid #e2e8f0; font-weight:800; color:#1a365d; font-size:16px;">
                <span>Total</span>
                <span>€ ${total.toFixed(2)}</span>
            </div>
        `;
    }

    // ---- Helpers -----------------------------------------------------------

    async function loadApartment(sb, apartmentId) {
        const { data } = await sb
            .from("apartments")
            .select("id, name, price_per_night_cents, active")
            .eq("id", apartmentId)
            .single();
        return data;
    }

    async function loadBlockedNights(sb, apartmentId) {
        const today = isoDate(new Date());
        const { data, error } = await sb
            .from("availability")
            .select("check_in, check_out")
            .eq("apartment_id", apartmentId)
            .gte("check_out", today);

        if (error) {
            console.warn("Falha a carregar disponibilidade:", error.message);
            return new Set();
        }

        const set = new Set();
        for (const row of data || []) {
            const start = new Date(row.check_in + "T00:00:00");
            const end   = new Date(row.check_out + "T00:00:00");
            for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
                set.add(isoDate(d));
            }
        }
        return set;
    }

    function isoDate(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
    }
})();
