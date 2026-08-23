// AI layer: fact extraction, Gemini/Minimax translation, usage accounting
// and the final-dedup provider chain.
// Extracted verbatim from pipeline/index.ts (split refactor) — no behavior change.

import { ALLOWED_CATEGORIES, GEMINI_DIRECT_MODELS, MINIMAX_MODEL, buildGlossaryBlock, classifyModel, cleanGeminiTranslation, extractFirstJsonObject, isHardProviderFailure, lengthPromptRule, normalizeAiCategory, rewriteAttemptTimeoutMs, stylePromptParts, validateSorani } from "./_shared.ts";
import { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, GROQ_API_KEY, MINIMAX_API_KEY, MISTRAL_API_KEY, OPENROUTER_API_KEY, geminiKeys } from "./config.ts";
import { enc, logActivity, rest } from "./db.ts";

// ── Two-stage rewrite: EXTRACT facts → COMPOSE brief ────────────────────────
// Replaces the single mega-prompt (~40 rules doing extraction + headline +
// summary at once) with two small calls:
//   Stage A EXTRACT — list ONLY the facts the source states (tiny prompt,
//     models follow it reliably; hallucination has nothing to feed on).
//   Stage B COMPOSE — write headline + summary USING ONLY the extracted
//     facts JSON; an invented detail has no source to come from.
// Each stage walks the same provider chain independently, so a provider that
// dies mid-extract can still be retried on compose, and each stage is
// bounded by its own slice of the chunk deadline.
export type ExtractedFacts = {
  headline: string;
  summary: string;
  facts: Record<string, unknown>;
};

export type RewriteItem = {
  title: string;
  description: string | null;
  /** Breaking/high-score items are rewritten alone (one item per LLM call) so
   *  the model's full attention is on the story that matters most. */
  solo?: boolean;
  style?: string;
  length?: string;
  styleRule?: string;
  styleExample?: string;
  aiStyleAssist?: boolean;
};

