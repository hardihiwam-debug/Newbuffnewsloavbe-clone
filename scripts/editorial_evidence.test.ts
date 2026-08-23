// Regression tests for the two editorial safety guards used before publishing.
import { expect, test } from "bun:test";
import { isHeadlineOnlySource, isIncompleteHeadline, safeHeadlineFallback } from "../supabase/functions/pipeline/_shared.ts";

test("headline-only source detection fails closed for missing descriptions", () => {
  expect(isHeadlineOnlySource("Video shows school attack", null, "ABC News")).toBe(true);
  expect(isHeadlineOnlySource("Video shows school attack", "", "ABC News")).toBe(true);
});

test("headline-only source detection recognizes title and publisher boilerplate", () => {
  const title = "Video shows international outrage over deadly Iranian girls' school attack";
  expect(isHeadlineOnlySource(title, title, "ABC News")).toBe(true);
  expect(isHeadlineOnlySource(title, `${title} ABC News`, "ABC News")).toBe(true);
});

test("headline-only source detection keeps a real description eligible for rewrite", () => {
  expect(
    isHeadlineOnlySource(
      "Video shows international outrage over deadly Iranian girls' school attack",
      "The video was released after officials confirmed the school was hit in Iran. Emergency workers reported damage and families gathered outside the site.",
      "ABC News",
    ),
  ).toBe(false);
});

test("incomplete headline guard catches English and Sorani dangling connectors", () => {
  expect(isIncompleteHeadline("International outrage over the attack in")).toBe(true);
  expect(isIncompleteHeadline("هێرشەکە لە")).toBe(true);
  expect(isIncompleteHeadline("International outrage over the attack in Iran")).toBe(false);
  expect(isIncompleteHeadline("هێرشەکە لە ئێران")).toBe(false);
});

test("safe headline fallback removes only a dangling connector", () => {
  expect(safeHeadlineFallback("International outrage over the attack in")).toBe("International outrage over the attack");
  expect(safeHeadlineFallback("International outrage over the attack in Iran")).toBe("International outrage over the attack in Iran");
});
