import { describe, expect, test } from "bun:test";

(globalThis as any).Deno = { env: { get: () => undefined } };

const {
  areTelegramPostsRelated,
  isInstantTelegramPostInWindow,
} = await import("../supabase/functions/pipeline/_shared.ts");
const { INSTANT_POST_GAP_MS, INSTANT_PUBLISH_CAP } = await import("../supabase/functions/pipeline/config.ts");

describe("Instant Telegram fetch window", () => {
  const start = Date.parse("2026-08-23T12:00:00.000Z");
  const complete = Date.parse("2026-08-23T12:05:00.000Z");

  test("accepts only posts strictly newer than the last boundary", () => {
    expect(isInstantTelegramPostInWindow("2026-08-23T12:00:00.001Z", start, complete)).toBe(true);
    expect(isInstantTelegramPostInWindow("2026-08-23T12:00:00.000Z", start, complete)).toBe(false);
    expect(isInstantTelegramPostInWindow("2026-08-23T11:59:59.999Z", start, complete)).toBe(false);
  });

  test("does not accept posts newer than the fetch completion boundary", () => {
    expect(isInstantTelegramPostInWindow("2026-08-23T12:05:00.001Z", start, complete)).toBe(false);
    expect(isInstantTelegramPostInWindow("2026-08-23T12:05:00.000Z", start, complete)).toBe(true);
  });

  test("rejects posts without a trustworthy publication timestamp", () => {
    expect(isInstantTelegramPostInWindow(null, start, complete)).toBe(false);
    expect(isInstantTelegramPostInWindow(undefined, start, complete)).toBe(false);
    expect(isInstantTelegramPostInWindow("not-a-date", start, complete)).toBe(false);
  });
});

describe("Instant Telegram related-post grouping", () => {
  test("groups reports about the same actor and incident", () => {
    expect(
      areTelegramPostsRelated(
        "The Houthis launched missiles at a vessel near the Red Sea.",
        "Houthi forces fired rockets at a ship near the Red Sea.",
      ),
    ).toBe(true);
  });

  test("groups reports about the same specific location and action", () => {
    expect(
      areTelegramPostsRelated(
        "An airstrike hit a convoy near Erbil.",
        "Several vehicles were damaged in an attack near Erbil.",
      ),
    ).toBe(true);
  });

  test("does not merge unrelated stories that only share a location", () => {
    expect(
      areTelegramPostsRelated(
        "Gold prices rose after investors reacted to market data in Erbil.",
        "A new hospital opened in Erbil after months of construction.",
      ),
    ).toBe(false);
  });

  test("does not merge unrelated actors without a shared event signal", () => {
    expect(
      areTelegramPostsRelated(
        "Iranian officials announced a budget plan in Tehran.",
        "A local football club opened a training center in Tehran.",
      ),
    ).toBe(false);
  });
});

describe("Instant publish policy", () => {
  test("keeps compatibility values at no cap and no artificial delay", () => {
    expect(INSTANT_PUBLISH_CAP).toBe(Number.POSITIVE_INFINITY);
    expect(INSTANT_POST_GAP_MS).toBe(0);
  });
});
