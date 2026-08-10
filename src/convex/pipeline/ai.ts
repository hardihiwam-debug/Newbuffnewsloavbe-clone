"use node";
import { CATEGORIES, type Category } from "./types";
import {
  DEFAULT_GEMINI_TRANSLATION_MODEL,
  DEFAULT_TRANSLATION_FALLBACK_MODEL,
  FREE_TIER_BLOCKED_MODELS,
  getGatewayKeys,
  getGroqKey,
  getMiniMaxKey,
  getOpenRouterKey,
  getTranslationModel,
  SUPPORTED_GEMINI_MODELS,
} from "../secrets";

const GATEWAY = "https://ai-gateway.vercel.sh/v1/chat/completions";

// Round-robin pick across all configured gateway keys.
let keyCursor = 0;
function pickKey(): string {
  const keys = getGatewayKeys();
  if (keys.length === 0) throw new Error(
    "No Gemini / Vercel AI Gateway key configured. Set GEMINI_API_KEY_1/2/3 in API keys or the secrets fallback is missing.",
  );
  const key = keys[keyCursor % keys.length]!;
  keyCursor += 1;
  return key;
}

async function gatewayChatWithKey(
  key: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  opts?: { max_tokens?: number; temperature?: number; reasoning_effort?: "none" | "low" | "medium" | "high" },
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts?.temperature ?? 0,
    max_tokens: opts?.max_tokens ?? 320,
  };
  if (model.startsWith("openai/") && opts?.reasoning_effort) {
    body["reasoning_effort"] = opts.reasoning_effort;
  }
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("AI rate limit reached (429)");
    if (res.status === 402) throw new Error("AI credits exhausted (402)");
    throw new Error(`AI gateway ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

async function chat(
  model: string,
  messages: Array<{ role: string; content: string }>,
  opts?: { max_tokens?: number; temperature?: number; reasoning_effort?: "none" | "low" | "medium" | "high" },
): Promise<string> {
  let lastError: string | null = null;
  const keys = getGatewayKeys();
  // Try each key once per call so rate limits on one key don't block everything.
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[(keyCursor + i) % keys.length]!;
    try {
      const out = await gatewayChatWithKey(key, model, messages, opts);
      keyCursor = (keyCursor + i + 1) % keys.length;
      return out;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastError ?? "AI gateway unreachable");
}

// MiniMax via its own key — the key passed here is a real Vercel AI Gateway
// key, so this bypasses the broken AQ.* rotation entirely.
async function minimaxChat(
  messages: Array<{ role: string; content: string }>,
  opts?: { max_tokens?: number; temperature?: number },
): Promise<string> {
  const key = getMiniMaxKey();
  if (!key) throw new Error("Missing MINIMAX_API_KEY");
  return await gatewayChatWithKey(key, "minimax/minimax-m3", messages, opts);
}

// OpenRouter — used for classification/rewrite/polls (default llama) AND
// for paid-only Gemini models (3, 3.1, 3.5, 3.6, pro). Accepts an optional
// model override; if absent it uses meta-llama/llama-3.3-70b-instruct.
async function openrouterChat(
  messages: Array<{ role: string; content: string }>,
  opts?: { max_tokens?: number; temperature?: number; jsonMode?: boolean },
  model = "meta-llama/llama-3.3-70b-instruct",
): Promise<string> {
  const key = getOpenRouterKey();
  if (!key) throw new Error("Missing OPENROUTER_API_KEY");
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts?.temperature ?? 0,
    max_tokens: opts?.max_tokens ?? 320,
  };
  if (opts?.jsonMode) body["response_format"] = { type: "json_object" };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${raw.slice(0, 240)}`);
  const json = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

