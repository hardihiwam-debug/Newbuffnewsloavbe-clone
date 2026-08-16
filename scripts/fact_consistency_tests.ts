// Phase-2 tests: fact-consistency guards (numbers, digits, update prefix,
// breaking age gate) — pure helpers from the pipeline shared module. These
// guard the exact shipped logic that prevents "12 killed → 15 killed"
// hallucination and stale-keyword breaking.

import { test, expect } from "bun:test";
import {
  buildUpdateHeadline,
  checkDigitPreservation,
  checkNumberConsistency,
  extractFactFigures,
  isBreaking,
} from "../supabase/functions/pipeline/_shared.ts";

test("extractFactFigures parses numbers with countable units", () => {
  const figures = extractFactFigures("12 killed and 3 missiles fired, 45% capacity, 1,000 barrels");
  expect(figures).toContainEqual({ value: "12", unit: "killed" });
  expect(figures).toContainEqual({ value: "3", unit: "missiles" });
  expect(figures).toContainEqual({ value: "45", unit: "percent" });
  expect(figures).toContainEqual({ value: "1000", unit: "barrels" });
});

test("checkNumberConsistency passes when figures are preserved", () => {
  const check = checkNumberConsistency(
    "Iran says 12 people killed and 3 missiles struck the base",
    "Iran said 12 people were killed and 3 missiles hit the base",
  );
  expect(check.ok).toBe(true);
  expect(check.mismatches).toEqual([]);
});

test("checkNumberConsistency rejects a changed figure", () => {
  const check = checkNumberConsistency("Officials report 12 killed", "Officials report 15 killed");
  expect(check.ok).toBe(false);
  expect(check.mismatches.join(" ")).toContain("15 killed");
});

test("checkNumberConsistency rejects an invented countable figure", () => {
  const check = checkNumberConsistency("Iran launched a missile barrage", "Iran launched 3 missiles in a barrage");
  expect(check.ok).toBe(false);
});

test("checkNumberConsistency treats 45% and 45 percent as equal", () => {
  expect(checkNumberConsistency("capacity at 45 percent", "capacity at 45%").ok).toBe(true);
});

test("checkDigitPreservation passes when digits survive translation", () => {
  const check = checkDigitPreservation("12 killed, 3 missiles", "12 کوژران، 3 موشک");
  expect(check.ok).toBe(true);
});

test("checkDigitPreservation flags a mistranslated digit", () => {
  const check = checkDigitPreservation("12 killed", "15 کوژران");
  expect(check.ok).toBe(false);
  expect(check.missing).toContain("15");
});

test("buildUpdateHeadline prefixes once and is idempotent", () => {
  expect(buildUpdateHeadline("US says no damage", "UPDATE — ")).toBe("UPDATE — US says no damage");
  expect(buildUpdateHeadline("UPDATE — US says no damage", "UPDATE — ")).toBe("UPDATE — US says no damage");
});

test("isBreaking rejects stale stories regardless of keywords", () => {
  expect(isBreaking("war", "airstrike kills 10 in Gaza", ["war"], 12, 8)).toBe(false);
  expect(isBreaking("war", "airstrike kills 10 in Gaza", ["war"], 2, 8)).toBe(true);
});

test("isBreaking without age info still breaks on a real strike", () => {
  expect(isBreaking("war", "airstrike kills 10 in Gaza", ["war"])).toBe(true);
});
