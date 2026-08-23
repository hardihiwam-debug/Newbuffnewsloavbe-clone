// Regression tests for summary-source routing:
//   Tier 1 extractive lede (keep source headline + verbatim first sentences)
//   Tier 3 single-call compression (prompt contract + fail-open)
//   Settings defaults are ON (operator can toggle either off)

import { test, expect, describe } from "bun:test";

(globalThis as any).Deno = { env: { get: () => undefined } };

const {
  extractiveLede,
  compressTargetChars,
  EXTRACTIVE_MIN_CHARS,
  EXTRACTIVE_MAX_CHARS,
} = await import("../supabase/functions/pipeline/_shared.ts");
const { COMPRESS_SYSTEM_PROMPT, compressArticle } = await import("../supabase/functions/pipeline/ai.ts");

describe("Tier 1: extractiveLede", () => {
  const body =
    "The US Treasury sanctioned three Iranian drone companies on Tuesday. The department said the firms helped procure components for unmanned aircraft. The sanctions block their US-based assets and any dealings with American citizens. Officials described the move as part of a broader pressure campaign. Additional designations are expected in the coming weeks according to one senior official familiar with the matter.";
  test("extracts the first two sentences verbatim", () => {
    const lede = extractiveLede(body)!;
    expect(lede).not.toBeNull();
    expect(lede.startsWith("The US Treasury sanctioned")).toBe(true);
    expect(lede).toContain("unmanned aircraft.");
    // verbatim — no rewording
    expect(body.includes(lede)).toBe(true);
  });
  test("falls back to one sentence when two exceed the budget", () => {
    const longSentences = `${"word ".repeat(115)}first very long sentence ends here. ${"A second sentence with plenty of additional context and detail follows here before it finally ends."}`;
    const lede = extractiveLede(longSentences)!;
    expect(lede.endsWith("ends here.")).toBe(true);
  });
  test("rejects too-short bodies (headline-only class)", () => {
    expect(extractiveLede("Title - Outlet Title - Outlet")).toBeNull();
  });
  test("rejects text without sentence boundaries", () => {
    expect(extractiveLede(`${"word ".repeat(150)}`)).toBeNull();
  });
  test("band constants match the approved tier design", () => {
    expect(EXTRACTIVE_MIN_CHARS).toBe(240);
    expect(EXTRACTIVE_MAX_CHARS).toBe(800);
  });
});

describe("Tier 3: compression", () => {
  test("target length follows the summary-length setting", () => {
    expect(compressTargetChars("brief")).toBe(350);
    expect(compressTargetChars("standard")).toBe(550);
    expect(compressTargetChars("long_form")).toBe(900);
    expect(compressTargetChars(undefined)).toBe(550);
  });
  test("prompt preserves original data and forbids additions", () => {
    expect(COMPRESS_SYSTEM_PROMPT).toContain("EVERY figure, name, place, date");
    expect(COMPRESS_SYSTEM_PROMPT).toContain("Never add any information not present");
    expect(COMPRESS_SYSTEM_PROMPT).toContain("Keep attribution verbs exactly");
  });
  test("fail-open: no providers configured returns null", async () => {
    const res = await compressArticle("t", "body text", 550, Date.now() + 1000);
    expect(res).toBeNull();
  });
});
