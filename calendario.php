<?php
// =============================================================================
// calendario.php — proxy de iCal Export
// Para o Booking.com importar sem expor a URL do Supabase.
// Uso: https://www.apartamentosturisticosalgarve.pt/calendario.php?apt=paraiso-do-sol
// =============================================================================

$apt = $_GET['apt'] ?? '';
$apt = preg_replace('/[^a-z0-9\-]/i', '', $apt);  // sanitização

$allowed = ['paraiso-do-sol', 'litoral-mar'];
if (!in_array($apt, $allowed, true)) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Apartamento inválido. Use ?apt=paraiso-do-sol ou ?apt=litoral-mar.";
    exit;
}

$url = "https://mfrmkkdqmlfuswggqbra.supabase.co/functions/v1/ical-export?apt=" . urlencode($apt);

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 15);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_USERAGENT, 'APTTA-Calendario-Proxy/1.0');
$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($status !== 200 || $body === false) {
    http_response_code(502);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Erro a obter calendário (HTTP $status).";
    exit;
}

header('Content-Type: text/calendar; charset=utf-8');
header('Content-Disposition: inline; filename="' . $apt . '.ics"');
header('Cache-Control: public, max-age=300');  // 5 min
echo $body;
