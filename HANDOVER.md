# Handover — By TR Alojamentos (site de reservas)

Documento de transferência do projeto. Contém o inventário completo, como aceder
a cada parte, e como tornar-se dono.

---

## 1. O que é o projeto

Site de reservas para os apartamentos **By TR Alojamentos** (Litoral Mar e
Paraíso do Sol, Praia da Rocha, Portimão). Permite:

- Ver os apartamentos, fotos, comodidades, localização
- Calendário com preços por época e disponibilidade em tempo real
- Reservar e pagar online (cartão / MB WAY / Multibanco)
- Conta de cliente (registo, login, perfil)
- Painel de administração para o dono (confirmar/cancelar reservas, ver estatísticas)
- Sincronização automática com o Booking.com (calendários)
- Email automático ao dono e ao hóspede quando há reserva paga

**Tecnologia:** site estático (HTML/CSS/JS, sem framework) + Supabase como backend
(base de dados, autenticação, Edge Functions, agendamentos).

---

## 2. Inventário de ativos e acessos

| Ativo | Onde | Como aceder |
|---|---|---|
| **Código-fonte** | GitHub: `miguelpararegistrar-prog/site` (privado) | Pedir convite de colaborador ao detentor actual |
| **Backend / BD** | Supabase, projeto `mfrmkkdqmlfuswggqbra` | https://supabase.com/dashboard → pedir convite à organização |
| **Email transacional** | Resend (conta `miguelpararegistrar@gmail.com`) | https://resend.com |
| **Pagamentos** | Stripe (test mode) — não está live | https://dashboard.stripe.com |
| **Sincronização Booking** | iCal configurado para Litoral Mar | gerido dentro do Supabase |
| **Site online** | ⚠️ ainda NÃO publicado | ver secção 6 |
| **Domínio** | ⚠️ ainda NÃO comprado | ver secção 6 |

---

## 3. Como correr o site localmente (para ver/testar)

1. Instalar [Git](https://git-scm.com) e abrir um terminal
2. Clonar o repositório:
   ```
   git clone https://github.com/miguelpararegistrar-prog/site.git
   cd site
   ```
3. Abrir `index.html` num browser, ou usar a extensão **Live Server** do VS Code
4. Funciona imediatamente — liga-se ao Supabase na cloud automaticamente

Não é preciso instalar base de dados nem servidores. O backend está todo na cloud.

---

## 4. Estrutura do código

```
index.html               → página inicial (lista de apartamentos)
apartamento-rocha.html   → Litoral Mar (calendário + reserva)
apartamento-amarilis.html→ Paraíso do Sol
login.html / registar.html / perfil.html → contas de cliente
admin.html / admin.js    → painel do dono (acesso restrito)
reserva-confirmada.html  → página pós-pagamento
reserva-cancelada.html   → página de pagamento cancelado
style.css                → design system (cores, tipografia, componentes)
script.js                → sessão, carrossel, perfil
supabase-auth.js         → login e registo
reservations.js          → calendário + checkout
recent-guests.js         → secção "hóspedes recentes"
supabase/migrations/     → estrutura da base de dados (SQL)
supabase/functions/      → Edge Functions (checkout, email, iCal)
tools/                   → scripts de deploy e testes
SETUP.md                 → guia detalhado de configuração de cada serviço
CLAUDE.md                → documentação técnica da arquitectura
```

---

## 5. Como tornar-se dono (transferência)

Para o novo dono assumir o controlo total:

### GitHub
- O detentor actual vai a **Settings → Collaborators** e adiciona a conta GitHub
  do novo dono como **Admin**; ou faz **Settings → Danger Zone → Transfer ownership**.

### Supabase
- O detentor actual vai a **Organization → Team → Invite** e adiciona o email do
  novo dono como **Owner**; ou **Project Settings → Transfer project** para a
  organização do novo dono.

### Serviços de pagamento e email
- Stripe / Resend estão ligados a contas pessoais com email/NIF/IBAN. Não se
  "transferem" — o novo dono cria as contas dele e substitui as chaves nos
  *secrets* do Supabase (ver SETUP.md). É rápido (~15 min por serviço).

---

## 6. O que falta para estar 100% pronto a vender

Por ordem de prioridade:

1. **Publicar o site online** — está a correr só localmente. Opções grátis:
   Netlify, Cloudflare Pages, Vercel (ligam ao GitHub e dão um URL em minutos).
2. **Comprar um domínio** (~€10/ano) — ex: `bytralojamentos.pt`. Resolve URL do
   site + emails profissionais.
3. **Activar pagamentos reais** — escolher provider (Stripe / Viva / IfthenPay),
   activar a conta (NIF + IBAN + documentos), trocar de "test" para "live".
4. **Configurar o webhook de pagamento** — sem ele, pagamentos não confirmam no site.
5. **Verificar domínio no Resend** — para enviar emails de qualquer remetente.
6. **Ligar Booking do Paraíso do Sol** — falta colar o URL iCal (Litoral Mar já está).

Todos estes passos estão detalhados em **SETUP.md**.

---

## 7. Contactos técnicos

- Documentação completa: `SETUP.md` e `CLAUDE.md` (na raiz do projeto)
- Scripts de verificação: `node tools/health-check.mjs` (testa todo o sistema)