// Chunking for the batch rewrite. Two limits per chunk: item count (a single
// response must never overflow max_tokens) AND total source characters — with
// full article bodies (up to ~12k chars each) five items could be 60k chars of
// input, which slows free-tier providers toward their timeouts and dilutes
// attention. Chunks stay ≤ MAX_ITEMS items and ≤ MAX_SOURCE_CHARS chars.
export const REWRITE_CHUNK_MAX_ITEMS = 5;
export const REWRITE_CHUNK_MAX_CHARS = 16_000;
export function chunkRewriteItems(items: RewriteItem[]): RewriteItem[][] {
  const chunks: RewriteItem[][] = [];
  let cur: RewriteItem[] = [];
  let curChars = 0;
  const itemChars = (it: RewriteItem) => it.title.length + (it.description?.length ?? 0);
  for (const it of items) {
    const c = itemChars(it);
    // A solo item (breaking story) always lands in a chunk of one — per-item
    // attention is worth one extra call exactly where quality matters most.
    if (it.solo && cur.length > 0) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    if (cur.length > 0 && (cur.length >= REWRITE_CHUNK_MAX_ITEMS || curChars + c > REWRITE_CHUNK_MAX_CHARS)) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(it);
    curChars += c;
    if (it.solo) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

// Structured rewrite log (Settings → AI & Translation → Rewrite log). One row
// per rewrite attempt (chunk), success or failure, with provider/model and
// headline previews so the operator can see what the rewrite step is doing.
// Best-effort: logging must never break ingest.
export async function logRewrite(entry: {
  ok: boolean;
  provider?: string | null;
  model?: string | null;
  itemCount: number;
  headlines?: string[];
  error?: string | null;
  durationMs?: number | null;
}): Promise<void> {
  try {
    await rest("rewrite_log", {
      method: "POST",
      body: {
        ok: entry.ok,
        provider: entry.provider ?? null,
        model: entry.model ?? null,
        item_count: entry.itemCount,
        headlines: (entry.headlines ?? []).slice(0, 5).map((h) => h.slice(0, 140)),
        error: entry.error?.slice(0, 500) ?? null,
        duration_ms: entry.durationMs ?? null,
      },
      prefer: "return=minimal",
    });
  } catch {
    /* best-effort only */
  }
}

// Per-cycle rewrite-provider health: providers that hard-fail (429 quota,
// 401/403, 402 no-credits, 5xx) are marked dead so later chunks in the same
// cycle skip them instead of re-burning the rewrite deadline. Reset once per
// cycle by the ingest phase (resetRewriteProviderHealth) so next cycle starts
// fresh.
let deadRewriteProviders = new Set<string>();

export function resetRewriteProviderHealth(): void {
  deadRewriteProviders = new Set<string>();
}

// Rewrite chunk result: the per-item extractions plus which provider/model
// actually produced them (threaded onto queue rows so Story Review can show
// "original → rewritten, by which model"; null when the rewrite failed).
export type RewriteChunkResult = {
  items: Array<ExtractedFacts | null>;
  provider: string | null;
  model: string | null;
};

type ProviderSpec = { name: string; url: string; key: string; model: string };
type RoutedProvider = {
  id: string;
  slug: string;
  kind: string;
  key: string;
  baseUrl: string;
  model: string;
};

let controlRoutes = new Map<string, RoutedProvider[]>();
let controlRoutesLoadedAt = 0;
let controlRoutesPromise: Promise<void> | null = null;

function providerEnvKey(slug: string): string {
  const keys: Record<string, string> = {
    groq: "GROQ_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    cloudflare: "CLOUDFLARE_API_TOKEN",
    mistral: "MISTRAL_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    openai: "OPENAI_API_KEY",
    minimax: "MINIMAX_API_KEY",
    gemini: "GEMINI_API_KEY_1",
  };
  return keys[slug] ?? "";
}

function routedCompletionUrl(provider: RoutedProvider): string {
  if (provider.slug === "cloudflare") return provider.baseUrl || `https://api.cloudflare.com/client/v4/accounts/${enc(CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`;
  if (provider.slug === "gemini" || provider.kind === "gemini") return provider.baseUrl || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  const base = provider.baseUrl || "";
  return base.endsWith("/chat/completions") ? base : `${base.replace(/\/$/, "")}/chat/completions`;
}

export async function loadAiControlRoutes(force = false): Promise<void> {
  if (!force && controlRoutesLoadedAt > Date.now() - 30_000) return;
  if (controlRoutesPromise) return controlRoutesPromise;
  controlRoutesPromise = (async () => {
    try {
      const [routeRows, providerRows] = await Promise.all([
        rest<Array<{ action?: string; provider_id?: string; position?: number; enabled?: boolean }>>("ai_action_routes", {
          query: "order=action.asc,position.asc&limit=500",
        }),
        rest<Array<Record<string, unknown>>>("ai_providers", { query: "enabled=eq.true&limit=100" }),
      ]);
      const providers = new Map<string, RoutedProvider>();
      for (const row of providerRows ?? []) {
        const slug = String(row.slug ?? "").trim();
        const envKey = String(row.api_key_env ?? providerEnvKey(slug)).trim();
        const key = String(row.api_key ?? "").trim() || (envKey ? Deno.env.get(envKey)?.trim() ?? "" : "");
        if (!key) continue;
        providers.set(String(row.id), {
          id: String(row.id),
          slug,
          kind: String(row.kind ?? "openai_compatible"),
          key,
          baseUrl: String(row.base_url ?? ""),
          model: String(row.default_model ?? ""),
        });
      }
      const next = new Map<string, RoutedProvider[]>();
      for (const row of routeRows ?? []) {
        const action = String(row.action ?? "");
        if (!action) continue;
        const list = next.get(action) ?? [];
        if (row.enabled !== false) {
          const provider = providers.get(String(row.provider_id ?? ""));
          if (provider) list.push(provider);
        }
        // Preserve an explicit empty action route: disabled rows or missing
        // keys must disable that action rather than silently restoring legacy
        // environment routing.
        next.set(action, list);
      }
      controlRoutes = next;
    } catch {
      // Missing migration or a transient PostgREST error preserves legacy env routing.
      controlRoutes = new Map();
    } finally {
      controlRoutesLoadedAt = Date.now();
      controlRoutesPromise = null;
    }
  })();
  return controlRoutesPromise;
}

async function routedProviders(action: string): Promise<RoutedProvider[] | null> {
  await loadAiControlRoutes();
  return controlRoutes.has(action) ? controlRoutes.get(action)! : null;
}

// Provider chain for both rewrite stages: Groq → Gemini → Mistral →
// Cloudflare → OpenRouter (:free). First usable response wins; order is by
// measured latency + free-tier generosity. Groq retired llama-3.3-70b — its
// current text model is openai/gpt-oss-20b (verified against /models on this
// key). Gemini 2.5-flash sits second so a quota-killed Groq hands the load to
// a FAST provider, not Mistral's slower free tier. OpenRouter runs a :free
// model verified live 2026-08-19 (accepts response_format json_object).
// Test hook: unit tests inject a stub provider list so they never depend on
// which env happened to be visible when config.ts was first evaluated.
let rewriteProvidersForTest: ProviderSpec[] | null = null;
export function setRewriteProvidersForTest(list: ProviderSpec[]): void {
  rewriteProvidersForTest = list;
}
function rewriteProviders(action = "rewrite"): ProviderSpec[] {
  if (rewriteProvidersForTest) return rewriteProvidersForTest;
  const routed = controlRoutes.get(action);
  if (routed) return routed.map((p) => ({ name: `${p.slug}:${p.id}`, url: routedCompletionUrl(p), key: p.key, model: p.model }));
  const providers: ProviderSpec[] = [];
  if (GROQ_API_KEY) providers.push({ name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", key: GROQ_API_KEY, model: "openai/gpt-oss-20b" });
  const gKeys = geminiKeys();
  if (gKeys.length > 0) {
    providers.push({ name: "gemini", url: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, key: gKeys[0]!.key, model: "gemini-2.5-flash" });
  }
  if (MISTRAL_API_KEY) providers.push({ name: "mistral", url: "https://api.mistral.ai/v1/chat/completions", key: MISTRAL_API_KEY, model: "mistral-small-latest" });
  if (CLOUDFLARE_API_TOKEN && CLOUDFLARE_ACCOUNT_ID) providers.push({ name: "cloudflare", url: `https://api.cloudflare.com/client/v4/accounts/${enc(CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`, key: CLOUDFLARE_API_TOKEN, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
  if (OPENROUTER_API_KEY) providers.push({ name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", key: OPENROUTER_API_KEY, model: "nvidia/nemotron-3-super-120b-a12b:free" });
  return providers;
}

export async function logAiAttempt(entry: {
  action: string;
  provider?: string | null;
  model?: string | null;
  attemptNumber?: number;
  success: boolean;
  fallbackUsed?: boolean;
  latencyMs?: number | null;
  inputChars?: number | null;
  outputChars?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  httpStatus?: number | null;
  validationResult?: string | null;
  failureReason?: string | null;
  finalDecision?: string | null;
}): Promise<void> {
  try {
    await rest("ai_attempt_log", {
      method: "POST",
      body: {
        action: entry.action,
        provider: entry.provider ?? null,
        model: entry.model ?? null,
        attempt_number: entry.attemptNumber ?? null,
        success: entry.success,
        fallback_used: entry.fallbackUsed ?? false,
        latency_ms: entry.latencyMs ?? null,
        input_chars: entry.inputChars ?? null,
        output_chars: entry.outputChars ?? null,
        prompt_tokens: entry.promptTokens ?? null,
        completion_tokens: entry.completionTokens ?? null,
        http_status: entry.httpStatus ?? null,
        http_status_category: entry.httpStatus === null || entry.httpStatus === undefined
          ? "network"
          : entry.httpStatus >= 500
            ? "5xx"
            : entry.httpStatus >= 400
              ? "4xx"
              : entry.httpStatus >= 300
                ? "3xx"
                : "2xx",
        validation_result: entry.validationResult ?? null,
        failure_reason: entry.failureReason?.slice(0, 500) ?? null,
        final_decision: entry.finalDecision ?? (entry.success ? "passed" : "fallback"),
        test_mode: false,
      },
      prefer: "return=minimal",
    });
  } catch {
    // Observability must never change editorial behavior.
  }
}

// One walk of the provider chain for one rewrite stage. Returns the parsed
// payload from the first usable provider, or null after every provider fails
// (dead-provider marking + error collection preserved from the old inline
// loop so per-cycle health and diagnosable errors behave identically).
async function runRewriteChain<T>(args: {
  stage: "extract" | "compose" | "compress" | "quality-judge" | "update-delta";
  messages: Array<{ role: string; content: string }>;
  deadline: number;
  maxTokens: number;
  parse: (jsonObj: string) => T;
}): Promise<{ data: T; provider: string; model: string } | null> {
  await loadAiControlRoutes();
  const providers = rewriteProviders(args.stage === "compress" ? "compression" : args.stage === "quality-judge" ? "quality_judge" : "rewrite");
  const providerErrors: string[] = [];
  let attemptNumber = 0;
  for (const p of providers) {
    attemptNumber += 1;
    const attemptStarted = Date.now();
    let httpStatus: number | null = null;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    let outputChars = 0;
    // Per-cycle dead-provider skip: a provider that hard-failed earlier in
    // the cycle (429 quota, 401/403, 402, 5xx) is skipped for the rest of the
    // cycle — reset per cycle by resetRewriteProviderHealth() in ingest.ts.
    if (deadRewriteProviders.has(p.name)) continue;
    // Never start an attempt that cannot finish inside the budget.
    if (Date.now() >= args.deadline) break;
    const attemptMs = rewriteAttemptTimeoutMs(Math.max(0, args.deadline - Date.now()));
    try {
      let res: Response;
      try {
        res = await fetch(p.url, {
          method: "POST",
          headers: p.name.startsWith("gemini:")
            ? { "Content-Type": "application/json", "x-goog-api-key": p.key }
            : { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
          body: JSON.stringify({
            model: p.model,
            messages: args.messages,
            temperature: 0.1,
            max_tokens: args.maxTokens,
            // Cloudflare's OpenAI-compat layer rejects response_format.
            ...(p.name.startsWith("cloudflare:") ? {} : { response_format: { type: "json_object" } }),
          }),
          signal: AbortSignal.timeout(attemptMs),
        });
      } catch (fetchErr) {
        throw new Error(`${p.name}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
      }        httpStatus = res.status;
        const raw = await res.text();
        outputChars = raw.length;
        if (!res.ok) throw new Error(`${p.name} ${res.status}: ${raw.slice(0, 150)}`);

      const json = JSON.parse(raw) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (json.choices?.[0]?.finish_reason === "length") {
        throw new Error(`${p.name} response truncated (max_tokens) — batch too large`);
      }
      let content = json.choices?.[0]?.message?.content ?? "";
      content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const jsonObj = extractFirstJsonObject(content);
      if (!jsonObj) throw new Error(`${p.name} returned no JSON object`);
      const data = args.parse(jsonObj);
      usage = json.usage;
      recordAiUsage(p.name, "rewrite", Number(json.usage?.prompt_tokens ?? 0), Number(json.usage?.completion_tokens ?? 0));
      await logAiAttempt({
        action: args.stage === "quality-judge" ? "quality_judge" : args.stage === "compress" ? "compression" : args.stage === "update-delta" ? "rewrite" : args.stage === "extract" ? "fact_extraction" : "rewrite",
        provider: p.name,
        model: p.model,
        attemptNumber,
        success: true,
        fallbackUsed: attemptNumber > 1,
        latencyMs: Date.now() - attemptStarted,
        inputChars: args.messages.reduce((sum, message) => sum + message.content.length, 0),
        outputChars,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        httpStatus,
        validationResult: "valid_json",
        finalDecision: "passed",
      });
      return { data, provider: p.name, model: p.model };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isHardProviderFailure(msg)) deadRewriteProviders.add(p.name);
      providerErrors.push(msg);
      await logAiAttempt({
        action: args.stage === "quality-judge" ? "quality_judge" : args.stage === "compress" ? "compression" : args.stage === "update-delta" ? "rewrite" : args.stage === "extract" ? "fact_extraction" : "rewrite",
        provider: p.name,
        model: p.model,
        attemptNumber,
        success: false,
        fallbackUsed: attemptNumber > 1,
        latencyMs: Date.now() - attemptStarted,
        inputChars: args.messages.reduce((sum, message) => sum + message.content.length, 0),
        outputChars,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        httpStatus,
        validationResult: "provider_or_parse_failed",
        failureReason: msg,
        finalDecision: "fallback",
      });
    }
  }
  await logActivity(
    "ingest",
    "warning",
    `AI ${args.stage} stage failed on all providers`,
    providerErrors.join(" | ").slice(0, 500),
  );
  return null;
}

const EXTRACT_SYSTEM_PROMPT = `You are a fact-extraction engine for a news wire. For EACH numbered item supplied as JSON, list ONLY the facts the item's text explicitly states. Return ONLY a JSON object mapping each item's number to its extraction, e.g. {"1": {"event":"...","actor":"...","action":"...","target":"...","location":"...","time":"...","claimed_result":"...","confirmed_result":null,"source_attribution":"...","confidence":"high","numbers":["18 killed","756 wounded"],"key_facts":["The US Treasury sanctioned three Iranian companies.","The Treasury Department said the companies helped procure components for unmanned aircraft.","The sanctions block their US-based assets."]}}.
Rules:
- key_facts: EVERY discrete stated fact as a short standalone sentence, in source order. Include who acted, what they did, the stated reason/mechanism, and the stated effect/consequence. This array is the complete factual record for the item — do not skip stated details.
- numbers: every figure exactly as stated ("18 killed", "$1.4 billion", "70%"). Never round, convert, or add figures not present.
- claimed_result: what the source SAYS happened. confirmed_result: only what the source states as verified/confirmed (often null).
- QUOTES: capture quoted statements verbatim inside key_facts, with who said them.
- Use null for any field the text does not state. NEVER infer, add background, motives, reactions, or world knowledge.
- confidence: high = specific, attributed, concrete; medium = some specifics but hedged; low = vague or single-source claims.`;

const JUDGE_SYSTEM_PROMPT = `You are a wire-quality checker. For EACH numbered item you receive the extracted FACTS (key_facts) plus a composed HEADLINE and SUMMARY. Return ONLY a JSON object mapping each item's number to {"ok": true} or {"ok": false, "reason": "..."}.
Mark ok=false ONLY when:
(a) the summary adds no information beyond what the headline already states;
(b) a claim is attributed passively or unnamed ("a claim was made", "reports say", "it was reported") although key_facts name an actor or source;
(c) the headline or summary states a figure, actor, place, or event that is NOT present in the facts.
Do NOT judge style, tone, length, or phrasing preferences — those are handled elsewhere.`;

// ── #3 Update delta: for an UPDATE post of an already-published event, write
// only what is NEW instead of restating the whole story. Fail-open: any error
// or thin output returns null and publish ships the full summary unchanged.
export const UPDATE_DELTA_PROMPT = `Given a PREVIOUSLY PUBLISHED brief and an UPDATED report of the same event, write the updated brief: 1-2 sentences stating ONLY what is new since the previous brief, opening directly with the newest development, plus one short context clause so a first-time reader knows which event this continues. Use ONLY facts present in the two texts — never add figures, actors, or events. Never use passive attribution; name who makes each claim. Preserve all figures exactly. Respond with ONLY JSON: {"summary":"..."}.`;

export async function composeUpdateDelta(previousBrief: string, updatedReport: string): Promise<string | null> {
  try {
    const res = await runRewriteChain<Record<string, unknown>>({
      stage: "update-delta",
      deadline: Date.now() + 12_000,
      maxTokens: 500,
      messages: [
        { role: "system", content: UPDATE_DELTA_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            previously_published_brief: previousBrief.slice(0, 900),
            updated_report: updatedReport.slice(0, 1200),
          }),
        },
      ],
      parse: (jsonObj) => JSON.parse(jsonObj) as Record<string, unknown>,
    });
    const s = String(res?.data?.summary ?? "").trim();
    return s.length > 30 ? s : null;
  } catch {
    return null;
  }
}

export function composeSystemPrompt(items: RewriteItem[]): string {
  const stylePolicy = items.map((item, i) => {
    const style = stylePromptParts(item.style, item.styleRule ? { [String(item.style ?? "current")]: { rule: item.styleRule, example: item.styleExample } } : undefined);
    return `Item ${i + 1}: ${style.id} — ${style.rule} Example: ${style.example} Length: ${lengthPromptRule(item.length)}${item.aiStyleAssist ? " AI assist is enabled: use judgment only when the source clearly calls for a different register; never override factual or attribution rules." : ""}`;
  }).join("\n");
  return `${stylePolicy}

You are a wire editor for an Iraqi, Muslim, pro-Iran regional news channel. For each numbered item you receive the FACTS extracted from its source text. Write the headline and a clean summary USING ONLY those facts. Return ONLY a JSON object mapping each item's number to {"headline": "...", "summary": "..."}.
Rules:
- HEADLINE: Who → did what → where → important consequence. Under 100 characters. If the facts describe only a claim, KEEP the attribution verb ("Iran says…", "US claims…") — never turn a claim into the channel's assertion. Never be more dramatic than the facts. Do not copy the source title verbatim.
- SUMMARY: a proper news brief whose length follows the per-item Length directive (brief = up to 2 concise sentences; standard = 3–5 informative sentences; long_form = fuller ONLY when key_facts support it without padding). The FIRST sentence must NOT restate the headline — open with what the headline does not say: the when/where, an exact figure, the named speaker and their exact claim, or the stated reason/mechanism. The headline alone owns the core fact; the summary must add to it from its very first words. Then continue with the stated mechanism, reason, and key details from key_facts; close with the stated consequence when the facts include one.
- ATTRIBUTION: never use passive or unnamed attribution ("a claim was made", "reports say", "it was reported") — name WHO makes every claim ("Iran's FM Araqchi said…"). When the facts name an actor or source_attribution for a claim, that name must appear in the summary.
- STYLE EXAMPLES ARE TONE-ONLY: never copy a country, person, place, event, number, quote, or claim from a style example unless that fact appears in the item's extracted facts.
- A detail not present in the extracted facts DOES NOT EXIST — never add context, background, implications, motives, statistics, casualties, or reactions.
- NEVER open with filler such as "A report states that…", "It has been reported that…" — state the fact directly with its real attribution.
- NEVER just reword the headline; the summary must add the details the headline leaves out. Do not repeat the headline, verbatim or reworded, anywhere in the summary.
- Preserve exact numbers and quoted statements verbatim. Never round, never add.
- Never end with ellipsis or an unfinished sentence.`;
}

// ── Long-body map-reduce: bodies over LONG_BODY_CHARS lose their tail to the
// 12k slice. Split at a sentence boundary into two halves, extract facts from
// each, and merge the fact records — the compose stage then sees the WHOLE
// article's factual record, not just its first half.
export const LONG_BODY_CHARS = 6000;

/** Split text into two sentence-boundary halves around `at` chars, or null
 *  when the text is not long enough to bother (≤ LONG_BODY_CHARS). */
export function splitLongText(text: string): [string, string] | null {
  const t = (text ?? "").trim();
  if (t.length <= LONG_BODY_CHARS) return null;
  const cutAt = (from: number, to: number): string => {
    const window = t.slice(from, to);
    let lastEnd = -1;
    for (const m of window.matchAll(/[.!?](?:\s|$)/g)) {
      if (m.index !== undefined) lastEnd = m.index + 1;
    }
    return lastEnd > 200 ? window.slice(0, lastEnd).trim() : window.trim();
  };
  const mid = Math.floor(t.length / 2);
  const first = cutAt(0, mid);
  const second = cutAt(first.length, t.length).trim();
  if (!first || !second) return null;
  return [first, second];
}

function dedupeConcat(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const arr of [a, b]) {
    if (!Array.isArray(arr)) continue;
    for (const v of arr) {
      const s = String(v).trim();
      if (!s) continue;
      const k = s.toLowerCase().slice(0, 80);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

/** Merge the two extract records of a split long body into one fact record:
 *  part 1 wins scalar conflicts; lists concat with near-duplicate removal. */
export function mergeLongFacts(
  part1: Record<string, unknown> | null | undefined,
  part2: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const p1 = part1 ?? {};
  const p2 = part2 ?? {};
  const out: Record<string, unknown> = {};
  for (const field of ["event", "actor", "action", "target", "location", "time", "claimed_result", "confirmed_result", "source_attribution", "confidence"]) {
    out[field] = p1[field] ?? p2[field] ?? null;
  }
  out.numbers = dedupeConcat(p1.numbers, p2.numbers);
  out.key_facts = dedupeConcat(p1.key_facts, p2.key_facts);
  return out;
}

// ── #5 Semantic quality judge (Stage C, fail-open). One small call per batch
// scores each composed brief against grounding/attribution/added-value rules
// regex guards cannot see. Any failure → null → nothing changes.
export type QualityVerdict = { ok?: boolean; reason?: string };

/** Pure application of judge verdicts: a failing brief is rebuilt from its own
 *  extracted key_facts (grounded by construction); when no key_facts exist the
 *  summary is emptied so downstream guards treat it as unusable. */
export function applyQualityVerdicts(
  results: Array<{ headline: string; summary: string }>,
  keyFactsPerItem: string[][],
  verdicts: Record<string, QualityVerdict> | null | undefined,
): { repaired: number; dropped: number } {
  if (!verdicts) return { repaired: 0, dropped: 0 };
  let repaired = 0;
  let dropped = 0;
  for (let i = 0; i < results.length; i++) {
    const v = verdicts[String(i + 1)];
    if (!v || v.ok !== false) continue;
    const kf = (keyFactsPerItem[i] ?? []).slice(0, 5).join(" ").trim();
    if (kf && kf.length >= 60) {
      results[i].summary = kf;
      repaired += 1;
    } else {
      results[i].summary = "";
      dropped += 1;
    }
  }
  return { repaired, dropped };
}

// ── Tier 3: single-call compression ────────────────────────────────────────
// Instead of extract→compose (2 calls + judge), one cheap call: "compress this
// article to ~N characters". Keeps the original data — every figure, name,
// date, quote and attribution verb must survive; nothing may be added.
export const COMPRESS_SYSTEM_PROMPT = `You are a wire editor compressing a news article. Compress the supplied article to about the requested character budget. Rules:
- The summary keeps EVERY figure, name, place, date, and quoted statement from the article — drop lesser details and repetition, never facts.
- Never add any information not present in the article. Never round or restate a number differently.
- Keep attribution verbs exactly ("X said", "Y claims") — never convert a claim into a plain fact.
- HEADLINE: under 100 characters, built from the article's own words: who did what, where. If the article states only a claim, keep the attribution verb in the headline too. Do not copy the source title verbatim — but do not drift from its meaning either.
- SUMMARY: the compressed body. Its first sentence must carry what the headline does not (when/where/figure/named speaker). Complete sentences only, no ellipsis, never end mid-sentence.
Respond with ONLY JSON: {"headline":"...","summary":"..."}.`;

export async function compressArticle(
  title: string,
  text: string,
  targetChars: number,
  deadline = Date.now() + 15_000,
): Promise<ExtractedFacts | null> {
  try {
    const res = await runRewriteChain<Record<string, unknown>>({
      stage: "compress",
      deadline,
      maxTokens: 1600,
      messages: [
        { role: "system", content: `${COMPRESS_SYSTEM_PROMPT}\nTarget length for the summary: about ${targetChars} characters.` },
        {
          role: "user",
          content: JSON.stringify({ source_title: title.slice(0, 300), article: text.slice(0, 8000) }),
        },
      ],
      parse: (jsonObj) => JSON.parse(jsonObj) as Record<string, unknown>,
    });
    if (!res) return null;
    const headline = String(res.data?.headline ?? "").trim();
    const summary = String(res.data?.summary ?? "").trim();
    if (!headline || !summary) return null;
    return { headline, summary, facts: { confidence: "high", note: "ai-compress", key_facts: [] } };
  } catch {
    return null;
  }
}

export async function groqExtractFacts(items: RewriteItem[], deadline = Number.POSITIVE_INFINITY): Promise<RewriteChunkResult> {
  if (items.length === 0) return { items: [], provider: null, model: null };
  const startAt = Date.now();
  await loadAiControlRoutes();
  if (rewriteProviders("rewrite").length === 0) {
    await logRewrite({
      ok: false,
      itemCount: items.length,
      headlines: items.map((i) => i.title),
      error: "no rewrite providers configured (GROQ_API_KEY / OPENROUTER_API_KEY / CLOUDFLARE credentials)",
      durationMs: Date.now() - startAt,
    });
    return { items: items.map(() => null), provider: null, model: null };
  }

  // Stage A — EXTRACT. Gets up to ~60% of the remaining budget (min 20s):
  // compose is the cheaper call and degrades gracefully if squeezed.
  const extractDeadline = Date.now() >= deadline
    ? deadline
    : Math.min(deadline, Date.now() + Math.max(20_000, Math.floor((deadline - Date.now()) * 0.6)));

  const extractCall = (
    batch: RewriteItem[],
    callDeadline: number,
  ): Promise<{ data: Record<string, Record<string, unknown>>; provider: string | null; model: string | null } | null> =>
    runRewriteChain<Record<string, Record<string, unknown>>>({
      stage: "extract",
      deadline: callDeadline,
      maxTokens: 6000,
      messages: [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify(batch.map((item, i) => ({ [String(i + 1)]: {
            title: item.title,
            // Full source text up to the fetch cap (12k) — mechanism/reason/
            // consequence sentences only exist deep in the body.
            text: item.description?.slice(0, 12_000) ?? "",
          } }))),
        },
      ],
      parse: (jsonObj) => JSON.parse(jsonObj) as Record<string, Record<string, unknown>>,
    });

  const rowToFacts = (row: Record<string, unknown>): Record<string, unknown> => ({
    event: row.event ?? null,
    actor: row.actor ?? null,
    action: row.action ?? null,
    target: row.target ?? null,
    location: row.location ?? null,
    time: row.time ?? null,
    claimed_result: row.claimed_result ?? null,
    confirmed_result: row.confirmed_result ?? null,
    source_attribution: row.source_attribution ?? null,
    confidence: row.confidence ?? null,
    numbers: Array.isArray(row.numbers) ? row.numbers : [],
    key_facts: Array.isArray(row.key_facts)
      ? row.key_facts.map((f) => String(f)).filter((f) => f.trim().length > 0)
      : [],
  });

  // Map-reduce for long bodies (#6): a body over LONG_BODY_CHARS is split at a
  // sentence boundary and each half extracts separately; the fact records are
  // merged so compose sees the WHOLE article. Short items extract as one
  // batch exactly as before.
  const normalIdx: number[] = [];
  const longIdx: number[] = [];
  items.forEach((it, i) => ((it.description?.length ?? 0) > LONG_BODY_CHARS ? longIdx : normalIdx).push(i));

  let extProvider: string | null = null;
  let extModel: string | null = null;
  const factsByIdx = new Map<number, Record<string, unknown>>();

  if (normalIdx.length > 0) {
    const res = await extractCall(normalIdx.map((i) => items[i]!), extractDeadline);
    if (res) {
      extProvider = res.provider;
      extModel = res.model;
      normalIdx.forEach((origIdx, j) => {
        const row = res.data[String(j + 1)];
        if (row) factsByIdx.set(origIdx, rowToFacts(row));
      });
    }
  }
  for (const origIdx of longIdx) {
    if (Date.now() >= extractDeadline) break;
    const halves = splitLongText(items[origIdx]!.description ?? "");
    if (!halves) continue;
    const halfDeadline = (used: number) => Math.min(extractDeadline, Date.now() + Math.max(15_000, Math.floor((extractDeadline - Date.now()) / used)));
    const [r1, r2] = await Promise.all([
      extractCall([{ title: items[origIdx]!.title, description: halves[0], solo: true }], halfDeadline(2)),
      extractCall([{ title: items[origIdx]!.title, description: halves[1], solo: true }], halfDeadline(2)),
    ]);
    const merged = mergeLongFacts(r1?.data["1"] ?? null, r2?.data["1"] ?? null);
    if (r1 || r2) {
      extProvider = extProvider ?? (r1 ?? r2)!.provider;
      extModel = extModel ?? (r1 ?? r2)!.model;
      factsByIdx.set(origIdx, merged);
    }
  }

  if (factsByIdx.size === 0) {
    await logRewrite({
      ok: false,
      itemCount: items.length,
      headlines: items.map((i) => i.title),
      error: "extract stage failed on all providers",
      durationMs: Date.now() - startAt,
    });
    return { items: items.map(() => null), provider: null, model: null };
  }

  // Per-item structured facts (same field set downstream code already reads,
  // plus key_facts — the compose-stage ground truth).
  const factRows = items.map((item, i) => ({
    item,
    facts: factsByIdx.get(i) ?? rowToFacts({}),
  }));

  // Stage B — COMPOSE from the extracted facts only.
  const comRes = await runRewriteChain<Record<string, Record<string, unknown>>>({
    stage: "compose",
    deadline,
    maxTokens: 4000,
    messages: [
      { role: "system", content: composeSystemPrompt(items) },
      {
        role: "user",
        content: JSON.stringify(factRows.map((r, i) => ({ [String(i + 1)]: {
          title: r.item.title,
          facts: r.facts,
        } }))),
      },
    ],
    parse: (jsonObj) => JSON.parse(jsonObj) as Record<string, Record<string, unknown>>,
  });

  // Merge. Compose failure degrades gracefully: the brief falls back to the
  // first extracted key_facts joined as sentences (still grounded — no
  // invention), then to the raw source text, matching the old fallbacks.
  const results = factRows.map((r, i): ExtractedFacts => {
    const row = comRes?.data[String(i + 1)] ?? {};
    const headline = String(row.headline ?? "").trim() || r.item.title;
    let summary = String(row.summary ?? "").trim();
    const keyFacts = (r.facts.key_facts as string[]) ?? [];
    if (!summary && keyFacts.length > 0) summary = keyFacts.slice(0, 5).join(" ");
    if (!summary) summary = r.item.description ?? "";
    if (!/[.!?]$/.test(summary) && summary.length > 0) summary += ".";
    return { headline, summary, facts: r.facts };
  });

  // Stage C — JUDGE (#5, fail-open): one small call scores every brief against
  // grounding/attribution/added-value rules regex guards cannot see. A failing
  // brief rebuilds from its own key_facts; no key_facts → emptied so the
  // ingest guards drop it. Judge failure changes nothing.
  const judgeRes = await runRewriteChain<Record<string, { ok?: boolean; reason?: string }>>({
    stage: "quality-judge",
    deadline: Math.min(deadline, Date.now() + 12_000),
    maxTokens: 1200,
    messages: [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(results.map((r, i) => ({ [String(i + 1)]: {
        facts: factRows[i]!.facts.key_facts,
        headline: r.headline,
        summary: r.summary,
      } }))) },
    ],
    parse: (jsonObj) => JSON.parse(jsonObj) as Record<string, { ok?: boolean; reason?: string }>,
  }).catch(() => null);
  const verdict = applyQualityVerdicts(
    results,
    factRows.map((r) => (r.facts.key_facts as string[]) ?? []),
    judgeRes?.data ?? null,
  );
  if (verdict.repaired + verdict.dropped > 0) {
    await logActivity("ingest", "info", `Quality judge: ${verdict.repaired} brief(s) rebuilt from key facts, ${verdict.dropped} dropped`);
  }

  await logRewrite({
    ok: true,
    provider: comRes ? `${extProvider}+${comRes.provider}` : `${extProvider}+facts-fallback`,
    model: comRes ? `${extModel}+${comRes.model}` : extModel,
    itemCount: results.length,
    headlines: results.map((r) => r.headline),
    durationMs: Date.now() - startAt,
  });
  // Provenance on the queue row names the provider that produced the VISIBLE
  // headline + summary — the compose stage when it ran, otherwise the facts
  // fallback produced by the extract-stage model. The full two-stage chain is
  // in the rewrite_log above.
  return { items: results, provider: comRes?.provider ?? extProvider, model: comRes?.model ?? extModel };
}


// ── AI: Gemini direct translation (Sorani) ─────────────────────────────────
export const GEMINI_DIRECT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
export const SORANI_SYSTEM_PROMPT =
  "Translate the following message into Kurdish Sorani (Central Kurdish, in the Sorani script). Output ONLY the translation — no commentary, no \"Translation:\" prefix, no quotes around the text. Preserve emojis, links, line breaks, and any formatting exactly. Preserve all numbers, dates, times, percentages and quoted statements exactly as given — never change, round or reword a figure. If the message contains a headline followed by a blank line, preserve that separator and make the translated headline a complete phrase; never end it with a dangling connector such as in, at, to, of, and, or the Sorani equivalents لە، بۆ، و، کە. Never include the publisher, source, or channel name anywhere in your output. Translate the headline ONCE as the title — never repeat the headline, in English or in Sorani, anywhere in the body, and never include the original English headline in your output. Every sentence and paragraph must be complete; never end any sentence with a dangling connector.";
export const SORANI_SYSTEM_PROMPT_STRICT =
  "Translate the following message into Kurdish Sorani (Central Kurdish). You MUST output ONLY the translation in the Sorani Arabic script (ئەلفوبێی عەرەبیی سۆرانی). Do NOT answer in English or Latin script — translate every word into Sorani script except widely-recognised abbreviations (CIA, US, UN, NATO, CEO). Do NOT add commentary, explanations, a \"Translation:\" prefix, or quotes. Output ONLY the Sorani translation. Preserve emojis, links, line breaks, and formatting exactly. Preserve all numbers, dates, times and quoted statements exactly as given — never change, round or reword a figure. If the message contains a headline followed by a blank line, preserve that separator and make the translated headline a complete phrase; never end it with a dangling connector such as لە، بۆ، و، کە. Never include the publisher, source, or channel name anywhere in your output. Translate the headline ONCE as the title — never repeat the headline, in English or in Sorani, anywhere in the body, and never include the original English headline in your output. Every sentence and paragraph must be complete; never end any sentence with a dangling connector.";


// Best-effort Gemini usage logging so the admin console per-key × per-model
// cards stay truthful (they read gemini_call_log + gemini_key_usage). Never
// throws — usage logging must not break translation.
export async function logGeminiCall(c) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await rest("gemini_call_log", {
      method: "POST",
      body: {
        key_index: c.keyIndex, model: c.model, direction: "sorani",
        ok: c.ok, code: c.code, message: String(c.message).slice(0, 200),
      },
      prefer: "return=minimal",
    });
    const existing = await rest("gemini_key_usage", {
      query: `day=eq.${today}&key_index=eq.${c.keyIndex}&model=eq.${encodeURIComponent(c.model)}&limit=1`,
    });
    const row = Array.isArray(existing) ? existing[0] : undefined;
    const inc = {
      calls: 1, ok: c.ok ? 1 : 0,
      rate_limited: c.code === 429 ? 1 : 0,
      other_errors: !c.ok && c.code !== 429 ? 1 : 0,
    };
    if (row?.id) {
      await rest(`gemini_key_usage?id=eq.${row.id}`, {
        method: "PATCH",
        body: {
          calls: Number(row.calls ?? 0) + inc.calls,
          ok: Number(row.ok ?? 0) + inc.ok,
          rate_limited: Number(row.rate_limited ?? 0) + inc.rate_limited,
          other_errors: Number(row.other_errors ?? 0) + inc.other_errors,
        },
        prefer: "return=minimal",
      });
    } else {
      await rest("gemini_key_usage", {
        method: "POST",
        body: {
          day: today, key_index: c.keyIndex, model: c.model,
          calls: inc.calls, ok: inc.ok,
          rate_limited: inc.rate_limited, other_errors: inc.other_errors,
        },
        prefer: "return=minimal",
      });
    }
  } catch { /* best-effort only */ }
}

export const GEMINI_MIN_INTERVAL_MS = 13_000;
export const GEMINI_RATE_LIMIT_COOLDOWN_MS = 65_000;
// Quota-exhaustion fail-fast: N consecutive 429s in one sweep means the whole
// key pool is drained (free-tier daily quota), so stop retrying Gemini and
// let MiniMax take the item — retries only burn the ~100s cycle budget.
export const GEMINI_429_FAILFAST_THRESHOLD = 3;
export const keyNextAt = new Map<number, number>();
export let geminiNextGlobalAt = 0;
export const modelCooldownUntil = new Map<string, number>();
// While set, geminiTranslateOnce returns null immediately (zero cost) so the
// rest of the cycle goes straight to MiniMax. Re-checked next cycle.
export let geminiPoolExhaustedUntil = 0;

// Keep the whole Gemini translator under 5 requests/minute. Do not allow key
// rotation to create bursts: 13 seconds between Gemini request starts = about
// 4.6 requests/minute total across all keys/models combined.
export async function waitForGeminiRateSlot(keyIndex: number): Promise<void> {
  const now = Date.now();
  const wait = Math.max((keyNextAt.get(keyIndex) ?? 0) - now, geminiNextGlobalAt - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const nextAt = Date.now() + GEMINI_MIN_INTERVAL_MS;
  keyNextAt.set(keyIndex, nextAt);
  geminiNextGlobalAt = nextAt;
}

export function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

export async function geminiTranslateOnce(text: string, glossary: string | undefined, modelOverride?: string): Promise<{ text: string; model: string; keyIndex: number } | null> {
  if (Date.now() < geminiPoolExhaustedUntil) return null;
  const keys = geminiKeys();
  if (keys.length === 0) return null;
  const deadKeys = new Set<number>();
  let consecutive429 = 0;
  const models = modelOverride ? [modelOverride] : GEMINI_DIRECT_MODELS;
  for (const model of models) {
    if (modelCooldownUntil.has(model) && Date.now() < (modelCooldownUntil.get(model) ?? 0)) continue;
    for (const { index, key } of keys) {
      if (deadKeys.has(index)) continue;
      await waitForGeminiRateSlot(index);

      const glossaryBlock = buildGlossaryBlock(glossary, text);
      // The glossary is an instruction, not text to translate. Tell the model
      // explicitly so it doesn't echo "TRANSLATION GLOSSARY — …" (or a Kurdish
      // rendering of it) into the answer — that leaked into the channel.
      const glossaryNote = glossaryBlock
        ? "The glossary above is an internal instruction only — do NOT translate, repeat, or output it or its header.\n\n"
        : "";
      const prompt = `${glossaryBlock}${SORANI_SYSTEM_PROMPT}\n\n${glossaryNote}Message:\n${text.slice(0, 2500)}`;
      let res: Response;
      try {
        res = await fetch(`${GEMINI_DIRECT_ENDPOINT}/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 4096 },
          }),
          signal: AbortSignal.timeout(45_000),
        });
      } catch (fetchErr) {
        await logGeminiCall({ keyIndex: index, model, ok: false, code: 0, message: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) });
        continue;
      }
      const data = (await res.json().catch(() => null)) as {
        error?: { code?: number; message?: string };
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      };
      if (!res.ok || data?.error) {
        const code = data?.error?.code ?? res.status;
        await logGeminiCall({ keyIndex: index, model, ok: false, code, message: data?.error?.message ?? `HTTP ${res.status}` });
        if (code === 400 || code === 401 || code === 403) deadKeys.add(index);
        if (code === 429) {
          const ra = retryAfterMs(res);
          consecutive429 += 1;
          // Every attempt this sweep is 429 (or a long Retry-After arrived):
          // the pool is quota-drained, not throttled. Stop here — MiniMax is
          // the fallback and it can finish inside the cycle budget.
          if (consecutive429 >= GEMINI_429_FAILFAST_THRESHOLD || (ra && ra > 15_000)) {
            if (Date.now() >= geminiPoolExhaustedUntil) {
              await logActivity("translation", "warning", "Gemini pool quota-exhausted (429) — using MiniMax fallback");
            }
            geminiPoolExhaustedUntil = Date.now() + Math.min(Math.max(60_000, ra ?? 0), 30 * 60_000);
            return null;
          }
          const cooldownUntil = Date.now() + (ra ?? GEMINI_RATE_LIMIT_COOLDOWN_MS);
          modelCooldownUntil.set(model, cooldownUntil);
          if (ra) geminiNextGlobalAt = Math.max(geminiNextGlobalAt, cooldownUntil);
        }
        continue;
      }
      if (data?.candidates?.[0]?.finishReason === "MAX_TOKENS") {
        await logGeminiCall({ keyIndex: index, model, ok: false, code: 500, message: "MAX_TOKENS truncation" });
        continue;
      }
      const out = cleanGeminiTranslation((data?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? "").join(""));
      if (out && validateSorani(out)) {
        await logGeminiCall({ keyIndex: index, model, ok: true, code: 200, message: "ok" });
        return { text: out, model, keyIndex: index };
      }
      await logGeminiCall({ keyIndex: index, model, ok: false, code: 500, message: "invalid Sorani output" });
    }
  }
  return null;
}

// Any model through the Vercel AI Gateway (one gateway token, no per-key
// daily/RPM quota cliffs). Used for MiniMax and for gateway-hosted Google
// Gemini models (google/gemini-2.5-flash, google/gemini-2.5-flash-lite, …).
export async function gatewayTranslate(text: string, glossary: string | undefined, model: string, strict: boolean): Promise<string | null> {
  if (!MINIMAX_API_KEY) return null;
  try {
    const glossaryBlock = buildGlossaryBlock(glossary, text);
    // Keep the glossary in the SYSTEM role (an instruction, not user text) so
    // the model doesn't treat it as part of the message and echo it back.
    const system = `${strict ? SORANI_SYSTEM_PROMPT_STRICT : SORANI_SYSTEM_PROMPT}${
      glossaryBlock
        ? `\n\n${glossaryBlock}Treat the glossary above as an internal instruction only — do NOT translate, repeat, or output it or its header.`
        : ""
    }`;
    const res = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MINIMAX_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: text.slice(0, 1500) },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
    if (json.choices?.[0]?.finish_reason === "length") return null;
    const out = cleanGeminiTranslation((json.choices?.[0]?.message?.content ?? "").trim());
    return validateSorani(out) ? out : null;
  } catch {
    return null;
  }
}

// MiniMax via the Vercel AI Gateway, used as the fallback behind the
// Gemini key pool (gemini_first default). MiniMax does not carry the
// per-key daily/RPM quota cliffs that burn through Gemini keys.
export async function minimaxTranslate(text: string, glossary: string | undefined, strict: boolean): Promise<string | null> {
  return gatewayTranslate(text, glossary, MINIMAX_MODEL, strict);
}

async function routedTranslation(
  text: string,
  glossary: string | undefined,
): Promise<{ text: string; model: string } | null> {
  const providers = await routedProviders("translation");
  if (providers === null) return null;
  let attemptNumber = 0;
  for (const provider of providers) {
    attemptNumber += 1;
    const startedAt = Date.now();
    const model = provider.model || MINIMAX_MODEL;
    const glossaryBlock = buildGlossaryBlock(glossary, text);
    const system = `${SORANI_SYSTEM_PROMPT_STRICT}${glossaryBlock ? `\\n\\n${glossaryBlock}Treat the glossary as internal instructions only.` : ""}`;
    const isGemini = provider.slug === "gemini" || provider.kind === "gemini";
    const isCloudflare = provider.slug === "cloudflare" || provider.kind === "cloudflare";
    const url = routedCompletionUrl(provider);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (isGemini) headers["x-goog-api-key"] = provider.key;
    else headers.Authorization = `Bearer ${provider.key}`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, { role: "user", content: text.slice(0, 2500) }],
          temperature: 0.2,
          max_tokens: 4096,
          ...(isCloudflare ? {} : { response_format: { type: "text" } }),
        }),
        signal: AbortSignal.timeout(45_000),
      });
      const raw = await response.text();
      if (!response.ok) {
        await logAiAttempt({
          action: "translation",
          provider: `${provider.slug}:${provider.id}`,
          model,
          attemptNumber,
          success: false,
          fallbackUsed: attemptNumber > 1,
          latencyMs: Date.now() - startedAt,
          inputChars: text.length,
          outputChars: raw.length,
          httpStatus: response.status,
          validationResult: "provider_rejected",
          failureReason: raw.slice(0, 500),
          finalDecision: "fallback",
        });
        continue;
      }
      const json = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
      if (json.choices?.[0]?.finish_reason === "length") {
        await logAiAttempt({
          action: "translation",
          provider: `${provider.slug}:${provider.id}`,
          model,
          attemptNumber,
          success: false,
          fallbackUsed: attemptNumber > 1,
          latencyMs: Date.now() - startedAt,
          inputChars: text.length,
          outputChars: raw.length,
          httpStatus: response.status,
          validationResult: "truncated",
          failureReason: "provider response truncated",
          finalDecision: "fallback",
        });
        continue;
      }
      const output = cleanGeminiTranslation(json.choices?.[0]?.message?.content ?? "");
      if (output && validateSorani(output)) {
        await logAiAttempt({
          action: "translation",
          provider: `${provider.slug}:${provider.id}`,
          model,
          attemptNumber,
          success: true,
          fallbackUsed: attemptNumber > 1,
          latencyMs: Date.now() - startedAt,
          inputChars: text.length,
          outputChars: output.length,
          httpStatus: response.status,
          validationResult: "valid_sorani",
          finalDecision: "passed",
        });
        return { text: output, model };
      }
      await logAiAttempt({
        action: "translation",
        provider: `${provider.slug}:${provider.id}`,
        model,
        attemptNumber,
        success: false,
        fallbackUsed: attemptNumber > 1,
        latencyMs: Date.now() - startedAt,
        inputChars: text.length,
        outputChars: output.length,
        httpStatus: response.status,
        validationResult: "invalid_sorani",
        failureReason: "provider returned invalid Sorani output",
        finalDecision: "fallback",
      });
    } catch (error) {
      await logAiAttempt({
        action: "translation",
        provider: `${provider.slug}:${provider.id}`,
        model,
        attemptNumber,
        success: false,
        fallbackUsed: attemptNumber > 1,
        latencyMs: Date.now() - startedAt,
        inputChars: text.length,
        validationResult: "network_or_parse_failed",
        failureReason: error instanceof Error ? error.message : String(error),
        finalDecision: "fallback",
      });
      // Continue to the next action-local provider.
    }
  }
  return null;
}

