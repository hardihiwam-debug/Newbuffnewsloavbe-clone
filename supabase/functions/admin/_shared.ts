// Pure helpers for the admin PIN lockout (no Deno / network / DB access) so
// they can be unit-tested directly and imported by the edge function.
// Keep this file dependency-free: importing it must never touch Deno APIs.

// An IP gets MAX_FAILED_ATTEMPTS wrong guesses per LOCKOUT_WINDOW_MS; the
// attempt that reaches the ceiling locks the IP until the window expires.
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

// Rewrite analytics aggregation (Settings → AI & Translation → Rewrite
// Analytics): success/fallback rates, per-provider health + latency, and a
// daily ok/fail trend from rewrite_log rows. Pure so it can be unit-tested.
export type RewriteLogRow = {
  created_at?: string | null;
  ok?: boolean | null;
  provider?: string | null;
  duration_ms?: number | null;
};

export function aggregateRewriteAnalytics(rows: RewriteLogRow[], days = 7): Record<string, unknown> {
  const dayKey = (d: Date) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
  const byDay: Record<string, { ok: number; fail: number }> = {};
  const byProvider: Record<string, { ok: number; fail: number; totalMs: number; calls: number }> = {};
  let total = 0;
  let ok = 0;
  for (const r of rows) {
    total++;
    if (r.ok) ok++;
    const day = r.created_at ? dayKey(new Date(r.created_at)) : "unknown";
    byDay[day] ??= { ok: 0, fail: 0 };
    byDay[day][r.ok ? "ok" : "fail"]++;
    const p = r.provider ?? "unknown";
    byProvider[p] ??= { ok: 0, fail: 0, totalMs: 0, calls: 0 };
    byProvider[p][r.ok ? "ok" : "fail"]++;
    byProvider[p].calls++;
    byProvider[p].totalMs += Number(r.duration_ms ?? 0);
  }
  const trend: Array<{ day: string; ok: number; fail: number }> = [];
  for (let d = days - 1; d >= 0; d--) {
    const key = dayKey(new Date(Date.now() - d * 86_400_000));
    trend.push({ day: key, ok: byDay[key]?.ok ?? 0, fail: byDay[key]?.fail ?? 0 });
  }
  const providers = Object.entries(byProvider)
    .map(([name, v]) => ({
      name,
      ok: v.ok,
      fail: v.fail,
      avgDurationMs: v.calls > 0 ? Math.round(v.totalMs / v.calls) : null,
    }))
    .sort((a, b) => b.ok - a.ok);
  return {
    total,
    ok,
    failed: total - ok,
    successRate: total > 0 ? Math.round((ok / total) * 100) : 0,
    fallbackRate: total > 0 ? Math.round(((total - ok) / total) * 100) : 0,
    providers,
    trend,
  };
}

// State-hash conditional polling decision (egress fast-win): the SPA sends
// the fingerprint it last saw for a resource; when it still matches the
// server's current fingerprint, the poll can be answered with a ~100-byte
// `{ __unchanged: true }` instead of the full payload. Empty/undefined
// values never match (first poll always gets the full payload).
export function fingerprintsMatch(sent: unknown, current: unknown): boolean {
  return (
    typeof sent === "string" &&
    sent.length > 0 &&
    typeof current === "string" &&
    current === sent
  );
}

// admin_fingerprints() returns a NESTED OBJECT per resource (e.g.
// dashboardSummary = {"bots":"1|…","queue":"39|…",…}). The client can only
// round-trip a string, so the server serializes the object into a stable
// string (jsonb key order is deterministic for identical data) before
// comparing / sending it. Null/undefined (migration not applied) → null,
// which never matches and forces the full payload (fail open).

// Source of truth for what admin_fingerprints() fingerprints per resource
// (migration 0030). The fingerprint_coverage test parses the migration SQL and
// asserts it matches this list exactly — and that every table a resource
// READS (documented in that test) is inside its fingerprint, so an unchanged
// poll can never hide a real change (the cron-health and chat-title gaps from
// 0030 were exactly that class of bug). Table names are the underlying
// public.* tables, not the RPC's inner aliases (published/fails/usage/…).
export const FINGERPRINTED_RESOURCES: Record<string, string[]> = {
  dashboardSummary: ["settings", "bots", "queue", "published_history", "polls", "translation_failures", "ai_usage", "activity_log", "cron_job_health"],
  dashboardFeed: ["queue", "activity_log"],
  dashboardQueue: ["queue", "published_history", "chats"],
  dashboardChats: ["chats"],
  dashboardSources: ["sources", "topic_queries"],
  dashboardAnalytics: ["published_history", "polls"],
  dashboardAi: ["translation_failures", "translation_history"],
  dashboardEvents: ["clusters"],
  dashboardPublished: ["polls"],
};
export type SourceTrustStatus = "trusted" | "normal" | "degraded" | "temporarily_muted";

