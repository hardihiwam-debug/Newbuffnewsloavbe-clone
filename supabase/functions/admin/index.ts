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
// ADMIN_PIN env (default "200006" to match the existing Convex fallback).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ADMIN_PIN = Deno.env.get("ADMIN_PIN") ?? "200006";
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

// Supported direct-REST Gemini model chain (kept in sync with the pipeline).
// Mirrors SUPPORTED_GEMINI_MODELS in src/convex/secrets.ts.
const SUPPORTED_GEMINI_MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-1.5-flash",
  "google/gemini-1.5-flash-8b",
  "minimax/MiniMax-M2",
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
// guess off the response latency.
function pinMatches(provided: unknown): boolean {
  if (typeof provided !== "string") return false;
  const a = provided.trim();
  const b = ADMIN_PIN.trim();
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
  breakingCategories: ["war", "iran", "proxies", "usa"],
  oilMoveThreshold: 3,
  goldMoveThreshold: 2,
  timezone: "Asia/Baghdad",
  eventCooldownHours: 8,
  eventSimilarityThreshold: 0.52,
  sendDelayMs: 3000,
  bulletinEnabled: false,
  bulletinTime: "08:00",
  bulletinHours: 24,
  translationMode: "gemini_first",
  translationModel: "google/gemini-2.5-flash",
  pollsEnabled: true,
  pollsMaxPerHour: 1,
  pollsAutoCloseMinutes: 60,
  pollsCategories: ["war", "iran", "proxies", "usa"],
  pollsDefaultLanguage: "chat",
  pollCadence: "breaking",
  ingestIntervalMinutes: 15,
  publishIntervalMinutes: 10,
  minPostGapMinutes: 1,
  bulletinIntervalMinutes: 15,
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

// ── Action: getDashboard ────────────────────────────────────────────────────
async function getDashboard(_p: Record<string, unknown>): Promise<unknown> {
  const settings = await getSettings();
  const [chatsRaw, sourcesRaw, topicsRaw, queueRaw, queueAllRaw, historyRaw] = await Promise.all([
    rest<unknown[]>("chats", { query: "limit=500" }),
    rest<unknown[]>("sources", { query: "limit=500" }),
    rest<unknown[]>("topic_queries", { query: "limit=500" }),
    rest<unknown[]>("queue", { query: "status=eq.queued&limit=200" }),
    rest<unknown[]>("queue", { query: "order=created_at.desc&limit=300" }),
    rest<unknown[]>("published_history", { query: "order=published_at.desc&limit=200" }),
  ]);

  const chats = snakeArray(chatsRaw).sort((a: any, b: any) =>
    String(b.lastSeenAt ?? "").localeCompare(String(a.lastSeenAt ?? "")),
  );
  const sources = snakeArray(sourcesRaw).sort((a: any, b: any) =>
    (a.priority ?? 0) - (b.priority ?? 0),
  );
  const topics = snakeArray(topicsRaw).sort((a: any, b: any) =>
    String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
  );
  const queue = snakeArray(queueRaw).sort((a: any, b: any) => {
    if (Boolean(a.breaking) !== Boolean(b.breaking)) return a.breaking ? -1 : 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });
  const queueAll = snakeArray(queueAllRaw);

  // Dedup published history by dedupKey keeping the most recent + the full
  // list of chat titles each story went to.
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

  const transFailRaw = await rest<unknown[]>("translation_failures", { query: "order=created_at.desc&limit=50" });
  const pollsRaw = await rest<unknown[]>("polls", { query: "order=created_at.desc&limit=100" });
  const activityRaw = await rest<unknown[]>("activity_log", { query: "order=created_at.desc&limit=100" });
  const transHistRaw = await rest<unknown[]>("translation_history", { query: "order=created_at.desc&limit=50" });
  // Event clusters (the backend's cross-outlet event grouping). The Events
  // page renders these as the newsroom's developing-story board.
  const clustersRaw = await rest<unknown[]>("clusters", {
    query: "order=last_seen_at.desc.nullslast&limit=100",
  });

  // 14-day analytics series (real counts from retained history/polls).
  const since14 = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const hist14Raw = await rest<unknown[]>("published_history", {
    query: `published_at=gte.${encodeURIComponent(since14)}&limit=2000`,
  });
  const polls14Raw = await rest<unknown[]>("polls", {
    query: `created_at=gte.${encodeURIComponent(since14)}&limit=2000`,
  });
  const hist14 = Array.isArray(hist14Raw) ? hist14Raw : [];
  const polls14 = Array.isArray(polls14Raw) ? polls14Raw : [];

  const days: { date: string; published: number; breaking: number; polls: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    days.push({
      date: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
      published: 0,
      breaking: 0,
      polls: 0,
    });
  }
  const slots = new Map(days.map((d) => [d.date, d]));
  const daySlice = (iso: string) => iso.slice(0, 10);
  const seenStory = new Set<string>();
  for (const h of hist14 as any[]) {
    const slot = slots.get(daySlice(h.published_at));
    if (!slot) continue;
    if (seenStory.has(h.dedup_key)) continue;
    seenStory.add(h.dedup_key);
    slot.published += 1;
    if (h.breaking) slot.breaking += 1;
  }
  for (const p of polls14 as any[]) {
    const slot = slots.get(daySlice(p.created_at));
    if (slot) slot.polls += 1;
  }

  // Live 24h counts.
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const queuedAllRaw = await rest<unknown[]>("queue", { query: "status=eq.queued&limit=5000&select=id" });
  const published24hRaw = await rest<unknown[]>("published_history", { query: `published_at=gte.${encodeURIComponent(dayAgo)}&limit=5000` });
  const polls24hRaw = await rest<unknown[]>("polls", { query: `created_at=gte.${encodeURIComponent(dayAgo)}&limit=5000` });
  const tfail24hRaw = await rest<unknown[]>("translation_failures", { query: `created_at=gte.${encodeURIComponent(dayAgo)}&limit=5000` });
  const queuedTotal = Array.isArray(queuedAllRaw) ? queuedAllRaw.length : 0;
  const seen24h = new Set<string>();
  let published24h = 0;
  for (const r of (Array.isArray(published24hRaw) ? published24hRaw : []) as any[]) {
    if (seen24h.has(r.dedup_key)) continue;
    seen24h.add(r.dedup_key);
    published24h += 1;
  }
  const polls24h = Array.isArray(polls24hRaw) ? polls24hRaw.length : 0;
  const translationFails24h = Array.isArray(tfail24hRaw) ? tfail24hRaw.length : 0;

  // AI-decision-path usage today (Groq/OpenRouter/Cloudflare).
  const aiUsageToday = new Date().toISOString().slice(0, 10);
  const aiUsageRaw = await rest<unknown[]>("ai_usage", {
    query: `day=gte.${encodeURIComponent(aiUsageToday)}&limit=5000`,
  });
  const aiUsage24h = (() => {
    let calls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    const byProvider: Record<string, { calls: number; promptTokens: number; completionTokens: number }> = {};
    for (const r of (Array.isArray(aiUsageRaw) ? aiUsageRaw : []) as any[]) {
      calls += Number(r.calls ?? 0);
      promptTokens += Number(r.prompt_tokens ?? 0);
      completionTokens += Number(r.completion_tokens ?? 0);
      const p = (byProvider[r.provider] ??= { calls: 0, promptTokens: 0, completionTokens: 0 });
      p.calls += Number(r.calls ?? 0);
      p.promptTokens += Number(r.prompt_tokens ?? 0);
      p.completionTokens += Number(r.completion_tokens ?? 0);
    }
    return { calls, promptTokens, completionTokens, byProvider };
  })();

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
  const schemaMigrations = { ok: Object.keys(schemaMissing).length === 0, missing: schemaMissing };

  return {
    settings,
    isOwner: true,
    chats,
    sources,
    topics,
    queue: queue.slice(0, 50),
    queueAll,
    history,
    translationFailures: snakeArray(transFailRaw),
    translationHistory: snakeArray(transHistRaw),
    polls: snakeArray(pollsRaw),
    clusters: snakeArray(clustersRaw),
    recentActivity: snakeArray(activityRaw),
    analytics: days,
    queuedTotal,
    published24h,
    polls24h,
    translationFails24h,
    aiUsage24h,
    schemaMigrations,
    botConfigured: Boolean(TELEGRAM_BOT_TOKEN),
    newsdataConfigured: Boolean(NEWSDATA_API_KEY),
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
  await rest(`chats?id=eq.${encodeURIComponent(p.id)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
  await logActivity({
    type: "chat",
    level: "info",
    message: "Chat updated",
    detail: Object.keys(patch).map((k) => `${k}=${String(patch[k])}`).join(", ") || undefined,
  });
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

  const hardcodedGemini: { index: number; first8: string; last4: string }[] = [];
  for (let i = 1; i <= 6; i++) {
    const key = Deno.env.get(`GEMINI_API_KEY_${i}`)?.trim() ?? "";
    if (key) hardcodedGemini.push({ index: i, first8: key.slice(0, 8), last4: key.slice(-4) });
  }

  // Per-key × per-model usage (from gemini_key_usage + recent gemini_call_log).
  const usageRows = await rest<unknown[]>("gemini_key_usage", { query: "limit=5000" });
  const logRows = await rest<unknown[]>("gemini_call_log", { query: "order=at.desc&limit=800" });
  const todayStr = new Date().toISOString().slice(0, 10);
  const empty = () => ({ calls: 0, ok: 0, rateLimited: 0, otherErrors: 0 });
  const geminiUsage: Array<{
    keyIndex: number;
    first8: string;
    last4: string;
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
async function tgApi(method: string, body?: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  if (!TELEGRAM_BOT_TOKEN) throw new HttpError(503, "TELEGRAM_BOT_TOKEN not configured");
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  return (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as any;
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
  const r = await tgApi("getUpdates", { timeout: 0, limit: 100, allowed_updates: ["message", "channel_post"] });
  if (!r.ok) return { chats: 0, error: r.description ?? "getUpdates failed" };
  const updates = (r.result as any[]) ?? [];
  const seen = new Set<number>();
  let added = 0;
  for (const u of updates) {
    const msg = u.message ?? u.channel_post ?? u.edited_channel_post;
    const chat = msg?.chat;
    if (!chat?.id) continue;
    const cid = Number(chat.id);
    if (seen.has(cid)) continue;
    seen.add(cid);
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
        last_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
      prefer: "return=minimal",
    });
    added += 1;
  }
  await logActivity({ type: "system", level: "info", message: `Synced ${added} new chat(s) from Telegram`, detail: `total updates: ${updates.length}` });
  return { chats: added, scanned: updates.length };
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
    "gemini-2.5-flash",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
  ];
  const keys: { index: number; key: string }[] = [];
  for (let i = 1; i <= 6; i++) {
    const k = Deno.env.get(`GEMINI_API_KEY_${i}`)?.trim();
    if (k) keys.push({ index: i, key: k });
  }
  if (keys.length === 0) throw new HttpError(400, "No GEMINI_API_KEY_1..6 configured in function secrets");

  const results: Array<{
    keyIndex: number;
    masked: string;
    models: Array<{ model: string; status: "ok" | "rate_limited" | "auth_error" | "error"; code: number; detail: string }>;
  }> = [];

  for (const { index, key } of keys) {
    const models: Array<{ model: string; status: "ok" | "rate_limited" | "auth_error" | "error"; code: number; detail: string }> = [];
    for (const model of GEMINI_DIRECT_MODELS) {
      let status: "ok" | "rate_limited" | "auth_error" | "error" = "error";
      let code = 0;
      let detail = "";
      try {
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
      await new Promise((r) => setTimeout(r, 350));
    }
    results.push({
      keyIndex: index,
      masked: `${key.slice(0, 6)}…${key.slice(-4)}`,
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
  await logActivity({
    type: "system",
    level: "info",
    message: `Manual pipeline run (${mode})`,
    detail: res.ok ? "ok" : `HTTP ${res.status}`,
  });
  return { ok: res.ok, status: res.status, result: parsed };
}

// ── Action: clearQueue ───────────────────────────────────────────────────────
// Deletes every queued item, then immediately triggers a fresh ingest so the
// queue repopulates from current news instead of a stale backlog. Used by the
// dashboard "Clear queue" button (queue can balloon past 900 items).
async function clearQueue(_p: Record<string, unknown>): Promise<unknown> {
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
  return { ok: true, cleared: true, ingest };
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

// ── Handler table ───────────────────────────────────────────────────────────
const handlers: Record<string, (p: any) => Promise<unknown>> = {
  verifyPin: async () => ({ ok: true }),
  getDashboard,
  saveSettings,
  setPauseState,
  setTranslationModel,
  updateChat,
  addChat,
  upsertTopic,
  upsertSource,
  listTranslationKeys,
  upsertTranslationKey,
  listTranslationModels,
  testTranslationKey,
  testSource,
  refreshBotInfo,
  setWebhook,
  syncBotChats,
  sendTestMessage,
  testPoll,
  testGeminiKeys,
  runPipeline,
  clearQueue,
  previewNextBatch,
  editQueueItem,
  publishQueueItem,
  setQueueStatus,
};

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
  if (!pinMatches(pin)) {
    return jsonResponse(403, { error: "Incorrect PIN" });
  }
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
