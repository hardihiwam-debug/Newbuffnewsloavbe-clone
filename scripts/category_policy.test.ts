// Tests for the category policy system: per-category status, priority scoring,
// keyword matching, freshness, and daily caps. Imports REAL implementations.

import { test, expect } from "bun:test";
import {
  getCategoryPolicies,
  getCategoryPolicy,
  categoryScore,
  categoryFreshnessHours,
  categoryKeywordMatch,
  categoryAtDailyCap,
  pickKeywordTriggeredCategory,
  CATEGORY_PRIORITY,
} from "../supabase/functions/pipeline/_shared.ts";

// ── getCategoryPolicies / getCategoryPolicy ──────────────────────────────────

test("getCategoryPolicies returns empty object for null/undefined/invalid", () => {
  expect(getCategoryPolicies(null)).toEqual({});
  expect(getCategoryPolicies(undefined)).toEqual({});
  expect(getCategoryPolicies("bad")).toEqual({});
  expect(getCategoryPolicies(42)).toEqual({});
});

test("getCategoryPolicy returns safe defaults for missing category", () => {
  const p = getCategoryPolicy({}, "war");
  expect(p.status).toBe("enabled");
  expect(p.priority).toBe("normal");
  expect(p.scoreOverride).toBe(0);
  expect(p.freshnessHours).toBe(0);
  expect(p.maxPostsPerDay).toBe(0);
  expect(p.keywords).toEqual([]);
  expect(p.excludedKeywords).toEqual([]);
  expect(p.hashtagsEnabled).toBe(true);
  expect(p.maxHashtags).toBe(0);
});

test("getCategoryPolicy reads partial entries with defaults for missing fields", () => {
  const policies = { war: { status: "disabled", priority: "very_high" as const } };
  const p = getCategoryPolicy(policies, "war");
  expect(p.status).toBe("disabled");
  expect(p.priority).toBe("very_high");
  expect(p.scoreOverride).toBe(0);
  expect(p.hashtagsEnabled).toBe(true);
});

// ── categoryScore ────────────────────────────────────────────────────────────

test("categoryScore uses priority preset when score override is 0", () => {
  const policies = { war: { priority: "very_high" as const }, analysis: { priority: "normal" as const } };
  expect(categoryScore(policies, "war", 10)).toBe(80);
  expect(categoryScore(policies, "analysis", 10)).toBe(40);
  expect(categoryScore(policies, "missing", 10)).toBe(10); // fallback
});

test("categoryScore uses score override when set", () => {
  const policies = { war: { scoreOverride: 95 } };
  expect(categoryScore(policies, "war", 10)).toBe(95);
});

// ── categoryFreshnessHours ───────────────────────────────────────────────────

test("categoryFreshnessHours returns fallback when policy is 0", () => {
  expect(categoryFreshnessHours({}, "war", 14)).toBe(14);
  expect(categoryFreshnessHours({ war: { freshnessHours: 0 } }, "war", 14)).toBe(14);
});

test("categoryFreshnessHours uses policy value when set", () => {
  expect(categoryFreshnessHours({ war: { freshnessHours: 6 } }, "war", 14)).toBe(6);
  expect(categoryFreshnessHours({ analysis: { freshnessHours: 72 } }, "analysis", 48)).toBe(72);
});

// ── categoryKeywordMatch ─────────────────────────────────────────────────────

test("categoryKeywordMatch passes when no keywords configured", () => {
  const result = categoryKeywordMatch({}, "war", "anything at all");
  expect(result.ok).toBe(true);
});

test("categoryKeywordMatch requires at least one keyword to match", () => {
  const policies = { war: { keywords: ["ceasefire", "sanctions"] } };
  expect(categoryKeywordMatch(policies, "war", "US imposes new sanctions on Iran").ok).toBe(true);
  expect(categoryKeywordMatch(policies, "war", "a completely unrelated story about cats").ok).toBe(false);
  expect(categoryKeywordMatch(policies, "war", "ceasefire agreed").ok).toBe(true);
});

test("categoryKeywordMatch rejects when excluded keyword is present", () => {
  const policies = { oil: { excludedKeywords: ["analysis", "opinion"] } };
  expect(categoryKeywordMatch(policies, "oil", "Analysis: oil prices surge").ok).toBe(false);
  expect(categoryKeywordMatch(policies, "oil", "Oil prices surge on supply fears").ok).toBe(true);
});

test("categoryKeywordMatch excluded keyword wins over required keyword", () => {
  const policies = { oil: { keywords: ["oil"], excludedKeywords: ["opinion"] } };
  expect(categoryKeywordMatch(policies, "oil", "Oil opinion piece").ok).toBe(false);
});

