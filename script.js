// =========================================================
// 1. O TEU CÓDIGO ORIGINAL (Para a página de detalhes)
// =========================================================
let slideIndex = 0;

function mudarSlide(direcao) {
    const slides = document.querySelectorAll('.slide');
    const contador = document.querySelectorAll('.contador-fotos');

    if (slides.length === 0) return;

    slides[slideIndex].classList.remove('active');
    slideIndex += direcao;

    if (slideIndex >= slides.length) {
        slideIndex = 0;
    }
    if (slideIndex < 0) {
        slideIndex = slides.length - 1;
    }

    slides[slideIndex].classList.add('active');

    if (contador.length > 0) {
        contador[0].textContent = `${slideIndex + 1}/${slides.length}`;
    }
}


// =========================================================
// 2. LÓGICA AUTOMÁTICA PARA O INDEX + GESTÃO DE SESSÃO AVANÇADA
// =========================================================
document.addEventListener("DOMContentLoaded", () => {
    const cardsIndex = document.querySelectorAll('.card');
    cardsIndex.forEach(card => {
        const slides = card.querySelectorAll('.card-slide');
        if (slides.length > 1) {
            let currentSlide = 0;
            slides.forEach((slide, index) => {
                if (index === 0) {
                    slide.style.setProperty('opacity', '1', 'important');
                    slide.style.setProperty('z-index', '2', 'important');
                } else {
                    slide.style.setProperty('opacity', '0', 'important');
                    slide.style.setProperty('z-index', '1', 'important');
                }
            });
            setInterval(() => {
                slides[currentSlide].style.setProperty('opacity', '0', 'important');
                slides[currentSlide].style.setProperty('z-index', '1', 'important');
                currentSlide = (currentSlide + 1) % slides.length;
                slides[currentSlide].style.setProperty('opacity', '1', 'important');
                slides[currentSlide].style.setProperty('z-index', '2', 'important');
            }, 4000); 
        }
    });

    gerirSistemaAutenticacao();
});

