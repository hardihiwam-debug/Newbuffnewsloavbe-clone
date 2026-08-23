// Tests for the thin-body merge: when a rewrite returned a one-liner (or the
// source was just a headline), formatMessage must render headline + body as a
// single merged line instead of a bold headline followed by a near-duplicate
// sentence. Imports the REAL implementation from the pipeline shared module.
import { test, expect } from "bun:test";
import { formatMessage, mergeThinBody, type Post } from "../supabase/functions/pipeline/_shared.ts";

function post(overrides: Partial<Post>): Post {
  return {
    headline: "",
    summary: "",
    sourceName: "Washington Times",
    url: "https://example.com/x",
    imageUrl: null,
    videoUrl: null,
    originalPublishedAt: null,
    breaking: false,
    timezone: "Asia/Baghdad",
    extraSources: [],
    ...overrides,
  };
}

test("mergeThinBody: normal body untouched", () => {
  const body = "This is a long enough body that the merge should not engage because it has plenty of content beyond the headline. It goes on with several more sentences of actual detail to comfortably clear the threshold.";
  const r = mergeThinBody("H", body, "src");
  expect(r.merged).toBe(false);
  expect(r.headline).toBe("H");
  expect(r.summary).toBe(body);
});

test("mergeThinBody: one-liner restating the headline merges", () => {
  const r = mergeThinBody(
    "Iran's hardline parliament raises concerns with 'foreign infiltration' plan",
    "Al Jazeera reports that Iran's hardline parliament has raised concerns about a plan referred to as 'foreign infiltration'.",
    "Al Jazeera",
  );
  expect(r.merged).toBe(true);
  // Headline kept, body is the one-liner remainder.
  expect(r.headline).toBe("Iran's hardline parliament raises concerns with 'foreign infiltration' plan");
  expect(r.summary.length).toBeGreaterThan(24);
});

test("mergeThinBody: body that is just headline + site name collapses to headline only", () => {
  const h = "Canadian official condemns Israel's 'unlawful invasion' and announces new aid to Lebanon";
  const r = mergeThinBody(h, `${h} Washington Times`, "Washington Times");
  expect(r.merged).toBe(true);
  expect(r.headline).toBe(h);
  expect(r.summary).toBe("");
});

test("mergeThinBody: empty headline leaves body untouched (untitled Telegram posts)", () => {
  const r = mergeThinBody("", "Some telegram body text", "@chan");
  expect(r.merged).toBe(false);
  expect(r.summary).toBe("Some telegram body text");
});

test("mergeThinBody: empty body keeps headline", () => {
  const r = mergeThinBody("Headline here", "", "src");
  expect(r.merged).toBe(false);
  expect(r.headline).toBe("Headline here");
  expect(r.summary).toBe("");
});

test("formatMessage: thin body renders as one merged line with em dash", () => {
  const out = formatMessage(
    post({
      headline: "Iran's hardline parliament raises concerns with 'foreign infiltration' plan",
      summary: "Al Jazeera reports that Iran's hardline parliament has raised concerns about a plan referred to as 'foreign infiltration'.",
      sourceName: "Al Jazeera",
    }),
  );
  expect(out).toContain("<b>Iran's hardline parliament raises concerns with 'foreign infiltration' plan</b> — Al Jazeera reports");
  // No separate bare-headline line + blank + body layout.
  expect(out).not.toContain("<b>Iran's hardline parliament raises concerns with 'foreign infiltration' plan</b>\n\nAl Jazeera");
});

test("formatMessage: headline+site-name-only body renders headline only, no duplicate", () => {
  const h = "Canadian official condemns Israel's 'unlawful invasion' and announces new aid to Lebanon";
  const out = formatMessage(post({ headline: h, summary: `${h} Washington Times`, sourceName: "Washington Times" }));
  expect(out).toContain(`<b>${h}</b>`);
  // The body never repeats the headline on a separate line.
  expect(out).not.toContain(`<b>${h}</b>\n\n${h}`);
  // Source attribution still present.
  expect(out).toContain("<i>Washington Times</i>");
  // Read-more link still present.
  expect(out).toContain("<a href=\"https://example.com/x\">");
});

test("formatMessage: normal long body keeps headline + body layout", () => {
  const out = formatMessage(
    post({
      headline: "Iran fires missiles at Tel Aviv overnight",
      summary: "Iran's IRGC launched a wave of ballistic missiles toward Israeli cities, IDF confirms strikes hit two suburban districts. Reports of casualties are still emerging from the affected areas.",
      sourceName: "@insiderpaper",
    }),
  );
  expect(out).toContain("<b>Iran fires missiles at Tel Aviv overnight</b>\n\nIran's IRGC launched");
});

test("formatMessage: breaking prefix preserved on merged thin body", () => {
  const out = formatMessage(
    post({
      headline: "Hormuz toll booth hardwires higher prices",
      summary: "Bousso says the new tolling regime will push energy costs higher.",
      sourceName: "EnergyNow.com",
      breaking: true,
    }),
    { breakingPrefix: "🔥 " },
  );
  expect(out).toContain("<b>🔥 Hormuz toll booth hardwires higher prices</b> — Bousso says");
});

test("stripLinks: bare @-mentions and tg:// links are removed from bodies", async () => {
  // gates.ts's module chain reads Deno.env at import time; stub it for the test.
  (globalThis as Record<string, unknown>).Deno = { env: { get: () => undefined } };
  const { stripLinks } = await import("../supabase/functions/pipeline/gates.ts");
  const out = stripLinks(
    "The UAE announced the strikes @Middle_East_Spectator tg://resolve?domain=me_spectator https://t.me/x/1 https://example.com/a",
  );
  expect(out).not.toContain("@Middle_East_Spectator");
  expect(out).not.toContain("tg://");
  expect(out).not.toContain("t.me");
  expect(out).not.toContain("https://");
  // Emails survive (leading-space rule).
  expect(stripLinks("contact press@example.com now")).toContain("press@example.com");
});

test("stripLinks: @-handles after punctuation and bare domains with paths are removed", async () => {
  (globalThis as Record<string, unknown>).Deno = { env: { get: () => undefined } };
  const { stripLinks } = await import("../supabase/functions/pipeline/gates.ts");
  expect(stripLinks("(@Middle_East_Spectator) struck")).not.toContain("@");
  expect(stripLinks("source:@Middle_East_Spectator")).not.toContain("@");
  expect(stripLinks("read it at spectator.org/12345 now")).not.toContain("spectator.org");
  // Bare names (no path) and emails survive.
  expect(stripLinks("Reuters.com reported")).toContain("Reuters.com");
  expect(stripLinks("contact press@example.com now")).toContain("press@example.com");
});
