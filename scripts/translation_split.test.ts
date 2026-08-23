// Tests for splitTranslatedPost — the pure helper that splits a Sorani
// translation back into headline + body for titled (web) posts. Guards the
// ckb duplication bug: when the model returned a single block (no \n\n), the
// old inline code routed the WHOLE translation to both fields, so the channel
// showed "<b>full text</b>\n\nfull text". Imports the REAL implementation.
import { test, expect } from "bun:test";
import { splitTranslatedPost } from "../supabase/functions/pipeline/_shared.ts";

const HEADLINE = "Israel strikes Iranian positions near Damascus";
const SUMMARY = "A wave of Israeli strikes hit targets near Damascus overnight, Syrian state media reported.";

test("single-block translation keeps the source headline and uses the whole text as body (no duplication)", () => {
  const whole = "ئێوارەی ئەمڕۆ ئیسرائیل لە نزیک دیمەشق چەند ناوەندێکی ئێرانی بۆردومان کرد. دەزگاکانی راگەیاندنی سووریا ڕایانگەیاند کە بۆردومانەکان بەرەبەیانی ئەمڕۆ بەرامبەر چەند ناوەندێک لە نزیک دیمەشق ڕوویانداوە.";
  const r = splitTranslatedPost(whole, HEADLINE, SUMMARY, false);
  // Headline stays English source; the WHOLE translation is the body — it never
  // appears as both title and body.
  expect(r.headline).toBe(HEADLINE);
  expect(r.summary).toBe(whole);
  expect(r.summary).not.toBe(r.headline);
});

test("split translation (headline\\n\\nbody) uses first block as title, rest as body", () => {
  const first = "ئیسرائیل ناوەندەکانی ئێرانی لە نزیک دیمەشق بۆردومان دەکات";
  const body = "شەپۆلێك لە بۆردومانە ئیسرائیلییەکان ناوەندەکانی لە نزیک دیمەشق کردە ئامانج و دەزگاکانی سووریا ڕایانگەیاند.";
  const r = splitTranslatedPost(`${first}\n\n${body}`, HEADLINE, SUMMARY, false);
  expect(r.headline).toBe(first);
  expect(r.summary).toBe(body);
});

test("untitled Telegram item: whole translation is the body, no headline", () => {
  const text = "دەقەکانی بەرنامەکە لە کەناڵەکەدا هه‌ڵگیراون.";
  const r = splitTranslatedPost(text, HEADLINE, SUMMARY, true);
  expect(r.headline).toBe("");
  expect(r.summary).toBe(text);
});

test("split with an empty body chunk falls back to the source summary (not duplication)", () => {
  const first = "ئیسرائیل ناوەندەکانی ئێرانی بۆردومان دەکات";
  const r = splitTranslatedPost(`${first}\n\n   `, HEADLINE, SUMMARY, false);
  expect(r.headline).toBe(first);
  expect(r.summary).toBe(SUMMARY);
});
