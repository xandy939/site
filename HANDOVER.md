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

1. **Webhook do Stripe (`whsec_...`)** — sem ele, pagamentos chegam ao Stripe mas
   o nosso site não sabe e a reserva fica em limbo (cancelada pelo cron ao fim de 32min).
   Configurar em https://dashboard.stripe.com/test/webhooks (test mode) ou /webhooks (live).
2. **Gmail App Password** — sem ele, **nenhum email sai** (dono nem hóspede).
   Gerar em https://myaccount.google.com/apppasswords e meter como secret
   `GMAIL_APP_PASSWORD` no Supabase.
3. **Publicar o site permanentemente** — actualmente publicado em Netlify Drop
   temporário (1h por sessão). Para permanente: criar conta grátis Netlify/
   Cloudflare/Vercel e arrastar a pasta `publicar/`.
4. **Activar pagamentos reais (Stripe live mode)** — neste momento só funciona
   em modo teste. Activar conta: NIF + IBAN + documentos, espera 1-3 dias.
   Depois substituir secrets `STRIPE_SECRET_KEY` (sk_live_) e `STRIPE_WEBHOOK_SECRET`.
5. **Domínio próprio** (~€10/ano) — ex: `bytralojamentos.pt`. Permite URL
   profissional + emails do teu domínio (resolve limite Resend / Gmail SMTP).
6. **URL iCal do Paraíso do Sol no Booking** — só Litoral Mar está sincronizado.
   Quando o Paraíso estiver listado no Booking, copiar o URL `.ics` e configurar.
7. **Foto da piscina do Paraíso** — actualmente o cartão da homepage mostra só o
   logo. Adicionar foto da piscina como `imagens/paraiso-piscina.png` e referenciá-la.

Todos estes passos estão detalhados em **SETUP.md**.

## 6.1 Acessos de administração

A função SQL `is_owner()` reconhece como admins os emails listados em
`app_settings.owner_email` (separados por vírgula). Actualmente:
- `miguelpararegistrar@gmail.com`
- `mfralmeida.2008@gmail.com`
- `xandy939@gmail.com`

Qualquer um deles consegue ver o botão **"Painel de Administração"** no perfil
e aceder ao `admin.html` com permissões completas.

---

## 7. Contactos técnicos

- Documentação completa: `SETUP.md` e `CLAUDE.md` (na raiz do projeto)
- Scripts de verificação: `node tools/health-check.mjs` (testa todo o sistema)
