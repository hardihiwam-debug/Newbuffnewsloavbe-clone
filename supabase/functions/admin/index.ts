// Iran Desk Bot — Supabase Edge Function: admin console API.
//
// Replaces the Convex pin-protected queries / mutations / actions used by
// src/routes/_authenticated/dashboard.tsx and settings.tsx. Lets the SPA be
// fully hosted on Supabase + Vite (no Convex runtime), so the project can be
// decommissioned once this lands.
//
// Wire shape:
//   POST /functions/v1/admin
//   body: { action: string, pin: string, ...payload }
//   responses:
//     200 { ok: true,  data: <handler-specific JSON> }
//     400 { error: "missing action" / "invalid JSON body" }
//     403 { error: "Incorrect PIN" }
//     500 { error: <handler error message> }
//
// All DB access goes through PostgREST with the service-role key auto-injected
// by Supabase as SUPABASE_SERVICE_ROLE_KEY. The browser never sends the
// service key; it only sends the PIN, which the function validates against
// the ADMIN_PIN secret. Fail-closed: when ADMIN_PIN is not set, every
// PIN-gated action is denied (there is NO hardcoded default), so the console
// stays locked until the operator configures the secret in the Supabase
// dashboard. Failed guesses are rate-limited per IP through the
// admin_auth_attempts table (5 wrong attempts per 15 minutes → 429 lockout).

import {
  LOCKOUT_WINDOW_MS,
  MAX_FAILED_ATTEMPTS,
  aggregateRewriteAnalytics,
  fingerprintsMatch,
  lockoutSecondsFor,
  serializeStateFingerprint,
  classifySourceTrust,
  derivePipelineControlCenter,
} from "./_shared.ts";
import { TEXT_STYLE_DEFINITIONS } from "../pipeline/_shared.ts";
import { createAiControlHandlers } from "./ai_control_handlers.ts";

// Register additive AI control actions after this module has initialized its
// existing handler table and shared PostgREST helpers.
queueMicrotask(() => {
  Object.assign(handlers, createAiControlHandlers(rest, logActivity));
});

import {
  deleteScheduledCampaign,
  deleteScheduledItem,
  listScheduled,
  saveScheduledCampaign,
  saveScheduledItem,
  scheduledResetItem,
  scheduledSendItem,
  scheduledSendNext,
  scheduledSkipNext,
  setScheduledCampaignStatus,
} from "./scheduled.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ADMIN_PIN = Deno.env.get("ADMIN_PIN") ?? "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const NEWSDATA_API_KEY = Deno.env.get("NEWSDATA_API_KEY") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const MINIMAX_API_KEY =
  Deno.env.get("MINIMAX_API_KEY") ??
  Deno.env.get("VERCEL_AI_GATEWAY_API_KEY") ??
  Deno.env.get("AI_GATEWAY_API_KEY") ??
  "";
const PIPELINE_INTERNAL_SECRET = Deno.env.get("INTERNAL_SECRET") ?? "";
const PIPELINE_URL = `${SUPABASE_URL}/functions/v1/pipeline`;
// Real-time chat-discovery webhook: this function is publicly reachable at
// /functions/v1/admin, so the dispatcher can serve a /telegram-webhook path
// and register chats the moment a bot is added to a channel — instead of
// relying on Telegram's 24h getUpdates retention window.
const TG_WEBHOOK_BASE = `${SUPABASE_URL}/functions/v1/telegram-webhook`;

async function webhookSecretFor(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`telegram-webhook:${token}`));
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Supported translation model chain (kept in sync with the pipeline: the
// bare ids route through the direct Gemini key pool, google/* and minimax/*
// through the Vercel AI Gateway).
const SUPPORTED_GEMINI_MODELS = [
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "minimax/minimax-m3",
];

// ── Errors ──────────────────────────────────────────────────────────────────
class PinError extends Error {
  constructor() { super("Incorrect PIN"); }
}
class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

// ── PIN check ───────────────────────────────────────────────────────────────
// Constant-time-style comparison so an attacker can't time a brute-force pin
// guess off the response latency. Fail-closed: an unset ADMIN_PIN never
// matches, not even the empty string.
function pinMatches(provided: unknown): boolean {
  if (typeof provided !== "string") return false;
  if (!ADMIN_PIN) return false;
  const a = provided.trim();
  const b = ADMIN_PIN.trim();
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ── PIN brute-force lockout (per IP) ────────────────────────────────────────
// The admin function is publicly reachable with the anon key, so "never
// reveal whether the guess was right" is not enough — an attacker can guess
// forever. Each wrong PIN is recorded per client IP in admin_auth_attempts;
// the MAX_FAILED_ATTEMPTS-th failure within LOCKOUT_WINDOW_MS locks that IP
// (HTTP 429) until the window expires. All three helpers fail open on DB
// errors: a hiccup must never lock the operator out, and the PIN check itself
// remains the security boundary.
function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0]?.trim() || "unknown").slice(0, 64);
}

async function lockoutSeconds(ip: string): Promise<number> {
  try {
    const rows = await rest<Array<{ failed_count: number; first_failed_at: string }>>(
      "admin_auth_attempts",
      { query: `ip=eq.${encodeURIComponent(ip)}&limit=1` },
    );
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    return lockoutSecondsFor(rows[0]!.failed_count, rows[0]!.first_failed_at);
  } catch (err) {
    console.error("[admin] lockout check failed (failing open):", err instanceof Error ? err.message : err);
    return 0;
  }
}

async function recordPinFailure(ip: string): Promise<void> {
  try {
    // Lazy prune: drop expired rows while we're here so the table never
    // grows beyond a handful of currently-locked IPs.
    await rest("admin_auth_attempts", {
      method: "DELETE",
      query: `first_failed_at.lt.${new Date(Date.now() - LOCKOUT_WINDOW_MS).toISOString()}`,
    }).catch(() => {});
    const rows = await rest<Array<{ failed_count: number }>>(
      "admin_auth_attempts",
      { query: `ip=eq.${encodeURIComponent(ip)}&limit=1` },
    );
    if (Array.isArray(rows) && rows.length > 0) {
      const count = (rows[0]!.failed_count ?? 0) + 1;
      await rest("admin_auth_attempts", {
        method: "PATCH",
        query: `ip=eq.${encodeURIComponent(ip)}`,
        body: { failed_count: count, updated_at: new Date().toISOString() },
        prefer: "return=minimal",
      });
    } else {
      await rest("admin_auth_attempts", {
        method: "POST",
        body: { ip, failed_count: 1 },
        prefer: "return=minimal",
      });
    }
  } catch (err) {
    console.error("[admin] recordPinFailure failed (failing open):", err instanceof Error ? err.message : err);
  }
}

async function clearPinFailures(ip: string): Promise<void> {
  try {
    await rest("admin_auth_attempts", {
      method: "DELETE",
      query: `ip=eq.${encodeURIComponent(ip)}`,
    });
  } catch {
    // Failing open here is harmless: the next wrong guess just re-creates
    // the row.
  }
}

// ── PostgREST helpers ───────────────────────────────────────────────────────
function restHeaders(prefer?: string): HeadersInit {
  const h: Record<string, string> = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) h["Prefer"] = prefer;
  return h;
}