test("categoryKeywordMatch skipRequired lets non-English instant posts through", () => {
  // Instant Telegram sources default to "war" with no English keyword match;
  // a required-keyword list must not silently drop every non-English post.
  const policies = { war: { keywords: ["ceasefire", "strike"] } };
  const arabic = "هجمات جديدة على مواقع إيرانية في دير الزور";
  expect(categoryKeywordMatch(policies, "war", arabic).ok).toBe(false);
  expect(categoryKeywordMatch(policies, "war", arabic, { skipRequired: true }).ok).toBe(true);
  // Exclusions still veto even with skipRequired.
  const excluded = { war: { keywords: ["ceasefire"], excludedKeywords: ["opinion"] } };
  expect(categoryKeywordMatch(excluded, "war", "opinion piece about nothing", { skipRequired: true }).ok).toBe(false);
});

// ── pickKeywordTriggeredCategory (keywords as triggers) ──────────────────────

test("keyword trigger returns null when no keywords configured", () => {
  expect(pickKeywordTriggeredCategory({}, "US sanctions Iran over nuclear program")).toBeNull();
  expect(pickKeywordTriggeredCategory({ war: {} }, "anything at all")).toBeNull();
});

test("keyword trigger classifies a story the built-in classifier would drop", () => {
  // "nuclear" is not in the built-in iran regex pattern, so this story would
  // be dropped as off-topic; a keyword list on the iran policy rescues it.
  const policies = { iran: { keywords: ["nuclear", "enrichment", "iaea"] } };
  expect(pickKeywordTriggeredCategory(policies, "IAEA inspectors visit enrichment site")).toBe("iran");
  expect(pickKeywordTriggeredCategory(policies, "a story about fishing boats")).toBeNull();
});

test("keyword trigger respects excluded keywords (veto)", () => {
  const policies = { oil: { keywords: ["oil"], excludedKeywords: ["opinion"] } };
  expect(pickKeywordTriggeredCategory(policies, "Oil prices surge on supply fears")).toBe("oil");
  expect(pickKeywordTriggeredCategory(policies, "Opinion: oil prices will crash")).toBeNull();
});

test("keyword trigger never selects a disabled category", () => {
  const policies = { gaza: { status: "disabled" as const, keywords: ["gaza", "rafah"] } };
  expect(pickKeywordTriggeredCategory(policies, "Strike hits Rafah overnight")).toBeNull();
});

test("keyword trigger picks the highest-scoring category when several match", () => {
  const policies = {
    oil: { scoreOverride: 25, keywords: ["tanker"] },
    war: { scoreOverride: 60, keywords: ["tanker"] },
  };
  expect(pickKeywordTriggeredCategory(policies, "Missiles hit a tanker near Hormuz")).toBe("war");
});

// ── 0042 parity guard ────────────────────────────────────────────────────────
// Migration 0042 backfills scoreOverride with the legacy CATEGORY_PRIORITY
// values. If that mapping ever drifts from the code (or the code's baseline
// changes), publish ordering silently shifts — this test pins them together.
const LEGACY_SCORES = {
  iraq: 70, gaza: 62, war: 60, syria: 57, lebanon: 57, iran: 50, proxies: 45,
  "middle-east": 42, analysis: 34, gold: 30, usa: 30, oil: 25, "economic-impact": 20,
};

test("0042 scoreOverride seed matches CATEGORY_PRIORITY for every category", () => {
  const policies = getCategoryPolicies(
    Object.fromEntries(
      Object.entries(LEGACY_SCORES).map(([cat, score]) => [cat, { scoreOverride: score }]),
    ),
  );
  for (const [cat, score] of Object.entries(LEGACY_SCORES)) {
    expect(categoryScore(policies, cat, -1), `category ${cat}`).toBe(score);
    expect(CATEGORY_PRIORITY[cat], `CATEGORY_PRIORITY[${cat}]`).toBe(score);
  }
});

test("0042 seed list covers every category in CATEGORY_PRIORITY and vice versa", () => {
  expect(Object.keys(LEGACY_SCORES).sort()).toEqual(Object.keys(CATEGORY_PRIORITY).sort());
});

// ── categoryAtDailyCap ───────────────────────────────────────────────────────

test("categoryAtDailyCap returns false when no limit set", () => {
  expect(categoryAtDailyCap({}, "war", 100)).toBe(false);
  expect(categoryAtDailyCap({ war: { maxPostsPerDay: 0 } }, "war", 100)).toBe(false);
});

test("categoryAtDailyCap returns true when count reaches limit", () => {
  expect(categoryAtDailyCap({ war: { maxPostsPerDay: 5 } }, "war", 5)).toBe(true);
  expect(categoryAtDailyCap({ war: { maxPostsPerDay: 5 } }, "war", 4)).toBe(false);
  expect(categoryAtDailyCap({ war: { maxPostsPerDay: 5 } }, "war", 10)).toBe(true);
});

test("categoryAtDailyCap does not affect other categories", () => {
  const policies = { war: { maxPostsPerDay: 3 } };
  expect(categoryAtDailyCap(policies, "oil", 100)).toBe(false);
});
