// Regression tests for the fragment guards (thin editorial sources):
// - a rewritten English headline that lost its subject starts with a
//   lowercase verb ("challenges Trump claim on Iran's nuclear status") and
//   must be treated as incomplete → dropped by the existing headline guard
// - a rewritten summary that opens mid-sentence ("that Donald Trump faces…")
//   must be repaired from the source body, or dropped when no body exists.

import { test, expect, describe } from "bun:test";

(globalThis as any).Deno = { env: { get: () => undefined } };

const { isIncompleteHeadline, polishRewriteSummary } = await import(
  "../supabase/functions/pipeline/_shared.ts"
) as any;

const BODY =
  "PBS published a report examining the president's position on Tehran. " +
  "The report says the enriched uranium stockpile documented by the IAEA undercuts claims of full denuclearization. " +
  "It adds that negotiations have not resolved the stockpile question.";

describe("isIncompleteHeadline — lowercase-subject fragments", () => {
  test("lowercase-opening headline is incomplete (missing subject)", () => {
    expect(isIncompleteHeadline("challenges Trump claim on Iran's nuclear status")).toBe(true);
    expect(isIncompleteHeadline("warns of retaliation after strike")).toBe(true);
  });

  test("normal headlines still pass", () => {
    expect(isIncompleteHeadline("PBS report challenges Trump claim on Iran's nuclear status")).toBe(false);
    expect(isIncompleteHeadline("3 missiles hit base near Hormuz")).toBe(false);
    expect(isIncompleteHeadline("\"We will respond,\" Iran says after strikes")).toBe(false);
    expect(isIncompleteHeadline("UPDATE — Qatar allows Iranian team to meet captured pilots")).toBe(false);
  });

  test("lowercase brand names and Arabic article prefixes are NOT fragments", () => {
    expect(isIncompleteHeadline("al-Qaeda affiliate claims attack on base")).toBe(false);
    expect(isIncompleteHeadline("al Jazeera: ceasefire talks resume in Doha")).toBe(false);
    expect(isIncompleteHeadline("i24NEWS exclusive: Mossad ops expand")).toBe(false);
    expect(isIncompleteHeadline("iPhone sales fund Israeli surveillance tech")).toBe(false);
    expect(isIncompleteHeadline("eBay blocks auction of Iranian artifacts")).toBe(false);
  });
});

describe("polishRewriteSummary — mid-sentence summary fragments", () => {
  test("lowercase-opening summary with no source body → dropped", () => {
    const r = polishRewriteSummary(
      "that Donald Trump faces challenges in determining his stance on Iran ahead of elections.",
      "Trump's Iran stance ahead of elections",
      null,
    );
    expect(r).toBeNull();
  });

  test("lowercase-opening summary with a real source body → repaired from the lede", () => {
    const r = polishRewriteSummary(
      "that Donald Trump faces challenges in determining his stance on Iran ahead of elections.",
      "Trump's Iran stance ahead of elections",
      BODY,
    );
    expect(r).not.toBeNull();
    // Repaired brief comes from the source's first sentences.
    expect(r!.startsWith("PBS")).toBe(true);
  });

  test("good summaries pass through untouched", () => {
    const good = "The US Treasury sanctioned three Iranian companies over their role in the drone program.";
    expect(polishRewriteSummary(good, "US sanctions three Iranian companies", null)).toBe(good);
  });
});
