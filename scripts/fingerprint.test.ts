// Regression tests for the event-fingerprint dedup layer — imports the REAL
// functions from the pipeline shared module so this guards the exact shipped
// logic that catches rephrased same-event coverage ("US strikes western Yemen
// overnight" vs "American aircraft hit Houthi positions in Yemen") which the
// token-similarity layer misses, while never merging genuinely different
// events that merely share an actor or a country.

import { test, expect } from "bun:test";
import {
  fingerprintArticle,
  fingerprintMatch,
  sameEventFingerprint,
  matchPublishedFingerprint,
  type EventFingerprint,
} from "../supabase/functions/pipeline/_shared.ts";

const same = (a: string, b: string) => sameEventFingerprint(fingerprintArticle(a), fingerprintArticle(b));
const diff = (a: string, b: string) => !sameEventFingerprint(fingerprintArticle(a), fingerprintArticle(b));

// ── True positives: the rephrased same-event pairs similarity misses ────────
test("false-split pair merges: US strikes western Yemen vs American aircraft hit Houthi positions", () => {
  expect(same("US strikes western Yemen overnight", "American aircraft hit Houthi positions in Yemen")).toBe(true);
});

test("false-split pair merges: Mokha port attack kills four vs al-Mokha killed four in missile strike", () => {
  expect(same("Mokha port attack kills four", "al-Mokha killed four in missile strike")).toBe(true);
});

test("identical headline merges", () => {
  expect(same("Israeli strikes hit Hezbollah depot near Beirut", "Israeli strikes hit Hezbollah depot near Beirut")).toBe(true);
});

test("Arabic rephrase merges: American airstrikes on Houthis in Yemen", () => {
  expect(same("غارات أمريكية على الحوثيين في اليمن", "طائرات أمريكية تقصف مواقع الحوثيين باليمن")).toBe(true);
});

test("missiles fired at Tel Aviv merges with missile attack on Tel Aviv", () => {
  expect(same("missiles fired at Tel Aviv", "missile attack on Tel Aviv, several injured")).toBe(true);
});

test("fingerprint match through the row-level helper (published_history rows)", () => {
  const candidate = fingerprintArticle("US strikes western Yemen overnight");
  const published = [{ headline: "American aircraft hit Houthi positions in Yemen", summary: "Multiple airstrikes reported" }];
  expect(matchPublishedFingerprint(candidate, published)).toBe(true);
});

test("row-level helper prefers english_headline when present", () => {
  const candidate = fingerprintArticle("US strikes western Yemen overnight");
  const published = [
    { headline: "Coverage of the Yemen war continues", english_headline: "American aircraft hit Houthi positions in Yemen" },
  ];
  expect(matchPublishedFingerprint(candidate, published)).toBe(true);
});

// ── True negatives: different events that share an actor/place must not merge
test("false-merge pair stays apart: Iran missile production facility vs Iran tests missile near Hormuz", () => {
  expect(diff("Iran announces new missile production facility", "Iran tests new missile near Hormuz")).toBe(true);
});

test("Iran-only overlap does not merge", () => {
  expect(diff("Iran warns the United States over sanctions", "Iran opens new trade route with Iraq")).toBe(true);
});

test("same country, different action does not merge (Gaza ceasefire vs Gaza strike)", () => {
  expect(diff("Gaza ceasefire talks resume in Cairo", "Israeli strike on Gaza kills three")).toBe(true);
});

test("same actor+action but different target does not merge", () => {
  expect(diff("US strikes Houthi positions in Yemen", "US strikes Hezbollah targets in Lebanon")).toBe(true);
});

test("satellite launch must not look like a strike", () => {
  expect(diff("Iran launches satellite into orbit", "Iran launches missile strike on base")).toBe(true);
});

// ── Extraction sanity ───────────────────────────────────────────────────────
test("extraction: US strikes Houthi positions → actor usa, target houthi, action strike, location yemen", () => {
  const fp = fingerprintArticle("US strikes Houthi positions in Yemen");
  expect(fp.actors).toContain("usa");
  expect(fp.targets).toContain("houthi");
  expect(fp.action).toBe("strike");
  expect(fp.location).toBe("yemen");
});

test("lone target-biased entity stays a target, not an actor (conservative)", () => {
  const fp = fingerprintArticle("Houthis strike Tel Aviv");
  expect(fp.actors).toEqual([]);
  expect(fp.targets).toEqual(["houthi"]);
  expect(fp.action).toBe("strike");
  expect(fp.specificLocation).toBe("telaviv");
});

test("matchPublishedFingerprint fast path: precomputed fingerprint list", () => {
  const candidate = fingerprintArticle("US strikes western Yemen overnight");
  const published = [fingerprintArticle("American aircraft hit Houthi positions in Yemen", "Multiple airstrikes reported")];
  expect(matchPublishedFingerprint(candidate, published)).toBe(true);
});

test("extraction: specific location mokha is captured", () => {
  const fp = fingerprintArticle("Mokha port attack kills four");
  expect(fp.specificLocation).toBe("mokha");
  expect(fp.action).toBe("strike");
  expect(fp.result).toBe("casualties");
  expect(fp.casualties).toContain("4");
});

test("extraction: weapon captured", () => {
  const fp = fingerprintArticle("Iran tests new missile near Hormuz");
  expect(fp.weapon).toBe("missile");
  expect(fp.action).toBe("test");
  expect(fp.specificLocation).toBe("hormuz");
});

test("extraction: empty title yields empty fingerprint, never crashes", () => {
  const fp = fingerprintArticle("", "");
  expect(fp.actors).toEqual([]);
  expect(fp.action).toBeNull();
  expect(fingerprintMatch(fp, fingerprintArticle("US strikes Yemen"))).toBe(0);
  expect(sameEventFingerprint(fp, fingerprintArticle("US strikes Yemen"))).toBe(false);
});

test("timeBucket is filled from publishedAt and null without it", () => {
  const withTs = fingerprintArticle("US strikes Yemen", "", "2026-08-18T14:30:00Z");
  expect(withTs.timeBucket).toBe("2026-08-18T14");
  expect(fingerprintArticle("US strikes Yemen").timeBucket).toBeNull();
});

test("matchPublishedFingerprint returns false for unrelated published rows", () => {
  const candidate = fingerprintArticle("Iran opens new trade route with Iraq");
  const published = [{ headline: "American aircraft hit Houthi positions in Yemen" }];
  expect(matchPublishedFingerprint(candidate, published)).toBe(false);
});

// ── Score stability guard ───────────────────────────────────────────────────
test("fingerprintMatch is symmetric", () => {
  const a = fingerprintArticle("US strikes western Yemen overnight");
  const b = fingerprintArticle("American aircraft hit Houthi positions in Yemen");
  expect(fingerprintMatch(a, b)).toBeCloseTo(fingerprintMatch(b, a), 5);
});
