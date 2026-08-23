export const AI_ACTIONS = [
  { id: "translation", label: "Translation", description: "Convert the final article into the target language." },
  { id: "rewrite", label: "Headline and summary rewrite", description: "Create the editorial headline and summary." },
  { id: "compression", label: "Summary compression", description: "Reduce an existing brief to a target character budget." },
  { id: "quality_judge", label: "Quality judge", description: "Check grounding, attribution, and headline/body value." },
  { id: "final_dedup", label: "Final duplicate check", description: "Decide whether a candidate repeats a published story." },
  { id: "category", label: "Category classification", description: "Assign the most specific supported category." },
  { id: "fact_extraction", label: "Fact extraction", description: "Extract only facts explicitly present in the source." },
] as const;

export type AiActionId = (typeof AI_ACTIONS)[number]["id"];

export const PROVIDER_CATALOG = [
  { slug: "groq", label: "Groq", kind: "openai_compatible", baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY", defaultModel: "openai/gpt-oss-20b" },
  { slug: "openrouter", label: "OpenRouter", kind: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY", defaultModel: "meta-llama/llama-3.3-70b-instruct" },
  { slug: "cloudflare", label: "Cloudflare Workers AI", kind: "cloudflare", baseUrl: "", envKey: "CLOUDFLARE_API_TOKEN", defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  { slug: "mistral", label: "Mistral", kind: "openai_compatible", baseUrl: "https://api.mistral.ai/v1", envKey: "MISTRAL_API_KEY", defaultModel: "mistral-small-latest" },
  { slug: "gemini", label: "Google Gemini", kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", envKey: "GEMINI_API_KEY_1", defaultModel: "gemini-2.5-flash" },
  { slug: "cerebras", label: "Cerebras", kind: "openai_compatible", baseUrl: "https://api.cerebras.ai/v1", envKey: "CEREBRAS_API_KEY", defaultModel: "llama-3.3-70b" },
  { slug: "openai", label: "OpenAI", kind: "openai_compatible", baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY", defaultModel: "gpt-4o-mini" },
  { slug: "minimax", label: "MiniMax", kind: "openai_compatible", baseUrl: "https://api.minimax.chat/v1", envKey: "MINIMAX_API_KEY", defaultModel: "MiniMax-M2" },
] as const;

export type ProviderRow = {
  id: string;
  slug: string;
  instance_key?: string | null;
  label: string;
  kind: string;
  base_url?: string | null;
  api_key?: string | null;
  api_key_env?: string | null;
  default_model?: string | null;
  enabled?: boolean | null;
  last_status?: string | null;
  last_error?: string | null;
  last_latency_ms?: number | null;
  last_tested_at?: string | null;
  cooldown_until?: string | null;
};

export type ActionRouteRow = {
  id: string;
  action: string;
  provider_id: string;
  position: number;
  enabled?: boolean | null;
  fallback_mode?: string | null;
};

export function providerCatalogEntry(slug: string) {
  return PROVIDER_CATALOG.find((provider) => provider.slug === slug) ?? null;
}

export function resolveProviderKey(provider: ProviderRow): string {
  if (String(provider.api_key ?? "").trim()) return String(provider.api_key).trim();
  const envKey = String(provider.api_key_env ?? providerCatalogEntry(provider.slug)?.envKey ?? "").trim();
  if (!envKey) return "";
  return Deno.env.get(envKey)?.trim() ?? "";
}

export function maskSecret(secret: string | null | undefined): string | null {
  const value = String(secret ?? "");
  if (!value) return null;
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

export function safeProvider(provider: ProviderRow): Record<string, unknown> {
  return {
    id: provider.id,
    slug: provider.slug,
    instanceKey: provider.instance_key ?? "default",
    label: provider.label,
    kind: provider.kind,
    baseUrl: provider.base_url ?? providerCatalogEntry(provider.slug)?.baseUrl ?? null,
    model: provider.default_model ?? providerCatalogEntry(provider.slug)?.defaultModel ?? null,
    enabled: provider.enabled !== false,
    keyConfigured: Boolean(resolveProviderKey(provider)),
    keySource: provider.api_key ? "stored" : provider.api_key_env ? "environment" : providerCatalogEntry(provider.slug)?.envKey ? "environment" : "missing",
    maskedKey: maskSecret(resolveProviderKey(provider)),
    lastStatus: provider.last_status ?? null,
    lastError: provider.last_error ?? null,
    lastLatencyMs: provider.last_latency_ms ?? null,
    lastTestedAt: provider.last_tested_at ?? null,
    cooldownUntil: provider.cooldown_until ?? null,
  };
}

export function statusCategory(status: number): string {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500) return "5xx";
  return "network";
}

export function actionPrompt(action: string, input: Record<string, unknown>): { system: string; user: string } {
  const source = String(input.body ?? input.text ?? "").slice(0, 12_000);
  const headline = String(input.headline ?? "").slice(0, 500);
  const targetLength = Math.max(40, Math.min(5000, Number(input.targetLength ?? 500) || 500));
  const common = "Use only the supplied source. Never invent facts, names, figures, places, dates, quotes, or attribution. Return only JSON.";
  switch (action) {
    case "translation":
      return { system: `${common} Translate the source into Kurdish Sorani. Return {\"text\":\"...\"}.`, user: JSON.stringify({ source, targetLanguage: input.targetLanguage ?? "Sorani" }) };
    case "compression":
      return { system: `${common} Compress the source to about ${targetLength} characters while preserving every concrete fact. Return {\"summary\":\"...\"}.`, user: JSON.stringify({ headline, source, targetLength }) };
    case "quality_judge":
      return { system: `${common} Judge whether the summary adds value beyond the headline and is grounded. Return {\"ok\":true|false,\"reason\":\"...\"}.`, user: JSON.stringify({ headline, summary: source, facts: input.facts ?? null }) };
    case "final_dedup":
      return { system: `${common} Decide whether candidate is the same event as any published item. Return {\"verdict\":\"duplicate\"|\"new\",\"reason\":\"...\"}.`, user: JSON.stringify({ candidate: source, published: input.published ?? [] }) };
    case "category":
      return { system: `${common} Choose one category from iran, oil, war, gold, usa, proxies, iraq, middle-east, analysis, economic-impact, gaza, syria, lebanon. Return {\"category\":\"...\"}.`, user: JSON.stringify({ source }) };
    case "fact_extraction":
      return { system: `${common} Extract explicit facts in source order. Return {\"facts\":[\"...\"]}.`, user: JSON.stringify({ source }) };
    case "connection":
      return { system: `${common} Confirm that you can answer this request. Return exactly {\"ok\":true}.`, user: JSON.stringify({ source }) };
    default:
      return { system: `${common} Write a concise newsroom headline and summary. Return {\"headline\":\"...\",\"summary\":\"...\"}.`, user: JSON.stringify({ headline, source, targetLength }) };
  }
}

export function parseProviderContent(value: string): Record<string, unknown> | null {
  const cleaned = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function validateActionResult(action: string, result: Record<string, unknown> | null): { ok: boolean; message: string } {
  if (!result) return { ok: false, message: "Provider returned no JSON object" };
  if (action === "translation" && !String(result.text ?? "").trim()) return { ok: false, message: "Translation result is empty" };
  if (action === "compression" && !String(result.summary ?? "").trim()) return { ok: false, message: "Compression result is empty" };
  if (action === "quality_judge" && typeof result.ok !== "boolean") return { ok: false, message: "Quality result has no boolean verdict" };
  if (action === "final_dedup" && result.verdict !== "duplicate" && result.verdict !== "new") return { ok: false, message: "Dedup result has no valid verdict" };
  if (action === "category" && !String(result.category ?? "").trim()) return { ok: false, message: "Category result is empty" };
  if (action === "fact_extraction" && !Array.isArray(result.facts)) return { ok: false, message: "Fact result has no facts array" };
  if (action === "connection" && typeof result.ok !== "boolean") return { ok: false, message: "Connection result has no boolean ok field" };
  if (action === "rewrite" && (!String(result.headline ?? "").trim() || !String(result.summary ?? "").trim())) return { ok: false, message: "Rewrite result needs headline and summary" };
  return { ok: true, message: "valid" };
}
