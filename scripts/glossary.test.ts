// Regression tests for buildGlossaryBlock — the lean-glossary filter that
// only sends glossary terms actually occurring in the source text, so a large
// glossary isn't re-sent verbatim on every translation call. Imports the REAL
// function from the pipeline shared module.

import { test, expect } from "bun:test";
import { buildGlossaryBlock, translationCacheKey } from "../supabase/functions/pipeline/_shared.ts";

const GLOSSARY = [
  "Strait of Hormuz = تەنگی هورمز",
  "IRGC = سوپای پاسداران",
  "CENTCOM = سێنتکام",
  "Houthi = حووسییەکان",
  "oil tanker = نەوتبەری",
].join("\n");

test("keeps only terms that appear in the source text", () => {
  const block = buildGlossaryBlock(GLOSSARY, "IRGC struck a tanker near the Strait of Hormuz.");
  expect(block).toContain("IRGC = سوپای پاسداران");
  expect(block).toContain("Strait of Hormuz = تەنگی هورمز");
  expect(block).not.toContain("CENTCOM");
  expect(block).not.toContain("Houthi");
  expect(block).not.toContain("oil tanker");
});

test("term matching is case-insensitive", () => {
  const block = buildGlossaryBlock(GLOSSARY, "the irgc fired a missile");
  expect(block).toContain("IRGC = سوپای پاسداران");
  expect(block).not.toContain("Strait of Hormuz");
});

test("partial-word term still matches (term embedded in a longer word)", () => {
  const block = buildGlossaryBlock(GLOSSARY, "Houthi-controlled territory");
  expect(block).toContain("Houthi = حووسییەکان");
});

test("no matching terms → no glossary section at all", () => {
  expect(buildGlossaryBlock(GLOSSARY, "Unrelated news about weather.")).toBe("");
});

test("empty / undefined glossary → empty block", () => {
  expect(buildGlossaryBlock(undefined, "any text")).toBe("");
  expect(buildGlossaryBlock("", "any text")).toBe("");
  expect(buildGlossaryBlock("   \n  ", "any text")).toBe("");
});

test("lines without a separator are matched by their whole text", () => {
  const block = buildGlossaryBlock("CENTCOM\nIRGC = سوپای پاسداران", "CENTCOM confirmed");
  expect(block).toContain("CENTCOM");
  expect(block).not.toContain("IRGC");
});

test("a wrapped line (no separator) continues the previous entry instead of breaking it", () => {
  // A long translation that spilled onto a second line must stay ONE entry:
  // the old parser treated the second line as a standalone fragment whose
  // "term" never matches the source, silently dropping the whole glossary
  // line from the prompt.
  const glossary = [
    "IRGC = سوپای پاسداران",
    "وەک بەشێک لە هێزە چەکدارەکانی ئێران",
    "CENTCOM = سێنتکام",
  ].join("\n");
  const block = buildGlossaryBlock(glossary, "The IRGC fired a missile.");
  // The full merged entry ships — both lines — not the fragment alone.
  expect(block).toContain("IRGC = سوپای پاسداران وەک بەشێک لە هێزە چەکدارەکانی ئێران");
  // The fragment must not ship as its own line.
  expect(block).not.toContain("\nوەک بەشێک لە هێزە چەکدارەکانی ئێران");
  expect(block).not.toContain("CENTCOM");
});

test("a wrapped entry is still dropped entirely when its term never appears", () => {
  const glossary = ["CENTCOM = سێنتکام", "وەک فەرماندەیی سەربازی"] .join("\n");
  expect(buildGlossaryBlock(glossary, "The IRGC fired a missile.")).toBe("");
});

test("continuation lines may wrap multiple times and keep entry order", () => {
  const glossary = [
    "Strait of Hormuz = تەنگی هورمز",
    "لە نێوان ئێران و عومان",
    "IRGC = سوپای پاسداران",
    "وەک بەشێک لە هێزەکانی ئێران",
    "لە ڕۆژهەڵاتی ناوەڕاست",
  ].join("\n");
  const block = buildGlossaryBlock(glossary, "Ships crossed the Strait of Hormuz as IRGC patrols watched.");
  const lines = block.split("\n").filter((l) => l.includes("="));
  // Both entries ship, fully merged, in original order.
  expect(lines[0]).toBe("Strait of Hormuz = تەنگی هورمز لە نێوان ئێران و عومان");
  expect(lines[1]).toBe("IRGC = سوپای پاسداران وەک بەشێک لە هێزەکانی ئێران لە ڕۆژهەڵاتی ناوەڕاست");
});

test("term-only first line followed by a real entry keeps both working", () => {
  const glossary = ["CENTCOM", "IRGC = سوپای پاسداران"].join("\n");
  const block = buildGlossaryBlock(glossary, "CENTCOM and the IRGC met");
  expect(block).toContain("CENTCOM");
  expect(block).toContain("IRGC = سوپای پاسداران");
});

test("only matched lines are included, preserving original order", () => {
  const block = buildGlossaryBlock(
    ["IRGC = سوپای پاسداران", "CENTCOM = سێنتکام", "Houthi = حووسییەکان"].join("\n"),
    "CENTCOM and Houthi met",
  );
  const lines = block.split("\n").filter((l) => l.includes("="));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("CENTCOM");
  expect(lines[1]).toContain("Houthi");
});

// ── Glossary-aware translation cache key ────────────────────────────────────
// The glossary must be part of the cache key: otherwise an operator editing a
// term keeps receiving the OLD cached Sorani for text already translated,
// and the glossary change never reaches the channel.
test("translationCacheKey: empty glossary keeps the legacy raw-input key", () => {
  expect(translationCacheKey("IRGC fired", undefined)).toBe("IRGC fired");
  expect(translationCacheKey("IRGC fired", "")).toBe("IRGC fired");
  expect(translationCacheKey("IRGC fired", "   \n ")).toBe("IRGC fired");
});

test("translationCacheKey: a glossary change produces a different key for the same text", () => {
  const a = translationCacheKey("IRGC fired", "IRGC = سوپای پاسداران");
  const b = translationCacheKey("IRGC fired", "IRGC = سپای پاسداران");
  expect(a).not.toBe(b);
  // Both differ from the no-glossary legacy key too.
  expect(a).not.toBe("IRGC fired");
});

test("translationCacheKey: whitespace-only glossary differences are normalized away", () => {
  expect(translationCacheKey("x", "IRGC = سوپای پاسداران")).toBe(
    translationCacheKey("x", "  IRGC = سوپای پاسداران  "),
  );
});
