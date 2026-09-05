# Iran Desk — UI Reverse-Engineering Reference (2026-09)

Complete front-to-back map of the admin console: **routes → components →
state → data resources → backend actions**, with the exact mechanics of every
interaction (polling, state-hash envelopes, debounced saves, optimistic UI,
responsive shells) and the loading / empty / error behavior of each screen.

Companion to `REVERSE-ENGINEERING.md` (backend / pipeline / DB).

Legend: 🎨 UI component · 📡 data it reads · ⚡ action it fires · ⚙️ behavior /
state machine · 🧯 error/empty/loading handling.

---

## 1. Runtime & stack

- **React 19 + TanStack Router v1.170** (file-based routing, Vite plugin
  generates `src/routeTree.gen.ts`; `src/router.tsx` builds the router with
  scroll restoration) · **Tailwind CSS v4** (CSS-first theme in
  `src/styles.css`) · **shadcn/ui-style primitives** in `src/components/ui`
  (button, dialog, alert-dialog, input, label, switch, textarea, separator,
  badge, sonner) · **lucide-react** icons · **sonner** toasts · **recharts**
  (Analytics only).
- The SPA is a **static Vite build** (see `index.html`, `public/manifest.json`
  PWA shell, `viewport-fit=cover`, safe-area utilities, `theme-color`).
- **Backend contract:** the browser talks to exactly ONE endpoint —
  `POST {VITE_SUPABASE_URL}/functions/v1/admin` with JSON
  `{action, pin, …payload, ifState?}`. There is no direct PostgREST access,
  no WebSockets, no Convex runtime. Responses are `{ok:true,data}` or
  `{error}`; 403 (bad PIN) / 429 (IP lockout) trigger the session-reset event.
  Secrets never ship to the browser (only the anon key + URLs in the bundle).

```
┌────────────────────────── Browser (React SPA) ───────────────────────────┐
│  routes/index.tsx (PIN) → _authenticated (AppShell)                      │
│     └─ NewsroomProvider ── context ── AppShellInner + pages              │
│         useAdminQuery / useAdminMutation / useAdminAction  (per-resource  │
│         cadences + state-hash envelope)                                   │
└───────────────┬──────────────────────────────────────────────────────────┘
                │  POST …/functions/v1/admin  { action, pin, ifState }
                ▼
        Supabase Edge Function `admin`  (PIN-verified, per-IP lockout,
        service-role DB writes, activity_log)
                │  x-internal-secret  (manual runs)
                ▼
        Edge Function `pipeline` (cron: pg_cron → …/scheduled + pipeline)
        → Postgres (settings / queue / published_history / …)
```

---

## 2. Boot & session

### 2.1 `src/main.tsx`
`createRoot(<RouterProvider> + <Toaster top-right richColors>)` and a global
`freebuff:auth-rejected` listener: coalesced (2 s) toast + `navigate("/")`
when `adminApi` sees a 403/429. Not fired when already on `/`.

### 2.2 Sign-in — `src/routes/index.tsx` (route `/`)
🎨 Centered brand panel: IRAN DESK wordmark, dark/light toggle (top-right),
numeric PIN `<Input type=password>` + "ENTER NEWSROOM".
⚙️ On submit: `adminApi.verifyPin({pin})` **server-side check first**; only a
pass writes `freebuff_admin_pin` → `localStorage` and navigates to
`/overview`. Error text is mapped: server "pin" message → "Incorrect PIN",
anything else surfaces raw (backend unreachable etc.).
⚙️ Mount: if a stored PIN already exists → skip straight to `/overview`.
Exports `readStoredPin()` / `clearStoredPin()` (used app-wide;
`pinStorage.ts` re-exports).

### 2.3 Protected layout — `src/routes/_authenticated/route.tsx`
No stored PIN → `navigate("/")`; otherwise renders `<AppShell>` + `<Outlet/>`
with an "Authenticating…" flash.

### 2.4 `__root.tsx`
Bare `createRootRoute` → `<Outlet/>` (all routes carry `head()` meta:
title/description/noindex).

---

## 3. Shared data layer (the engine under every page)

### 3.1 Provider — `src/lib/newsroomStore.tsx`
`AppShell` mounts `<NewsroomProvider>`. One poller per admin resource, merged
into a single context payload read via `useNewsroomData()` — so the shell
badge, the KPI cards and every page share one copy of the data and never
issue duplicate polls.

| Resource | Cadence | Notes / payload keys |
|---|---|---|
| `dashboardSummary` | 30 s | `settings`, `bots`, `categories`, `queuedTotal`, `published24h`, `translationFails24h`, `stuckSending`, `aiUsage24h`, `cronHealth`, `controlCenter`, `currentModel`, `currentProvider`, `schemaMigrations`, `usage`, `newsdataConfigured`, `botConfigured`, `polls24h` |
| `dashboardFeed` | 10 s | `queue` (light list), `recentActivity` — the only aggressive poll |
| `getPipelineRun` | 3 s | live `pipeline_run` progress object (drives the Overview progress bar) |
| `dashboardQueue` | 5 min | **mount-on-demand** on `/overview /inbox /review /events /published /analytics`: `queueAll`, `history`, `sending` |
| `dashboardChats` | 5 min | mount-on-demand on `/settings`: `chats` |
| `dashboardSources` | 5 min | `sources`, `topics` |
| `dashboardAi` | 5 min | `translationHistory`, `translationFailures` |
| `dashboardEvents` | 5 min | `clusters` |
| `dashboardPublished` | 5 min | `published_history` archive rows |
| `dashboardAnalytics` | 5 min | `analytics` (14-day SQL-computed rows) |

(Cadence note: queue and chats are the only **mount-on-demand** resources;
sources / ai / events / published / analytics poll on every authenticated page
at their 5-minute cadence.)

Mechanics:
- **Mount-on-demand** — `queueArgs`/`chatsArgs` become `"skip"` off their
  routes, firing nothing; a return visit refetches fresh once.
- **Hidden-tab pause** — interval stops on `visibilitychange`, resumes on
  visible; background tabs pay zero egress.
- **Mutation refresh** — `refreshNewsroomData()` (re-exported by AppShell)
  dispatches `newsroom:refresh`; the provider bumps a `v` tick that is part of
  every query's args key, so `useAdminQuery` refetches immediately
  (~1 s). Unchanged resources still answer with the ~100 B envelope.

### 3.2 Hooks — `src/lib/supabaseAdminHooks.ts`
- `useAdminQuery(action, args, {refetchIntervalMs=5000})` → data | undefined.
  Skips when args are `"skip"`/null/undefined; aborts stale responses on
  unmount/args change (latest-key guard); keeps last-seen fingerprint and
  sends `ifState[action]`; warns on unknown action names.
- `useAdminMutation(action)` / `useAdminAction(action)` → direct promise
  calls (types validated against the API maps).
- `api.admin.X` / `api.admin_actions.X` — string proxies so code reads like
  the old Convex surface; a typo fails fast.

### 3.3 State-hash envelope — `src/lib/stateEnvelope.ts`
Pure `applyStatefulEnvelope<T>(value)`: server envelope is
`{__unchanged:true, __fingerprint}` (keep data, remember fp) or
`{…data, __fingerprint}` (replace data). Plain responses pass through.
Non-string fingerprints are treated as absent (forces refetch). This is the
egress fast-win: an unchanged poll costs ~100 bytes instead of the full list.

### 3.4 API client — `src/lib/adminApi.ts`
`callAdmin(action, payload, {signal, ifState})`; error type `AdminError`
carries the HTTP status; 403/429 → `clearStoredPin()` + dispatch
`freebuff:auth-rejected`. `adminFunctionUrl()` (from
`src/lib/supabase.ts`) returns null until `VITE_SUPABASE_URL` is set → 503.

