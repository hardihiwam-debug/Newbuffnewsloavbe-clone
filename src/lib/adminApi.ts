// Type-safe wrapper for the Supabase `admin` Edge Function. The SPA used to
// talk to Convex via `useQuery(api.admin.getDashboard, ...)`; we replaced
// that with `useAdminQuery("admin.getDashboard", ...)` in
// src/lib/supabaseAdminHooks.ts, which dispatches through this module.
//
// Wire shape: POST → /functions/v1/admin with body { action, pin, ...payload }.
// Server returns:
//   200 { ok: true,  data: <action-specific JSON> }
//   400 / 403 / 404 / 500 { error: "..." }

import { adminFunctionUrl } from "./supabase";
import { clearStoredPin } from "./pinStorage";

export type AdminPayload = Record<string, unknown>;

/** Result of a successful admin call. The data shape is action-specific —
 *  narrow it at the call site, e.g.:
 *    const r = await callAdmin<{ ok: true }>("verifyPin", { pin }); */
export type AdminResult<T> = { ok: true; data: T } | { ok: false; error: string };

export class AdminError extends Error {
  constructor(public readonly status: number, msg: string) {
    super(msg);
    this.name = "AdminError";
  }
}

export async function callAdmin<T = unknown>(
  action: string,
  payload: AdminPayload,
  init?: { signal?: AbortSignal; ifState?: Record<string, string> },
): Promise<T> {
  const url = adminFunctionUrl();
  if (!url) {
    throw new AdminError(
      503,
      "Supabase backend not configured — VITE_SUPABASE_URL is missing at build time",
    );
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      ...payload,
      // State-hash conditional polling: the client's last-seen fingerprint
      // for this resource. When it still matches, the server answers with a
      // ~100-byte { __unchanged: true } instead of the full payload.
      ...(init?.ifState ? { ifState: init.ifState } : {}),
    }),
    signal: init?.signal,
  });
  const text = await res.text();
  let parsed: AdminResult<T>;
  try {
    parsed = text ? (JSON.parse(text) as AdminResult<T>) : ({ ok: false, error: "" } as AdminResult<T>);
  } catch {
    throw new AdminError(res.status, text || `HTTP ${res.status}`);
  }
  if (!res.ok || parsed.ok === false) {
    // A rejected/expired session (403 = wrong PIN, 429 = IP locked out) must
    // return the operator to the sign-in form — never leave the app spinning
    // on "Loading console…" with a stale stored PIN. Clear the stored PIN and
    // notify the app (main.tsx navigates to "/").
    if (res.status === 403 || res.status === 429) {
      clearStoredPin();
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("freebuff:auth-rejected", { detail: { status: res.status } }),
        );
      }
    }
    throw new AdminError(res.status, (parsed as { error?: string }).error || `HTTP ${res.status}`);
  }
  return (parsed as { ok: true; data: T }).data;
}

// ── Typed wrappers mirror the Convex `api.admin.*` / `api.admin_actions.*`
//    names so the React layer can swap imports without per-call rewriting.
//    Each function takes `{ pin, ...args }` and returns a Promise. ──────────

