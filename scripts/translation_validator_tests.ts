// Regression tests for the Sorani translation validator — imports the REAL
// function from the pipeline shared module so this guards the exact shipped
// logic that bounced every emoji-prefixed Telegram post (❗️ / ⭕️ carry the
// U+FE0F variation selector) to the English fallback.

import { test, expect } from "bun:test";
import { validateSorani } from "../supabase/functions/pipeline/_shared.ts";

test("valid Sorani translation with Telegram ❗️ emoji passes (variation selector allowed)", () => {
  expect(
    validateSorani(
      "❗️ هێرشەکانی ئیسرائیل بەردەوام بوون بە درێژایی شەودا لە باشووری لوبنان، بەپێی سەرچاوە ناوخۆییەکان",
    ),
  ).toBe(true);
});

test("valid Sorani translation with Telegram ⭕️ emoji passes", () => {
  expect(
    validateSorani(
      "⭕️ بەپێی سەرچاوە ناوخۆییەکان، شاندێکی یوونیسێف گەیشتووە بۆ ماڵە گەمارۆدراوەکە لە قوسرا، باشووری نابلوس",
    ),
  ).toBe(true);
});

test("valid Sorani translation with UPDATE prefix + emoji passes", () => {
  expect(
    validateSorani("UPDATE — ❗️ وەزیری جەنگی ئیسرائیل بەڵێنی تۆڵەسەندنەوە دەدات لە باشووری لوبنان"),
  ).toBe(true);
});

test("plain Sorani translation (no emoji) passes", () => {
  expect(
    validateSorani("بەپێی ڕاپۆرتێک، ئیدیعایەکی هەڵە دەربارەی چالاکییە ئەتۆمییەکانی ئێران بڵاوبووەتەوە"),
  ).toBe(true);
});

test("Sorani keeps Latin proper nouns (Israel, place names) without rejection", () => {
  expect(
    validateSorani(
      "هێرشەکانی ئیسرائیل بە درێژایی شەودا لە لوبنان بەردەوام بوون، بەپێی سەرچاوەکانی کەناڵی ئەلمەنار لە دەوروبەری عەلی ئەلتاهیر و قەنترا",
    ),
  ).toBe(true);
});

test("English output is rejected", () => {
  expect(validateSorani("Israeli attacks continued across southern Lebanon overnight")).toBe(false);
});

test("Latin-transliterated Kurdish output is rejected", () => {
  expect(validateSorani("Hewshakani Israeil bardawam bun bi drêjayî şewda le başûrî Lubnan")).toBe(false);
});

test("empty / whitespace-only output is rejected", () => {
  expect(validateSorani("")).toBe(false);
  expect(validateSorani("   ")).toBe(false);
});
