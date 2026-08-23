// Regression tests for the title/body echo fix (A + B):
// - compose prompt must instruct summaries to open with what the headline
//   does NOT say (kills the contradiction that produced random echoes)
// - summaryOpensAsEcho catches PARAPHRASED headline echoes that a verbatim
//   token check misses ("asks if" -> "asks whether", "US" -> "United States")
// - polishRewriteSummary repairs an echoed opening from a real article body,
//   and drops the item when nothing beyond the headline exists.

import { test, expect, describe } from "bun:test";

(globalThis as any).Deno = { env: { get: () => undefined } };

const { summaryOpensAsEcho, polishRewriteSummary } = await import("../supabase/functions/pipeline/_shared.ts");
const { composeSystemPrompt } = await import("../supabase/functions/pipeline/ai.ts");

describe("compose prompt anti-echo rule (A)", () => {
  const prompt = composeSystemPrompt([{ title: "t", description: null }]);
  test("forbids restating the headline in the first sentence", () => {
    expect(prompt).toContain("FIRST sentence must NOT restate the headline");
  });
  test("directs the opening toward what the headline lacks", () => {
    expect(prompt).toContain("open with what the headline does not say");
  });
  test("keeps the facts-only grounding rule", () => {
    expect(prompt).toContain("DOES NOT EXIST");
  });
});

describe("summaryOpensAsEcho (B detector)", () => {
  const H = "EnergyNow asks if US and Iran can bridge differences in talks";
  test("catches a paraphrased echo", () => {
    const s = "EnergyNow asks whether the United States and Iran can bridge their differences during ongoing talks.";
    expect(summaryOpensAsEcho(H, s)).toBe(true);
  });
  test("passes a first sentence with real added detail", () => {
    const s = "Talks in Geneva entered their second day on Tuesday, with mediators proposing a phased prisoner exchange alongside the nuclear track.";
    expect(summaryOpensAsEcho(H, s)).toBe(false);
  });
  test("later sentences may repeat the headline — only the opening counts", () => {
    const s = "Negotiators tabled a two-week truce draft late Monday. The question of whether the US and Iran can bridge differences remains open.";
    expect(summaryOpensAsEcho(H, s)).toBe(false);
  });
  test("short/vague headlines never trip it", () => {
    expect(summaryOpensAsEcho("Markets wobble", "Markets wobbled again on Tuesday amid thin trading.")).toBe(false);
  });
  test("Sorani text is handled without crashing (returns false on non-Latin mismatch)", () => {
    expect(summaryOpensAsEcho("ئێران هەڕەشە دەکات", "لە پەیوەندییەکی تەلەفۆنیدا وەزیری دەرەوە وتاری کرد")).toBe(false);
  });
});

describe("polishRewriteSummary echo handling (B enforcement)", () => {
  const H = "EnergyNow asks if US and Iran can bridge differences in talks";
  const ECHO = "EnergyNow asks whether the United States and Iran can bridge their differences during ongoing talks.";
  test("repairs an echoed opening when a real article body exists", () => {
    const body = "Mediators tabled a two-week truce draft late Monday in Geneva, according to officials briefed on the talks. A second round is expected before the end of the month.";
    const out = polishRewriteSummary(ECHO, H, body);
    expect(out).not.toBeNull();
    expect(out!.startsWith("Mediators")).toBe(true);
  });
  test("drops the item when nothing exists beyond the headline", () => {
    expect(polishRewriteSummary(ECHO, H, ECHO)).toBeNull();
    expect(polishRewriteSummary(ECHO, H, "short snippet")).toBeNull();
    expect(polishRewriteSummary(ECHO, H, null)).toBeNull();
  });
  test("leaves good summaries untouched", () => {
    const s = "Negotiators tabled a two-week truce draft late Monday, according to officials briefed on the talks.";
    expect(polishRewriteSummary(s, H, s)).toBe(s);
  });
});
