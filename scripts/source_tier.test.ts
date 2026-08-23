// Tests for the source trust-tier byline: deterministic outlet classification
// (Wire / State media / Independent / Analysis) and its rendering inside
// formatMessage. Imports the REAL implementation from the pipeline shared module.

import { test, expect } from "bun:test";
import { formatMessage, sourceTier, sourceTierLabel, type Post } from "../supabase/functions/pipeline/_shared.ts";

test("classifies major agencies and broadcasters as wire", () => {
  expect(sourceTier("Reuters")).toBe("wire");
  expect(sourceTier("Associated Press")).toBe("wire");
  expect(sourceTier("Al Jazeera")).toBe("wire");
  expect(sourceTier("BBC World")).toBe("wire");
});

test("classifies Iranian / regional state outlets as state-media", () => {
  expect(sourceTier("Press TV")).toBe("state-media");
  expect(sourceTier("IRNA English")).toBe("state-media");
  expect(sourceTier("Tasnim News")).toBe("state-media");
  expect(sourceTier("Al Mayadeen")).toBe("state-media");
});

test("classifies think-tank / opinion outlets as analysis", () => {
  expect(sourceTier("War on the Rocks")).toBe("analysis");
  expect(sourceTier("Responsible Statecraft")).toBe("analysis");
  expect(sourceTier("FDD")).toBe("analysis");
  expect(sourceTier("Iran Desk")).toBe("analysis");
});

test("Middle East Eye uses the article type, not the publisher name", () => {
  expect(sourceTier("Middle East Eye")).toBe("independent");
  expect(sourceTier("Middle East Eye", "https://www.middleeasteye.net/news/yanbu-report", "news")).toBe("independent");
  expect(sourceTier("Middle East Eye", "https://www.middleeasteye.net/opinion/example", "analysis")).toBe("analysis");
});

test("classifies independent regional outlets as independent", () => {
  expect(sourceTier("Rudaw")).toBe("independent");
  expect(sourceTier("Shafaq News")).toBe("independent");
  expect(sourceTier("Iran International")).toBe("independent");
});

test("unknown sources resolve to null (never mislabel)", () => {
  expect(sourceTier("Some Unknown Blog")).toBeNull();
  expect(sourceTier("@ajanews")).toBeNull();
});

test("falls back to the URL host when the name is generic", () => {
  expect(sourceTier("", "https://www.reuters.com/world/x")).toBe("wire");
  expect(sourceTier("", "https://presstv.ir/x")).toBe("state-media");
});

test("labels localize to Kurdish Sorani", () => {
  expect(sourceTierLabel("wire", "en")).toBe("Wire");
  expect(sourceTierLabel("wire", "ckb")).toBe("ئاژانسی هەواڵ");
  expect(sourceTierLabel("state-media", "ckb")).toBe("میدیای دەوڵەتی");
  expect(sourceTierLabel(null, "en")).toBeNull();
});

function post(overrides: Partial<Post>): Post {
  return {
    headline: "Headline",
    summary: "A normal body that is long enough to stay separate from the headline.",
    sourceName: "Reuters",
    url: "https://www.reuters.com/world/x",
    imageUrl: null,
    videoUrl: null,
    originalPublishedAt: null,
    breaking: false,
    timezone: "Asia/Baghdad",
    extraSources: [],
    ...overrides,
  };
}

test("formatMessage appends the tier tag to the byline", () => {
  const out = formatMessage(post({ sourceName: "Reuters" }), { showTimestamp: false });
  expect(out).toContain("<i>Reuters</i> · Wire");
});

test("formatMessage shows no tier for an unknown source", () => {
  const out = formatMessage(post({ sourceName: "@ajanews", url: "https://t.me/s/ajanews" }), { showTimestamp: false });
  expect(out).toContain("<i>@ajanews</i>");
  expect(out).not.toMatch(/<i>@ajanews<\/i> · (Wire|State media|Independent|Analysis)/);
});

test("showSourceTier: false hides the tier tag", () => {
  const out = formatMessage(post({ sourceName: "Press TV" }), { showSourceTier: false, showTimestamp: false });
  expect(out).toContain("<i>Press TV</i>");
  expect(out).not.toContain("State media");
});

test("tier label follows the post language", () => {
  const out = formatMessage(post({ sourceName: "Press TV" }), { showTimestamp: false, sourceTierLang: "ckb" });
  expect(out).toContain("<i>Press TV</i> · میدیای دەوڵەتی");
});

test("Middle East Eye news posts are tagged Independent in the byline", () => {
  const out = formatMessage(
    post({ sourceName: "Middle East Eye", url: "https://www.middleeasteye.net/news/yanbu-report", articleType: "news" }),
    { showTimestamp: false },
  );
  expect(out).toContain("<i>Middle East Eye</i> · Independent");
  expect(out).not.toContain("· Analysis");
});

test("generated analysis posts are tagged Analysis in the byline", () => {
  const out = formatMessage(
    post({
      headline: "WHY IT MATTERS — Hormuz closure",
      summary: "A closure of the strait would raise shipping costs and energy prices across Asia and Europe.",
      sourceName: "Iran Desk",
    }),
    { showTimestamp: false },
  );
  expect(out).toContain("<i>Iran Desk</i> · Analysis");
});
