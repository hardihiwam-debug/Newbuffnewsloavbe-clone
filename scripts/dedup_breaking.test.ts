// Tests for the dedup / classification helpers — imports the REAL functions
// from the pipeline shared module so these guard the exact shipped logic that
// caused the "Mokha/Hormuz reposted 6×" and "everything is 🚨" regressions.

import { test, expect } from "bun:test";
import {
  eventSimilarity,
  isBreaking,
  keywordCategory,
  matchEventCluster,
  sameEvent,
  severityLevel,
} from "../supabase/functions/pipeline/_shared.ts";

test("sameEvent groups two Mokha headlines (location + action boost)", () => {
  expect(sameEvent("Mokha port attack kills four", "al-Mokha killed four in missile strike")).toBe(true);
});

test("sameEvent does not group unrelated same-place stories", () => {
  expect(sameEvent("Iran seizes tanker near Hormuz", "Hormuz shipping rates rise")).toBe(false);
});

test("eventSimilarity ranks same-event pair above unrelated pair", () => {
  const same = eventSimilarity("Mokha port attack kills four", "al-Mokha killed four in missile strike");
  const diff = eventSimilarity("Mokha port attack kills four", "Hormuz shipping rates rise");
  expect(same).toBeGreaterThan(diff);
});

test("routine headline is not breaking", () => {
  expect(isBreaking("usa", "US Allies Frustrated", ["war", "iran", "proxies", "usa"])).toBe(false);
});

test("a real strike is breaking", () => {
  expect(isBreaking("war", "airstrike kills 10 in Gaza", ["war", "iran"])).toBe(true);
});

test("leader statement is breaking even without a strike keyword", () => {
  expect(isBreaking("iran", "Khamenei says Iran will respond", ["iran"])).toBe(true);
});

test("historical discussion of missile attacks is not breaking", () => {
  expect(isBreaking("war", "Iranian officials discuss missile attacks from last year", ["war", "iran"])).toBe(false);
});

test("retrospective about past strikes is not breaking", () => {
  expect(isBreaking("war", "Documentary recalls the airstrikes that killed 10 in 2024", ["war"])).toBe(false);
});

test("fresh strike mentioning last year's war still breaks", () => {
  expect(isBreaking("war", "Iran launches airstrike on Israel tonight after last year's war", ["war"])).toBe(true);
});

test("severity levels escalate", () => {
  expect(severityLevel("nuclear strike on the city")).toBe(3);
  expect(severityLevel("airstrike kills 10")).toBe(2);
  expect(severityLevel("naval deployment reported")).toBe(1);
  expect(severityLevel("routine market update")).toBe(0);
});

test("keywordCategory classifies a non-Iran Gaza strike as war", () => {
  expect(keywordCategory("Israeli airstrike on Gaza kills 12")).toBe("war");
});

test("keywordCategory classifies Hormuz tanker story as oil", () => {
  expect(keywordCategory("oil tanker seized near Hormuz")).toBe("oil");
});

test("matchEventCluster reuses event_id for same incident from another outlet", () => {
  const clusters = [{ event_id: "war-2026-08-15-abc", label: "Mokha port attack kills four", category: "war", post_count: 1 }];
  const matched = matchEventCluster("al-Mokha killed four in missile strike", "war", clusters, 0.52);
  expect(matched?.eventId).toBe("war-2026-08-15-abc");
  expect(matched?.isFollowUp).toBe(true);
});

test("matchEventCluster returns null for an unrelated story", () => {
  const clusters = [{ event_id: "oil-2026-08-15-def", label: "Iran seizes tanker near Hormuz", category: "oil", post_count: 1 }];
  expect(matchEventCluster("Iraqi PM visits Tehran for economic talks", "iran", clusters, 0.52)).toBeNull();
});

test("matchEventCluster ignores clusters from other categories", () => {
  const clusters = [{ event_id: "oil-2026-08-15-def", label: "Mokha port attack kills four", category: "oil", post_count: 1 }];
  expect(matchEventCluster("Mokha port attack kills four", "war", clusters, 0.52)).toBeNull();
});

test("matchEventCluster returns null when no clusters exist", () => {
  expect(matchEventCluster("Mokha port attack kills four", "war", [], 0.52)).toBeNull();
});