export async function translateToSorani(
  text: string,
  glossary: string | undefined,
  mode = "gemini_first",
  modelOrder?: string[],
): Promise<{ text: string | null; model: string }> {
  // Operator-controllable chain order (settings.translation_mode), and the
  // newer fine-grained order (settings.translation_model_order) which wins:
  // a top-to-bottom list of model ids — each Gemini model id (run across
  // every configured key) or the MiniMax gateway id "minimax/minimax-m3".
  const routed = await routedTranslation(text, glossary);
  if (routed) return routed;
  const configuredTranslationRoute = controlRoutes.has("translation");
  if (configuredTranslationRoute) return { text: null, model: "none" };
  const m = mode || "gemini_first";

  const explicit = Array.isArray(modelOrder)
    ? [...new Set(modelOrder.map((x) => String(x).trim()).filter((x) => x && classifyModel(x) !== "unknown"))]
    : [];
  if (explicit.length > 0) {
    for (const model of explicit) {
      const kind = classifyModel(model);
      if (kind === "gateway") {
        const gw = (await gatewayTranslate(text, glossary, model, false)) ?? (await gatewayTranslate(text, glossary, model, true));
        if (gw) return { text: gw, model };
      } else if (kind === "direct") {
        const g = await geminiTranslateOnce(text, glossary, model);
        if (g) return { text: g.text, model: g.model };
      }
    }
    return { text: null, model: "none" };
  }

  // Legacy translation_mode chain (unchanged when no explicit order is set).
  // "gemini_first" (default) runs the Gemini key pool first — the operator
  // pays for those keys and wants them used; MiniMax is the fallback.
  // "minimax_first" keeps the AI-Gateway call in front; the "*_only" modes
  // skip the other provider.
  const useMinimax = m !== "gemini_only";
  const useGemini = m !== "minimax_only";
  const minimaxFirst = m === "minimax_first" || m === "minimax_only";

  const tryMinimax = async (): Promise<string | null> => {
    if (!useMinimax) return null;
    return (await minimaxTranslate(text, glossary, false)) ?? (await minimaxTranslate(text, glossary, true));
  };
  const tryGemini = async (): Promise<{ text: string; model: string } | null> => {
    if (!useGemini) return null;
    return await geminiTranslateOnce(text, glossary);
  };

  if (minimaxFirst) {
    const mm = await tryMinimax();
    if (mm) return { text: mm, model: MINIMAX_MODEL };
    const g = await tryGemini();
    if (g) return { text: g.text, model: g.model };
  } else {
    const g = await tryGemini();
    if (g) return { text: g.text, model: g.model };
    const mm = await tryMinimax();
    if (mm) return { text: mm, model: MINIMAX_MODEL };
  }
  return { text: null, model: "none" };
}