// Smart Google router: for free-tier Gemini models (2.5-flash, flash-lite,
// flash-image) it tries the Vercel AI Gateway first (cheaper). For paid-only
// models (Gemini Pro, Gemini 3+, 3.1, 3.5, 3.6) it goes straight through
// OpenRouter. If the gateway returns a free-tier block it also falls back
// to OpenRouter.
async function googleRoute(
  model: string,
  messages: Array<{ role: string; content: string }>,
  opts?: { max_tokens?: number; temperature?: number },
): Promise<string> {
  const blocked = FREE_TIER_BLOCKED_MODELS.has(model);
  const errors: string[] = [];
  // Build attempt order: if blocked, try OpenRouter first; otherwise gateway first.
  const order: Array<{ name: string; run: () => Promise<string> }> = [];
  if (blocked) {
    order.push({ name: `openrouter:${model}`, run: () => openrouterChat(messages, opts, model) });
    order.push({ name: `gateway:${model}`, run: () => chat(model, messages, opts) });
  } else {
    order.push({ name: `gateway:${model}`, run: () => chat(model, messages, opts) });
    order.push({ name: `openrouter:${model}`, run: () => openrouterChat(messages, opts, model) });
  }
  for (const a of order) {
    try {
      return await a.run();
    } catch (err) {
      errors.push(`${a.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`All providers failed for ${model}: ${errors.join(" | ")}`);
}

async function groqChat(
  messages: Array<{ role: string; content: string }>,
  opts?: { max_tokens?: number; temperature?: number; jsonMode?: boolean },
): Promise<string> {
  const key = getGroqKey();
  if (!key) throw new Error("Missing GROQ_API_KEY");
  const body: Record<string, unknown> = {
    model: "llama-3.3-70b-versatile",
    messages,
    temperature: opts?.temperature ?? 0,
    max_tokens: opts?.max_tokens ?? 320,
  };
  if (opts?.jsonMode) body["response_format"] = { type: "json_object" };
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Groq ${res.status}: ${raw.slice(0, 240)}`);
  const json = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

export async function translateTelegramToEnglish(texts: string[]): Promise<string[]> {
  if (texts.length === 0) return [];
  const messages = [
    {
      role: "system",
      content:
        "Translate Arabic or Persian breaking-news posts into concise professional English. Preserve names, numbers, attribution and factual uncertainty. Remove only labels such as عاجل. Return ONLY a JSON array of strings in the same order. Never summarize away facts.",
    },
    { role: "user", content: JSON.stringify(texts) },
  ];
  let raw: string;
  try {
    raw = await groqChat(messages, { jsonMode: true, max_tokens: 2000 });
  } catch {
    raw = await openrouterChat(messages, { jsonMode: true, max_tokens: 2000 });
  }
  const parsed = extractJson(raw);
  if (!Array.isArray(parsed) || parsed.length !== texts.length) {
    throw new Error("Telegram translation shape mismatch");
  }
  return parsed.map((value) => String(value).trim());
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.search(/[[{]/);
  if (start === -1) throw new Error("No JSON in model output");
  // Find the true end of the JSON value: walk from the last occurrence and
  // validate it parses; if the tail contains trailing prose, trim it off.
  let end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
  while (end > start) {
    const candidate = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // The last } / ] may be inside trailing prose — step back to the next one.
      const before = cleaned.slice(start, end);
      end = Math.max(before.lastIndexOf("]"), before.lastIndexOf("}"));
    }
  }
  throw new Error("No parseable JSON in model output");
}

const CATEGORY_GUIDE = `
- iraq: major Iraqi security, politics, diplomacy, energy, economy, Kurdistan Region, or regional developments with a direct impact on Iraq.
- middle-east: major regional developments in Israel/Palestine, Lebanon, Syria, Yemen, Saudi Arabia, the Gulf or Turkey that matter to a Middle Eastern audience.
- analysis: substantive geopolitical or military analysis about Iran, Iraq, the Iran-US confrontation, or the wider Middle East.
- war: military strikes, attacks, casualties, mobilisation, or direct armed confrontation involving Iran, the US, Israel or their allies.
- iran: Iranian politics, leadership statements, nuclear programme, sanctions, internal affairs, Iran's regional diplomacy.
- proxies: Hezbollah, the Houthis, Iraqi militias, other Iran-aligned armed groups, and Israel-related conflict news.
- usa: US government or Trump administration action, statements or policy toward Iran and the region.
- oil: crude oil prices, supply, shipping, the Strait of Hormuz, OPEC.
- gold: gold and precious-metal prices and safe-haven flows.
- economic-impact: other market, currency, trade or inflation effects of the conflict.
Return "none" for minor local stories, video games, sports, entertainment, generic finance, foreign domestic politics without regional impact, and India-only gold retail prices.`;

export async function classifyBatch(
  items: Array<{ title: string; description: string | null }>,
): Promise<Array<Category | null>> {
  if (items.length === 0) return [];
  const numbered = items
    .map((it, i) => `${i + 1}. ${it.title}\n   ${(it.description ?? "").slice(0, 300)}`)
    .join("\n");

  const messages = [
    {
      role: "system",
      content: `You classify English-language news for an Iraqi audience covering Iraq first, Iran and Iranian perspectives, the Iran-US conflict, and major Middle East events. Categories:${CATEGORY_GUIDE}\nJudge meaning, not keywords: a "God of War" game article is "none", not war.\nReply with ONLY a JSON array of strings, one per numbered item, in order.`,
    },
    { role: "user", content: numbered },
  ];
  let raw: string;
  try {
    raw = getGroqKey() ? await groqChat(messages, { jsonMode: true }) : await openrouterChat(messages, { jsonMode: true });
  } catch {
    try {
      // Fallback chain if first choice fails: groq → openrouter → gemini-flash
      raw = await openrouterChat(messages, { jsonMode: true });
    } catch {
      raw = await chat("google/gemini-2.5-flash", messages, { max_tokens: 400 });
    }
  }

  let parsed: unknown[];
  try {
    const json = extractJson(raw);
    if (!Array.isArray(json)) throw new Error("classification not an array");
    parsed = json;
  } catch {
    const labels = raw.toLowerCase().match(/\b(?:middle-east|economic-impact|iraq|analysis|war|iran|proxies|usa|oil|gold|none)\b/g) ?? [];
    if (labels.length < items.length) throw new Error("classification output could not be recovered");
    parsed = labels.slice(-items.length);
  }
  return items.map((_, i) => {
    const value = String(parsed[i] ?? "none").trim().toLowerCase();
    return (CATEGORIES as string[]).includes(value) ? (value as Category) : null;
  });
}

export interface Rewritten {
  headline: string;
  summary: string;
}

export async function rewrite(item: {
  title: string;
  description: string | null;
  sourceName: string | null;
}): Promise<Rewritten> {
  const raw = await runRewrite([item]);
  return raw[0] ?? {
    headline: item.title,
    summary: (item.description ?? "").trim(),
  };
}

export async function rewriteBatch(items: Array<{
  title: string;
  description: string | null;
  sourceName: string | null;
}>): Promise<Rewritten[]> {
  if (items.length === 0) return [];
  return await runRewrite(items);
}

async function runRewrite(items: Array<{
  title: string;
  description: string | null;
  sourceName: string | null;
}>): Promise<Rewritten[]> {
  const messages = [
    {
      role: "system",
      content: `You are a wire editor for an Iraqi, Muslim, pro-Iran regional news channel. Return ONLY a JSON array with one {"headline": string, "summary": string} object per input, in order.
Headline: factual, under 110 characters, no clickbait or feed labels.
Summary: 2-3 complete standalone sentences, ending normally; include who did what, where, and why it matters. Never end with an ellipsis or an unfinished clause. Attribute disputed claims. Do not add facts. Do not adopt hostile or demoralising framing about Iran. Professional English only.`,
    },
    {
      role: "user",
      content: JSON.stringify(items.map((item) => ({
        ...item,
        description: item.description?.slice(0, 1200) ?? null,
      }))),
    },
  ];
  // Prefer Groq for speed, then OpenRouter (verified working), then Gemini.
  // max_tokens is high (4000): a 10-item batch of headline+summary objects
  // easily exceeds 700 tokens, and truncated JSON fails the shape check.
  let raw: string;
  try {
    raw = getGroqKey() ? await groqChat(messages, { jsonMode: true, max_tokens: 4000 }) : await openrouterChat(messages, { jsonMode: true, max_tokens: 4000 });
  } catch {
    try {
      raw = await openrouterChat(messages, { jsonMode: true, max_tokens: 4000 });
    } catch {
      raw = await chat("google/gemini-2.5-flash", messages, { max_tokens: 4000 });
    }
  }
  const parsed = extractJson(raw);
  if (!Array.isArray(parsed) || parsed.length !== items.length) {
    throw new Error(
      `rewrite batch shape mismatch (expected ${items.length} items, got ${Array.isArray(parsed) ? parsed.length : "non-array"})`,
    );
  }
  return parsed.map((value, index) => {
    const row = value as { headline?: string; summary?: string };
    const fallback = items[index];
    let summary = String(row.summary ?? fallback?.description ?? "").trim();
    if (/(\.\.\.|…)$/.test(summary)) {
      const withoutEllipsis = summary.replace(/(\.\.\.|…)$/, "").trim();
      const lastCompleteSentence = withoutEllipsis.match(/^([\s\S]*[.!?])\s+[^.!?]*$/)?.[1];
      summary = (lastCompleteSentence ?? withoutEllipsis).trim();
    }
    if (!/[.!?]$/.test(summary) && summary.length > 0) summary += ".";
    return {
      headline: String(row.headline ?? fallback?.title ?? "").trim(),
      summary,
    };
  });
}

export function isBreaking(
  category: Category,
  title: string,
  breakingCategories: string[],
): boolean {
  if (breakingCategories.includes(category)) {
    const hardSignals =
      /\b(strike|strikes|attack|attacked|missile|drone|killed|assassinat|retaliat|launch(ed)?|invasion|war|ceasefire|ultimatum|sanction(s|ed)?|statement|address|speech|warns?)\b/i;
    return hardSignals.test(title);
  }
  return false;
}

export type TranslationProvider = "gemini" | "minimax";

export interface TranslationKey {
  id: string;
  provider: TranslationProvider;
  label: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  priority: number;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  lastStatus: number | null;
  lastError: string | null;
  lastUsedAt: string | null;
}

export function isKeyAvailable(key: TranslationKey): boolean {
  return !key.cooldownUntil || Date.parse(key.cooldownUntil) <= Date.now();
}

// Translate any Google Gemini model to Kurdish Sorani. Uses googleRoute()
// which tries the Vercel AI Gateway first (free-tier models) and auto-falls
// back to OpenRouter for paid-only models (Gemini 3+, Pro).
export async function geminiTranslate(key: TranslationKey, text: string): Promise<string> {
  const messages = [
    {
      role: "system",
      content:
        "Translate into Kurdish Sorani using Arabic script. Preserve names, numbers, URLs, acronyms and attribution. Output only the translation, with no preface, explanation or markdown.",
    },
    { role: "user", content: text.slice(0, 1500) },
  ];
  const model = key.model || getTranslationModel();
  if (model.startsWith("google/")) {
    return await googleRoute(model, messages, { max_tokens: 600, temperature: 0 });
  }
  return await chat(model, messages, { max_tokens: 600, temperature: 0 });
}

export async function minimaxTranslate(key: TranslationKey, text: string): Promise<string> {
  // If the DB row carries its own gateway key, use it; otherwise fall back to
  // the hardcoded MiniMax key (which is a real Vercel AI Gateway key).
  const ownKey = (key.apiKey ?? "").trim();
  const messages = [
    {
      role: "system",
      content:
        "Translate into Kurdish Sorani using Arabic script. Preserve names, numbers, URLs, acronyms and attribution. Output only the translation, with no preface, explanation or markdown.",
    },
    { role: "user", content: text.slice(0, 1500) },
  ];
  if (ownKey) {
    return await gatewayChatWithKey(ownKey, key.model || "minimax/minimax-m3", messages, {
      max_tokens: 600,
      temperature: 0,
    });
  }
  return await minimaxChat(messages, { max_tokens: 600, temperature: 0 });
}

const SORANI_ALLOWED =
  /^[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF0-9\s\p{P}\p{S}\p{Extended_Pictographic}A-Za-z.-]*$/u;

export function validateSorani(text: string): boolean {
  if (!text.trim()) return false;
  const latinLetters = (text.match(/[A-Za-z]/g) ?? []).length;
  const arabicLetters = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) ?? []).length;
  if (arabicLetters < 2) return false;
  if (latinLetters > Math.max(24, arabicLetters * 0.35)) return false;
  return SORANI_ALLOWED.test(text);
}

export interface TranslationResult {
  text: string | null;
  modelsTried: string[];
  detail?: string;
}

export async function translateToSoraniWithKeys(
  text: string,
  keys: TranslationKey[],
  mode: "gemini_first" | "minimax_first" | "both",
  preferredModel?: string,
): Promise<TranslationResult> {
  // GROQ FIRST: always try Groq before anything else, because the Vercel
  // AI Gateway keys may be invalid and DB-stored keys may not exist.
  try {
    const groqOut = await groqChat(
      [
        { role: "system", content: "Translate into Kurdish Sorani using Arabic script. Preserve names, numbers, URLs, acronyms and attribution. Output only the translation, with no preface, explanation or markdown." },
        { role: "user", content: text.slice(0, 1500) },
      ],
      { max_tokens: 600 },
    );
    if (validateSorani(groqOut)) {
      return { text: groqOut, modelsTried: ["groq:llama-3.3-70b"] };
    }
  } catch { /* Groq unavailable — continue to gateway / DB keys */ }

  const gemini = keys.filter((k) => k.provider === "gemini");
  const minimax = keys.filter((k) => k.provider === "minimax");

  let ordered: TranslationKey[];
  if (mode === "minimax_first") ordered = [...minimax, ...gemini];
  else if (mode === "both") ordered = [...gemini, ...minimax];
  else ordered = [...gemini, ...minimax];

  // Override the model on incoming gemini keys if the user picked one in the dashboard.
  if (preferredModel) {
    ordered = ordered.map((k) =>
      k.provider === "gemini" ? { ...k, model: preferredModel } : k,
    );
  }

  const tried: string[] = [];
  let detail = "";
  for (const key of ordered) {
    tried.push(`${key.provider}:${key.model}`);
    try {
      const out = key.provider === "gemini"
        ? await geminiTranslate(key, text)
        : await minimaxTranslate(key, text);
      if (validateSorani(out)) return { text: out, modelsTried: tried };
      detail = `${key.provider} returned output that failed Sorani validation`;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
  }

  // HARDCODED FALLBACK — when no DB keys exist.
  // Order: Google Gemini via the Vercel AI Gateway (the admin's vck_* key is
  // a global gateway key that routes ALL providers, including Google models),
  // then MiniMax M3 as backup, then Groq as last resort.
  if (tried.length === 0) {
    const translatePrompt = (role: string) => [
      { role, content: "Translate into Kurdish Sorani using Arabic script. Preserve names, numbers, URLs, acronyms and attribution. Output only the translation, with no preface, explanation or markdown." },
      { role: "user", content: text.slice(0, 1500) },
    ];

    // 1) Google Gemini via smart router (Vercel AI Gateway first, OpenRouter
    //    fallback for paid-only models). The vck_* key works for free-tier
    //    Gemini (2.5-flash, flash-lite). Pro / 3+ / 3.5 / 3.6 auto-route
    //    through OpenRouter at fractions of a cent per request.
    try {
      const gModel = preferredModel || getTranslationModel();
      if (gModel.startsWith("google/")) {
        const geminiOut = await googleRoute(gModel, translatePrompt("system"), {
          max_tokens: 600,
          temperature: 0,
        });
        if (validateSorani(geminiOut)) {
          return { text: geminiOut, modelsTried: [`hardcoded:${gModel}`] };
        }
        detail = `Gemini returned output that failed Sorani validation`;
      } else if (gModel.startsWith("minimax/")) {
        // Admin picked MiniMax explicitly — use the dedicated key.
        const mmOut = await minimaxChat(translatePrompt("system"), {
          max_tokens: 600,
          temperature: 0,
        });
        if (validateSorani(mmOut)) {
          return { text: mmOut, modelsTried: [`hardcoded:${gModel}`] };
        }
        detail = "MiniMax returned output that failed Sorani validation";
      } else {
        // Unknown model — try the generic gateway path.
        const gwOut = await chat(gModel, translatePrompt("system"), {
          max_tokens: 600,
        });
        if (validateSorani(gwOut)) {
          return { text: gwOut, modelsTried: [`hardcoded:${gModel}`] };
        }
        detail = `Gateway returned output that failed Sorani validation`;
      }
    } catch (err) {
      detail = `Hardcoded ${preferredModel || getTranslationModel()}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }

    // 2) MiniMax M3 — separate key, verified working: returns clean Sorani.
    try {
      const mmOut = await minimaxChat(translatePrompt("system"), {
        max_tokens: 600,
        temperature: 0,
      });
      if (validateSorani(mmOut)) {
        return { text: mmOut, modelsTried: ["hardcoded:minimax/minimax-m3"] };
      }
      detail = "MiniMax returned output that failed Sorani validation";
    } catch (err) {
      detail = `MiniMax hardcoded: ${err instanceof Error ? err.message : String(err)}`;
    }

    // 3) Groq llama-3.3 — fast, cheap (datacenter IP may 403).
    try {
      const groqOut = await groqChat(translatePrompt("system"), {
        max_tokens: 600,
      });
      if (validateSorani(groqOut)) {
        return { text: groqOut, modelsTried: ["hardcoded:groq-llama"] };
      }
      detail = "Groq returned output that failed Sorani validation";
    } catch (err) {
      detail = `Groq hardcoded: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return { text: null, modelsTried: tried, detail: detail || "No translation provider is configured or available" };
}

// Helper exposed for the admin UI to show the available models
export function listSupportedGeminiModels(): string[] {
  return Array.from(SUPPORTED_GEMINI_MODELS);
}

export function getDefaultGeminiTranslationModel(): string {
  return getTranslationModel() || DEFAULT_GEMINI_TRANSLATION_MODEL;
}

// ── Poll generation ────────────────────────────────────────────────────────────────────

export interface GeneratedPoll {
  question: string;
  options: string[]; // 2..10 mutually-exclusive options
}

interface PollSkeleton {
  question: string | null;
  options: string[] | null;
  skip_reason?: string | null;
}

// Decide which language the poll should be in. In practice:
// • If the chat language is Kurdish, use Sorani
// • If English, use English
// • If the per-poll language setting is "chat", follow the chat language
// • If defaultLanguage is "both", lean Kurdish (per admin preference)
// Otherwise fall back to settings defaultLanguage.
export function pickPollLanguage(chatLang: string | undefined | null, settingsDefault: string, pollDefault: string): "ckb" | "en" {
  const target = pollDefault || "chat";
  if (target === "ckb") return "ckb";
  if (target === "en") return "en";
  // "chat" – follow the chat, fall back to settings default if both→ckb
  const chat = (chatLang ?? settingsDefault ?? "").toLowerCase();
  if (chat === "ckb") return "ckb";
  if (chat === "en") return "en";
  // settingsDefault "both" → prefer Kurdish Sorani for polls
  return "ckb";
}

export async function generatePoll(
  item: { headline: string; summary: string; category: string },
  language: "ckb" | "en",
): Promise<GeneratedPoll | null> {
  const sys =
    language === "ckb"
      ? "You generate Telegram polls in Kurdish Sorani (Arabic script) for an Iraq/Kurdistan audience that follows Iran-US-conflict news. Given one breaking-news headline + 2-3 sentence summary, produce ONE multiple-choice question with 2-4 mutually-exclusive, plausible, balanced, non-overlapping options that probe how the audience expects the situation to unfold (response, escalation, casualties, markets, etc.). Options ≤80 chars each, neutral in tone, no editorials. If no natural predictive question exists (e.g. compassion-only humanitarian deaths, sports-style score updates), return {question: null, options: null, skip_reason: \"no clear predictive question\"}. Return ONLY a strict JSON object matching the schema."
      : "You generate Telegram polls in English for an Iraq/Kurdistan audience that follows Iran-US-conflict news. Given one breaking-news headline + 2-3 sentence summary, produce ONE multiple-choice question with 2-4 mutually-exclusive, plausible, balanced, non-overlapping options that probe how the audience expects the situation to unfold (response, escalation, casualties, markets, etc.). Options ≤80 chars each, neutral in tone, no editorials. If no natural predictive question exists (e.g. compassion-only humanitarian deaths, sports-style score updates), return {question: null, options: null, skip_reason: \"no clear predictive question\"}. Return ONLY a strict JSON object matching the schema.";

  const user = JSON.stringify({
    headline: item.headline,
    summary: item.summary.slice(0, 800),
    category: item.category,
  });

  // Try Groq first (JSON mode + cheap and fast for short structured tasks),
  // then OpenRouter (verified working), then the gateway as last resort.
  let raw: string;
  try {
    raw = getGroqKey()
      ? await groqChat(
          [{ role: "system", content: sys }, { role: "user", content: user }],
          { jsonMode: true, max_tokens: 250 },
        )
      : await openrouterChat(
          [{ role: "system", content: sys }, { role: "user", content: user }],
          { jsonMode: true, max_tokens: 250 },
        );
  } catch {
    try {
      raw = await openrouterChat(
        [{ role: "system", content: sys }, { role: "user", content: user }],
        { jsonMode: true, max_tokens: 250 },
      );
    } catch {
      try {
        raw = await chat("google/gemini-2.5-flash-lite",
          [{ role: "system", content: sys }, { role: "user", content: user }],
          { max_tokens: 250 });
      } catch {
        return null;
      }
    }
  }

  let parsed: PollSkeleton;
  try {
    parsed = extractJson(raw) as PollSkeleton;
  } catch {
    return null;
  }
  if (!parsed.question || !Array.isArray(parsed.options) || parsed.options.length < 2) {
    return null;
  }
  const question = String(parsed.question).slice(0, 255).trim();
  const options = parsed.options
    .map((o) => String(o).slice(0, 100).trim())
    .filter(Boolean)
    .slice(0, 10);
  if (options.length < 2 || question.length < 3) return null;
  return { question, options };
}

// Re-export pickKey under a more descriptive name for callers.
export { pickKey as getGatewayKey };
