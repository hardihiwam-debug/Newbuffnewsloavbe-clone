// Daily Bulletin tests: once-per-day scheduling logic from
// supabase/functions/_shared/bulletin.ts. Guards the exact shipped rule —
// fires at/after bulletin_time in the settings timezone, once per local day —
// so the recap can never double-send or fire before its time.

import { test, expect } from "bun:test";
import { bulletinDueToday, localDateInTz } from "../supabase/functions/_shared/bulletin.ts";

test("not due before bulletin_time, even if never sent", () => {
  const due = bulletinDueToday(
    { timezone: "UTC", bulletin_time: "08:00", last_bulletin_at: null },
    new Date("2026-08-15T07:00:00Z"),
  );
  expect(due).toBe(false);
});

test("due after bulletin_time when never sent", () => {
  const due = bulletinDueToday(
    { timezone: "UTC", bulletin_time: "08:00", last_bulletin_at: null },
    new Date("2026-08-15T08:30:00Z"),
  );
  expect(due).toBe(true);
});

test("not due twice on the same local day", () => {
  const due = bulletinDueToday(
    { timezone: "UTC", bulletin_time: "08:00", last_bulletin_at: "2026-08-15T06:00:00Z" },
    new Date("2026-08-15T20:00:00Z"),
  );
  expect(due).toBe(false);
});

test("due again on the next local day", () => {
  const due = bulletinDueToday(
    { timezone: "UTC", bulletin_time: "08:00", last_bulletin_at: "2026-08-14T23:00:00Z" },
    new Date("2026-08-15T08:30:00Z"),
  );
  expect(due).toBe(true);
});

test("timezone: Baghdad wall clock drives the schedule (UTC+3)", () => {
  // 04:30 UTC = 07:30 Baghdad — before the 08:00 bulletin time.
  expect(
    bulletinDueToday({ timezone: "Asia/Baghdad", bulletin_time: "08:00" }, new Date("2026-08-15T04:30:00Z")),
  ).toBe(false);
  // 05:30 UTC = 08:30 Baghdad — due.
  expect(
    bulletinDueToday({ timezone: "Asia/Baghdad", bulletin_time: "08:00" }, new Date("2026-08-15T05:30:00Z")),
  ).toBe(true);
  // Sent 02:00 UTC (05:00 Baghdad) earlier today → not due again.
  expect(
    bulletinDueToday(
      { timezone: "Asia/Baghdad", bulletin_time: "08:00", last_bulletin_at: "2026-08-15T02:00:00Z" },
      new Date("2026-08-15T05:30:00Z"),
    ),
  ).toBe(false);
  // Sent 20:00 UTC yesterday (23:00 Baghdad) → due today.
  expect(
    bulletinDueToday(
      { timezone: "Asia/Baghdad", bulletin_time: "08:00", last_bulletin_at: "2026-08-14T20:00:00Z" },
      new Date("2026-08-15T05:30:00Z"),
    ),
  ).toBe(true);
});

test("midnight renders as 00 (h23), not 24, so early-morning times still work", () => {
  // 00:45 UTC with bulletin_time 00:30 → due; midnight must not parse as "24:45".
  expect(
    bulletinDueToday({ timezone: "UTC", bulletin_time: "00:30" }, new Date("2026-08-16T00:45:00Z")),
  ).toBe(true);
  // Same day already sent at 00:00 → not due again.
  expect(
    bulletinDueToday(
      { timezone: "UTC", bulletin_time: "00:30", last_bulletin_at: "2026-08-16T00:00:00Z" },
      new Date("2026-08-16T00:45:00Z"),
    ),
  ).toBe(false);
});

test("localDateInTz returns the wall-clock date in the settings timezone", () => {
  expect(localDateInTz(new Date("2026-08-15T23:30:00Z"), "UTC")).toBe("2026-08-15");
  // 23:30 UTC = 02:30 next day in Baghdad.
  expect(localDateInTz(new Date("2026-08-15T23:30:00Z"), "Asia/Baghdad")).toBe("2026-08-16");
});
