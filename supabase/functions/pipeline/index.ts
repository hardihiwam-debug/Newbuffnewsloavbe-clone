// Iran Desk Bot — Supabase Edge Function pipeline (entrypoint + scheduler).
// Replaces the Convex ingest/publish crons: fetch → filter → dedup →
// fact-extract (Groq) → enqueue → translate (MiniMax → Gemini direct) →
// publish to Telegram. Persists everything in Supabase Postgres via PostgREST.
//
// Scheduled by pg_cron every minute (net.http_post). The function self-gates
// on the editable intervals (ingestIntervalMinutes) and the day/night window
// cadence, so the schedule is just a ticker.
//
// Split refactor: the pipeline logic now lives in sibling modules
// (config / db / telegram / fetch / gates / ai / publish / ingest). This file
// only keeps the scheduler (runCycle + mode dispatch) and the HTTP entry.
// No behavior change.

import { dedupeChats, fingerprintArticle, matchPublishedFingerprint, relevanceGate } from "./_shared.ts";
import { AUTO_PUBLISH_BATCH_SIZE, INTERNAL_SECRET, PUBLISH_BATCH_SIZE, SettingsRow } from "./config.ts";
import { enc, getSettings, listActiveChats, listQueued, listRecentPublished, logActivity, patchSettings, pruneQueueAndRetain, reportRunProgress, rest, syncChatsFromBots } from "./db.ts";
import { runIngest } from "./ingest.ts";
import { buildDedupContext, deletePublishedPost, isRepeated, queueEffectiveScore, runPublish } from "./publish.ts";

