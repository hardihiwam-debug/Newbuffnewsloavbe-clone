// Regression tests for the hardened contentless-source guard + the Sorani
// translation hardening (Option 1 + Option 2 of the "last 3 posts are
// useless" fix).
//
// The three posts that published AFTER the first headline-only fix shipped —
// EnergyNow 07:15, CryptoRank 07:30, L'Orient Today 07:50 — all had the same
// stored source shape: the feed DUPLICATED the whole title inside the
// description ("<title> - <publisher> <title> <publisher>"), and in some
// variants truncated the <title> field itself. The old guard only checked the
// suffix after the FIRST headline occurrence (<= 60 chars), so the second,
// full copy of the title pushed the suffix past 60 chars and the guard
// returned false. These tests pin the exact payload shapes that must now be
// dropped.
//
// NOTE: pipeline modules read Deno.env at import time (config.ts), so the
// stub must be installed BEFORE they load — dynamic imports, not static ones.
import { test, expect } from "bun:test";

(globalThis as Record<string, unknown>).Deno = { env: { get: () => undefined } };

const { isHeadlineOnlySource, dedupeSourceName, isIncompleteSoraniEnding, safeSoraniEnding, stripEchoedEnglishHeadline, stripEchoedSoraniHeadline, stripChannelFooter, cleanTruncatedTail, fitCaption, isIncompleteHeadline, safeHeadlineFallback, hasRepeatedFigure, resolveFinalHeadline, stripSummaryFiller, isHeadlineReword, polishRewriteSummary } =
  await import("../supabase/functions/pipeline/_shared.ts");
const { stripSourceName } = await import("../supabase/functions/pipeline/gates.ts");

// ── The exact published junk payloads (post-fix regression) ────────────────

test("L'Orient Today duplicated-title description is headline-only", () => {
  // Post at ~07:50. Title is repeated verbatim after " - L'Orient Today".
  expect(
    isHeadlineOnlySource(
      "US sanctions on Hezbollah officials, financiers and firms tied to attacks on Israel",
      "US sanctions on Hezbollah officials, financiers and firms tied to attacks on Israel - L'Orient Today US sanctions on Hezbollah officials, financiers and firms tied to attacks on Israel L'Orient Today",
      "L'Orient Today",
    ),
  ).toBe(true);
});

test("EnergyNow duplicated-title description is headline-only", () => {
  expect(
    isHeadlineOnlySource(
      "How Far Have the U.S. and Iran Come in Talks?",
      "How Far Have the U.S. and Iran Come in Talks? - EnergyNow How Far Have the U.S. and Iran Come in Talks? EnergyNow",
      "EnergyNow",
    ),
  ).toBe(true);
});

test("CryptoRank duplicated-title description is headline-only", () => {
  expect(
    isHeadlineOnlySource(
      "Gold Price Forecast: XAU/USD to Rise as Yields Retreat",
      "Gold Price Forecast: XAU/USD to Rise as Yields Retreat - CryptoRank Gold Price Forecast: XAU/USD to Rise as Yields Retreat CryptoRank",
      "CryptoRank",
    ),
  ).toBe(true);
});

// The variant that actually defeated the old guard: the <title> field is
// TRUNCATED while the description carries the FULL title twice. The old
// prefix-only check saw a suffix of ~120 chars (> 60) and returned false.
test("truncated-title variant is headline-only (the old guard's blind spot)", () => {
  expect(
    isHeadlineOnlySource(
      "US sanctions on Hezbollah…",
      "US sanctions on Hezbollah officials, financiers and firms tied to attacks on Israel - L'Orient Today US sanctions on Hezbollah officials, financiers and firms tied to attacks on Israel L'Orient Today",
      "L'Orient Today",
    ),
  ).toBe(true);
});

// ── Existing contract, preserved ───────────────────────────────────────────

test("the ABC school-attack thin source is still detected as headline-only", () => {
  expect(
    isHeadlineOnlySource(
      "Video International outrage over deadly Iranian girls’ school attack",
      "Video International outrage over deadly Iranian girls’ school attack ABC News - Breaking News, Latest News and Videos",
      "ABC News",
    ),
  ).toBe(true);
});

test("missing, empty, or exact-duplicate descriptions are headline-only", () => {
  expect(isHeadlineOnlySource("Some headline here", null)).toBe(true);
  expect(isHeadlineOnlySource("Some headline here", "")).toBe(true);
  expect(isHeadlineOnlySource("Some headline here", "Some headline here")).toBe(true);
});

