#!/usr/bin/env node
// Backfill the pieces of the Convex export that the Supabase cutover never
// copied: raw_articles (dedup memory — prevents re-publishing old stories)
// and published_history (feeds the 14-day chart + publish dedup window).
//
// Uses the Supabase Management API SQL endpoint (same as
// scripts/apply_supabase_migrations.mjs), so it needs an access token:
//
//   SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=ljvdaajfbkqeodglghwn \
//   node scripts/backfill_convex_data.mjs
//
// Safe to re-run: rows that already exist (dedup_key / published row) are
// skipped via INSERT ... ON CONFLICT DO NOTHING.

import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
const EXPORT_ZIP = process.env.EXPORT_ZIP ?? ".convex/local/default/export.zip";

if (!TOKEN || !REF) {
  console.error("Set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF");
  process.exit(1);
}

function unzip(path) {
  const dest = mkdtempSync(join(tmpdir(), "conv-"));
  const r = spawnSync("unzip", ["-o", "-qq", path, "-d", dest], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`unzip failed: ${r.stderr || r.stdout}`);
  return dest;
}

function readJsonl(dir, table) {
  try {
    return readFileSync(join(dir, table, "documents.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const esc = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return "'" + String(v).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
};

async function runSql(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

async function insertChunks(table, columns, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 40) {
    const chunk = rows.slice(i, i + 40);
    const tuples = chunk
      .map((r) => `(${columns.map((c) => esc(r[c])).join(",")})`)
      .join(",");
    const sql = `insert into public.${table} (${columns.join(",")}) values ${tuples} on conflict do nothing;`;
    await runSql(sql);
    inserted += chunk.length;
  }
  return inserted;
}

async function main() {
  console.log(`→ Reading ${EXPORT_ZIP}`);
  const dir = unzip(EXPORT_ZIP);

  const raws = readJsonl(dir, "rawArticles");
  console.log(`→ rawArticles: ${raws.length} rows in export`);

  // Only feed rows that carry a dedup key (that's all the pipeline checks).
  const rawRows = raws
    .filter((r) => r.dedupKey || r.dedup_key)
    .map((r) => ({
      dedup_key: String(r.dedupKey ?? r.dedup_key).slice(0, 300),
      provider: String(r.provider ?? "convex-backfill").slice(0, 120),
      url: String(r.url ?? "https://localhost").slice(0, 1000),
      title: String(r.title ?? r.headline ?? "").slice(0, 500),
      source_name: r.sourceName ? String(r.sourceName).slice(0, 200) : null,
      category: r.category ? String(r.category).slice(0, 50) : null,
      published_at: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
      fetched_at: new Date(r._creationTime ?? Date.now()).toISOString(),
      rejected: Boolean(r.rejected),
      reject_reason: r.rejectReason ? String(r.rejectReason).slice(0, 300) : null,
    }));
  console.log(`→ rawRows to insert: ${rawRows.length}`);
  if (rawRows.length) {
    const n = await insertChunks(
      "raw_articles",
      ["dedup_key", "provider", "url", "title", "source_name", "category", "published_at", "fetched_at", "rejected", "reject_reason"],
      rawRows,
    );
    console.log(`  ✓ raw_articles: ${n} rows inserted (dedup memory restored)`);
  }

  const hist = readJsonl(dir, "publishedHistory");
  console.log(`→ publishedHistory: ${hist.length} rows in export`);
  const histRows = hist.map((r) => ({
    dedup_key: String(r.dedupKey ?? r.dedup_key).slice(0, 300),
    chat_id: Number(r.chatId ?? r.chat_id ?? 0),
    headline: r.headline ? String(r.headline).slice(0, 500) : null,
    english_headline: r.headline ? String(r.headline).slice(0, 500) : null,
    source_text: r.sourceText ? String(r.sourceText).slice(0, 2000) : null,
    event_id: r.eventId ? String(r.eventId).slice(0, 300) : null,
    source_name: r.sourceName ? String(r.sourceName).slice(0, 200) : null,
    category: r.category ? String(r.category).slice(0, 50) : null,
    breaking: Boolean(r.breaking),
    original_published_at: r.originalPublishedAt ? new Date(r.originalPublishedAt).toISOString() : null,
    published_at: new Date(r.publishedAt ?? r._creationTime ?? Date.now()).toISOString(),
  }));
  if (histRows.length) {
    const n = await insertChunks(
      "published_history",
      ["dedup_key", "chat_id", "headline", "english_headline", "source_text", "event_id", "source_name", "category", "breaking", "original_published_at", "published_at"],
      histRows,
    );
    console.log(`  ✓ published_history: ${n} rows inserted (14-day chart + dedup window restored)`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