async function rest<T = unknown>(
  table: string,
  opts: { method?: "GET" | "POST" | "PATCH" | "DELETE"; query?: string; body?: unknown; prefer?: string } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (opts.query) url += `?${opts.query}`;
  const res = await fetch(url, {
    method,
    headers: restHeaders(opts.prefer),
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PostgREST ${method} ${table} [${res.status}]: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  if (method === "GET") {
    return (await res.json().catch(() => [])) as T;
  }
  // PATCH/POST with return=representation returns the row(s).
  if (opts.prefer?.includes("return=representation")) {
    return (await res.json().catch(() => [])) as T;
  }
  return undefined as T;
}

// Snake-case row → camelCase so the SPA (which still expects Convex-style
// keys) doesn't need a rewrite. Numeric/string fields pass through; arrays
// and JSONB remain arrays / objects.
function snakeToCamel<T = Record<string, unknown>>(row: Record<string, unknown> | null | undefined): T {
  const out: Record<string, unknown> = {};
  if (!row) return out as T;
  for (const [k, v] of Object.entries(row)) {
    const camel = k.replace(/_([a-z0-9])/g, (_, m) => m.toUpperCase());
    out[camel] = v;
  }
  // Convex surfaces row ids as `_id`. The UI keys/upserts still read `_id`.
  if ("id" in out && !("_id" in out)) out["_id"] = out["id"];
  return out as T;
}

function snakeArray<T = Record<string, unknown>>(rows: unknown): T[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => snakeToCamel<T>(r as Record<string, unknown>));
}

// ── Activity log ────────────────────────────────────────────────────────────
async function logActivity(entry: { type: string; level: string; message: string; detail?: string; chatId?: number }) {
  try {
    await rest("activity_log", {
      method: "POST",
      body: { type: entry.type, level: entry.level, message: entry.message, detail: entry.detail ?? null, chat_id: entry.chatId ?? null },
      prefer: "return=minimal",
    });
  } catch (e) {
    // Activity logging must never fail the parent handler.
    console.warn("activity_log insert failed:", e instanceof Error ? e.message : e);
  }
}

// ── Defaults ────────────────────────────────────────────────────────────────
// In-memory mirror of the Convex defaults so the dashboard renders even when
// the settings row is missing (fresh DB right after a wipe).
// The category set the pipeline's keywordCategory() can assign. Exposed via
// getDashboard so the bots feature derives its category options from the
// system instead of hard-coding them in the UI (mirrors CATEGORY_PRIORITY in
// pipeline/_shared.ts).
const BOT_CATEGORIES = [
  "iraq",
  "war",
  "iran",
  "proxies",
  "middle-east",
  "analysis",
  "gold",
  "usa",
  "oil",
  "economic-impact",
  "gaza",
  "syria",
  "lebanon",
];

const DEFAULT_TEXT_STYLE_RULES = Object.fromEntries(
  Object.entries(TEXT_STYLE_DEFINITIONS).map(([id, definition]) => [id, {
    rule: definition.rule,
    example: definition.example,
  }]),
);

const DEFAULT_SETTINGS: Record<string, unknown> = {
  defaultLanguage: "en",
  botPaused: false,
  botPausedReason: null,
  dayStart: "08:00",
  dayEnd: "23:00",
  dayMinMinutes: 6,
  dayMaxMinutes: 16,
  nightStart: "23:00",
  nightEnd: "08:00",
  nightMinMinutes: 10,
  nightMaxMinutes: 20,
  breakingInterruptsNight: true,
  breakingCategories: ["war", "iran", "proxies", "usa", "gaza", "syria", "lebanon"],
  autoHashtag: true,
  whyItMattersEnabled: false,
  whyItMattersCategories: ["war", "iran", "proxies", "gaza", "syria", "lebanon", "iraq", "usa"],
  whyItMattersMaxPerDay: 4,
  whyItMattersPrefix: "WHY IT MATTERS — ",
  sourceTierEnabled: true,
  textStyle: "auto",
  textLength: "auto",
  textStyleAuto: true,
  textStyleAiAssist: false,
  styleByCategory: {},
  textStyleRules: DEFAULT_TEXT_STYLE_RULES,
  hashtagRules: {},
  oilMoveThreshold: 3,
  goldMoveThreshold: 2,
  timezone: "Asia/Baghdad",
  eventCooldownHours: 8,
  eventSimilarityThreshold: 0.52,
  sendDelayMs: 3000,
  translationMode: "gemini_first",
  translationModel: "google/gemini-1.5-flash-latest",
  pollsEnabled: true,
  pollsMaxPerHour: 1,
  pollsAutoCloseMinutes: 60,
  pollsCategories: ["war", "iran", "proxies", "usa"],
  pollsDefaultLanguage: "chat",
  pollCadence: "breaking",
  ingestIntervalMinutes: 15,
  publishIntervalMinutes: 10,
  minPostGapMinutes: 1,
  telegramSignalsIntervalMinutes: 5,
  aiDedupEnabled: true,
  aiDedupMode: "both",
  aiDedupWindowHours: 72,
  aiDedupMaxPosts: 30,
  aiDedupProvider: "groq",
  enrichSummaries: true,
  sourceAutoPauseEnabled: true,
  sourceAutoPauseThreshold: 8,
  postFooter: "⚡ Delivered by Freebuff",
  // Telegram video recovery: when "bot_api", the pipeline does
  // forwardMessage -> getFile -> sendVideo on the bot's Saved Messages staging
  // chat (or the staging chat below) to publish real Telegram videos instead
  // of their thumbnails. "off" (default) drops video_thumb posts to text-only
  // with the permalink, never sending the thumb as a photo.
  telegramVideoFetchMode: "bot_api",
  telegramVideoStagingChatId: null,
};

async function getSettings(): Promise<Record<string, unknown>> {
  const rows = await rest<unknown[]>("settings", { query: "limit=1" });
  const first = Array.isArray(rows) ? rows[0] : null;
  const camel = snakeToCamel<Record<string, unknown>>(first as Record<string, unknown>);
  // Ensure every default key exists (delete-then-add migrations lose rows).
  return { ...DEFAULT_SETTINGS, ...camel };
}

async function settingsId(): Promise<string | null> {
  const rows = await rest<unknown[]>("settings", { query: "limit=1&select=id" });
  const first = Array.isArray(rows) ? rows[0] as { id?: string } | undefined : undefined;
  return first?.id ?? null;
}

// ── Dashboard data: split into focused resources ────────────────────────────
// Egress fast-win: the old single getDashboard pulled ~17 datasets (including
// 2,000–5,000-row scans just to count rows) on every poll. The SPA now
// fetches each resource below on its own cadence (feed 5s, summary 10s,
// queue 15s, sources/events/AI/published 30s, analytics 60s) through a shared
// store, so nothing is fetched more than once per interval. getDashboard
// remains as a composition of every resource so the smoke script and any
// older caller keep working unchanged.

function dedupePublishedHistory(
  historyRaw: unknown,
  chats: Array<Record<string, unknown>>,
): any[] {
  const chatsById = new Map<number, string>(
    (chats as any[]).map((c) => [Number(c.chatId), c.title ?? String(c.chatId)]),
  );
  const chatStoryMap = new Map<string, Set<number>>();
  for (const row of snakeArray(historyRaw) as any[]) {
    const cid = Number(row.chatId);
    const set = chatStoryMap.get(row.dedupKey) ?? new Set<number>();
    set.add(cid);
    chatStoryMap.set(row.dedupKey, set);
  }
  const seenKey = new Set<string>();
  const history: any[] = [];
  for (const row of snakeArray(historyRaw) as any[]) {
    if (seenKey.has(row.dedupKey)) continue;
    seenKey.add(row.dedupKey);
    const cids = [...(chatStoryMap.get(row.dedupKey) ?? [])];
    history.push({
      ...row,
      chats: cids.map((cid) => chatsById.get(cid) ?? String(cid)),
    });
    if (history.length >= 100) break;
  }
  return history;
}

async function probeSchemaMigrations(): Promise<{ ok: boolean; missing?: Record<string, string[]> }> {
  // Schema-drift probe (migrations 0005–0009). The pipeline writes columns
  // that only exist in these migrations. If the deployed function outruns the
  // schema (functions and migrations deploy independently), every queue
  // INSERT fails with "column does not exist" — and the pipeline's
  // insertQueueItem swallows that error, so the dashboard shows "N fetched,
  // 0 queued" with no explanation. Probe one representative column per
  // migration; a 400 means the migration was never applied. Surfaced as a
  // banner in the dashboard so the operator sees the cause instead of a
  // mystery.
  const SCHEMA_PROBES: Array<{ table: string; column: string; migration: string }> = [
    { table: "queue", column: "media_kind", migration: "0005_telegram_video_bot.sql" },
    { table: "settings", column: "telegram_video_fetch_mode", migration: "0005_telegram_video_bot.sql" },
    { table: "published_history", column: "status", migration: "0008_ai_and_idempotency.sql" },
    { table: "sources", column: "consecutive_failures", migration: "0008_ai_and_idempotency.sql" },
    { table: "queue", column: "facts", migration: "0009_news_quality.sql" },
    { table: "queue", column: "is_update", migration: "0009_news_quality.sql" },
    { table: "settings", column: "breaking_max_age_hours", migration: "0009_news_quality.sql" },
    { table: "queue", column: "analysis_kind", migration: "0034_analysis_followups_source_tiers.sql" },
    { table: "settings", column: "why_it_matters_enabled", migration: "0034_analysis_followups_source_tiers.sql" },
    { table: "settings", column: "source_tier_enabled", migration: "0034_analysis_followups_source_tiers.sql" },
    { table: "settings", column: "text_style", migration: "0036_writing_styles.sql" },
    { table: "settings", column: "text_length", migration: "0036_writing_styles.sql" },
    { table: "settings", column: "style_by_category", migration: "0036_writing_styles.sql" },
    { table: "settings", column: "hashtag_rules", migration: "0037_hashtag_rules.sql" },
  ];
  const schemaMissing: Record<string, string[]> = {};
  const probeResults = await Promise.all(
    SCHEMA_PROBES.map(async (probe) => {
      try {
        await rest<unknown[]>(probe.table, { query: `select=${probe.column}&limit=1` });
        return null;
      } catch {
        return probe;
      }
    }),
  );
  for (const probe of probeResults) {
    if (probe) (schemaMissing[probe.migration] ??= []).push(`${probe.table}.${probe.column}`);
  }
  return { ok: Object.keys(schemaMissing).length === 0, missing: schemaMissing };
}

async function fetchDashboardSummary(): Promise<Record<string, unknown>> {
  const settings = await getSettings();
  const botsRaw = await rest<unknown[]>("bots", { query: "limit=50" }).catch(() => []);
  // Bot tokens are secrets: the SPA only needs to know whether one is set
  // (and a masked preview). The raw token must never cross the admin API to
  // the browser bundle — only the pipeline (service role) reads bots.token.
  const bots = (snakeArray(botsRaw) as Array<Record<string, unknown>>)
    .sort((a: any, b: any) =>
      String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
    )
    .map((b) => {
      const rawToken = String(b.token ?? "");
      const { token: _omit, ...rest0 } = b;
      return {
        ...rest0,
        tokenConfigured: rawToken.length > 0,
        tokenMasked: rawToken ? `••••${rawToken.slice(-4)}` : null,
      };
    });
  // Single-row DB aggregate (migration 0024) instead of fetching thousands of
  // rows and counting them in JavaScript. Degrades to zeros if the migration
  // hasn't been applied yet so the dashboard never breaks on it.
  let counts: Record<string, unknown> = {};
  try {
    const rows = await rest<Array<Record<string, unknown>>>("rpc/dashboard_counts", {
      method: "POST",
      prefer: "return=representation",
    });
    counts = (Array.isArray(rows) ? rows[0] : rows) ?? {};
  } catch (e) {
    console.warn("[admin] dashboard_counts failed (migration 0024 missing?):", e instanceof Error ? e.message : e);
  }
  const schemaMigrations = await probeSchemaMigrations();
  // Cron scheduler health (migration 0014 exposes cron.job / cron.job_run_details
  // as public.cron_job_health because pg_cron lives in a schema PostgREST does
  // not expose). Degrades to [] if the view is missing or the query fails, so a
  // not-yet-applied migration can never break the dashboard.
  const cronHealthRaw = await rest<unknown[]>("cron_job_health", { query: "limit=50" }).catch(() => []);
  const recentActivityRaw = await rest<unknown[]>("activity_log", { query: "order=created_at.desc&limit=100" }).catch(() => []);
  const recentActivity = snakeArray(recentActivityRaw) as Array<Record<string, unknown>>;
  const quotaLimited = recentActivity.some((row) => {
    const createdAt = Date.parse(String(row.createdAt ?? ""));
    const recentEnough = Number.isFinite(createdAt) && Date.now() - createdAt <= 24 * 60 * 60_000;
    const text = `${String(row.message ?? "")} ${String(row.detail ?? "")}`.toLowerCase();
    return recentEnough && /quota|rate.?limit|429|exhausted/.test(text) && /translation|gemini|model|ai/.test(text);
  });
  const pipelineRun = (settings.pipelineRun as Record<string, unknown> | null | undefined) ?? null;
  const controlCenter = derivePipelineControlCenter({
    paused: Boolean(settings.botPaused),
    pipelineRun,
    lastIngestAt: settings.lastIngestAt as string | null | undefined,
    lastPublishAt: settings.lastPublishAt as string | null | undefined,
    translationQuotaLimited: quotaLimited,
  });
  const currentProvider = String(settings.translationMode ?? "unknown");
  const currentModel = String(settings.translationModel ?? "unknown");
  // AI counters are real database counters. Supabase resource consumption is
  // not exposed by this schema, so do not turn row counts into a fake billing
  // estimate; expose the limitation explicitly for the UI.
  const usage = {
    ai: {
      calls: Number(counts.ai_calls ?? 0),
      promptTokens: Number(counts.ai_prompt_tokens ?? 0),
      completionTokens: Number(counts.ai_completion_tokens ?? 0),
    },
    supabase: {
      tracked: false,
      note: "Supabase compute, bandwidth, and quota usage are not available through the current application schema.",
    },
  };
  // Stuck deliveries: published_history rows reserved with status 'sending'
  // that were never flipped to 'sent' (worker killed between Telegram accept
  // and the DB PATCH). They block re-delivery by design (no duplicates) but
  // can strand a post forever — the KPI + Published-page reconcile panel
  // surface them so the operator can mark-sent or delete-and-retry.
  const sendingRaw = await rest<Array<Record<string, unknown>>>("published_history", {
    query: "status=eq.sending&select=id&limit=1000",
  }).catch(() => []);
  return {
    settings,
    bots,
    categories: BOT_CATEGORIES,
    queuedTotal: Number(counts.queued_total ?? 0),
    published24h: Number(counts.published_24h ?? 0),
    polls24h: Number(counts.polls_24h ?? 0),
    translationFails24h: Number(counts.translation_fails_24h ?? 0),
    stuckSending: sendingRaw?.length ?? 0,
    aiUsage24h: {
      calls: Number(counts.ai_calls ?? 0),
      promptTokens: Number(counts.ai_prompt_tokens ?? 0),
      completionTokens: Number(counts.ai_completion_tokens ?? 0),
      byProvider: (counts.ai_by_provider as Record<string, unknown>) ?? {},
    },
    controlCenter,
    currentProvider,
    currentModel,
    usage,
    schemaMigrations,
    cronHealth: snakeArray(cronHealthRaw),
    botConfigured: Boolean(TELEGRAM_BOT_TOKEN),
    newsdataConfigured: Boolean(NEWSDATA_API_KEY),
  };
}

async function fetchDashboardFeed(): Promise<Record<string, unknown>> {
  const [queueRaw, activityRaw] = await Promise.all([
    rest<unknown[]>("queue", { query: "status=eq.queued&limit=100" }),
    rest<unknown[]>("activity_log", { query: "order=created_at.desc&limit=30" }),
  ]);
  const queue = snakeArray(queueRaw).sort((a: any, b: any) => {
    if (Boolean(a.breaking) !== Boolean(b.breaking)) return a.breaking ? -1 : 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });
  return { queue: queue.slice(0, 50), recentActivity: snakeArray(activityRaw) };
}

async function fetchDashboardQueue(): Promise<Record<string, unknown>> {
  // Chats are deliberately NOT shipped in full here anymore: the full list
  // lives in dashboardChats (Settings-only, mount-on-demand). History dedup
  // only needs chat titles for its `chats: [...]` join, so fetch just the two
  // columns — a couple KB instead of the old 500-row full payload.
  const [queueAllRaw, historyRaw, sendingRaw, chatsLightRaw] = await Promise.all([
    rest<unknown[]>("queue", { query: "order=created_at.desc&limit=100" }),
    rest<unknown[]>("published_history", { query: "order=published_at.desc&limit=100" }),
    rest<unknown[]>("published_history", { query: "status=eq.sending&order=published_at.desc&limit=50" }),
    rest<unknown[]>("chats", { query: "select=chat_id,title&limit=200" }),
  ]);
  const chatsById = new Map<number, string>(
    ((chatsLightRaw as unknown[]) ?? []).map((c) => [Number((c as Record<string, unknown>).chat_id), String((c as Record<string, unknown>).title ?? Number((c as Record<string, unknown>).chat_id))]),
  );
  // Stuck 'sending' rows, per-chat, with the chat title resolved so the
  // reconcile panel can name the destination. Kept separate from `history`
  // (which is the dedup-merged delivered archive).
  const sending = snakeArray(sendingRaw).map((r: Record<string, unknown>) => ({
    ...r,
    chatTitle: chatsById.get(Number(r.chatId)) ?? String(r.chatId ?? ""),
  }));
  return {
    queueAll: snakeArray(queueAllRaw),
    history: dedupePublishedHistory(historyRaw, chatsLightRaw),
    sending,
  };
}

async function fetchDashboardChats(): Promise<Record<string, unknown>> {
  const chatsRaw = await rest<unknown[]>("chats", { query: "limit=200" });
  const chats = snakeArray(chatsRaw).sort((a: any, b: any) =>
    String(b.lastSeenAt ?? "").localeCompare(String(a.lastSeenAt ?? "")),
  );
  return { chats };
}

async function fetchDashboardSources(): Promise<Record<string, unknown>> {
  const [sourcesRaw, topicsRaw] = await Promise.all([
    rest<unknown[]>("sources", { query: "limit=200" }),
    rest<unknown[]>("topic_queries", { query: "limit=200" }),
  ]);
  const sources = snakeArray(sourcesRaw) as Array<Record<string, unknown>>;
  const trust = sources.map((source) => classifySourceTrust(source as any));
  return {
    sources: sources.sort((a: any, b: any) =>
      (a.priority ?? 0) - (b.priority ?? 0),
    ),
    sourceTrust: trust,
    sourceTrustNote: "Trust is derived from source health and the stored accepted/rejected counters when populated. Duplicate, thin-body, date, translation, and quality rates are not source-linked yet.",
    topics: snakeArray(topicsRaw).sort((a: any, b: any) =>
      String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
    ),
  };
}

async function fetchDashboardAnalytics(): Promise<Record<string, unknown>> {
  // 14-day series computed in SQL (migration 0024) — the old path fetched up
  // to 2,000 published_history + 2,000 polls rows per poll to build this.
  let days: Array<{ date: string; published: number; breaking: number; polls: number }> = [];
  try {
    const rows = await rest<Array<Record<string, unknown>>>("rpc/dashboard_analytics", {
      method: "POST",
      prefer: "return=representation",
    });
    days = (Array.isArray(rows) ? rows : []).map((r) => ({
      date: String(r.date ?? ""),
      published: Number(r.published ?? 0),
      breaking: Number(r.breaking ?? 0),
      polls: Number(r.polls ?? 0),
    }));
  } catch (e) {
    console.warn("[admin] dashboard_analytics failed (migration 0024 missing?):", e instanceof Error ? e.message : e);
  }
  return { analytics: days };
}

async function fetchDashboardAi(): Promise<Record<string, unknown>> {
  const [failsRaw, histRaw] = await Promise.all([
    rest<unknown[]>("translation_failures", { query: "order=created_at.desc&limit=50" }),
    rest<unknown[]>("translation_history", { query: "order=created_at.desc&limit=50" }),
  ]);
  return {
    translationFailures: snakeArray(failsRaw),
    translationHistory: snakeArray(histRaw),
  };
}

async function fetchDashboardEvents(): Promise<Record<string, unknown>> {
  const clustersRaw = await rest<unknown[]>("clusters", {
    query: "order=last_seen_at.desc.nullslast&limit=100",
  });
  return { clusters: snakeArray(clustersRaw) };
}

async function fetchDashboardPublished(): Promise<Record<string, unknown>> {
  const pollsRaw = await rest<unknown[]>("polls", { query: "order=created_at.desc&limit=100" });
  return { polls: snakeArray(pollsRaw) };
}

// ── State-hash conditional polling (egress fast-win) ───────────────────────
// The SPA polls the 9 dashboard resources on cadences of 10s–5min. Most polls
// find nothing changed, yet each used to ship the full payload (queue rows,
// history, chats, usage). Each resource now answers from
// admin_fingerprints() (migration 0028): the client sends
// `ifState[action]` = the fingerprint it last saw; if it still matches, the
// function answers `{ __unchanged: true, __fingerprint }` (~100 bytes) and
// the SPA keeps its copy. Real responses carry the fresh fingerprint so the
// client can store it. If the RPC is missing (migration not applied) the
// map is empty and every poll falls through to the full payload (fail open).
const FINGERPRINT_CACHE_MS = 2_000;
let fpCache: Record<string, unknown> | null = null;
let fpCacheAt = 0;

async function fingerprints(): Promise<Record<string, unknown>> {
  if (fpCache && Date.now() - fpCacheAt < FINGERPRINT_CACHE_MS) return fpCache;
  try {
    const rows = await rest<unknown>("rpc/admin_fingerprints", {
      method: "POST",
      prefer: "return=representation",
    });
    let obj: Record<string, unknown> = {};
    if (Array.isArray(rows)) {
      const first = (rows[0] ?? {}) as Record<string, unknown>;
      const nested = first.admin_fingerprints;
      obj =
        nested && typeof nested === "object"
          ? (nested as Record<string, unknown>)
          : first;
    } else if (rows && typeof rows === "object") {
      obj = rows as Record<string, unknown>;
    }
    fpCache = obj;
    fpCacheAt = Date.now();
    return obj;
  } catch (e) {
    console.warn(
      "[admin] admin_fingerprints failed (migration 0028 missing?):",
      e instanceof Error ? e.message : e,
    );
    return {};
  }
}

async function statefulDashboard<T extends Record<string, unknown>>(
  action: string,
  p: Record<string, unknown>,
  fetchFn: () => Promise<T>,
): Promise<unknown> {
  const current = await fingerprints();
  const cur = current[action];
  // admin_fingerprints() emits a nested OBJECT per resource; serialize it to a
  // stable string so the client can round-trip it verbatim (jsonb key order is
  // deterministic for identical data). null when the RPC/migration is missing
  // → never matches → full payload (fail open).
  const fpStr = serializeStateFingerprint(cur);
  const sent = (p.ifState as Record<string, unknown> | undefined)?.[action];
  if (fpStr !== null && fingerprintsMatch(sent, fpStr)) {
    return { __unchanged: true, __fingerprint: fpStr };
  }
  const data = await fetchFn();
  return { ...data, __fingerprint: fpStr };
}

// ── Action: getDashboard ────────────────────────────────────────────────────
// Backward-compatible composition of every focused resource (the smoke script
// and any older caller still use this single action).
async function getDashboard(_p: Record<string, unknown>): Promise<unknown> {
  const [summary, feed, queueRes, chatsRes, sources, analytics, ai, events, published] = await Promise.all([
    fetchDashboardSummary(),
    fetchDashboardFeed(),
    fetchDashboardQueue(),
    fetchDashboardChats(),
    fetchDashboardSources(),
    fetchDashboardAnalytics(),
    fetchDashboardAi(),
    fetchDashboardEvents(),
    fetchDashboardPublished(),
  ]);
  return {
    ...summary,
    ...feed,
    ...queueRes,
    ...chatsRes,
    ...sources,
    ...analytics,
    ...ai,
    ...events,
    ...published,
    isOwner: true,
  };
}

// ── Action: saveSettings ────────────────────────────────────────────────────
// camelCase (SPA contract) -> snake_case (PostgREST column names).
function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

async function saveSettings(p: { patch: Record<string, unknown> }): Promise<unknown> {
  // The SPA sends camelCase keys (Convex-style). Convert to snake_case column
  // names, otherwise every dashboard save fails with "Could not find the
  // 'postFooter' column".
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.patch ?? {})) {
    patch[camelToSnake(k)] = v;
  }
  const id = await settingsId();
  if (!id) {
    await rest("settings", {
      method: "POST",
      body: { ...patch, updated_at: new Date().toISOString() },
      prefer: "return=minimal",
    });
  } else {
    await rest(`settings?id=eq.${id}`, {
      method: "PATCH",
      body: { ...patch, updated_at: new Date().toISOString() },
      prefer: "return=minimal",
    });
  }
  await logActivity({
    type: "admin",
    level: "info",
    message: "Settings updated",
    detail: Object.keys(p.patch ?? {}).slice(0, 8).join(", ") || undefined,
  });
  return { ok: true };
}