// ── Cadence ─────────────────────────────────────────────────────────────────
export function minutesOfDay(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(d);
  const [h, m] = parts.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
export function parseTime(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
export function inWindow(now: number, start: number, end: number): boolean {
  return start <= end ? now >= start && now < end : now >= start || now < end;
}
export function isNight(s: SettingsRow): boolean {
  const now = minutesOfDay(new Date(), String(s.timezone ?? "Asia/Baghdad"));
  return inWindow(now, parseTime(String(s.night_start ?? s.nightStart ?? "23:00")), parseTime(String(s.night_end ?? s.nightEnd ?? "08:00")));
}
export function randomInt(lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// ── Main handler ────────────────────────────────────────────────────────────
// Dry-run of runPublish's selection step: same scoring + dedup gates, no
// sends, no row mutations. Powers the dashboard "Preview next batch" dialog
// so each candidate shows an honest ready / duplicate / blocked status with
// a reason instead of the old "dump raw queue rows and call them blocked".
export async function computePublishPreview(settings: SettingsRow, limit = 5): Promise<Record<string, unknown>> {
  const chats = dedupeChats(await listActiveChats());
  const pool = await listQueued();
  const recentPublished = await listRecentPublished(200);
  const cooldownHours = Number(settings.event_cooldown_hours ?? 8);
  const dedup = buildDedupContext(recentPublished, cooldownHours);
  const simThreshold = Number(settings.event_similarity_threshold ?? 0.52);
  const language = (settings.default_language ?? "en") === "both" ? "ckb" : String(settings.default_language ?? "en");

  const blockedReason = settings.bot_paused
    ? "Bot is paused"
    : chats.length === 0
      ? "No active destination chats configured"
      : null;

  const sorted = [...pool].sort((a, b) => {
    if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
    return queueEffectiveScore(b) - queueEffectiveScore(a);});





  const items = sorted.slice(0, limit).map((q) => {
    const headline = String(q.headline ?? "");
    const summary = String(q.summary ?? "");
    const fp = fingerprintArticle(headline, summary);
    const repeated =
      isRepeated({ dedup_key: String(q.dedup_key ?? ""), headline, summary }, dedup, simThreshold) ||
      Boolean(fp && matchPublishedFingerprint(fp, dedup.publishedFingerprintList));
    // Mirror the publish-time beat gate so "Preview next batch" never says
    // "ready" for an item the publish loop will drop. Same rule as runPublish:
    // Telegram fast-lane channels (@-sourced, the operator's hand-picked
    // feeds) are exempt; analysis follow-ups are exempt.
    const sourceName = String(q.source_name ?? "");
    const isAnalysis = String(q.analysis_kind ?? "") === "why_it_matters";
    const offBeat =
      !isAnalysis &&
      !sourceName.startsWith("@") &&
      !relevanceGate(String(q.source_text ?? `${headline} ${summary}`), "").ok;
    const status = blockedReason ? "blocked" : offBeat ? "blocked" : repeated ? "duplicate" : "ready";
    const reason = blockedReason
      ? blockedReason
      : offBeat
        ? "Off-beat — rejected at publish by the relevance gate"
        : repeated
          ? "Already published (or too similar) within the cooldown window"
          : "Would publish next";
    return {
      _id: q.id,
      headline,
      summary,
      category: String(q.category ?? ""),
      score: Number(q.score ?? 0),
      sourceName: String(q.source_name ?? ""),
      breaking: Boolean(q.breaking),
      members: [],
      status,
      reason,
    };});





  return {
    paused: Boolean(settings.bot_paused),
    chats: chats.length,
    queued: pool.length,
    language,
    items,
  };
}


// Stale window must exceed the WORST legitimate cycle, not just the budget:
// a cycle stops STARTING new work at 100s but its last in-flight AI chunk
// (~15s) plus publish can push total wall time past 120s. If the lock went
// stale mid-cycle, the next cron tick would claim it and run concurrently.
// 150s matches the Supabase worker kill ceiling — anything still holding the
// lock by then is genuinely dead (killed workers never reach the finally).
const STALE_LOCK_MS = 150_000;

export async function acquireLock(settings: SettingsRow): Promise<string | null> {
  // Conditional UPDATE prevents two fresh callers from claiming the lock.
  // Ownership is also persisted so an older invocation cannot release a
  // newer invocation's lease after the stale window has elapsed.
  const owner = crypto.randomUUID();
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const claimed = await rest<Array<{ id: string }>>("settings", {
    method: "PATCH",
    query: `id=eq.${enc(String(settings.id))}&or=(publish_run_lock_at.is.null,publish_run_lock_at.lt.${enc(staleBefore)})`,
    body: { publish_run_lock_at: new Date().toISOString(), publish_run_lock_owner: owner },
    prefer: "return=representation",
  }).catch(() => []);
  return Array.isArray(claimed) && claimed.length > 0 ? owner : null;
}
export async function releaseLock(settings: SettingsRow, owner: string): Promise<void> {
  await rest("settings", {
    method: "PATCH",
    query: `id=eq.${enc(String(settings.id))}&publish_run_lock_owner=eq.${enc(owner)}`,
    body: { publish_run_lock_at: null, publish_run_lock_owner: null },
    prefer: "return=minimal",});




}

export function windowGapOk(settings: SettingsRow, now = Date.now()): { ok: boolean; gapMinutes: number; night: boolean } {
  const floor = Math.max(0, Number(settings.min_post_gap_minutes ?? 1));
  const night = isNight(settings);
  const dayLo = Math.max(floor, Number(settings.day_min_minutes ?? 6));
  const dayHi = Math.max(dayLo, Number(settings.day_max_minutes ?? 16));
  const nightLo = Math.max(floor, Number(settings.night_min_minutes ?? 10));
  const nightHi = Math.max(nightLo, Number(settings.night_max_minutes ?? 20));
  const gapMinutes = night ? randomInt(nightLo, nightHi) : randomInt(dayLo, dayHi);
  const last = settings.last_published_at as string | undefined;
  if (!last) return { ok: true, gapMinutes, night };
  const since = now - Date.parse(last);
  if (Number.isFinite(since) && since >= 0 && since < gapMinutes * 60_000) {
    return { ok: false, gapMinutes, night };
  }
  return { ok: true, gapMinutes, night };
}

export async function runCycle(force: boolean): Promise<Record<string, unknown>> {
  let settings = await getSettings();
  if (!settings) throw new Error("Settings row missing");
  if (settings.bot_paused) return { skipped: "bot paused" };

  // Retention/pruning runs even while a publish lock is held (cheap PATCH/DELETEs).
  await pruneQueueAndRetain().catch(() => {});



  // Auto chat discovery — re-scan every bot's recent Telegram updates at most
  // once per 24h so a new user/channel that messaged the bot is registered and
  // starts receiving news without pressing Sync chats. Deliberately NOT gated
  // on force: a manual publish must not trigger getUpdates (which drains a
  // webhook-backed bot's pending update queue). Runs before the publish lock
  // so discovery can never hold up publishing.
  const lastChatSync = settings.last_chat_sync_at as string | undefined;
  if (!lastChatSync || Date.now() - Date.parse(lastChatSync) >= 24 * 3_600_000) {
    try {
      const syncStats = await syncChatsFromBots();
      if (syncStats.added > 0 || syncStats.errors.length > 0) {
        await logActivity(
          "system",
          syncStats.errors.length > 0 ? "warning" : "info",
          `Auto chat sync: ${syncStats.added} new chat(s) across ${syncStats.bots} bot(s)${syncStats.errors.length ? `, ${syncStats.errors.length} error(s)` : ""}`,
        );
      }
      await patchSettings(String(settings.id), { last_chat_sync_at: new Date().toISOString() });


    } catch (err) {
      await logActivity("system", "warning", `Auto chat sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const lockOwner = await acquireLock(settings);
  if (!lockOwner) return { skipped: "publish run in progress" };
  try {
    // Hard time budget: Supabase kills the worker at ~150s
    // (WORKER_RESOURCE_LIMIT) and a killed cycle never reaches the finally
    // that releases the publish lock — which is what silently halted the bot
    // before. Stop starting new work before the ceiling so every cycle
    // finishes, releases the lock, and keeps ingesting/publishing.
    const cycleStart = Date.now();
    const budgetMs = 100_000; // ~50s headroom under the worker limit
    const budgetLeft = () => Date.now() - cycleStart < budgetMs;
    // Telegram fast lane: check channels every N minutes and publish any
    // breaking story immediately (no queue wait, no window-gap gate).
    const lastTg = settings.last_telegram_signals_at as string | undefined;
    const tgInterval = Math.max(1, Number(settings.telegram_signals_interval_minutes ?? 5));
    const tgDue = force || !lastTg || Date.now() - Date.parse(lastTg) >= tgInterval * 60_000;
    let tgStats: Record<string, unknown> | null = null;
    if (tgDue) {
      try {
        tgStats = await runIngest(settings, "telegram", { deadline: cycleStart + budgetMs });


      } catch (err) {
        await logActivity("ingest", "error", `Telegram signals failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      settings = (await getSettings()) ?? settings;
    }

    const lastIngest = settings.last_ingest_at as string | undefined;
    const ingestInterval = Math.max(1, Number(settings.ingest_interval_minutes ?? 15));
    const ingestDue = force || !lastIngest || Date.now() - Date.parse(lastIngest) >= ingestInterval * 60_000;
    let ingestStats: Record<string, unknown> | null = null;
    if (ingestDue) {
      try {
        ingestStats = await runIngest(settings, "all", { deadline: cycleStart + budgetMs });


      } catch (err) {
        await logActivity("ingest", "error", `Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      settings = (await getSettings()) ?? settings;
    }

    // Instant Telegram channels publish every newly ingested Instant item in
    // this cycle. There is no per-cycle count cap and no artificial delay;
    // runPublish still uses the durable queue row as an outbox, reserves each
    // destination before sending, and stops only at the worker deadline.
    const instantQueued = Number(tgStats?.instantQueued ?? 0) + Number(ingestStats?.instantQueued ?? 0);
    // Retained Instant rows are a durable outbox for ambiguous/partial
    // Telegram delivery. Drain them on the next cycle even when no new post
    // arrived, otherwise a failed send could wait indefinitely behind the
    // "newly ingested" trigger.
    const pendingInstant = (await listQueued()).filter((item) => {
      const parts = (item.score_parts as Record<string, unknown> | null) ?? {};
      return parts.instant === true || Number(parts.boost ?? 0) >= 150;
    }).length;
    if ((instantQueued > 0 || pendingInstant > 0) && budgetLeft()) {
      const instantStats = await runPublish(settings, Math.max(instantQueued, pendingInstant), null, { instantOnly: true, deadline: cycleStart + budgetMs });
      return { telegram: tgStats, ingest: ingestStats, instant: instantStats };
    }

    // Telegram fast lane: publish any NEW related post within the 5-minute
    // fetch cadence, 24/7 (not just "breaking" ones, not just the day window)
    // so the channel always feels live. Cap at 1 per cycle so a burst doesn't
    // flood subscribers. Web/news/RSS content still follows the day/night gap
    // cadence in the fall-through path below.
    if (tgStats && Number(tgStats.queued) > 0 && budgetLeft()) {
      const remainingSec = Math.max(0, (cycleStart + budgetMs - Date.now()) / 1000);
      const tgBatch = Math.max(1, Math.min(AUTO_PUBLISH_BATCH_SIZE, Number(tgStats.queued), Math.floor(remainingSec / 35)));
      const publishStats = await runPublish(settings, tgBatch, null, { deadline: cycleStart + budgetMs });


      return { telegram: tgStats, ingest: ingestStats, publish: publishStats };
    }

    const gap = windowGapOk(settings);
    if (!force && !gap.ok) return { skipped: `window gap (${gap.gapMinutes} min ${gap.night ? "night" : "day"})`, telegram: tgStats, ingest: ingestStats };
    if (!budgetLeft()) return { skipped: "time budget (publish deferred)", telegram: tgStats, ingest: ingestStats };

    const remainingSec = Math.max(0, (cycleStart + budgetMs - Date.now()) / 1000);
    const batch = Math.max(1, Math.min(AUTO_PUBLISH_BATCH_SIZE, Math.floor(remainingSec / 35)));
    const publishStats = await runPublish(settings, batch, null, { deadline: cycleStart + budgetMs });


    return { telegram: tgStats, ingest: ingestStats, publish: publishStats };
  } finally {
    await releaseLock(settings, lockOwner).catch(() => {});


  }
}Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });


  }
  if (INTERNAL_SECRET) {
    const provided = req.headers.get("x-internal-secret") ?? "";
    if (provided !== INTERNAL_SECRET) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });


    }
  }
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "cycle";
  const force = url.searchParams.get("force") === "1";
  try {
    if (mode === "preview") {
      const settings = await getSettings();
      if (!settings) throw new Error("Settings row missing");
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") ?? 5)));
      const stats = await computePublishPreview(settings, limit);
      return new Response(JSON.stringify(stats), { status: 200, headers: { "Content-Type": "application/json"  }
});



    }
    if (mode === "ingest") {
      const settings = await getSettings();
      if (!settings) throw new Error("Settings row missing");
      // Manual ingest claims the publish lock too so it can't race the cron
      // cycle's ingest phase (two concurrent fetches double-queue rows).
      const lockOwner = await acquireLock(settings);
      if (!lockOwner) {
        await reportRunProgress(String(settings.id), { action: "ingest", message: "Another pipeline run is in progress — skipped", done: true, at: new Date().toISOString() }).catch(() => {});
        return new Response(JSON.stringify({ skipped: "publish run in progress" }), { status: 200, headers: { "Content-Type": "application/json"  }
});



      }
      const startedAt = new Date().toISOString();
      await reportRunProgress(String(settings.id), { action: "ingest", message: "Fetching sources…", item: 0, total: 0, startedAt, done: false, at: startedAt }).catch(() => {});
      try {
        const stats = await runIngest(settings, "all", { reportProgress: true });
        await reportRunProgress(String(settings.id), {
          action: "ingest",
          message: `Ingest complete — ${stats.fetched ?? 0} fetched, ${stats.queued ?? 0} queued`,
          item: 0, total: 0, startedAt, done: true, at: new Date().toISOString(),
        }).catch(() => {});
        return new Response(JSON.stringify(stats), { status: 200, headers: { "Content-Type": "application/json"  }
});



      } catch (err) {
        await reportRunProgress(String(settings.id), {
          action: "ingest",
          message: `Ingest failed — ${err instanceof Error ? err.message : String(err)}`,
          item: 0, total: 0, startedAt, done: true, at: new Date().toISOString(),
        }).catch(() => {});
        throw err;
      } finally {
        await releaseLock(settings, lockOwner).catch(() => {});


      }
    }
    if (mode === "delete") {
      // Console "delete a published post": the admin function forwards here
      // with the published_history row id; the bot token stays in this
      // function. No publish lock needed — Telegram deleteMessage is safe to
      // race with a send cycle (a concurrently re-sent story is the operator's
      // call, and deleteMessage is idempotent on a missing message).
      const id = url.searchParams.get("id") ?? "";
      if (!id) {
        return new Response(JSON.stringify({ ok: false, error: "id required" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const result = await deletePublishedPost(id);
      return new Response(JSON.stringify(result), { status: result.ok ? 200 : 404, headers: { "Content-Type": "application/json" } });
    }
    if (mode === "publish") {
      const settings = await getSettings();
      if (!settings) throw new Error("Settings row missing");
      // Manual publish must respect the same lock as the cron cycle — a
      // "Publish now" racing the 1-minute ticker would otherwise read the
      // same queue row concurrently and double-send.
      const lockOwner = await acquireLock(settings);
      if (!lockOwner) {
        await reportRunProgress(String(settings.id), { action: "publish", message: "Another pipeline run is in progress — skipped", done: true, at: new Date().toISOString() }).catch(() => {});
        return new Response(JSON.stringify({ skipped: "publish run in progress" }), { status: 200, headers: { "Content-Type": "application/json"  }
});



      }
      const startedAt = new Date().toISOString();
      await reportRunProgress(String(settings.id), { action: "publish", message: "Publishing…", item: 0, total: 0, startedAt, done: false, at: startedAt }).catch(() => {});
      try {
        const onlyId = url.searchParams.get("id");
        const stats = await runPublish(settings, PUBLISH_BATCH_SIZE, onlyId, { deadline: Date.now() + 100_000 });
        await reportRunProgress(String(settings.id), {
          action: "publish",
          message: `Publish complete — ${stats.sent ?? 0} sent`,
          item: 0, total: 0, startedAt, done: true, at: new Date().toISOString(),
        }).catch(() => {});

        return new Response(JSON.stringify(stats), { status: 200, headers: { "Content-Type": "application/json"  }
});



      } catch (err) {
        await reportRunProgress(String(settings.id), {
          action: "publish",
          message: `Publish failed — ${err instanceof Error ? err.message : String(err)}`,
          item: 0, total: 0, startedAt, done: true, at: new Date().toISOString(),
        }).catch(() => {});
        throw err;
      } finally {
        await releaseLock(settings, lockOwner).catch(() => {});


      }
    }
    const result = await runCycle(force);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json"  }
});



  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });


  }
});
