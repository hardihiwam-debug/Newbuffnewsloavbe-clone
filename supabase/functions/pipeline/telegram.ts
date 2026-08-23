// Low-level Telegram Bot API calls (sendMessage / getMe / getUpdates etc.).
// Extracted verbatim from pipeline/index.ts (split refactor) — no behavior change.

import { TELEGRAM_BOT_TOKEN } from "./config.ts";

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

