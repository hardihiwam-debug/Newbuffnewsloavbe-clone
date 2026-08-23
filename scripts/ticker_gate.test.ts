// Regression tests for the two contentless-source safeguards:
//   A) PRICE_TICKER / quote-widget pages (Kitco-style "Gold Price Canada Today
//      | Live Gold Price in CAD") are rejected by junkGate before anything
//      else runs.
//   B) Headline-only feed results (description = title repeated, or missing)
//      are detected by isHeadlineOnlySource — ingest drops them instead of
//      publishing a duplicated-title post with no article body.
// The near-miss split matters: real market headlines must still pass.
//
// NOTE: the pipeline modules read Deno.env at import time (config.ts), so the
// stub must be installed BEFORE they load — dynamic imports, not static ones
// (static imports are hoisted above the stub assignment and poison the shared
// module cache for every later test file).
import { test, expect } from "bun:test";

(globalThis as Record<string, unknown>).Deno = { env: { get: () => undefined } };

const { isPriceTickerTitle, junkGate } = await import("../supabase/functions/pipeline/gates.ts");
const { isHeadlineOnlySource } = await import("../supabase/functions/pipeline/_shared.ts");
type Article = import("../supabase/functions/pipeline/config.ts").Article;

function article(title: string, description: string | null): Article {
  return {
    provider: "RSS/test",
    sourceName: "Test Outlet",
    url: "https://example.com/article",
    title,
    description,
    imageUrl: null,
    publishedAt: new Date().toISOString(),
    mediaKind: null,
  };
}

// ── Option A: price ticker titles must be rejected ──────────────────────────

test("the exact Kitco ticker title that published as post #3202 is rejected", () => {
  expect(isPriceTickerTitle("Gold Price Canada Today | Live Gold Price in CAD")).toBe(true);
});

test("junkGate reports the ticker reason for the Kitco page", () => {
  const r = junkGate(article("Gold Price Canada Today | Live Gold Price in CAD", null));
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("price ticker/quote-widget page");
});

test("live/real-time commodity price widgets are rejected", () => {
  expect(isPriceTickerTitle("Live Gold Price")).toBe(true);
  expect(isPriceTickerTitle("Live gold price & historical chart")).toBe(true);
  expect(isPriceTickerTitle("Real-time oil price quotes")).toBe(true);
  expect(isPriceTickerTitle("Silver price live chart")).toBe(true);
  expect(isPriceTickerTitle("Exchange rate USD to IQD — currency converter, live")).toBe(true);
});

test("price-in-country-today converter pages are rejected", () => {
  expect(isPriceTickerTitle("Gold rate in Pakistan today")).toBe(true);
  expect(isPriceTickerTitle("Price of dollar in Iraq today")).toBe(true);
});

// ── Near misses: legitimate market news MUST pass ───────────────────────────

test("real market headlines are not flagged as tickers", () => {
  expect(isPriceTickerTitle("Gold price rises as Fed signals rate cut")).toBe(false);
  expect(isPriceTickerTitle("Oil falls 3% after attack on tanker near Hormuz")).toBe(false);
  expect(isPriceTickerTitle("Gold hits record high as dollar weakens")).toBe(false);
  expect(isPriceTickerTitle("Spot gold climbs for a third session")).toBe(false);
  expect(isPriceTickerTitle("Bitcoin surges past $70,000 amid ETF inflows")).toBe(false);
  expect(junkGate(article("Gold price rises as Fed signals rate cut", "Bullion gained after the Fed minutes.")).ok).toBe(true);
});

// ── Option B: headline-only sources (drop at ingest) ────────────────────────

test("the ABC school-attack thin source is detected as headline-only", () => {
  // Real stored payload of the malformed post #3197.
  expect(
    isHeadlineOnlySource(
      "Video International outrage over deadly Iranian girls’ school attack",
      "Video International outrage over deadly Iranian girls’ school attack ABC News - Breaking News, Latest News and Videos",
      "ABC News",
    ),
  ).toBe(true);
});

test("missing or duplicated descriptions are headline-only; real paragraphs are not", () => {
  expect(isHeadlineOnlySource("Some headline here", null)).toBe(true);
  expect(isHeadlineOnlySource("Some headline here", "")).toBe(true);
  expect(isHeadlineOnlySource("Some headline here", "Some headline here")).toBe(true);
  expect(
    isHeadlineOnlySource(
      "Strike hits tanker off Gulf coast",
      "A naval strike targeted a tanker off the Gulf coast on Friday, shipping sources said, the second such incident this month.",
    ),
  ).toBe(false);
});
