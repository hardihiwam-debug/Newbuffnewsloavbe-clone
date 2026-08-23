// Scheduled Posts / Campaign engine (separate automation lane).
//
// Ticked every minute by pg_cron (migration 0031) — publishes one-time,
// recurring and series campaigns (e.g. a 30-part Seerah series: Part N goes
// out at start + (N-1) × interval). State lives in the DB, so restarts never
// lose progress. Sends reuse the pipeline's proven Telegram path (sendPost:
// worker→R2 media relay, HTML parse mode) so behavior matches news posts.
//
// Rules (operator decisions):
//   - advance a series after the FIRST successful send (any target chat);
//   - a part that fails max_attempts times is auto-skipped (marked failed);
//   - sends ignore the day/night window, but respect settings.bot_paused;
//   - content is sent exactly as authored (no AI translation in v1);
//   - media scope v1: text + optional image (no video/buttons).

import { INTERNAL_SECRET, SERVICE_KEY, SUPABASE_URL, TELEGRAM_BOT_TOKEN } from "../pipeline/config.ts";
import { telegramCall } from "../pipeline/telegram.ts";
import { fitCaption } from "../pipeline/_shared.ts";
import { computeDueItems, recurringNextDueMs, seriesPartDueMs, seriesTerminalStatus } from "./_shared.ts";

// ── PostgREST helper (service role) ────────────────────────────────────────
async function rest<T = unknown>(
  path: string,
  opts: { method?: string; body?: Record<string, unknown>; query?: string; prefer?: string } = {},
): Promise<T> {
  const url = `${SUPABASE_URL}/rest/v1/${path}${opts.query ? `?${opts.query}` : ""}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${SERVICE_KEY}`,
    apikey: SERVICE_KEY,
    "Content-Type": "application/json",
  };
  if (opts.prefer) headers["Prefer"] = opts.prefer;
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`rest ${opts.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const enc = (v: string | number) => encodeURIComponent(String(v));

// ── Concurrency lock (mirrors the pipeline's atomic CAS) ───────────────────
const STALE_LOCK_MS = 120_000;

async function acquireLock(): Promise<string | null> {
  const owner = crypto.randomUUID();
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const claimed = await rest<Array<{ id: string }>>("settings", {
    method: "PATCH",
    query: `or=(scheduled_run_lock_at.is.null,scheduled_run_lock_at.lt.${enc(staleBefore)})`,
    body: { scheduled_run_lock_at: new Date().toISOString(), scheduled_run_lock_owner: owner },
    prefer: "return=representation",
  }).catch(() => []);
  return Array.isArray(claimed) && claimed.length > 0 ? owner : null;
}

async function releaseLock(owner: string): Promise<void> {
  await rest("settings", {
    method: "PATCH",
    query: `scheduled_run_lock_owner=eq.${enc(owner)}`,
    body: { scheduled_run_lock_at: null, scheduled_run_lock_owner: null },
    prefer: "return=minimal",
  }).catch(() => {});
}

// ── Cycle ──────────────────────────────────────────────────────────────────
type CampaignRow = {
  id: string;
  name: string;
  kind: "one_time" | "recurring" | "series";
  status: string;
  timezone: string;
  start_at: string | null;
  end_at: string | null;
  schedule: Record<string, unknown> | null;
  target_chat_ids: unknown;
  max_attempts: number;
  last_sent_at: string | null;
  next_send_at: string | null;
};
type ItemRow = {
  id: string;
  campaign_id: string;
  position: number;
  title: string | null;
  text: string;
  image_url: string | null;
  scheduled_for: string | null;
  status: string;
  attempts: number;
  force_due: boolean;
  sent_at?: string | null;
  error?: string | null;
};

const CYCLE_BUDGET_MS = 90_000;
const MAX_SENDS_PER_CYCLE = 12;

class DeliveryUnknownError extends Error {
  constructor(cause: unknown) {
    super(`Telegram delivery outcome is unknown: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DeliveryUnknownError";
  }
}