// ── Near misses: real reporting MUST pass ──────────────────────────────────

test("a genuine multi-sentence paragraph is not headline-only", () => {
  expect(
    isHeadlineOnlySource(
      "Strike hits tanker off Gulf coast",
      "A naval strike targeted a tanker off the Gulf coast on Friday, shipping sources said, the second such incident this month.",
    ),
  ).toBe(false);
});

test("a real Reuters-style description with details is not headline-only", () => {
  expect(
    isHeadlineOnlySource(
      "US sanctions on Hezbollah officials",
      "US sanctions on Hezbollah officials, freezing assets of three financiers. The Treasury said the measures target a network that funnels funds to the group. Officials said more sanctions could follow.",
    ),
  ).toBe(false);
});

test("a long genuine body that quotes its own headline twice still passes", () => {
  // The >= 2 rule is bounded to bodies <= 400 chars so a real article that
  // references its own headline is never dropped.
  const body =
    "US sanctions on Hezbollah officials. The Treasury said the measures target a network that funnels funds to the group. US sanctions on Hezbollah have been expanding since October, officials said, and more designations are expected as pressure grows on the group's financial infrastructure across Lebanon and the wider region. The action freezes US-held assets and bars American citizens from dealing with the named individuals, who include senior financiers.";
  expect(body.length).toBeGreaterThan(400);
  expect(isHeadlineOnlySource("US sanctions on Hezbollah officials", body)).toBe(false);
});

// ── dedupeSourceName ───────────────────────────────────────────────────────

test("doubled source names collapse to the single name", () => {
  expect(dedupeSourceName("L'Orient Today L'Orient Today")).toBe("L'Orient Today");
  expect(dedupeSourceName("@InsiderPaper @InsiderPaper")).toBe("@InsiderPaper");
  expect(dedupeSourceName("Associated Press Associated Press")).toBe("Associated Press");
});

test("normal source names pass through untouched", () => {
  expect(dedupeSourceName("L'Orient Today")).toBe("L'Orient Today");
  expect(dedupeSourceName("The National")).toBe("The National");
  expect(dedupeSourceName("")).toBe("");
});

// ── Sorani completeness (truncated endings) ────────────────────────────────

test("a Sorani body ending on a dangling connector is incomplete", () => {
  expect(isIncompleteSoraniEnding("…گوشار دەخەنە سەر")).toBe(true);
  expect(isIncompleteSoraniEnding("هێرشەکە لەسەر")).toBe(true);
  expect(isIncompleteSoraniEnding("هەواڵەکە بەپێی")).toBe(true);
});

test("complete Sorani bodies are not incomplete", () => {
  expect(isIncompleteSoraniEnding("نرخی نەوت بەرزبووەوە لە بەغدا")).toBe(false);
  expect(isIncompleteSoraniEnding("ئەمڕۆ")).toBe(false);
  expect(isIncompleteSoraniEnding("")).toBe(false);
});

test("safeSoraniEnding trims only the dangling connector", () => {
  expect(safeSoraniEnding("هێرشەکە لەسەر")).toBe("هێرشەکە");
  expect(safeSoraniEnding("ئەمڕۆ")).toBe("ئەمڕۆ");
  expect(safeSoraniEnding("")).toBe("");
});

// ── English headline echo leak (Option 2a) ─────────────────────────────────

test("an English headline echoed inside a Sorani body is stripped", () => {
  expect(
    stripEchoedEnglishHeadline(
      "Gold price climbs as dollar weakens — نرخی زێڕ بەرزبووەوە بەهۆی لاوازبوونی دۆلارەوە",
      "Gold price climbs as dollar weakens",
    ),
  ).toBe("نرخی زێڕ بەرزبووەوە بەهۆی لاوازبوونی دۆلارەوە");
});

test("a body without an English-headline echo is unchanged", () => {
  expect(
    stripEchoedEnglishHeadline("نرخی زێڕ بەرزبووەوە بەهۆی لاوازبوونی دۆلارەوە", "Gold price climbs as dollar weakens"),
  ).toBe("نرخی زێڕ بەرزبووەوە بەهۆی لاوازبوونی دۆلارەوە");
});

