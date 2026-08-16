// Tests for formatMessage() — imports the REAL implementation from the
// pipeline shared module (not a mirror), so a regression in the shipped
// formatter fails here.
//
// The footer is the sole configurable branding line, governed entirely by
// the operator's post_footer setting (null -> DEFAULT_FOOTER, "" -> no
// footer, custom string -> that string). Nothing else is appended.

import { test, expect } from "bun:test";
import { formatMessage, type Post } from "../supabase/functions/pipeline/_shared.ts";

const basePost: Post = {
  headline: "Iran fires missiles at Tel Aviv overnight",
  summary: "Iran's IRGC launched a wave of ballistic missiles toward Israeli cities, IDF confirms strikes hit two suburban districts.",
  sourceName: "@insiderpaper",
  url: "https://t.me/insiderpaper/12345",
  imageUrl: null,
  videoUrl: null,
  originalPublishedAt: "2026-08-15T01:23:00Z",
  breaking: false,
  timezone: "Asia/Baghdad",
  extraSources: [],
};

test("default footer is emitted when post_footer is null", () => {
  const out = formatMessage(basePost);
  expect(out).toContain("⚡ Delivered by Freebuff");
});

test("empty footer removes the footer line entirely", () => {
  const out = formatMessage(basePost, { footer: "" });
  expect(out).not.toContain("⚡ Delivered by Freebuff");
  expect(out).not.toContain("Powered by Freebuff");
});

test("custom footer overrides the default", () => {
  const out = formatMessage(basePost, { footer: "My Custom Newsroom" });
  expect(out).toContain("My Custom Newsroom");
  expect(out).not.toContain("Delivered by Freebuff");
  expect(out).not.toContain("Powered by Freebuff");
});

test("Telegram permalink preserved as source link", () => {
  const out = formatMessage(basePost);
  expect(out).toContain(`<a href="https://t.me/insiderpaper/12345">`);
  expect(out).toContain("Read the full report");
});

test("breaking prefix still inserted", () => {
  const out = formatMessage({ ...basePost, breaking: true }, { breakingPrefix: "🔥 " });
  expect(out).toContain("🔥 Iran fires missiles");
});

test("no brand line is appended beyond the configured footer", () => {
  const out = formatMessage(basePost);
  expect(out).not.toMatch(/🟧 Powered by/);
  expect(out).not.toMatch(/Powered by Freebuff · freebuff\.com/);
});
