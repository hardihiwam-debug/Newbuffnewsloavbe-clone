// Regression tests for the two-stage rewrite (EXTRACT → COMPOSE):
// - the compose prompt stays grounded ("USING ONLY those facts", pinned
//   style-tone-only rule, per-item length directives)
// - groqExtractFacts runs extract then compose against a stubbed provider and
//   merges facts + brief correctly
// - when the compose stage fails, the brief degrades to the extracted
//   key_facts (still grounded) instead of raw invention or total loss
// - when the extract stage exhausts every provider, items fall back to null
//   (source-text fallback), matching the old single-stage failure path.
//
// Providers are injected via setRewriteProvidersForTest so the tests never
// depend on which env was visible when config.ts was first evaluated.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";

(globalThis as any).Deno = {
  env: { get: (k: string) => (k === "GROQ_API_KEY" ? "test-key" : undefined) },
};

const ai = await import("../supabase/functions/pipeline/ai.ts");

const GROQ_STUB = [{
  name: "groq",
  url: "https://api.groq.com/openai/v1/chat/completions",
  key: "test-key",
  model: "test-model",
}];

type FetchCall = { url: string; body: any };
let calls: FetchCall[] = [];
let providerResponses: any[] = [];
let providerStatuses: number[] = [];
const realFetch = globalThis.fetch;

function stubFetch(responses: any[], statuses: number[] = []) {
  calls = [];
  providerResponses = responses;
  providerStatuses = statuses;
  // deno-lint-ignore require-await
  globalThis.fetch = (async (url: any, init?: any) => {
    const urlStr = String(url);
    if (urlStr.includes("api.groq.com")) {
      const body = JSON.parse(init?.body ?? "{}");
      const callIndex = calls.length;
      calls.push({ url: urlStr, body });
      const status = providerStatuses[callIndex] ?? 200;
      if (status !== 200) return new Response("provider error", { status });
      const payload = providerResponses[callIndex]
        ?? providerResponses[providerResponses.length - 1];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // DB writes (rewrite_log / activity): best-effort, accept everything.
    return new Response("[]", { status: 201 });
  }) as typeof fetch;
}

const item = {
  title: "US sanctions three Iranian companies",
  description:
    "The US Treasury Department sanctioned three Iranian companies on Tuesday. " +
    "The department said the firms helped procure components for Iran's drone program. " +
    "The measures block the companies' US-based assets and generally prohibit Americans from doing business with them.",
};

describe("two-stage rewrite prompts", () => {
  test("compose prompt is grounded in extracted facts only", () => {
    const p = ai.composeSystemPrompt([item]);
    expect(p).toContain("USING ONLY those facts");
    expect(p).toContain("STYLE EXAMPLES ARE TONE-ONLY");
    expect(p).toContain("Length:");
    expect(p).toContain("Never end with ellipsis");
  });

  test("compose prompt carries the per-item style rule", () => {
    const p = ai.composeSystemPrompt([{ ...item, styleRule: "Be terse.", length: "brief" }]);
    expect(p).toContain("Be terse.");
  });
});

describe("groqExtractFacts two-stage flow", () => {
  beforeEach(() => {
    ai.setRewriteProvidersForTest(GROQ_STUB);
    // A previous test's 429 marks groq dead for the "cycle" (module-level
    // state) — start each test with fresh provider health.
    ai.resetRewriteProviderHealth();
    stubFetch([]);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("extract then compose merge into ExtractedFacts", async () => {
    stubFetch([
      // Stage A — extract
      {
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({
            "1": {
              event: "US sanctions",
              actor: "US Treasury Department",
              action: "sanctioned three Iranian companies",
              location: null,
              time: "Tuesday",
              claimed_result: null,
              confirmed_result: "assets blocked",
              source_attribution: "Treasury Department",
              confidence: "high",
              numbers: ["three"],
              key_facts: [
                "The US Treasury Department sanctioned three Iranian companies on Tuesday.",
                "The department said the firms helped procure components for Iran's drone program.",
                "The measures block the companies' US-based assets.",
              ],
            },
          }) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 80 },
      },
      // Stage B — compose
      {
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({
            "1": { headline: "US sanctions three Iranian companies over drone program", summary: "The US Treasury sanctioned three Iranian companies on Tuesday. The department said they procured drone components. The measures block their US-based assets." },
          }) },
        }],
        usage: { prompt_tokens: 90, completion_tokens: 60 },
      },
    ]);

    const res = await ai.groqExtractFacts([item], Date.now() + 30_000);
    expect(calls.length).toBe(3); // extract call + compose call + quality-judge call (#5)
    // The judge payload must carry facts + composed brief for scoring.
    const judgePayload = JSON.parse(calls[2]!.body.messages[1].content);
    const judgeUser = Array.isArray(judgePayload) ? judgePayload[0] : judgePayload;
    expect(judgeUser["1"].headline.length).toBeGreaterThan(0);
    expect(res.provider).toBe("groq");
    expect(res.items).toHaveLength(1);
    const first = res.items[0]!;
    expect(first.headline).toBe("US sanctions three Iranian companies over drone program");
    expect(first.summary.startsWith("The US Treasury sanctioned")).toBe(true);
    expect((first.facts.key_facts as string[]).length).toBe(3);
    expect(first.facts.actor).toBe("US Treasury Department");

    // The second call's user payload must carry ONLY extracted facts.
    // (Payloads are JSON arrays of single-key objects, as in the old flow.)
    const composePayload = JSON.parse(calls[1]!.body.messages[1].content);
    const composeUser = Array.isArray(composePayload) ? composePayload[0] : composePayload;
    expect(composeUser["1"].facts.numbers).toEqual(["three"]);
    expect(composeUser["1"].facts.key_facts.length).toBe(3);
  });

  test("compose failure degrades to key_facts brief (still grounded)", async () => {
    // Call 1 (extract) succeeds; call 2 (compose) hard-fails with 429 quota.
    stubFetch([
      {
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({
            "1": {
              actor: "Yemeni forces",
              key_facts: ["Yemeni forces destroyed an explosive boat in Bab al-Mandab.", "No casualties were reported."],
              numbers: [],
            },
          }) },
        }],
        usage: { prompt_tokens: 50, completion_tokens: 40 },
      },
    ], [200, 429]);

    const res = await ai.groqExtractFacts([item], Date.now() + 30_000);
    expect(calls.length).toBe(2);
    const first = res.items[0]!;
    expect(first.headline).toBe(item.title); // falls back to source title
    expect(first.summary).toBe(
      "Yemeni forces destroyed an explosive boat in Bab al-Mandab. No casualties were reported.",
    );
  });

  test("extract exhausted on all providers → null items (source-text fallback)", async () => {
    stubFetch([], [429]);
    const res = await ai.groqExtractFacts([item], Date.now() + 30_000);
    expect(calls.length).toBe(1); // one attempt, then the provider is marked dead
    expect(res.items[0]).toBeNull();
    expect(res.provider).toBeNull();
  });
});
