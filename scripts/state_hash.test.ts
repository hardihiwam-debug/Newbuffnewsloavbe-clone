// Tests for the state-hash conditional polling decision (egress fast-win) —
// imports the REAL fingerprintsMatch + serializeStateFingerprint from the
// admin shared module so this guards the exact shipped logic that lets
// unchanged dashboard polls answer with ~100 bytes instead of the full
// payload.
//
// Regression guard: admin_fingerprints() returns a NESTED OBJECT per resource
// (e.g. dashboardSummary = {"bots":"1|…","queue":"39|…",…}), not the flat
// "count|timestamp" strings the original tests assumed — so without
// serializeStateFingerprint the decision never matched and every poll shipped
// the full payload. The "real RPC shape" tests below lock that path.
import { test, expect } from "bun:test";
import { fingerprintsMatch, serializeStateFingerprint } from "../supabase/functions/admin/_shared.ts";

// ── fingerprintsMatch (raw string contract) ────────────────────────────────
test("matching non-empty fingerprint → unchanged (skip the payload)", () => {
  expect(fingerprintsMatch("queue:12|2026-08-19T10:00:00Z", "queue:12|2026-08-19T10:00:00Z")).toBe(true);
});

test("different fingerprint → full fetch", () => {
  expect(fingerprintsMatch("queue:12|2026-08-19T10:00:00Z", "queue:13|2026-08-19T10:01:00Z")).toBe(false);
});

test("first poll (no ifState sent) → full fetch", () => {
  expect(fingerprintsMatch(undefined, "queue:12|2026-08-19T10:00:00Z")).toBe(false);
});

test("empty-string ifState never matches", () => {
  expect(fingerprintsMatch("", "queue:12|2026-08-19T10:00:00Z")).toBe(false);
});

test("non-string values never match", () => {
  expect(fingerprintsMatch(12 as unknown, "queue:12|2026-08-19T10:00:00Z")).toBe(false);
  expect(fingerprintsMatch(null, "queue:12|2026-08-19T10:00:00Z")).toBe(false);
});

test("missing server fingerprint (migration not applied) → full fetch (fail open)", () => {
  expect(fingerprintsMatch("queue:12|2026-08-19T10:00:00Z", undefined)).toBe(false);
  expect(fingerprintsMatch("queue:12|2026-08-19T10:00:00Z", null)).toBe(false);
});

// ── serializeStateFingerprint (REAL RPC shape — the no-op regression) ──────
// The exact shape admin_fingerprints() emits for one resource, as observed on
// the live DB (2026-08-19).
const REAL_DASHBOARD_SUMMARY = {
  bots: "1|2026-08-18 05:46:28.837+00",
  fails: "16|2026-08-17 06:22:25.048535+00",
  polls: "0|",
  queue: "39|2026-08-19 13:20:15.104+00",
  usage: "18|2026-08-19 15:05:21.619305+00",
  activity: "4349|2026-08-19 15:06:00.000+00",
  settings: "1|2026-08-19 14:00:00.000+00",
  published: "120|2026-08-19 14:59:00.000+00",
};

test("REAL shape: nested object serializes to a stable string (not null)", () => {
  const s = serializeStateFingerprint(REAL_DASHBOARD_SUMMARY);
  expect(typeof s).toBe("string");
  expect(s!.length).toBeGreaterThan(0);
  // Deterministic: same object → same string (jsonb key order is stable).
  expect(serializeStateFingerprint(REAL_DASHBOARD_SUMMARY)).toBe(s);
});

test("REAL shape: an unchanged poll (client echoes the serialized string) → __unchanged", () => {
  const fp = serializeStateFingerprint(REAL_DASHBOARD_SUMMARY);
  // The full server decision: sent === serialized current → unchanged.
  expect(fingerprintsMatch(fp, fp)).toBe(true);
});

test("REAL shape: one changed sub-value → different string → full fetch", () => {
  const changed = { ...REAL_DASHBOARD_SUMMARY, queue: "40|2026-08-19 13:21:00.000+00" };
  const sent = serializeStateFingerprint(REAL_DASHBOARD_SUMMARY);
  const cur = serializeStateFingerprint(changed);
  expect(cur).not.toBe(sent);
  expect(fingerprintsMatch(sent, cur)).toBe(false);
});

test("REAL shape: missing resource (migration not applied) → null → full fetch", () => {
  expect(serializeStateFingerprint(undefined)).toBe(null);
  expect(serializeStateFingerprint(null)).toBe(null);
  expect(fingerprintsMatch("anything", null)).toBe(false);
});

test("plain string fingerprints pass through untouched", () => {
  expect(serializeStateFingerprint("queue:12|2026-08-19T10:00:00Z")).toBe("queue:12|2026-08-19T10:00:00Z");
});