// ── Incomplete-title detection (the "فێری ژیان دەکات بێ —" post) ──────────
// The newest posts at 08:15/08:25 still shipped broken titles after the
// connector-based check: 3215 ended on a dash after a noun, 3216 ended on
// "بێ" ("without") which was missing from the dangling lists, and 3214 was a
// garbled ticker translation repeating one figure twice.

test("a title ending on a dash/ellipsis is incomplete even when the last word is a noun", () => {
  // post 3216: "The Middle East learns to live without —"
  expect(isIncompleteHeadline("ڕۆژهەڵاتی ناوەڕاست فێری ژیان دەکات بێ —")).toBe(true);
  // post 3215: "InkStack Media report on a deal that could reshape the Middle East —"
  expect(isIncompleteHeadline("ڕاپۆرتی ئینکشتاک میدیا لەسەر ڕێککەوتنێک کە دەتوانێت ڕۆژهەڵاتی ناوەڕاست —")).toBe(true);
  expect(isIncompleteHeadline("Iran sanctions loom…")).toBe(true);
});

test("a title ending on the بێ (without) connector is incomplete", () => {
  expect(isIncompleteHeadline("ڕۆژهەڵاتی ناوەڕاست فێری ژیان دەکات بێ")).toBe(true);
  expect(isIncompleteHeadline("The Middle East learns to live without")).toBe(true);
});

test("a truncated English feed title ending mid-phrase is incomplete", () => {
  // The ABC school-attack class: feed cut "…school in" before "Iran".
  expect(isIncompleteHeadline("Video shows international outrage over deadly attack on girls' school in")).toBe(true);
  expect(isIncompleteHeadline("US-Iran talks continue as")).toBe(true);
});

test("complete headlines are not flagged", () => {
  expect(isIncompleteHeadline("Video shows international outrage over deadly attack on girls' school in Iran")).toBe(false);
  expect(isIncompleteHeadline("سەرۆکی ئێران دەڵێت کاتی ئەوەیە شەڕ کۆتایی بێت")).toBe(false);
  expect(isIncompleteHeadline("")).toBe(true); // empty = nothing to publish
});

test("safeHeadlineFallback removes the dangling ending", () => {
  expect(safeHeadlineFallback("ڕۆژهەڵاتی ناوەڕاست فێری ژیان دەکات بێ —")).toBe("ڕۆژهەڵاتی ناوەڕاست فێری ژیان دەکات");
  expect(safeHeadlineFallback("Video shows international outrage over deadly attack on girls' school in")).toBe(
    "Video shows international outrage over deadly attack on girls' school",
  );
  expect(safeHeadlineFallback("Video shows international outrage over deadly attack on girls' school in Iran")).toBe(
    "Video shows international outrage over deadly attack on girls' school in Iran",
  );
});

// ── Repeated-figure garbage (the "٥،٤٨٢ تاکای ٥٤٨٢" post) ─────────────────

test("a garbled ticker translation repeating one figure is detected", () => {
  // post 3214: same 5482 figure twice, digits and separators mangled.
  expect(hasRepeatedFigure("باجوس نرخی زێڕ بە ٥،٤٨٢ تاکای ٥٤٨٢ لە هەر بەورییەکدا بەرز")).toBe(true);
  expect(hasRepeatedFigure("Gold bulls eye $5,482 per ounce 5482")).toBe(true);
});

test("single-figure and small-number titles are not flagged", () => {
  expect(hasRepeatedFigure("Gold bulls eye $5,482 per ounce")).toBe(false);
  expect(hasRepeatedFigure("3 killed, 3 injured in blast")).toBe(false);
  expect(hasRepeatedFigure("نرخی زێڕ لە کەنەدا")).toBe(false);
  expect(hasRepeatedFigure("")).toBe(false);
});

// ── resolveFinalHeadline — the publish-time final guarantee ────────────────
// publish.ts is DB/network-heavy and not unit-tested; the resolver that
// decides "trim / fix / drop" is extracted pure so the DROP branch (the one
// that deletes a queue row) is pinned here.

test("resolver drops a headline that is incomplete even after fallback", () => {
  // "لە" alone: a dangling connector with nothing to trim to — the fallback
  // returns it unchanged, still incomplete → drop (never ship it).
  expect(resolveFinalHeadline("لە")).toEqual({ drop: true, action: "dropped" });
  // Same for an English-only connector.
  expect(resolveFinalHeadline("in")).toEqual({ drop: true, action: "dropped" });
});

