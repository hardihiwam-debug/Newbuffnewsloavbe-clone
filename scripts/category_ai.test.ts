// Tests for the AI-assisted category gate — the pure decision helpers that
// decide WHEN the pipeline asks the model (categoryNeedsAi) and whether the
// model's answer is trusted (normalizeAiCategory). Imports the REAL
// implementations from the pipeline shared module.
//
// Design contract (locked here):
//   - 0 keyword matches            → ambiguous → ask AI (rescues items that
//                                     would otherwise be dropped/defaulted)
//   - 1 match, generic bucket      → ambiguous → ask AI (iran / war /
//                                     middle-east could be several stories)
//   - 1 match, specific bucket     → confident keyword routing, no AI
//   - 2+ matches                   → confident keyword routing, no AI
//   - model answers are whitelisted against ALLOWED_CATEGORIES; anything
//     else is rejected (never inserted into the queue raw).
import { test, expect } from "bun:test";
import {
  ALLOWED_CATEGORIES,
  categoryNeedsAi,
  keywordCategory,
  normalizeAiCategory,
} from "../supabase/functions/pipeline/_shared.ts";

test("ALLOWED_CATEGORIES is the full canonical set including the new conflict regions", () => {
  expect(ALLOWED_CATEGORIES).toEqual(
    expect.arrayContaining(["gaza", "syria", "lebanon"]),
  );
  expect(ALLOWED_CATEGORIES).toHaveLength(13);
});

test("0 keyword matches is ambiguous (would be dropped/defaulted otherwise)", () => {
  // Nothing matches any English or Arabic keyword block.
  expect(categoryNeedsAi("A quiet day at the office for regional traders")).toBe(true);
  expect(categoryNeedsAi("مهرجان للزهور يعرض تشكيلات ملونة في الحديقة العامة")).toBe(true);
});

test("single generic bucket (iran) is ambiguous", () => {
  // Tehran mention with no specific theme → could be war/proxies/plain iran.
  expect(categoryNeedsAi("اجتماع في طهران لبحث الملف النووي")).toBe(true);
  expect(categoryNeedsAi("Iranian officials meet in Tehran today")).toBe(true);
});

test("single generic bucket (war) is ambiguous", () => {
  // Severity word with no region → could be gaza/syria/lebanon/etc.
  expect(categoryNeedsAi("طهران تهدد بصواريخ باليستية ردا على أي هجوم إسرائيلي")).toBe(true);
});

test("single generic bucket (middle-east) is ambiguous", () => {
  expect(categoryNeedsAi("تصريح من الرياض حول التعاون الخليجي المشترك")).toBe(true);
});

test("single SPECIFIC bucket is confident keyword routing — no AI", () => {
  expect(categoryNeedsAi("Baghdad announces a new pipeline investment")).toBe(false); // iraq
  expect(categoryNeedsAi("Gold reserves surge as Tehran moves assets")).toBe(false); // gold
  expect(categoryNeedsAi("مؤتمر صحفي في أربيل حول الاستثمار")).toBe(false); // iraq
  expect(categoryNeedsAi("استهداف ناقلة نفط في مضيق هرمز")).toBe(false); // oil + war
});

test("2+ matches are confident — no AI", () => {
  expect(categoryNeedsAi("Israeli airstrike on Gaza school kills 12")).toBe(false); // gaza+war+middle-east
  expect(categoryNeedsAi("الحشد الشعبي يعلن قصف قاعدة أمريكية في بغداد")).toBe(false); // iraq+proxies+war
});

test("normalizeAiCategory whitelists exactly the canonical set", () => {
  expect(normalizeAiCategory("gaza")).toBe("gaza");
  expect(normalizeAiCategory("  GAZA  ")).toBe("gaza");
  expect(normalizeAiCategory("Syria")).toBe("syria");
  expect(normalizeAiCategory("middle-east")).toBe("middle-east");
  expect(normalizeAiCategory("economic-impact")).toBe("economic-impact");
  expect(normalizeAiCategory("hack the planet")).toBeNull();
  expect(normalizeAiCategory("iran war")).toBeNull();
  expect(normalizeAiCategory("")).toBeNull();
  expect(normalizeAiCategory("gaza strip ceasefire")).toBeNull();
});

test("new conflict regions classify via keywords as their own category", () => {
  expect(keywordCategory("Israeli troops shoot children in Rafah")).toBe("gaza");
  expect(keywordCategory("Turkish airstrike hits Kurdish positions in northern Syria")).toBe("syria");
  expect(keywordCategory("Hezbollah fires rockets at northern Israel")).toBe("lebanon");
  expect(keywordCategory("Houthis target a US warship in the Red Sea")).toBe("proxies");
});
