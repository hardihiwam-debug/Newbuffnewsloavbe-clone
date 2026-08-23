// Tests for the per-cycle rewrite-provider health + attempt-budget decision —
// imports the REAL helpers from the pipeline shared module so this guards the
// exact shipped logic that skips dead providers (429 quota, 401/403, 402,
// 5xx) for the rest of a cycle instead of re-burning the rewrite deadline on
// every chunk, and caps each attempt to half the remaining window so one slow
// response can't starve the fallback providers.
import { test, expect } from "bun:test";
import { isHardProviderFailure, rewriteAttemptTimeoutMs } from "../supabase/functions/pipeline/_shared.ts";

test("quota exhausted (429) is a hard failure — skip for the rest of the cycle", () => {
  expect(isHardProviderFailure("cloudflare 429: {\"errors\":[{\"message\":\"used up your daily free allocation of 10,000 neurons\"}]}")).toBe(true);
});

test("missing credits (402) is a hard failure", () => {
  expect(isHardProviderFailure("openrouter 402: {\"error\":{\"message\":\"Insufficient credits\"}}")).toBe(true);
});

test("auth failures (401/403) are hard failures", () => {
  expect(isHardProviderFailure("groq 401: unauthorized")).toBe(true);
  expect(isHardProviderFailure("mistral 403: forbidden")).toBe(true);
});

test("model-not-found (404) is a hard failure", () => {
  expect(isHardProviderFailure("groq 404: model not found")).toBe(true);
});

test("server errors (5xx) are hard failures", () => {
  expect(isHardProviderFailure("cloudflare 500: internal")).toBe(true);
  expect(isHardProviderFailure("openrouter 503: unavailable")).toBe(true);
});

test("timeouts are NOT hard failures (retry next chunk)", () => {
  expect(isHardProviderFailure("The operation was aborted due to timeout")).toBe(false);
  expect(isHardProviderFailure("network error")).toBe(false);
});

test("JSON parse / content failures are NOT hard failures", () => {
  expect(isHardProviderFailure("cloudflare returned no JSON object")).toBe(false);
  expect(isHardProviderFailure("groq response truncated (max_tokens) — batch too large")).toBe(false);
});

test("empty message is not a hard failure", () => {
  expect(isHardProviderFailure("")).toBe(false);
});

// ── rewriteAttemptTimeoutMs (tail-chunk starvation fix) ───────────────────
test("a fresh 60s window caps the first attempt at 30s", () => {
  expect(rewriteAttemptTimeoutMs(60_000)).toBe(30_000);
});

test("a 30s window gives the first provider 15s, leaving room for a fallback", () => {
  expect(rewriteAttemptTimeoutMs(30_000)).toBe(15_000);
});

test("a 40s window gives 20s per provider (two attempts fit)", () => {
  expect(rewriteAttemptTimeoutMs(40_000)).toBe(20_000);
});

test("a 30s window gives the first provider 15s, leaving room for a fallback", () => {
  expect(rewriteAttemptTimeoutMs(30_000)).toBe(15_000);
});

test("tight windows never drop below the 15s floor — Mistral's measured 8-12s latency must fit", () => {
  // The 5:46 PM failure: remaining window ~12s → old 8s floor killed Mistral
  // at 8s even though it succeeds in 8-12s. 15s lets the slow-but-working
  // provider finish instead of starving the chunk.
  expect(rewriteAttemptTimeoutMs(20_000)).toBe(15_000);
  expect(rewriteAttemptTimeoutMs(10_000)).toBe(15_000);
  expect(rewriteAttemptTimeoutMs(5_000)).toBe(15_000);
  expect(rewriteAttemptTimeoutMs(1_000)).toBe(15_000);
});

test("missing/expired windows fall back to the floor (still lets one attempt run)", () => {
  expect(rewriteAttemptTimeoutMs(0)).toBe(15_000);
  expect(rewriteAttemptTimeoutMs(-5)).toBe(15_000);
  expect(rewriteAttemptTimeoutMs(Number.NaN)).toBe(15_000);
  expect(rewriteAttemptTimeoutMs(Number.POSITIVE_INFINITY)).toBe(15_000);
});