async function setPauseState(p: { paused: boolean; reason?: string | null }): Promise<unknown> {
  const id = await settingsId();
  if (!id) throw new HttpError(404, "Settings row missing");
  const body: Record<string, unknown> = { bot_paused: p.paused };
  if (p.paused) {
    body.bot_paused_reason = p.reason?.trim() || "Paused by admin";
    body.bot_paused_at = new Date().toISOString();
  } else {
    body.bot_paused_reason = null;
    body.bot_paused_at = null;
  }
  await rest(`settings?id=eq.${id}`, { method: "PATCH", body, prefer: "return=minimal" });
  await logActivity({
    type: "system",
    level: p.paused ? "warning" : "success",
    message: p.paused
      ? `Bot paused${p.reason ? ` — ${p.reason}` : ""}`
      : "Bot services resumed",
  });
  return { ok: true };
}

const ALLOWED_CRON_SCHEDULES = ["* * * * *", "*/2 * * * *", "*/5 * * * *", "*/10 * * * *", "*/15 * * * *"];

// Operator picks the pipeline ticker cadence (Settings → Scheduler). The
// whitelist lives inside the SQL function too — this check just gives a
// friendly 400 instead of a raw SQL error.
async function setCronSchedule(p: { schedule?: string }): Promise<unknown> {
  const schedule = String(p.schedule ?? "").trim();
  if (!ALLOWED_CRON_SCHEDULES.includes(schedule)) {
    throw new HttpError(400, `schedule must be one of: ${ALLOWED_CRON_SCHEDULES.join(", ")}`);
  }
  const r = await rest<Array<Record<string, unknown>>>("rpc/set_pipeline_cron_schedule", {
    method: "POST",
    body: { p_schedule: schedule },
  });
  // Persist the operator's choice for display (the RPC deliberately does not
  // touch tables - PostgREST guard). Best-effort.
  const sid = await settingsId();
  if (sid) {
    await rest(`settings?id=eq.${sid}`, {
      method: "PATCH",
      body: { cron_schedule: schedule, updated_at: new Date().toISOString() },
      prefer: "return=minimal",
    }).catch(() => {});
  }
  const applied = Array.isArray(r) ? String((r[0]?.set_pipeline_cron_schedule as string) ?? schedule) : schedule;
  await logActivity({
    type: "admin",
    level: "info",
    message: `Pipeline ticker schedule set to "${applied}"`,
  });
  return { ok: true, schedule: applied };
}

