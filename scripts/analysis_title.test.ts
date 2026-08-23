// Tests for whyItMattersTitleBase — the "Why it matters" headline fallback
// must not double the literal model fallback ("WHY IT MATTERS — Why it matters").
import { test, expect } from "bun:test";
import { whyItMattersTitleBase } from "../supabase/functions/pipeline/_shared.ts";

test("keeps a real significance title", () => {
  expect(whyItMattersTitleBase("Hormuz closure risk", "Iran raises Hormuz threat")).toBe("Hormuz closure risk");
});

test("falls back to the story headline when the model title is empty", () => {
  expect(whyItMattersTitleBase("", "Iran raises Hormuz threat")).toBe("Iran raises Hormuz threat");
  expect(whyItMattersTitleBase("   ", "Iran raises Hormuz threat")).toBe("Iran raises Hormuz threat");
});

test("does not double the literal fallback title", () => {
  expect(whyItMattersTitleBase("Why it matters", "Iran raises Hormuz threat")).toBe("Iran raises Hormuz threat");
  expect(whyItMattersTitleBase("  why IT matters ", "Iran raises Hormuz threat")).toBe("Iran raises Hormuz threat");
});