Typed groups (all require `pin` unless noted):
- Reads: `verifyPin`, `getDashboard`, `dashboardSummary/Feed/Queue/Chats/
  Sources/Analytics/Ai/Events/Published`, `getPipelineRun`,
  `listTranslationKeys`, `listScheduled`, `listAiControlPlane`,
  `listAiAttempts`.
- Settings/system: `saveSettings` (patch), `setPauseState`, `clearQueue`,
  `setTranslationModel`, `setCronSchedule` (action), scheduled-campaign CRUD +
  `scheduledSkipNext/SendNext/SendItem/ResetItem/SetStatus`.
- Editorial: `editQueueItem`, `publishQueueItem`, `setQueueStatus`,
  `deleteQueueItem`.
- Chats/bots/sources: `updateChat`, `addChat`, `saveBot`, `deleteBot`,
  `upsertTopic`, `upsertSource`.
- AI control plane: `saveAiProvider`, `deleteAiProvider`,
  `saveAiActionRoutes`, `upsertTranslationKey`.
- `adminActionsApi` (imperative): `runPipeline` (`mode: ingest|publish|cycle`
  — strips the duplicate `action` key), `previewNextBatch`,
  `testAiProviderConnection`, `testAiAction`, `listTranslationModels`,
  `testTranslationKey`, `testSource`, `refreshBotInfo`,
  `enableChatWebhooks`, `setWebhook`, `syncBotChats`, `sendTestMessage`,
  `testPoll`, `testGeminiKeys`, `getRewriteLog`, `getRewriteAnalytics`,
  `resolveSending`.

---

## 4. App shell — `src/components/AppShell.tsx`

`AppShell` = `<NewsroomProvider><AppShellInner/>`. Re-exports
`useNewsroomData`, `refreshNewsroomData`.

Constants:
- `NAV_ITEMS` (desktop sidebar): Overview, Inbox, Events, Published, Sources,
  AI Desk, Analytics.
- `MOBILE_PRIMARY` (bottom nav): Overview, Inbox, Events, Published.
- `MORE_ITEMS` (More bottom sheet): Sources, AI Desk, Analytics, Settings.

🎨 Desktop (`md:`+): fixed 56-wide left sidebar — brand block (ID tile +
IRAN DESK/Newsroom), nav with active state (`bg-primary`), an **Inbox badge**
= `queuedTotal`, footer: Settings link, LIVE/PAUSED dot + "Bot operational",
last-run time, theme toggle, **Lock console** (`clearStoredPin()` +
`navigate("/")`).
🎨 Mobile: fixed top bar (hamburger → drawer with full nav incl. Settings,
last-run clock, LIVE/PAUSED chip, theme, lock) + bottom nav of 4 primary
routes with queued badge, plus a **More** button that opens the bottom sheet
(not `/settings`).
⚙️ Active detection `isActive(to) = pathname.startsWith(to)` (so nested
routes stay highlighted). Drawers/sheets close on navigation and on outside
pointer-down (delayed 100 ms to not eat the opening click). Bottom sheets and
bottom nav use `pb-safe` (PWA safe-area). Content column: `max-w-6xl`,
top padding for the mobile bar.
📡 Reads summary resource: `settings.botPaused`, `queuedTotal`,
`recentActivity[0]` (publish/ingest) for "last run X".

---

## 5. Page-by-page reference

### 5.1 `/overview` — Newsroom overview (`overview.tsx`)
**Gates before render:** no PIN → "Sign in required" panel; no
`data.settings` → "Backend offline" (when `!isSupabaseConfigured()`) vs
"Loading newsroom…" (12 s `slow` timer upgrades the copy + shows Refresh).

**Command bar** (disabled while `botPaused` unless resume/lock):
- 🎨 Fetch now → ⚡ `runPipeline({action:"ingest"})` · Preview →
  `previewNextBatch({limit:3})` → PreviewDialog · Run pipeline →
  `runPipeline({action:"publish"})` — all through the shared `withToast`
  helper that renders the real server counts ("N fetched, N queued, N sent …
  in Ns") from the response `result` (handles a `{scheduled:true}` early-return
  answer too).
- Pause/Resume: `ConfirmAction` ("Stop the bot?" — copy states queue is
  kept) → `setPauseState({paused:true, reason:"Stopped from overview"})`;
  resume button when paused. Lock button included.
- ⚙️ Error path: unified `onError` toast; busy states disable buttons.
- 🧯 **Schema-drift banner** when `schemaMigrations.ok` is false — lists
  missing migration files/columns (blocks queue+publish).

**Operational strip:** PAUSED/OPERATIONAL dot, today's date, last run time.

**KPI strip:** Published today (with ▲/▼ delta vs yesterday when non-zero) ·
In queue · Held for review (`isUpdate`/importance=update in queuedItems, hint
shown when >0) · Source failures (autoPaused OR ≥3 consecutiveRejects OR
lastError). Mobile: one horizontal scroll row; `md` 3-col; `lg` 4-col.

**`ControlCenter` (local):** stage tiles Ingest/Rewrite/Translation/Publish
with status → Running/Stopped/Paused/Quota limited/Waiting (from
`controlCenter.stages`), plus metrics: Queue, Last successful cycle (relTime),
Provider/model (`currentProvider`/`currentModel`), AI usage today
(calls + tokens from `usage.ai` or `aiUsage24h`), Supabase usage (tracked or
"Not available" + note).

**`SourceTrustPanel` (local):** table from `sourceTrust` + `sourceTrustNote`:
source, trust badge (trusted/normal/degraded/temporarily_muted), useful,
rejected, acceptance %, fetch failures, "other rates not tracked". Empty →
"no source trust data yet".

**Newsroom feed:** merges `history[:12]` (kind=published) + `queuedItems[:12]`
(queued) + `activity[:12]` (event) into one time-sorted stream, newest first,
renders ≤14. Event rows show icon by level/type (error=destructive warning,
warning=review, publish=healthy, else info), message + detail (truncated w/
title tooltip) + `relTime`. Story rows are `StoryCard` wired to
Review (`navigate /review?id=`), Edit (`EditQueueItemDialog`), Publish
(only for kind=queued → `publishQueueItem` with per-row `busy`). "Open
inbox" action. Empty → EmptyState "run Fetch now…".

**`PipelineProgress` (local):** renders only while `pipeline_run` is
`!done` and younger than 10 min (re-checks on a 1 s interval): action icon,
message, elapsed clock, optional item/total, indeterminate pulse bar when no
total. Uses the 3 s `getPipelineRun` poll via context merge
(`settings.pipelineRun`).

**`PreviewDialog` (local):** modal listing candidate items with status badge
ready/duplicate/blocked; header explains dry-run summary (paused? queue
empty? "X of Y would publish · N queued · M chats · language L").

### 5.2 `/inbox` — Editorial queue (`inbox.tsx`)
State: `tab` (ALL/REVIEW/READY/HELD/FAILED), `editing` row, `busyId`,
`removedIds` (optimistic delete set), clear-queue dialog state
(`clearMode` x|all, `clearCount`, `clearBreaking`).

📡 `queueAll` (excludes `published` rows + `removedIds`), `recentActivity`,
`translationFailures`.
- Tab counts derive from the filtered queue: REVIEW = breaking|isUpdate;
  READY = status queued & not breaking/update; HELD = held; FAILED =
  rejected.
- FAILED tab additionally lists recent operational failures (error/warning
  activity, ≤12) and recent translation failures (≤6).
- Header actions: **Clear** (AlertDialog) and "Refresh list" (returns to
  ALL — relies on remount/fresh queue fetch).