// ── AI decision usage accounting + final-dedup provider chain ─────────────
// The operator-facing "AI final dedup" settings (ai_dedup_enabled,
// ai_dedup_provider, ai_dedup_window_hours, ai_dedup_max_posts) used to be
// configuration illusions — nothing in the pipeline read them. This wires
// them to a real LLM duplicate check at publish time and records usage in
// ai_usage (previously only ever deleted, so the dashboard "AI" stat was
// permanently zero). Usage is buffered per cycle and flushed once per
// (provider, kind) so accounting never becomes a per-call database tax.

export const _aiUsageBuffer = new Map<
  string,
  { provider: string; kind: string; calls: number; prompt: number; completion: number }
>();

export async function recordAiUsage(provider: string, kind: string, promptTokens: number, completionTokens: number): Promise<void> {
  const key = `${provider}:${kind}`;
  const cur = _aiUsageBuffer.get(key) ?? { provider, kind, calls: 0, prompt: 0, completion: 0 };
  cur.calls += 1;
  cur.prompt += promptTokens;
  cur.completion += completionTokens;
  _aiUsageBuffer.set(key, cur);
}

export async function flushAiUsage(): Promise<void> {
  if (_aiUsageBuffer.size === 0) return;
  const entries = [..._aiUsageBuffer.values()];
  _aiUsageBuffer.clear();
  const day = new Date().toISOString().slice(0, 10);
  for (const e of entries) {
    try {
      const rows = await rest<Array<{ id: string; calls: number; prompt_tokens: number; completion_tokens: number }>>("ai_usage", {
        query: `day=eq.${enc(day)}&provider=eq.${enc(e.provider)}&kind=eq.${enc(e.kind)}&limit=1`,
      });
      const row = rows?.[0];
      if (row?.id) {
        await rest(`ai_usage?id=eq.${enc(String(row.id))}`, {
          method: "PATCH",
          body: {
            calls: Number(row.calls ?? 0) + e.calls,
            prompt_tokens: Number(row.prompt_tokens ?? 0) + e.prompt,
            completion_tokens: Number(row.completion_tokens ?? 0) + e.completion,
          },
          prefer: "return=minimal",
        });
      } else {
        await rest("ai_usage", {
          method: "POST",
          body: { day, provider: e.provider, kind: e.kind, calls: e.calls, prompt_tokens: e.prompt, completion_tokens: e.completion },
          prefer: "return=minimal",
        });
      }
    } catch {
      /* usage accounting must never break the pipeline */
    }
  }
}

