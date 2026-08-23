// Applies supabase/migrations/*.sql to the linked project using the Supabase
// Management API SQL endpoint (works without the database password — only the
// access token is required).
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... node scripts/apply_supabase_migrations.mjs
import { readFileSync } from "node:fs";

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
if (!TOKEN || !REF) {
  console.error("Set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF");
  process.exit(1);
}

// Split SQL into top-level statements, respecting single quotes, double
// quotes, dollar-quoted bodies ($tag$ ... $tag$) and -- line comments.
function splitStatements(sql) {
  const out = [];
  let current = "";
  let i = 0;
  let dollarTag = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        current += ch;
        i++;
      }
      continue;
    }
    if (ch === "'") {
      current += ch;
      i++;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      current += ch;
      i++;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "$") {
      const m = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/);
      if (m) {
        dollarTag = m[0];
        current += dollarTag;
        i += dollarTag.length;
        continue;
      }
      current += ch;
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) {
        current += sql.slice(i);
        i = sql.length;
      } else {
        current += sql.slice(i, nl);
        i = nl;
      }
      continue;
    }
    if (ch === ";") {
      const stmt = current.trim();
      if (stmt) out.push(stmt);
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  const tail = current.trim();
  if (tail) out.push(tail);
  return out;
}

const files = [
  "supabase/migrations/0001_init.sql",
  "supabase/migrations/0002_cron.sql",
  "supabase/migrations/0003_cache_and_retention.sql",
  "supabase/migrations/0004_slim.sql",
  "supabase/migrations/0005_telegram_video_bot.sql",
  "supabase/migrations/0006_slim_after_post.sql",
  "supabase/migrations/0007_enable_rls.sql",
  "supabase/migrations/0008_ai_and_idempotency.sql",
  "supabase/migrations/0009_news_quality.sql",
  "supabase/migrations/0011_gemini_first_translation.sql",
  "supabase/migrations/0012_post_links.sql",
  "supabase/migrations/0013_cron_config.sql",
  "supabase/migrations/0014_cron_health.sql",
  "supabase/migrations/0015_cron_5min.sql",
  "supabase/migrations/0016_translation_model_order.sql",
  "supabase/migrations/0017_gateway_gemini_models.sql",
  "supabase/migrations/0018_bots.sql",
  "supabase/migrations/0019_chat_sync.sql",
  "supabase/migrations/0020_remove_bulletin.sql",
  "supabase/migrations/0021_post_source_toggles.sql",
  "supabase/migrations/0022_fetch_source_toggles.sql",
  "supabase/migrations/0023_queue_trim.sql",
  "supabase/migrations/0024_dashboard_aggregates.sql",
  "supabase/migrations/0025_primary_bot_exclusions.sql",
  "supabase/migrations/0026_rewrite_log.sql",
  "supabase/migrations/0027_admin_pin_lockout.sql",
  "supabase/migrations/0028_state_fingerprints.sql",
  "supabase/migrations/0029_rewrite_preview_analytics.sql",
  "supabase/migrations/0030_state_fingerprint_coverage.sql",
  "supabase/migrations/0031_scheduled_posts.sql",
  "supabase/migrations/0032_conflict_categories.sql",
  "supabase/migrations/0033_auto_hashtag.sql",
  "supabase/migrations/0034_analysis_followups_source_tiers.sql",
  "supabase/migrations/0035_queue_dedup_and_campaign_status.sql",
  "supabase/migrations/0036_writing_styles.sql",
  "supabase/migrations/0037_hashtag_rules.sql",
  "supabase/migrations/0038_lock_ownership.sql",
  "supabase/migrations/0039_auto_style_and_source_tier.sql",
  "supabase/migrations/0040_disable_why_it_matters_by_default.sql",
  "supabase/migrations/0041_category_policies.sql",
  "supabase/migrations/0042_category_priority_parity.sql",
  "supabase/migrations/0043_publish_delete.sql",
  "supabase/migrations/0044_age_limits.sql",
  "supabase/migrations/0045_cron_1min.sql",
  "supabase/migrations/0046_cron_customizable.sql",
  "supabase/migrations/0047_english_summary.sql",
  "supabase/migrations/0048_summary_source_routing.sql",
  "supabase/migrations/0049_ai_control_plane.sql",
];
// Optional positional filter: `node scripts/apply_supabase_migrations.mjs 0034`
// applies only the migration(s) whose path contains the argument (e.g. a
// single new migration), instead of re-running the whole idempotent-but-slow
// sequence from 0001.
const filter = process.argv[2];
const targets = filter ? files.filter((f) => f.includes(filter)) : files;
let failed = 0;
for (const file of targets) {
  const sql = readFileSync(file, "utf8");
  const statements = splitStatements(sql);
  for (const stmt of statements) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: stmt }),
    });
    if (res.ok) {
      const prefix = stmt.replace(/\s+/g, " ").slice(0, 80);
      console.log(`OK  ${file}: ${prefix}…`);
    } else {
      failed++;
      const err = await res.text().catch(() => "");
      console.error(`ERR ${file}: ${stmt.replace(/\s+/g, " ").slice(0, 120)}\n    -> ${res.status} ${err.slice(0, 400)}`);
    }
  }
}
// PostgREST caches the schema and does not observe DDL run through the
// Management API — without this, a migration that creates an RPC function is
// invisible to PostgREST (PGRST202) until something else reloads the cache.
if (failed === 0) {
  await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "notify pgrst, 'reload schema';" }),
  }).catch(() => {});
}
console.log(failed === 0 ? "ALL MIGRATIONS APPLIED" : `DONE WITH ${failed} ERROR(S)`);
process.exit(failed === 0 ? 0 : 1);