function isDefinitiveTelegramFailure(err: unknown): boolean {
  return /Telegram .* \[(400|401|403|404|413)\]/i.test(err instanceof Error ? err.message : String(err));
}

// ── Send path ──────────────────────────────────────────────────────────────
// Campaign content is sent EXACTLY as authored (no news-post template: no
// footer, no source line, no "read more" link). HTML parse mode preserves any
// intentional formatting; if the authored text breaks HTML parsing (raw <, &,
// …), we resend the same text as plain so the message is never lost. Images
// go through sendPhoto with a caption (the same fitCaption used by the news
// path so long posts are truncated cleanly instead of rejected).
async function sendText(chatId: number, token: string, body: string): Promise<void> {
  try {
    await telegramCall("sendMessage", { chat_id: chatId, text: body, parse_mode: "HTML", disable_web_page_preview: false }, token);
  } catch (err) {
    if (!isDefinitiveTelegramFailure(err)) throw new DeliveryUnknownError(err);
    // A known Telegram 4xx content error is safe to retry without HTML.
    await telegramCall("sendMessage", { chat_id: chatId, text: body, disable_web_page_preview: true }, token);
  }
}

async function sendCampaignItem(chatId: number, token: string, body: string, imageUrl: string | null): Promise<void> {
  if (imageUrl) {
    try {
      await telegramCall("sendPhoto", { chat_id: chatId, photo: imageUrl, caption: fitCaption(body, 1024), parse_mode: "HTML" }, token);
      return;
    } catch (err) {
      if (!isDefinitiveTelegramFailure(err)) throw new DeliveryUnknownError(err);
      // A known 4xx parse/media error is safe to retry without HTML.
      try {
        await telegramCall("sendPhoto", { chat_id: chatId, photo: imageUrl, caption: fitCaption(body, 1024) }, token);
        return;
      } catch (retryErr) {
        if (!isDefinitiveTelegramFailure(retryErr)) throw new DeliveryUnknownError(retryErr);
        /* fall through to text */
      }
    }
  }
  await sendText(chatId, token, body);
}

