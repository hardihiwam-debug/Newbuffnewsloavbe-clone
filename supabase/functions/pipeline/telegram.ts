// Low-level Telegram Bot API calls (sendMessage / getMe / getUpdates etc.).
// Extracted verbatim from pipeline/index.ts (split refactor) — no behavior change.

import { TELEGRAM_BOT_TOKEN } from "./config.ts";

// ── Delivery-outcome classification ────────────────────────────────────────
// Shared by the news pipeline (publish.ts) and the campaign engine
// (scheduled/index.ts) so the two send paths can never drift apart.

// A send attempt that failed in a way where we cannot know whether Telegram
// accepted the message (timeout, 5xx). Callers must KEEP the durable
// 'sending' reservation so a retry can never double-deliver.
export class DeliveryUnknownError extends Error {
  constructor(cause: unknown) {
    super(`Telegram delivery outcome is unknown: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DeliveryUnknownError";
  }
}

export function isDefinitiveTelegramFailure(err: unknown): boolean {
  // Telegram rejects malformed content/media before delivery with a 4xx, and
  // a 429/420 rate-limit response means the request was refused BEFORE any
  // delivery — the message was definitely not sent. Only a timeout or 5xx is
  // ambiguous (the API may have accepted the message even when this function
  // did not receive confirmation).
  //
  // Treating 429 as definitive matters: a burst (instant fast lane, manual
  // force-publish) that trips the per-chat rate limit would otherwise leave a
  // permanent 'sending' reservation — invisible to the dedup snapshot, skipped
  // on retry, and wedged until an operator reconciles it. With 429 classified
  // as a definitive failure the reservation is dropped and the still-queued
  // item simply retries on the next cycle (Telegram's own backoff).
  return /Telegram .* \[(400|401|403|404|413|420|429)\]/i.test(err instanceof Error ? err.message : String(err));
}

export function isRateLimitFailure(err: unknown): boolean {
  // 420/429 flood-control responses. When a chat is rate-limited, alternate
  // media strategies (cached URL, byte upload, text fallback) hit the SAME
  // chat and would each be refused — and Telegram escalates the penalty for
  // repeated attempts while limited. Bail out of the fallback cascade and
  // let the caller drop the reservation; the next cycle (5 min later) retries.
  return /\[(420|429)\]/i.test(err instanceof Error ? err.message : String(err));
}

// ── Telegram send ───────────────────────────────────────────────────────────


export async function telegramCall(method: string, payload: Record<string, unknown>, token = TELEGRAM_BOT_TOKEN): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  const json = JSON.parse(body) as { ok?: boolean; result?: unknown; description?: string };
  if (!res.ok || !json.ok) throw new Error(`Telegram ${method} [${res.status}]: ${json.description ?? body.slice(0, 200)}`);
  return json.result as Record<string, unknown>;
}

