# Supabase — Pausa automática (plano grátis)

## O que é
O Supabase (servidor que guarda reservas, contas e pagamentos do site) pausa automaticamente **após 7 dias sem actividade**. Quando isto acontece, o site deixa de funcionar até alguém clicar "Restore".

## Quando vai notificar
Recebes email tipo *"O teu projecto vai pausar em X dias"*. **Não é urgente** — é só um aviso.

## Como evitar
- **Usar o site** ao menos 1× por semana — qualquer reserva, login ou consulta reseta o contador
- Se ninguém usar durante 7 dias, pausa

## Se já tiver pausado
1. Abrir: https://supabase.com/dashboard/project/mfrmkkdqmlfuswggqbra
2. Aparece o botão **"Restore project"**
3. Clicar
4. Esperar ~2 minutos
5. Site volta a funcionar normalmente

**Não perdes dados.** Tudo continua igual após restaurar.

## Soluções permanentes
- **Cron externo** *(grátis)*: configurar https://cron-job.org para fazer ping diário → contador nunca chega aos 7 dias
- **Upgrade Pro** *(~€23/mês)*: o projecto nunca mais pausa

## Contacto
Para reactivar ou configurar o cron, contactar quem mantém o site.
