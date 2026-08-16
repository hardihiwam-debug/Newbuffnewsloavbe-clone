// Tests for computeQuotaPatch (source daily-quota accounting) — imports the
// REAL pure helper from the pipeline shared module so it guards the exact
// rollover logic that feeds the dashboard's "X / 200 used today" stat.

import { test, expect } from "bun:test";
import { computeQuotaPatch } from "../supabase/functions/pipeline/_shared.ts";

test("same-day calls accumulate on used_today", () => {
  expect(computeQuotaPatch("2026-08-16", 42, "2026-08-16", 3)).toEqual({
    used_today: 45,
    quota_date: "2026-08-16",
  });
});

test("first call of a new day resets the counter", () => {
  expect(computeQuotaPatch("2026-08-16", 42, "2026-08-15", 3)).toEqual({
    used_today: 3,
    quota_date: "2026-08-16",
  });
});

test("null quota_date is treated as a fresh day", () => {
  expect(computeQuotaPatch("2026-08-16", 0, null, 1)).toEqual({
    used_today: 1,
    quota_date: "2026-08-16",
  });
});

test("zero calls still stamps today (no-op safe)", () => {
  expect(computeQuotaPatch("2026-08-16", 100, "2026-08-16", 0)).toEqual({
    used_today: 100,
    quota_date: "2026-08-16",
  });
});

test("missing used_today defaults to 0 on a fresh day", () => {
  expect(computeQuotaPatch("2026-08-16", undefined, "2026-08-15", 2)).toEqual({
    used_today: 2,
    quota_date: "2026-08-16",
  });
});
