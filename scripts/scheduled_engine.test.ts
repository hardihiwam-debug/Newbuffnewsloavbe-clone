// Tests for the scheduled-posts engine's pure time math — imports the REAL
// helpers from supabase/functions/scheduled/_shared.ts so this guards the
// exact shipped scheduling logic (series part slots, recurring cadences,
// due-item selection, override behavior).
//
// All expected values use Asia/Baghdad = UTC+3 (no DST). 2026-08-20 is a
// Thursday; 20:00 Baghdad == 17:00Z. Aug 20 + 29 days = Sep 18 (the classic
// "30-part daily Seerah starting Aug 20 → part 30 on Sep 18" case).

import { test, expect } from "bun:test";
import {
  computeDueItems,
  nextLocalOccurrence,
  nextWeekdayAfter,
  recurringNextDueMs,
  seriesPartDueMs,
  seriesTerminalStatus,
  type CampaignConfig,
  type ItemLike,
} from "../supabase/functions/scheduled/_shared.ts";

const TZ = "Asia/Baghdad";
const P1 = Date.parse("2026-08-20T17:00:00Z"); // part 1 slot (Thu 20:00 Baghdad)
const DAY = 86_400_000;
const now = Date.parse("2026-08-19T00:00:00Z"); // before the series starts

// ── Series: daily ──────────────────────────────────────────────────────────
test("daily series: part N = start + (N-1) days, anchored at the send time", () => {
  const sched = { cadence: "daily", times: ["20:00"] };
  expect(seriesPartDueMs(0, P1, sched, TZ, null, now)).toBe(P1);
  expect(seriesPartDueMs(1, P1, sched, TZ, null, now)).toBe(P1 + DAY);
  // The 30-part example: Part 30 (index 29) lands Sep 18.
  expect(seriesPartDueMs(29, P1, sched, TZ, null, now)).toBe(Date.parse("2026-09-18T17:00:00Z"));
});

test("daily series never fires a part before start_at", () => {
  // start_at is 02:00 Baghdad (Aug 21 local) — the first 20:00 slot after it
  // is Aug 21, and part 2 follows on Aug 22.
  const start = Date.parse("2026-08-20T23:00:00Z");
  const sched = { cadence: "daily", times: ["20:00"] };
  expect(seriesPartDueMs(0, start, sched, TZ, null, now)).toBe(Date.parse("2026-08-21T17:00:00Z"));
  expect(seriesPartDueMs(1, start, sched, TZ, null, now)).toBe(Date.parse("2026-08-22T17:00:00Z"));
});

test("weekly series: part 2 is exactly 7 days after part 1", () => {
  const sched = { cadence: "weekly", times: ["20:00"] };
  expect(seriesPartDueMs(0, P1, sched, TZ, null, now)).toBe(P1);
  expect(seriesPartDueMs(1, P1, sched, TZ, null, now)).toBe(P1 + 7 * DAY);
});

test("custom-interval series: interval_days spacing", () => {
  const sched = { cadence: "custom", interval_days: 3, times: ["20:00"] };
  expect(seriesPartDueMs(0, P1, sched, TZ, null, now)).toBe(P1);
  expect(seriesPartDueMs(1, P1, sched, TZ, null, now)).toBe(P1 + 3 * DAY);
});

test("manual series uses the item's own scheduled_for", () => {
  const sched = { cadence: "manual" };
  expect(seriesPartDueMs(2, P1, sched, TZ, Date.parse("2026-09-05T12:00:00Z"), now)).toBe(Date.parse("2026-09-05T12:00:00Z"));
  expect(seriesPartDueMs(2, P1, sched, TZ, null, now)).toBe(null);
});

// ── Series: selected days (strictly-after, no shared slots) ────────────────
test("selected-days series: first part can land on start day, later parts strictly after", () => {
  const sched = { cadence: "selected_days", weekdays: [4], times: ["20:00"] }; // Thursdays only
  // start_at = midnight UTC Thu Aug 20 → part 1 same day 20:00 Baghdad.
  const start = Date.parse("2026-08-20T00:00:00Z");
  expect(seriesPartDueMs(0, start, sched, TZ, null, now)).toBe(P1);
  // part 2 must be the NEXT Thursday, never the same instant again.
  expect(seriesPartDueMs(1, start, sched, TZ, null, now)).toBe(Date.parse("2026-08-27T17:00:00Z"));
  expect(seriesPartDueMs(2, start, sched, TZ, null, now)).toBe(Date.parse("2026-09-03T17:00:00Z"));
});