test("resolver trims a dangling ending and keeps the post", () => {
  expect(resolveFinalHeadline("ڕۆژهەڵاتی ناوەڕاست فێری ژیان دەکات بێ —")).toEqual({
    drop: false,
    action: "trimmed",
    headline: "ڕۆژهەڵاتی ناوەڕاست فێری ژیان دەکات",
  });
  expect(resolveFinalHeadline("Video shows international outrage over deadly attack on girls' school in")).toEqual({
    drop: false,
    action: "trimmed",
    headline: "Video shows international outrage over deadly attack on girls' school",
  });
});

test("resolver fixes a repeated figure when the fallback yields a clean title", () => {
  // Trailing punctuation split the two copies; the fallback's punctuation
  // strip leaves a single figure → fixed, not dropped.
  expect(resolveFinalHeadline("Gold hits 5482. 5482.")).toEqual({
    drop: false,
    action: "figures-fixed",
    headline: "Gold hits 5482. 5482",
  });
});

test("resolver degrades (never drops) when the garbled figure cannot be fixed", () => {
  // The exact 3214 ticker shape: the fallback can't remove the doubled
  // figure (no connector to trim), so the resolver keeps it — degraded,
  // never dropped. Matches the pre-extraction publish.ts contract.
  const r = resolveFinalHeadline("باجوس نرخی زێڕ بە ٥،٤٨٢ تاکای ٥٤٨٢ لە هەر بەورییەکدا");
  expect(r.drop).toBe(false);
  expect(r.action).toBe("kept");
  expect(r.headline).toBe("باجوس نرخی زێڕ بە ٥،٤٨٢ تاکای ٥٤٨٢ لە هەر بەورییەکدا");
});

test("resolver passes clean headlines through untouched", () => {
  expect(resolveFinalHeadline("US sanctions on Hezbollah officials and financiers")).toEqual({
    drop: false,
    action: "kept",
    headline: "US sanctions on Hezbollah officials and financiers",
  });
  expect(resolveFinalHeadline("سەرۆکی ئێران دەڵێت کاتی ئەوەیە شەڕ کۆتایی بێت")).toEqual({
    drop: false,
    action: "kept",
    headline: "سەرۆکی ئێران دەڵێت کاتی ئەوەیە شەڕ کۆتایی بێت",
  });
  // Empty headline (title-less Telegram items) is exempt, never a drop.
  expect(resolveFinalHeadline("")).toEqual({ drop: false, headline: "", action: "kept" });
});

// ── Live-post regression batch (posts #3224–#3231, 2026-08-22) ─────────────
// Every assertion here pins a failure that was observed on the LIVE channel
// AFTER the v149/v150 fixes shipped — so this file is the canary for the
// "same issues persist" class.

test("mid-word and entity-cut Sorani endings are incomplete (was passing)", () => {
  // #3229 ends "…هەیە ل" (لە cut), #3230 ends "…بەسەرچوو&" (entity cut),
  // #3226 ends "…ئینگلتەر" (ئینگلتەرا cut). All three slipped the old
  // connector-only check.
  expect(isIncompleteSoraniEnding("...هەیە ل")).toBe(true);
  expect(isIncompleteSoraniEnding("...بەسەرچوو&")).toBe(true);
  // #3226 "…ئینگلتەر" (ئینگلتەرا cut) is NOT classifier-detectable: the
  // final "ر" is a valid Sorani word-final consonant, so no string rule can
  // flag it without a dictionary. That cut was produced by the 1024-char
  // caption cutter — which now routes through cleanTruncatedTail and never
  // cuts mid-word (pinned by the fitCaption test below).
  // #3228 "…جەختی لە" — a real dangling connector, still caught.
  expect(isIncompleteSoraniEnding("...جەختی لە")).toBe(true);
  // A genuinely complete ending is untouched.
  expect(isIncompleteSoraniEnding("...کۆتایی قسەیان هەیە")).toBe(false);
});

test("safeSoraniEnding removes mid-word and entity cuts too", () => {
  expect(safeSoraniEnding("...کۆتایی قسەیان هەیە ل")).toBe("...کۆتایی قسەیان هەیە");
  expect(safeSoraniEnding("...بە شێوەیەکی بەسەرچوو&")).toBe("...بە شێوەیەکی بەسەرچوو");
  expect(safeSoraniEnding("...جەختی لە")).toBe("...جەختی");
});

