// Credential handling for the admin workspace.
//
// SECURITY NOTE: real key values are NOT committed to this repository —
// GitHub push protection blocks them. Provide keys at runtime via
// environment variables (Freebuff API Keys / Convex env vars). The
// placeholders below only serve as a visible reminder of which variable
// each getter expects; functions return `undefined` when a key is missing.
//
// IMPORTANT: this file is only imported from Convex backend code
// (under ./ ), never from the React SPA. Do not import it from any
// file under /src/components, /src/routes, /src/lib that is rendered
// by the browser, or the keys will end up in the JS bundle.

export const FALLBACK_OWNER_EMAILS = [
  "akam09890@gmail.com",
  "Akam09890@gmail.com",
];
export const FALLBACK_PIN = "200006";

// Set these via environment variables (see the getters below).
const TELEGRAM_BOT_TOKEN_FALLBACK =
  "REPLACE_ME_set_TELEGRAM_BOT_TOKEN_env_var";
const NEWSDATA_API_KEY_FALLBACK =
  "REPLACE_ME_set_NEWSDATA_API_KEY_env_var";
const GROQ_API_KEY_FALLBACK =
  "REPLACE_ME_set_GROQ_API_KEY_env_var";
const MINIMAX_API_KEY_FALLBACK =
  "REPLACE_ME_set_MINIMAX_API_KEY_env_var";
const OPENROUTER_API_KEY_FALLBACK =
  "REPLACE_ME_set_OPENROUTER_API_KEY_env_var";
const GATEWAY_KEY_1_FALLBACK = "REPLACE_ME_set_GEMINI_API_KEY_1_env_var";
const GATEWAY_KEY_2_FALLBACK = "REPLACE_ME_set_GEMINI_API_KEY_2_env_var";
const GATEWAY_KEY_3_FALLBACK = "REPLACE_ME_set_GEMINI_API_KEY_3_env_var";

// Full roster of Google Gemini models available across our two providers
// (Vercel AI Gateway free tier + OpenRouter). The translation pipeline will
// try the Vercel gateway first; if the model is free-tier blocked, it
// auto-routes through OpenRouter instead, so every model here actually works.
export const SUPPORTED_GEMINI_MODELS = [
  // Free tier on the Vercel AI Gateway (works via the gateway key)
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.5-flash-image",
  // Paid-only — auto-routed through OpenRouter at fractions of a cent/req
  "google/gemini-2.5-pro",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3.1-flash-image",
  "google/gemini-3.1-flash-image-preview",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.6-flash",
  "google/gemini-omni-flash-preview",
  "google/gemma-4-31b-it",
  // Translation-only backup path
  "minimax/minimax-m3",
] as const;
export const DEFAULT_GEMINI_TRANSLATION_MODEL = "google/gemini-3.1-flash-lite";
export const DEFAULT_TRANSLATION_FALLBACK_MODEL = "minimax/minimax-m3";

// Models the Vercel AI Gateway blocks on the free tier — the translation
// pipeline auto-routes these through OpenRouter at fractions of a cent per
// request.
export const FREE_TIER_BLOCKED_MODELS = new Set([
  "google/gemini-2.5-pro",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3.1-flash-image",
  "google/gemini-3.1-flash-image-preview",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.6-flash",
  "google/gemini-omni-flash-preview",
  "google/gemma-4-31b-it",
]);

// ── Helpers (env var driven) ────────────────────────────────────────────────

function envOr(value: string | undefined, envName: string): string | undefined {
  if (value && !value.startsWith("REPLACE_ME_")) return value;
  const fromEnv = process.env[envName];
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined;
}

export function getTelegramToken(): string | undefined {
  return envOr(TELEGRAM_BOT_TOKEN_FALLBACK, "TELEGRAM_BOT_TOKEN");
}
export function getNewdataKey(): string | undefined {
  return envOr(NEWSDATA_API_KEY_FALLBACK, "NEWSDATA_API_KEY");
}
export function getGroqKey(): string | undefined {
  return envOr(GROQ_API_KEY_FALLBACK, "GROQ_API_KEY");
}
export function getMiniMaxKey(): string | undefined {
  return envOr(MINIMAX_API_KEY_FALLBACK, "MINIMAX_API_KEY");
}
export function getOpenRouterKey(): string | undefined {
  return envOr(OPENROUTER_API_KEY_FALLBACK, "OPENROUTER_API_KEY");
}
export function getGatewayKeys(): string[] {
  return [
    envOr(MINIMAX_API_KEY_FALLBACK, "MINIMAX_API_KEY"),
    envOr(GATEWAY_KEY_1_FALLBACK, "GEMINI_API_KEY_1"),
    envOr(GATEWAY_KEY_2_FALLBACK, "GEMINI_API_KEY_2"),
    envOr(GATEWAY_KEY_3_FALLBACK, "GEMINI_API_KEY_3"),
    process.env["VERCEL_AI_GATEWAY_API_KEY"],
    process.env["AI_GATEWAY_API_KEY"],
    process.env["VERCEL_API_KEY"],
  ].filter((k): k is string => Boolean(k));
}
export function getTranslationModel(): string {
  const raw = (process.env["GEMINI_TRANSLATION_MODEL"] ?? "").trim();
  if (raw.startsWith("google/") || raw.startsWith("gemini-") || raw.startsWith("minimax/")) return raw;
  // Historical default in the original .env: "gemini-2.5-flash".
  if (raw && !raw.includes("/")) return `google/${raw}`;
  return DEFAULT_GEMINI_TRANSLATION_MODEL;
}
export function getOwnerEmails(): string[] {
  const raw = process.env["OWNER_EMAILS"] ?? process.env["OWNER_EMAIL"] ?? "";
  const set = new Set<string>();
  for (const e of raw.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)) {
    set.add(e.toLowerCase());
  }
  for (const e of FALLBACK_OWNER_EMAILS) set.add(e.toLowerCase());
  return Array.from(set);
}