test("nextWeekdayAfter is strictly after fromMs", () => {
  // From the Thursday 20:00 slot, the next Thursday is a week later — never
  // the same slot (the at-or-after case is the caller's -1ms nudge).
  expect(nextWeekdayAfter(P1, [4], "20:00", TZ)).toBe(P1 + 7 * DAY);
  expect(nextWeekdayAfter(P1 - 1, [4], "20:00", TZ)).toBe(P1);
});

test("nextLocalOccurrence finds the next wall-clock time", () => {
  expect(nextLocalOccurrence(Date.parse("2026-08-20T00:00:00Z"), "20:00", TZ)).toBe(P1);
  // 21:00 Baghdad (18:00Z) is after the 20:00 slot → next day.
  expect(nextLocalOccurrence(Date.parse("2026-08-20T18:00:00Z"), "20:00", TZ)).toBe(P1 + DAY);
});

// ── Recurring ──────────────────────────────────────────────────────────────
test("recurring daily: next send is strictly after the last send", () => {
  const sched = { frequency: "daily", times: ["20:00"] };
  // Last send exactly at the 20:00 slot → next is tomorrow, never the same instant.
  expect(recurringNextDueMs(P1, Date.parse("2026-08-10T00:00:00Z"), null, sched, TZ, P1)).toBe(P1 + DAY);
  // Last send mid-morning → today's 20:00 still qualifies.
  expect(recurringNextDueMs(Date.parse("2026-08-20T06:00:00Z"), Date.parse("2026-08-10T00:00:00Z"), null, sched, TZ, now)).toBe(P1);
});

test("recurring weekly with weekdays uses strictly-after weekday math", () => {
  const sched = { frequency: "weekly", weekdays: [4], times: ["20:00"] };
  expect(recurringNextDueMs(P1, Date.parse("2026-08-10T00:00:00Z"), null, sched, TZ, now)).toBe(P1 + 7 * DAY);
});

test("recurring custom counts from start_at on the first send, then from last send", () => {
  const sched = { frequency: "custom", interval_days: 3, times: ["20:00"] };
  const start = Date.parse("2026-08-17T00:00:00Z");
  // First send = start + 3d at 20:00 Baghdad (Aug 20 17:00Z), even though
  // "now" is Aug 19 — it must not count from now.
  expect(recurringNextDueMs(null, start, null, sched, TZ, Date.parse("2026-08-19T00:00:00Z"))).toBe(P1);
  // After that send, next = +3d.
  expect(recurringNextDueMs(P1, start, null, sched, TZ, P1 + DAY)).toBe(P1 + 3 * DAY);
});

test("recurring respects end_at (null when the next slot is past the end)", () => {
  const sched = { frequency: "daily", times: ["20:00"] };
  const end = P1 + DAY - 1; // ends before tomorrow's slot
  expect(recurringNextDueMs(P1, Date.parse("2026-08-10T00:00:00Z"), end, sched, TZ, now)).toBe(null);
});

// ── computeDueItems (cycle-level selection) ────────────────────────────────
const baseCampaign: CampaignConfig = {
  kind: "series",
  start_at: "2026-08-20T17:00:00Z",
  timezone: TZ,
  schedule: { cadence: "daily", times: ["20:00"] },
};

function items(...parts: Array<Partial<ItemLike> & { position: number }>): ItemLike[] {
  return parts.map((p) => ({
    status: "pending",
    attempts: 0,
    force_due: false,
    scheduled_for: null,
    ...p,
  }));
}

test("series: only the next unsent part is due, and only once its slot passes", () => {
  const pending = items({ position: 1 }, { position: 2 }, { position: 3 });
  // Before part 1's slot (now = Aug 19) → nothing due.
  expect(computeDueItems({ campaign: baseCampaign, items: pending, nowMs: now, lastSentAtMs: null })).toEqual([]);
  // At/after part 1's slot → exactly part 1.
  const due = computeDueItems({ campaign: baseCampaign, items: pending, nowMs: P1, lastSentAtMs: null });
  expect(due.map((d) => d.position)).toEqual([1]);
});

