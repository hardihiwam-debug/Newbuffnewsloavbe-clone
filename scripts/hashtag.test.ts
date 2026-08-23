// Tests for the auto-hashtag feature — imports the REAL implementation from
// the pipeline shared module (not a mirror).
//
// Contract (operator decisions, locked here):
//   - Toggle in Settings → Posting (auto_hashtag, default ON)
//   - Scope: every news post with a category (scheduled/campaign posts have
//     no category and never hit this path)
//   - Placement: absolute last line, BELOW the operator-configured links
//   - Text: localized per the post's language (en Title Case / ckb Arabic
//     script), spaces + hyphens stripped (Telegram hashtag rules),
//     unknown category/lang → no hashtag line.
import { test, expect } from "bun:test";
import { categoryHashtag, fitCaption, formatMessage, selectHashtags, type Post } from "../supabase/functions/pipeline/_shared.ts";

const basePost: Post = {
  headline: "Iran fires missiles at Tel Aviv overnight",
  summary: "Iran's IRGC launched a wave of ballistic missiles toward Israeli cities.",
  sourceName: "@insiderpaper",
  url: "https://t.me/insiderpaper/12345",
  imageUrl: null,
  videoUrl: null,
  originalPublishedAt: "2026-08-15T01:23:00Z",
  breaking: false,
  timezone: "Asia/Baghdad",
  extraSources: [],
  category: "war",
};

test("English hashtags are Title Case with spaces and hyphens stripped", () => {
  expect(categoryHashtag("gaza", "en")).toBe("#Gaza");
  expect(categoryHashtag("war", "en")).toBe("#War");
  expect(categoryHashtag("iraq", "en")).toBe("#Iraq");
  expect(categoryHashtag("iran", "en")).toBe("#Iran");
  expect(categoryHashtag("syria", "en")).toBe("#Syria");
  expect(categoryHashtag("lebanon", "en")).toBe("#Lebanon");
  expect(categoryHashtag("proxies", "en")).toBe("#Proxies");
  expect(categoryHashtag("oil", "en")).toBe("#Oil");
  expect(categoryHashtag("gold", "en")).toBe("#Gold");
  expect(categoryHashtag("analysis", "en")).toBe("#Analysis");
  // Hyphenated slugs become single-word tags (Telegram has no hyphen tags).
  expect(categoryHashtag("economic-impact", "en")).toBe("#EconomicImpact");
  expect(categoryHashtag("middle-east", "en")).toBe("#MiddleEast");
  // USA stays uppercase.
  expect(categoryHashtag("usa", "en")).toBe("#USA");
});

test("Kurdish Sorani hashtags use the Arabic script with underscore-joined phrases", () => {
  expect(categoryHashtag("gaza", "ckb")).toBe("#غەززە");
  expect(categoryHashtag("war", "ckb")).toBe("#شەڕ");
  expect(categoryHashtag("iraq", "ckb")).toBe("#عێراق");
  expect(categoryHashtag("iran", "ckb")).toBe("#ئێران");
  expect(categoryHashtag("lebanon", "ckb")).toBe("#لوبنان");
  expect(categoryHashtag("syria", "ckb")).toBe("#سووریا");
  expect(categoryHashtag("proxies", "ckb")).toBe("#پرۆکسی");
  expect(categoryHashtag("oil", "ckb")).toBe("#نەوت");
  expect(categoryHashtag("gold", "ckb")).toBe("#زێڕ");
  expect(categoryHashtag("usa", "ckb")).toBe("#ئەمریکا");
  expect(categoryHashtag("analysis", "ckb")).toBe("#شیکاری");
  // Multi-word tags join with underscores (Kurdish channel convention).
  expect(categoryHashtag("middle-east", "ckb")).toBe("#ڕۆژهەڵاتی_ناوەڕاست");
  // economic-impact uses the short "Economy" tag, matching the Analytics label.
  expect(categoryHashtag("economic-impact", "ckb")).toBe("#ئابووری");
});

