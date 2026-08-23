// Data access layer: PostgREST helpers, queue/history/source operations,
// translation cache, source health/quota and queue retention.
// Extracted verbatim from pipeline/index.ts (split refactor) — no behavior change.

import { ChatRow, computeQuotaPatch, translationCacheKey } from "./_shared.ts";
import { SERVICE_KEY, SUPABASE_URL, SettingsRow, TELEGRAM_BOT_TOKEN } from "./config.ts";

// Real-time chat-discovery webhook URL (the admin function's /telegram-webhook
// path). When a bot's webhook points here, discovery is instant and the
// getUpdates scan must leave it alone.
const TG_WEBHOOK_BASE = `${SUPABASE_URL}/functions/v1/telegram-webhook`;
import { telegramCall } from "./telegram.ts";

// ── PostgREST helpers ───────────────────────────────────────────────────────
export function restHeaders(prefer?: string): HeadersInit {
  const h: Record<string, string> = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) h["Prefer"] = prefer;
  return h;
}

export async function rest<T = unknown>(
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
  if (method === "GET" || opts.prefer === "return=representation") {
    return (await res.json().catch(() => null)) as T;
  }
  return undefined as T;
}

export const enc = encodeURIComponent;

// ── Crypto / URL helpers ────────────────────────────────────────────────────
export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function hostname(url: string): string {
  const h = hostOf(url);
  return h || "Unknown source";
}


// ── Data access ─────────────────────────────────────────────────────────────
export async function getSettings(): Promise<SettingsRow | null> {
  const rows = await rest<SettingsRow[]>("settings", { query: "select=*&limit=1" });
  return rows?.[0] ?? null;
}
export async function patchSettings(id: string, patch: Record<string, unknown>): Promise<void> {
  await rest("settings", { method: "PATCH", query: `id=eq.${enc(id)}`, body: patch, prefer: "return=minimal" });
}

// Live manual-run progress: settings.pipeline_run (jsonb, migration 0001) is
// the carrier the dashboard's PipelineProgress widget reads. Fire-and-forget
// — a progress write must never break the run itself, and it must never
// throw into the caller (progress is diagnostic, not load-bearing).
export async function reportRunProgress(id: string, patch: Record<string, unknown>): Promise<void> {
  await patchSettings(id, { pipeline_run: patch }).catch(() => {});
}
export async function listSources(): Promise<Array<Record<string, unknown>>> {
  return (await rest<Array<Record<string, unknown>>>("sources", { query: "select=*&order=priority.asc" })) ?? [];
}
export async function listTopicQueries(): Promise<Array<{ query: string; category: string; enabled: boolean }>> {
  return (await rest<Array<{ query: string; category: string; enabled: boolean }>>("topic_queries", { query: "select=query,category,enabled" })) ?? [];
}
export async function listActiveChats(): Promise<Array<ChatRow>> {
  return (await rest<Array<ChatRow>>("chats", { query: "select=id,chat_id,bot_id&active=eq.true" })) ?? [];
}
export type BotRow = { id: string; name?: string | null; token?: string | null; categories?: unknown; enabled?: boolean | null };
// Every registered bot's token + category whitelist. bot_id = null on a chat
// means the primary bot (env TELEGRAM_BOT_TOKEN, all categories).
export async function listBots(): Promise<Map<string, BotRow>> {
  const rows = await rest<BotRow[]>("bots", { query: "select=id,name,token,categories,enabled&limit=100" });
  return new Map((rows ?? []).filter((b) => b.enabled !== false).map((b) => [String(b.id), b]));
}
// dedupeChats lives in _shared.ts (unit-tested): it prefers the primary-bot
// row (bot_id = null) so a channel where both the primary and an additional
// bot are members deterministically receives everything from the primary bot.