export async function runScheduledCycle(): Promise<Record<string, unknown>> {
  const cycleStart = Date.now();
  const budgetLeft = () => Date.now() - cycleStart < CYCLE_BUDGET_MS;
  const stats: Record<string, unknown> = { checked: 0, sent: 0, failed: 0, skipped: 0, items: [] as string[] };

  const settingsRows = await rest<Array<Record<string, unknown>>>("settings", { query: "limit=1" });
  const settings = settingsRows?.[0];
  if (!settings) throw new Error("settings row missing");
  // Respect the global pause (operator decision); ignore the day/night window.
  if (settings.bot_paused === true) {
    return { ...stats, skipped: "bot_paused" };
  }

  const campaignRows = await rest<CampaignRow[]>("scheduled_campaigns", {
    query: "select=*&limit=100",
  }).catch(() => [] as CampaignRow[]);
  const chatRows = await rest<Array<Record<string, unknown>>>("chats", {
    query: "select=id,chat_id,bot_id,active&limit=500",
  }).catch(() => [] as Array<Record<string, unknown>>);
  const chatById = new Map<number, Record<string, unknown>>();
  for (const c of chatRows) chatById.set(Number(c.chat_id), c);
  const botRows = await rest<Array<Record<string, unknown>>>("bots", {
    query: "select=id,token&limit=100",
  }).catch(() => [] as Array<Record<string, unknown>>);
  const tokenByBot = new Map<string, string>();
  for (const b of botRows) if (String(b.token ?? "")) tokenByBot.set(String(b.id), String(b.token));

  const now = Date.now();
  let sendsThisCycle = 0;

  for (const campaign of campaignRows) {
    if (!budgetLeft()) break;
    const cid = String(campaign.id);
    // A paused/completed/expired campaign is skipped (manual overrides set
    // force_due on items and the operator resumes the campaign to run them).
    if (campaign.status !== "active") continue;

    const items = await rest<ItemRow[]>("scheduled_items", {
      query: `campaign_id=eq.${enc(cid)}&order=position.asc&limit=500`,
    }).catch(() => [] as ItemRow[]);
    if (items.length === 0) continue;
    stats.checked = Number(stats.checked) + 1;
    const sentBefore = Number(stats.sent);

    // Target chats (active only, by chat_id).
    const targets: Array<{ chatId: number; token: string }> = [];
    const targetIds = (Array.isArray(campaign.target_chat_ids) ? campaign.target_chat_ids : []) as number[];
    for (const tid of targetIds) {
      const chat = chatById.get(Number(tid));
      if (!chat || chat.active === false) continue;
      if (chat.bot_id) {
        const token = tokenByBot.get(String(chat.bot_id));
        if (!token) continue;
        targets.push({ chatId: Number(tid), token });
      } else {
        if (!TELEGRAM_BOT_TOKEN) continue;
        targets.push({ chatId: Number(tid), token: TELEGRAM_BOT_TOKEN });
      }
    }
    if (targets.length === 0) continue;

    const due = computeDueItems({
      campaign: {
        kind: campaign.kind,
        start_at: campaign.start_at,
        end_at: campaign.end_at,
        timezone: campaign.timezone,
        schedule: campaign.schedule ?? {},
        max_attempts: campaign.max_attempts,
      },
      items: items.map((i) => ({
        position: i.position,
        status: i.status as ItemLike["status"],
        attempts: i.attempts,
        force_due: i.force_due === true,
        scheduled_for: i.scheduled_for,
      })),
      nowMs: now,
      lastSentAtMs: campaign.last_sent_at ? Date.parse(campaign.last_sent_at) : null,
    });
    const dueMap = new Map(due.map((d) => [d.position, d]));

    for (const item of items) {
      if (!budgetLeft() || sendsThisCycle >= MAX_SENDS_PER_CYCLE) break;
      if (!dueMap.has(item.position)) continue;
      if (item.status !== "pending") continue;
      if (item.force_due !== true && item.scheduled_for && Date.parse(item.scheduled_for) > now) continue;

      const body = item.title ? `${item.title}\n\n${item.text}` : item.text;
      const previousLogs = await rest<Array<{ chat_id: number; ok: boolean; sent_at: string }>>("scheduled_log", {
        query: `item_id=eq.${enc(item.id)}&ok=eq.true&limit=500`,
      }).catch(() => [] as Array<{ chat_id: number; ok: boolean; sent_at: string }>);
      const previousDeliveryCutoff = campaign.kind === "recurring" && item.sent_at ? Date.parse(item.sent_at) : null;
      const deliveredChatIds = new Set(
        previousLogs
          .filter((r) => previousDeliveryCutoff === null || Date.parse(r.sent_at) > previousDeliveryCutoff)
          .map((r) => Number(r.chat_id)),
      );
      const pendingTargets = targets.filter((t) => !deliveredChatIds.has(t.chatId));
      const sentOk: number[] = [];
      let deliveryUnknown = false;
      const chatResults: Array<{ chatId: number; ok: boolean; error: string | null }> = [];
      for (const t of pendingTargets) {
        try {
          await sendCampaignItem(t.chatId, t.token, body, item.image_url);
          sentOk.push(t.chatId);
          chatResults.push({ chatId: t.chatId, ok: true, error: null });
        } catch (err) {
          deliveryUnknown ||= err instanceof DeliveryUnknownError;
          chatResults.push({ chatId: t.chatId, ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) });
        }
      }

      const deliveredCount = deliveredChatIds.size + sentOk.length;
      // If every target was already recorded as delivered, recover the item
      // state without sending again. This covers a crash after Telegram and
      // the delivery log succeeded but before the item status was updated.
      if (deliveredCount >= targets.length) {
        sentOk.push(...[...deliveredChatIds]);
      }
      // If every target failed with an ambiguous response, stop automatic
      // retries rather than sending a possible duplicate on the next tick.
      // The item is marked failed so the operator can explicitly reset it after
      // checking Telegram.
      if (sentOk.length === 0 && deliveryUnknown) {
        const error = "Telegram delivery outcome unknown; manual confirmation required";
        await rest(`scheduled_items?id=eq.${enc(item.id)}`, {
          method: "PATCH",
          body: { status: "failed", attempts: Math.max(Number(item.attempts ?? 0) + 1, Number(campaign.max_attempts) || 3), error, force_due: false },
          prefer: "return=minimal",
        }).catch(() => {});
        item.status = "failed";
        item.attempts = Math.max(Number(item.attempts ?? 0) + 1, Number(campaign.max_attempts) || 3);
        item.error = error;
        item.force_due = false;
        stats.skipped = Number(stats.skipped) + 1;
        sendsThisCycle += 1;
        continue;
      }

      // Record per-chat delivery history (best-effort).
      for (const r of chatResults) {
        await rest("scheduled_log", {
          method: "POST",
          body: { campaign_id: cid, item_id: item.id, chat_id: r.chatId, ok: r.ok, error: r.error },
          prefer: "return=minimal",
        }).catch(() => {});
      }

      if (deliveredCount >= targets.length) {
        // Advance after every eligible target is either newly delivered or
        // already recorded as delivered for this occurrence. A partial send
        // stays pending so only the missing chats are retried next tick.

        // Recurring campaigns rotate: the single item goes back to pending so
        // the next occurrence sends it again — progress lives in the
        // campaign's last_sent_at / next_send_at (and the delivery history in
        // scheduled_log), not in item status.
        const nextStatus = campaign.kind === "recurring" ? "pending" : "sent";
        const sentAt = new Date().toISOString();
        await rest(`scheduled_items?id=eq.${enc(item.id)}`, {
          method: "PATCH",
          body: nextStatus === "pending"
            ? { status: "pending", attempts: 0, sent_at: sentAt, error: null, force_due: false }
            : { status: "sent", sent_at: sentAt, error: null, force_due: false },
          prefer: "return=minimal",
        }).catch(() => {});
        item.status = nextStatus;
        item.attempts = 0;
        item.sent_at = sentAt;
        item.error = null;
        item.force_due = false;
        stats.sent = Number(stats.sent) + 1;
        (stats.items as string[]).push(`${campaign.name} #${item.position}`);
      } else {
        const attempts = Number(item.attempts ?? 0) + 1;
        if (attempts >= (Number(campaign.max_attempts) || 3)) {
          // Auto-skip after N failures: mark failed, series advances to the
          // next part; recurring/one-time simply stops trying this item.
          const error = chatResults[0]?.error ?? "all target chats failed";
          await rest(`scheduled_items?id=eq.${enc(item.id)}`, {
            method: "PATCH",
            body: { status: "failed", attempts, error, force_due: false },
            prefer: "return=minimal",
          }).catch(() => {});
          item.status = "failed";
          item.attempts = attempts;
          item.error = error;
          item.force_due = false;
          stats.skipped = Number(stats.skipped) + 1;
        } else {
          await rest(`scheduled_items?id=eq.${enc(item.id)}`, {
            method: "PATCH",
            body: { attempts },
            prefer: "return=minimal",
          }).catch(() => {});
          item.attempts = attempts;
          stats.failed = Number(stats.failed) + 1;
        }
      }
      sendsThisCycle += 1;
    }

    // Refresh campaign progress + completion state. `last_sent_at` moves only
    // when something actually sent this cycle — the recurring next-send math
    // reads it, so an unchanged campaign must not drift forward.
    const sentThisCycle = Number(stats.sent) > 0 && sentBefore < Number(stats.sent);
    await refreshCampaign(campaign, items, now, sentThisCycle);
  }

  return stats;
}