test("cleanTruncatedTail never leaves a dangling connector, fragment, or &", () => {
  expect(cleanTruncatedTail("...جەختی لە")).toBe("...جەختی");
  expect(cleanTruncatedTail("...کۆتایی قسەیان هەیە ل")).toBe("...کۆتایی قسەیان هەیە");
  expect(cleanTruncatedTail("...بەسەرچوو&")).toBe("...بەسەرچوو");
  expect(cleanTruncatedTail("...school in")).toBe("...school");
  expect(cleanTruncatedTail("...کۆتایی قسەیان هەیە")).toBe("...کۆتایی قسەیان هەیە");
});

test("fitCaption cuts land on a clean word, never a dangling connector", () => {
  // Build a caption whose 1024-char cut would land mid-sentence on "لە".
  const long = "<b>سەرەوە</b>\n\n" + "ئەم ڕاپۆرتە باسی شەڕی ئێران دەکات و جەختی لە ".repeat(60);
  const out = fitCaption(long);
  expect(out.length).toBeLessThanOrEqual(1024);
  // The visible ending must not be a dangling connector or partial word.
  const last = out.replace(/…$/, "").trim().split(/\s+/).pop() ?? "";
  expect(["لە", "و", "بۆ", "ل", "بە", "کە"].includes(last)).toBe(false);
  expect(last.length).toBeGreaterThan(1);
});

test("Sorani headline echoed in the body is stripped (was not guarded)", () => {
  const soraniHead = "ڕووداوی هاتووچۆ بە بەشداریی ئۆتۆمبێلی پۆلیس";
  const body = `${soraniHead} لە شانشینی یەکگرتوو ڕووداوێکی هاتووچۆ بە بەشداریی ئۆتۆمبێلی پۆلیس و ئۆتۆمبێلێک`;
  const out = stripEchoedSoraniHeadline(body, soraniHead);
  expect(out.startsWith(soraniHead)).toBe(false);
  // English headline + Sorani body must pass through untouched (Arabic-script guard).
  expect(stripEchoedSoraniHeadline("US Gold Corp evaluates M&A — کۆمپانیا", "US Gold Corp evaluates M&A")).toBe("US Gold Corp evaluates M&A — کۆمپانیا");
});

test("fuzzy English strip removes a truncated-headline echo", () => {
  const headline = "US says it can hold Strait of Hormuz indefinitely, Hegseth states";
  const echo = headline.slice(0, 48); // the model cut the echo at ~48 chars
  const body = `${echo} — کۆمپانیایەک لە ناوچەکە`;
  const out = stripEchoedEnglishHeadline(body, headline);
  expect(out.startsWith("—")).toBe(true);
  expect(out.includes("Hegseth")).toBe(false);
});

test("stripChannelFooter removes the channel self-mention footer (post #3231)", () => {
  // #3231: the channel's own footer was translated into the body AND captured
  // as the title: "…نەوت Kurdistan24 سەرچاوە کەناڵ #عێراق".
  const text = "عێراق و سعودیە تاوتوێی ئاسایشی وزە و سەقامگیری بازاڕی نەوت Kurdistan24 سەرچاوە کەناڵ #عێراق";
  const out = stripChannelFooter(text, "@Kurdistan24");
  expect(out).toBe("عێراق و سعودیە تاوتوێی ئاسایشی وزە و سەقامگیری بازاڕی نەوت");
  // Trailing footer lines are dropped too.
  expect(stripChannelFooter("بەیاننامەیەک لە وەزارەت\n\nسەرچاوە کەناڵ #ئێران", "@X")).toBe("بەیاننامەیەک لە وەزارەت");
  expect(stripChannelFooter("هەواڵێک\n#ئێران #شەڕ", "@X")).toBe("هەواڵێک");
  // Content is untouched.
  expect(stripChannelFooter("هەواڵێکی ئاسایی لە ناوچەکە", "@X")).toBe("هەواڵێکی ئاسایی لە ناوچەکە");
});

test("stripSourceName also drops a media-ish tail (post #3227 'Mehr News · میدیا')", () => {
  expect(stripSourceName("...و ١٠ کەسیش Mehr News · میدیا", "Mehr News")).toBe("...و ١٠ کەسیش");
  expect(stripSourceName("...سەرەوە Inkstick Media", "Inkstick Media")).toBe("...سەرەوە");
  // A genuine tail that is not source-anchored survives.
  expect(stripSourceName("...و ١٠ کەسیش لە ناوچەکە", "Mehr News")).toBe("...و ١٠ کەسیش لە ناوچەکە");
});

