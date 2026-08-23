// Tests for aggregateRewriteAnalytics (Settings → AI & Translation → Rewrite
// Analytics) — imports the REAL pure helper from the admin shared module so it
// guards the exact aggregation that feeds the success/fallback rates,
// per-provider latency and 7-day trend.

import { test, expect } from "bun:test";
import { aggregateRewriteAnalytics } from "../supabase/functions/admin/_shared.ts";

const day = (offsetDays = 0) => new Date(Date.now() - offsetDays * 86_400_000).toISOString();

test("empty log → zeroed aggregates with empty 7-day trend", () => {
  const a = aggregateRewriteAnalytics([]);
  expect(a.total).toBe(0);
  expect(a.ok).toBe(0);
  expect(a.failed).toBe(0);
  expect(a.successRate).toBe(0);
  expect(a.fallbackRate).toBe(0);
  expect(a.providers).toEqual([]);
  expect((a.trend as any[]).length).toBe(7);
  expect((a.trend as any[]).every((d) => d.ok === 0 && d.fail === 0)).toBe(true);
});

test("rates are computed correctly from ok/fail rows", () => {
  const a = aggregateRewriteAnalytics([
    { created_at: day(0), ok: true, provider: "groq" },
    { created_at: day(0), ok: true, provider: "groq" },
    { created_at: day(0), ok: false, provider: "cloudflare" },
    { created_at: day(1), ok: true, provider: "mistral" },
  ]);
  expect(a.total).toBe(4);
  expect(a.ok).toBe(3);
  expect(a.failed).toBe(1);
  expect(a.successRate).toBe(75);
  expect(a.fallbackRate).toBe(25);
});

test("per-provider ok/fail counts and average latency", () => {
  const a = aggregateRewriteAnalytics([
    { created_at: day(0), ok: true, provider: "groq", duration_ms: 1000 },
    { created_at: day(0), ok: true, provider: "groq", duration_ms: 3000 },
    { created_at: day(0), ok: false, provider: "groq", duration_ms: 8000 },
    { created_at: day(0), ok: true, provider: "mistral", duration_ms: null },
  ]);
  const groq = (a.providers as any[]).find((p) => p.name === "groq");
  const mistral = (a.providers as any[]).find((p) => p.name === "mistral");
  expect(groq).toMatchObject({ ok: 2, fail: 1, avgDurationMs: 4000 });
  expect(mistral).toMatchObject({ ok: 1, fail: 0, avgDurationMs: 0 });
  // providers are sorted best-first by ok count
  expect((a.providers as any[])[0]!.name).toBe("groq");
});

test("7-day trend buckets rows by UTC day", () => {
  const a = aggregateRewriteAnalytics([
    { created_at: day(0), ok: true, provider: "groq" },
    { created_at: day(3), ok: false, provider: "cloudflare" },
  ]);
  const trend = a.trend as any[];
  expect(trend[6]!.ok).toBe(1); // today
  expect(trend[3]!.fail).toBe(1); // 3 days ago
  const todayKey = new Date().toISOString().slice(0, 10);
  expect(trend[6]!.day).toBe(todayKey);
});

test("unknown/null provider and missing dates do not crash", () => {
  const a = aggregateRewriteAnalytics([
    { created_at: null, ok: true },
    { ok: false, provider: null, duration_ms: undefined },
  ]);
  expect(a.total).toBe(2);
  expect(a.ok).toBe(1);
  expect((a.providers as any[]).some((p) => p.name === "unknown")).toBe(true);
});