**Clear-queue dialog:** shows totals (incl. breaking count). Two modes:
"Clear N lowest-score" (number input; toggle "Include breaking", off =
breaking protected; calls `clearQueue({limit:N, includeBreaking})`) and
"Clear all" (wipes status=queued then triggers a fresh ingest —
`clearQueue()`). Success toasts differ per mode/count; all end with
`refreshNewsroomData()`.

Row actions (each `StoryCard`): Review → `/review?id=`; Edit → dialog
`editQueueItem`; Publish → `publishQueueItem` (toast loading → success or
surfaced `result.error/skipped`); Reject → `setQueueStatus(rejected)`;
delete via swipe or trash → `deleteQueueItem`. Every success path calls
`refreshNewsroomData()` (see ⚠️ gaps in §8). Swipe-left-≥60 px deletes
immediately (optimistic remove, rollback on failure). Legend row under list.

### 5.3 `/review?id=` — Story review (`review.tsx`)
Resolves the row from `queueAll` by search `id`. Missing → "no longer in the
queue" EmptyState with back link.

🎨 Three columns:
1. **Original source**: sourceName + clock time, "Open source" link (external
   `rel=noopener`), scrollable source text (max-height 46vh) or "No source
   text captured".
2. **Generated story (editable)**: headline/summary textareas (`dir=auto`),
   category `<select>` from `EDIT_CATEGORIES` (13 cats), breaking `Switch`,
   "Unsaved changes/Saved" indicator → **Save edits**
   (`editQueueItem`, disabled until dirty, busy state). Local state syncs
   from the row whenever `item.id` changes.
3. **Verification**: "Extracted facts" definition list for facts.event,
   actor, action, target, location, time, claimed_result, confirmed_result,
   source_attribution, confidence (each rendered only when present), plus
   **Figures** chips (facts.numbers, review color, "digit-preservation"
   emphasis) or "No structured facts (Telegram/legacy)". "Checks" card: three
   hardcoded editorial checks (attribution preserved, figures preserved,
   facts-only summary).

⚡ Actions panel: Reject (`setQueueStatus rejected`), Hold (`held`), Requeue
(`queued`, shown only while held), Publish now (loading toast; `ok:false`
surfaces `result.error/skipped`). Status changes toast then
`refreshNewsroomData()` and navigate to `/inbox`; publish navigates to
`/published`.

### 5.4 `/events` — Event clusters (`events.tsx`)
Constants: `CLUSTERS_AT_A_GLANCE = 12`, `TIMELINE_LIMIT = 30`.

📡 `clusters`, plus `queueAll` + `history` joined **locally** into a timeline
by matching `eventId`/`event_id` (queued rows get kind queued; history rows
published), sorted desc.
🎨 Left: cluster cards (dot: healthy ≤6 h old else review; title truncated +
`title` attr, category pill, N posts, N timeline items, "Nh ago", optional
"last:" line on its own truncating row). Click selects; "Show all N clusters"
toggle (40 cap). Right pane: selected cluster → timeline (StatusPill per row:
published/breaking/update/queued, clock time, headline, source) with
"+N older collapsed"; no rows yet → explanatory line; nothing selected →
dashed placeholder. Empty state when zero clusters.

### 5.5 `/published` — Archive (`published.tsx`)
State: `filter` TODAY/BREAKING/IRAN/IRAQ/MILITARY/ECONOMY/ALL, `busyId`,
local `sending` snapshot (copy of `data.sending` taken at mount).
📡 `history`, `sending`.
- Filters: TODAY = same calendar day; MILITARY = category in
  war/proxies/usa; ECONOMY = oil/gold/economic-impact.
- **Stuck-delivery reconciliation panel** (when `sending.length>0`):
  amber banner "N deliveries with unknown outcome…", per row headline →
  chat · time with **Mark sent** (`resolveSending sent` — flips the
  reservation to delivered) and **Retry** (`resolveSending retry` — deletes
  the reservation so the next cycle re-sends if still queued). Row removed
  locally + `refreshNewsroomData()` after success.
- Archive rows: optional lazy thumbnail (hidden on error/small screens),
  pills, clock + relative time, headline, source, "→ chat1, chat2" when
  multi-chat (`history.chats`), truncated event id, and a TELEGRAM ✓ chip.
  Empty states per filter.

### 5.6 `/analytics` (`analytics.tsx`)
All computed **from real retained rows** (nothing estimated).
📡 `analytics` (14-day), `history`, `sources`, `aiUsage24h`.
- KPI boxes: Published today (24 h), Published 14 d, Breaking 14 d, Polls 14 d
  (sums over the series).
- Bar chart (recharts `ResponsiveContainer`): day (MM-DD) vs published /
  breaking / polls; CSS-var theming for axes/tooltip; empty → EmptyState.
- Sources panel: top-12 published sources by count over the retained window
  with proportional health-colored bars + note "retained window (16h)".
- AI panel: calls + tokens tiles + per-provider bars (`ai.byProvider`),
  empty → "No AI usage recorded today".

### 5.7 `/aidesk` — AI Desk (`aidesk.tsx`)
Local query: `listTranslationKeys` (default 5 s while mounted).
📡 context settings/sources/aiUsage24h/translationHistory/
translationFailures + `schemaMigrations`.
🎨 Three top panels:
1. **AI pipeline checklist** — each stage derives ok/detail from live config:
   Ingestion (sources configured), Event detection (schema ok — "Event
   clustering active (48h window)"), Deduplication (aiDedupEnabled +
   provider), Fact extraction (schema), Translation (envGeminiCount>0 or
   stored keys>0 + mode), Quality check (freshness gate enabled).
2. **Today** — Metric tiles (AI calls, Published, Translation failures w/
   danger tone, Tokens) + per-provider usage bars.
3. **Gemini keys** — per-key index 1..6: configured mask (`first8…last4`),
   today's calls, lifetime 429 count; else "not configured" + guidance
   ("Add GEMINI_API_KEY_1..6 under Keys/API keys…").
Bottom: Recent translations (rtl Kurdish text + cleaned model id + timestamp,
≤15 in scroll area) and Translation failures (detail, modelsTried, time).
"AI performance" panel is an honest placeholder (quality scores not tracked
by the backend yet).

### 5.8 `/sources` — Source monitor (`sources.tsx`)
State: selected source id.
📡 `sources`.
🎨 Health state machine `health(src)`: autoPaused OR ≥3 consecutiveFailures →
**Failing** (destructive dot/badge); lastError OR ≥3 consecutiveRejects →
**Degraded**; else **Healthy**. Cards: dot, name, badge, kind, "N ok · N
rejected", daily quota usage (usedToday/dailyQuota when present), acceptance
%, "last fetch Nh" vs "no successful fetch yet", disabled marker.
Master-detail: right profile lists kind, priority, articles today, quota
today, rejected, consecutive fetch failures, reject streak, last success,
auto-paused, plus a destructive "Last error" box and an auto-pause explainer
("re-enable in Settings → Sources"). Header copy points edits to Settings →
Sources.

### 5.9 `/settings` — Settings shell (`SettingsShell.tsx`)
**Tabs (9 ids in 4 job groups):**

