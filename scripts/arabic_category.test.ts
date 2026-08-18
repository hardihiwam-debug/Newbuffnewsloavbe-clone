// Tests for the Arabic-aware category classifier — imports the REAL
// implementation from the pipeline shared module (not a mirror).
//
// Why this matters: the instant Telegram channels the operator follows post
// in Arabic, and the English keyword blocks never match them. Without this
// pass every Arabic post defaulted to "war", so a category-specific bot
// subscribed to e.g. "iraq" or "oil" never received Arabic stories about
// those topics.
import { test, expect } from "bun:test";
import { keywordCategory, allCategoriesOf } from "../supabase/functions/pipeline/_shared.ts";

test("Arabic Iraq strike classifies as iraq", () => {
  expect(keywordCategory("مقتل ثلاثة مدنيين في هجوم بقذيفة على أحد أحياء الموصل")).toBe("iraq");
});

test("Arabic Iraq story routes to iraq + proxies + war", () => {
  const cats = allCategoriesOf("الحشد الشعبي يعلن قصف قاعدة أمريكية في بغداد");
  expect(cats).toContain("iraq");
  expect(cats).toContain("proxies");
  expect(cats).toContain("war");
});

test("Arabic Houthi story classifies as proxies (proxy beats strike)", () => {
  expect(keywordCategory("الحوثيون يعلنون استهداف سفينة حربية أمريكية في البحر الأحمر")).toBe("proxies");
});

test("Arabic Iran missile threat classifies as war", () => {
  expect(keywordCategory("طهران تهدد بصواريخ باليستية ردا على أي هجوم إسرائيلي")).toBe("war");
});

test("Arabic Israel/Gaza strike classifies as war, not middle-east", () => {
  expect(keywordCategory("غارات إسرائيلية مكثفة على قطاع غزة فجر اليوم")).toBe("war");
});

test("Arabic Hormuz tanker story matches oil + war for routing", () => {
  const cats = allCategoriesOf("استهداف ناقلة نفط في مضيق هرمز");
  expect(cats).toContain("oil");
  expect(cats).toContain("war");
  expect(keywordCategory("استهداف ناقلة نفط في مضيق هرمز")).toBe("war");
});

test("Arabic plain Iran mention classifies as iran", () => {
  expect(keywordCategory("اجتماع في طهران لبحث الملف النووي")).toBe("iran");
});

test("Arabic USA story (Iran-linked) routes to usa", () => {
  const cats = allCategoriesOf("واشنطن تفرض عقوبات جديدة على إيران");
  expect(cats).toContain("usa");
  expect(cats).toContain("economic-impact");
  expect(keywordCategory("واشنطن تفرض عقوبات جديدة على إيران")).toBe("economic-impact");
});

test("English behavior is unchanged by the Arabic pass", () => {
  expect(keywordCategory("Iran fires missiles at Tel Aviv overnight")).toBe("war");
  const cats = allCategoriesOf("Baghdad strike by Kataib Hezbollah");
  expect(cats).toEqual(expect.arrayContaining(["iraq", "war", "proxies"]));
  expect(keywordCategory("US approves new sanctions against Tehran")).toBe("economic-impact");
});

test("unrelated Arabic text stays unclassified (falls through to existing fallbacks)", () => {
  expect(keywordCategory("مهرجان للزهور يعرض تشكيلات ملونة في الحديقة العامة")).toBeNull();
});

test("non-Iran Arabic regional news classifies as middle-east (not war)", () => {
  expect(keywordCategory("تصريح من الرياض حول التعاون الخليجي المشترك")).toBe("middle-east");
  const cats = allCategoriesOf("الرياض تستضيف اجتماعا خليجيا حول الأوضاع في المنطقة");
  expect(cats).toContain("middle-east");
  expect(cats).not.toContain("war");
});

test("non-Iran Arabic war story still classifies as war", () => {
  expect(keywordCategory("غارات جوية على مواقع في اليمن فجر اليوم")).toBe("war");
  const cats = allCategoriesOf("اشتباكات عنيفة في درعا بسوريا");
  expect(cats).toContain("war");
});
