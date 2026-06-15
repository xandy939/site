// =============================================================================
// supabase-auth.js — handlers de login e registo
// Carregado por login.html, registar.html e index.html.
// Cada handler binda só ao seu form; em páginas sem o form fica inerte.
// =============================================================================

const SUPABASE_URL      = "https://mfrmkkdqmlfuswggqbra.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mcm1ra2RxbWxmdXN3Z2dxYnJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjM5NDYsImV4cCI6MjA5NDgzOTk0Nn0.T-niRyVa8D8RjXOgKqENbwNoVQFJ95cpfaH--LyfrOE";

window.addEventListener("load", () => {
    if (!window.supabase) {
        console.error("Supabase JS não carregou.");
        return;
    }
    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    bindLogin(sb);
    bindRegister(sb);
});

// ---- LOGIN -----------------------------------------------------------------
function bindLogin(sb) {
    const form = document.getElementById("login-form");
    if (!form) return;

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email    = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;

        try {
            const { data, error } = await sb.auth.signInWithPassword({ email, password });
            if (error) return alert("Erro no login: " + error.message);
            if (!data?.session) return alert("Erro inesperado ao processar a autenticação.");

            alert("Login feito com sucesso!");
            const next = new URLSearchParams(location.search).get("next");
            location.href = (next && next.startsWith("/")) ? next : "index.html";
        } catch (err) {
            console.error(err);
            alert("Erro crítico de ligação ao servidor Supabase.");
        }
    });

    // ---- ESQUECI-ME DA PASSWORD ---------------------------------------
    const linkEsqueci = document.getElementById("link-esqueci");
    if (linkEsqueci) {
        linkEsqueci.addEventListener("click", async (e) => {
            e.preventDefault();
            const inputEmail = document.getElementById("email");
            const email = (inputEmail?.value || "").trim();
            if (!email) {
                inputEmail?.focus();
                return alert("Escreve o teu email no campo acima e depois carrega em 'Esqueceu-se?'.");
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return alert("Email inválido. Verifica e tenta de novo.");
            }
            try {
                const { error } = await sb.auth.resetPasswordForEmail(email, {
                    redirectTo: location.origin + "/redefinir-pass.html",
                });
                if (error) return alert("Erro: " + error.message);
                alert("Email de recuperação enviado para " + email + ".\n\nVerifica a inbox (e a pasta de SPAM). Pode demorar até 1 minuto.");
            } catch (err) {
                console.error(err);
                alert("Erro de ligação. Tenta de novo.");
            }
        });
    }
}

// ---- REGISTO ---------------------------------------------------------------
function bindRegister(sb) {
    const form = document.getElementById("register-form");
    if (!form) return;

    const btn = form.querySelector("button[type=submit]");

    form.addEventListener("submit", async (e) => {
        e.preventDefault();

        const nome      = document.getElementById("nome").value.trim();
        const apelido   = document.getElementById("apelido").value.trim();
        const idade     = parseInt(document.getElementById("idade").value, 10);
        const sexo      = document.getElementById("sexo").value;
        const email     = document.getElementById("email").value.trim();
        const telefone  = document.getElementById("telefone").value.trim();
        const password  = document.getElementById("password").value;
        const confirmar = document.getElementById("confirmar-password").value;

        // Validações básicas no cliente
        if (!nome || !apelido) return alert("Preenche o nome e o apelido.");
        if (!Number.isFinite(idade) || idade < 18) return alert("Tens de ter pelo menos 18 anos.");
        if (!sexo) return alert("Escolhe o sexo.");
        if (password.length < 6) return alert("A password deve ter pelo menos 6 caracteres.");
        if (password !== confirmar) return alert("As passwords não coincidem.");

        btn.disabled = true;
        const labelOriginal = btn.textContent;
        btn.textContent = "A criar conta...";

        try {
            // signUp dispara o trigger handle_new_user que copia o raw_user_meta_data
            // para a tabela profiles (colunas: first_name, last_name, phone, age, gender)
            const { data, error } = await sb.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        first_name: nome,
                        last_name:  apelido,
                        phone:      telefone,
                        age:        idade,
                        gender:     sexo,
                        full_name:  `${nome} ${apelido}`,
                    },
                },
            });

            if (error) {
                alert("Erro a criar conta: " + error.message);
                return;
            }

            if (data?.session) {
                // Auto-login (a confirmação de email está desligada no projecto)
                alert("Conta criada e sessão iniciada!");
                const next = new URLSearchParams(location.search).get("next");
                location.href = (next && next.startsWith("/")) ? next : "index.html";
            } else {
                // Email de confirmação foi enviado
                alert("Conta criada! Verifica o teu email para confirmar antes de fazer login.");
                location.href = "login.html";
            }
        } catch (err) {
            console.error(err);
            alert("Erro crítico de ligação ao servidor Supabase.");
        } finally {
            btn.disabled = false;
            btn.textContent = labelOriginal;
        }
    });
}