// Recompute next_send_at / last_sent_at and flip series → completed when all
// parts are done.
async function refreshCampaign(campaign: CampaignRow, items: ItemRow[], nowMs: number, sentAny: boolean): Promise<void> {
  const cid = String(campaign.id);
  const patch: Record<string, unknown> = {};
  const pending = items.filter((i) => i.status === "pending");
  const startAtMs = campaign.start_at ? Date.parse(campaign.start_at) : NaN;
  const endAtMs = campaign.end_at ? Date.parse(campaign.end_at) : null;
  const timezone = campaign.timezone || "Asia/Baghdad";

  if (campaign.kind === "series") {
    if (sentAny) patch.last_sent_at = new Date(nowMs).toISOString();
    const terminal = seriesTerminalStatus(items);
    if (terminal !== "active") {
      patch.status = terminal;
      patch.next_send_at = null;
    } else {
      const next = pending[0]!;
      const dueMs = seriesPartDueMs(
        next.position - 1,
        startAtMs,
        campaign.schedule ?? {},
        timezone,
        next.scheduled_for ? Date.parse(next.scheduled_for) : null,
        nowMs,
      );
      patch.next_send_at = dueMs !== null ? new Date(dueMs).toISOString() : null;
    }
  } else if (campaign.kind === "recurring") {
    const lastSentMs = sentAny ? nowMs : campaign.last_sent_at ? Date.parse(campaign.last_sent_at) : null;
    if (sentAny) patch.last_sent_at = new Date(nowMs).toISOString();
    const dueMs = recurringNextDueMs(
      lastSentMs,
      startAtMs,
      endAtMs,
      campaign.schedule ?? {},
      timezone,
      nowMs,
    );
    patch.next_send_at = dueMs !== null ? new Date(dueMs).toISOString() : null;
    if (endAtMs !== null && endAtMs < nowMs) patch.status = "expired";
  } else if (campaign.kind === "one_time") {
    if (sentAny) patch.last_sent_at = new Date(nowMs).toISOString();
    patch.next_send_at = campaign.start_at ?? null;
    const allDone = items.every((i) => i.status !== "pending");
    if (allDone) patch.status = "completed";
  }
  if (Object.keys(patch).length > 0) {
    await rest(`scheduled_campaigns?id=eq.${enc(cid)}`, {
      method: "PATCH",
      body: patch,
      prefer: "return=minimal",
    }).catch(() => {});
  }
}

