// Regression tests for the six rewrite/summary upgrades approved together:
//   #1 passive-attribution ban pinned in the compose prompt
//   #2 fuseHeadlineTexts (cross-source headline fusion)
//   #3 composeUpdateDelta prompt + fail-open contract
//   #4 solo chunks for breaking items in chunkRewriteItems
//   #5 applyQualityVerdicts (semantic judge application)
//   #6 splitLongText + mergeLongFacts (long-body map-reduce)

import { test, expect, describe } from "bun:test";

(globalThis as any).Deno = { env: { get: () => undefined } };

const shared = await import("../supabase/functions/pipeline/_shared.ts");
const {
  chunkRewriteItems,
  composeSystemPrompt,
  applyQualityVerdicts,
  splitLongText,
  mergeLongFacts,
  LONG_BODY_CHARS,
  UPDATE_DELTA_PROMPT,
} = await import("../supabase/functions/pipeline/ai.ts");
const { fuseHeadlineTexts } = shared;

describe("#1 compose prompt attribution rule", () => {
  const prompt = composeSystemPrompt([{ title: "t", description: null }]);
  test("bans passive/unnamed attribution", () => {
    expect(prompt).toContain("never use passive or unnamed attribution");
    expect(prompt).toContain('"a claim was made"');
  });
});

describe("#2 fuseHeadlineTexts", () => {
  test("fuses sibling titles into a body long enough to extract", () => {
    const fused = fuseHeadlineTexts("US sanctions Iranian drone firms", [
      { title: "Treasury blacklists three Tehran companies over drone program", description: "The Treasury Department said the firms helped procure components for unmanned aircraft." },
      { title: "Washington expands restrictions on Iranian aviation entities", description: null },
    ]);
    expect(fused).not.toBeNull();
    expect(fused!.includes("Treasury")).toBe(true);
    expect(fused!.includes("blacklists")).toBe(true);
  });
  test("returns null when siblings add too little text", () => {
    expect(fuseHeadlineTexts("Short title", [{ title: "Another short one", description: null }])).toBeNull();
    expect(fuseHeadlineTexts("Short title", [])).toBeNull();
  });
});

describe("#4 chunkRewriteItems solo handling", () => {
  const item = (t: string, solo?: boolean) => ({ title: t, description: "x".repeat(50), ...(solo ? { solo: true } : {}) });
  test("a solo item between normal items becomes its own chunk", () => {
    const chunks = chunkRewriteItems([item("a"), item("BREAKING", true), item("c")]);
    expect(chunks.length).toBe(3);
    expect(chunks[1]!.length).toBe(1);
    expect(chunks[1]![0]!.title).toBe("BREAKING");
  });
  test("a leading solo item still merges forward correctly", () => {
    const chunks = chunkRewriteItems([item("BREAKING", true), item("b"), item("c")]);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(1);
  });
  test("normal batching unchanged without solo flags", () => {
    const chunks = chunkRewriteItems([item("a"), item("b"), item("c")]);
    expect(chunks.length).toBe(1);
  });
});

describe("#5 applyQualityVerdicts", () => {
  test("rebuilds a failing brief from its own key_facts", () => {
    const results = [{ headline: "H1", summary: "echo of H1" }];
    const kf = [["The Treasury named three firms on Tuesday.", "The firms procured drone components."]];
    applyQualityVerdicts(results, kf, { "1": { ok: false, reason: "adds nothing" } });
    expect(results[0]!.summary).toContain("Tuesday");
  });
  test("empties a failing brief with no key_facts so guards drop it", () => {
    const results = [{ headline: "H1", summary: "bad" }];
    applyQualityVerdicts(results, [[]], { "1": { ok: false } });
    expect(results[0]!.summary).toBe("");
  });
  test("passing verdicts and null verdict objects change nothing", () => {
    const results = [{ headline: "H", summary: "good summary with detail" }];
    applyQualityVerdicts(results, [[ "fact" ]], { "1": { ok: true } });
    applyQualityVerdicts(results, [[ "fact" ]], null);
    expect(results[0]!.summary).toBe("good summary with detail");
  });
});

describe("#6 splitLongText + mergeLongFacts", () => {
  test("returns null for short text and splits long text at sentence boundary", () => {
    expect(splitLongText("short")).toBeNull();
    const long = Array.from({ length: 140 }, (_, i) => `Sentence number ${i} adds some detail to the record here.`).join(" ");
    expect(long.length).toBeGreaterThan(LONG_BODY_CHARS);
    const halves = splitLongText(long)!;
    expect(halves[0]!.length).toBeGreaterThan(200);
    expect(halves[1]!.length).toBeGreaterThan(200);
    // sentence integrity: halves end on punctuation
    expect(halves[0]!.trim().endsWith(".")).toBe(true);
    // no content lost: re-joined length close to original
    expect(halves[0]!.length + halves[1]!.length).toBeGreaterThan(long.length * 0.9);
  });
  test("mergeLongFacts prefers part1 scalars and concats lists deduped", () => {
    const merged = mergeLongFacts(
      { actor: "A1", time: "t1", key_facts: ["fact one", "fact two"], numbers: ["18 killed"] },
      { actor: "A2", time: "t2", key_facts: ["FACT TWO", "fact three"], numbers: ["18 killed", "$1.4 billion"] },
    );
    expect(merged.actor).toBe("A1");
    expect(merged.time).toBe("t1");
    expect(merged.key_facts).toEqual(["fact one", "fact two", "fact three"]);
    expect(merged.numbers).toEqual(["18 killed", "$1.4 billion"]);
  });
  test("mergeLongFacts tolerates missing parts", () => {
    const merged = mergeLongFacts(null, { key_facts: ["only part2"] });
    expect(merged.key_facts).toEqual(["only part2"]);
    expect(merged.actor).toBeNull();
  });
});

describe("#3 update-delta prompt contract", () => {
  test("requires what-is-new opening and named attribution", () => {
    expect(UPDATE_DELTA_PROMPT).toContain("ONLY what is new");
    expect(UPDATE_DELTA_PROMPT).toContain("Never use passive attribution");
  });
});
