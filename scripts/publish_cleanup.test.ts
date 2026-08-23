// Tests for the two mechanical publish bugs fixed after the channel audit:
//  1. glossary leak — the "TRANSLATION GLOSSARY — …" instruction (or a Kurdish
//     rendering of it) was echoed into the published body by the model;
//  2. duplication — the model echoed the headline as the body's first
//     paragraph, or repeated a paragraph verbatim.
// Imports the REAL implementations from _shared.ts.
import { test, expect } from "bun:test";
import { dedupePostBody, parseGlossaryEntries, stripGlossaryLeak } from "../supabase/functions/pipeline/_shared.ts";

const GLOSSARY = [
  "Iran = ئێران",
  "Iraq = عێراق",
  "Israel = ئیسرائیل",
  "United States = ویلایەتە یەکگرتووەکان",
  "Oil price = نرخی نەوت",
].join("\n");

const STORY = "دەزگاکانی ڕاگەیاندنی ئێران ڕایانگەیاند کە وتووێژەکانی نەوت لەگەڵ عێراق بەردەوامە.";

// ── stripGlossaryLeak ──────────────────────────────────────────────────────

test("strips a Kurdish glossary header + echoed entries before the translation", () => {
  const input = `فەرهەنگی وەرگێڕان — ئەم وەرگێڕانە وردانە بۆ وشە گرنگەکان بەکاربهێنە: Iran = ئێران Iraq = عێراق\n\n${STORY}`;
  expect(stripGlossaryLeak(input, GLOSSARY, "Iran and Iraq")).toBe(STORY);
});

test("strips self-mapping glossary echoes (term re-translated to itself)", () => {
  const input = `ئێران = ئێران نرخی نەوت = نرخی نەوت\n\n${STORY}`;
  expect(stripGlossaryLeak(input, GLOSSARY, "Iran oil")).toBe(STORY);
});

test("strips the English glossary header and sent entries", () => {
  const input = `TRANSLATION GLOSSARY — use these exact translations for key terms:\nIran = ئێران\nIraq = عێراق\n\n${STORY}`;
  expect(stripGlossaryLeak(input, GLOSSARY, "Iran and Iraq")).toBe(STORY);
});

test("strips a Kurdish header with a self-mapping entry on the same line", () => {
  const input = `چاوگ: وەرگێڕانی وشە گرنگەکان … ویلایەتە یەکگرتووەکان = ویلایەتە یەکگرتووەکان\n\n${STORY}`;
  expect(stripGlossaryLeak(input, GLOSSARY, "United States")).toBe(STORY);
});

test("strips a bare Kurdish 'translation' header with a self-mapping entry", () => {
  const input = `ئەندازەی وەرگێڕان … ئیسرائیل = ئیسرائیل\n\n${STORY}`;
  expect(stripGlossaryLeak(input, GLOSSARY, "Israel")).toBe(STORY);
});

test("leaves a normal translation untouched", () => {
  const input = "بەغدا ڕایگەیاند کە هێرشەکە بەرپەرچ دراوە.";
  expect(stripGlossaryLeak(input, GLOSSARY, "Iran")).toBe(input);
});

test("glossary-only garbage output collapses to empty", () => {
  const input = "فەرهەنگی وەرگێڕان — Iran = ئێران";
  expect(stripGlossaryLeak(input, GLOSSARY, "Iran").trim()).toBe("");
});

// ── parseGlossaryEntries ───────────────────────────────────────────────────

test("parseGlossaryEntries splits term and translation and merges continuations", () => {
  const entries = parseGlossaryEntries("Iran = ئێران\nدەوڵەت\nIraq: عێراق");
  expect(entries).toEqual([
    { term: "Iran", translation: "ئێران دەوڵەت", text: "Iran = ئێران دەوڵەت" },
    { term: "Iraq", translation: "عێراق", text: "Iraq: عێراق" },
  ]);
});

// ── dedupePostBody ─────────────────────────────────────────────────────────

test("drops a body paragraph that exactly restates the headline", () => {
  const headline = "ئیسرائیل ناوەندەکانی ئێرانی بۆردومان دەکات";
  const body = "دەزگاکانی سووریا ڕایانگەیاند کە بۆردومانەکان لە نزیک دیمەشق ڕوویانداوە.";
  expect(dedupePostBody(`${headline}\n\n${body}`, headline)).toBe(body);
});

test("collapses a paragraph the model repeated verbatim", () => {
  const para = "شەپۆلێك لە بۆردومانەکان ناوەندەکانی نزیک دیمەشق کردە ئامانج.";
  expect(dedupePostBody(`${para}\n\n${para}\n\n${para}`, "")).toBe(para);
});

test("keeps distinct paragraphs in order", () => {
  const a = "خاڵی یەکەم.";
  const b = "خاڵی دووەم.";
  expect(dedupePostBody(`${a}\n\n${b}`, "")).toBe(`${a}\n\n${b}`);
});

test("headline restatement is only dropped when it is the FIRST block", () => {
  const headline = "سەرنووسە";
  const body = "دەقی ڕاستەقینەی هەواڵەکە.";
  expect(dedupePostBody(`${body}\n\n${headline}`, headline)).toBe(`${body}\n\n${headline}`);
});
