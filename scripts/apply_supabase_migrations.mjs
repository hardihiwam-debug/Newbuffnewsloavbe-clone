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
  "supabase/migrations/0010_bulletin_cron.sql",
  "supabase/migrations/0011_gemini_first_translation.sql",
];
let failed = 0;
for (const file of files) {
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
console.log(failed === 0 ? "ALL MIGRATIONS APPLIED" : `DONE WITH ${failed} ERROR(S)`);
process.exit(failed === 0 ? 0 : 1);