test("Settings-selected topic rules add only matching topics after the category", () => {
  const rules = {
    war: {
      topicLimit: 1,
      topics: [
        { en: "Missiles", ckb: "مووشەک", keywords: ["missile", "rocket"], enabled: true },
        { en: "Ceasefire", ckb: "ئاگربەست", keywords: ["ceasefire"], enabled: true },
      ],
    },
  };
  expect(selectHashtags("war", "Iran fires a missile overnight", "en", rules)).toEqual(["#War", "#Missiles"]);
  expect(selectHashtags("war", "Officials discuss a ceasefire", "en", rules)).toEqual(["#War", "#Ceasefire"]);
  expect(selectHashtags("war", "Iran announces a statement", "en", rules)).toEqual(["#War"]);
});

test("topic limit two, disabled topics, and localized labels are respected", () => {
  const rules = {
    iran: {
      topicLimit: 2,
      topics: [
        { en: "Nuclear Program", ckb: "پرۆگرامی ناوکی", keywords: ["nuclear"], enabled: true },
        { en: "Sanctions", ckb: "سزاکان", keywords: ["sanction"], enabled: false },
        { en: "Diplomacy", ckb: "دیپلۆماسی", keywords: ["talks"], enabled: true },
      ],
    },
  };
  expect(selectHashtags("iran", "Iran nuclear talks", "ckb", rules)).toEqual(["#ئێران", "#پرۆگرامی_ناوکی", "#دیپلۆماسی"]);
  expect(selectHashtags("iran", "Iran nuclear talks", "en", rules)).toEqual(["#Iran", "#NuclearProgram", "#Diplomacy"]);
});

test("Settings can customize the category tag and unknown categories stay empty", () => {
  const rules = { oil: { categoryEn: "Oil-Market", topicLimit: 1, topics: [] } };
  expect(selectHashtags("oil", "Brent price rises", "en", rules)).toEqual(["#OilMarket"]);
  expect(selectHashtags("unknown", "anything", "en", rules)).toEqual([]);
});

test("unknown category or language yields no hashtag (no broken line)", () => {
  expect(categoryHashtag("sports", "en")).toBeNull();
  expect(categoryHashtag("", "en")).toBeNull();
  // Unknown language falls back to English, not null.
  expect(categoryHashtag("gaza", "ar")).toBe("#Gaza");
});

test("autoHashtag appends the hashtag as the absolute last line", () => {
  const out = formatMessage(basePost, { autoHashtag: true, hashtagLang: "en", hashtagRules: { war: { topicLimit: 1, topics: [{ en: "Missiles", ckb: "مووشەک", keywords: ["missile"], enabled: true }] } } });
  const lines = out.split("\n");
  expect(lines[lines.length - 1]).toBe("#Missiles");
  expect(out).toContain("#War");
  expect(out).toContain("#War\n#Missiles");
});

test("hashtag goes BELOW the operator links (very bottom)", () => {
  const out = formatMessage(basePost, {
    autoHashtag: true,
    hashtagLang: "en",
    links: [{ url: "https://example.com/join", text: "Join our channel" }],
  });
  const lines = out.split("\n");
  expect(lines[lines.length - 1]).toBe("#War");
  // Blank line separator, then the operator link just above it.
  expect(lines[lines.length - 2]).toBe("");
  expect(lines[lines.length - 3]).toContain("Join our channel");
});

test("Sorani posts get the localized hashtag", () => {
  const out = formatMessage(basePost, { autoHashtag: true, hashtagLang: "ckb" });
  const lines = out.split("\n");
  expect(lines[lines.length - 1]).toBe("#شەڕ");
});

test("toggle off or missing category → no hashtag line", () => {
  const off = formatMessage(basePost, { autoHashtag: false, hashtagLang: "en" });
  expect(off.split("\n").at(-1)).not.toBe("#War");
  expect(off).not.toContain("#War");
  const noCat = formatMessage({ ...basePost, category: null }, { autoHashtag: true, hashtagLang: "en" });
  expect(noCat).not.toContain("#");
  // Default (no fmt) is unchanged — feature off unless requested.
  expect(formatMessage(basePost)).not.toContain("#War");
});

test("fitCaption keeps the hashtag tail when trimming a long post", () => {
  const longSummary = "Word. ".repeat(400);
  const out = formatMessage(
    { ...basePost, summary: longSummary, category: "gaza" },
    { autoHashtag: true, hashtagLang: "en" },
  );
  const trimmed = fitCaption(out, 1024);
  expect(trimmed.endsWith("#Gaza")).toBe(true);
});
