// Tests for the shared Telegram delivery-outcome classification used by the
// news pipeline (publish.ts) and the campaign engine (scheduled/index.ts).
//
// The 429/420 classification is the 2026-09 rate-limit fix: flood-control
// responses are DEFINITIVE failures (the request was refused before any
// delivery) so the durable 'sending' reservation is dropped and the queued
// item retries next cycle — previously they wedged permanently. Timeouts and
// 5xx stay AMBIGUOUS so the reservation is kept and a retry can never
// double-deliver.

import { describe, expect, test } from "bun:test";

(globalThis as any).Deno = { env: { get: () => undefined } };

const {
  DeliveryUnknownError,
  isDefinitiveTelegramFailure,
  isRateLimitFailure,
} = await import("../supabase/functions/pipeline/telegram.ts");

describe("isDefinitiveTelegramFailure", () => {
  test("4xx malformed-content rejections are definitive (refused before delivery)", () => {
    for (const status of [400, 401, 403, 404, 413]) {
      expect(isDefinitiveTelegramFailure(new Error(`Telegram sendMessage [${status}]: Bad Request`)), `status ${status}`).toBe(true);
    }
  });

  test("429/420 rate limits are definitive — the request never reached delivery", () => {
    expect(isDefinitiveTelegramFailure(new Error("Telegram sendMessage [429]: Too Many Requests: retry after 3"))).toBe(true);
    expect(isDefinitiveTelegramFailure(new Error("Telegram sendMessage [420]: Flood control: retry after 5"))).toBe(true);
  });

  test("raw-media-upload errors embed the status so they classify too", () => {
    expect(isDefinitiveTelegramFailure(new Error("Telegram sendPhoto upload [429]: Too Many Requests"))).toBe(true);
    expect(isDefinitiveTelegramFailure(new Error("Telegram sendVideo upload [400]: FILE_IS_TOO_BIG"))).toBe(true);
  });

  test("timeouts and 5xx are ambiguous — NOT definitive (reservation must be kept)", () => {
    expect(isDefinitiveTelegramFailure(new Error("Telegram sendMessage [500]: Internal Server Error"))).toBe(false);
    expect(isDefinitiveTelegramFailure(new Error("Telegram sendMessage [502]: Bad Gateway"))).toBe(false);
    expect(isDefinitiveTelegramFailure(new Error("This operation was aborted (timeout of 20000ms exceeded)"))).toBe(false);
    expect(isDefinitiveTelegramFailure(new Error("fetch failed"))).toBe(false);
  });

  test("non-Error values and plain strings do not accidentally classify", () => {
    expect(isDefinitiveTelegramFailure("Telegram sendMessage [429]: nope")).toBe(true); // message format still matches
    expect(isDefinitiveTelegramFailure("429")).toBe(false); // no bracketed status
    expect(isDefinitiveTelegramFailure(null)).toBe(false);
    expect(isDefinitiveTelegramFailure(undefined)).toBe(false);
  });
});

describe("isRateLimitFailure", () => {
  test("matches 429 and 420 anywhere in the message (bail-out for the fallback cascade)", () => {
    expect(isRateLimitFailure(new Error("Telegram sendMessage [429]: Too Many Requests"))).toBe(true);
    expect(isRateLimitFailure(new Error("Telegram sendMessage [420]: Flood control"))).toBe(true);
    expect(isRateLimitFailure(new Error("Telegram sendPhoto upload [429]: Too Many Requests"))).toBe(true);
  });

  test("does not match other statuses or bare numbers", () => {
    expect(isRateLimitFailure(new Error("Telegram sendMessage [400]: Bad Request"))).toBe(false);
    expect(isRateLimitFailure(new Error("Telegram sendMessage [500]: Internal Server Error"))).toBe(false);
    expect(isRateLimitFailure(new Error("Telegram sendMessage [413]: too big"))).toBe(false);
    expect(isRateLimitFailure(new Error("429"))).toBe(false);
  });
});

describe("DeliveryUnknownError", () => {
  test("is an Error whose message carries the underlying cause", () => {
    const err = new DeliveryUnknownError(new Error("boom"));
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DeliveryUnknownError);
    expect(err.name).toBe("DeliveryUnknownError");
    expect(err.message).toContain("unknown");
    expect(err.message).toContain("boom");
  });
});