| Group | Tab id | Label | Component | Cards |
|---|---|---|---|---|
| Channels | `telegram` | Telegram | `TelegramTab` | Bot Connection, Bots, Chats, Polls, Recent Polls |
| Channels | `sources` | Sources | `SourcesTab` | Providers, Telegram Channels, Source Quality, Topic Queries, Test |
| Content | `style` | Style | `StyleTab` | AI writing style, Language, Post Format, Summary source, Hashtag rules |
| Content | `editorial` | Editorial | `EditorialTab` | Breaking-News Criteria, News quality, Why-it-matters follow-ups, Telegram Video Handling |
| Content | `categories` | Categories | `CategoriesTab` | Category Policy |
| Delivery | `scheduling` | Scheduling | `SchedulingTab` | Posting Windows, Publishing Speed |
| Delivery | `campaigns` | Campaigns | `CampaignsTab` | Campaigns (+per-item Send now / Move up/down / Reset to pending / Delivery history) |
| Intelligence & System | `ai` | AI & Translation | `AiTranslationTab` | Translation Provider, Translation model order, AI Control Plane, AI Dedup, Translation API Keys, Gemini Key Usage, Translation Glossary, Translation History, Translation Failures, AI Rewrite Log, Rewrite Analytics, Test |
| Intelligence & System | `system` | System & Security | `SystemTab` + `SecurityTab` | Scheduler (pg_cron), System Status, Security |

Rendered by `/settings` (`settings.tsx` → shell directly as the route
component). All tabs read shared state through `useSettings()`; per-tab
bodies live in `src/components/settings/<Tab>.tsx`.

**Shell mechanics (⚙️):**
- **Data plumbed down** (`SettingsContextValue` in `shared.tsx`): `s`
  (settings **overlaid with optimistic edits**), `save(patch)`, `data`, pin/
  pinArgs, `onError`, `lock`, lists (`chats, bots, sources, topics, polls,
  translationHistory, translationFailures, tkeys, geminiUsage`),
  `envGeminiCount` (from runtime env, not stored keys), `botTokenConfigured`
  (from summary — env truth), `categories`, and the mutation/action fns
  (`updateChat, addChat, saveBot, deleteBot, upsertTopic, upsertSource,
  upsertTranslationKey, testTranslationKey, testGeminiKeys, testSource,
  refreshBotInfo, setWebhook, enableChatWebhooks, setTranslationModel,
  setCronSchedule, listTranslationModels, getRewriteLog,
  getRewriteAnalytics, syncBotChats, testPoll`).
- **Optimistic + debounced save:** every `save(patch)` merges into an
  optimistic overlay (inputs never fight in-flight writes), accumulates a
  pending patch, marks the active tab dirty, and schedules `flushSave` after
  **600 ms**. `flushSave` posts ONE `saveSettings({patch})`, clears dirty
  dots on success, toasts on failure. Unmount → flush (no lost edits).
  "Saving… / All changes saved" indicator in the header (desktop inline,
  mobile in subtitle).
- **Deep links:** `/settings?tab=<id>&card=<id>` (URL read/written via
  `history.replaceState`, no router schema conflict). `pendingCardRef`
  scrolls the target card into view after the tab mounts, opening any
  wrapping `<details>`.
- **Search:** `⌘K/Ctrl+K` global listener + header button open
  `SettingsSearch`; picking a result `jumpTo(tab, cardId)` switches tab and
  scrolls/opens (registry in `searchRegistry.ts`).
- **Gates:** no PIN → sign-in panel; no settings data → "Loading settings…".