async function setTranslationModel(p: { model: string }): Promise<unknown> {
  const requested = p.model.trim();
  const normalized =
    requested.startsWith("google/") ||
    requested.startsWith("gemini-") ||
    requested.startsWith("minimax/")
      ? requested
      : `google/${requested}`;
  if (!SUPPORTED_GEMINI_MODELS.includes(normalized)) {
    throw new HttpError(
      400,
      `Unsupported model "${normalized}". Supported: ${SUPPORTED_GEMINI_MODELS.join(", ")}`,
    );
  }
  const id = await settingsId();
  if (!id) throw new HttpError(404, "Settings row missing");
  await rest(`settings?id=eq.${id}`, {
    method: "PATCH",
    body: { translation_model: normalized, updated_at: new Date().toISOString() },
    prefer: "return=minimal",
  });
  await logActivity({ type: "translation", level: "info", message: `Translation model switched to ${normalized}` });
  return { ok: true, model: normalized };
}

// ── Action: chats ───────────────────────────────────────────────────────────
async function updateChat(p: {
  id: string;
  active?: boolean;
  language?: string | null;
  pollsEnabled?: boolean | null;
  botId?: string | null;
  remove?: boolean;
}): Promise<unknown> {
  if (p.remove) {
    await rest(`chats?id=eq.${encodeURIComponent(p.id)}`, { method: "DELETE", prefer: "return=minimal" });
    await logActivity({ type: "chat", level: "info", message: "Chat removed from dashboard", detail: p.id });
    return { ok: true };
  }
  const patch: Record<string, unknown> = {};
  if (p.active !== undefined) patch.active = p.active;
  if (p.language !== undefined) patch.language = p.language || null;
  if (p.pollsEnabled !== undefined) patch.polls_enabled = p.pollsEnabled ?? null;
  if (p.botId !== undefined) patch.bot_id = p.botId || null;
  await rest(`chats?id=eq.${encodeURIComponent(p.id)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
  await logActivity({
    type: "chat",
    level: "info",
    message: "Chat updated",
    detail: Object.keys(patch).map((k) => `${k}=${String(patch[k])}`).join(", ") || undefined,
  });
  return { ok: true };
}

// ── Action: bots (N-bot delivery) ─────────────────────────────────────────
// The operator registers any number of Telegram bots from Settings. Each bot
// has a name, a token (stored in the DB — the operator explicitly chose
// Settings-editable over env secrets for additional bots), an optional
// category whitelist (null/[] = all categories) and an enabled switch.
async function saveBot(p: {
  id?: string;
  name?: string;
  token?: string | null;
  categories?: string[] | null;
  enabled?: boolean;
}): Promise<unknown> {
  const name = String(p.name ?? "").trim();
  const token = String(p.token ?? "").trim();
  const categories = Array.isArray(p.categories) ? p.categories.filter(Boolean).map(String) : null;
  if (p.id) {
    // Update path: only the fields the UI actually sent change. The category
    // toggle sends { id, categories } with NO name — it must not be rejected
    // or wipe the stored name.
    const patch: Record<string, unknown> = {};
    if (name) patch.name = name;
    // Token is explicitly clearable: the UI sends token: "" to remove it, so
    // distinguish "not sent" (undefined → leave unchanged) from "cleared".
    if (p.token !== undefined) patch.token = token || null;
    if (p.categories !== undefined) patch.categories = categories;
    if (p.enabled !== undefined) patch.enabled = Boolean(p.enabled);
    await rest(`bots?id=eq.${encodeURIComponent(p.id)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
    await logActivity({ type: "chat", level: "info", message: `Bot "${name || p.id}" updated` });
  } else {
    if (!name) throw new HttpError(400, "Bot name is required");
    const inserted = await rest<Array<{ id: string }>>("bots", {
      method: "POST",
      body: {
        name,
        token: token || null,
        categories,
        enabled: p.enabled !== false,
        created_at: new Date().toISOString(),
      },
      prefer: "return=representation",
    });
    const botId = (inserted as Array<{ id: string }> | null)?.[0]?.id;
    await logActivity({ type: "chat", level: "info", message: `Bot "${name}" registered` });
    // The whole point of an additional bot is delivering to chats where it
    // (not the primary bot) is a member/admin. Auto-discover those chats
    // right away so the operator's "add token → pick categories" flow starts
    // delivering without a separate manual sync step. Best-effort: a bot with
    // no chats yet just contributes zero rows.
    if (botId && token) {
      try {
        await scanBotChats(token, botId, name);
      } catch (e) {
        await logActivity({ type: "chat", level: "warning", message: `Chat discovery for bot "${name}" failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }
  return { ok: true };
}

async function deleteBot(p: { id: string }): Promise<unknown> {
  if (!p.id) throw new HttpError(400, "Bot id is required");
  await rest(`bots?id=eq.${encodeURIComponent(p.id)}`, { method: "DELETE", prefer: "return=minimal" });
  // chats.bot_id is ON DELETE SET NULL, so chats assigned to this bot revert to
  // the primary bot automatically — nothing else to clean up.
  await logActivity({ type: "chat", level: "info", message: "Bot deleted", detail: p.id });
  return { ok: true };
}

async function addChat(p: { chatId: number; title?: string; type?: string }): Promise<unknown> {
  const existing = await rest<unknown[]>("chats", { query: `chat_id=eq.${p.chatId}&limit=1` });
  if (Array.isArray(existing) && existing.length > 0) {
    throw new HttpError(409, `Chat ${p.chatId} is already registered`);
  }
  const now = new Date().toISOString();
  await rest("chats", {
    method: "POST",
    body: {
      chat_id: p.chatId,
      title: p.title?.trim() || null,
      type: p.type ?? "private",
      active: true,
      last_seen_at: now,
      created_at: now,
    },
    prefer: "return=minimal",
  });
  await logActivity({
    type: "chat",
    level: "success",
    message: `Chat added manually: ${p.title?.trim() || String(p.chatId)}`,
    detail: `chatId=${p.chatId} · type=${p.type ?? "private"}`,
  });
  return { ok: true, chatId: p.chatId };
}

// ── Action: topics ───────────────────────────────────────────────────────────
async function upsertTopic(p: {
  id?: string;
  query?: string;
  category?: string;
  enabled?: boolean;
  remove?: boolean;
}): Promise<unknown> {
  if (p.remove && p.id) {
    await rest(`topic_queries?id=eq.${encodeURIComponent(p.id)}`, { method: "DELETE", prefer: "return=minimal" });
    await logActivity({ type: "admin", level: "info", message: `Topic removed: ${p.query ?? p.id}` });
    return { ok: true };
  }
  if (p.id) {
    const patch: Record<string, unknown> = {};
    if (p.enabled !== undefined) patch.enabled = p.enabled;
    if (p.query) patch.query = p.query;
    if (p.category) patch.category = p.category;
    await rest(`topic_queries?id=eq.${encodeURIComponent(p.id)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
    await logActivity({
      type: "admin",
      level: "info",
      message:
        p.enabled !== undefined
          ? `Topic ${p.enabled ? "enabled" : "disabled"}: ${p.query ?? ""}`
          : `Topic updated: ${p.query ?? p.id}`,
    });
  } else if (p.query) {
    await rest("topic_queries", {
      method: "POST",
      body: { query: p.query, category: p.category ?? "iran", enabled: true, created_at: new Date().toISOString() },
      prefer: "return=minimal",
    });
    await logActivity({
      type: "admin",
      level: "info",
      message: `Topic added: ${p.query}`,
      detail: p.category ?? "iran",
    });
  }
  return { ok: true };
}

// ── Action: sources ─────────────────────────────────────────────────────────
async function upsertSource(p: {
  id?: string;
  name?: string;
  kind?: string;
  secretRef?: string | null;
  priority?: number;
  enabled?: boolean;
  boost?: number;
  remove?: boolean;
}): Promise<unknown> {
  if (p.remove && p.id) {
    await rest(`sources?id=eq.${encodeURIComponent(p.id)}`, { method: "DELETE", prefer: "return=minimal" });
    await logActivity({ type: "admin", level: "info", message: `Provider removed: ${p.name ?? p.id}` });
    return { ok: true };
  }
  if (p.id) {
    const existing = await rest<unknown[]>("sources", { query: `id=eq.${encodeURIComponent(p.id)}&limit=1` });
    const cur = (Array.isArray(existing) ? existing[0] : null) as Record<string, unknown> | null;
    const patch: Record<string, unknown> = {};
    if (p.enabled !== undefined) {
      patch.enabled = p.enabled;
      if (p.enabled) {
        // Manual enable = operator override: clear auto-pause + reject streak.
        patch.auto_paused = null;
        patch.auto_pause_reason = null;
        patch.consecutive_rejects = 0;
      }
    }
    if (p.name) patch.name = p.name;
    if (p.kind) patch.kind = p.kind;
    if (p.secretRef !== undefined) patch.secret_ref = p.secretRef || null;
    if (p.priority !== undefined) patch.priority = p.priority;
    if (cur?.kind === "telegram") {
      const cfg = { ...((cur.config as object) ?? {}) } as Record<string, unknown>;
      if (p.name) cfg.channel = p.name.replace(/^@/, "").trim();
      if (p.boost !== undefined) cfg.boost = p.boost;
      patch.config = cfg;
    }
    await rest(`sources?id=eq.${encodeURIComponent(p.id)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
    await logActivity({
      type: "admin",
      level: "info",
      message:
        p.enabled !== undefined
          ? `Provider ${p.enabled ? "enabled" : "disabled"}: ${p.name ?? p.id}`
          : `Provider updated: ${p.name ?? p.id}`,
    });
  } else if (p.name && p.kind) {
    const cfg = p.kind === "telegram" ? { channel: p.name.replace(/^@/, "").trim() } : {};
    await rest("sources", {
      method: "POST",
      body: {
        name: p.name,
        kind: p.kind,
        secret_ref: p.secretRef ?? null,
        config: cfg,
        priority: p.priority ?? 100,
        used_today: 0,
        quota_date: new Date().toISOString().slice(0, 10),
        enabled: true,
        created_at: new Date().toISOString(),
      },
      prefer: "return=minimal",
    });
    await logActivity({
      type: "admin",
      level: "info",
      message: `Provider added: ${p.name}`,
      detail: `${p.kind} · priority ${p.priority ?? 100}`,
    });
  }
  return { ok: true };
}

// ── Action: translation keys ────────────────────────────────────────────────
async function listTranslationKeys(_p: Record<string, unknown>): Promise<unknown> {
  const rowsRaw = await rest<unknown[]>("translation_provider_keys", { query: "limit=500" });
  const keys = snakeArray(rowsRaw)
    .map((k: any) => ({
      ...k,
      apiKey: k.apiKey ? `${String(k.apiKey).slice(0, 6)}...` : null,
    }))
    .sort((a: any, b: any) =>
      String(a.provider ?? "").localeCompare(String(b.provider ?? "")) ||
      (a.priority ?? 0) - (b.priority ?? 0),
    );

  const hardcodedGemini: { index: number; first8: string; last4: string; email: string }[] = [];
  for (let i = 1; i <= 6; i++) {
    const key = Deno.env.get(`GEMINI_API_KEY_${i}`)?.trim() ?? "";
    if (key) hardcodedGemini.push({ index: i, first8: key.slice(0, 8), last4: key.slice(-4), email: Deno.env.get(`GEMINI_API_EMAIL_${i}`)?.trim() ?? "" });
  }

  // Per-key × per-model usage (from gemini_key_usage + recent gemini_call_log).
  const usageRows = await rest<unknown[]>("gemini_key_usage", { query: "limit=2000" });
  const logRows = await rest<unknown[]>("gemini_call_log", { query: "order=at.desc&limit=400" });
  const todayStr = new Date().toISOString().slice(0, 10);
  const empty = () => ({ calls: 0, ok: 0, rateLimited: 0, otherErrors: 0 });
  const geminiUsage: Array<{
    keyIndex: number;
    first8: string;
    last4: string;
    email: string;
    configured: boolean;
    today: ReturnType<typeof empty>;
    total: ReturnType<typeof empty>;
    models: Record<string, ReturnType<typeof empty>>;
    unused: boolean;
  }> = [];
  for (let i = 1; i <= 6; i++) {
    const envKey = Deno.env.get(`GEMINI_API_KEY_${i}`)?.trim() ?? "";
    const configured = Boolean(envKey);
    const today = empty();
    const models: Record<string, ReturnType<typeof empty>> = {};
    for (const row of (Array.isArray(usageRows) ? usageRows : []) as any[]) {
      if (Number(row.key_index) !== i) continue;
      const m = (models[row.model] ??= empty());
      m.calls += Number(row.calls ?? 0);
      m.ok += Number(row.ok ?? 0);
      m.rateLimited += Number(row.rate_limited ?? 0);
      m.otherErrors += Number(row.other_errors ?? 0);
      if (row.day === todayStr) {
        today.calls += Number(row.calls ?? 0);
        today.ok += Number(row.ok ?? 0);
        today.rateLimited += Number(row.rate_limited ?? 0);
        today.otherErrors += Number(row.other_errors ?? 0);
      }
    }
    const logModels: Record<string, ReturnType<typeof empty>> = {};
    for (const row of (Array.isArray(logRows) ? logRows : []) as any[]) {
      if (Number(row.key_index) !== i) continue;
      const m = (logModels[row.model] ??= empty());
      m.calls += 1;
      if (row.ok) m.ok += 1;
      else if (Number(row.code) === 429) m.rateLimited += 1;
      else m.otherErrors += 1;
    }
    for (const [model, lm] of Object.entries(logModels)) {
      const m = (models[model] ??= empty());
      m.calls = Math.max(m.calls, lm.calls);
      m.ok = Math.max(m.ok, lm.ok);
      m.rateLimited = Math.max(m.rateLimited, lm.rateLimited);
      m.otherErrors = Math.max(m.otherErrors, lm.otherErrors);
    }
    const total = empty();
    for (const m of Object.values(models)) {
      total.calls += m.calls;
      total.ok += m.ok;
      total.rateLimited += m.rateLimited;
      total.otherErrors += m.otherErrors;
    }
    geminiUsage.push({
      keyIndex: i,
      first8: envKey.slice(0, 8),
      last4: envKey.slice(-4),
      email: Deno.env.get(`GEMINI_API_EMAIL_${i}`)?.trim() ?? "",
      configured,
      today,
      total,
      models,
      unused: total.calls === 0,
    });
  }
  return {
    keys,
    envDefaults: {
      gemini: hardcodedGemini.length,
      minimax: Boolean(MINIMAX_API_KEY),
    },
    hardcodedGemini,
    geminiUsage,
  };
}

async function upsertTranslationKey(p: {
  id?: string;
  provider: string;
  label: string;
  apiKey?: string;
  model: string;
  enabled?: boolean;
  priority?: number;
  remove?: boolean;
}): Promise<unknown> {
  if (p.remove && p.id) {
    await rest(`translation_provider_keys?id=eq.${encodeURIComponent(p.id)}`, {
      method: "DELETE",
      prefer: "return=minimal",
    });
    await logActivity({ type: "translation", level: "info", message: `Translation key removed: ${p.label}` });
    return { ok: true };
  }
  const now = new Date().toISOString();
  if (p.id) {
    const patch: Record<string, unknown> = {
      provider: p.provider,
      label: p.label,
      model: p.model,
      enabled: p.enabled ?? true,
      priority: p.priority ?? 100,
      updated_at: now,
    };
    if (p.apiKey?.trim()) patch.api_key = p.apiKey.trim();
    await rest(`translation_provider_keys?id=eq.${encodeURIComponent(p.id)}`, {
      method: "PATCH",
      body: patch,
      prefer: "return=minimal",
    });
  } else {
    if (!p.apiKey?.trim()) throw new HttpError(400, "API key is required");
    await rest("translation_provider_keys", {
      method: "POST",
      body: {
        provider: p.provider,
        label: p.label,
        api_key: p.apiKey.trim(),
        model: p.model,
        enabled: p.enabled ?? true,
        priority: p.priority ?? 100,
        consecutive_failures: 0,
        created_at: now,
        updated_at: now,
      },
      prefer: "return=minimal",
    });
  }
  await logActivity({
    type: "translation",
    level: "info",
    message: p.id ? `Translation key updated: ${p.label}` : `Translation key added: ${p.label}`,
    detail: `${p.provider} · ${p.model}`,
  });
  return { ok: true };
}

// ── Action: listTranslationModels ───────────────────────────────────────────
// Returns BOTH the old Convex shape ({ supported, current }) that settings.tsx
// consumes and the { models } shape used by the port — so the SPA contract is
// preserved exactly.
async function listTranslationModels(_p: Record<string, unknown>): Promise<unknown> {
  const settings = await getSettings();
  const current =
    String(settings.translationModel ?? "").trim() || SUPPORTED_GEMINI_MODELS[0]!;
  return {
    supported: SUPPORTED_GEMINI_MODELS,
    current,
    models: SUPPORTED_GEMINI_MODELS,
  };
}

// ── Action: telegram helpers ────────────────────────────────────────────────
// `token` defaults to the primary env bot so existing callers are unchanged;
// the multi-bot sync passes an additional bot's stored token to reach chats
// where only that bot is a member/admin.
async function tgApi(method: string, body?: Record<string, unknown>, token = TELEGRAM_BOT_TOKEN): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  if (!token) throw new HttpError(503, "Telegram bot token not configured");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  return (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as any;
}

// Register every chat visible in one Telegram bot's getUpdates stream. When
// `botId` is set the new rows carry bot_id so the pipeline routes them through
// that bot's token + category whitelist; `botId` null = the primary env bot.
// Existing rows are never stolen or re-pointed — the operator's assignment in
// Settings wins.
async function scanBotChats(token: string, botId: string | null, label: string): Promise<{ added: number; scanned: number; error?: string }> {
  // my_chat_member fires when the bot is added to/removed from a group or
  // channel — without it, "bot was just made admin" events are missed.
  const ALLOWED = ["message", "channel_post", "my_chat_member"];
  let r = await tgApi("getUpdates", { timeout: 0, limit: 100, allowed_updates: ALLOWED }, token);
  // A bot with an active webhook can't use getUpdates (Telegram rejects the
  // call). Some bots carry a leftover webhook from an older deployment, which
  // silently made discovery impossible. Temporarily remove the webhook, poll
  // once, then restore it exactly as it was (url + allowed_updates + limits).
  if (!r.ok && /webhook/i.test(String(r.description ?? ""))) {
    const info = await tgApi("getWebhookInfo", undefined, token);
    const wh = info?.ok ? (info.result as Record<string, unknown> | null) : null;
    const url = String(wh?.url ?? "").trim();
    // Telegram rejects getUpdates while ANY webhook is active. For this app's
    // own discovery webhook, temporarily switch to polling so the manual
    // Sync chats button can also drain pending updates for additional bots.
    // Always restore the webhook in finally: discovery must not be disabled by
    // a failed or timed-out sync.
    if (url.startsWith(TG_WEBHOOK_BASE)) {
      await tgApi("deleteWebhook", { drop_pending_updates: false }, token).catch(() => {});
      try {
        r = await tgApi("getUpdates", { timeout: 0, limit: 100, allowed_updates: ALLOWED }, token);
      } finally {
        await tgApi(
          "setWebhook",
          {
            url,
            secret_token: await webhookSecretFor(token),
            allowed_updates: ALLOWED,
            drop_pending_updates: false,
            ...(Number(wh?.max_connections ?? 0) > 0
              ? { max_connections: Number(wh?.max_connections) }
              : {}),
          },
          token,
        ).catch(() => {});
      }
    } else {
      // Anything else is a webhook this deployment cannot receive — clear it
      // so the getUpdates scan can discover chats, then restore it afterwards.
      await tgApi("deleteWebhook", { drop_pending_updates: false }, token).catch(() => {});
      await logActivity({
        type: "chat",
        level: "warning",
        message: `Cleared stale webhook for "${label}" so chat discovery (getUpdates) can work`,
        detail: url ? `was: ${url}` : "no webhook URL was returned",
      });
      r = await tgApi("getUpdates", { timeout: 0, limit: 100, allowed_updates: ALLOWED }, token);
      if (wh && url) {
        const restore: Record<string, unknown> = { url };
        if (Array.isArray(wh.allowed_updates)) restore.allowed_updates = wh.allowed_updates;
        if (Number(wh.max_connections ?? 0) > 0) restore.max_connections = Number(wh.max_connections);
        await tgApi("setWebhook", restore, token).catch(() => {});
      }
    }
  }
  if (!r.ok) return { added: 0, scanned: 0, error: r.description ?? "getUpdates failed" };
  const updates = (r.result as any[]) ?? [];
  let added = 0;
  for (const u of updates) {
    const msg = u.message ?? u.channel_post ?? u.edited_channel_post;
    const mcm = u.my_chat_member as any;
    const chat = msg?.chat ?? mcm?.chat;
    if (!chat?.id) continue;
    // my_chat_member also fires when the bot is REMOVED from a group/channel
    // — a kicked/left bot cannot post there, so never register it.
    const mcmStatus = mcm?.new_chat_member?.status;
    if (mcmStatus === "left" || mcmStatus === "kicked") continue;
    const cid = Number(chat.id);
    const exists = await rest<unknown[]>("chats", { query: `chat_id=eq.${cid}&limit=1` });
    if (Array.isArray(exists) && exists.length > 0) continue;
    await rest("chats", {
      method: "POST",
      body: {
        chat_id: cid,
        title: chat.title ?? chat.username ?? null,
        username: chat.username ?? null,
        type: chat.type ?? "private",
        active: true,
        bot_id: botId,
        last_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
      prefer: "return=minimal",
    });
    added += 1;
  }
  if (added > 0) {
    await logActivity({ type: "chat", level: "info", message: `Discovered ${added} chat(s) for bot "${label}"`, detail: `updates scanned: ${updates.length}` });
  }
  return { added, scanned: updates.length };
}

async function refreshBotInfo(_p: Record<string, unknown>): Promise<unknown> {
  const r = await tgApi("getMe");
  return { ok: r.ok, bot: r.result ?? null, error: r.ok ? null : r.description ?? "unknown" };
}

async function setWebhook(p: { baseUrl: string }): Promise<unknown> {
  const url = `${p.baseUrl.replace(/\/$/, "")}/telegram-webhook`;
  const r = await tgApi("setWebhook", { url, allowed_updates: ["message", "channel_post", "edited_channel_post", "callback_query"] });
  return { ok: r.ok, url, error: r.ok ? null : r.description ?? "unknown" };
}

async function syncBotChats(_p: Record<string, unknown>): Promise<unknown> {
  // Scan the PRIMARY bot AND every enabled additional bot. A channel where
  // only an additional bot is admin (e.g. @lodevnewsbo with the "Lodev"
  // bot) never appears in the primary bot's getUpdates stream, so the old
  // primary-only sync could never discover it — which is exactly why a
  // second bot registered with categories still delivered nothing. Chats
  // found under an additional bot are registered with bot_id so the
  // pipeline sends them with that bot's token and category whitelist.
  const botRows = await rest<Array<{ id: string; name?: string | null; token?: string | null; enabled?: boolean | null }>>(
    "bots",
    { query: "select=id,name,token,enabled&limit=100" },
  ).catch(() => []);
  const targets: Array<{ label: string; token: string; botId: string | null }> = [];
  if (TELEGRAM_BOT_TOKEN) targets.push({ label: "primary bot", token: TELEGRAM_BOT_TOKEN, botId: null });
  for (const b of botRows ?? []) {
    const tok = String(b.token ?? "").trim();
    if (!tok || b.enabled === false) continue;
    targets.push({ label: b.name ?? "bot", token: tok, botId: String(b.id) });
  }

  const errors: string[] = [];
  let added = 0;
  let scanned = 0;
  for (const t of targets) {
    try {
      const r = await scanBotChats(t.token, t.botId, t.label);
      added += r.added;
      scanned += r.scanned;
      if (r.error) errors.push(`${t.label}: ${r.error}`);
    } catch (e) {
      errors.push(`${t.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await logActivity({
    type: "system",
    level: "info",
    message: `Synced ${added} new chat(s) across ${targets.length} bot(s)`,
    detail: targets.map((t) => t.label).join(", "),
  });
  return { chats: added, scanned, errors };
}

async function sendTestMessage(p: { chatId: number; message?: string }): Promise<unknown> {
  const text = p.message?.trim() || "✅ Test message from Freebuff admin console.";
  const r = await tgApi("sendMessage", { chat_id: p.chatId, text });
  return { ok: r.ok, message_id: (r.result as any)?.message_id ?? null, error: r.ok ? null : r.description ?? "unknown" };
}

async function testPoll(p: { chatId: number; question?: string; options?: string[] }): Promise<unknown> {
  const question = p.question?.trim() || "Freebuff test poll — does this work?";
  const options = p.options?.length ? p.options : ["Yes 👍", "No 👎"];
  const r = await tgApi("sendPoll", { chat_id: p.chatId, question, options, is_anonymous: true });
  return { ok: r.ok, poll_id: (r.result as any)?.message_id ?? null, error: r.ok ? null : r.description ?? "unknown" };
}

// ── Action: testSource ──────────────────────────────────────────────────────
// Live-test one source. NewsData hits the API with its key; Telegram fetches
// the channel; RSS runs a Google News search.
async function testSource(p: { id: string }): Promise<unknown> {
  const rows = await rest<unknown[]>("sources", { query: `id=eq.${encodeURIComponent(p.id)}&limit=1` });
  const src = (Array.isArray(rows) ? rows[0] : null) as Record<string, unknown> | null;
  if (!src) throw new HttpError(404, "Source not found");
  const kind = String(src.kind ?? "");
  const name = String(src.name ?? "");

  if (kind === "newsdata") {
    if (!NEWSDATA_API_KEY) return { ok: false, kind, name, error: "NEWSDATA_API_KEY not set" };
    const res = await fetch(
      `https://newsdata.io/api/1/latest?apikey=${NEWSDATA_API_KEY}&q=Iran&language=en&size=3`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const data = await res.json().catch(() => null) as { results?: unknown[]; status?: string; totalResults?: number } | null;
    return {
      ok: res.ok,
      kind,
      name,
      count: Array.isArray(data?.results) ? data.results.length : 0,
      total: data?.totalResults ?? null,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  }
  if (kind === "rss") {
    const url = "https://news.google.com/rss/search?q=Iran+United+States&hl=en-US&gl=US&ceid=US:en";
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    return {
      ok: res.ok,
      kind,
      name,
      itemCount: (text.match(/<item>/g) ?? []).length,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  }
  if (kind === "telegram") {
    if (!TELEGRAM_BOT_TOKEN) return { ok: false, kind, name, error: "TELEGRAM_BOT_TOKEN not set" };
    const channel = ((src.config as Record<string, unknown> | null)?.channel ?? name).toString().replace(/^@/, "");
    // Try getChat first to confirm the channel exists and is accessible.
    const r = await tgApi("getChat", { chat_id: `@${channel}` });
    if (!r.ok && !String(r.description ?? "").toLowerCase().includes("chat not found")) {
      // Fall back to channel lookup by trying to forward from @ channel.
    }
    return {
      ok: Boolean(r.ok),
      kind,
      name,
      channel: `@${channel}`,
      info: (r.result as Record<string, unknown> | null)?.title ?? r.description ?? null,
    };
  }
  return { ok: false, kind, name, error: `Unknown source kind "${kind}"` };
}

// ── Action: testTranslationKey ──────────────────────────────────────────────
// Translate a fixed English sample into Sorani using the given key/model.
// Falls through Groq → MiniMax based on provider.
// For "google/gemini-*" — direct REST via generateContent.
// For "minimax/*" or "groq/*" — OpenAI-compatible chat/completions.
async function testTranslationKey(p: { id: string }): Promise<unknown> {
  const rows = await rest<unknown[]>("translation_provider_keys", { query: `id=eq.${encodeURIComponent(p.id)}&limit=1` });
  const kd = (Array.isArray(rows) ? rows[0] : null) as Record<string, unknown> | null;
  if (!kd) throw new HttpError(404, "Key not found");
  const provider = String(kd.provider ?? "");
  const model = String(kd.model ?? "");
  const apiKey = String(kd.api_key ?? "").trim();
  const sample = "Iran announced a new statement today.";
  const sysPrompt = "Translate the user's English sentence into Kurdish Sorani. Output ONLY the Sorani translation, no commentary.";
  let translated = "";

  if (provider === "google" || provider === "gemini" || provider === "google-gemini") {
    if (!apiKey) return { ok: false, detail: "API key missing" };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.replace(/^google\//, ""))}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: sample }] }],
        systemInstruction: { role: "system", parts: [{ text: sysPrompt }] },
        generationConfig: { maxOutputTokens: 256, temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => null) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } } | null;
    if (!res.ok) return { ok: false, detail: data?.error?.message ?? `HTTP ${res.status}` };
    translated = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  } else if (provider === "groq") {
    if (!apiKey && !GROQ_API_KEY) return { ok: false, detail: "GROQ_API_KEY not set and no key on row" };
    const key = apiKey || GROQ_API_KEY;
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: model.replace(/^groq\//, ""),
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: sample },
        ],
        max_tokens: 256,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } } | null;
    if (!res.ok) return { ok: false, detail: data?.error?.message ?? `HTTP ${res.status}` };
    translated = data?.choices?.[0]?.message?.content?.trim() ?? "";
  } else if (provider === "minimax" || provider === "minimax-ai") {
    if (!apiKey && !MINIMAX_API_KEY) return { ok: false, detail: "MINIMAX_API_KEY not set and no key on row" };
    const key = apiKey || MINIMAX_API_KEY;
    const res = await fetch("https://api.minimax.chat/v1/text/chatcompletion_v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: model.replace(/^minimax\//, "") || "MiniMax-M2",
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: sample },
        ],
        max_tokens: 256,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } } | null;
    if (!res.ok) return { ok: false, detail: data?.error?.message ?? `HTTP ${res.status}` };
    translated = data?.choices?.[0]?.message?.content?.trim() ?? "";
  } else {
    return { ok: false, detail: `Unsupported provider "${provider}"` };
  }
  if (!translated) return { ok: false, detail: "Empty response (no error)" };
  // Lightweight Sorani sanity check: must include at least one commonly-used
  // Sorani ideograph. Same heuristic the Convex action uses.
  if (!/[ئابپتجددرزسشعغفقلمنهوێکگ]/u.test(translated)) {
    return { ok: false, preview: translated, detail: "Validation failed: result doesn't look like Sorani" };
  }
  return { ok: true, preview: translated };
}

// ── Action: testGeminiKeys ──────────────────────────────────────────────────
// Live health-check every GEMINI_API_KEY_1..6 across each direct-REST model.
// Costs real Gemini quota: 18 calls per click (6 keys × 3 models). The promise
// of the admin UI is to show exactly which (key, model) pairs are still
// usable. The dashboard already shows a confirm-style button.
async function testGeminiKeys(_p: Record<string, unknown>): Promise<unknown> {
  const GEMINI_DIRECT_MODELS = [
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
  ];
  // Pace the live check under 5 RPM total (same global rule as the pipeline
  // translator): 13 seconds between request starts across all keys/models.
  const GEMINI_TEST_INTERVAL_MS = 13_000;
  let nextGeminiTestAt = 0;
  const waitForGeminiTestSlot = async (): Promise<void> => {
    const now = Date.now();
    const wait = nextGeminiTestAt - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextGeminiTestAt = Date.now() + GEMINI_TEST_INTERVAL_MS;
  };

  const keys: { index: number; key: string; email: string }[] = [];
  for (let i = 1; i <= 6; i++) {
    const k = Deno.env.get(`GEMINI_API_KEY_${i}`)?.trim();
    if (k) keys.push({ index: i, key: k, email: Deno.env.get(`GEMINI_API_EMAIL_${i}`)?.trim() ?? "" });
  }
  if (keys.length === 0) throw new HttpError(400, "No GEMINI_API_KEY_1..6 configured in function secrets");

  const results: Array<{
    keyIndex: number;
    masked: string;
    email: string;
    models: Array<{ model: string; status: "ok" | "rate_limited" | "auth_error" | "error"; code: number; detail: string }>;
  }> = [];

  for (const { index, key, email } of keys) {
    const models: Array<{ model: string; status: "ok" | "rate_limited" | "auth_error" | "error"; code: number; detail: string }> = [];
    for (const model of GEMINI_DIRECT_MODELS) {
      let status: "ok" | "rate_limited" | "auth_error" | "error" = "error";
      let code = 0;
      let detail = "";
      try {
        await waitForGeminiTestSlot();
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: "Say OK" }] }],
              generationConfig: { maxOutputTokens: 8 },
            }),
            signal: AbortSignal.timeout(35_000),
          },
        );
        const data = (await res.json().catch(() => null)) as { error?: { code?: number; message?: string } } | null;
        code = data?.error?.code ?? res.status;
        if (res.ok) {
          status = "ok";
          detail = "usable";
        } else if (res.status === 429 || code === 429) {
          status = "rate_limited";
          detail = data?.error?.message ?? "429 quota";
        } else if (res.status === 400 || res.status === 401 || res.status === 403) {
          status = "auth_error";
          detail = data?.error?.message ?? `HTTP ${res.status}`;
        } else {
          status = "error";
          detail = data?.error?.message ?? `HTTP ${res.status}`;
        }
      } catch (err) {
        status = "error";
        detail = err instanceof Error ? err.message : String(err);
      }
      models.push({ model, status, code, detail: detail.slice(0, 200) });
    }
    results.push({
      keyIndex: index,
      masked: `${key.slice(0, 6)}…${key.slice(-4)}`,
      email,
      models,
    });
  }
  return { keys: results, models: GEMINI_DIRECT_MODELS };
}

