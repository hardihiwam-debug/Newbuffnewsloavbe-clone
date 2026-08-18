// Tests for the per-source-type attribution toggles in formatMessage:
// post_show_telegram_source hides @channel names, post_show_web_source hides
// website names (RSS/NewsData), and the master show_source switch still wins.
import { test, expect } from "bun:test";
import { formatMessage, type Post, type PostFormat } from "../supabase/functions/pipeline/_shared.ts";

function makePost(sourceName: string, extra: Array<{ name: string; url: string }> = []): Post {
  return {
    headline: "بەغدا ڕایگەیاند",
    summary: "نووسینەکە",
    sourceName,
    url: "https://t.me/ajanews/123",
    imageUrl: null,
    videoUrl: null,
    originalPublishedAt: null, // no timestamp → keeps assertions stable
    breaking: false,
    timezone: "Asia/Baghdad",
    extraSources: extra,
  };
}

function render(sourceName: string, fmt: PostFormat = {}, extra: Array<{ name: string; url: string }> = []): string {
  return formatMessage(makePost(sourceName, extra), fmt);
}

const TELEGRAM = "@ajanews";
const WEB = "Mehr News";

test("default: both Telegram and web source names are shown", () => {
  expect(render(TELEGRAM)).toContain("<i>@ajanews</i>");
  expect(render(WEB)).toContain("<i>Mehr News</i>");
  // The read-more link survives either way.
  expect(render(TELEGRAM)).toContain("<a href=\"https://t.me/ajanews/123\">Read the full report</a>");
});

test("showTelegramSource=false hides Telegram names only", () => {
  const telegram = render(TELEGRAM, { showTelegramSource: false });
  expect(telegram).not.toContain("<i>@ajanews</i>");
  expect(telegram).not.toContain("🗞");
  expect(telegram).toContain("<a href=\"https://t.me/ajanews/123\">Read the full report</a>");
  // Web sources are untouched by the Telegram toggle.
  expect(render(WEB, { showTelegramSource: false })).toContain("<i>Mehr News</i>");
});

test("showWebSource=false hides website names only", () => {
  const web = render(WEB, { showWebSource: false });
  expect(web).not.toContain("<i>Mehr News</i>");
  expect(web).toContain("<a href=\"https://t.me/ajanews/123\">Read the full report</a>");
  // Telegram sources are untouched by the web toggle.
  expect(render(TELEGRAM, { showWebSource: false })).toContain("<i>@ajanews</i>");
});

test("master showSource=false hides both types", () => {
  expect(render(TELEGRAM, { showSource: false })).not.toContain("<i>@ajanews</i>");
  expect(render(WEB, { showSource: false })).not.toContain("<i>Mehr News</i>");
  // Even when the per-type toggle says show, the master still wins.
  expect(render(WEB, { showSource: false, showWebSource: true })).not.toContain("<i>Mehr News</i>");
});

test("multi-source posts fall back to the link when source names are hidden", () => {
  const extra = [{ name: "Reuters", url: "https://reuters.com/x" }];
  // Shown: Sources: line lists both names.
  const shown = render(WEB, {}, extra);
  expect(shown).toContain("Sources:");
  expect(shown).toContain("Reuters");
  // Hidden: no Sources: line, but the clickable link remains.
  const hidden = render(WEB, { showWebSource: false }, extra);
  expect(hidden).not.toContain("Sources:");
  expect(hidden).not.toContain("Mehr News");
  expect(hidden).not.toContain("Reuters");
  expect(hidden).toContain("<a href=\"https://t.me/ajanews/123\">Read the full report</a>");
});

test("undefined per-type toggles behave like on (defaults preserved)", () => {
  expect(render(TELEGRAM, { showTelegramSource: undefined })).toContain("<i>@ajanews</i>");
  expect(render(WEB, { showWebSource: undefined })).toContain("<i>Mehr News</i>");
});
