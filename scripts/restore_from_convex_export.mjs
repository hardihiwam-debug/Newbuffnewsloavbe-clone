#!/usr/bin/env node
// Restore lost Convex data into the live Supabase admin console.
//
// Reads .convex/local/default/export.zip (the snapshot the Convex backend
// was using before the migration) and replays the topic queries and chats
// that were dropped on the floor during the cutover. Uses the already
// deployed `admin` edge function for every write, so the same PIN gate
// and row-shaped payloads the dashboard uses apply here.
//
// Usage:
//   ADMIN_URL=https://<ref>.supabase.co/functions/v1/admin \
//   ADMIN_PIN=200006 \
//   node scripts/restore_from_convex_export.mjs
//
// Or just `node scripts/restore_from_convex_export.mjs` — script falls
// back to the project's defaults from vite.config.ts / supabase config.

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── Project defaults (overridable via env) ─────────────────────────────
const DEFAULT_URL = "https://ljvdaajfbkqeodglghwn.supabase.co/functions/v1/admin";
const DEFAULT_PIN = "200006";
const DEFAULT_ZIP = ".convex/local/default/export.zip";

const ADMIN_URL = process.env.ADMIN_URL ?? DEFAULT_URL;
const ADMIN_PIN = process.env.ADMIN_PIN ?? DEFAULT_PIN;
const EXPORT_ZIP = process.env.EXPORT_ZIP ?? DEFAULT_ZIP;

// ── Lightweight unzip (no streaming zip dependency) ────────────────────
// We only need files at the top level of the zip (Convex exports lay
// everything out as `<table>/documents.jsonl` directly under root).
function readZipFile(zipBuf, name) {
  // Signature: PK\x03\x04 ... central directory needs a full parse. Use
  // Node 22+ built-in `unzip` via the shell if available; otherwise read
  // the central directory with a small hand-rolled parser.
  // Easiest: spawn the system `unzip` if present, fall through to shell.
  return null; // unused — we use shell out below
}

// Need a real unzip: write to /tmp + shell out, since Node has no built-in.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function unzip(path) {
  const dest = mkdtempSync(join(tmpdir(), "conv-"));
  const r = spawnSync("unzip", ["-o", "-qq", path, "-d", dest], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`unzip failed: ${r.stderr || r.stdout}`);
  }
  return dest;
}

async function admin(action, payload) {
  const res = await fetch(ADMIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, pin: ADMIN_PIN, ...payload }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text }; }
  if (!res.ok || (parsed && parsed.ok === false)) {
    return { ok: false, status: res.status, error: parsed?.error ?? text };
  }
  return { ok: true, status: res.status, data: parsed?.data ?? parsed };
}

async function main() {
  console.log(`→ Reading Convex export:  ${EXPORT_ZIP}`);
  const dir = unzip(EXPORT_ZIP);

  // ── 1. snapshot current Supabase state ────────────────────────
  const dashboard = await admin("getDashboard", {});
  if (!dashboard.ok) {
    console.error("getDashboard failed:", dashboard.error);
    process.exit(2);
  }
  const existingChats = dashboard.data.chats ?? [];
  const existingTopicQueries = dashboard.data.topicQueries ?? [];

  console.log(`→ Current state on Supabase:`);
  console.log(`    ${existingChats.length} chat(s), ${existingTopicQueries.length} topic query(ies)`);

  const existingChatIds = new Set(existingChats.map((c) => Number(c.chatId)));

  // ── 2. read the Convex export ─────────────────────────────────
  const convexChats = (rf(join(dir, "chats", "documents.jsonl"), "utf8") || "")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const convexTopics = (rf(join(dir, "topicQueries", "documents.jsonl"), "utf8") || "")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));

  console.log(`→ Convex had ${convexChats.length} chat(s), ${convexTopics.length} topic query(ies)`);

  // ── 3. restore chats ──────────────────────────────────────────
  let chatsAdded = 0, chatsSkipped = 0;
  for (const c of convexChats) {
    const chatId = Number(c.chatId);
    if (existingChatIds.has(chatId)) { chatsSkipped++; continue; }
    const r = await admin("addChat", {
      chatId,
      title: c.title ?? undefined,
      type: c.type ?? "private",
    });
    if (r.ok) {
      console.log(`  ✓ chat ${chatId} (${c.title}) added`);
      chatsAdded++;
    } else if (/409|already/i.test(String(r.error))) {
      console.log(`  · chat ${chatId} already exists`);
      chatsSkipped++;
    } else {
      console.error(`  ✗ chat ${chatId}: ${r.error}`);
    }
  }

  // ── 4. restore topic queries ──────────────────────────────────
  const existingQueries = new Set(existingTopicQueries.map((t) => t.query));
  let topicsAdded = 0, topicsSkipped = 0;
  for (const t of convexTopics) {
    if (!t.enabled) continue;
    if (existingQueries.has(t.query)) { topicsSkipped++; continue; }
    const r = await admin("upsertTopic", {
      query: t.query,
      category: t.category ?? "iran",
      enabled: true,
    });
    if (r.ok) {
      console.log(`  ✓ topic '${t.query}' [${t.category}] added`);
      topicsAdded++;
    } else {
      console.error(`  ✗ topic '${t.query}': ${r.error}`);
    }
  }

  console.log(``);
  console.log(`Done.`);
  console.log(`  chats:    +${chatsAdded} added, ${chatsSkipped} already present`);
  console.log(`  topics:   +${topicsAdded} added, ${topicsSkipped} already present`);
}

main().catch((err) => {
  console.error("Restore failed:", err);
  process.exit(1);
});
