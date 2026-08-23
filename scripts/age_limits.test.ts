// Regression tests for operator-customizable age limits:
// - defaults preserve the original hardcoded values (14/22/48h + Telegram 6h)
// - ageLimitsFrom reads settings columns and falls back on invalid values
// - maxArticleAgeHours / realDateCheckOk honor custom limits

import { test, expect, describe } from "bun:test";

(globalThis as any).Deno = { env: { get: () => undefined } };

const { maxArticleAgeHours, realDateCheckOk, ageLimitsFrom, DEFAULT_AGE_LIMITS } = await import(
  "../supabase/functions/pipeline/_shared.ts"
) as any;

describe("ageLimitsFrom (settings → limits)", () => {
  test("null/undefined row → defaults", () => {
    expect(ageLimitsFrom(null)).toEqual(DEFAULT_AGE_LIMITS);
    expect(ageLimitsFrom(undefined)).toEqual(DEFAULT_AGE_LIMITS);
    expect(ageLimitsFrom({})).toEqual(DEFAULT_AGE_LIMITS);
  });

  test("settings columns override defaults", () => {
    const limits = ageLimitsFrom({ max_age_breaking_hours: 8, max_age_news_hours: 30, max_age_analysis_hours: 96 });
    expect(limits).toEqual({ breaking: 8, news: 30, analysis: 96 });
  });

  test("invalid values (0, negative, NaN) fall back to defaults", () => {
    const limits = ageLimitsFrom({ max_age_breaking_hours: 0, max_age_news_hours: -5, max_age_analysis_hours: "abc" });
    expect(limits).toEqual(DEFAULT_AGE_LIMITS);
  });
});

describe("maxArticleAgeHours with custom limits", () => {
  test("defaults preserve the original hardcoded values", () => {
    expect(maxArticleAgeHours("US missile strike hits Houthi position")).toBe(14);
    expect(maxArticleAgeHours("Analysis: what the ceasefire actually means")).toBe(48);
    expect(maxArticleAgeHours("Iraqi PM visits Tehran for talks")).toBe(22);
  });

  test("custom limits apply per story class", () => {
    const limits = { breaking: 8, news: 30, analysis: 96 };
    expect(maxArticleAgeHours("US missile strike hits Houthi position", limits)).toBe(8);
    expect(maxArticleAgeHours("Analysis: what the ceasefire actually means", limits)).toBe(96);
    expect(maxArticleAgeHours("Iraqi PM visits Tehran for talks", limits)).toBe(30);
  });
});

describe("realDateCheckOk with custom limits", () => {
  const NOW = Date.now();

  test("a 20h-old breaking story passes with default 14h? no — fails; passes with 24h limit", () => {
    const iso = new Date(NOW - 20 * 3_600_000).toISOString();
    const text = "Iran fires missiles at Tel Aviv";
    expect(realDateCheckOk(iso, text, NOW).ok).toBe(false); // default 14h
    expect(realDateCheckOk(iso, text, NOW, { ...DEFAULT_AGE_LIMITS, breaking: 24 }).ok).toBe(true);
  });

  test("unparseable date still passes with the effective maxAge reported", () => {
    const r = realDateCheckOk("not-a-date", "Iraqi PM visits Tehran", NOW, { ...DEFAULT_AGE_LIMITS, news: 40 });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.maxAge).toBe(40);
  });
});