// ── Action: runPipeline / previewNextBatch ──────────────────────────────────
// Accepts the inner pipeline mode under either `action` (legacy) or `mode`.
// The browser SPA used to send `action: "ingest"`, which collided with the
// outer admin `action` in JSON.stringify (duplicate key → only the inner
// one survives → admin returns 404 "unknown action\"ingest\"").  Switching
// the wrapper to `mode:` keeps the outer dispatch intact.
async function runPipeline(p: { action?: string; mode?: string }): Promise<unknown> {
  const raw = String(p.mode ?? p.action ?? "").toLowerCase();
  const mode = raw === "ingest" ? "ingest" : raw === "publish" ? "publish" : "cycle";
  // Seed the live progress record BEFORE the blocking pipeline call so the
  // dashboard's progress bar appears instantly (the pipeline itself updates
  // settings.pipeline_run as the run advances; this seed closes the gap
  // between click and first pipeline write).
  const runId = await settingsId();
  const seededAt = new Date().toISOString();
  if (runId) {
    await rest("settings", {
      method: "PATCH",
      query: `id=eq.${runId}`,
      body: {
        pipeline_run: {
          action: mode,
          message: mode === "ingest" ? "Fetching sources…" : mode === "publish" ? "Publishing…" : "Running cycle…",
          item: 0,
          total: 0,
          startedAt: seededAt,
          at: seededAt,
          done: false,
        },
      },
      prefer: "return=minimal",
    }).catch(() => {});
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (PIPELINE_INTERNAL_SECRET) headers["x-internal-secret"] = PIPELINE_INTERNAL_SECRET;
  const res = await fetch(`${PIPELINE_URL}?mode=${mode}${mode === "publish" ? "&force=1" : ""}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ trigger: "admin" }),
    signal: AbortSignal.timeout(170_000),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  // If the pipeline never reported (e.g. it crashed before the done write),
  // mark the run finished so the bar doesn't hang for 10 minutes.
  if (runId) {
    const done = !res.ok || (parsed && typeof parsed === "object" && !("skipped" in (parsed as Record<string, unknown>)));
    await rest("settings", {
      method: "PATCH",
      query: `id=eq.${runId}`,
      body: {
        pipeline_run: {
          action: mode,
          message: done ? (mode === "ingest" ? "Ingest complete" : mode === "publish" ? "Publish complete" : "Cycle complete") : "Skipped — another run in progress",
          item: 0,
          total: 0,
          startedAt: seededAt,
          at: new Date().toISOString(),
          done: true,
        },
      },
      prefer: "return=minimal",
    }).catch(() => {});
  }
  await logActivity({
    type: "system",
    level: "info",
    message: `Manual pipeline run (${mode})`,
    detail: res.ok ? "ok" : `HTTP ${res.status}`,
  });
  return { ok: res.ok, status: res.status, result: parsed };
}

// ── Action: clearQueue ───────────────────────────────────────────────────────
// Two modes:
//   - limit > 0: clear-N — delete only the N lowest-scored queued items (the
//     mirror image of publish's "breaking first, then highest score" sort).
//     Breaking items are excluded so urgent stories are never wiped.
//   - no limit: clear-all — wipe every queued item, then immediately trigger
//     a fresh ingest so the queue repopulates from current news.
async function clearQueue(p: { limit?: number | string | null; includeBreaking?: boolean }): Promise<unknown> {
  const limit = Math.max(0, Math.floor(Number(p?.limit ?? 0) || 0));
  if (limit > 0) {
    const breakingFilter = p?.includeBreaking ? "" : "&breaking=eq.false";
    const victims = await rest<Array<{ id: string }>>("queue", {
      query: `select=id&status=eq.queued${breakingFilter}&order=score.asc&limit=${Math.min(limit, 500)}`,
    }).catch(() => []);
    const ids = (victims ?? []).map((v) => String(v.id)).filter(Boolean);
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      await rest("queue", {
        method: "DELETE",
        query: `id=in.(${batch.join(",")})`,
        prefer: "return=minimal",
      }).catch(() => {});
    }
    await logActivity({
      type: "admin",
      level: "warning",
      message: `Queue trimmed from console: dropped ${ids.length} lowest-score item(s)`,
    });
    return { ok: true, cleared: ids.length > 0, count: ids.length };
  }
  await rest("queue", {
    method: "DELETE",
    query: "status=eq.queued",
    prefer: "return=minimal",
  });
  // Also roll old finished rows so the table doesn't accumulate.
  const doneCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  await rest("queue", {
    method: "DELETE",
    query: `status=neq.queued&created_at=lt.${encodeURIComponent(doneCutoff)}`,
    prefer: "return=minimal",
  }).catch(() => {});

  let ingest: unknown = null;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (PIPELINE_INTERNAL_SECRET) headers["x-internal-secret"] = PIPELINE_INTERNAL_SECRET;
    const res = await fetch(`${PIPELINE_URL}?mode=ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({ trigger: "admin" }),
      signal: AbortSignal.timeout(170_000),
    });
    const text = await res.text();
    try { ingest = JSON.parse(text); } catch { ingest = text; }
  } catch (err) {
    ingest = err instanceof Error ? err.message : String(err);
  }
  await logActivity({
    type: "admin",
    level: "warning",
    message: "Queue cleared from console (auto-fetch triggered)",
  });
  return { ok: true, cleared: true, count: null, ingest };
}

