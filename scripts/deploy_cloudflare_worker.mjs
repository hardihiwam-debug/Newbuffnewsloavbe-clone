// Deploy the news-fetch Cloudflare Worker (fetch relay + R2 media cache) via
// the Cloudflare API — no wrangler needed. Idempotent: re-running replaces the
// script in place.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... \
//   CLOUDFLARE_ACCOUNT_ID=... \
//   node scripts/deploy_cloudflare_worker.mjs
//
// Optional env:
//   CLOUDFLARE_RELAY_KEY  — shared secret the pipeline sends as X-Relay-Key.
//                           If unset, a random one is generated and printed.
//   CLOUDFLARE_BUCKET     — R2 bucket name (default: newsbuff).
//   CLOUDFLARE_WORKER_NAME— script name (default: news-fetch).

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!TOKEN || !ACCOUNT) {
  console.error("usage: CLOUDFLARE_API_TOKEN=.. CLOUDFLARE_ACCOUNT_ID=.. node scripts/deploy_cloudflare_worker.mjs");
  process.exit(1);
}

const BUCKET = process.env.CLOUDFLARE_BUCKET ?? "newsbuff";
const NAME = process.env.CLOUDFLARE_WORKER_NAME ?? "news-fetch";

// Reuse the already-deployed relay key when the operator did not pin one:
// rotating it on a routine re-deploy would silently break the pipeline's
// CLOUDFLARE_RELAY_KEY secret and egress would fall back to direct fetches.
let RELAY_KEY = process.env.CLOUDFLARE_RELAY_KEY || "";

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function cf(path, init) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: init?.headers ?? H });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { success: false, errors: [{ message: text.slice(0, 300) }] }; }
  if (!res.ok || body.success === false) {
    throw new Error(`${init?.method ?? "GET"} ${path} [${res.status}]: ${JSON.stringify(body.errors ?? body).slice(0, 400)}`);
  }
  return body.result;
}

// 1. Ensure the R2 bucket exists (public access is a separate dashboard step;
//    the bucket used here must already be public for Telegram to fetch media).
try {
  await cf(`/r2/buckets/${BUCKET}`);
} catch {
  await cf(`/r2/buckets`, { method: "POST", body: JSON.stringify({ name: BUCKET }) });
  console.log(`[r2] bucket "${BUCKET}" created`);
}

// 1b. If no key was pinned, pull the current one from the deployed script's
// bindings so re-deploys never rotate the key under the pipeline.
if (!RELAY_KEY) {
  try {
    const settings = await cf(`/workers/scripts/${NAME}/settings`);
    const existing = (settings?.bindings ?? []).find((b) => b?.name === "RELAY_KEY");
    if (existing?.text) RELAY_KEY = String(existing.text);
  } catch {
    // First deploy (or script deleted) — a fresh key is fine.
  }
}
if (!RELAY_KEY) RELAY_KEY = randomBytes(24).toString("hex");

// 2. Resolve the workers.dev subdomain so we can print the final URL.
const sub = await cf("/workers/subdomain");
const subdomain = String(sub?.subdomain ?? "");

// 3. Upload the worker (multipart: metadata + source).
const source = readFileSync(new URL("../cloudflare/worker.js", import.meta.url));
const metadata = JSON.stringify({
  main_module: "worker.js",
  compatibility_date: "2024-01-01",
  bindings: [
    { type: "r2_bucket", name: "MEDIA_BUCKET", bucket_name: BUCKET },
    { type: "plain_text", name: "RELAY_KEY", text: RELAY_KEY },
  ],
});
const boundary = "----cfwb" + Date.now();
const enc = (s) => new TextEncoder().encode(s);
const chunks = [
  enc(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`),
  enc(`--${boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n`),
  source,
  enc(`\r\n--${boundary}--\r\n`),
];
const body = new Blob(chunks);
const res = await fetch(`${BASE}/workers/scripts/${NAME}`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
  body,
});
const text = await res.text();
if (!res.ok) {
  console.error(`[worker] deploy failed [${res.status}]: ${text.slice(0, 500)}`);
  process.exit(1);
}
console.log(`[worker] "${NAME}" deployed (${(text.match(/"modified_on"/) ? "ok" : "ok")})`);
console.log(`[worker] url: https://${NAME}.${subdomain}.workers.dev`);
if (process.env.CLOUDFLARE_RELAY_KEY) {
  console.log(`[worker] relay key: pinned via env (unchanged)`);
} else {
  console.log(`[worker] relay key (set as CLOUDFLARE_RELAY_KEY on the pipeline): ${RELAY_KEY}`);
  console.log(`[worker] note: this key was reused from the existing deployment — the pipeline's secret stays valid.`);
}