export const adminApi = {
  verifyPin: (args: { pin: string }) =>
    callAdmin<{ ok: true }>("verifyPin", args),
  getDashboard: (args: { pin: string }) => callAdmin("getDashboard", args),
  // Focused dashboard resources (egress fast-win): the SPA polls each of
  // these on its own cadence through the shared NewsroomProvider instead of
  // re-fetching the whole getDashboard payload from every mounted component.
  dashboardSummary: (args: { pin: string }, init?: { signal?: AbortSignal; ifState?: Record<string, string> }) =>
    callAdmin("dashboardSummary", args, init),
  dashboardFeed: (args: { pin: string }, init?: { signal?: AbortSignal; ifState?: Record<string, string> }) =>
    callAdmin("dashboardFeed", args, init),
  dashboardQueue: (args: { pin: string }, init?: { signal?: AbortSignal; ifState?: Record<string, string> }) =>
    callAdmin("dashboardQueue", args, init),
  dashboardChats: (args: { pin: string }, init?: { signal?: AbortSignal; ifState?: Record<string, string> }) =>
    callAdmin("dashboardChats", args, init),
  dashboardSources: (args: { pin: string }, init?: { signal?: AbortSignal; ifState?: Record<string, string> }) =>
    callAdmin("dashboardSources", args, init),
  dashboardAnalytics: (args: { pin: string }, init?: { signal?: AbortSignal; ifState?: Record<string, string> }) =>
    callAdmin("dashboardAnalytics", args, init),
  dashboardAi: (args: { pin: string }, init?: { signal?: AbortSignal; ifState?: Record<string, string> }) =>
    callAdmin("dashboardAi", args, init),
  dashboardEvents: (args: { pin: string }, init?: { signal?: AbortSignal; ifState?: Record<string, string> }) =>
    callAdmin("dashboardEvents", args, init),
  dashboardPublished: (args: { pin: string }, init?: { signal?: AbortSignal; ifState?: Record<string, string> }) =>
    callAdmin("dashboardPublished", args, init),
  /** Live manual-run progress (settings.pipeline_run jsonb). */
  getPipelineRun: (args: { pin: string }) => callAdmin<{ pipeline_run: unknown }>("getPipelineRun", args),
  listTranslationKeys: (args: { pin: string }) =>
    callAdmin("listTranslationKeys", args),
  saveSettings: (args: { pin: string; patch: Record<string, unknown> }) =>
    callAdmin<{ ok: true }>("saveSettings", args),
  setPauseState: (args: {
    pin: string;
    paused: boolean;
    reason?: string | null;
  }) => callAdmin<{ ok: true }>("setPauseState", args),
  clearQueue: (args: { pin?: string; limit?: number; includeBreaking?: boolean }) =>
    callAdmin<{ ok: boolean; cleared: boolean; count?: number | null; ingest?: unknown }>("clearQueue", args),
  editQueueItem: (args: {
    pin: string;
    id: string;
    headline?: string;
    summary?: string;
    category?: string;
    breaking?: boolean;
  }) => callAdmin<{ ok: true; id: string }>("editQueueItem", args),
  publishQueueItem: (args: { pin: string; id: string }) =>
    callAdmin<{ ok: boolean; status: number; result: unknown }>("publishQueueItem", args),
  setQueueStatus: (args: {
    pin: string;
    id: string;
    status: "held" | "rejected" | "queued";
  }) => callAdmin<{ ok: true; id: string; status: string }>("setQueueStatus", args),
  deleteQueueItem: (args: { pin: string; id: string }) =>
    callAdmin<{ ok: true; id: string; deleted: boolean }>("deleteQueueItem", args),
  // ── Scheduled Posts / Campaign engine (Settings → Campaigns) ───────────
  listScheduled: (args: { pin: string }) =>
    callAdmin<{
      campaigns: Array<Record<string, any>>;
      items: Array<Record<string, any>>;
      log: Array<Record<string, any>>;
    }>("listScheduled", args),
  saveScheduledCampaign: (args: {
    pin: string;
    _id?: string;
    name?: string;
    kind?: string;
    status?: string;
    timezone?: string;
    startAt?: string | null;
    endAt?: string | null;
    schedule?: Record<string, unknown>;
    targetChatIds?: number[];
    maxAttempts?: number;
    items?: Array<{ title?: string; text: string; imageUrl?: string | null; scheduledFor?: string | null }>;
  }) => callAdmin<{ ok: boolean; id: string; itemsAdded?: number }>("saveScheduledCampaign", args),
  saveScheduledItem: (args: {
    pin: string;
    _id?: string;
    campaignId?: string;
    title?: string | null;
    text?: string;
    imageUrl?: string | null;
    scheduledFor?: string | null;
    position?: number;
  }) => callAdmin<{ ok: boolean; id: string }>("saveScheduledItem", args),
  deleteScheduledCampaign: (args: { pin: string; _id: string }) =>
    callAdmin<{ ok: boolean; deleted: boolean }>("deleteScheduledCampaign", args),
  deleteScheduledItem: (args: { pin: string; _id: string }) =>
    callAdmin<{ ok: boolean; deleted: boolean }>("deleteScheduledItem", args),
  setScheduledCampaignStatus: (args: { pin: string; _id: string; status: string }) =>
    callAdmin<{ ok: boolean; id: string; status: string }>("setScheduledCampaignStatus", args),
  scheduledSkipNext: (args: { pin: string; campaignId: string }) =>
    callAdmin<{ ok: boolean; itemId: string | null }>("scheduledSkipNext", args),
  scheduledSendNext: (args: { pin: string; campaignId: string }) =>
    callAdmin<{ ok: boolean; itemId: string | null }>("scheduledSendNext", args),
  scheduledSendItem: (args: { pin: string; _id: string }) =>
    callAdmin<{ ok: boolean; itemId: string | null }>("scheduledSendItem", args),
  scheduledResetItem: (args: { pin: string; _id: string }) =>
    callAdmin<{ ok: boolean; itemId: string }>("scheduledResetItem", args),
  setTranslationModel: (args: { pin: string; model: string }) =>
    callAdmin<{ ok: true; model: string }>("setTranslationModel", args),
  updateChat: (args: {
    pin: string;
    id: string;
    active?: boolean;
    language?: string | null;
    pollsEnabled?: boolean | null;
    botId?: string | null;
    remove?: boolean;
  }) => callAdmin<{ ok: true }>("updateChat", args),
  saveBot: (args: {
    pin: string;
    id?: string;
    name?: string;
    token?: string | null;
    categories?: string[] | null;
    enabled?: boolean;
  }) => callAdmin<{ ok: true }>("saveBot", args),
  deleteBot: (args: { pin: string; id: string }) =>
    callAdmin<{ ok: true }>("deleteBot", args),
  addChat: (args: {
    pin: string;
    chatId: number;
    title?: string;
    type?: string;
  }) => callAdmin<{ ok: true; chatId: number }>("addChat", args),
  upsertTopic: (args: {
    pin: string;
    id?: string;
    query?: string;
    category?: string;
    enabled?: boolean;
    remove?: boolean;
  }) => callAdmin<{ ok: true }>("upsertTopic", args),
  upsertSource: (args: {
    pin: string;
    id?: string;
    name?: string;
    kind?: string;
    secretRef?: string | null;
    priority?: number;
    enabled?: boolean;
    boost?: number;
    remove?: boolean;
  }) => callAdmin<{ ok: true }>("upsertSource", args),
  upsertTranslationKey: (args: {
    pin: string;
    id?: string;
    provider: string;
    label: string;
    apiKey?: string;
    model: string;
    enabled?: boolean;
    priority?: number;
    remove?: boolean;
  }) => callAdmin<{ ok: true }>("upsertTranslationKey", args),
  listAiControlPlane: (args: { pin: string }) =>
    callAdmin<Record<string, unknown>>("listAiControlPlane", args),
  saveAiProvider: (args: {
    pin: string;
    id?: string;
    slug: string;
    label?: string;
    instanceKey?: string;
    apiKey?: string | null;
    apiKeyEnv?: string | null;
    baseUrl?: string | null;
    model?: string | null;
    enabled?: boolean;
    deleteStoredKey?: boolean;
  }) => callAdmin<{ ok: true }>("saveAiProvider", args),
  deleteAiProvider: (args: { pin: string; id: string }) =>
    callAdmin<{ ok: true; id: string }>("deleteAiProvider", args),
  saveAiActionRoutes: (args: { pin: string; action: string; providerIds?: string[]; routes?: Array<{ providerId: string; enabled?: boolean }> }) =>
    callAdmin<{ ok: true; action: string; providerIds: string[] }>("saveAiActionRoutes", args),
  listAiAttempts: (args: { pin: string; action?: string; limit?: number }) =>
    callAdmin<{ entries: Array<Record<string, unknown>> }>("listAiAttempts", args),
};