// `previewNextBatch` forwards to the pipeline's dry-run preview mode so the
// dashboard dialog shows the same ready/duplicate/blocked verdict the real
// publish run would produce (same scoring + dedup gates, nothing sent).
async function previewNextBatch(p: { limit?: number }): Promise<unknown> {
  const limit = Math.min(20, Math.max(1, p.limit ?? 5));
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (PIPELINE_INTERNAL_SECRET) headers["x-internal-secret"] = PIPELINE_INTERNAL_SECRET;
  const res = await fetch(`${PIPELINE_URL}?mode=preview&limit=${limit}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ trigger: "admin" }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Preview failed (${res.status}): ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ── Action: editQueueItem ───────────────────────────────────────────────────
// Edit a queued item's headline/summary/category/breaking flag in place, then
// leave it queued so the operator can hit "Publish now" (or the next cycle)
// with the corrected copy. Only queued rows are editable — published rows are
// deleted after send and history is immutable.
async function editQueueItem(p: {
  id: string;
  headline?: string;
  summary?: string;
  category?: string;
  breaking?: boolean;
}): Promise<unknown> {
  if (!p.id) throw new HttpError(400, "id is required");
  const row = await rest<Array<Record<string, unknown>>>("queue", {
    query: `id=eq.${encodeURIComponent(p.id)}&limit=1`,
  });
  if (!Array.isArray(row) || row.length === 0) throw new HttpError(404, "Queue item not found");
  if (String(row[0].status) !== "queued") throw new HttpError(409, "Only queued items can be edited");
  const patch: Record<string, unknown> = {};
  if (typeof p.headline === "string" && p.headline.trim()) patch.headline = p.headline.trim();
  if (typeof p.summary === "string") patch.summary = p.summary.trim();
  if (typeof p.category === "string" && p.category.trim()) patch.category = p.category.trim();
  if (typeof p.breaking === "boolean") patch.breaking = p.breaking;
  if (Object.keys(patch).length === 0) throw new HttpError(400, "No editable fields provided");
  await rest("queue", {
    method: "PATCH",
    query: `id=eq.${encodeURIComponent(p.id)}`,
    body: patch,
    prefer: "return=minimal",
  });
  await logActivity({
    type: "admin",
    level: "info",
    message: "Queue item edited",
    detail: (p.headline ?? p.id).slice(0, 80),
  });
  return { ok: true, id: p.id };
}

// ── Action: setQueueStatus ─────────────────────────────────────────────────
// Hold / reject / requeue a queue item. The pipeline only ever auto-publishes
// rows with status='queued' (listQueued filters status=eq.queued), so setting
// a row to 'held' or 'rejected' genuinely gates it out of every publish cycle
// until the operator decides otherwise. Used by the Inbox / Review actions.
async function setQueueStatus(p: { id: string; status: "held" | "rejected" | "queued" }): Promise<unknown> {
  if (!p.id) throw new HttpError(400, "id is required");
  const status = String(p.status ?? "");
  if (!["held", "rejected", "queued"].includes(status)) {
    throw new HttpError(400, `invalid status: ${status}`);
  }
  const row = await rest<Array<Record<string, unknown>>>("queue", {
    query: `id=eq.${encodeURIComponent(p.id)}&limit=1`,
  });
  if (!Array.isArray(row) || row.length === 0) throw new HttpError(404, "Queue item not found");
  await rest("queue", {
    method: "PATCH",
    query: `id=eq.${encodeURIComponent(p.id)}`,
    body: { status },
    prefer: "return=minimal",
  });
  await logActivity({
    type: "admin",
    level: status === "rejected" ? "warning" : "info",
    message: status === "queued" ? "Queue item requeued" : `Queue item ${status}`,
    detail: String(row[0].headline ?? p.id).slice(0, 80),
  });
  return { ok: true, id: p.id, status };
}

// ── Action: publishQueueItem ────────────────────────────────────────────────
// Publish a single queued item immediately, bypassing the normal sort order.
// Forwards to the pipeline's publish mode with an explicit id so the operator
// can force a specific story out now (for example right after editing it).
// ── Action: deleteQueueItem ─────────────────────────────────────────────────
// Hard-delete a queue row (Inbox swipe-left). Unlike setQueueStatus — where
// "rejected" only flags the row so it is excluded from auto-publish but still
// visible in the FAILED tab — this actually removes the row so it can never be
// re-selected or re-published.
async function deleteQueueItem(p: { id: string }): Promise<unknown> {
  if (!p.id) throw new HttpError(400, "id is required");
  const row = await rest<Array<Record<string, unknown>>>("queue", {
    query: `id=eq.${encodeURIComponent(p.id)}&limit=1`,
  });
  if (!Array.isArray(row) || row.length === 0) throw new HttpError(404, "Queue item not found");
  await rest("queue", {
    method: "DELETE",
    query: `id=eq.${encodeURIComponent(p.id)}`,
    prefer: "return=minimal",
  });
  await logActivity({
    type: "admin",
    level: "info",
    message: "Queue item deleted",
    detail: String(row[0].headline ?? p.id).slice(0, 80),
  });
  return { ok: true, id: p.id, deleted: true };
}

async function publishQueueItem(p: { id: string }): Promise<unknown> {
  if (!p.id) throw new HttpError(400, "id is required");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (PIPELINE_INTERNAL_SECRET) headers["x-internal-secret"] = PIPELINE_INTERNAL_SECRET;
  const res = await fetch(`${PIPELINE_URL}?mode=publish&force=1&id=${encodeURIComponent(p.id)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ trigger: "admin" }),
    signal: AbortSignal.timeout(170_000),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  await logActivity({
    type: "admin",
    level: "info",
    message: "Manual publish of a single queue item",
    detail: p.id.slice(0, 8),
  });
  return { ok: res.ok, status: res.status, result: parsed };
}

