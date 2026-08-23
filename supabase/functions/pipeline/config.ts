// Pipeline config: env vars, tuning constants and shared types.
// Extracted verbatim from pipeline/index.ts (split refactor) — no behavior change.





export const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
export const INTERNAL_SECRET = Deno.env.get("INTERNAL_SECRET") ?? "";
export const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
export const NEWSDATA_API_KEY = Deno.env.get("NEWSDATA_API_KEY") ?? "";
export const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
export const MINIMAX_API_KEY = Deno.env.get("MINIMAX_API_KEY") ?? "";
// AI final-dedup provider chain (settings.ai_dedup_provider): only the
// configured provider + Groq fallback are used; these stay empty unless the
// operator adds the keys in the Freebuff Keys UI.
export const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
export const MISTRAL_API_KEY = Deno.env.get("MISTRAL_API_KEY") ?? "";
export const CLOUDFLARE_API_TOKEN = Deno.env.get("CLOUDFLARE_API_TOKEN") ?? "";
export const CLOUDFLARE_ACCOUNT_ID = Deno.env.get("CLOUDFLARE_ACCOUNT_ID") ?? "";
// Cloudflare egress offload (deployed via scripts/deploy_cloudflare_worker.mjs).
// When both are set, heavy outbound fetches (t.me HTML, article pages, media
// bytes) go through the Worker so bytes never cross Supabase's egress budget.
export const CLOUDFLARE_WORKER_URL = (Deno.env.get("CLOUDFLARE_WORKER_URL") ?? "").replace(/\/+$/, "");
export const CLOUDFLARE_RELAY_KEY = Deno.env.get("CLOUDFLARE_RELAY_KEY") ?? "";

// ── Pipeline tuning (operator decisions) ────────────────────────────────────
// Posts sent per MANUAL publish cycle (the dashboard "publish now" path).
// Raising this drains the backlog faster.
export const PUBLISH_BATCH_SIZE = 3;
// Automatic (cron-tick) publish cycles send exactly one post per cycle so a
// burst can never push 2-3 posts out in a single cycle.
export const AUTO_PUBLISH_BATCH_SIZE = 1;
// How many queue candidates a publish cycle may scan before giving up.
// Duplicates / rejects encountered while scanning are deleted or rejected
// (backlog cleanup), but only the first `force` READY items are actually sent.
// This is what keeps a duplicate sitting at the top of the queue from
// blocking the whole cycle: the old code looked at exactly one candidate and
// published nothing whenever that candidate was a duplicate.
export const PUBLISH_SCAN_CAP = 40;
// Instant Telegram channels (per-source speed = "Instant"): every new on-beat
// post is published immediately during the 5-minute fast lane. The publisher
// drains all Instant rows until the worker deadline; no count cap or artificial
// spacing is applied.
export const INSTANT_PUBLISH_CAP = Number.POSITIVE_INFINITY;
// Kept as a compatibility constant for older split-function references. It is
// intentionally zero: Instant sends must never sleep between posts.
export const INSTANT_POST_GAP_MS = 0;
// Ingest net width per cycle. NewsData groups are one API call each (the
// provider's own free tier caps at 200 requests/day, not us).
export const NEWSDATA_MAX_GROUPS = 8;
export const RSS_MAX_QUERIES = 12;
// Per-query cap for Google News RSS. A 1-day feed returns ~100 items per
// query; 12 queries un-capped floods every cycle with ~800 raw items, and the
// ingest's O(n²) in-cycle dedup + gate pipeline then blows past the function
// execution limit (cycle killed mid-ingest, publish lock stuck). 20/query keeps
// the fetch "wide like before" (~180-240 raw items) while staying inside the
// worker budget.
export const RSS_PER_QUERY_CAP = 20;
export const PUBLISHER_FEED_CAP = 15;
export const TELEGRAM_POSTS_PER_CHANNEL = 40;
// Telegram fast-lane (mode === "telegram") runs every ~5 minutes; it only
// needs the newest posts to catch breaking stories, so cap each channel's
// fetch well below the full-ingest width to avoid re-reading 40 old posts
// that are already in the raw_articles dedup window every cycle.
export const TELEGRAM_FAST_LANE_POSTS = 10;
// Telegram snapshot egress guard: t.me/s serves anonymous fetchers a frozen
// SSR snapshot (verified: byte-identical for 25+ min; no ETag/Last-Modified,
// cache-control: no-store). Re-downloading a channel whose post list hasn't
// changed is pure egress waste. After an unchanged snapshot, back the channel
// off this many minutes before fetching it again; the moment the snapshot
// advances (fingerprint changes) the next poll resumes on the 5-minute base.
export const TELEGRAM_SNAPSHOT_BACKOFF_MINUTES = 30;

export function geminiKeys(): Array<{ index: number; key: string }> {
  const out: Array<{ index: number; key: string }> = [];
  for (let i = 1; i <= 6; i++) {
    const k = Deno.env.get(`GEMINI_API_KEY_${i}`)?.trim();
    if (k) out.push({ index: i, key: k });
  }
  return out;
}

// ── Types ────────────────────────────────────────────────────────────────────
export type Article = {
  provider: string;
  sourceName: string | null;
  url: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  videoUrl?: string | null;
  publishedAt: string | null;
  sourceText?: string | null;
  boost?: number;
  mediaKind: "photo" | "video_thumb" | null;
};

export type SettingsRow = Record<string, unknown> & { id?: string };