export type SourceTrustInput = {
  id?: string;
  name?: string;
  enabled?: boolean | null;
  auto_paused?: boolean | null;
  autoPaused?: boolean | null;
  auto_pause_reason?: string | null;
  last_error?: string | null;
  lastError?: string | null;
  consecutive_failures?: number | null;
  consecutiveFailures?: number | null;
  consecutive_rejects?: number | null;
  consecutiveRejects?: number | null;
  published_count?: number | null;
  publishedCount?: number | null;
  rejected_count?: number | null;
  rejectedCount?: number | null;
};

function finiteCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function classifySourceTrust(source: SourceTrustInput): Record<string, unknown> {
  const usefulArticles = finiteCount(source.published_count ?? source.publishedCount);
  const rejectedArticles = finiteCount(source.rejected_count ?? source.rejectedCount);
  const totalDecisions = usefulArticles + rejectedArticles;
  const acceptanceRate = totalDecisions > 0 ? Math.round((usefulArticles / totalDecisions) * 100) : null;
  const fetchFailures = finiteCount(source.consecutive_failures ?? source.consecutiveFailures);
  const rejectStreak = finiteCount(source.consecutive_rejects ?? source.consecutiveRejects);
  const temporarilyMuted = Boolean(source.auto_paused ?? source.autoPaused);
  const lastError = source.last_error ?? source.lastError;
  const fetchDegraded = fetchFailures >= 3 || Boolean(lastError);
  const editorialDegraded = rejectStreak >= 3 || (totalDecisions >= 10 && (acceptanceRate ?? 100) < 25);
  const status: SourceTrustStatus = temporarilyMuted
    ? "temporarily_muted"
    : fetchDegraded || editorialDegraded
      ? "degraded"
      : usefulArticles >= 10 && (acceptanceRate ?? 0) >= 75
        ? "trusted"
        : "normal";

  return {
    id: source.id ?? null,
    name: source.name ?? "Unknown source",
    status,
    usefulArticles,
    rejectedArticles,
    acceptanceRate,
    fetchFailures,
    rejectStreak,
    autoPaused: temporarilyMuted,
    enabled: source.enabled !== false,
    lastError: lastError ?? null,
    // These outcomes are not linked to a source in the current schema.
    duplicateRate: null,
    thinBodyRate: null,
    translationFailureRate: null,
    incorrectDateRate: null,
    averagePublishingQuality: null,
    unavailableMetrics: [
      "duplicateRate",
      "thinBodyRate",
      "translationFailureRate",
      "incorrectDateRate",
      "averagePublishingQuality",
    ],
  };
}

export type PipelineStageStatus = "running" | "waiting" | "stopped" | "paused" | "quota-limited";

export function derivePipelineControlCenter(input: {
  paused: boolean;
  pipelineRun?: Record<string, unknown> | null;
  lastIngestAt?: string | null;
  lastPublishAt?: string | null;
  translationQuotaLimited?: boolean;
  now?: number;
}): Record<string, unknown> {
  const run = input.pipelineRun ?? {};
  const at = Date.parse(String(run.at ?? run.startedAt ?? ""));
  const fresh = !Boolean(run.done) && Number.isFinite(at) && (input.now ?? Date.now()) - at < 10 * 60_000;
  const action = String(run.action ?? "");
  const message = String(run.message ?? "").toLowerCase();
  const stopped = input.paused;
  const activeIngest = fresh && action === "ingest";
  const activePublish = fresh && action === "publish";
  const rewriting = activeIngest && /(rewrit|classif|queueing|clear(ed)? the gates)/.test(message);
  const translating = activePublish && /translat/.test(message);
  const lastSuccessfulCycle = [input.lastIngestAt, input.lastPublishAt]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;

  return {
    stages: {
      ingest: stopped ? "stopped" : activeIngest ? "running" : "waiting",
      rewrite: stopped ? "stopped" : rewriting ? "running" : "waiting",
      translation: stopped
        ? "stopped"
        : input.translationQuotaLimited
          ? "quota-limited"
          : translating
            ? "running"
            : "waiting",
      publish: stopped ? "paused" : activePublish ? "running" : "waiting",
    },
    lastSuccessfulCycle,
    activeRun: fresh ? run : null,
  };
}

export function serializeStateFingerprint(current: unknown): string | null {
  if (current === undefined || current === null) return null;
  if (typeof current === "string") return current;
  if (typeof current === "object") return JSON.stringify(current);
  return null;
}

// Returns the number of seconds still locked for an IP, 0 when not locked.
// `firstFailedAt` is the ISO timestamp of the first failure in the current
// window (null/undefined/NaN → not locked). A failed_count below the ceiling
// is not locked, even inside the window — the window only starts mattering
// once the ceiling is hit.
export function lockoutSecondsFor(
  failedCount: number | null | undefined,
  firstFailedAt: string | null | undefined,
  now = Date.now(),
): number {
  if (!firstFailedAt) return 0;
  const first = Date.parse(firstFailedAt);
  if (Number.isNaN(first)) return 0;
  const remaining = LOCKOUT_WINDOW_MS - (now - first);
  if (remaining <= 0) return 0;
  if ((failedCount ?? 0) >= MAX_FAILED_ATTEMPTS) return Math.ceil(remaining / 1000);
  return 0;
}
