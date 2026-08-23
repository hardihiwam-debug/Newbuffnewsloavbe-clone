// Unit tests for the admin PIN lockout helpers — imports the REAL functions
// from the admin edge-function shared module (same pattern as the pipeline
// shared-module tests).
import { test, expect } from "bun:test";
import {
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_WINDOW_MS,
  lockoutSecondsFor,
} from "../supabase/functions/admin/_shared.ts";

const NOW = Date.parse("2026-08-19T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test("no failures / no row → not locked", () => {
  expect(lockoutSecondsFor(0, null, NOW)).toBe(0);
  expect(lockoutSecondsFor(undefined, undefined, NOW)).toBe(0);
  expect(lockoutSecondsFor(1, undefined, NOW)).toBe(0);
});

test("below the ceiling is not locked, even inside the window", () => {
  expect(lockoutSecondsFor(1, ago(60_000), NOW)).toBe(0);
  expect(lockoutSecondsFor(MAX_FAILED_ATTEMPTS - 1, ago(60_000), NOW)).toBe(0);
});

test("at the ceiling → locked for the window remainder", () => {
  // 4 minutes ago → 11 minutes (660s) remain
  expect(lockoutSecondsFor(MAX_FAILED_ATTEMPTS, ago(4 * 60_000), NOW)).toBe(660);
  // fresh failure → the full window
  expect(lockoutSecondsFor(MAX_FAILED_ATTEMPTS, ago(500), NOW)).toBe(
    Math.ceil((LOCKOUT_WINDOW_MS - 500) / 1000),
  );
});

test("over the ceiling stays locked", () => {
  expect(lockoutSecondsFor(9, ago(2 * 60_000), NOW)).toBe(780);
});

test("expired window → not locked, regardless of count", () => {
  expect(lockoutSecondsFor(MAX_FAILED_ATTEMPTS, ago(LOCKOUT_WINDOW_MS + 1), NOW)).toBe(0);
  expect(lockoutSecondsFor(50, ago(LOCKOUT_WINDOW_MS * 2), NOW)).toBe(0);
});

test("malformed timestamp → not locked", () => {
  expect(lockoutSecondsFor(MAX_FAILED_ATTEMPTS, "not-a-date", NOW)).toBe(0);
  expect(lockoutSecondsFor(MAX_FAILED_ATTEMPTS, "", NOW)).toBe(0);
});
