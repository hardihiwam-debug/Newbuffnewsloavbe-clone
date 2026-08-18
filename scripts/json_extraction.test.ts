// Regression tests for extractFirstJsonObject — guards the exact parsing bug
// that made "AI rewrite failed on all providers" when Llama appended trailing
// prose (or a second object) after a valid JSON payload.

import { test, expect } from "bun:test";
import { extractFirstJsonObject } from "../supabase/functions/pipeline/_shared.ts";

test("extracts a clean object from trailing prose", () => {
  const raw = '{"1":{"headline":"Iran says..."}} Sure! Here you go.';
  expect(extractFirstJsonObject(raw)).toBe('{"1":{"headline":"Iran says..."}}');
});

test("extracts the FIRST of two concatenated objects", () => {
  const raw = '{"a":1}{"b":2}';
  expect(extractFirstJsonObject(raw)).toBe('{"a":1}');
});

test("handles braces and quotes inside string values", () => {
  const raw = '{"headline":"Iran says \\"hello\\" {x}","summary":"a } b"}\nHope this helps!';
  expect(extractFirstJsonObject(raw)).toBe('{"headline":"Iran says \\"hello\\" {x}","summary":"a } b"}');
});

test("returns null when there is no object", () => {
  expect(extractFirstJsonObject("no json here")).toBe(null);
});

test("returns null for an unterminated object", () => {
  expect(extractFirstJsonObject('{"a":1')).toBe(null);
});

test("extracts from code-fenced content with leading text", () => {
  const raw = "```json\n{\"verdict\":\"duplicate\",\"reason\":\"same event\"}\n```";
  expect(extractFirstJsonObject(raw)).toBe('{"verdict":"duplicate","reason":"same event"}');
});
