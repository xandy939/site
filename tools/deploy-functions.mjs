// Helper: deploy das 3 Edge Functions via Supabase Management API (multipart)
// O endpoint JSON tem um bug que corta os primeiros 4 bytes; o endpoint
// multipart /deploy é o que a CLI oficial usa e funciona correctamente.

import fs from "node:fs";

const token = fs.readFileSync(".supabase-token", "utf8").trim();
const PROJ  = "mfrmkkdqmlfuswggqbra";

const functions = [
    { slug: "notify-owner",        verify_jwt: true,  file: "supabase/functions/notify-owner/index.ts"        },
    { slug: "ical-export",         verify_jwt: false, file: "supabase/functions/ical-export/index.ts"         },
    { slug: "ical-import",         verify_jwt: true,  file: "supabase/functions/ical-import/index.ts"         },
    { slug: "gerar-referencia-mb", verify_jwt: false, file: "supabase/functions/gerar-referencia-mb/index.ts" },
    { slug: "gerar-reserva-iban",  verify_jwt: false, file: "supabase/functions/gerar-reserva-iban/index.ts"  },
    { slug: "ifthenpay-callback",  verify_jwt: false, file: "supabase/functions/ifthenpay-callback/index.ts"  },
    { slug: "delete-user-account", verify_jwt: false, file: "supabase/functions/delete-user-account/index.ts" },
];

// Permite deploy selectivo: `node tools/deploy-functions.mjs create-checkout stripe-webhook`
const onlySlugs = process.argv.slice(2);
const toDeploy = onlySlugs.length ? functions.filter(f => onlySlugs.includes(f.slug)) : functions;

async function deploy(fn) {
    const source = fs.readFileSync(fn.file, "utf8");

    const form = new FormData();
    // metadata como JSON blob com Content-Type application/json
    const metadata = {
        name: fn.slug,
        entrypoint_path: "index.ts",
        verify_jwt: fn.verify_jwt,
    };
    form.append("metadata",
        new Blob([JSON.stringify(metadata)], { type: "application/json" })
    );
    // ficheiro fonte
    form.append("file",
        new Blob([source], { type: "application/typescript" }),
        "index.ts"
    );

    const url = `https://api.supabase.com/v1/projects/${PROJ}/functions/deploy?slug=${fn.slug}`;
    const r = await fetch(url, {
        method: "POST",
        headers: { "Authorization": "Bearer " + token },
        body: form,
    });
    const text = await r.text();
    console.log(`[${fn.slug}] HTTP ${r.status}`, text.slice(0, 300));
    if (!r.ok) throw new Error(`Deploy de ${fn.slug} falhou`);
}

for (const fn of toDeploy) {
    await deploy(fn);
}
console.log(`✓ ${toDeploy.length} função(ões) publicada(s) via multipart.`);
