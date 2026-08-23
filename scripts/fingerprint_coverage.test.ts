// Structural guard for state-hash fingerprint coverage.
//
// The state-hash optimization answers unchanged polls with { __unchanged: true
// } — so a resource whose READ set is wider than its fingerprint goes silently
// stale until a fingerprinted table changes (the cron-health and chat-title
// gaps fixed by migration 0030). This test locks the contract:
//
//   1. The migration's admin_fingerprints() fingerprints EXACTLY the tables in
//      the FINGERPRINTED_RESOURCES manifest (no drift between SQL and code).
//   2. Every table each resource READS (documented below, mirrors the fetchFn
//      bodies in admin/index.ts) is inside its fingerprint.
//   3. The resource keys are exactly the nine stateful dashboard actions.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { FINGERPRINTED_RESOURCES } from "../supabase/functions/admin/_shared.ts";

const MIGRATION = readFileSync("supabase/migrations/0030_state_fingerprint_coverage.sql", "utf8");

// Tables each resource actually reads (from the fetchDashboard* bodies in
// admin/index.ts; RPC-derived counts list the tables dashboard_counts touches).
const RESOURCE_READS: Record<string, string[]> = {
  dashboardSummary: [
    "settings",
    "bots",
    "queue", // via dashboard_counts
    "published_history", // via dashboard_counts
    "polls", // via dashboard_counts
    "translation_failures", // via dashboard_counts
    "ai_usage", // via dashboard_counts
    "cron_job_health",
  ],
  dashboardFeed: ["queue", "activity_log"],
  dashboardQueue: ["queue", "published_history", "chats"], // chats = history title join
  dashboardChats: ["chats"],
  dashboardSources: ["sources", "topic_queries"],
  dashboardAnalytics: ["published_history", "polls"],
  dashboardAi: ["translation_failures", "translation_history"],
  dashboardEvents: ["clusters"],
  dashboardPublished: ["polls"],
};

// Parse each resource block from the migration SQL: every `from public.<t>` in
// the range between this action's name and the next action's name.
function sqlFingerprints(): Record<string, string[]> {
  const actions = Object.keys(FINGERPRINTED_RESOURCES);
  const out: Record<string, string[]> = {};
  for (let i = 0; i < actions.length; i++) {
    const start = MIGRATION.indexOf(`'${actions[i]}', jsonb_build_object(`);
    expect(start, `action ${actions[i]} present in migration`).toBeGreaterThan(-1);
    const end = i + 1 < actions.length ? MIGRATION.indexOf(`'${actions[i + 1]}', jsonb_build_object(`) : MIGRATION.length;
    const block = MIGRATION.slice(start, end);
    const tables = [...block.matchAll(/from public\.(\w+)/g)].map((m) => m[1]);
    out[actions[i]] = tables;
  }
  return out;
}

const sort = (a: string[]) => [...a].sort();

test("resource keys are exactly the nine stateful dashboard actions", () => {
  expect(Object.keys(FINGERPRINTED_RESOURCES).sort()).toEqual([
    "dashboardAi",
    "dashboardAnalytics",
    "dashboardChats",
    "dashboardEvents",
    "dashboardFeed",
    "dashboardPublished",
    "dashboardQueue",
    "dashboardSources",
    "dashboardSummary",
  ]);
  // ...and the reads map documents the same set (no orphan entries).
  expect(Object.keys(RESOURCE_READS).sort()).toEqual(Object.keys(FINGERPRINTED_RESOURCES).sort());
});

test("migration SQL fingerprints exactly what the manifest declares (no drift)", () => {
  const sql = sqlFingerprints();
  for (const [action, tables] of Object.entries(FINGERPRINTED_RESOURCES)) {
    expect(sort(sql[action]), `${action} SQL tables`).toEqual(sort(tables));
  }
});

test("every read table is fingerprinted (an unchanged poll can never hide a change)", () => {
  for (const [action, reads] of Object.entries(RESOURCE_READS)) {
    const fp = FINGERPRINTED_RESOURCES[action];
    for (const t of reads) {
      expect(fp.includes(t), `${action} fingerprints ${t} (reads it)`).toBe(true);
    }
  }
});

test("cron health + chats joins are fingerprinted (the 0030 regression)", () => {
  expect(FINGERPRINTED_RESOURCES.dashboardSummary).toContain("cron_job_health");
  expect(FINGERPRINTED_RESOURCES.dashboardQueue).toContain("chats");
});
