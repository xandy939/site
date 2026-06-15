// =============================================================================
// reservations.js — calendário + formulário + Stripe Checkout
// Carregado por litoralmar.html e paraisosoldarocha.html.
// =============================================================================

(() => {
    // ============================================
    // Dados bancários por apartamento — para transferências IBAN
    // (edita aqui se mudares de banco/conta)
    // ============================================
    const BANK_INFO = {
        "litoral-mar": {
            iban: "PT50 0269 0168 0020 0794 6527 5",
            name: "TudoParaRegistar, LDA",
            bank: "Bankinter",
        },
        "paraiso-do-sol": {
            iban: "PT50 0269 0391 0020 5997 3161 5",
            name: "Luis Santana",
            bank: "Bankinter",
        },
    };

    // URLs do anúncio Booking.com (link "Reservar via Booking")
    const BOOKING_URLS = {
        "paraiso-do-sol": "https://www.booking.com/hotel/pt/apartment-starfish-beach.pt-pt.html?aid=304142&label=gen173bo-10CAsouwFCGGFwYXJ0bWVudC1zdGFyZmlzaC1iZWFjaEgzWANouwGIAQGYATO4ARfIAQ_YAQPoAQH4AQGIAgGYAgaoAgG4Ap3Dn9EGwAIB0gIkYjM3MmViMTQtNTMzZC00M2QwLWIwOTUtY2NiMGIwYTkwMDI52AIB4AIB",
    };

    // Desconto aplicado a quem reserva pelo site (vs Booking.com)
    // Põe 0 para desactivar. Aplica-se ao total da reserva.
    const DISCOUNT_PERCENT = 10;
    // ============================================

    const SUPABASE_URL      = "https://mfrmkkdqmlfuswggqbra.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mcm1ra2RxbWxmdXN3Z2dxYnJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjM5NDYsImV4cCI6MjA5NDgzOTk0Nn0.T-niRyVa8D8RjXOgKqENbwNoVQFJ95cpfaH--LyfrOE";
    const URL_MULTIBANCO    = SUPABASE_URL + "/functions/v1/gerar-referencia-mb";
    const URL_IBAN          = SUPABASE_URL + "/functions/v1/gerar-reserva-iban";

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

        // ---- 1. Buscar preço, épocas e disponibilidade --------------------
        const [aptInfo, blockedNights, seasons] = await Promise.all([
            loadApartment(sb, apartmentId),
            loadBlockedNights(sb, apartmentId),
            loadSeasons(sb, apartmentId),
        ]);
        const basePrice = aptInfo?.price_per_night_cents ?? 0;
        const fees = {
            cleaning: aptInfo?.cleaning_fee_cents ?? 0,
            towel:    aptInfo?.towel_fee_cents ?? 0,
            linen:    aptInfo?.linen_fee_cents ?? 0,
            taxPerPerson: aptInfo?.tourist_tax_per_person_cents ?? 0,
        };
        // Função: dado um Date, devolve o preço em cêntimos para essa noite
        const priceFor = (date) => {
            const iso = isoDate(date);
            for (const s of seasons) {
                if (iso >= s.start_date && iso <= s.end_date) return s.price_per_night_cents;
            }
            return basePrice;
        };

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
                picker.on("selected", () => atualizarPrecoVisual(picker, priceFor, fees, parseInt(selHospedes.value, 10)));
                picker.on("show", () => {
                    decorarDiasComPreco(blockedNights, priceFor);
                    iniciarObservadorPrecos(blockedNights, priceFor);
                });
            },
        });

        // Recalcular total quando muda o nº de hóspedes (imposto por pessoa)
        selHospedes.addEventListener("change", () => {
            atualizarPrecoVisual(picker, priceFor, fees, parseInt(selHospedes.value, 10));
        });

        // ---- 3. Pré-preencher com dados do utilizador + exigir login ------
        const { data: { session } } = await sb.auth.getSession();
        const isLogged = !!(session && session.user);

        if (isLogged) {
            inputEmail.value = session.user.email || "";
            try {
                const { data: profile } = await sb
                    .from("profiles")
                    .select("first_name, last_name, phone")
                    .eq("id", session.user.id)
                    .single();
                if (profile) {
                    const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
                    if (fullName)        inputNome.value = fullName;
                    if (profile.phone)   inputTel.value  = profile.phone;
                }
            } catch (_) { /* sem profile, ignora */ }
        } else {
            // Sem sessão — força login antes de reservar
            btn.textContent = "Iniciar sessão para reservar";
            // Aviso visível
            const aviso = document.createElement("div");
            aviso.className = "alert aviso show";
            aviso.style.marginBottom = "var(--s-3)";
            aviso.innerHTML = `🔒 Tens de <a href="login.html?next=${encodeURIComponent(location.pathname)}" style="color:inherit; text-decoration:underline; font-weight:600;">iniciar sessão</a> ou <a href="registar.html?next=${encodeURIComponent(location.pathname)}" style="color:inherit; text-decoration:underline; font-weight:600;">criar conta</a> para reservar.`;
            form.insertBefore(aviso, form.firstChild);
        }

        // ---- 4. Injectar selector de método de pagamento ------------------
        // Paraíso do Sol: só IBAN (sem Multibanco) + aviso sobre faturas via Booking
        // Outros: Multibanco + IBAN
        const seletorPagamento = document.createElement("div");
        seletorPagamento.className = "metodo-pagamento";
        seletorPagamento.style.cssText = "margin: var(--s-3) 0;";
        if (apartmentId === "paraiso-do-sol") {
            const bookingUrl = BOOKING_URLS[apartmentId];
            seletorPagamento.innerHTML = `
                <div style="font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; margin-bottom: var(--s-2);">Pagamento</div>
                <label style="display:flex; align-items:flex-start; gap:10px; padding:12px; border:1px solid var(--line-soft); border-radius:8px; cursor:pointer;">
                    <input type="radio" name="metodo-pagamento" value="iban" checked style="margin-top:3px;">
                    <div>
                        <div style="font-weight:600; color:var(--navy);">Transferência bancária (IBAN)</div>
                        <div style="font-size:12.5px; color:var(--muted);">Recebes IBAN + referência. Confirmação manual após verificarmos o banco (1-2 dias úteis).</div>
                    </div>
                </label>
                <div style="margin-top:10px; padding:10px 12px; background:#f0f7ff; border-left:3px solid var(--atlantic); border-radius:6px; font-size:12.5px; color:var(--navy); line-height:1.5;">
                    📄 Se necessitar de fatura, por favor reserve através do <a href="${bookingUrl}" target="_blank" rel="noopener" style="color:var(--atlantic); font-weight:600;">Booking.com</a>.
                </div>
            `;
        } else {
            seletorPagamento.innerHTML = `
                <div style="font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; margin-bottom: var(--s-2);">Método de pagamento</div>
                <label style="display:flex; align-items:flex-start; gap:10px; padding:12px; border:1px solid var(--line-soft); border-radius:8px; margin-bottom:8px; cursor:pointer;">
                    <input type="radio" name="metodo-pagamento" value="multibanco" checked style="margin-top:3px;">
                    <div>
                        <div style="font-weight:600; color:var(--navy);">Referência Multibanco</div>
                        <div style="font-size:12.5px; color:var(--muted);">Pagas num ATM ou homebanking. Reserva confirma-se em poucos minutos. Prazo: 3 dias.</div>
                    </div>
                </label>
                <label style="display:flex; align-items:flex-start; gap:10px; padding:12px; border:1px solid var(--line-soft); border-radius:8px; cursor:pointer;">
                    <input type="radio" name="metodo-pagamento" value="iban" style="margin-top:3px;">
                    <div>
                        <div style="font-weight:600; color:var(--navy);">Transferência bancária (IBAN)</div>
                        <div style="font-size:12.5px; color:var(--muted);">Recebes IBAN + referência. Confirmação manual após verificarmos o banco (1-2 dias úteis).</div>
                    </div>
                </label>
            `;
        }
        btn.parentElement.insertBefore(seletorPagamento, btn);

        // ---- 5. Submissão → Multibanco ou IBAN ----------------------------
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            showMsg(null);

            // BLOQUEIO obrigatório: precisa de sessão iniciada
            const { data: { session: liveCheck } } = await sb.auth.getSession();
            if (!liveCheck || !liveCheck.user) {
                const ret = encodeURIComponent(location.pathname + location.search);
                location.href = `login.html?next=${ret}`;
                return;
            }

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

            const banco = BANK_INFO[apartmentId] || Object.values(BANK_INFO)[0];
            const payload = {
                apartment_id: apartmentId,
                guest_name:   inputNome.value.trim(),
                guest_email:  inputEmail.value.trim(),
                guest_phone:  inputTel.value.trim() || null,
                guests:       parseInt(selHospedes.value, 10),
                check_in:     range.start.format("YYYY-MM-DD"),
                check_out:    range.end.format("YYYY-MM-DD"),
                business_iban: banco.iban,
                business_name: banco.name,
                business_bank: banco.bank,
            };

            const metodo = document.querySelector('input[name="metodo-pagamento"]:checked')?.value || "multibanco";
            const endpoint = metodo === "iban" ? URL_IBAN : URL_MULTIBANCO;

            try {
                const resp = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", ...authHeader },
                    body: JSON.stringify(payload),
                });
                const data = await resp.json();

                if (!resp.ok) {
                    if (data.overlap) {
                        showMsg("erro", "Estas datas já foram reservadas. Recarrega a página e escolhe outras.");
                    } else {
                        showMsg("erro", data.error || "Erro inesperado a criar a reserva.");
                    }
                    btn.disabled = false;
                    btn.textContent = "Reservar e Pagar";
                    return;
                }

                if (metodo === "iban") {
                    const params = new URLSearchParams({
                        iban:    data.iban    || "",
                        titular: data.titular || "",
                        banco:   data.banco   || "",
                        valor:   data.valor_eur,
                        ref:     data.short_ref,
                    });
                    location.href = "reserva-iban.html?" + params.toString();
                } else {
                    const params = new URLSearchParams({
                        entidade:   data.entidade,
                        referencia: data.referencia,
                        valor:      data.valor_eur,
                        expira:     data.expira_em,
                    });
                    location.href = "reserva-multibanco.html?" + params.toString();
                }
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

    // ---- Etiqueta de preço em cada dia do calendário -----------------------

    let observador = null;
    function iniciarObservadorPrecos(blockedNights, priceFor) {
        if (observador) return;
        const picker = document.querySelector(".litepicker");
        if (!picker) return;
        observador = new MutationObserver(() => {
            decorarDiasComPreco(blockedNights, priceFor);
        });
        observador.observe(picker, { childList: true, subtree: true });
    }

    function decorarDiasComPreco(blockedNights, priceFor) {
        setTimeout(() => {
            document.querySelectorAll(".litepicker .day-item").forEach(el => {
                if (el.querySelector(".price-tag")) return;
                if (el.classList.contains("is-locked"))  return;
                if (el.classList.contains("is-empty"))   return;
                if (el.classList.contains("is-disabled"))return;

                const ts = parseInt(el.dataset.time, 10);
                if (!ts) return;
                const d = new Date(ts);
                if (d < new Date(new Date().toDateString())) return;

                const key = isoDate(d);
                if (blockedNights.has(key)) return;

                const cents = priceFor(d);
                if (!cents) return;
                const tag = document.createElement("span");
                tag.className = "price-tag";
                tag.textContent = "€" + Math.round(cents / 100);
                el.appendChild(tag);
            });
        }, 0);
    }

    // ---- Preço dinâmico ----------------------------------------------------

    function atualizarPrecoVisual(picker, priceFor, fees, guests) {
        const el = document.getElementById("preco-total");
        if (!el) return;
        const s = picker.getStartDate();
        const e = picker.getEndDate();
        if (!s || !e) { el.style.display = "none"; return; }

        // Iterar pelas noites e somar com o preço de cada uma
        const breakdown = {};
        let accommodationCents = 0;
        let nights = 0;
        const cursor = new Date(s.toJSDate());
        const end    = new Date(e.toJSDate());
        while (cursor < end) {
            const c = priceFor(cursor);
            accommodationCents += c;
            nights++;
            const key = Math.round(c / 100);
            breakdown[key] = (breakdown[key] || 0) + 1;
            cursor.setDate(cursor.getDate() + 1);
        }
        if (nights < 1) { el.style.display = "none"; return; }

        const linhasAloj = Object.entries(breakdown).map(([preco, n]) =>
            `<div class="line"><span>€${preco} × ${n} noite${n>1?'s':''}</span><span>€${(preco*n).toFixed(2)}</span></div>`
        ).join("");

        const f = fees || {};
        const g = guests || 1;
        const taxTotal = (f.taxPerPerson || 0) * g * nights;
        const taxasCents = (f.cleaning||0) + (f.towel||0) + (f.linen||0) + taxTotal;
        const totalCents = accommodationCents + taxasCents;

        const linhaTaxa = (label, cents) => cents > 0
            ? `<div class="line"><span>${label}</span><span>€${(cents/100).toFixed(2)}</span></div>` : "";

        // Desconto exclusivo do site
        const discountCents = DISCOUNT_PERCENT > 0 ? Math.round(totalCents * DISCOUNT_PERCENT / 100) : 0;
        const totalFinalCents = totalCents - discountCents;
        const linhaDesconto = discountCents > 0
            ? `<div class="line" style="color: var(--terracotta, #c0392b); font-weight: 600;"><span>Desconto site (-${DISCOUNT_PERCENT}%)</span><span>−€${(discountCents/100).toFixed(2)}</span></div>`
            : "";

        el.style.display = "block";
        el.innerHTML = `
            ${linhasAloj}
            ${linhaTaxa("Limpeza", f.cleaning)}
            ${linhaTaxa("Toalhas", f.towel)}
            ${linhaTaxa("Roupa de cama", f.linen)}
            ${linhaTaxa(`Imposto municipal (€${((f.taxPerPerson||0)/100).toFixed(2)} × ${g} × ${nights} noite${nights>1?'s':''})`, taxTotal)}
            ${linhaDesconto}
            <div class="total"><span>Total</span><span>${discountCents > 0 ? `<span style="text-decoration:line-through; color:var(--muted); font-weight:400; margin-right:8px;">€${(totalCents/100).toFixed(2)}</span>` : ""}€${(totalFinalCents/100).toFixed(2)}</span></div>
        `;
    }

    // ---- Helpers -----------------------------------------------------------

    async function loadApartment(sb, apartmentId) {
        const { data } = await sb
            .from("apartments")
            .select("id, name, price_per_night_cents, active, cleaning_fee_cents, towel_fee_cents, linen_fee_cents, tourist_tax_per_person_cents")
            .eq("id", apartmentId)
            .single();
        return data;
    }

    async function loadSeasons(sb, apartmentId) {
        const { data, error } = await sb
            .from("pricing_seasons")
            .select("name, start_date, end_date, price_per_night_cents")
            .eq("apartment_id", apartmentId)
            .order("start_date", { ascending: true });
        if (error) {
            console.warn("Falha a carregar épocas:", error.message);
            return [];
        }
        return data || [];
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