// ── Auto chat discovery (manual Sync chats + daily auto-sync) ──────────────
// Telegram does not let a bot enumerate its chats, so the only way to pick up
// a new subscriber/channel is to poll getUpdates and register every chat that
// appears. Scans the primary bot AND every enabled additional bot; chats found
// under an additional bot carry bot_id so the router sends through that bot's
// token + category whitelist. Existing rows are never re-pointed.
//
// A bot with an active webhook rejects getUpdates (Telegram conflict). Such
// bots get a temporary deleteWebhook → poll → restore so discovery still
// works — the webhook URL/limits are restored exactly as they were.
export async function syncChatsFromBots(): Promise<{ added: number; bots: number; errors: string[] }> {
  const errors: string[] = [];
  const targets: Array<{ label: string; token: string; botId: string | null }> = [];
  if (TELEGRAM_BOT_TOKEN) targets.push({ label: "primary bot", token: TELEGRAM_BOT_TOKEN, botId: null });
  const bots = await listBots().catch(() => new Map<string, BotRow>());
  for (const b of bots.values()) {
    const tok = String(b.token ?? "").trim();
    if (!tok) continue;
    targets.push({ label: b.name ?? b.id, token: tok, botId: b.id });
  }

  const UPDATES_ALLOWED = { timeout: 0, limit: 100, allowed_updates: ["message", "channel_post", "my_chat_member"] };
  let added = 0;
  for (const t of targets) {
    let updates: Array<Record<string, unknown>> = [];
    try {
      try {
        updates = (await telegramCall("getUpdates", UPDATES_ALLOWED, t.token)) as Array<Record<string, unknown>>;
      } catch (e) {
        if (!/webhook/i.test(String(e instanceof Error ? e.message : e))) throw e;
        let wh: Record<string, unknown> | null = null;
        try {
          wh = (await telegramCall("getWebhookInfo", {}, t.token)) as Record<string, unknown> | null;
        } catch { /* nothing to log */ }
        const url = String(wh?.url ?? "").trim();
        // Real-time discovery webhook (the admin function's /telegram-webhook
        // path) already covers this bot — leave it alone; getUpdates would
        // just conflict and draining it would break instant discovery.
        if (TG_WEBHOOK_BASE && url.startsWith(TG_WEBHOOK_BASE)) continue;
        // Anything else is a webhook this deployment cannot receive — clear it
        // permanently so the 24h getUpdates scan can discover chats.
        await telegramCall("deleteWebhook", { drop_pending_updates: false }, t.token).catch(() => {});
        await logActivity(
          "chat",
          "warning",
          `Cleared stale webhook for "${t.label}" so chat discovery (getUpdates) can work`,
          url ? `was: ${url}` : "no webhook URL was returned",
        );
        updates = (await telegramCall("getUpdates", UPDATES_ALLOWED, t.token)) as Array<Record<string, unknown>>;
      }
      for (const u of updates) {
        const myChatMember = u.my_chat_member as Record<string, unknown> | undefined;
        const chat =
          (u.message ?? u.channel_post ?? u.edited_channel_post)?.chat ??
          myChatMember?.chat;
        if (!chat || typeof chat !== "object") continue;
        // my_chat_member also fires when the bot is REMOVED from a group or
        // channel — a kicked/left bot cannot post there, so never register it.
        if (myChatMember) {
          const status = (myChatMember.new_chat_member as Record<string, unknown> | undefined)?.status;
          if (status === "left" || status === "kicked") continue;
        }
        const cid = Number((chat as Record<string, unknown>).id ?? 0);
        if (!cid) continue;
        const exists = await rest<Array<{ id: string }>>("chats", { query: `chat_id=eq.${cid}&limit=1` }).catch(() => []);
        if (Array.isArray(exists) && exists.length > 0) continue;
        try {
          await rest("chats", {
            method: "POST",
            body: {
              chat_id: cid,
              title: (chat as Record<string, unknown>).title ?? (chat as Record<string, unknown>).username ?? null,
              username: (chat as Record<string, unknown>).username ?? null,
              type: (chat as Record<string, unknown>).type ?? "private",
              active: true,
              bot_id: t.botId,
              last_seen_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
            prefer: "return=minimal",
          });
          added += 1;
        } catch (e) {
          errors.push(`${t.label}: failed to persist chat ${cid}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      errors.push(`${t.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { added, bots: targets.length, errors };
}
export async function logActivity(type: string, level: string, message: string, detail?: string): Promise<void> {
  try {
    await rest("activity_log", { method: "POST", body: { type, level, message, detail }, prefer: "return=minimal" });
  } catch {
    /* never break the pipeline */
  }
}
export async function getKnownRawKeys(keys: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const rows = await rest<Array<{ dedup_key: string }>>("raw_articles", {
      query: `select=dedup_key&dedup_key=in.(${chunk.map(enc).join(",")})`,
    });
    for (const r of rows ?? []) known.add(r.dedup_key);
  }
  return known;
}
function isDuplicateConflict(err: unknown): boolean {
  return /\[409\]/.test(err instanceof Error ? err.message : String(err));
}

export async function insertRawArticle(row: Record<string, unknown>): Promise<boolean> {
  try {
    await rest("raw_articles", { method: "POST", body: row, prefer: "return=minimal" });
    return true;
  } catch (err) {
    if (isDuplicateConflict(err)) return false;
    throw err;
  }
}

// Returns false only when the unique dedup key already exists. Operational
// failures must reach the caller; otherwise raw_articles can suppress the
// article forever even though its queue insert failed.
export async function insertQueueItem(row: Record<string, unknown>): Promise<boolean> {
  try {
    await rest("queue", { method: "POST", body: row, prefer: "return=minimal" });
    return true;
  } catch (err) {
    if (isDuplicateConflict(err)) return false;
    throw err;
  }
}
export async function listQueued(): Promise<Array<Record<string, unknown>>> {
  // No tight newest-60 window: the queue routinely holds 100+ items and a
  // high-score / breaking item queued early would fall outside a small window
  // and be starved forever (it never even reaches the publish sort). Fetch up
  // to PostgREST's max rows so the sort + gates see the whole backlog.
  return (await rest<Array<Record<string, unknown>>>("queue", { query: "select=*&status=eq.queued&order=created_at.desc&limit=1000" })) ?? [];
}
export async function setQueueStatus(id: string, status: string): Promise<void> {
  await rest("queue", { method: "PATCH", query: `id=eq.${enc(id)}`, body: { status }, prefer: "return=minimal" });
}
// delete-after-post: once a queue row lands in every active chat we drop it
// from Postgres immediately, so the queue table does not grow with each
// published story. Dedup memory moves to published_history and is sized by
// the configured cooldown window (see pruneQueueAndRetain).
export async function deleteQueueRow(id: string): Promise<void> {
  await rest("queue", { method: "DELETE", query: `id=eq.${enc(id)}`, prefer: "return=minimal" });
}
export async function listRecentPublished(take = 200): Promise<Array<Record<string, unknown>>> {
  return (await rest<Array<Record<string, unknown>>>("published_history", { query: `select=*&order=published_at.desc&limit=${take}` })) ?? [];
}
// Exact per-category daily publish count — the category-policy cap must not
// depend on how many rows fit in the recent-published window (a heavy day
// would undercount and let a category flood past its limit). Why-it-matters
// rows carry category "analysis" but are exempt from caps, so they are
// excluded here too (matches the publish-side isAnalysis exemption).
export async function countCategoryPublishedToday(category: string): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const rows = await rest<Array<{ id: string }>>("published_history", {
    query: `select=id&category=eq.${enc(category)}&published_at=gte.${enc(day)}&analysis_kind=is.null&status=neq.sending&limit=1000`,
  }).catch(() => []);
  return rows?.length ?? 0;
}
// Active event clusters for cluster-aware event_id assignment (see
// matchEventCluster in _shared.ts). Only clusters seen within the cutoff are
// candidates so a 3-day-old event never swallows a genuinely new one.
export async function listActiveClusters(cutoffHours = 48): Promise<Array<Record<string, unknown>>> {
  const cutoff = new Date(Date.now() - cutoffHours * 3_600_000).toISOString();
  return (await rest<Array<Record<string, unknown>>>("clusters", {
    query: `select=event_id,label,category,post_count,last_source_text&last_seen_at=gte.${enc(cutoff)}&limit=300`,
  })) ?? [];
}

// ── Translation cache (saves Gemini calls when the same text is republished) ─
export async function getTranslationCache(inputText: string, glossary?: string): Promise<{ kurdish: string; model: string } | null> {
  try {
    const key = await sha256hex(translationCacheKey(inputText, glossary));
    const rows = await rest<Array<{ kurdish_text: string; model: string }>>("translation_history", {
      query: `select=kurdish_text,model&cache_key=eq.${enc(key)}&limit=1`,
    });
    const r = rows?.[0];
    return r && r.kurdish_text ? { kurdish: r.kurdish_text, model: r.model } : null;
  } catch {
    return null;
  }
}
export async function saveTranslationCache(inputText: string, kurdish: string, model: string, glossary?: string): Promise<void> {
  try {
    const key = await sha256hex(translationCacheKey(inputText, glossary));
    await rest("translation_history", {
      method: "POST",
      body: { english_text: inputText.slice(0, 900), kurdish_text: kurdish, model, cache_key: key, created_at: new Date().toISOString() },
      prefer: "return=minimal",
    });
  } catch {
    /* cache must never break publish */
  }
}

// ── Source fetch health ─────────────────────────────────────────────────────
// Per-channel last_success_at / last_error / consecutive_failures so the
// dashboard can show exactly why a channel went quiet instead of the old
// silent `catch { /* skip channel */ }`.
export async function patchSourceHealth(id: string, lastError: string | null, consecutiveFailures: number): Promise<void> {
  if (!id) return;
  const patch: Record<string, unknown> = { consecutive_failures: consecutiveFailures };
  if (lastError === null) patch.last_success_at = new Date().toISOString();
  else patch.last_error = lastError.slice(0, 300);
  await rest("sources", { method: "PATCH", query: `id=eq.${enc(id)}`, body: patch, prefer: "return=minimal" }).catch(() => {});
}

// Persist a channel's Telegram snapshot fingerprint + next-fetch backoff into
// its sources.config row (best-effort; a failed write just re-fetches sooner).
export async function patchSourceSnapshot(id: string, fp: string, nextFetchAt: number, instantWatermarkAt?: string | null): Promise<void> {
  if (!id) return;
  try {
    const rows = await rest<Array<{ config: unknown }>>("sources", { query: `id=eq.${enc(id)}&select=config&limit=1` });
    const cfg = (rows?.[0]?.config as Record<string, unknown> | null) ?? {};
    const nextConfig: Record<string, unknown> = { ...cfg, snapshot_fp: fp, next_fetch_at: nextFetchAt };
    if (instantWatermarkAt) nextConfig.instant_watermark_at = instantWatermarkAt;
    await rest("sources", {
      method: "PATCH",
      query: `id=eq.${enc(id)}`,
      body: { config: nextConfig },
      prefer: "return=minimal",
    });
  } catch {
    /* snapshot state is best-effort */
  }
}

export async function bumpSourceFailure(
  id: string,
  msg: string,
  autoPause: { enabled: boolean; threshold: number } | null,
): Promise<{ first: boolean; autoPaused: boolean; failures: number } | null> {
  if (!id) return null;
  try {
    const rows = await rest<Array<{ consecutive_failures: number; enabled: boolean }>>("sources", {
      query: `id=eq.${enc(id)}&select=consecutive_failures,enabled&limit=1`,
    });
    const row = rows?.[0];
    if (!row) return null;
    const failures = Number(row.consecutive_failures ?? 0) + 1;
    const patch: Record<string, unknown> = { consecutive_failures: failures, last_error: msg.slice(0, 300) };
    let autoPaused = false;
    if (autoPause?.enabled && failures >= autoPause.threshold && row.enabled !== false) {
      patch.enabled = false;
      patch.auto_paused = true;
      patch.auto_pause_reason = `Telegram fetch failed ${failures} consecutive times: ${msg.slice(0, 120)}`;
      autoPaused = true;
    }
    await rest("sources", { method: "PATCH", query: `id=eq.${enc(id)}`, body: patch, prefer: "return=minimal" });
    return { first: failures === 1, autoPaused, failures };
  } catch {
    return null;
  }
}

// ── Source daily quota tracking ────────────────────────────────────────────
// NewsData charges per API request, so `used_today` counts successful calls
// (failed requests don't consume a credit). The counter rolls over at
// midnight so the dashboard's "X / 200 used today" stays honest instead of
// the old always-zero placeholder.
export async function bumpSourceQuota(id: string, calls: number): Promise<void> {
  if (!id || calls <= 0) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await rest<Array<{ used_today: number; quota_date: string }>>("sources", {
      query: `id=eq.${enc(id)}&select=used_today,quota_date&limit=1`,
    });
    const row = rows?.[0];
    const patch = computeQuotaPatch(today, row?.used_today, row?.quota_date, calls);
    await rest("sources", { method: "PATCH", query: `id=eq.${enc(id)}`, body: patch, prefer: "return=minimal" });
  } catch {
    /* quota tracking must never break ingest */
  }
}

// ── Queue pruning + table retention (free-plan row hygiene) ─────────────
// Runs at the top of every cycle; keeps the DB from growing unbounded:
//   queue:                queued older than 24h -> expired; non-queued > 1h -> deleted
//   raw_articles:         > 48h deleted (dedup memory — freshness window is <= 24h)
//   published_history:    > 7d deleted (dedup cooldown + the dashboard's
//                         24h/7d analytics read this table)
//   translation_history:  > 16h deleted (cache — cooldown window is 8h)
//   clusters:             > 3d deleted (event identity window)
//   activity_log:         > 3d deleted
//   translation_failures / gemini_call_log: > 7d deleted
//   ai_usage:             > 30d deleted
export async function pruneQueueAndRetain(): Promise<void> {
  // Delete-after-post sweep. Defaults below match the operator's
  // "minimum Supabase consumption" stance: rows are kept only as long as
  // they serve an active dedup / audit / translation-cache purpose.
  //   - queue rows get DELETE-d in runPublish() on successful publish
  //     (see `deleteQueueRow`). This prune just sweeps the trailing
  //     orphans (function crash left status="publishing", plus the
  //     expired/duplicate/rejected rows that the publish path marks).
  //   - published_history is the dedup memory AND the dashboard analytics
  //     source (Published 24h stat + 7-day chart), so it is retained for 7d.
  //   - translation_history / clusters serve the cooldown window only.
  //   - raw_articles, ai_usage, activity_log, gemini_call_log: tighter
  //     since none are read in the publish hot path.
  const now = Date.now();
  const queuedCutoff = new Date(now - 24 * 3_600_000).toISOString();
  const orphanQueueCutoff = new Date(now - 1 * 3_600_000).toISOString();
  const dedupWindowCutoff = new Date(now - 16 * 3_600_000).toISOString();
  const publishedHistoryCutoff = new Date(now - 7 * 86_400_000).toISOString();   // 7d — dashboard analytics + dedup
  const clusterCutoff = new Date(now - 3 * 86_400_000).toISOString();            // 3d — event identity window
  const rawCutoff = new Date(now - 48 * 3_600_000).toISOString();                // was 21d
  const activityCutoff = new Date(now - 3 * 86_400_000).toISOString();           // was 30d
  const geminiCutoff = new Date(now - 7 * 86_400_000).toISOString();             // was 14d
  const usageDayCutoff = new Date(now - 30 * 86_400_000).toISOString().slice(0, 10);
  try {
    // Anything still "queued" after 24h is no longer news — mark expired.
    await rest("queue", {
      method: "PATCH",
      query: `status=eq.queued&created_at=lt.${enc(queuedCutoff)}`,
      body: { status: "expired" },
      prefer: "return=minimal",
    });
    // Orphaned rows (cycle crashed mid-publish) older than 1h → delete so
    // they can be re-queued. Successfully published rows normally get
    // deleted inline by runPublish(); this catches survivors AND sweeps the
    // expired/duplicate/rejected rows so they never accumulate (the old code
    // only ever deleted publishing/published, so "expired" rows leaked
    // forever and slowly filled the dashboard's queue window with dead rows).
    await rest("queue", {
      method: "DELETE",
      query: `status=in.(publishing,published,expired,duplicate,rejected)&created_at=lt.${enc(orphanQueueCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("raw_articles", {
      method: "DELETE",
      query: `fetched_at=lt.${enc(rawCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("published_history", {
      method: "DELETE",
      query: `published_at=lt.${enc(publishedHistoryCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("translation_history", {
      method: "DELETE",
      query: `created_at=lt.${enc(dedupWindowCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("clusters", {
      method: "DELETE",
      query: `last_seen_at=lt.${enc(clusterCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("activity_log", {
      method: "DELETE",
      query: `created_at=lt.${enc(activityCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("gemini_call_log", {
      method: "DELETE",
      query: `at=lt.${enc(geminiCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("translation_failures", {
      method: "DELETE",
      query: `created_at=lt.${enc(geminiCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("ai_usage", {
      method: "DELETE",
      query: `day=lt.${enc(usageDayCutoff)}`,
      prefer: "return=minimal",
    });
    // Max-queue auto-trim: when the queued backlog exceeds the configured cap
    // (settings.max_queue_size, default 150), drop the lowest-scored
    // NON-breaking items beyond the cap so the queue can't balloon. Breaking
    // items are never trimmed (they need operator review); 0 disables the trim.
    await trimQueueToCap().catch(() => {});
  } catch {
    /* retention must never break the cycle */
  }
}

// Standalone max-queue trim (extracted from pruneQueueAndRetain so the cap is
// also enforced right after ingest adds items, not only at cycle start). When
// the queued backlog exceeds max_queue_size, drop the lowest-scored
// NON-breaking items beyond the cap. Breaking items are never trimmed (they
// need operator review); 0 disables the trim. Never throws.
export async function trimQueueToCap(): Promise<void> {
  const maxQueueSize = Math.max(0, Math.floor(Number((await getSettings().catch(() => null))?.max_queue_size ?? 150)));
  if (maxQueueSize <= 0) return;
  const queued = await rest<Array<{ id: string }>>("queue", { query: "select=id&status=eq.queued&limit=1000" }).catch(() => []);
  const overflow = (queued?.length ?? 0) - maxQueueSize;
  if (overflow <= 0) return;
  const victims = await rest<Array<{ id: string }>>("queue", {
    query: `select=id&status=eq.queued&breaking=eq.false&order=score.asc&limit=${overflow}`,
  }).catch(() => []);
  const ids = (victims ?? []).map((v) => String(v.id)).filter(Boolean);
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    await rest("queue", {
      method: "DELETE",
      query: `id=in.(${batch.map(enc).join(",")})`,
      prefer: "return=minimal",
    }).catch(() => {});
  }
  if (ids.length > 0) {
    await logActivity("queue", "info", `Auto-trim: dropped ${ids.length} lowest-score item(s) over the ${maxQueueSize}-item cap`);
  }
}

