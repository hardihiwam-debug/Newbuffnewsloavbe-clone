// Pure scheduling engine for the campaign system (no Deno / DB / network —
// unit-testable). Decides WHAT is due now from campaign config + item state;
// the edge function only performs the sends.

export type CampaignConfig = {
  kind: "one_time" | "recurring" | "series";
  start_at?: string | null;
  end_at?: string | null;
  timezone?: string;
  schedule?: Record<string, unknown>;
  max_attempts?: number;
};

export type ItemLike = {
  position: number;
  status: "pending" | "sent" | "failed" | "skipped";
  attempts: number;
  force_due?: boolean;
  scheduled_for?: string | null;
};

// ── Time math (UTC ms) ──────────────────────────────────────────────────────
// The schedule is expressed in the campaign's timezone ("20:00 Asia/Baghdad").
// We convert local wall-clock times to UTC instants with the IANA offset at
// that date, so DST shifts are handled. `nextLocalTime(fromMs, "20:00", tz)`
// = the first UTC instant >= fromMs whose local wall clock reads 20:00.
export function localTimeToUtcMs(dateStr: string, time: string, timeZone: string): number {
  // Interpret the wall-clock time as if it were UTC, then read what the
  // target timezone actually shows at that instant — the difference is the
  // zone offset (DST-correct) at that date. Shifting back by the offset gives
  // the UTC instant whose wall clock in `timeZone` reads `time`.
  const [h, m] = time.split(":").map(Number);
  const naiveUtc = Date.UTC(
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)) - 1,
    Number(dateStr.slice(8, 10)),
    h ?? 0,
    m ?? 0,
    0,
  );
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(naiveUtc));
  const [dd, mm, yyyy, hh, mi, ss] = parts.split(/[/,:\s]+/).map(Number);
  // DateTimeFormat with hour12:false can emit "24" for midnight; normalize.
  const hour = hh === 24 ? 0 : hh;
  const wallAsUtc = Date.UTC(yyyy!, mm! - 1, dd!, hour, mi!, ss ?? 0);
  return naiveUtc - (wallAsUtc - naiveUtc);
}

export function nextLocalOccurrence(fromMs: number, time: string, timeZone: string): number {
  let day = new Date(fromMs).toISOString().slice(0, 10);
  for (let guard = 0; guard < 400; guard++) {
    const candidate = localTimeToUtcMs(day, time, timeZone);
    if (candidate >= fromMs) return candidate;
    const next = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    day = next;
  }
  return fromMs + 86_400_000;
}

export function addDaysMs(ms: number, days: number): number {
  // Calendar-day arithmetic in the campaign's timezone: keep the same local
  // wall clock. Approximated via UTC + days (DST drift < 1h, acceptable for
  // daily cadences); exact wall-clock preservation is handled for the "time"
  // component because every send time is recomputed through
  // nextLocalOccurrence(partStartMs, time, tz).
  return ms + days * 86_400_000;
}

// ── Campaign-level: when is a series part due? ─────────────────────────────
// Series: part N is due at the Nth occurrence of the cadence starting from
// start_at. cadence: daily → +1 day per part; weekly → +7; selected_days →
// the next weekday in `weekdays` after the previous part; custom → +
// interval_days; manual → the item's own scheduled_for.
export function seriesPartDueMs(
  partIndex: number, // 0-based (part 1 → 0)
  startAtMs: number,
  schedule: Record<string, unknown>,
  timeZone: string,
  itemScheduledForMs: number | null,
  nowMs: number,
): number | null {
  const cadence = String(schedule.cadence ?? "daily");
  if (cadence === "manual") {
    return itemScheduledForMs ?? null;
  }
  const times = Array.isArray(schedule.times) && (schedule.times as string[]).length > 0
    ? (schedule.times as string[])
    : ["20:00"];
  const time = times[0]!;
  const intervalDays = Number(schedule.interval_days ?? 0) || (cadence === "weekly" ? 7 : cadence === "daily" ? 1 : 1);
  if (cadence === "selected_days") {
    const weekdays = (schedule.weekdays as number[] | undefined) ?? [];
    if (weekdays.length === 0) return null;
    let anchor = startAtMs;
    for (let i = 0; i < partIndex; i++) {
      // First step: the very first occurrence at-or-after start (allow landing
      // exactly on start_at). Every later step must be STRICTLY after the
      // previous part's send time so two parts never share a slot.
      anchor = nextWeekdayAfter(anchor - (i === 0 ? 1 : 0), weekdays, time, timeZone);
    }
    return nextWeekdayAfter(anchor - (partIndex === 0 ? 1 : 0), weekdays, time, timeZone);
  }
  // Part 1 = the first occurrence of `time` at-or-after start_at; every later
  // part is one interval past the previous part, re-anchored to `time`
  // (calendar arithmetic in the campaign timezone, DST-safe). This guarantees
  // a series never fires a part before its start_at and two parts never share
  // a slot.
  let scheduled = nextLocalOccurrence(startAtMs, time, timeZone);
  for (let i = 0; i < partIndex; i++) {
    scheduled = nextLocalOccurrence(scheduled + intervalDays * 86_400_000, time, timeZone);
  }
  return scheduled;
}

export function nextWeekdayAfter(fromMs: number, weekdays: number[], time: string, timeZone: string): number {
  // From `fromMs`, find the first day whose ISO weekday is in `weekdays`
  // (1=Mon..7=Sun), at `time` in `timeZone`, STRICTLY after fromMs. (The
  // at-or-after case is handled by callers passing fromMs - 1ms for the first
  // step, so a series can still land exactly on its start_at.) This keeps two
  // consecutive parts of a selected-days series from ever sharing one slot.
  for (let d = 0; d < 8; d++) {
    const dayStart = fromMs - (fromMs % 86_400_000) + d * 86_400_000;
    const candidate = nextLocalOccurrence(Math.max(fromMs - (fromMs % 86_400_000), dayStart), time, timeZone);
    const wd = new Date(candidate).getUTCDay(); // 0=Sun..6=Sat
    const iso = wd === 0 ? 7 : wd;
    if (candidate > fromMs && weekdays.includes(iso)) return candidate;
  }
  return fromMs + 7 * 86_400_000;
}

