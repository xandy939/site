// =============================================================================
// recent-guests.js — Mostra "Hóspedes recentes" nas páginas dos apartamentos.
// Lê de uma view pública anonimizada (só primeiro nome + bandeira + mês).
// =============================================================================

(() => {
    const SUPABASE_URL      = "https://mfrmkkdqmlfuswggqbra.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mcm1ra2RxbWxmdXN3Z2dxYnJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjM5NDYsImV4cCI6MjA5NDgzOTk0Nn0.T-niRyVa8D8RjXOgKqENbwNoVQFJ95cpfaH--LyfrOE";

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
    const MES = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

    document.addEventListener("DOMContentLoaded", async () => {
        const container = document.getElementById("hospedes-recentes");
        if (!container) return;

        const apartmentId = document.querySelector("[data-apartment-id]")?.dataset.apartmentId;
        if (!apartmentId || !window.supabase) return;

        const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        const { data, error } = await sb
            .from("recent_guests")
            .select("display_name, nationality, source, stay_month")
            .eq("apartment_id", apartmentId)
            .order("check_out", { ascending: false })
            .limit(8);

        if (error || !data || data.length === 0) {
            container.style.display = "none";
            return;
        }

        const cards = data.map(g => {
            const flag = g.nationality ? (FLAGS[g.nationality.toUpperCase()] || "🌍") : "🌍";
            const country = g.nationality ? (COUNTRY_NAMES[g.nationality.toUpperCase()] || g.nationality) : "";
            const initial = g.display_name?.charAt(0).toUpperCase() || "?";
            const [year, month] = (g.stay_month || "").split("-");
            const mesStr = month ? `${MES[parseInt(month,10)-1]} ${year}` : "";
            const sourceBadge = g.source === "booking"
                ? `<span class="guest-source booking">via Booking</span>`
                : `<span class="guest-source site">via site</span>`;
            return `
                <div class="guest-card">
                    <div class="guest-avatar">${esc(initial)}</div>
                    <div class="guest-name">${esc(g.display_name || "")}</div>
                    <div class="guest-country">${flag} ${esc(country)}</div>
                    <div class="guest-meta">${esc(mesStr)} ${sourceBadge}</div>
                </div>
            `;
        }).join("");

        container.style.display = "";
        container.querySelector(".guests-grid").innerHTML = cards;
    });

    function esc(s) {
        return (s ?? "").toString()
            .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
    }
})();