**Shared primitives (`shared.tsx`):** `Card` (icon + title + hint + action +
`id` anchor, `scroll-mt-24`), `CompactInput` (draft-buffer fix so numeric
fields don't resurrect deleted numbers), `CompactToggle`/`Switch` row
helpers, `DEFAULT_CATEGORIES` (13). Bottom tab bar on desktop vs horizontal
scrollable chip row on mobile (gradient fade hints overflow); snapshot group
headers only on desktop.

---

## 6. Shared UI building blocks

### `src/components/newsroom.tsx` (cross-page)
| Export | Props → behavior |
|---|---|
| `relTime(iso)` | now / Nm / Nh / Nd |
| `clockTime(iso)` | HH:MM local |
| `CategoryPill` | colored chip; color map per category incl. oklch literals for proxies/middle-east/gaza/syria/lebanon/oil; fallback muted |
| `StatusPill` | BREAKING (destructive), UPDATE/HELD (review), READY/PUBLISHED (healthy), REJECTED/MINOR (muted), fallback upper |
| `Kpi` | value (ReactNode), tone neutral/danger/review/healthy, optional delta + hint |
| `StoryCard` | item + optional `onReview/onPublish/onEdit/onReject/onDelete`, `busy`, `showFacts`. Headline button → review; facts figures chip; per-action icon buttons; **touch swipe**: horizontal drag ≤ -60 px triggers `onDelete ?? onReject`, `touchAction: pan-y` so vertical scroll survives |
| `ConfirmAction` | AlertDialog wrapper: title/description/confirmLabel/variant/size → `onConfirm` |
| `EDIT_CATEGORIES` | the 13 editable categories |
| `EditQueueItemDialog` | Dialog + `EditQueueForm` (headline/summary/category/breaking; save gated on non-empty headline; `onSaved` hook after `editQueueItem`) |
| `SectionTitle` | eyebrow + title + hint + right `action` |
| `EmptyState` | icon + text |

### `src/components/settings/*` (tab-local)
`SettingsShell`, `SettingsSearch` (modal registry search), `searchRegistry.ts`
(term → tab/card map), tab components, `shared.tsx` (Card + form primitives +
SettingsProvider). **Settings-specific live widgets:** `BotsCard`,
`TelegramChannels`, `AddChat` are used by `TelegramTab`; `GlossaryEditor` by
`AiTranslationTab`; `SchedulerTab` vs `SchedulingTab` note — Scheduling tab
is the active one; `SchedulerTab.tsx` is legacy/retired.

### `src/components/ui/*` (shadcn-style primitives)
button, input, label, textarea, switch, badge, separator, dialog,
alert-dialog, sonner (toaster). Styled by `src/styles.css` tokens.

### Root-level `src/components/*`
`AppShell.tsx` (shell), `newsroom.tsx` (library above), plus legacy top-level
pieces (`BotsCard`, `TelegramChannels`, `AddChat`, `newsroomStore.tsx`).

---

## 7. Theme & styling

- `src/styles.css`: Tailwind v4 directives + CSS variables for
  background/foreground/card/muted/border/primary/destructive/review/healthy/
  info/brand/sidebar tokens; `.dark` class re-themes; `.panel`,
  `.panel-hover`, `pb-safe` utilities, category oklch colors, fonts
  (`font-display`), scrollbars. Imported once in `main.tsx`.
- Dark/light persisted under `localStorage.theme`; toggles from the Sign-in
  page and AppShell swap the `dark` class on `<html>`.

---

## 8. Known rough edges (as of this writing)

- ~~`EditQueueItemDialog` was passed without `onSaved` on `/inbox` and
  `/overview`~~ — **fixed**: both call sites now pass
  `onSaved={() => refreshNewsroomData()}`, so in-place edits refresh the
  5-minute queue list immediately. Every mutating path on `/inbox` (reject /
  hold / delete / clear / publish / edit) and the overview edit dialog now
  refresh right after the write.
- `/overview`'s quick-publish and `/published`'s resolve-sending still rely
  on the 10 s feed (or remount) to reflect — acceptable, not yet wired to
  `refreshNewsroomData()`.
- Activity "Published" rows can appear twice ~250 ms apart (same headline,
  no chatId) — believed to be double logging, not double delivery (the
  `published_history` unique index prevents duplicates).
- `/published` keeps a mount-time snapshot of `sending`; new stuck rows
  appear on remount/refresh rather than instantly.
- AI quality scores (headline/summary/fact-consistency) are not tracked by
  the backend yet — AI Desk's performance panel states this explicitly.

---

## 9. End-to-end flows

1. **Sign in** → verifyPin server → store PIN → Overview mounts provider →
   first summary/feed/pipeline-run fetches → shell LIVE dot + pages populate.
2. **Browse/review a queued story** → Inbox StoryCard → `/review?id=` →
   Reject/Hold/Requeue/Publish now → admin mutation on the queue row →
   activity_log → refresh + navigation → remount refetch shows the result.
3. **Publish now (single)** → `publishQueueItem` → pipeline force-publish
   (reserves `published_history` 'sending' row per chat BEFORE send; flips to
   'sent' or drops reservation on definitive failures incl. 429/420; ambiguous
   timeouts stay 'sending' → surfaced on `/published` for manual
   reconciliation) → queue row deleted when every eligible chat got it.
4. **Manual full run** → Fetch now / Run pipeline → admin action with
   `x-internal-secret` → real `pipeline` execution → `settings.pipeline_run`
   progress → Overview bar via the 3 s poll → toast with real counts.
5. **Settings change** → toggle/input → optimistic overlay + 600 ms debounce →
   single `saveSettings` patch → flush on navigate → dirty dots clear →
   next pipeline cycle picks it up.
6. **Pause everything** → Overview Pause (ConfirmAction) →
   `setPauseState(true)` → pipeline/scheduled/webhook honor `bot_paused` →
   shell + overview show PAUSED; Resume reverses it.
7. **Session expiry** → any admin call 403/429 → PIN cleared +
   `freebuff:auth-rejected` → toast + redirect to `/`.

---

# PART II — Appendices (added per operator request)

## 10. ASCII component trees (per page)

Tree legend: `R` file route · `[component]` with `(props)` · arrows show render
nesting · `◇` data read · `▸` action fired · `?` conditional render. Boxes for
shared library components live in §6; `<ui>` = shadcn primitive.

### 10.1 / (Sign-in)

```
R src/routes/index.tsx → SignIn
├─ theme button (Sun/Moon)                     ◇ documentElement.classList
├─ IRAN DESK brand panel + PIN form
│  └─ <ui Input type=password numeric>          local state pin
│  └─ <ui Button> ENTER NEWSROOM                ▸ adminApi.verifyPin → store → /overview
└─ “System online” dot (static)
```

### 10.2 Protected layout → AppShell (every authed page)

```
R route.tsx → ProtectedLayout            ? no PIN → navigate "/"
└─ [AppShell] = NewsroomProvider → AppShellInner
   ├─ <NewsroomProvider>                    (store: per-resource polls, refresh tick)
   └─ AppShellInner
      ├─ aside (desktop sidebar)            NAV_ITEMS + Settings link, Inbox badge,
      │                                      LIVE/PAUSED dot, theme, Lock
      ├─ mobile top bar + drawer            MOBILE_PRIMARY + NAV_ITEMS+Settings
      ├─ More bottom sheet (mobile)         MORE_ITEMS
      ├─ main → <Outlet/>                   (page content, max-w-6xl)
      └─ mobile bottom nav                  MOBILE_PRIMARY + “More” button
```

### 10.3 /overview

```
R overview.tsx → Overview
│  gates: no pin → Sign-in panel · no settings → Backend offline / Loading (+12s slow)
├─ Command bar: Fetch now ▸ runPipeline ingest · Preview ▸ previewNextBatch
│   · Run pipeline ▸ runPipeline publish · Pause(ConfirmAction)/Resume
│     ▸ setPauseState · Lock ▸ clearStoredPin
├─ Operational strip (PAUSED dot, date, last run)      ◇ activity[0]
├─ Schema-drift banner?                             ◇ schemaMigrations.ok
├─ KPI row: Published/In queue/Held/Source failures  ◇ analytics, queueAll, sources
├─ [ControlCenter] (local)
│   ├─ stage tiles Ingest|Rewrite|Translation|Publish ◇ controlCenter.stages
│   └─ metrics row → [ControlMetric]×5                ◇ usage.ai, currentModel…
├─ [SourceTrustPanel] (local)                      ◇ sourceTrust + note
├─ Newsroom feed (merged history+queue+activity, ≤14)
│   ├─ event rows (level icon + message + detail + relTime)
│   └─ [StoryCard] ×N  ▸ review / edit / publish  (kind=queued only)
├─ [PipelineProgress]?                              ◇ settings.pipelineRun (3s poll)
├─ [EditQueueItemDialog]                            ▸ editQueueItem
└─ [PreviewDialog]                                  ▸ previewNextBatch payload
```

### 10.4 /inbox

```
R inbox.tsx → Inbox
├─ [SectionTitle] action: Clear (AlertDialog) + Refresh-list
├─ Tab bar ALL/REVIEW/READY/HELD/FAILED (+counts)   ◇ queueAll filtered
├─ FAILED extra: rejected rows + operational failures + translation failures
│                                                ◇ recentActivity, translationFailures
├─ [StoryCard] list  ▸ review → /review?id · edit · publish(publishQueueItem)
│                      · reject(setQueueStatus) · delete/ swipe → deleteQueueItem
│   each success: toast + refreshNewsroomData()
└─ Clear-queue AlertDialog: mode x|all, N, includeBreaking ▸ clearQueue
   + [EditQueueItemDialog]
```

### 10.5 /review?id=

```
R review.tsx → Review (search param id → row from queueAll)
├─ col1 Original source: name/time · open-source link · sourceText (46vh scroll)
├─ col2 Generated story: headline+summary textareas · category select
│       (EDIT_CATEGORIES) · breaking switch → Save ▸ editQueueItem
└─ col3 Verification: facts dl (event…confidence, numbers chips) + checks list
   actions: Reject ▸ rejected · Hold ▸ held · Requeue ▸ queued · Publish now
   ▸ publishQueueItem → then refreshNewsroomData() + navigate inbox/published
```

### 10.6 /events

```
R events.tsx → Events
├─ cluster cards (≤12, toggle show-all ≤40)        ◇ clusters
│   ▸ select (local) → right pane
└─ timeline pane: rows join queueAll+history by eventId (≤30, +N older)
```

### 10.7 /published

```
R published.tsx → Published
├─ filter pills TODAY/BREAKING/IRAN/IRAQ/MILITARY/ECONOMY/ALL  ◇ history
├─ stuck-sending panel? ◇ sending → per row Mark sent ▸ resolveSending(sent)
│                                        · Retry ▸ resolveSending(retry)
└─ archive rows: thumbnail? + pills + time + chats + event id + TELEGRAM ✓
```

### 10.8 /analytics · /aidesk · /sources (read-mostly pages)

```
R analytics.tsx → Analytics: KpiBox×4 · recharts BarChart (published/breaking/polls)
   · sources bars (history) · AI panel (aiUsage24h byProvider)
R aidesk.tsx → AiDesk: AI checklist (derived) · Today metrics · Gemini keys
   (listTranslationKeys) · translations/failures lists
R sources.tsx → Sources: health list (state machine) → profile pane (master-detail)
```

### 10.9 /settings

```
R settings.tsx → SettingsShell (owns everything; renders one tab body)
├─ header: back · title + saving indicator · Search(⌘K) · Lock
├─ group nav: 4 TAB_GROUPS → 9 tabs (dirty dot) ▸ selectTab (URL ?tab=)
└─ <SettingsProvider value=ctx> (data + actions + debounced save)
   ├─ activeTab === 'telegram'  → TelegramTab      (cards per §12)
   ├─ 'sources'  → SourcesTab       · 'style' → StyleTab
   ├─ 'editorial' → EditorialTab    · 'categories' → CategoriesTab
   ├─ 'scheduling' → SchedulingTab  · 'campaigns' → CampaignsTab
   ├─ 'ai' → AiTranslationTab       · 'system' → SystemTab + SecurityTab
└─ <SettingsSearch> modal (registry → jumpTo tab+card)
```

---

## 11. Action ↔ backend catalog

Every UI action is a `POST /functions/v1/admin` with
`{ action, pin, ...payload }`. The edge function verifies the PIN on every
call, then dispatches through a single `handlers` map
(`supabase/functions/admin/index.ts:2073`). Responses: `200 {ok,data}` ·
`403` wrong/stale PIN · `404` unknown action · `429` per-IP lockout ·
`500` handler error. Writes go through the service-role REST client (`rest`)
— the anon key has **zero** table policies, so nothing else can write.

### 11.1 Read actions (dashboard + fingerprints)

| Action | Returns | UI consumer | Cadence (client) |
|---|---|---|---|
| `verifyPin` | `{ok}` | PIN gate, lock console | on login |
| `getDashboard` | everything below, one shot | route boot | on mount |
| `dashboardSummary` | KPIs (queue/published/bots/health…) | `/overview` header + `/aidesk` | 30s |
| `dashboardFeed` | pipeline_run + recent queue activity | `/overview` live strip | 10s |
| `dashboardQueue` | queue items (full) | `/inbox` + queue badges | mount + 5m + refresh evt |
| `dashboardChats` | telegram chats | `/settings` Telegram tab | mount + 5m |
| `dashboardSources` | sources w/ health + topics | `/sources`, SourcesTab | 5 min (all authed pages) |
| `dashboardAnalytics` | 24h charts (published, breaking, polls, AI) | `/analytics` | 5 min (all authed pages) |
| `dashboardAi` | AI provider usage + translation health | `/aidesk` | 5 min (all authed pages) |
| `dashboardEvents` | cluster events | `/events` | 5 min (all authed pages) |
| `dashboardPublished` | `published_history` archive | `/published` | 5 min (all authed pages) |
| `getPipelineRun` | live `pipeline_run` jsonb row | `/overview` progress bar | 3 s during a manual run |
| `dashboardSummary` | KPIs (queue/published/bots/health…) | `/overview` header + `/aidesk` | 30 s |
| `dashboardFeed` | pipeline_run + recent queue activity | `/overview` live strip | 10 s |
| `getRewriteLog` | rewrite/debug entries | AiDesk · review debug | on demand |
| `getRewriteAnalytics` | headline-only-drop stats | AiDesk | on demand |
| `listTranslationKeys` / `listTranslationModels` | key rows + live catalog | AiDesk · Settings AI tab | on demand |
| `listScheduled` | campaigns + items | Settings Campaigns tab | 30 s while the tab is open |
| `previewNextBatch` | next N publishable items | `/overview` preview | on demand |

Stateful dashboard actions honour a `since` hash envelope: unchanged state
answers `{hash}` (no payload); changed state returns the full document. That
is the ~100-byte poll optimization (`state_envelope.ts`).

### 11.2 Write actions & the tables they touch

| Action | Payload | Effect (server-side) |
|---|---|---|
| `saveSettings` | `{patch}` camelCase keys | `settings` row(s); keys camel→snake-normalized |
| `setPauseState` | `{paused, reason}` | `settings.bot_paused` + activity log; blocks cron ingest/publish/instant |
| `setCronSchedule` | `{schedule}` | pg_cron job reschedule (or create on first run) |
| `setTranslationModel` | `{model}` | `settings.translation_model` (live switch, no deploy) |
| `saveBot` | bot fields | `bots` upsert (token stored server-side only) |
| `deleteBot` | `{id}` | `bots` delete |
| `addChat` / `updateChat` | chat fields | `chats` insert / update (`chat_id` unique) |
| `upsertTopic` | topic fields | `topics` upsert |
| `upsertSource` | source fields | `sources` upsert (freshness/gates/boost) |
| `upsertTranslationKey` | key + provider | `translation_keys` upsert (masked on read) |
| `setWebhook` | `{baseUrl}` | points primary bot webhook at base URL |
| `enableChatWebhooks` | — | sets webhook + secret_token on **every** enabled bot (chat discovery becomes realtime) |
| `syncBotChats` | — | backfill: getUpdates sweep → `chats` inserts |
| `refreshBotInfo` | — | getMe → update bot name/username |
| `sendTestMessage` / `testPoll` | `{chatId, …}` | direct Telegram `sendMessage`/`sendPoll` |
| `testSource` | `{id}` | fetch source once → health/parse report |
| `testTranslationKey` / `testGeminiKeys` | key id | live provider round-trip (usage-charged) |
| `runPipeline` | `{action?, mode?}` | full ingest→gate→rewrite→queue cycle; real external fetches (see §9.2) |
| `clearQueue` | `{limit?, includeBreaking?}` | `queue` rows → deleted or parked (2 modes); activity log |
| `editQueueItem` | `{id, patch}` | `queue` row update (headline/summary/category/…) |
| `setQueueStatus` | `{id, status}` | held / rejected / queued |
| `deleteQueueItem` | `{id}` | `queue` delete |
| `publishQueueItem` | `{id}` | marks queued → `published_history` (unique `(dedup_key, chat_id)`) → Telegram send via publish pipeline |
| `deletePublishedPost` | `{id}` | `published_history` delete |
| `resolveSending` | `{id?, resolve}` | `sent` → keep post; `retry` → delete reservation so item re-queues |
| scheduled actions (`saveScheduledCampaign`, `saveScheduledItem`, `deleteScheduled…`, `setScheduledCampaignStatus`, `scheduledSkipNext`, `scheduledSendNext`, `scheduledSendItem`, `scheduledResetItem`) | campaign/item fields | `scheduled_campaigns` / `scheduled_items` (auto-send engine) |

### 11.3 Who fires what (page → write actions)

| Page | Actions fired |
|---|---|
| `/overview` | `setPauseState` (pause/resume) · `runPipeline` (ingest / publish / breaking-cycle) · `clearQueue` · `publishQueueItem` (quick publish) · `editQueueItem` · `sendTestMessage` · `previewNextBatch` |
| `/inbox` | `setQueueStatus` (hold/reject/un-hold) · `editQueueItem` (via `EditQueueItemDialog`) · `publishQueueItem` |
| `/review` | `editQueueItem` (headline/summary) · `setQueueStatus` (approve→queued, reject) · `publishQueueItem` |
| `/published` | `resolveSending` (sent/retry) · `deletePublishedPost` |
| `/events` | (read-only timeline + cluster drill-down) |
| `/analytics` · `/aidesk` | `testTranslationKey` · `testGeminiKeys` · `runPipeline` (manual cycle from AiDesk) |
| `/sources` | `testSource` |
| `/settings` | `saveSettings` · `saveBot`/`deleteBot` · `addChat`/`updateChat` · `upsertSource`/`upsertTopic` · `upsertTranslationKey`/`testTranslationKey` · `setCronSchedule` · `setWebhook` · `enableChatWebhooks` · `syncBotChats` · `refreshBotInfo` · `sendTestMessage`/`testPoll` · `listScheduled` + all scheduled CRUD |

### 11.4 Auth envelope (every call)

```
POST /functions/v1/admin
{ action, pin, ...payload }        → 200 { ok, data } | 403 | 404 | 429 | 500
```

- PIN check happens **before** dispatch; only `verifyPin` failures count
  toward the per-IP lockout (so stale stored PINs from parallel polls can't
  self-lock an IP).
- The `/telegram-webhook` URL path bypasses the PIN gate but is authenticated
  by per-bot `secret_token` (Telegram can't know the admin PIN).
- 403 / 429 on any poll → client clears the stored PIN, fires
  `freebuff:auth-rejected`, redirects to `/`. 500s surface inline.

---

## 12. Per-card settings detail (all 9 tabs)

Every card below lives in `src/components/settings/<Tab>.tsx`. The pattern is
uniform: `const { s, save } = useSettings()` — `s["camelKey"]` reads the live
value (`?? default` shown below when the code defines one), and
`save({ camelKey: v })` optimistically applies + debounce-writes a
`saveSettings` patch (edge function normalizes camelCase → snake_case DB
keys). Cards marked **action** use a dedicated admin action instead.

### 12.1 Telegram tab (`TelegramTab.tsx`)

| Card (id) | Controls / keys | Kind |
|---|---|---|
| Bot Connection | bot info display · **Test message** box → `sendTestMessage` · **Set webhook** → `setWebhook` | action |
| Bots | per-bot row: name/token field, enable toggle, refresh info → `refreshBotInfo`, save → `saveBot`, delete → `deleteBot`, enable realtime chat discovery → `enableChatWebhooks` (sets webhook + secret_token on **all** enabled bots) | action |
| Polls | compose + **Send test poll** → `testPoll`; recent polls list (chat polls) | action |
| Chats | chat list (from `dashboardChats`) · add chat → `addChat` · edit/rename → `updateChat` · rescan via webhook/getUpdates → `syncBotChats` | action |
| (no card — sidebar control) | **Excluded categories for primary bot** → `primaryBotExcludedCategories` (categories never auto-posted to the main channel) | save |

### 12.2 Sources tab (`SourcesTab.tsx`)

| Card | Controls / keys | Kind |
|---|---|---|
| Providers | provider blocks (Telegram channels / NewsData / Google News / Publisher RSS) — toggles live in Scheduler (12.6); per-provider count + health | read |
| Telegram Channels | monitored channels; add/remove; test fetch → `testSource` | action |
| Source Quality | auto-pause when a source degrades: `sourceAutoPauseEnabled`, `sourceAutoPauseThreshold` (default 8 failures) | save |
| Topic Queries | topic rows (feed → query → category gate); add/edit → `upsertTopic`, delete with `remove:true` | action |
| (row actions) | each source row: pause toggle, freshness/boost fields, delete → `upsertSource` (whole-row save) · **Test** → `testSource` | action |

### 12.3 Style tab (`StyleTab.tsx`)

| Card | Controls / keys | Kind |
|---|---|---|
| AI writing style | per-category text style: `styleByCategory`, `textStyleRules` (per-category rule objects), `textStyle`/`textStyleAuto` (auto = model chooses), `textStyleAiAssist`, `textLength`, `breakingPrefix`, `aiCompress` | save |
| Summary source | how summaries are built: `extractiveLede`, `enrichSummaries`, `sourceTierEnabled` (tier-gated summary depth) | save |
| Post Format | Telegram post chrome: `postEmoji`, `postFooter`, `postLinkLabel`, `postShowTimestamp`, `postShowWebSource`, `postShowTelegramSource`, `grabImages`, `linkPreviews`, `autoHashtag`, `postLinks` (on/off) | save |
| Language | output language → `defaultLanguage` | save |
| Hashtag rules | per-category hashtag rule objects → `hashtagRules` (each with topic list; add/remove topic) | save |

### 12.4 Editorial tab (`EditorialTab.tsx`)

| Card | Controls / keys | Kind |
|---|---|---|
| Breaking-News Criteria | which categories break: `breakingCategories`; `breakingInterruptsNight` (breaking can post at night), `breakingMaxAgeHours` (default 8 — older breaking never posts) | save |
| News quality | update/refresh cadence on already-published events: `updatePrefix` (e.g. "UPDATE:"), `updateCooldownHours` (default 1), `updateMaterialThreshold`, `maxUpdatesPerCycle` | save |
| Why-it-matters follow-ups | `whyItMattersEnabled`, `whyItMattersCategories`, `whyItMattersMaxPerDay`, `whyItMattersPrefix` | save |
| Telegram Video Handling | video fetch policy: `telegramVideoFetchMode`, `telegramVideoStagingChatId` | save |

### 12.5 Categories tab (`CategoriesTab.tsx`)

| Card | Controls / keys | Kind |
|---|---|---|
| Category Policy | routing policy object → `categoryPolicy` (incl. `updatePolicy`) — how sources/topics map to categories, and which categories gate | save |

### 12.6 Scheduling tab (`SchedulingTab.tsx` — embeds `SchedulerTab`)

| Card | Controls / keys | Kind |
|---|---|---|
| Scheduler (job cadence) | `ingestIntervalMinutes` (def. 15 — news search + queue) · `telegramSignalsIntervalMinutes` (def. 5) · `minPostGapMinutes` (def. 1) · fetch toggles `fetchTelegramEnabled`, `fetchNewsdataEnabled`, `fetchGoogleNewsEnabled`, `fetchPublisherFeedsEnabled` · `maxQueueSize` (def. 150, 0 = off) | save |
| Pipeline ticker (cron) | wake-up interval → `setCronSchedule({ schedule })` (`* * * * *` def.; applies live to pg_cron, first run creates the job) | action |
| Freshness limits | `maxAgeBreakingHours` (14) · `maxAgeNewsHours` (22) · `maxAgeAnalysisHours` (48) · `telegramMaxAgeHours` (6 — channel posts older never enter) | save |
| Publishing Speed | `sendDelayMs` (def. 30s, min 1s) — delay between consecutive posts | save |
| Posting Windows | day: `dayStart`/`dayEnd` (06:00–22:00) + `dayMinMinutes`/`dayMaxMinutes` (6–16) · night: `nightStart`/`nightEnd` (22:00–06:00) + `nightMinMinutes`/`nightMaxMinutes` (10–20) — spacing randomized within the active window's Min–Max; night also gates non-breaking | save |

### 12.7 Campaigns tab (`CampaignsTab.tsx`)

| Card | Controls | Kind |
|---|---|---|
| Campaigns | campaign list; **New campaign / Edit** dialog — name, kind (`one_time`/`recurring`), cadence + interval-days, start/end, parts editor (add/remove/reorder parts, each a send payload) | action |
| Parts — &lt;name&gt; | per-part rows: edit text, **Send now** → `scheduledSendItem`, **Reset to pending (retry)** → `scheduledResetItem` | action |
| (row actions) | enable/pause → `setScheduledCampaignStatus` · **Skip next** → `scheduledSkipNext` · **Send next now** → `scheduledSendNext` · edit → `saveScheduledCampaign` / `saveScheduledItem` · delete → `deleteScheduledCampaign` / `deleteScheduledItem` | action |

### 12.8 AI tab (`AiTranslationTab.tsx` + `GlossaryEditor.tsx`)

| Card | Controls / keys | Kind |
|---|---|---|
| AI Dedup | final duplicate check on the queue: `aiDedupEnabled`, `aiDedupMode`, `aiDedupWindowHours` (def. 72), `aiDedupMaxPosts` (def. 30), `aiDedupProvider` | save |
| Translation Provider | current provider/model selector (writes `translation_model` via dedicated action) | action |
| Translation model order | ordered list (`translationModelOrder`) — tried top to bottom, drag to reorder | save |
| Translation API Keys | per-provider key rows (masked): add/update → `upsertTranslationKey`, **Test** → `testTranslationKey`, delete | action |
| Glossary | Kurdish terminology glossary object → `translationGlossary` (term replacement map) | save |
| Gemini Key Usage | live usage bars → `testGeminiKeys` + usage read | action |
| Translation History | expandable recent translations (read-only from dashboard data) | read |

### 12.9 System tab (`SystemTab.tsx` + `SecurityTab.tsx`)

| Card | Controls | Kind |
|---|---|---|
| System Status | deployed backend health — schema-migration probe, bot/pause state, pipeline_run age (read-only) | read |
| Scheduler (pg_cron) | cron job state + last-run info (read-only; schedule is set in 12.6) | read |
| Security | how the console is protected — server-side PIN, per-IP lockout, zero-policy RLS, env-only secrets (read-only explainer) | read |

---

## 13. Data dictionary

Backend is Supabase Postgres. Every table has RLS enabled with **zero
policies** — the anon key cannot read or write anything. Only the edge
functions (service role, server-side) touch data, so every row below that is
user-visible arrived via a `dashboard*`/`get*` admin action.

### 13.1 Tables

| Table | Purpose | Key columns / notes | Written by |
|---|---|---|---|
| `settings` | single source of truth for pipeline config + state | one row (or few, keyed); jsonb-heavy; `bot_paused`, `pipeline_run`, `translation_model`, cron + freshness + style keys (see 13.2) | `saveSettings`, `setPauseState`, `setCronSchedule`, `setTranslationModel`, pipeline (writes `pipeline_run` progress) |
| `queue` | editorial triage inbox (ingested items awaiting review) | status: `queued`/`held`/`rejected` (+ sending flow), headline/summary/category/breaking flags, dedup/score fields, event linkage | pipeline ingest → here; `setQueueStatus`, `editQueueItem`, `publishQueueItem`, `clearQueue` |
| `raw_articles` | dedup staging of fetched source content | source url + fetched text before AI | pipeline ingest |
| `published_history` | send archive + **delivery reservation** | unique `(dedup_key, chat_id)` index; status `sending`/`sent`/`failed`; message_id, chat_id | pipeline publish, `publishQueueItem`, `resolveSending` |
| `clusters` | event clusters (breaking stories grouped) | event id, headline set, timeline | pipeline event/cluster builder |
| `sources` | feed sources + per-source policy | kind, url/query, enabled, freshness limit, boost, auto-pause health counters | `upsertSource`, pipeline health |
| `topic_queries` | topic → query → category routing | topic, query, category, enabled | `upsertTopic` |
| `bots` | Telegram bot config | name, token (**server-side only**, never in bundle), enabled, webhook state | `saveBot`, `deleteBot`, `setWebhook` |
| `chats` | known Telegram chats/channels | chat_id (unique), title, type, bot_id, last_seen | `addChat`, `updateChat`, webhook discovery, `syncBotChats` |
| `translation_provider_keys` | AI provider API keys | provider, masked value (never returned fully), enabled | `upsertTranslationKey` |
| `translation_history` | recent translation attempts + outputs | input hash, model, result | pipeline translation |
| `translation_failures` | failed translation attempts (retry bookkeeping) | provider, error, attempts | pipeline translation |
| `ai_usage` / `ai_attempt_log` | per-provider usage counters + attempt log | provider, calls, tokens | pipeline AI calls |
| `gemini_key_usage` / `gemini_call_log` | Gemini key-level usage + call log | key id, model, latency, ok | pipeline Gemini lane |
| `rewrite_log` | rewrite/debug entries (incl. headline-only drops) | item, verdict | pipeline rewrite gate |
| `scheduled_campaigns` / `scheduled_items` / `scheduled_log` | campaign engine: campaigns → ordered parts, send log | campaign status (paused/enabled), part send state, attempts | scheduled CRUD actions + `scheduled` engine |
| `activity_log` | operator + pipeline audit trail | type (`pipeline`, `chat`, …), level, message, created_at | every admin write + pipeline milestones |
| `admin_auth_attempts` | per-IP PIN failure/lockout bookkeeping | ip, fail count, window | admin PIN gate |

### 13.2 Settings key dictionary (UI camelCase → stored snake_case)

Values the Settings pages write via `saveSettings`; edge function
camel→snake-normalizes. Defaults shown are the client-side fallbacks.

| UI key (camel) | Meaning | Default |
|---|---|---|
| `botPaused` | master stop (paused ⇒ no cron ingest/publish/instant) | false |
| `ingestIntervalMinutes` | news search + queue cadence | 15 |
| `telegramSignalsIntervalMinutes` | Telegram channel fetch cadence | 5 |
| `minPostGapMinutes` | min spacing between posts | 1 |
| `fetchTelegramEnabled` / `fetchNewsdataEnabled` / `fetchGoogleNewsEnabled` / `fetchPublisherFeedsEnabled` | per-provider fetch toggles | true |
| `maxQueueSize` | backlog cap (0 off; excess lowest-score non-breaking dropped) | 150 |
| `cronSchedule` | pg_cron wake interval (via `setCronSchedule`) | `* * * * *` |
| `maxAgeBreakingHours` / `maxAgeNewsHours` / `maxAgeAnalysisHours` / `telegramMaxAgeHours` | freshness auto-drop windows | 14 / 22 / 48 / 6 |
| `sendDelayMs` | delay between consecutive sends | 30000 |
| `dayStart`/`dayEnd`, `dayMinMinutes`/`dayMaxMinutes` | day posting window + randomized spacing | 06:00–22:00, 6–16 |
| `nightStart`/`nightEnd`, `nightMinMinutes`/`nightMaxMinutes` | night window (also gates non-breaking) | 22:00–06:00, 10–20 |
| `breakingCategories` / `breakingInterruptsNight` / `breakingMaxAgeHours` | what breaks, night interrupt, max age | — / false / 8 |
| `updatePrefix` / `updateCooldownHours` / `updateMaterialThreshold` / `maxUpdatesPerCycle` | UPDATE: follow-ups on published events | "UPDATE:" / 1 / — / — |
| `whyItMattersEnabled` / `whyItMattersCategories` / `whyItMattersMaxPerDay` / `whyItMattersPrefix` | why-it-matters follow-ups | — |
| `telegramVideoFetchMode` / `telegramVideoStagingChatId` | video attachment handling | — |
| `categoryPolicy` | source/topic → category routing incl. `updatePolicy` | — |
| `translationModelOrder` | model order tried top→bottom | seeded list (3.x first) |
| `translationModel` | active model (`setTranslationModel` action) | seed default |
| `translationGlossary` | Kurdish terminology override map | — |
| `aiDedupEnabled` / `aiDedupMode` / `aiDedupWindowHours` / `aiDedupMaxPosts` / `aiDedupProvider` | final semantic dedup pass | false / — / 72 / 30 / — |
| `sourceAutoPauseEnabled` / `sourceAutoPauseThreshold` | auto-pause failing sources | — / 8 |
| `primaryBotExcludedCategories` | categories never auto-posted to primary bot | — |
| style block: `textStyle`, `styleByCategory`, `textStyleRules`, `textLength`, `textStyleAuto`, `textStyleAiAssist`, `breakingPrefix`, `aiCompress` | per-category writing style | — |
| summary block: `extractiveLede`, `enrichSummaries`, `sourceTierEnabled` | summary construction | — |
| format block: `postEmoji`, `postFooter`, `postLinkLabel`, `postShowTimestamp`, `postShowWebSource`, `postShowTelegramSource`, `postLinks`, `grabImages`, `linkPreviews`, `autoHashtag` | Telegram post chrome | — |
| `defaultLanguage` | output language | — |
| `hashtagRules` | per-category hashtag → topic rules | — |

### 13.3 Live-state shapes the UI reads

- **`pipeline_run`** (jsonb, in `settings`): `{ status, stage, startedAt, … }`
  written progressively by the pipeline; Overview polls it at ~3 s during a
  manual run. `status: "running" | "done" | "error" | "skipped"…`.
- **Queue row**: `id, headline, summary, category, breaking, source_url,
  dedup_key, score, status (queued/held/rejected), timestamps`.
- **`published_history` row**: `id, dedup_key, chat_id, status
  (sending/sent/failed), message_id, sent_at`.
- **Activity entry**: `type, level (info/warn/error), message, created_at` —
  the raw stream the Overview/AiDesk log panels and KPI counts derive from.

Everything above was verified against `supabase/functions/**` and the
settings components this session; where the code exposes a client default it
is listed, otherwise `—`.