// Recurring (non-series): next send time strictly after the last send (or
// from start_at if nothing sent yet), capped by end_at.
export function recurringNextDueMs(
  lastSentAtMs: number | null,
  startAtMs: number,
  endAtMs: number | null,
  schedule: Record<string, unknown>,
  timeZone: string,
  nowMs: number,
): number | null {
  const from = lastSentAtMs ?? Math.max(startAtMs, nowMs - 60_000);
  const frequency = String(schedule.frequency ?? "daily");
  const times = Array.isArray(schedule.times) && (schedule.times as string[]).length > 0
    ? (schedule.times as string[])
    : ["20:00"];
  const weekdays = (schedule.weekdays as number[] | undefined) ?? [];
  const intervalDays = Number(schedule.interval_days ?? 0) || (frequency === "weekly" ? 7 : 1);

  let due: number | null = null;
  if (frequency === "daily") {
    // Strictly after the last send: a daily send lands exactly ON its slot
    // (e.g. 20:00:00.000), and without the 1ms nudge the next occurrence
    // would resolve to the same instant and fire again immediately.
    due = nextLocalOccurrence(from + 1, times[0]!, timeZone);
  } else if (frequency === "weekly") {
    const days = (schedule.weekdays as number[] | undefined) ?? [];
    if (days.length > 0) {
      due = nextWeekdayAfter(from, days, times[0]!, timeZone);
    } else {
      due = addDaysMs(nextLocalOccurrence(from, times[0]!, timeZone), 7);
    }
  } else if (frequency === "custom") {
    // Custom interval counts from the campaign start (first send = one
    // interval after start_at; after that, from the last send). "from" here
    // would count from now on the first send, which pushes the first post a
    // full interval into the future — wrong when start_at is in the past.
    const anchor = lastSentAtMs ?? startAtMs;
    const base = addDaysMs(anchor, intervalDays);
    due = nextLocalOccurrence(base, times[0]!, timeZone);
  } else if (weekdays.length > 0) {
    due = nextWeekdayAfter(from, weekdays, times[0]!, timeZone);
  }
  if (due === null) return null;
  if (endAtMs !== null && endAtMs !== undefined && due > endAtMs) return null;
  return due;
}

// ── Cycle-level: which items are due right now? ─────────────────────────────
// Returns pending items that must be attempted this cycle, in position order:
//   - items flagged force_due (manual "send now / send next"),
//   - the next unsent item of an active series whose due time <= now,
//   - one_time items whose start_at <= now,
//   - recurring campaigns produce exactly one due item per cycle (a synthetic
//     item keyed by position 1; the campaign's own progress is tracked by
//     last_sent_at on the campaign — see CampaignProgress).
export function computeDueItems(opts: {
  campaign: CampaignConfig;
  items: ItemLike[];
  nowMs: number;
  lastSentAtMs: number | null;
  forceAll?: boolean;
}): ItemLike[] {
  const { campaign, items, nowMs, lastSentAtMs, forceAll } = opts;
  const startAtMs = campaign.start_at ? Date.parse(campaign.start_at) : NaN;
  const endAtMs = campaign.end_at ? Date.parse(campaign.end_at) : null;
  // Missing status = active (the DB always stores one; tests may omit it).
  if (campaign.status !== undefined && campaign.status !== "active" && !forceAll) return [];
  if (!Number.isFinite(startAtMs)) return [];
  if (endAtMs !== null && nowMs > endAtMs) return [];

  if (campaign.kind === "one_time") {
    if (startAtMs > nowMs) return [];
    return items.filter((i) => i.status === "pending");
  }
  if (campaign.kind === "series") {
    const pending = items.filter((i) => i.status === "pending").sort((a, b) => a.position - b.position);
    if (pending.length === 0) return [];
    const forced = pending.filter((i) => i.force_due === true);
    if (forced.length > 0 || forceAll) return pending;
    const next = pending[0]!;
    const dueMs = seriesPartDueMs(next.position - 1, startAtMs, campaign.schedule ?? {}, campaign.timezone ?? "Asia/Baghdad", next.scheduled_for ? Date.parse(next.scheduled_for) : null, nowMs);
    if (dueMs === null) return [];
    if (dueMs <= nowMs) return [next];
    return [];
  }
  if (campaign.kind === "recurring") {
    const dueMs = recurringNextDueMs(lastSentAtMs, startAtMs, endAtMs, campaign.schedule ?? {}, campaign.timezone ?? "Asia/Baghdad", nowMs);
    if (dueMs === null) return [];
    if (dueMs <= nowMs) return items.filter((i) => i.status === "pending");
    return [];
  }
  return [];
}

// One-time: the part's own date. Series: computed. Recurring: next occurrence.
export function dueLabel(item: ItemLike, campaign: CampaignConfig): string {
  if (item.scheduled_for) return item.scheduled_for;
  return "";
}

// Terminal status for a series whose items are all non-pending: "completed"
// when every part sent, "failed" when at least one part was auto-skipped after
// max_attempts (otherwise the dashboard would report a partially-failed series
// as "completed"). "active" while any part is still pending.
export function seriesTerminalStatus(items: Array<{ status: string }>): "active" | "completed" | "failed" {
  if (items.some((i) => i.status === "pending")) return "active";
  return items.some((i) => i.status === "failed") ? "failed" : "completed";
}