// ── HTTP entry ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
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
  try {
    if (mode === "dryrun") {
      // Read-only preview of what the next cycle would send (for testing).
      const settingsRows = await rest<Array<Record<string, unknown>>>("settings", { query: "limit=1" });
      const campaigns = await rest<CampaignRow[]>("scheduled_campaigns", { query: "select=*&limit=100" }).catch(() => [] as CampaignRow[]);
      const due: string[] = [];
      for (const c of campaigns) {
        if (c.status !== "active") continue;
        const items = await rest<ItemRow[]>("scheduled_items", {
          query: `campaign_id=eq.${enc(String(c.id))}&order=position.asc&limit=500`,
        }).catch(() => [] as ItemRow[]);
        const d = computeDueItems({
          campaign: {
            kind: c.kind,
            start_at: c.start_at,
            end_at: c.end_at,
            timezone: c.timezone,
            schedule: c.schedule ?? {},
          },
          items: items.map((i) => ({ position: i.position, status: i.status as ItemLike["status"], attempts: i.attempts, force_due: i.force_due === true, scheduled_for: i.scheduled_for })),
          nowMs: Date.now(),
          lastSentAtMs: c.last_sent_at ? Date.parse(c.last_sent_at) : null,
        });
        for (const x of d) due.push(`${c.name} #${x.position}`);
      }
      return new Response(JSON.stringify({ ok: true, paused: settingsRows?.[0]?.bot_paused === true, due }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const lockOwner = await acquireLock();
    if (!lockOwner) {
      return new Response(JSON.stringify({ ok: true, skipped: "lock busy" }), { status: 200 });
    }
    try {
      const stats = await runScheduledCycle();
      return new Response(JSON.stringify({ ok: true, ...stats }), { status: 200, headers: { "Content-Type": "application/json" } });
    } finally {
      await releaseLock(lockOwner);
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });
  }
});

// Type import for computeDueItems item shape (kept local to avoid a circular
// runtime dependency on _shared).
type ItemLike = { position: number; status: string; attempts: number; force_due?: boolean; scheduled_for?: string | null };
