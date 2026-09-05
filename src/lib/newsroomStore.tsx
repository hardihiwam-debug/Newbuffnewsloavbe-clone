// Shared newsroom data store (egress fast-win).
//
// Previously every mounted page called useNewsroomData(), which each fired its
// own full getDashboard poll every 5 seconds — AppShell + the page = 2+
// identical ~400KB requests every 5s, each pulling 17 datasets (including
// 2,000–5,000-row scans). This provider fetches each resource ONCE, on its
// own cadence, and exposes the merged payload to every consumer through
// context:
//
//   summary    30s  settings, bots, counts, AI usage, cron health
//   feed       10s  queued items + recent activity (the only live part)
//   queue      5m   full queue list + published history — ONLY on the pages
//                   that render them (overview/inbox/review/events/
//                   published/analytics); skipped elsewhere (mount-on-demand)
//   chats      5m   full chats list — ONLY on /settings
//   sources    5m   sources + topic queries
//   ai         5m   translation history + failures
//   events     5m   event clusters
//   published  5m   polls
//   analytics  5m   14-day series (computed in SQL, single row)
//
// Every resource also answers with state-hash conditional polling
// (ifState/__unchanged — see useAdminQuery): unchanged polls cost ~100 bytes
// instead of the full payload. All polls pause while the tab is hidden
// (visibilitychange — see useAdminQuery).
//
// The merged object keeps the exact field names the old getDashboard payload
// used, so pages read data.settings / data.queue / … unchanged.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { api, useAdminQuery } from "@/lib/supabaseAdminHooks";
import { readStoredPin } from "@/lib/pinStorage";

export type NewsroomData = Record<string, any> | undefined;

const NewsroomContext = createContext<NewsroomData>(undefined);

// Pages dispatch this after a successful mutation (approve / reject / hold /
// publish / delete / clear / edit) so every mounted resource refetches
// immediately instead of waiting for its next interval (queue lists poll on a
// 5-minute cadence; the feed on 10s). Without it, a row an editor just
// rejected stays visible on /inbox for up to 5 minutes. The refetch is cheap:
// unchanged resources answer with the ~100-byte state-hash envelope.
export const NEWSROOM_REFRESH_EVENT = "newsroom:refresh";

export function refreshNewsroomData() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NEWSROOM_REFRESH_EVENT));
}

// Routes that render the queue resource (queueAll / history). Everything else
// (aidesk, sources, settings) does not read it, so the 100+100-row poll is
// skipped there entirely.
const QUEUE_PAGE_RE = /^\/(overview|inbox|review|events|published|analytics)(\/|$)/;
const SETTINGS_RE = /^\/settings(\/|$)/;

export function NewsroomProvider({ children }: { children: ReactNode }) {
  const pin = readStoredPin();
  const { pathname } = useLocation();

  // Mutation-triggered refresh: refreshNewsroomData() bumps this tick, which
  // changes every query's argsKey → useAdminQuery refetches those resources
  // on the next effect pass (server answers unchanged ones with the ~100-byte
  // state-hash envelope, so the refetch costs egress only when rows changed).
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    const onRefresh = () => setRefreshTick((t) => t + 1);
    window.addEventListener(NEWSROOM_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(NEWSROOM_REFRESH_EVENT, onRefresh);
  }, []);

  // The `v` key is ignored by the admin server (it reads pin + its own args).
  const args = pin ? { pin, v: refreshTick } : ("skip" as const);

  // Mount-on-demand (egress fast-win): gated resources return "skip" off their
  // pages, which fires nothing (useAdminQuery) — so aidesk/sources/settings
  // never pay for the 100-row queue list, and non-settings pages never pay for
  // the 200-row chats list. Returning to a page refetches fresh once.
  const queueArgs = pin && QUEUE_PAGE_RE.test(pathname) ? args : ("skip" as const);
  const chatsArgs = pin && SETTINGS_RE.test(pathname) ? args : ("skip" as const);

  // Cadence note (egress fast-win): only the live feed stays aggressive (10s).
  // summary 30s, heavy lists 5min — and ALL polls pause while the tab is
  // hidden (see useAdminQuery), so background tabs pay zero egress.
  const summary = useAdminQuery(api.admin.dashboardSummary, args, { refetchIntervalMs: 30_000 });
  const feed = useAdminQuery(api.admin.dashboardFeed, args, { refetchIntervalMs: 10_000 });
  // Live pipeline-run progress (settings.pipeline_run jsonb, written by the
  // pipeline during MANUAL ingest/publish runs). Polled aggressively on its
  // own tiny single-row resource — NOT via the 30s summary — so the Overview
  // progress bar tracks a fetch in near-real-time (~3s updates). No state-hash
  // envelope needed: the payload is ~100 bytes.
  const pipelineRun = useAdminQuery(api.admin.getPipelineRun, args, { refetchIntervalMs: 3_000 });
  const queue = useAdminQuery(api.admin.dashboardQueue, queueArgs, { refetchIntervalMs: 300_000 });
  const chats = useAdminQuery(api.admin.dashboardChats, chatsArgs, { refetchIntervalMs: 300_000 });
  const sources = useAdminQuery(api.admin.dashboardSources, args, { refetchIntervalMs: 300_000 });
  const ai = useAdminQuery(api.admin.dashboardAi, args, { refetchIntervalMs: 300_000 });
  const events = useAdminQuery(api.admin.dashboardEvents, args, { refetchIntervalMs: 300_000 });
  const published = useAdminQuery(api.admin.dashboardPublished, args, { refetchIntervalMs: 300_000 });
  const analytics = useAdminQuery(api.admin.dashboardAnalytics, args, { refetchIntervalMs: 300_000 });

  const value = useMemo<NewsroomData>(() => {
    // settings (in summary) is the anchor every page waits on; the other
    // resources fill in as their first responses arrive.
    if (!summary) return undefined;
    const freshRun = (pipelineRun as { pipeline_run?: unknown } | undefined)?.pipeline_run ?? null;
    const merged: NewsroomData = {
      ...summary,
      // Live progress overrides the (stale, 30s) summary copy of
      // settings.pipeline_run so the Overview widget reads fresh phases.
      ...(freshRun ? { settings: { ...(summary.settings ?? {}), pipelineRun: freshRun } } : {}),
      ...(feed ?? {}),
      ...(queue ?? {}),
      ...(chats ?? {}),
      ...(sources ?? {}),
      ...(ai ?? {}),
      ...(events ?? {}),
      ...(published ?? {}),
      ...(analytics ?? {}),
    };
    return merged;
  }, [summary, pipelineRun, feed, queue, chats, sources, ai, events, published, analytics]);

  return <NewsroomContext.Provider value={value}>{children}</NewsroomContext.Provider>;
}

export function useNewsroomData(): NewsroomData {
  return useContext(NewsroomContext);
}
