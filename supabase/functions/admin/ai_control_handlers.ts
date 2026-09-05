import {
  AI_ACTIONS,
  PROVIDER_CATALOG,
  actionPrompt,
  parseProviderContent,
  providerCatalogEntry,
  resolveProviderKey,
  safeProvider,
  statusCategory,
  validateActionResult,
  type ActionRouteRow,
  type ProviderRow,
} from "./ai_control.ts";

type Rest = (table: string, opts?: Record<string, unknown>) => Promise<any>;
type Activity = (entry: { type: string; level: string; message: string; detail?: string }) => Promise<void>;

type ProviderResponse = {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
  outputText: string;
  usage: { prompt: number; completion: number };
  error?: string;
};

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

async function providerById(rest: Rest, id: string): Promise<ProviderRow> {
  const rows = await rest("ai_providers", { query: `id=eq.${encodeURIComponent(id)}&limit=1` });
  const provider = (Array.isArray(rows) ? rows[0] : null) as ProviderRow | null;
  if (!provider) throw httpError(404, "AI provider not found");
  return provider;
}

async function requestProvider(provider: ProviderRow, action: string, input: Record<string, unknown>): Promise<ProviderResponse> {
  const key = resolveProviderKey(provider);
  if (!key) return { ok: false, status: 0, body: null, outputText: "", usage: { prompt: 0, completion: 0 }, error: "provider key is not configured" };

  const prompt = actionPrompt(action, input);
  const model = String(provider.default_model ?? providerCatalogEntry(provider.slug)?.defaultModel ?? "");
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  let url = String(provider.base_url ?? providerCatalogEntry(provider.slug)?.baseUrl ?? "").replace(/\/$/, "");
  let body: Record<string, unknown>;

  if (provider.kind === "cloudflare" || provider.slug === "cloudflare") {
    const account = Deno.env.get("CLOUDFLARE_ACCOUNT_ID") ?? "";
    if (!account) return { ok: false, status: 0, body: null, outputText: "", usage: { prompt: 0, completion: 0 }, error: "CLOUDFLARE_ACCOUNT_ID is not configured" };
    url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/v1/chat/completions`;
    body = { model, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], max_tokens: 1400, temperature: 0.1 };
  } else if (provider.kind === "gemini" || provider.slug === "gemini") {
    url = `${url}/models/${encodeURIComponent(model.replace(/^google\//, ""))}:generateContent`;
    delete headers.Authorization;
    headers["x-goog-api-key"] = key;
    body = { contents: [{ role: "user", parts: [{ text: `${prompt.system}\n${prompt.user}` }] }], generationConfig: { maxOutputTokens: 1400, temperature: 0.1 } };
  } else {
    url = `${url}/chat/completions`;
    body = { model, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], max_tokens: 1400, temperature: 0.1, response_format: { type: "json_object" } };
  }

  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = { raw }; }
    const choices = Array.isArray(parsed.choices) ? parsed.choices as Array<Record<string, unknown>> : [];
    const content = provider.kind === "gemini" || provider.slug === "gemini"
      ? String((((parsed.candidates as Array<Record<string, unknown>> | undefined)?.[0]?.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined)?.[0]?.text ?? "")
      : String(((choices[0]?.message as Record<string, unknown> | undefined)?.content ?? ""));
    const usage = (parsed.usage ?? {}) as Record<string, unknown>;
    return {
      ok: response.ok,
      status: response.status,
      body: parseProviderContent(content),
      outputText: content,
      usage: { prompt: Number(usage.prompt_tokens ?? usage.promptTokenCount ?? 0), completion: Number(usage.completion_tokens ?? usage.candidatesTokenCount ?? 0) },
      error: response.ok ? undefined : String(((parsed.error as Record<string, unknown> | undefined)?.message ?? raw.slice(0, 300))),
    };
  } catch (error) {
    return { ok: false, status: 0, body: null, outputText: "", usage: { prompt: 0, completion: 0 }, error: error instanceof Error ? error.message : String(error) };
  }
}

export function createAiControlHandlers(rest: Rest, logActivity: Activity): Record<string, (p: any) => Promise<unknown>> {
  const recordAttempt = async (entry: Record<string, unknown>) => {
    await rest("ai_attempt_log", { method: "POST", body: entry, prefer: "return=minimal" }).catch(() => {});
  };

  const listAiControlPlane = async (): Promise<Record<string, unknown>> => {
    const [providersRaw, routesRaw, attemptsRaw] = await Promise.all([
      rest("ai_providers", { query: "order=label.asc&limit=100" }).catch(() => []),
      rest("ai_action_routes", { query: "order=action.asc,position.asc&limit=500" }).catch(() => []),
      rest("ai_attempt_log", { query: "order=created_at.desc&limit=100" }).catch(() => []),
    ]);
    const providers = (Array.isArray(providersRaw) ? providersRaw : []).map((row) => safeProvider(row as ProviderRow));
    const providerById = new Map(providers.map((provider) => [String(provider.id), provider]));
    const routes = (Array.isArray(routesRaw) ? routesRaw : []).map((row) => {
      const route = row as ActionRouteRow;
      return {
        id: route.id,
        action: route.action,
        providerId: route.provider_id,
        position: Number(route.position ?? 0),
        enabled: route.enabled !== false,
        fallbackMode: route.fallback_mode ?? "continue",
        provider: providerById.get(String(route.provider_id)) ?? null,
      };
    });
    return { actions: AI_ACTIONS, catalog: PROVIDER_CATALOG, providers, routes, attempts: Array.isArray(attemptsRaw) ? attemptsRaw.map((row) => row) : [] };
  };

  const saveAiProvider = async (p: { id?: string; slug?: string; label?: string; instanceKey?: string; apiKey?: string | null; apiKeyEnv?: string | null; baseUrl?: string | null; model?: string | null; enabled?: boolean; deleteStoredKey?: boolean }) => {
    const slug = String(p.slug ?? "").trim().toLowerCase();
    const catalog = providerCatalogEntry(slug);
    if (!slug || !catalog) throw httpError(400, `Unsupported provider "${slug}"`);
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      slug,
      instance_key: String(p.instanceKey ?? "default").trim() || "default",
      label: String(p.label ?? catalog.label).trim() || catalog.label,
      kind: catalog.kind,
      base_url: p.baseUrl === undefined ? catalog.baseUrl || null : p.baseUrl || null,
      default_model: p.model === undefined ? catalog.defaultModel : String(p.model ?? "").trim() || catalog.defaultModel,
      api_key_env: p.apiKeyEnv === undefined ? catalog.envKey : (p.apiKeyEnv || null),
      enabled: p.enabled !== false,
      updated_at: now,
    };
    if (p.deleteStoredKey) patch.api_key = null;
    else if (p.apiKey !== undefined && p.apiKey !== null && String(p.apiKey).trim()) patch.api_key = String(p.apiKey).trim();
    if (p.id) await rest(`ai_providers?id=eq.${encodeURIComponent(p.id)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
    else await rest("ai_providers", { method: "POST", body: { ...patch, created_at: now }, prefer: "return=minimal" });
    await logActivity({ type: "ai", level: "info", message: `AI provider ${p.id ? "updated" : "added"}: ${catalog.label}`, detail: p.deleteStoredKey ? "stored key deleted" : undefined });
    return { ok: true };
  };

  const deleteAiProvider = async (p: { id: string }) => {
    if (!p.id) throw httpError(400, "provider id is required");
    await rest(`ai_providers?id=eq.${encodeURIComponent(p.id)}`, { method: "DELETE", prefer: "return=minimal" });
    await logActivity({ type: "ai", level: "warning", message: "AI provider deleted globally", detail: p.id });
    return { ok: true, id: p.id };
  };

  const saveAiActionRoutes = async (p: { action: string; providerIds?: string[]; routes?: Array<{ providerId: string; enabled?: boolean }> }) => {
    const action = String(p.action ?? "").trim();
    if (!AI_ACTIONS.some((item) => item.id === action)) throw httpError(400, `Unsupported AI action "${action}"`);
    const routeInputs = Array.isArray(p.routes)
      ? p.routes.map((route) => ({ providerId: String(route.providerId), enabled: route.enabled !== false })).filter((route) => route.providerId)
      : (Array.isArray(p.providerIds) ? p.providerIds.map((providerId) => ({ providerId: String(providerId), enabled: true })) : []);
    const seen = new Set<string>();
    const routes = routeInputs.filter((route) => !seen.has(route.providerId) && seen.add(route.providerId));
    for (const route of routes) await providerById(rest, route.providerId);
    await rest(`ai_action_routes?action=eq.${encodeURIComponent(action)}`, { method: "DELETE", prefer: "return=minimal" });
    for (let i = 0; i < routes.length; i++) await rest("ai_action_routes", { method: "POST", body: { action, provider_id: routes[i]!.providerId, position: i, enabled: routes[i]!.enabled, fallback_mode: "continue" }, prefer: "return=minimal" });
    await logActivity({ type: "ai", level: "info", message: `AI route updated: ${action}`, detail: routes.map((route) => `${route.providerId}:${route.enabled ? "on" : "off"}`).join(" → ") || "disabled" });
    return { ok: true, action, providerIds: routes.map((route) => route.providerId) };
  };

  const testAiProviderConnection = async (p: { providerId: string }) => {
    const provider = await providerById(rest, p.providerId);
    const input = { body: "Return a JSON object with an ok boolean." };
    const started = Date.now();
    const result = await requestProvider(provider, "connection", input);
    const validation = result.ok ? validateActionResult("connection", result.body) : { ok: false, message: result.error ?? `HTTP ${result.status}` };
    const success = result.ok && validation.ok;
    const latency = Date.now() - started;
    const message = result.error ?? validation.message;
    await recordAttempt({ action: "connection", provider: provider.slug, model: provider.default_model, attempt_number: 1, success, fallback_used: false, latency_ms: latency, input_chars: JSON.stringify(input).length, output_chars: result.outputText.length, prompt_tokens: result.usage.prompt, completion_tokens: result.usage.completion, http_status: result.status || null, http_status_category: statusCategory(result.status), validation_result: validation.message, failure_reason: success ? null : message, final_decision: success ? "usable" : "unusable", test_mode: true });    await rest(`ai_providers?id=eq.${encodeURIComponent(provider.id)}`, { method: "PATCH", body: { last_status: result.ok ? "ok" : "failed", last_error: result.ok ? null : message.slice(0, 500), last_latency_ms: latency, last_tested_at: new Date().toISOString(), updated_at: new Date().toISOString() }, prefer: "return=minimal" }).catch(() => {});
    return { ok: success, provider: safeProvider(provider), latencyMs: latency, status: result.status || null, detail: success ? "connection accepted" : message };
  };

  const testAiAction = async (p: { aiAction?: string; action?: string; providerIds?: string[]; input?: Record<string, unknown> }) => {
    // `aiAction` is the wire name: the dispatcher reads the outer `action`
    // field to pick the handler, so an inner `action` key would collide and
    // the request would 404 ("unknown action \"translation\""). The old
    // inner `action` name is still accepted for backward compatibility.
    const action = String(p.aiAction ?? p.action ?? "").trim();
    if (!AI_ACTIONS.some((item) => item.id === action)) throw httpError(400, `Unsupported AI action "${action}"`);
    const routeRows = await rest(`ai_action_routes`, { query: `action=eq.${encodeURIComponent(action)}&enabled=eq.true&order=position.asc&limit=100` }).catch(() => []);
    const providerIds = Array.isArray(p.providerIds) && p.providerIds.length > 0 ? p.providerIds : (routeRows as ActionRouteRow[]).map((row) => String(row.provider_id));
    if (providerIds.length === 0) throw httpError(400, "No providers selected for this action");
    const results: Array<Record<string, unknown>> = [];
    let finalDecision = "no_provider_succeeded";
    for (let i = 0; i < providerIds.length; i++) {
      const provider = await providerById(rest, providerIds[i]!);
      const started = Date.now();
      const result = await requestProvider(provider, action, p.input ?? {});
      const validation = result.ok ? validateActionResult(action, result.body) : { ok: false, message: result.error ?? `HTTP ${result.status}` };
      const success = result.ok && validation.ok;
      const latency = Date.now() - started;
      await recordAttempt({ action, provider: provider.slug, model: provider.default_model, attempt_number: i + 1, success, fallback_used: i > 0, latency_ms: latency, input_chars: JSON.stringify(p.input ?? {}).length, output_chars: result.outputText.length, prompt_tokens: result.usage.prompt, completion_tokens: result.usage.completion, http_status: result.status || null, http_status_category: statusCategory(result.status), validation_result: validation.message, failure_reason: success ? null : validation.message, final_decision: success ? "passed" : "fallback", test_mode: true, scenario: p.input ?? {} });
      results.push({ provider: safeProvider(provider), model: provider.default_model, success, latencyMs: latency, status: result.status || null, validation: validation.message, output: success ? result.body : null, error: success ? null : validation.message });
      if (success) { finalDecision = "passed"; break; }
    }
    return { action, testMode: true, finalDecision, attempts: results };
  };

  const listAiAttempts = async (p: { action?: string; limit?: number }) => {
    const limit = Math.max(1, Math.min(500, Number(p.limit ?? 100) || 100));
    const filter = p.action ? `&action=eq.${encodeURIComponent(p.action)}` : "";
    const rows = await rest("ai_attempt_log", { query: `order=created_at.desc&limit=${limit}${filter}` });
    return { entries: Array.isArray(rows) ? rows : [] };
  };

  return { listAiControlPlane, saveAiProvider, deleteAiProvider, saveAiActionRoutes, testAiProviderConnection, testAiAction, listAiAttempts };
}