test("series: parts 1+2 both past their slots → only the next one is due", () => {
  const pending = items({ position: 1 }, { position: 2 }, { position: 3 });
  const due = computeDueItems({ campaign: baseCampaign, items: pending, nowMs: P1 + 2 * DAY, lastSentAtMs: null });
  expect(due.map((d) => d.position)).toEqual([1]);
});

test("series: a forced item makes the whole pending run due", () => {
  const pending = items({ position: 1 }, { position: 2, force_due: true });
  const due = computeDueItems({ campaign: baseCampaign, items: pending, nowMs: now, lastSentAtMs: null });
  expect(due.map((d) => d.position)).toEqual([1, 2]);
});

test("paused campaign → nothing due (overrides run through forceAll)", () => {
  const paused = { ...baseCampaign, status: "paused" };
  const pending = items({ position: 1, force_due: true });
  expect(computeDueItems({ campaign: paused, items: pending, nowMs: P1, lastSentAtMs: null })).toEqual([]);
  expect(computeDueItems({ campaign: paused, items: pending, nowMs: P1, lastSentAtMs: null, forceAll: true }).length).toBe(1);
});

test("one_time: everything pending is due once start_at passes", () => {
  const camp: CampaignConfig = { kind: "one_time", start_at: "2026-08-20T17:00:00Z", timezone: TZ, schedule: {} };
  const pending = items({ position: 1 }, { position: 2 });
  expect(computeDueItems({ campaign: camp, items: pending, nowMs: now, lastSentAtMs: null })).toEqual([]);
  expect(computeDueItems({ campaign: camp, items: pending, nowMs: P1, lastSentAtMs: null }).length).toBe(2);
});

test("recurring: due only at/after the next occurrence", () => {
  const camp: CampaignConfig = {
    kind: "recurring",
    start_at: "2026-08-10T00:00:00Z",
    timezone: TZ,
    schedule: { frequency: "daily", times: ["20:00"] },
  };
  const single = items({ position: 1 });
  // Mid-day on Aug 20 (before 20:00) → not due yet.
  expect(computeDueItems({ campaign: camp, items: single, nowMs: Date.parse("2026-08-20T10:00:00Z"), lastSentAtMs: null })).toEqual([]);
  // Exactly at the slot → due.
  expect(computeDueItems({ campaign: camp, items: single, nowMs: P1, lastSentAtMs: null }).map((d) => d.position)).toEqual([1]);
  // Just sent → next occurrence is tomorrow 20:00 → not due a moment before.
  expect(computeDueItems({ campaign: camp, items: single, nowMs: P1 + DAY - 1, lastSentAtMs: P1 })).toEqual([]);
  // …and due exactly when that slot arrives.
  expect(computeDueItems({ campaign: camp, items: single, nowMs: P1 + DAY, lastSentAtMs: P1 }).map((d) => d.position)).toEqual([1]);
});

test("expired campaign (end_at past) → nothing due", () => {
  const camp: CampaignConfig = {
    kind: "recurring",
    start_at: "2026-08-10T00:00:00Z",
    end_at: "2026-08-19T00:00:00Z",
    timezone: TZ,
    schedule: { frequency: "daily", times: ["20:00"] },
  };
  expect(computeDueItems({ campaign: camp, items: items({ position: 1 }), nowMs: P1, lastSentAtMs: null })).toEqual([]);
});

// ── seriesTerminalStatus (campaign-status clarity) ─────────────────────────
test("seriesTerminalStatus: sent → completed, failed → failed, pending → active", () => {
  expect(seriesTerminalStatus([{ status: "sent" }, { status: "sent" }])).toBe("completed");
  expect(seriesTerminalStatus([{ status: "sent" }, { status: "failed" }])).toBe("failed");
  expect(seriesTerminalStatus([{ status: "failed" }, { status: "failed" }])).toBe("failed");
  expect(seriesTerminalStatus([{ status: "sent" }, { status: "pending" }])).toBe("active");
  expect(seriesTerminalStatus([{ status: "pending" }, { status: "failed" }])).toBe("active");
  expect(seriesTerminalStatus([])).toBe("completed");
});
