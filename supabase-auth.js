window.addEventListener("load", () => {
    const loginForm = document.getElementById('login-form');
    
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            // Credenciais embutidas diretamente na ação
            const SUPABASE_URL = "https://mfrmkkdqmlfuswggqbra.supabase.co"; 
            const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mcm1ra2RxbWxmdXN3Z2dxYnJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjM5NDYsImV4cCI6MjA5NDgzOTk0Nn0.T-niRyVa8D8RjXOgKqENbwNoVQFJ95cpfaH--LyfrOE"; 

            if (!window.supabase) {
                alert("Erro: A biblioteca do Supabase não carregou. Tente atualizar a página.");
                return;
            }

            // Cria o cliente local apenas para o login
            const supabaseLocal = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            
            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value;

            try {
                const { data, error } = await supabaseLocal.auth.signInWithPassword({
                    email: email,
                    password: password,
                });

                if (error) {
                    alert("Erro no login: " + error.message);
                } else if (data?.session) {
                    alert("Login feito com sucesso!");
                    window.location.href = "index.html"; 
                } else {
                    alert("Erro inesperado ao processar a autenticação.");
                }
            } catch (err) {
                console.error(err);
                alert("Erro crítico de ligação ao servidor Supabase.");
            }
        });
    }
});