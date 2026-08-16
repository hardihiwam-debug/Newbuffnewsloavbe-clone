// Daily Bulletin scheduling logic (pure — no Deno/network deps, so the same
// module drives the edge function and the bun unit tests).
//
// Semantics: the bulletin fires once per day, at/after `bulletin_time` in the
// settings timezone, unless a bulletin was already sent on the same local
// date. `now` is injectable for tests.
//
// NOTE: this is the canonical copy — the deployer only ships files inside the
// function's own folder. supabase/functions/_shared/bulletin.ts re-exports
// from here so scripts/bulletin_tests.ts keeps one source of truth.

export type BulletinSettingsLike = {
  timezone?: string | null;
  bulletin_time?: string | null;
  last_bulletin_at?: string | null;
};

export function bulletinDueToday(s: BulletinSettingsLike, now: Date = new Date()): boolean {
  const tz = s.timezone ?? "Asia/Baghdad";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const nowMin = Number(get("hour")) * 60 + Number(get("minute"));
  const [bh, bm] = String(s.bulletin_time ?? "08:00").split(":").map((x) => Number(x) || 0);
  if (nowMin < bh * 60 + bm) return false;

  const todayKey = `${get("year")}-${get("month")}-${get("day")}`;
  const last = s.last_bulletin_at;
  if (!last) return true;
  const lastParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(last));
  const lastKey = `${lastParts.find((p) => p.type === "year")?.value}-${lastParts.find((p) => p.type === "month")?.value}-${lastParts.find((p) => p.type === "day")?.value}`;
  return lastKey !== todayKey;
}

// Local wall-clock date (YYYY-MM-DD) in the settings timezone — used for the
// bulletin header so "Daily Bulletin — 2026-08-15" matches the channel's day.
export function localDateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
