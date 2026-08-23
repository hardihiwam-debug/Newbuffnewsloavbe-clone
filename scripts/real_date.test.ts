// Tests for the real article-date freshness chain (the June-22 re-crawl leak):
//   - maxArticleAgeHours / realDateCheckOk — the shared thresholds used by
//     BOTH the ingest enrichment drop and the publish-time verification, so a
//     feed re-stamp of an old story can never slip through either layer;
//   - extractArticlePublishedTime — the page-parsing patterns that recover a
//     real publish date from the common markup shapes (OpenGraph meta, schema
//     itemprop, JSON-LD, <time datetime>, data-* attributes).
// Imports the REAL implementations from the pipeline modules.
import { test, expect } from "bun:test";
import { maxArticleAgeHours, realDateCheckOk } from "../supabase/functions/pipeline/_shared.ts";

// fetch.ts reads Deno.env at import time (via config.ts) — stub it before the
// dynamic import, same pattern as thin_body.test.ts uses for gates.ts.
(globalThis as Record<string, unknown>).Deno = { env: { get: () => undefined } };
const { extractArticlePublishedTime } = await import("../supabase/functions/pipeline/fetch.ts");

const NOW = Date.parse("2026-08-19T12:00:00Z");

test("maxArticleAgeHours: breaking/war keywords → 14h", () => {
  expect(maxArticleAgeHours("US missile strike hits Houthi position")).toBe(14);
});

test("maxArticleAgeHours: analysis/opinion → 48h", () => {
  expect(maxArticleAgeHours("Analysis: what the ceasefire actually means")).toBe(48);
});

test("maxArticleAgeHours: plain news → 22h", () => {
  expect(maxArticleAgeHours("Iraqi PM visits Tehran for talks")).toBe(22);
});

test("realDateCheckOk: a fresh article passes", () => {
  const r = realDateCheckOk(new Date(NOW - 3 * 3_600_000).toISOString(), "Iran nuclear talks resume in Vienna", NOW);
  expect(r.ok).toBe(true);
  expect(r.verified).toBe(true);
});

test("realDateCheckOk: a 2-month-old article fails (the tovima.com leak)", () => {
  const r = realDateCheckOk(new Date(NOW - 60 * 86_400_000).toISOString(), "Vance says Iran agreed to allow inspectors", NOW);
  expect(r.ok).toBe(false);
  expect(r.ageHours).toBeGreaterThan(22);
  expect(r.verified).toBe(true);
});

test("realDateCheckOk: unparseable date does not block (verified=false)", () => {
  const r = realDateCheckOk("not-a-date", "some headline", NOW);
  expect(r.ok).toBe(true);
  expect(r.verified).toBe(false);
});

test("realDateCheckOk: future timestamp is treated as age 0 (passes)", () => {
  const r = realDateCheckOk(new Date(NOW + 60_000).toISOString(), "headline", NOW);
  expect(r.ok).toBe(true);
  expect(r.ageHours).toBe(0);
});

test("extractArticlePublishedTime: og article:published_time meta", () => {
  const html = `<html><head><meta property="article:published_time" content="2026-06-22T09:30:00+03:00"></head><body>x</body></html>`;
  expect(extractArticlePublishedTime(html)).toBe("2026-06-22T06:30:00.000Z");
});

test("extractArticlePublishedTime: reversed meta attribute order", () => {
  const html = `<meta content="2026-08-19T08:00:00Z" property="article:published_time">`;
  expect(extractArticlePublishedTime(html)).toBe("2026-08-19T08:00:00.000Z");
});

test("extractArticlePublishedTime: itemprop datePublished meta", () => {
  const html = `<meta itemprop="datePublished" content="2026-08-19T07:15:00Z">`;
  expect(extractArticlePublishedTime(html)).toBe("2026-08-19T07:15:00.000Z");
});

test("extractArticlePublishedTime: JSON-LD double-quoted datePublished", () => {
  const html = `<script type="application/ld+json">{"@type":"NewsArticle","datePublished": "2026-08-19T10:00:00Z"}</script>`;
  expect(extractArticlePublishedTime(html)).toBe("2026-08-19T10:00:00.000Z");
});

test("extractArticlePublishedTime: JSON-LD single-quoted datePublished", () => {
  const html = `<script type="application/ld+json">{'datePublished': '2026-08-19T11:00:00Z'}</script>`;
  expect(extractArticlePublishedTime(html)).toBe("2026-08-19T11:00:00.000Z");
});

test("extractArticlePublishedTime: <time datetime> element", () => {
  const html = `<article><time datetime="2026-08-19T05:45:00Z">Aug 19</time></article>`;
  expect(extractArticlePublishedTime(html)).toBe("2026-08-19T05:45:00.000Z");
});

test("extractArticlePublishedTime: data-published attribute", () => {
  const html = `<div class="story" data-published="2026-08-19T04:20:00Z">…</div>`;
  expect(extractArticlePublishedTime(html)).toBe("2026-08-19T04:20:00.000Z");
});

test("extractArticlePublishedTime: parsely-pub-date meta", () => {
  const html = `<meta name="parsely-pub-date" content="2026-08-19T06:10:00Z">`;
  expect(extractArticlePublishedTime(html)).toBe("2026-08-19T06:10:00.000Z");
});

test("extractArticlePublishedTime: no date anywhere → null", () => {
  expect(extractArticlePublishedTime("<html><body><p>no date here</p></body></html>")).toBeNull();
});