// ── Action: deletePublishedPost ────────────────────────────────────────────
// Delete a delivered post from every chat (Telegram deleteMessage) so a bad
// post can be removed from the channel from the console. Forwards to the
// pipeline's mode=delete with the published_history row id — the bot tokens
// live in the pipeline function, not here. The history row carries the
// per-chat Telegram message ids recorded since migration 0043.
async function deletePublishedPost(p: { id: string }): Promise<unknown> {
  if (!p.id) throw new HttpError(400, "id is required");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (PIPELINE_INTERNAL_SECRET) headers["x-internal-secret"] = PIPELINE_INTERNAL_SECRET;
  const res = await fetch(`${PIPELINE_URL}?mode=delete&id=${encodeURIComponent(p.id)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ trigger: "admin" }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  await logActivity({
    type: "admin",
    level: "info",
    message: "Delete published post",
    detail: p.id.slice(0, 8),
  });
  return { ok: res.ok, status: res.status, result: parsed };
}


// ── Action: getRewriteLog ──────────────────────────────────────────────────
// Recent AI-rewrite attempts (Settings → AI & Translation → Rewrite log):
// one row per rewrite chunk, success or failure, with provider/model and
// headline previews. Pure read; the pipeline writes the rows.
async function getRewriteLog(): Promise<{ entries: Array<Record<string, unknown>> }> {
  const rows = await rest<Array<Record<string, unknown>>>("rewrite_log", {
    query: "order=created_at.desc&limit=50",
  });
  return { entries: snakeArray(rows) };
}

// ── Action: resolveSending ─────────────────────────────────────────────────
// Reconcile a stuck 'sending' published_history row. These rows are ambiguous
// by design: Telegram may or may not have delivered. The operator decides:
//   action "sent"  → the message was delivered (or is acceptable as lost);
//                    mark the row 'sent' so it stops blocking and the archive
//                    is honest.
//   action "retry" → delete the row; if the queue item is still queued the
//                    next publish cycle re-delivers to that chat.
async function resolveSending(p: { id?: string; resolve?: string }): Promise<unknown> {
  // `resolve` (not `action`): the router dispatches on the payload's `action`
  // field, so naming this choice `action` would collide and override the RPC.
  const id = String(p.id ?? "");
  const action = String(p.resolve ?? "");
  if (!id || (action !== "sent" && action !== "retry")) {
    throw new HttpError(400, "id and resolve ('sent'|'retry') required");
  }
  if (action === "sent") {
    await rest(`published_history?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { status: "sent", updated_at: new Date().toISOString() },
      prefer: "return=minimal",
    });
  } else {
    await rest(`published_history?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      prefer: "return=minimal",
    });
  }
  await logActivity({
    type: "admin",
    level: "info",
    message: `Stuck delivery ${action === "sent" ? "marked sent" : "deleted for retry"}: ${id.slice(0, 8)}`,
  });
  return { ok: true, id, action };
}

// ── Action: getRewriteAnalytics ────────────────────────────────────────────
// 7-day rewrite health (Settings → AI & Translation → Rewrite Analytics):
// success/fallback rates, per-provider success + avg latency, daily trend.
// Pure aggregation of the last 7 days of rewrite_log (a few rows per ingest
// cycle, so the fetch is small); the math lives in _shared.ts (unit-tested).
async function getRewriteAnalytics(): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = await rest<Array<Record<string, unknown>>>("rewrite_log", {
    query: `created_at=gte.${since}&order=created_at.desc&limit=5000`,
  }).catch(() => []);
  return aggregateRewriteAnalytics(rows);
}

const handlers: Record<string, (p: any) => Promise<unknown>> = {
  verifyPin: async () => ({ ok: true }),
  getDashboard,
  dashboardSummary: (p) => statefulDashboard("dashboardSummary", p, fetchDashboardSummary),
  dashboardFeed: (p) => statefulDashboard("dashboardFeed", p, fetchDashboardFeed),
  dashboardQueue: (p) => statefulDashboard("dashboardQueue", p, fetchDashboardQueue),
  dashboardChats: (p) => statefulDashboard("dashboardChats", p, fetchDashboardChats),
  dashboardSources: (p) => statefulDashboard("dashboardSources", p, fetchDashboardSources),
  dashboardAnalytics: (p) => statefulDashboard("dashboardAnalytics", p, fetchDashboardAnalytics),
  dashboardAi: (p) => statefulDashboard("dashboardAi", p, fetchDashboardAi),
  dashboardEvents: (p) => statefulDashboard("dashboardEvents", p, fetchDashboardEvents),
  dashboardPublished: (p) => statefulDashboard("dashboardPublished", p, fetchDashboardPublished),
  // Live manual-run progress: the lightweight read the Overview page polls
  // (every ~2.5s) while a manual fetch/publish is in flight. Single-row
  // settings read — the pipeline writes pipeline_run (jsonb) as it advances.
  getPipelineRun: async () => {
    const s = await getSettings();
    return { pipeline_run: (s as Record<string, unknown>).pipeline_run ?? null };
  },
  resolveSending,
  saveSettings,
  setCronSchedule,
  setPauseState,
  setTranslationModel,
  updateChat,
  addChat,
  saveBot,
  deleteBot,
  upsertTopic,
  upsertSource,
  listTranslationKeys,
  upsertTranslationKey,
  listTranslationModels,
  testTranslationKey,
  testSource,
  refreshBotInfo,
  setWebhook,
  enableChatWebhooks,
  syncBotChats,
  sendTestMessage,
  testPoll,
  testGeminiKeys,
  runPipeline,
  clearQueue,
  previewNextBatch,
  editQueueItem,
  publishQueueItem,
  deletePublishedPost,
  setQueueStatus,
  deleteQueueItem,
  getRewriteLog,
  getRewriteAnalytics,
  // Scheduled Posts / Campaign engine (Settings → Campaigns).
  listScheduled,
  saveScheduledCampaign,
  saveScheduledItem,
  deleteScheduledCampaign,
  deleteScheduledItem,
  setScheduledCampaignStatus,
  scheduledSkipNext,
  scheduledSendNext,
  scheduledSendItem,
  scheduledResetItem,
};

// ── Action: enableChatWebhooks ──────────────────────────────────────────────
// Points every bot's Telegram webhook at this function's /telegram-webhook
// path so chat discovery is REAL-TIME (a my_chat_member update registers the
// chat instantly) instead of relying on the 24h getUpdates retention window.
// Each bot carries its own secret_token; the receiver verifies + identifies it.
async function enableChatWebhooks(_p: Record<string, unknown>): Promise<unknown> {
  const botRows = await rest<Array<{ id: string; name?: string | null; token?: string | null; enabled?: boolean | null }>>(
    "bots",
    { query: "select=id,name,token,enabled&limit=100" },
  ).catch(() => []);
  const targets: Array<{ label: string; token: string }> = [];
  if (TELEGRAM_BOT_TOKEN) targets.push({ label: "primary bot", token: TELEGRAM_BOT_TOKEN });
  for (const b of botRows ?? []) {
    const tok = String(b.token ?? "").trim();
    if (!tok || b.enabled === false) continue;
    targets.push({ label: b.name ?? "bot", token: tok });
  }
  const results: Array<{ label: string; ok: boolean; error?: string }> = [];
  for (const t of targets) {
    const r = await tgApi("setWebhook", {
      url: TG_WEBHOOK_BASE,
      secret_token: await webhookSecretFor(t.token),
      allowed_updates: ["message", "channel_post", "edited_channel_post", "my_chat_member"],
      drop_pending_updates: false,
    }, t.token);
    results.push({ label: t.label, ok: r.ok, error: r.ok ? undefined : r.description ?? "unknown" });
  }
  const okCount = results.filter((r) => r.ok).length;
  await logActivity({
    type: "chat",
    level: okCount > 0 ? "info" : "warning",
    message: `Enabled real-time chat webhooks for ${okCount}/${targets.length} bot(s)`,
    detail: results.map((r) => `${r.label}: ${r.ok ? "ok" : r.error}`).join(", "),
  });
  return { results, ok: okCount === targets.length };
}

// Telegram update receiver (path /telegram-webhook). Verified by the
// X-Telegram-Bot-Api-Secret-Token header, which also identifies the bot.
// Registers/refreshes the chat row; never re-points an existing chat to a
// different bot. Returns 200 quickly so Telegram does not retry.
async function handleTelegramWebhook(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const update = JSON.parse(text) as Record<string, unknown>;
    const provided = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    let botId: string | null = null;
    let label = "primary bot";
    let verified = provided.length > 0 && (await webhookSecretFor(TELEGRAM_BOT_TOKEN)) === provided;
    if (!verified) {
      const botRows = await rest<Array<{ id: string; name?: string | null; token?: string | null }>>(
        "bots",
        { query: "select=id,name,token&limit=100" },
      ).catch(() => []);
      for (const b of botRows ?? []) {
        const tok = String(b.token ?? "");
        if (!tok) continue;
        if ((await webhookSecretFor(tok)) === provided) {
          verified = true;
          botId = String(b.id);
          label = b.name ?? "bot";
          break;
        }
      }
    }
    if (!verified) return jsonResponse(401, { error: "Unauthorized" });

    const msg = (update.message ?? update.channel_post ?? update.edited_channel_post ?? update.my_chat_member) as Record<string, unknown> | undefined;
    const chat = (msg?.chat ?? undefined) as Record<string, unknown> | undefined;
    const cid = Number((chat as Record<string, unknown> | undefined)?.id ?? 0);
    if (!cid) return jsonResponse(200, { ok: true, ignored: true });
    const mcm = update.my_chat_member as Record<string, unknown> | undefined;
    const status = (mcm?.new_chat_member as Record<string, unknown> | undefined)?.status;
    if (status === "left" || status === "kicked") {
      await rest("chats", {
        method: "PATCH",
        body: { active: false, last_seen_at: new Date().toISOString() },
        query: `chat_id=eq.${cid}`,
      }).catch(() => {});
      return jsonResponse(200, { ok: true });
    }
    const title = (chat as Record<string, unknown>).title ?? (chat as Record<string, unknown>).username ?? null;
    const username = (chat as Record<string, unknown>).username ?? null;
    const type = (chat as Record<string, unknown>).type ?? null;
    const exists = await rest<Array<{ id: string }>>("chats", { query: `chat_id=eq.${cid}&limit=1` }).catch(() => []);
    if (Array.isArray(exists) && exists.length > 0) {
      // Refresh identity fields too (a renamed channel / edited post carries
      // the new title) so webhook updates never leave stale titles behind
      // until the next full sync.
      const patch: Record<string, unknown> = { active: true, last_seen_at: new Date().toISOString() };
      if (title !== null && title !== undefined) patch.title = title;
      if (username !== null && username !== undefined) patch.username = username;
      if (type !== null && type !== undefined) patch.type = type;
      await rest("chats", { method: "PATCH", body: patch, query: `chat_id=eq.${cid}` }).catch(() => {});
      return jsonResponse(200, { ok: true, refreshed: true });
    }
    await rest("chats", {
      method: "POST",
      body: {
        chat_id: cid,
        title,
        username,
        type: type ?? "private",
        active: true,
        bot_id: botId,
        last_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
      prefer: "return=minimal",
    }).catch(() => {});
    await logActivity({
      type: "chat",
      level: "info",
      message: `Webhook discovered chat "${String(title ?? cid).slice(0, 40)}" (${label})`,
    });
    return jsonResponse(200, { ok: true });
  } catch {
    return jsonResponse(200, { ok: false });
  }
}

// ── CORS helpers (so the SPA can call directly without a proxy) ─────────────
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  // Preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  // Telegram webhook receiver (real-time chat discovery): identified by the
  // URL path, verified by the secret-token header — runs before the PIN gate
  // because Telegram does not know the admin PIN.
  if (new URL(req.url).pathname.endsWith("/telegram-webhook")) {
    return await handleTelegramWebhook(req);
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse(405, { error: "method not allowed" });
  }
  let body: Record<string, unknown> = {};
  try {
    if (req.method === "POST") {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    }
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const { action, pin, ...payload } = body;
  if (typeof action !== "string" || !action) {
    return jsonResponse(400, { error: "missing action" });
  }
  // Rate-limit the PIN gate before checking: an IP at the failure ceiling
  // gets a 429 without revealing whether the guess would have been right.
  const ip = clientIp(req);
  const lockedFor = await lockoutSeconds(ip);
  if (lockedFor > 0) {
    return jsonResponse(429, { error: `Too many failed attempts — locked for ${lockedFor}s` });
  }
  if (!pinMatches(pin)) {
    // Only real login attempts (verifyPin) count toward the per-IP lockout.
    // Dashboard polls from a device holding a stale stored PIN also get a
    // 403, but counting those would let a device lock out its own IP (8
    // parallel resource polls x 403 on mount = instant lockout). A
    // brute-forcer gets the same throttle from the login path alone — the
    // PIN gate is the same for every action.
    if (action === "verifyPin") await recordPinFailure(ip);
    return jsonResponse(403, { error: "Incorrect PIN" });
  }
  await clearPinFailures(ip);
  const handler = handlers[action];
  if (!handler) return jsonResponse(404, { error: `unknown action "${action}"` });
  try {
    const data = await handler(payload);
    return jsonResponse(200, { ok: true, data });
  } catch (err) {
    if (err instanceof PinError) return jsonResponse(403, { error: err.message });
    if (err instanceof HttpError) return jsonResponse(err.status, { error: err.message });
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[admin] ${action} failed:`, msg);
    return jsonResponse(500, { error: msg });
  }
});
