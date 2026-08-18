// Tests for the multi-bot category-whitelist matcher — imports the REAL
// botMatchesCategories / allCategoriesOf implementations from the pipeline
// shared module.
//
// This is the exact predicate the publish router runs per (chat, article):
// a bot's category whitelist (empty = ALL) vs the article's primary category
// plus every category its source text hits (English + Arabic passes).
import { test, expect } from "bun:test";
import { botMatchesCategories } from "../supabase/functions/pipeline/_shared.ts";

test("empty whitelist matches everything (bot receives all categories)", () => {
  expect(botMatchesCategories([], "war", "Iran strikes a base in Iraq")).toBe(true);
  expect(botMatchesCategories([], "iraq", "anything at all")).toBe(true);
});

test("article primary category alone satisfies the whitelist", () => {
  expect(botMatchesCategories(["iraq"], "iraq", "a source text with no keywords")).toBe(true);
});

test("English secondary category (from source text) satisfies the whitelist", () => {
  // Primary category is iran, but the text also hits the oil block.
  expect(botMatchesCategories(["oil"], "iran", "Tehran threatens tanker traffic in the Strait of Hormuz")).toBe(true);
});

test("Arabic secondary category (from source text) satisfies the whitelist", () => {
  // Primary category is war (instant-channel default), but the Arabic text
  // is an Iraq story — an "iraq" bot must still receive it.
  expect(botMatchesCategories(["iraq"], "war", "مقتل ثلاثة مدنيين في هجوم بقذيفة على أحد أحياء الموصل")).toBe(true);
});

test("no overlap → false (bot skips the article)", () => {
  expect(botMatchesCategories(["gold"], "iraq", "baghdad announces a new pipeline")).toBe(false);
  expect(botMatchesCategories(["oil", "usa"], "proxies", "hezbollah statement about lebanon")).toBe(false);
});

test("partial overlap of a multi-category whitelist → true", () => {
  expect(botMatchesCategories(["iraq", "oil"], "iran", "Tehran hits a refinery near Basra")).toBe(true);
});