// Strict-JSON duplicate verdict. Provider chain follows settings.ai_dedup_provider
// (groq | openrouter | cloudflare), with Groq as the always-available fallback
// when the chosen provider's env key is not configured. Returns null when no
// provider is reachable — the publish path then proceeds on the fast
// keyword/fingerprint dedup alone rather than blocking on AI.
export async function aiDecideIsDuplicate(
  candidateText: string,
  publishedTexts: string[],
  providerSetting: string,
): Promise<{ verdict: "duplicate" | "new" } | null> {
  const texts = publishedTexts.slice(0, 20);
  if (texts.length === 0) return null;
  const system =
    'You are a news-desk duplicate checker for an Iran/Iraq war news channel. Given a candidate news item and a list of already-published items, decide whether the candidate reports the SAME STORY as one already published, or is genuinely NEW. Treat as duplicate: same actor + target + location + day where only the framing/headline differs (e.g. "Trump pressures Iran" vs "Trump contains Iran fallout"), even if the action wording differs. A material NEW development (new casualty count, new official statement, new attack wave) is NEW. Respond with ONLY JSON: {"verdict":"duplicate"|"new","reason":"short reason"}.';
  const user = JSON.stringify({ candidate: candidateText.slice(0, 2000), already_published: texts.map((t) => t.slice(0, 1200)) });
  const order: Array<{ name: string; url: string; headers: Record<string, string>; model: string }> = [];
  const pushProvider = (name: string) => {
    if (name === "groq" && GROQ_API_KEY) {
      order.push({ name, url: "https://api.groq.com/openai/v1/chat/completions", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` }, model: "openai/gpt-oss-20b" });
    } else if (name === "openrouter" && OPENROUTER_API_KEY) {
      order.push({ name, url: "https://openrouter.ai/api/v1/chat/completions", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENROUTER_API_KEY}` }, model: "meta-llama/llama-3.3-70b-instruct" });
    } else if (name === "cloudflare" && CLOUDFLARE_API_TOKEN && CLOUDFLARE_ACCOUNT_ID) {
      order.push({ name, url: `https://api.cloudflare.com/client/v4/accounts/${enc(CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    }
  };
  if (providerSetting === "openrouter") {
    pushProvider("openrouter"); pushProvider("cloudflare"); pushProvider("groq");
  } else if (providerSetting === "cloudflare") {
    pushProvider("cloudflare"); pushProvider("openrouter"); pushProvider("groq");
  } else {
    pushProvider("groq"); pushProvider("openrouter"); pushProvider("cloudflare");
  }
  for (const cfg of order) {
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature: 0,
          max_tokens: 120,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      const content = json?.choices?.[0]?.message?.content ?? "";
      let raw = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const jsonObj = extractFirstJsonObject(raw);
      if (!jsonObj) continue;
      const parsed = JSON.parse(jsonObj) as { verdict?: string };
      if (parsed.verdict === "duplicate" || parsed.verdict === "new") {
        recordAiUsage(cfg.name, "dedup", Number(json?.usage?.prompt_tokens ?? 0), Number(json?.usage?.completion_tokens ?? 0));
        return { verdict: parsed.verdict };
      }
    } catch {
      /* try the next provider */
    }
  }
  return null;
}

// AI-assisted category: called from ingest ONLY when the keyword classifier is
// ambiguous (categoryNeedsAi — 0 keyword matches, or a single generic bucket).
// One-shot JSON decision, same provider chain as the dedup verdict
// (settings.ai_dedup_provider, Groq as the always-available fallback) so the
// operator's existing provider choice covers it — zero new infra. The answer
// is whitelisted against ALLOWED_CATEGORIES before it is trusted; a null
// return means "keep the keyword result" (never blocks ingest).
export async function aiDecideCategory(
  text: string,
  providerSetting: string,
): Promise<string | null> {
  const system =
    `You are a news-desk categorizer for a Middle East war news channel. Given a news item's title and summary, pick the SINGLE most specific category from this exact list: ${ALLOWED_CATEGORIES.join(", ")}. Rules: gaza = Israel-Palestine / Gaza / West Bank stories specifically; syria = Syria specifically (strikes, Turkey border, regime); lebanon = Lebanon / the Hezbollah-Israel front specifically (Hezbollah activity goes here, NOT proxies); proxies = Iran-aligned militias other than Hezbollah (Houthis, Kataib, Hashd, Hamas outside Gaza framing); war = military action not covered by a region above; iran = Iran-related with no more specific match; middle-east = other regional news; iraq / oil / gold / usa / economic-impact / analysis as their names say. Prefer the most specific category. Respond with ONLY JSON: {"category":"<one of the list>","reason":"short reason"}.`;
  const user = JSON.stringify({ item: text.slice(0, 2000) });
  const order: Array<{ name: string; url: string; headers: Record<string, string>; model: string }> = [];
  const pushProvider = (name: string) => {
    if (name === "groq" && GROQ_API_KEY) {
      order.push({ name, url: "https://api.groq.com/openai/v1/chat/completions", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` }, model: "openai/gpt-oss-20b" });
    } else if (name === "openrouter" && OPENROUTER_API_KEY) {
      order.push({ name, url: "https://openrouter.ai/api/v1/chat/completions", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENROUTER_API_KEY}` }, model: "meta-llama/llama-3.3-70b-instruct" });
    } else if (name === "cloudflare" && CLOUDFLARE_API_TOKEN && CLOUDFLARE_ACCOUNT_ID) {
      order.push({ name, url: `https://api.cloudflare.com/client/v4/accounts/${enc(CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    }
  };
  if (providerSetting === "openrouter") {
    pushProvider("openrouter"); pushProvider("cloudflare"); pushProvider("groq");
  } else if (providerSetting === "cloudflare") {
    pushProvider("cloudflare"); pushProvider("openrouter"); pushProvider("groq");
  } else {
    pushProvider("groq"); pushProvider("openrouter"); pushProvider("cloudflare");
  }
  for (const cfg of order) {
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature: 0,
          max_tokens: 60,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      const content = json?.choices?.[0]?.message?.content ?? "";
      const raw = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const jsonObj = extractFirstJsonObject(raw);
      if (!jsonObj) continue;
      const parsed = JSON.parse(jsonObj) as { category?: string };
      const category = normalizeAiCategory(parsed.category ?? "");
      if (category) {
        recordAiUsage(cfg.name, "category", Number(json?.usage?.prompt_tokens ?? 0), Number(json?.usage?.completion_tokens ?? 0));
        return category;
      }
    } catch {
      /* try the next provider */
    }
  }
  return null;
}

// ── AI: "Why it matters" analysis follow-up ───────────────────────────────
// Generated after a breaking story publishes (see enqueueWhyItMatters in
// publish.ts). Returns a short factual explainer — context, consequences,
// what to watch next — using ONLY the supplied facts, so a thin wire alert
// cannot be inflated into invented analysis. Same provider chain as the
// final-dedup / category decisions (settings.ai_dedup_provider + fallbacks),
// so the operator's existing provider choice covers it with zero new infra.
// A null return means "no provider answered": the follow-up is simply skipped.
export async function generateWhyItMatters(
  input: { headline: string; summary: string; sourceText: string; category: string },
  providerSetting: string,
  deadline = Number.POSITIVE_INFINITY,
): Promise<{ title: string; text: string } | null> {
  const system =
    'You are a regional news analyst for a Middle East war-news channel. Given one breaking story, write a short "Why this matters" explainer for readers who already saw the headline. Rules: 3-5 plain-language sentences; give context and consequences the headline alone does not carry (who is affected, what it changes, what to watch next); strictly neutral and factual; use ONLY facts present in the supplied text — never add figures, locations, or actors; do not repeat the headline. Respond with ONLY JSON: {"title":"short significance headline, under 90 characters","text":"the explainer, 3-5 sentences"}.';
  const user = JSON.stringify({
    category: input.category,
    headline: input.headline.slice(0, 300),
    summary: input.summary.slice(0, 1500),
    source_text: input.sourceText.slice(0, 3000),
  });
  const order: Array<{ name: string; url: string; headers: Record<string, string>; model: string }> = [];
  const pushProvider = (name: string) => {
    if (name === "groq" && GROQ_API_KEY) {
      order.push({ name, url: "https://api.groq.com/openai/v1/chat/completions", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` }, model: "openai/gpt-oss-20b" });
    } else if (name === "openrouter" && OPENROUTER_API_KEY) {
      order.push({ name, url: "https://openrouter.ai/api/v1/chat/completions", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENROUTER_API_KEY}` }, model: "meta-llama/llama-3.3-70b-instruct" });
    } else if (name === "cloudflare" && CLOUDFLARE_API_TOKEN && CLOUDFLARE_ACCOUNT_ID) {
      order.push({ name, url: `https://api.cloudflare.com/client/v4/accounts/${enc(CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    }
  };
  if (providerSetting === "openrouter") {
    pushProvider("openrouter"); pushProvider("cloudflare"); pushProvider("groq");
  } else if (providerSetting === "cloudflare") {
    pushProvider("cloudflare"); pushProvider("openrouter"); pushProvider("groq");
  } else {
    pushProvider("groq"); pushProvider("openrouter"); pushProvider("cloudflare");
  }
  for (const cfg of order) {
    // Respect the publish cycle's deadline: stop starting new providers once
    // the budget is spent (each attempt is individually 20s-capped, so the
    // worst-case overshoot is a single timeout, not the full provider chain).
    if (Date.now() >= deadline) break;
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature: 0.2,
          max_tokens: 500,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      const content = json?.choices?.[0]?.message?.content ?? "";
      const raw = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const jsonObj = extractFirstJsonObject(raw);
      if (!jsonObj) continue;
      const parsed = JSON.parse(jsonObj) as { title?: string; text?: string };
      const title = String(parsed.title ?? "").trim();
      const text = String(parsed.text ?? "").trim();
      if (!text || text.length < 40) continue;
      recordAiUsage(cfg.name, "analysis", Number(json?.usage?.prompt_tokens ?? 0), Number(json?.usage?.completion_tokens ?? 0));
      return { title, text };
    } catch {
      /* try the next provider */
    }
  }
  return null;
}

