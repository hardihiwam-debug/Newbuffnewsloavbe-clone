import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const queueMigration = readFileSync("supabase/migrations/0035_queue_dedup_and_campaign_status.sql", "utf8");
const lockMigration = readFileSync("supabase/migrations/0038_lock_ownership.sql", "utf8");
const pipeline = readFileSync("supabase/functions/pipeline/index.ts", "utf8");
const publish = readFileSync("supabase/functions/pipeline/publish.ts", "utf8");
const scheduled = readFileSync("supabase/functions/scheduled/index.ts", "utf8");
const webhook = readFileSync("supabase/functions/telegram-webhook/index.ts", "utf8");
const admin = readFileSync("supabase/functions/admin/index.ts", "utf8");
const ai = readFileSync("supabase/functions/pipeline/ai.ts", "utf8");
const shared = readFileSync("supabase/functions/pipeline/_shared.ts", "utf8");
const whyItMattersMigration = readFileSync("supabase/migrations/0040_disable_why_it_matters_by_default.sql", "utf8");
const packageJson = readFileSync("package.json", "utf8");

test("queue migration keeps the oldest duplicate before adding the unique key", () => {
  expect(queueMigration).toContain("a.created_at > b.created_at");
  expect(queueMigration).toContain("create unique index if not exists queue_dedup_key_unique");
  expect(queueMigration).toContain("a.created_at = b.created_at and a.id > b.id");
});

test("execution leases have owner columns and owner-scoped release", () => {
  expect(lockMigration).toContain("publish_run_lock_owner text");
  expect(lockMigration).toContain("scheduled_run_lock_owner text");
  expect(pipeline).toContain("publish_run_lock_owner=eq.${enc(owner)}");
  expect(scheduled).toContain("scheduled_run_lock_owner=eq.${enc(owner)}");
});

test("partial news delivery retains the queue item for missing chats", () => {
  expect(publish).toContain("let eligibleChatCount = 0;");
  expect(publish).toContain("sentThisItem > 0 && sentThisItem === eligibleChatCount");
  expect(publish).toContain("retained for retry");
});

test("scheduled delivery skips chats already logged for the current occurrence", () => {
  expect(scheduled).toContain('rest<Array<{ chat_id: number; ok: boolean; sent_at: string }>>("scheduled_log"');
  expect(scheduled).toContain("const pendingTargets = targets.filter");
  expect(scheduled).toContain("deliveredCount >= targets.length");
});

test("dedicated Telegram webhook reports persistence failure for retry", () => {
  expect(webhook).toContain('return json(500, { ok: false, error: "chat persistence failed" });');
  expect(webhook).toContain("X-Telegram-Bot-Api-Secret-Token");
  expect(packageJson).toContain("telegram-webhook");
});

test("manual chat sync temporarily polls webhook-covered bots and restores discovery", () => {
  expect(admin).toContain("if (url.startsWith(TG_WEBHOOK_BASE))");
  expect(admin).toContain('await tgApi("deleteWebhook", { drop_pending_updates: false }, token)');
  expect(admin).toContain("finally");
  expect(admin).toContain("secret_token: await webhookSecretFor(token)");
});

test("Why-it-matters follow-ups are opt-in by default", () => {
  expect(admin).toContain("whyItMattersEnabled: false,");
  expect(publish).toContain("settings.why_it_matters_enabled === true");
  expect(whyItMattersMigration).toContain("alter column why_it_matters_enabled set default false");
  expect(whyItMattersMigration).toContain("set why_it_matters_enabled = false");
});

test("style examples cannot inject named story facts", () => {
  expect(shared).not.toContain("Bangladesh");
  expect(ai).toContain("STYLE EXAMPLES ARE TONE-ONLY");
});
