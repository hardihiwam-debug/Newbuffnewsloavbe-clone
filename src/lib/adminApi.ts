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
  init?: { signal?: AbortSignal },
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
    body: JSON.stringify({ action, ...payload }),
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
  listTranslationKeys: (args: { pin: string }) =>
    callAdmin("listTranslationKeys", args),
  saveSettings: (args: { pin: string; patch: Record<string, unknown> }) =>
    callAdmin<{ ok: true }>("saveSettings", args),
  setPauseState: (args: {
    pin: string;
    paused: boolean;
    reason?: string | null;
  }) => callAdmin<{ ok: true }>("setPauseState", args),
  clearQueue: (args: { pin?: string }) =>
    callAdmin<{ ok: boolean; cleared: boolean; ingest: unknown }>("clearQueue", args),
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
  setTranslationModel: (args: { pin: string; model: string }) =>
    callAdmin<{ ok: true; model: string }>("setTranslationModel", args),
  updateChat: (args: {
    pin: string;
    id: string;
    active?: boolean;
    language?: string | null;
    pollsEnabled?: boolean | null;
    remove?: boolean;
  }) => callAdmin<{ ok: true }>("updateChat", args),
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
};

export const adminActionsApi = {
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
  setWebhook: (args: { pin: string; baseUrl: string }) =>
    callAdmin<{ ok: boolean; url: string; error?: string }>("setWebhook", args),
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
};