export const adminActionsApi = {
  testAiProviderConnection: (args: { pin: string; providerId: string }) =>
    callAdmin<Record<string, unknown>>("testAiProviderConnection", args),
  testAiAction: (args: { pin: string; action: string; providerIds?: string[]; input?: Record<string, unknown> }) =>
    callAdmin<Record<string, unknown>>("testAiAction", args),
  listTranslationModels: (args: { pin: string }) =>
    callAdmin<{ supported: string[]; current: string; models: string[] }>(
      "listTranslationModels",
      args,
    ),
  testTranslationKey: (args: { pin: string; id: string }) =>
    callAdmin<{ ok: boolean; preview?: string; detail?: string }>("testTranslationKey", args),
  testSource: (args: { pin: string; id: string }) =>
    callAdmin<Record<string, unknown>>("testSource", args),
  refreshBotInfo: (args: { pin: string }) =>
    callAdmin<{ ok: boolean; bot?: unknown; error?: string }>("refreshBotInfo", args),
  enableChatWebhooks: (args: { pin: string }) =>
    callAdmin<{ results: Array<{ label: string; ok: boolean; error?: string }>; ok: boolean }>("enableChatWebhooks", args),
  // Points the primary/additional bots' webhooks at this function's
  // /telegram-webhook path (real-time chat discovery). The backend handler
  // returns { ok, url, error }.
  setWebhook: (args: { pin: string; baseUrl: string }) =>
    callAdmin<{ ok: boolean; url?: string; error?: string | null }>("setWebhook", args),
  syncBotChats: (args: { pin: string }) =>
    callAdmin<{ chats: number; scanned: number; error?: string }>("syncBotChats", args),
  sendTestMessage: (args: { pin: string; chatId: number; message?: string }) =>
    callAdmin<{ ok: boolean; message_id?: number | null; error?: string }>(
      "sendTestMessage",
      args,
    ),
  testPoll: (args: {
    pin: string;
    chatId: number;
    question?: string;
    options?: string[];
  }) =>
    callAdmin<{ ok: boolean; poll_id?: number | null; error?: string }>("testPoll", args),
  testGeminiKeys: (args: { pin: string }) =>
    callAdmin<{
      keys: Array<{
        keyIndex: number;
        masked: string;
        models: Array<{
          model: string;
          status: "ok" | "rate_limited" | "auth_error" | "error";
          code: number;
          detail: string;
        }>;
      }>;
      models: string[];
    }>("testGeminiKeys", args),
  // The admin edge function expects `mode` for the inner pipeline stage,
  // NOT `action` (which collides with the outer action enum when the call
  // is serialized). Accept both `mode` (preferred) and the legacy
  // `action` key, then strip `action` to avoid the duplicate-key collision
  // on JSON.stringify.
  runPipeline: (args: { pin: string; action: string }) =>
    callAdmin<{ ok: boolean; status: number; result: unknown }>("runPipeline", {
      pin: args.pin,
      mode: args.action,
    }),
  previewNextBatch: (args: { pin: string; limit?: number }) =>
    callAdmin<{ items: Array<Record<string, unknown>> }>("previewNextBatch", args),
  getRewriteLog: (args: { pin: string }) =>
    callAdmin<{ entries: Array<Record<string, unknown>> }>("getRewriteLog", args),
  resolveSending: (args: { pin: string; id: string; resolve: "sent" | "retry" }) =>
    callAdmin<{ ok: boolean; id: string; resolve: string }>("resolveSending", args),
  getRewriteAnalytics: (args: { pin: string }) =>
    callAdmin<{
      total: number;
      ok: number;
      failed: number;
      successRate: number;
      fallbackRate: number;
      providers: Array<{ name: string; ok: number; fail: number; avgDurationMs: number | null }>;
      trend: Array<{ day: string; ok: number; fail: number }>;
    }>("getRewriteAnalytics", args),
};
