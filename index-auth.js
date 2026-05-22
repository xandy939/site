// --- CARROSSEL DE IMAGENS ---
const cards = document.querySelectorAll('.card');
cards.forEach(card => {
    let currentSlide = 0; 
    const slides = card.querySelectorAll('.card-slide');
    if (slides.length > 1) {
        setInterval(() => {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }, 4000); 
    }
});

// --- SISTEMA DE AUTENTICAÇÃO DO PERFIL ---
window.addEventListener("load", async () => {
    const authArea = document.getElementById("auth-area");
    const supabase = window.supabaseClient;

    if (!supabase) return; 

    try {
        const { data: { session } } = await supabase.auth.getSession();

        if (session && session.user) {
            const userId = session.user.id;
            let nomeExibir = "Utilizador";

            // Se a tabela der erro no Supabase, o código NÃO vai morrer aqui
            try {
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('nome')
                    .eq('id', userId)
                    .single();

                if (profile && profile.nome) {
                    nomeExibir = profile.nome;
                }
            } catch (tableError) {
                console.warn("Erro ao aceder à tabela profiles, a usar nome padrão.", tableError);
            }

            if (authArea) {
                authArea.innerHTML = `
                    <div class="perfil-container">
                        <span class="user-name">👤 Olá, ${nomeExibir}</span>
                        <button id="btn-logout-act" class="btn-logout">Sair</button>
                    </div>
                `;

                document.getElementById("btn-logout-act").addEventListener("click", async () => {
                    await supabase.auth.signOut();
                    alert("Sessão terminada!");
                    window.location.reload(); 
                });
            }
        }
    } catch (err) {
        console.error("Erro geral na autenticação:", err);
    }
});