// ── Summary polish (live-post regression, 2026-08-22) ──────────────────────
// The queue on 2026-08-22 held summaries that either rewrote the headline
// ("Iran and the United States are scheduled to hold nuclear talks in Oman
// amid rising tensions." for a headline that said exactly that) or opened
// with filler ("A report states that…"). Pin the deterministic backstop.

test("stripSummaryFiller removes filler openers", () => {
  expect(stripSummaryFiller("A report states that Israel has struck Iran again.")).toBe("Israel has struck Iran again.");
  expect(stripSummaryFiller("It has been reported that the US sanctioned three firms.")).toBe("the US sanctioned three firms.");
  expect(stripSummaryFiller("According to a report, Iran dismissed the sanctions.")).toBe("Iran dismissed the sanctions.");
  expect(stripSummaryFiller("A report described how a deal was reached between Trump and Iran.")).toBe("a deal was reached between Trump and Iran.");
  expect(stripSummaryFiller("The news comes as talks resume in Geneva.")).toBe("talks resume in Geneva.");
  expect(stripSummaryFiller("Iran dismissed the sanctions, according to a report.")).toBe("Iran dismissed the sanctions,");
});

test("isHeadlineReword flags the live one-line rewords but not real briefs", () => {
  // Live queue rows (2026-08-22): summaries that only reworded the headline.
  expect(isHeadlineReword("Iran and the United States are scheduled to hold nuclear talks in Oman amid rising tensions.", "Iran and U.S. to hold nuclear talks in Oman amid tension")).toBe(true);
  expect(isHeadlineReword("Israel strikes Iran again after killing supreme leader - The Canberra Times", "Israel strikes Iran again after killing supreme leader")).toBe(true);
  // The user's GOOD example — a real 3-sentence brief — is never flagged.
  expect(
    isHeadlineReword(
      "The US has sanctioned three Iranian companies accused of supporting Iran's drone program. The Treasury Department said the companies helped procure components for unmanned aircraft. The sanctions block their US-based assets.",
      "US imposes sanctions on three Iranian firms over drone program",
    ),
  ).toBe(false);
  // Thin but genuinely-worded one-liners are not flagged either.
  expect(isHeadlineReword("Iran dismissed sanctions proposed by the United States as 'unprecedented'.", "Iran rejects proposed US sanctions as unprecedented")).toBe(false);
});

test("polishRewriteSummary falls back to the source brief and drops empty rewrites", () => {
  // Reword with a real source body → fall back to the source's first 1-2
  // sentences (richer than a one-liner).
  expect(
    polishRewriteSummary(
      "Iran and the United States are scheduled to hold nuclear talks in Oman amid rising tensions.",
      "Iran and U.S. to hold nuclear talks in Oman amid tension",
      "Iran and the United States are scheduled to hold nuclear talks in Oman amid rising tensions. The Omani foreign ministry confirmed the meeting will take place in Muscat.",
    ),
  ).toBe(
    "Iran and the United States are scheduled to hold nuclear talks in Oman amid rising tensions. The Omani foreign ministry confirmed the meeting will take place in Muscat.",
  );
  // Filler-only rewrite of a headline-only source → dropped (null).
  expect(
    polishRewriteSummary(
      "A report described how a last-minute deal was reached between Donald Trump and Iran.",
      "Trump and Iran reached a last-minute deal",
      "Trump and Iran reached a last-minute deal - ABC News",
    ),
  ).toBe(null);
  // Clean brief passes through untouched.
  expect(
    polishRewriteSummary(
      "The US has sanctioned three Iranian companies accused of supporting Iran's drone program. The Treasury Department said the companies helped procure components for unmanned aircraft.",
      "US imposes sanctions on three Iranian firms over drone program",
      "full body text",
    ),
  ).toBe(
    "The US has sanctioned three Iranian companies accused of supporting Iran's drone program. The Treasury Department said the companies helped procure components for unmanned aircraft.",
  );
});

test("stripSourceName strips a trailing source name followed by a period", () => {
  // Live queue row: the model leaked the outlet at the end of the summary.
  expect(stripSourceName("Iran's military remains intact: acting deputy defence minister The Express Tribune.", "The Express Tribune")).toBe(
    "Iran's military remains intact: acting deputy defence minister",
  );
});
