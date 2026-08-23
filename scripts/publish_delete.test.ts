// Tests for the publish-delete + off-beat-sports work:
//   1. SOFT_NEWS_PATTERNS / relevanceGate now reject martial-arts and other
//      sports headlines ("Iran wins … Taekwondo President's Cup") that
//      previously slipped through — the soft-news list had no sports tokens
//      and the concrete-check matched "president" inside "President's Cup".
//   2. sendPost captures and returns the Telegram message_id from each send
//      branch (sendMessage / sendPhoto), which the pipeline stores on the
//      published_history row so the console can delete a delivered post.

import { test, expect } from "bun:test";

(globalThis as Record<string, unknown>).Deno = { env: { get: () => undefined } };

import type { Post } from "../supabase/functions/pipeline/_shared.ts";
const { relevanceGate, SOFT_NEWS_PATTERNS } = await import("../supabase/functions/pipeline/_shared.ts");
const { sendPost } = await import("../supabase/functions/pipeline/publish.ts");

// ── 1. Sports / off-beat gate ──────────────────────────────────────────────

const SPORTS_HEADLINES = [
  // The exact class that shipped to @taqiswne and got flagged as unrelated.
  "Iran wins senior kyorugi, Pakistan tops poomsae at World Taekwondo President's Cup",
  "Iranian boxer qualifies for the Paris Olympics after a knockout win",
  "Iraq national football team draws with Jordan in World Cup qualifier",
  "Iranian wrestler takes silver at the Asian Games",
];

test("SOFT_NEWS_PATTERNS catches the Taekwondo class that previously slipped through", () => {
  for (const h of SPORTS_HEADLINES) {
    expect(SOFT_NEWS_PATTERNS.some((p) => p.test(h))).toBe(true);
  }
});

test("relevanceGate rejects sports headlines even when they mention Iran", () => {
  for (const h of SPORTS_HEADLINES) {
    const gate = relevanceGate(h, "");
    expect(gate.ok).toBe(false);
  }
});

test("relevanceGate keeps the marathon-idiom class (negotiation metaphor, not the sport)", () => {
  const idiom = [
    "Marathon Gaza ceasefire talks enter third day in Cairo",
    "Iran-US marathon negotiations resume in Oman",
    "Marathon session at UN Security Council on Iran sanctions",
  ];
  for (const h of idiom) {
    expect(relevanceGate(h, "").ok).toBe(true);
  }
});

test("relevanceGate still accepts real conflict-beat headlines", () => {
  const onBeat = [
    "US imposes sanctions on three Iranian companies over Iran's drone program",
    "Iran launches missile and drone attacks on UAE, Kuwait, Bahrain",
    "Israeli drone strike injures civilians in southwestern Syria",
    "Trump says he views Strait of Hormuz as American territory",
  ];
  for (const h of onBeat) {
    expect(relevanceGate(h, "").ok).toBe(true);
  }
});

// ── 2. sendPost message_id capture ─────────────────────────────────────────

const basePost: Post = {
  headline: "Iran fires missiles at Tel Aviv overnight",
  summary: "Iran's IRGC launched a wave of ballistic missiles toward Israeli cities, IDF confirms strikes hit two suburban districts.",
  sourceName: "Reuters",
  url: "https://www.reuters.com/world/middle-east/story",
  imageUrl: null,
  videoUrl: null,
  originalPublishedAt: "2026-08-15T01:23:00Z",
  breaking: false,
  timezone: "Asia/Baghdad",
  extraSources: [],
};

function mockTelegramFetch(calls: string[]) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return orig;
}

test("sendPost captures message_id from the sendMessage branch", async () => {
  const calls: string[] = [];
  const orig = mockTelegramFetch(calls);
  try {
    const d = await sendPost(-1001234567, { ...basePost, imageUrl: null }, undefined, null);
    expect(d.mode).toBe("text");
    expect(d.messageId).toBe(4242);
    expect(calls.some((c) => c.includes("sendMessage"))).toBe(true);
  } finally {
    globalThis.fetch = orig;
  }
});

test("sendPost captures message_id from the sendPhoto branch", async () => {
  const calls: string[] = [];
  const orig = mockTelegramFetch(calls);
  try {
    const d = await sendPost(-1001234567, { ...basePost, imageUrl: "https://cdn.example.com/photo.jpg" }, undefined, "photo");
    expect(d.mode).toBe("photo");
    expect(d.messageId).toBe(4242);
    expect(calls.some((c) => c.includes("sendPhoto"))).toBe(true);
  } finally {
    globalThis.fetch = orig;
  }
});
