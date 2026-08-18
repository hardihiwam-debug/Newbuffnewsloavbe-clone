// One-shot: bundle edge function(s) with esbuild, deploy via Management API.
//   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... node scripts/_deploy_fn.mjs <slug...>
//   e.g. node scripts/_deploy_fn.mjs pipeline admin
//   (npm/bun: `bun run deploy:all` deploys pipeline + admin)
//
// Secrets are read from the environment ONLY — never hardcode a token here.
// Set SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF via the Freebuff Keys UI
// so deploys work without pasting secrets into chat or shell history.
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
const slugs = process.argv.slice(2);
if (!TOKEN || !REF || slugs.length === 0) {
  console.error(
    "usage: SUPABASE_ACCESS_TOKEN=.. SUPABASE_PROJECT_REF=.. node scripts/_deploy_fn.mjs <slug...>",
  );
  process.exit(1);
}

let failed = 0;
for (const slug of slugs) {
  const entry = `supabase/functions/${slug}/index.ts`;
  const out = join(tmpdir(), `${slug}_bundle.js`);
  execSync(
    `npx esbuild ${entry} --bundle --format=esm --platform=neutral --target=esnext --outfile=${out}`,
    { stdio: "inherit" },
  );
  const file = readFileSync(out);
  const metadata = JSON.stringify({
    entrypoint_path: "index.ts",
    verify_jwt: false,
    import_map_path: null,
  });

  const boundary = "----codebuff" + Date.now();
  const enc = (s) => new TextEncoder().encode(s);
  const chunks = [
    enc(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
    ),
    enc(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: text/typescript\r\n\r\n`,
    ),
    file,
    enc(`\r\n--${boundary}--\r\n`),
  ];
  const body = new Blob(chunks);

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${REF}/functions/deploy?slug=${encodeURIComponent(slug)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "x-upsert": "true",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    },
  );
  const text = await res.text();
  rmSync(out, { force: true });
  console.log(`[${slug}] HTTP ${res.status}`);
  console.log(text.slice(0, 600));
  if (!res.ok) failed += 1;
}
process.exit(failed ? 1 : 0);