async function gerirSistemaAutenticacao() {
    if (!window.supabase) return;

    const SUPABASE_URL = "https://mfrmkkdqmlfuswggqbra.supabase.co"; 
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mcm1ra2RxbWxmdXN3Z2dxYnJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjM5NDYsImV4cCI6MjA5NDgzOTk0Nn0.T-niRyVa8D8RjXOgKqENbwNoVQFJ95cpfaH--LyfrOE"; 
    const supabaseCtrl = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    try {
        const { data: { session } } = await supabaseCtrl.auth.getSession();

        const authArea = document.getElementById("auth-area");
        const perfNome = document.getElementById("perf-nome");
        const perfUsername = document.getElementById("perf-username");
        const perfGenero = document.getElementById("perf-genero");
        const perfTelefone = document.getElementById("perf-telefone");
        const perfId = document.getElementById("perf-id");
        const perfEmail = document.getElementById("perf-email");
        const perfData = document.getElementById("perf-data");
        const btnLogoutPerfil = document.getElementById("btn-logout-perfil");
        const btnAlterarSenha = document.getElementById("btn-alterar-senha");
        const inputFoto = document.getElementById("input-foto");
        const perfFotoImg = document.getElementById("perf-foto-img");
        const perfFotoPlaceholder = document.getElementById("perf-foto-placeholder");

        if (session && session.user) {
            const userId = session.user.id;
            const userEmail = session.user.email;
            const criadoEm = new Date(session.user.created_at).toLocaleDateString('pt-PT');
            
            let nomeCompleto = "";
            let nomeEncontrado = false;

            const metadata = session.user.user_metadata;
            if (metadata) {
                if (metadata.full_name) { nomeCompleto = metadata.full_name; nomeEncontrado = true; }
                else if (metadata.display_name) { nomeCompleto = metadata.display_name; nomeEncontrado = true; }
                else if (metadata.name) { nomeCompleto = metadata.name; nomeEncontrado = true; }
            }

            let telefoneExibir = "Não registado";
            let generoExibir = "Não especificado";
            let avatarUrl = "";

            // 2. Busca os dados estendidos (incluindo genero/sexo) da tabela profiles
            try {
                // Tenta puxar as colunas comuns. Se a tua coluna se chamar 'sexo' em vez de 'genero', altera abaixo
                const { data: profile } = await supabaseCtrl
                    .from('profiles')
                    .select('nome, telefone, avatar_url, genero, sexo')
                    .eq('id', userId)
                    .single();

                if (profile) {
                    if (profile.nome && !nomeEncontrado) { nomeCompleto = profile.nome; nomeEncontrado = true; }
                    if (profile.telefone) telefoneExibir = profile.telefone;
                    if (profile.avatar_url) avatarUrl = profile.avatar_url;
                    
                    // Verifica se o dado veio guardado na coluna 'genero' ou 'sexo'
                    if (profile.genero) generoExibir = profile.genero;
                    else if (profile.sexo) generoExibir = profile.sexo;
                }
            } catch (err) {
                console.warn("Campos extras não encontrados na tabela profiles.");
            }

            // Fallback inteligente para o primeiro nome
            let primeiroNome = "";
            if (nomeEncontrado && nomeCompleto) {
                primeiroNome = nomeCompleto.trim().split(' ')[0];
            } else {
                const parteAntesDoArroba = userEmail.split('@')[0];
                const palavraLimpa = parteAntesDoArroba.split(/[._-]/)[0]; 
                if (palavraLimpa.toLowerCase().includes("miguel")) {
                    primeiroNome = "Miguel";
                    nomeCompleto = "Miguel Registra Almeida";
                } else {
                    primeiroNome = palavraLimpa.charAt(0).toUpperCase() + palavraLimpa.slice(1);
                    nomeCompleto = primeiroNome;
                }
            }

            // 1. Injeta o Primeiro Nome no Index
            if (authArea) {
                authArea.innerHTML = `
                    <a href="perfil.html" class="user-name" style="text-decoration: none; display: inline-flex; align-items: center; gap: 8px;">
                        👤 Olá, ${primeiroNome}
                    </a>
                `;
            }

            // 2. Preenche os campos do Perfil
            if (perfNome) perfNome.textContent = nomeCompleto;
            if (perfUsername) perfUsername.textContent = nomeCompleto;
            if (perfGenero) perfGenero.textContent = generoExibir;
            if (perfTelefone) perfTelefone.textContent = telefoneExibir;
            if (perfId) perfId.textContent = userId;
            if (perfEmail) perfEmail.textContent = userEmail;
            if (perfData) perfData.textContent = criadoEm;

            // Foto de perfil
            if (avatarUrl && perfFotoImg) {
                perfFotoImg.src = avatarUrl;
                perfFotoImg.style.display = "block";
                if (perfFotoPlaceholder) perfFotoPlaceholder.style.display = "none";
            }

            // --- INTERAÇÃO: ALTERAR PASSWORD DIRETO NO SUPABASE ---
            if (btnAlterarSenha) {
                btnAlterarSenha.addEventListener("click", async () => {
                    const novaSenha = prompt("Insere a tua nova password (mínimo 6 caracteres):");
                    
                    if (novaSenha === null) return; // Utilizador cancelou
                    
                    if (novaSenha.trim().length < 6) {
                        alert("A password deve conter pelo menos 6 caracteres!");
                        return;
                    }

                    // Comando oficial do Supabase para atualizar dados do user logado
                    const { error } = await supabaseCtrl.auth.updateUser({
                        password: novaSenha.trim()
                    });

                    if (error) {
                        alert("Erro ao alterar password: " + error.message);
                    } else {
                        alert("Password alterada com sucesso!");
                    }
                });
            }

            // EVENTO UPLOAD DE FOTO
            if (inputFoto) {
                inputFoto.addEventListener("change", async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;

                    const fileExt = file.name.split('.').pop();
                    const fileName = `${userId}-${Math.random()}.${fileExt}`;
                    const filePath = `${fileName}`;

                    alert("A carregar nova foto, aguarde...");

                    const { error: uploadError } = await supabaseCtrl.storage
                        .from('avatars')
                        .upload(filePath, file, { cacheControl: '3600', upsert: true });

                    if (uploadError) {
                        alert("Erro no upload: " + uploadError.message);
                        return;
                    }

                    const { data: { publicUrl } } = supabaseCtrl.storage
                        .from('avatars')
                        .getPublicUrl(filePath);

                    await supabaseCtrl
                        .from('profiles')
                        .upsert({ id: userId, avatar_url: publicUrl });

                    alert("Foto de perfil atualizada!");
                    window.location.reload();
                });
            }

            // EVENTO LOGOUT
            if (btnLogoutPerfil) {
                btnLogoutPerfil.addEventListener("click", async () => {
                    await supabaseCtrl.auth.signOut();
                    alert("Sessão terminada!");
                    window.location.href = "index.html";
                });
            }

        } else {
            if (perfNome) {
                window.location.href = "index.html";
            }
        }
    } catch (globalErr) {
        console.error("Erro no sistema:", globalErr);
    }
}