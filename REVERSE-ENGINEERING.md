# Iran Desk — Full Architecture Reference (2026-08)

This document is the authoritative description of how the Iran Desk Bot
actually works today. The backend runs entirely on **Supabase** (Postgres +
four Edge Functions) — Convex is gone. The frontend is a newsroom operations
app with a PIN-gated sign-in. Anything referencing Convex, a local dev
backend, a `/convex` proxy, the old `/dashboard` route, or the Daily
Bulletin feature is obsolete.

---

## 1. Stack

- **Frontend**: React 19 + Vite + **TanStack Router** (file-based routes,
  route tree generated automatically by the `@tanstack/router-plugin/vite`
  plugin into `src/routeTree.gen.ts` — there is no manual route-gen script),
  Tailwind CSS v4, shadcn/ui components, `lucide-react` icons, `sonner`
  toasts, `recharts` charts.
- **Backend / database**: Supabase project `ljvdaajfbkqeodglghwn`. Postgres
  holds all state. Four **Edge Functions** do the work:
  - `admin` — the PIN-gated JSON API the SPA calls directly, including the
    Telegram webhook receiver and AI control-plane actions.
  - `pipeline` — the full news pipeline (fetch → gate → cluster → rewrite →
    enqueue → route → translate → publish) + retention + chat discovery.
  - `scheduled` — scheduled campaigns and series posts.
  - `telegram-webhook` — authenticated chat discovery receiver for Telegram
    bot updates.
- **Scheduler**: `pg_cron` ticks the `pipeline` function on an
  **operator-chosen cadence** (Settings → Scheduler → Pipeline ticker;
  whitelist `*`, `*/2`, `*/5`, `*/10`, `*/15`; default `*/5`). History:
  0002 = 1/min, 0015 = 1/5min for egress, 0045 = back to 1/min so gap
  settings are honored exactly, 0046 = made it a dropdown via the
  security-definer RPC `set_pipeline_cron_schedule(text)` (PostgREST cannot
  touch `cron.*` directly). Current live choice is stored in
  `settings.cron_schedule` and visible in the dashboard's cron-health panel.
  The tick only wakes the function — ingest/fast-lane/publish are gated by
  their own editable interval settings and the day/night windows. NOTE: the
  wake-up interval quantizes publish gaps — the window-gap check only runs
  on a wake, so a 4–6 min gap setting with a */5 ticker yields ~5 or ~10 min
  spacing; every-minute yields the exact roll.
- **Runtime**: Bun for installs/scripts. Vite dev server binds `0.0.0.0`
  with HMR disabled (Freebuff requirement).
- **Deployment**: Freebuff-managed hosting for the SPA (`vite build` →
  `dist/`); Edge Functions deploy independently via the Supabase Management
  API (`scripts/_deploy_fn.mjs`); migrations apply via the Management API
  SQL endpoint (`scripts/apply_supabase_migrations.mjs`). See §15.

The SPA is a static build. It talks to the cloud Supabase `admin` function
(URL + anon key baked in by `vite.config.ts`), never a local backend, so
settings/queue/history persist across preview restarts. Every admin call is
PIN-gated server-side; the service-role key never leaves the Edge Functions.

---

## 2. Frontend layout

Routing is file-based under `src/routes/`.

| Route | File | Purpose |
| --- | --- | --- |
| `/` | `src/routes/index.tsx` | PIN sign-in (theme toggle, verify via `admin.verifyPin`) |
| (layout) | `src/routes/_authenticated/route.tsx` | Auth guard + `AppShell` wrapper |
| `/overview` | `_authenticated/overview.tsx` | Command bar, KPI strip, live newsroom feed |
| `/inbox` | `_authenticated/inbox.tsx` | Editorial queue with ALL/REVIEW/READY/HELD/FAILED tabs |
| `/review` | `_authenticated/review.tsx` | 3-column editorial workspace (source · generated · facts) |
| `/events` | `_authenticated/events.tsx` | Event clusters + timeline |
| `/published` | `_authenticated/published.tsx` | Archive with filters (Today/Breaking/Iran/Iraq/Military/Economy) |
| `/sources` | `_authenticated/sources.tsx` | Source health + per-source profile |
| `/aidesk` | `_authenticated/aidesk.tsx` | AI pipeline stages, usage, Gemini key health, translations |
| `/analytics` | `_authenticated/analytics.tsx` | 14-day analytics (sparklines, deltas, channels, categories, scheduler health, activity) |
| `/settings` | `_authenticated/settings.tsx` | Thin route → `SettingsShell` (8 tabs, see below) |

`src/routes/index.tsx` is a **route file under the workspace sync layer**:
edits to it (and to other route files) must be made via terminal/git, not the
file tools, or the sync scaffolder replaces them with a TanStack placeholder.

### Shell & shared UI

- `src/components/AppShell.tsx` — wraps children in `NewsroomProvider`, then
  renders the sidebar (brand, nav, live Inbox badge, bot-status + last-run
  footer, Lock console) + mobile top bar/drawer/bottom nav
  (Overview / Inbox / Events / Sources / More).
- `src/components/newsroom.tsx` — reusable primitives: `Kpi`, `StoryCard`,
  `StatusPill`, `CategoryPill`, `ConfirmAction`, `EditQueueItemDialog`,
  `SectionTitle`, `EmptyState`, relative-time helpers.
- `src/components/AddChat.tsx`, `src/components/TelegramChannels.tsx`,
  `src/components/BotsCard.tsx` — chat / Telegram-channel / bot management,
  reused inside Settings → Telegram.
- `src/components/settings/` — the entire Settings console: `SettingsShell`
  (8-tab shell owning the shared context, debounced save, PIN handling),
  `shared.tsx` (SettingsProvider context, `Card`, `CompactSelect`,
  `CompactInput`, `Row`, `SubText`, `IconBtn`), and one file per tab.
- `src/components/ui/*` — shadcn/ui primitives.

### Data access layer

| File | Role |
| --- | --- |
| `src/lib/supabase.ts` | Supabase client + `adminFunctionUrl()` |
| `src/lib/pinStorage.ts` | Shared `readStoredPin` / `clearStoredPin` / `PIN_STORAGE_KEY` |
| `src/lib/adminApi.ts` | Typed wrapper for every `admin` action; dispatches `freebuff:auth-rejected` on 403/429 |
| `src/lib/supabaseAdminHooks.ts` | `useAdminQuery` (per-call poll interval, `"skip"` support, visibility pause), `useAdminMutation`, `useAdminAction`, `api.*` string proxy |
| `src/lib/newsroomStore.tsx` | `NewsroomProvider` — one poll per focused resource, merged payload via `useNewsroomData()` |

The SPA never calls PostgREST directly. Every read/write goes through the
`admin` Edge Function with the stored PIN.

### Data freshness model (egress fast-win)

The old `getDashboard` pulled ~17 datasets (including 2,000–5,000-row scans)
on every 5s poll from every mounted page. It is now split into **8 focused
resources**, each fetched once per interval by `NewsroomProvider`:

| Resource | Cadence | Contents |
| --- | --- | --- |
| `dashboardSummary` | 10s | settings, bots (token-masked), counts (SQL RPC), AI usage, cron health, schema drift |
| `dashboardFeed` | 5s | queued items (top 50) + recent activity — the only truly live part |
| `dashboardQueue` | 60s | full queue (300), published history (200, deduped), chats (500) |
| `dashboardSources` | 60s | sources + topic queries |
| `dashboardAi` | 60s | translation history + failures |
| `dashboardEvents` | 60s | event clusters |
| `dashboardPublished` | 60s | polls |
| `dashboardAnalytics` | 60s | 14-day SQL series |

All polls **pause while the tab is hidden** (`visibilitychange` in
`useAdminQuery`) — a background tab pays zero egress and resumes on return.
The Settings page additionally polls `listTranslationKeys` (up to 5,000 usage
rows) every **30s** while mounted, not the 5s default.

### Settings tabs (8)

`SettingsShell` renders one tab at a time (sidebar nav on desktop, horizontal
scroll on mobile). Every control auto-saves through a **600 ms-debounced**
`saveSettings` (camelCase key → `camelToSnake` → PATCH on the single
`settings` row) with an optimistic overlay, and the debounce **flushes on
unmount** so mid-debounce navigation never loses edits.

| Tab | Cards |
| --- | --- |
| **Telegram** | Bot Connection (env-token status, refresh info, webhooks) · Bots (primary-bot category blocklist + N additional bots with per-bot category whitelists) · Polls (test poll sender) · Recent Polls · Chats (grouped by assigned bot, per-row bot/language/active/remove) |
| **Sources** | Providers (NewsData/RSS/Telegram sources, per-fetch-type toggles from 0022) · Telegram Channels · Source Quality (auto-pause settings) · Topic Queries |
| **Editorial** | Breaking-News Criteria (breaking categories, max age, thresholds) · News quality (dedup threshold, update cadence) |
| **Posting** | Publishing Speed (delays) · Post Format (footer, emoji, link label, per-source-type attribution toggles from 0021, footer hyperlinks) · Language (default + per-chat overrides, **Auto hashtags** toggle) · Posting Windows (day/night, breaking interrupt) · Telegram Video Handling |
| **Scheduler** | Interval minutes for each job (ingest, Telegram signals, …) · Max queue size · Pipeline ticker (cron wake-up dropdown — live reschedule) · Freshness limits (breaking/news/analysis/Telegram max age in hours, live-editable) |
| **AI & Translation** | AI Dedup (provider + enable) · Translation Provider · Translation model order (reorderable) · Translation API Keys · Gemini Key Usage · Translation History · Translation Failures · AI Rewrite Log (per-chunk attempts: provider/model, headline previews, error, status) · Translation Glossary (row-based editor: term/translation per row, reorder/import, counter) |
| **System** | System Status (schema drift, bot token, NewsData key, queue/published/translation-fail counts) · Scheduler (pg_cron) health |
| **Security** | PIN behavior, brute-force lockout description, Lock console |

---

## 3. Backend layout

| File | Role |
| --- | --- |
| `supabase/migrations/0001_init.sql` … `0049_ai_control_plane.sql` | Schema + cron + feature migrations (see §4) |
| `supabase/functions/pipeline/index.ts` | Scheduler entrypoint: `runCycle` + mode dispatch + `computePublishPreview` |
| `supabase/functions/pipeline/config.ts` | Settings types, env wiring, model constants, bot-category list |
| `supabase/functions/pipeline/db.ts` | PostgREST helpers, settings fetch, list helpers, retention (`pruneQueueAndRetain`), queue-cap trim |
| `supabase/functions/pipeline/telegram.ts` | Bot-API calls (send*, getUpdates, webhooks), media handling, poll sending |
| `supabase/functions/pipeline/fetch.ts` | NewsData / Google News RSS / publisher feed / Telegram-channel-page fetchers |
| `supabase/functions/pipeline/gates.ts` | Deterministic content gates (junk, respect/Kurd-hostile, relevance, freshness, English) |
| `supabase/functions/pipeline/ai.ts` | Rewrite + fact extraction (`groqExtractFacts`), rewrite log, final-dedup chain |
| `supabase/functions/pipeline/publish.ts` | Candidate selection, dedup, multi-bot routing, translation hook-in, send loop |
| `supabase/functions/pipeline/ingest.ts` | Ingest orchestration (Telegram + web), scoring, queue insert |
| `supabase/functions/pipeline/_shared.ts` | Pure helpers (formatMessage, similarity, categories, fingerprints, Sorani validator, lean glossary, …) — unit-tested directly |
| `supabase/functions/admin/index.ts` | PIN-gated admin API (all dashboard + mutation actions, lockout, webhook receiver) |
| `supabase/functions/admin/_shared.ts` | Pure lockout helpers (unit-tested) |
| `scripts/_deploy_fn.mjs` | esbuild-bundles + deploys an Edge Function via Management API |
| `scripts/apply_supabase_migrations.mjs` | Applies every `supabase/migrations/*.sql` statement via Management API; supports an optional migration filter and reloads PostgREST schema |
| `scripts/admin_smoke.sh` | Live end-to-end smoke test of the deployed `admin` function (requires `ADMIN_PIN`) |
| `scripts/deploy_cloudflare_worker.mjs` | Deploys the egress-relay Cloudflare Worker |
| `scripts/*.test.ts` | Unit tests for pure logic (see §15) |

---

## 4. Migrations (0001 → 0049)

| File | What it adds |
| --- | --- |
| `0001_init.sql` | All core tables + indexes (settings, ai_usage, topic_queries, sources, chats, raw_articles, queue, published_history, clusters, translation_failures, translation_provider_keys, activity_log, translation_history, gemini_throttle, gemini_call_log, gemini_key_usage, polls) |
| `0002_cron.sql` | `pg_cron` minute ticker → `pipeline` (superseded by 0015) |
| `0003_cache_and_retention.sql` | Translation cache column/index + queue status index |
| `0004_slim.sql` | DB size reduction on the free plan |
| `0005_telegram_video_bot.sql` | Bot-API video mode + media columns |
| `0006_slim_after_post.sql` | Post-publish retention slimming |
| `0007_enable_rls.sql` | Row-level security enabled on every public table (zero policies) |
| `0008_ai_and_idempotency.sql` | AI dedup settings + idempotent publish |
| `0009_news_quality.sql` | `facts`, `is_update`, `breaking_max_age_hours`, update cadence |
| *(0010 was the bulletin cron — deleted with the feature; see 0020)* | |
| `0011_gemini_first_translation.sql` | Flips live `translation_mode` to `gemini_first` |
| `0012_post_links.sql` | `settings.post_links jsonb` (operator footer hyperlinks) |
| `0013_cron_config.sql` | Cron HTTP target + internal secret read from the settings row |
| `0014_cron_health.sql` | Public `cron_job_health` view over pg_cron internals |
| `0015_cron_5min.sql` | Pipeline cron tick 1/min → 1/5min (egress reduction) |
| `0016_translation_model_order.sql` | `settings.translation_model_order jsonb` — operator-reorderable chain |
| `0017_gateway_gemini_models.sql` | `google/gemini-2.5-flash(-lite)` via the Vercel AI Gateway |
| `0018_bots.sql` | `bots` table: N additional Telegram bots with per-bot category whitelists; `chats.bot_id` |
| `0019_chat_sync.sql` | `settings.last_chat_sync_at` — 24h auto chat discovery gate |
| `0020_remove_bulletin.sql` | Removes the Daily Bulletin entirely (cron job + settings columns) |
| `0021_post_source_toggles.sql` | Per-source-type attribution toggles (`post_show_telegram_source`, `post_show_web_source`) |
| `0022_fetch_source_toggles.sql` | Per-fetch-type master switches (Telegram / NewsData / Google News / feeds) |
| `0023_queue_trim.sql` | `settings.max_queue_size` — auto-trim of lowest-scored non-breaking backlog |
| `0024_dashboard_aggregates.sql` | SQL RPCs `dashboard_counts()` + `dashboard_analytics()` (aggregates move into Postgres) |
| `0025_primary_bot_exclusions.sql` | `settings.primary_bot_excluded_categories text[]` — main-bot category blocklist |
| `0026_rewrite_log.sql` | `rewrite_log` table — one row per rewrite chunk attempt |
| `0027_admin_pin_lockout.sql` | `admin_auth_attempts` table — per-IP PIN brute-force lockout |
| `0028_state_fingerprints.sql` | Published-state fingerprints (dashboard change detection) |
| `0029_rewrite_preview_analytics.sql` | Rewrite preview + analytics RPCs |
| `0030_state_fingerprint_coverage.sql` | Coverage guard for fingerprint manifest |
| `0031_scheduled_posts.sql` | Scheduled/campaign posts engine (+ its own cron job `news-desk-scheduled`) |
| `0032_conflict_categories.sql` | Conflict-beat category set (iran, usa, gaza, syria, lebanon, war, …) |
| `0033_auto_hashtag.sql` | `settings.auto_hashtag` (default on) — localized category hashtag per post |
| `0034_analysis_followups_source_tiers.sql` | Analysis follow-ups + source trust tiers |
| `0035_queue_dedup_and_campaign_status.sql` | Queue dedup hardening + campaign status transitions |
| `0036_writing_styles.sql` | Per-category writing styles (`style_by_category`, auto style) |
| `0037_hashtag_rules.sql` | Operator hashtag rules (`settings.hashtag_rules jsonb`) |
| `0038_lock_ownership.sql` | Publish-lock ownership column (crash-safe reclaim) |
| `0039_auto_style_and_source_tier.sql` | Auto text-style selection + source-tier byline columns |
| `0040_disable_why_it_matters_by_default.sql` | "Why it matters" generation off by default |
| `0041_category_policies.sql` | Per-category policy jsonb (status/priority/freshness/keywords) |
| `0042_category_priority_parity.sql` | Category priority parity across bots |
| `0043_publish_delete.sql` | `published_history.telegram_message_id` + delete-post plumbing (records msg id at send; admin `deletePublishedPost` deletes from every chat) |
| `0044_age_limits.sql` | Customizable freshness limits (`max_age_breaking/news/analysis_hours`, `telegram_max_age_hours`) |
| `0045_cron_1min.sql` | Pipeline cron back to 1/min (gap precision) — superseded by the operator dropdown of 0046 |
| `0046_cron_customizable.sql` | `settings.cron_schedule` + whitelisted security-definer RPC `set_pipeline_cron_schedule(text)` (re-arms the pg_cron job; PostgREST cannot reach `cron.*`) |
| `0047_english_summary.sql` | English summary fields and source-preserving summary support |
| `0048_summary_source_routing.sql` | `extractive_lede` and `ai_compress` settings for source-led summaries and bounded AI compression |
| `0049_ai_control_plane.sql` | Provider registry, per-action fallback routes, and unified AI attempt logs; API keys remain server-side |

The pipeline reads columns from 0005/0009/0011/0012/0016/0021/0022/0047/0048; the admin AI control plane also requires 0049. If
migrations lag the deployed functions, `admin` returns `schemaMigrations`
drift info and the SPA shows a "database schema is behind" banner.

### Data model (key tables)

- **settings** — single row; every operator control (`default_language`,
  `bot_paused`, intervals, day/night windows, `post_footer`, `post_links`,
  `translation_mode`, `translation_model_order`, `breaking_max_age_hours`,
  `max_queue_size`, `primary_bot_excluded_categories`,
  `last_chat_sync_at`, `last_telegram_signals_at`, `last_ingest_at`, …).
- **bots** — additional Telegram bots (`name`, `token` stored per operator
  decision, `categories text[]` whitelist, `enabled`). `bot_id = NULL` on a
  chat = the **primary bot** (env token, delivers everything).
- **chats** — destination chat per bot: `chat_id`, `type`, `language`
  override, `active`, `polls_enabled`, `bot_id`, `last_seen_at`.
- **sources** — RSS / NewsData / Telegram sources with priority, boost
  (0 normal / 1 fast / 2 instant), `published_count` / `rejected_count` /
  `consecutive_rejects`, auto-pause flags.
- **queue** — ingest output: `dedup_key`, `headline`, `summary`, `category`,
  `source_name`, `url`, `image_url`, `video_url`, `media_kind`, `event_id`,
  `facts` (jsonb), `is_update`, `importance`, `score`, `score_parts`,
  `status` (`queued` / `held` / `rejected` / `expired`, plus transient
  `publishing` / `published` / `duplicate` during a send).
- **published_history** — idempotency rows keyed by `(dedup_key, chat_id)`,
  status `sending` → `sent`; doubles as the analytics source (7d retention).
- **clusters** — cross-outlet event grouping (`event_id`, `label`,
  `last_headline`, `post_count`, 3d retention).
- **translation_history** — content-hash cache (`cache_key`) of
  English → Sorani pairs (16h retention).
- **translation_failures** — failed translations (honest "translation fails"
  stat).
- **rewrite_log** — per-chunk rewrite attempts (provider, model, ok/error,
  headline previews). *Not currently pruned by the retention pass* — volume
  is a few rows per ingest cycle.
- **activity_log** — operational events shown in the Overview feed / Inbox
  FAILED tab (3d retention).
- **ai_usage** — per-day/provider/kind token+calls (30d retention).
- **gemini_throttle / gemini_call_log / gemini_key_usage** — per-key × model
  quota health (7d call-log retention).
- **admin_auth_attempts** — per-IP PIN failure counters backing the lockout
  (lazily pruned; see §13).

---

## 5. Scheduler & cycle (`runCycle` in `pipeline/index.ts`)

pg_cron POSTs to `pipeline` on the operator's chosen schedule (Settings →
Scheduler → Pipeline ticker; currently `*/5`, see §1) with the internal
secret; calls without the matching secret are rejected. The wake-up
interval quantizes the publish cadence — every other gate is time-based.
Each cycle:

1. **`bot_paused` gate** — STOP ALL.
2. **Retention** — `pruneQueueAndRetain()` runs even while a publish lock is
   held (cheap PATCH/DELETEs, never throws).
3. **Auto chat discovery** — re-scans every bot's `getUpdates` at most once
   per 24h (`last_chat_sync_at`); deliberately runs *before* the publish lock
   and is skipped on manual `force` (a forced publish must not drain a
   webhook-backed bot's pending updates).
4. **Serialization lock** — `acquireLock` / `releaseLock` on
   `settings.publish_run_lock_at`; a crashed run's stale lock is reclaimable
   after **10 minutes**.
5. **Hard time budget** — Supabase kills the worker at ~150s, so the cycle
   budgets **100s** (`budgetLeft()`) and stops starting new work before the
   ceiling, guaranteeing the `finally` releases the lock.
6. **Telegram fast lane** — `runIngest("telegram")` when due
   (`telegram_signals_interval_minutes`, default **5**).
7. **Web ingest** — `runIngest("all")` when due (`ingest_interval_minutes`,
   default **15**).
8. **Instant Telegram channels** (per-source speed = "Instant") — every new
   on-beat post from those channels is published immediately (no scoring
   order, no window gap), capped by `INSTANT_PUBLISH_CAP` per cycle; overflow
   stays queued and drains on later cycles.
9. **Telegram fast-lane publish** — up to `AUTO_PUBLISH_BATCH_SIZE` (1/cycle)
   of freshly-queued Telegram items, 24/7, so the channel always feels live.
10. **Normal publish** — the day/night window-gap cadence path
    (`runPublish`).

Manual runs (`runPipeline` from the dashboard) bypass the intervals but still
respect `botPaused` and the lock.

---

## 6. Ingest pipeline (`runIngest` in `ingest.ts`)

1. **Telegram signals** — monitored Telegram channels (`sources.kind =
   "telegram"`), fetched from public `t.me/s/<channel>` pages (optionally
   relayed through the Cloudflare worker, §11), cleaned; non-English posts
   are translated to English first. Per-channel **boost** (0 normal / 1 fast /
   2 instant) from the source row.
2. **Web fetches** — NewsData.io (quota-aware), Google News RSS queries, and
   direct publisher feeds, each controllable by the 0022 toggles.
   **Capped at 100 fetched/cycle.**
3. **Deterministic gates** (`gates.ts`), in order, short-circuiting:
   1. `sourceBanGate` — banned domains/sources
   2. `junkGate` — junk domains, junk title patterns, too-short titles,
      Arabic junk/opinion/poetry patterns
   3. `respectGate` / `kurdHostileGate` — disrespect toward Kurds/Muslims;
      anti-Kurd hostile framing (Peshmerga-bashing militia statements)
   4. `relevanceGate` — strict conflict beat (see below)
   5. `englishGate` — English source text only (post Telegram→English)
   6. `freshnessGate` — age limits by category
   - Then exact-key dedup against `raw_articles` (canonical key).
4. **Event clustering** (48h active window, `eventSimilarity` with alias
   normalization): no match → new `event_id`; match with ≥ re-report
   threshold → dropped (zero AI spend); match with materially new info →
   `is_update` row sharing the cluster's `event_id`.
4b. **Full-text enrichment** — **every gated web article** gets its full
   body fetched (`fetchArticleFullText` via the Cloudflare relay), not just
   thin ones: the rewrite model needs the mechanism/reason/consequence
   sentences that only exist deep in the body. Bodies are capped at 12,000
   chars; the phase is bounded by a 35s window + the cycle deadline with 4
   workers, and any articles the window never reaches are logged
   (`Full-text window closed with N article(s) unfetched…`) and simply keep
   their feed text. The SAME page fetch also returns the article's **real
   published date** (`extractArticlePublishedTime` — OpenGraph meta, schema
   itemprop, JSON-LD `datePublished`, `<time datetime>`, `data-*`/
   `parsely-pub-date` attributes). Feeds re-stamp old stories with crawl
   timestamps, so a feed pubDate that passed `freshnessGate` is not
   trustworthy; the verified page date replaces it (`original_published_at`),
   and an item whose real age exceeds the window is **dropped before it
   reaches the queue**. Age windows are operator-editable (Settings →
   Scheduler → Freshness limits → `max_age_breaking_hours` 14 /
   `max_age_news_hours` 22 / `max_age_analysis_hours` 48 via
   `ageLimitsFrom(settings)`); invalid values fall back to those defaults.
   This is the first line of defense against aggregator re-crawl leaks.
5. **AI rewrite** (`groqExtractFacts` in `ai.ts`) — **two-stage
   architecture**, chunked by BOTH item count (≤5) and total source chars
   (≤16k — full-length bodies make a fixed batch-of-5 a 60k-char call):
   - **Stage A EXTRACT**: a tiny facts-only prompt lists every stated fact
     into strict JSON (`actor/action/target/location/time/claimed_result/
     confirmed_result/source_attribution/confidence/numbers` + a
     `key_facts` array that is the item's complete factual record). Tiny
     prompts are followed reliably; there is nothing to hallucinate FROM.
   - **Stage B COMPOSE**: writes the headline + summary **USING ONLY the
     extracted facts JSON** ("a detail not present in the facts DOES NOT
     EXIST"). Attribution verbs survive because attribution is an extracted
     field. If compose fails but extract succeeded, the brief degrades to
     the extracted key_facts joined as sentences (still grounded); if
     extract fails entirely, items fall back to source text like before.
   Each stage walks the provider chain independently with its own slice of
   the deadline (extract ≤60%, compose the rest). Provenance stored on the
   queue row names the provider that wrote the VISIBLE text (compose).
   Post-rewrite guards: number-consistency (hallucinated figures → source
   fallback), filler-opener stripping, headline-reword detection ("added
   nothing beyond the headline" → drop), **fragment guards** (a rewritten
   English headline starting with a lowercase word lost its subject —
   "challenges Trump claim…" — dropped unless it's an Arabic-article prefix
   (`al-`/`el-`) or lowercase brand (i24NEWS, iPhone, eBay…); a summary
   opening mid-sentence is repaired from the source lede or dropped), and
   incomplete-headline/summary trimming. Telegram items skip rewriting.
6. **Score** each survivor: category priority + freshness + severity +
   leader-statement + breaking + boost bonuses (full breakdown stored in
   `score_parts`).
7. **Insert** into `queue` with `event_id`, `facts`, `is_update`,
   `sourceText` (pre-rewrite), `score`, `scoreParts`, breaking flag.
   Breaking items trigger an immediate breaking publish.
8. **Source-quality tally** — every accepted/rejected article is attributed
   back to its source row (`recordSourceQualityBatch`).

### Relevance gate (strict conflict beat)

`relevanceGate` admits a story only if it hits:

- **Core beat**: Iran, Iraq, proxies/axis-of-resistance, nuclear, oil/energy,
  or the Middle-East region; **or**
- **US military in-region**: Centcom / Pentagon / carrier strike groups;
- **Major Russia–Ukraine war news** (operator carve-out): invasion,
  offensive, ceasefire, casualties, mass strikes — but **not** routine
  "drone hit a warehouse" noise.

`SOFT_NEWS_PATTERNS` rejects sports (incl. martial arts — taekwondo/judo/
boxing/… — but NOT the "marathon negotiations" news idiom), film/cinema,
music, theatre, galleries, tourism, recipes, weather, traffic accidents,
etc. A bare `war|attack|strike` keyword no longer qualifies a story. The
concrete-detail check is **two-tier**: strong `conflictAction` signals
(attack, strike, sanctions, killed, drones, warns, policy, pressure…)
qualify alone with an in-beat subject; weak `governance` nouns (minister,
president, parliament…) pass ONLY alongside a `conflictContext` signal
(sanctions, military, strike, war, nuclear, negotiations…). Commodity words
(`oil`, `gold`, `brent`, …) are **not** self-sufficient anymore — "Gold
prices in Egypt rise" is blocked while "Oil tanker struck in Hormuz" passes.
Plural forms are accepted (`missiles?`, `airstrikes?`, `ceasefires?`,
`drones?`). The same gate runs at publish time — including on manual
force-publishes and Telegram-sourced items — so an off-beat item can no
longer be pushed through by hand; the preview dialog models the identical
rule (`blocked` + reason). An Arabic keyword pass (`arabicCategoriesOf`)
classifies Arabic-sourced Telegram posts so category-specific bots actually
receive them.

### Category classification (keyword-first, AI assist)

- **13 canonical categories** (`ALLOWED_CATEGORIES` in `_shared.ts`): the
  original ten (`iraq, war, iran, middle-east, analysis, proxies, gold, usa,
  oil, economic-impact`) plus **`gaza`** (Israel–Palestine / Gaza / West
  Bank), **`syria`** (strikes, Turkey border, regime), and **`lebanon`**
  (Hezbollah–Israel front). Each has its own English + Arabic keyword blocks,
  checked BEFORE the generic `war` / `middle-east` / `proxies` buckets — a
  Gaza school strike, a Beirut hit, or a Damascus drone raid is its own
  story, not a generic one. Hezbollah activity now routes to `lebanon`, not
  `proxies`.
- Each new category gets its own `CATEGORY_PRIORITY` slot (`gaza 62`, `syria
  57`, `lebanon 57`), its own Published-page filter and bot-whitelist
  option, a pill color, and joins the `breaking_categories` default
  (migration 0032 — only applied when the operator never customized the
  stored list; the Editorial tab exposes the toggle).
- **AI-assisted category** (`aiDecideCategory` in `ai.ts`, wired in
  `runIngest`): when the keyword pass is genuinely ambiguous
  (`categoryNeedsAi` — **0** keyword matches, which would otherwise drop the
  item as off-topic or default an instant post to `war`; or a **single
  generic** bucket `iran` / `war` / `middle-east`), ingest asks the model
  once. Same provider chain as the dedup verdict (`settings.ai_dedup_provider`,
  Groq as the always-available fallback), 10s per-call bound, **max 4 calls
  per cycle** so free-tier quotas and the cycle deadline are never blown.
  The answer is whitelisted against `ALLOWED_CATEGORIES`
  (`normalizeAiCategory`) before it is trusted; a rejected/null answer falls
  through to the keyword result unchanged. Successful rescues/refinements are
  logged to `activity_log` as `AI category: … → <cat>` and counted in
  `ai_usage` (kind `category`).

---

## 7. Publish pipeline (`runPublish` in `publish.ts`)

1. Paused check, orphaned `publishing` recovery, expire items older than 24h.
2. Candidate pool = up to 500 queued items, sorted by **decayed** score
   (freshness re-evaluated now), breaking first.
3. **Cluster selection** — one cluster lead per distinct event and per
   source. Cron sends 1 story; manual `force` sends more.
4. Per item: repeated/dedup checks (`isRepeated` + event fingerprints +
   `matchPublishedFingerprint`) → **AI final dedup** (rewrite-provider chain)
   on borderline candidates only, controlled by `ai_dedup_enabled` /
   `ai_dedup_provider`.
5. **Multi-bot routing** (0018/0025) — each active chat resolves its bot
   (`chats.bot_id`, else the primary env bot); an orphaned `bot_id` (bot
   deleted) skips the chat; additional bots receive only items matching their
   category whitelist (`botMatchesCategories`); the **primary bot delivers
   every category except `primary_bot_excluded_categories`** (an item matching
   an excluded category is dropped for the primary bot). Chats are
   de-duplicated by `chat_id` (`dedupeChats` — primary row wins) so a chat
   where two bots are members never double-receives.
6. **Media resolution + real-date verification** once per item: Telegram
   items use the authoritative `t.me/s/CHANNEL/POST_ID` per-post page;
   `extractPostVideo` scans the whole post block for the real
   `cdn…telesco.pe/….mp4` (not the thumbnail). Every **web** candidate that
   clears dedup gets ONE article-page fetch (capped at 10/cycle;
   relayed through the Cloudflare worker, so it costs Supabase no egress)
   serving TWO jobs: the og:image fill (the page's og:image is canonical —
   corrects logo/stock feed images, and unlike before there is **no score
   bar**, so low-priority items get images too) and the **unconditional
   real-article-date check** — any category, breaking or not, even with
   `grab_images` off (freshness is not a media preference), using the same
   operator-editable age windows as ingest. A verified age
   over the window deletes the queue row and logs
   `Real article date …h old (> …h) — dropped`. This is the second line of
   defense (the ingest drop only covers thin-description items; this one
   covers every web item at the moment it would be sent).
   `chooseDeliveryMode` decides photo/video/text.
7. **Translation** (see §9) — Sorani output is cached by content hash and
   reused across chats/later publishes.
8. **Format + send** — `formatMessage` builds Telegram HTML (`<b>` headline,
   summary, `📰 <i>source</i>` + localized timestamp, main link, footer,
   operator footer hyperlinks, and — when **Auto hashtags** is on
   (`settings.auto_hashtag`, default true, migration 0033; toggle in
   Settings → Posting) — the post's **category as a localized hashtag as the
   absolute last line**. `categoryHashtag(category, lang)` maps the 13
   categories to Title-Case English tags (`#Gaza`, `#MiddleEast`, `#USA`)
   or Kurdish-Sorani Arabic-script tags (`#غەززە`, `#ڕۆژهەڵاتی_ناوەڕاست`,
   `#ئابووری` — multi-word phrases join with underscores, the Kurdish
   channel convention), stripping spaces/hyphens while preserving
   underscores (Telegram hashtag rules); the tag follows the language the
   post is actually sent in (`default_language`; `both` → ckb). Unknown
   category/language → no line. Scheduled/campaign posts (authored content,
   no category) never get one. `fitCaption` treats `#`-lines as part of the
   preserved tail when trimming. **Thin-body merge** (`mergeThinBody`): when
   a rewrite produced almost nothing (source was just a headline → one-liner
   like "Al Jazeera reports that…"), the body renders as a SINGLE merged
   line `<b>headline</b> — body` instead of a bold headline followed by a
   near-duplicate sentence; when the body is just the headline + site name
   ("…Lebanon Washington Times"), it collapses to the headline alone
   (the footer already names the source). Bodies with `@handle` mentions,
   `t.me/…`, `tg://…` or URLs are stripped by `stripLinks` before send.
   Sent per active chat with an idempotent `published_history` reservation
   (`sending` → `sent`) that records each chat's Telegram
   **`telegram_message_id`** (0043) — this is what makes posts deletable
   later — then the queue row is **deleted** (delete-after-post).

10. **Delete a published post** — admin `deletePublishedPost` resolves the
    bot per chat at send time (falling back to the primary token), calls
    Telegram `deleteMessage` on every chat the story reached, deletes the
    history rows, and logs the audit trail. Posts sent BEFORE 0043 have no
    recorded message id and can only be removed manually in Telegram.
9. Optional polls on breaking items (cadence + per-chat + hourly cap).

### Preview next batch (dry-run)

`previewNextBatch` runs the same candidate selection/clustering/dedup with
**no** AI calls, translation, or sends. The Overview dialog shows each
candidate with `ready` / `duplicate` / `blocked` status + reason.

---

## 8. Source quality + auto-pause

- Every article entering the funnel is attributed to a source row.
- `recordSourceQualityBatch` tallies `publishedCount` / `rejectedCount` /
  `consecutiveRejects` per source in one batched write.
- `sourceAutoPauseEnabled` (default on) + `sourceAutoPauseThreshold`
  consecutive rejections (default 8) → source disabled (`enabled=false`,
  `autoPaused=true`, `autoPauseReason` set). Manually toggling it back on
  clears the flags and resets the streak.

---

## 9. AI providers & chains

| Provider | Env key(s) | Used for |
| --- | --- | --- |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | rewrite + AI dedup (**first** choice) |
| OpenRouter | `OPENROUTER_API_KEY` | rewrite + AI dedup (`meta-llama/llama-3.3-70b-instruct`) — dead (402) since 2026-08-16 |
| Groq | `GROQ_API_KEY` | rewrite + AI dedup (`openai/gpt-oss-20b`, **first** choice) |
| Mistral | `MISTRAL_API_KEY` | rewrite (`mistral-small-latest`, second choice) |
| Google Gemini (direct REST) | `GEMINI_API_KEY_1..6` | rewrite last-resort (`gemini-2.5-flash`) + Sorani translation pool + Telegram→English |
| MiniMax M3 / gateway Gemini | `MINIMAX_API_KEY` (Vercel AI Gateway) | Sorani translation fallback + `google/*` models |

### Rewrite chain (`groqExtractFacts` — two-stage EXTRACT → COMPOSE)

Both stages share one provider-chain walker (`runRewriteChain`) with this
order: **Groq → Gemini → Mistral → Cloudflare → OpenRouter** (Groq runs
`openai/gpt-oss-20b`; Gemini 2.5-flash sits second so a quota-killed Groq
hands off to a fast provider; Mistral's free tier is the steady carrier;
Cloudflare fourth — its 10k-neuron daily allocation 429s once spent;
OpenRouter runs `:free`). Each stage walks the chain independently:

- **Stage A EXTRACT** gets ≤60% of the chunk deadline (min 20s) and returns
  the strict facts JSON per item (see §6 step 5).
- **Stage B COMPOSE** gets the rest; it receives ONLY the extracted facts +
  the item title + its style/length directives, and writes headline +
  summary. If it exhausts every provider, the brief falls back to the
  extracted key_facts joined as sentences (still grounded), then source text.

Shared mechanics (unchanged from the single-stage era):

- **Per-cycle dead-provider skip**: hard failures (429/401/403/402/5xx —
  `isHardProviderFailure`) mark a provider dead for the cycle
  (`resetRewriteProviderHealth()` at ingest start).
- A stage never starts an attempt that cannot finish inside its remaining
  budget (`rewriteAttemptTimeoutMs`); `finish_reason === "length"` counts as
  failure; JSON parsing strips code fences and pulls the first balanced
  object (`extractFirstJsonObject`); Cloudflare omits `response_format`.
- Chunking honors BOTH ≤5 items AND ≤16k source chars per call
  (`chunkRewriteItems`) — full-length bodies make fixed batch-of-5 calls a
  60k-char mistake. Every attempt is logged to `rewrite_log` (provider string
  reads `extract+compose`, or `…+facts-fallback` when compose degraded);
  usage lands in `ai_usage`.

Style directives (writing style, length, tone examples) are applied at the
COMPOSE stage only — style can no longer compete with fact extraction for
the model's attention.

### Translation chain (`translateToSorani`)

- Chain order is **operator-editable** (`settings.translation_model_order`,
  0016/0017). Bare ids (`gemini-3.7-flash`, `gemini-3.6-flash`,
  `gemini-3.5-flash`, `gemini-3.5-flash-lite`) hit the **direct Gemini REST
  pool** (`GEMINI_API_KEY_1..6`, 6.5s per-key throttle, dead-key skipping on
  400/401/403); `google/gemini-2.5-flash(-lite)` and `minimax/minimax-m3`
  route through the **Vercel AI Gateway**.
- **Lean glossary** (`buildGlossaryBlock`): the operator's glossary
  (`English = Sorani` entries, one per line) is filtered per call — only
  entries whose term actually appears in the source text are sent, so a
  large glossary isn't re-sent verbatim on every call. **Continuation-aware**:
  a line without `=`/`:` (a long translation that wrapped onto the next
  line — e.g. pasted text) is merged back into the previous entry instead of
  becoming a broken fragment whose term never matches; a separator-less
  FIRST line stays a valid term-only entry. Edited in Settings via the
  row-based `GlossaryEditor` (term/translation inputs, add/remove/reorder,
  paste-import, live counter) — one row per entry, so the UI can never
  produce a wrapped entry.
- **Sorani validator** (`validateSorani`): rejects output with <2 Arabic
  script chars, or Latin count `> max(50, arabic)` (the relaxed Latin bound
  lets legitimate translations keep proper nouns). Greeting lines are
  stripped first (`cleanGeminiTranslation`).
- **Digit-preservation guard**: a translation must keep the source's exact
  figures; one retry, then accept + log (never silently ship changed digits).
- Output is **cached** in `translation_history` by content hash and reused
  across chats.
- **English fallback** is a **last resort only** — published when every key
  and model fail, with a `translation_failures` row and an activity-log
  warning.

---

## 10. Telegram specifics

- **Webhook receiver** — the `admin` function serves a real
  `/telegram-webhook` path (`handleTelegramWebhook`) that registers chats the
  moment a bot is added to a channel. `enableChatWebhooks` points each bot's
  webhook at it with a per-bot `secret_token`
  (`base64url(SHA-256("telegram-webhook:" + token))`); the receiver runs
  before the PIN gate and is verified by that token, so Telegram never needs
  the admin PIN.
- **`syncBotChats` / auto chat sync** — `getUpdates`-based discovery (24h
  gate). If a bot has a webhook set to anything other than this function's
  receiver, the sync **clears** it (with a logged warning) so getUpdates can
  work — it never restores foreign webhooks. The old "clear then restore"
  behavior is gone.
- **Channel fetch** uses public `t.me/s/<channel>` pages — no API ID/hash.
- **Telegram items are never titled**: they go out as body-only
  (translated), because the "headline" for a Telegram post is just the first
  180 chars of the same text.
- **Video**: `extractPostVideo` scans the whole post block for the real mp4
  from the listing/per-post page and sends it as a real video; avatars, og
  images, favicons and logos are rejected. Embeds with no real mp4 degrade
  to text + source link. **Bot-API video mode** (default on) forwards a
  candidate video into the bot's Saved Messages, calls `getFile`, and posts
  the real `.mp4` when the public-page scrape has no mp4.
- **Media relay** — `cloudflare/worker.js` offloads heavy egress (channel
  HTML, per-post pages, article pages, media caching into R2) from Supabase;
  all routes except `/health` require the `CLOUDFLARE_RELAY_KEY` header. Media
  served from a public R2 bucket URL.

---

## 11. Admin console & API

### Pages (current IA)

- **Overview** — command bar (Fetch now / Preview / Run pipeline /
  Pause·Resume / Lock), operational strip (status · date · last run), schema
  drift banner, KPI strip (published today, in queue, held for review, source
  failures), merged **live newsroom feed** (published history + queue +
  activity), live pipeline progress, preview dialog.
- **Inbox** — tabs ALL / REVIEW (breaking + updates) / READY / HELD /
  FAILED. Actions: review, edit, publish-now, reject.
- **Story Review** — 3 columns: original source text · editable generated
  story (headline/summary/category/breaking) · extracted facts + checks.
  Actions: Reject / Hold / Requeue / Publish now.
- **Events** — cluster list (post count, timeline length, last seen) + per
  event timeline from queue + published rows sharing the `event_id`.
- **Published** — archive with TODAY / BREAKING / IRAN / IRAQ / GAZA / SYRIA /
  LEBANON / MILITARY / ECONOMY / ALL filters.
- **Sources** — health (healthy/degraded/failing) + source profile
  (kind, priority, articles today, rejections, failures, auto-paused, last
  error).
- **AI Desk** — pipeline stage status, today's calls/tokens/published/
  translation-failures, per-provider load, per-key Gemini usage, recent
  translations + failures. Quality scores are an explicit "not yet tracked"
  placeholder.
- **Analytics** — 14-day charts (published/breaking/polls), KPI sparklines,
  published-today ▲/▼ delta vs yesterday, **Channels & Bots** (publish counts
  per destination chat), **Top Categories**, **Scheduler (pg_cron) health**,
  **Activity timeline** (last 15 pipeline events), consistent empty states.
  All pure frontend over the shared store.
- **Settings** — 8 tabs (see §2). Every control persists in Postgres.

### `admin` function actions

`verifyPin`, `getDashboard`, `dashboardSummary`, `dashboardFeed`,
`dashboardQueue`, `dashboardSources`, `dashboardAnalytics`, `dashboardAi`,
`dashboardEvents`, `dashboardPublished`, `getPipelineRun`, `saveSettings`,
`setPauseState`, `setTranslationModel`, `setCronSchedule`, `updateChat`,
`addChat`, `saveBot`, `deleteBot`, `upsertTopic`, `upsertSource`,
`listTranslationKeys`, `upsertTranslationKey`, `listTranslationModels`,
`testTranslationKey`, `testSource`, `refreshBotInfo`, `setWebhook`,
`enableChatWebhooks`, `syncBotChats`, `sendTestMessage`, `testPoll`,
`testGeminiKeys`, `runPipeline`, `clearQueue`, `previewNextBatch`,
`editQueueItem`, `publishQueueItem`, `setQueueStatus`, `deleteQueueItem`,
`resolveSending`, `deletePublishedPost`, `getRewriteLog`.

- **`setCronSchedule`** — validates against the whitelist
  (`*`, `*/2`, `*/5`, `*/10`, `*/15`), calls the SQL RPC to re-arm the
  pg_cron job, persists the choice on the settings row, and logs it. The
  whitelist is enforced twice (TS for a friendly 400, SQL as authority).
- **`resolveSending`** — reconciles stuck `sending` history rows (mark-sent
  or retry) from the Published page.
- **`deletePublishedPost`** — removes a published post from every chat via
  Telegram `deleteMessage` using the recorded message ids (0043), then
  deletes the history rows.

`getDashboard` is a **backward-compatible composition** of the eight focused
resources (same field names as the old single payload) — the SPA uses the
focused actions through `NewsroomProvider`; the smoke script still uses
`getDashboard`.

`saveSettings` maps camelCase keys → snake_case columns and PATCHes the single
`settings` row. `setQueueStatus` (hold / reject / requeue) is how Inbox/Review
gate items: the pipeline only auto-publishes rows with `status = 'queued'`.

---

## 12. Secrets & configuration

Secrets live in Supabase Edge Function secrets (deployed-function env) and/or
the Freebuff Keys tab. Required names:

- `ADMIN_PIN` — **required**; the console is fail-closed without it (see §13)
- `OWNER_EMAILS`
- `TELEGRAM_BOT_TOKEN` (primary bot)
- `NEWSDATA_API_KEY`
- `GROQ_API_KEY` (rewrite #1), `MISTRAL_API_KEY` (rewrite #2),
  `OPENROUTER_API_KEY` (rewrite #4, `:free` model — optional, chain skips
  missing)
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_WORKER_URL`, `CLOUDFLARE_RELAY_KEY`
- `MINIMAX_API_KEY` (Vercel AI Gateway token for MiniMax + `google/*` models)
- `GEMINI_API_KEY_1..6`, `GEMINI_API_EMAIL_1..6` (optional),
  `GEMINI_TRANSLATION_MODEL`
- `INTERNAL_SECRET` (cron → pipeline auth; piped through settings row by 0013)
- `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` (deploy tooling —
  `_deploy_fn.mjs` / `apply_supabase_migrations.mjs`)

The Supabase service-role key is a deployed-function secret only. Public
values (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) are baked into the SPA
by `vite.config.ts`. Do not hardcode secrets in source.

---

## 13. Security model

### PIN gate (fail-closed)

- `admin` validates every action against the `ADMIN_PIN` secret. There is
  **no hardcoded default** — if the secret is unset, every PIN (including the
  empty string) is rejected and the console stays locked until it is set.
- Comparison is constant-time-style (`pinMatches`, XOR accumulator) so an
  attacker can't time guesses, and the length check doesn't reveal the PIN
  length beyond the trim.

### Per-IP brute-force lockout

- Failed **login attempts** (`verifyPin` only) are recorded in
  `admin_auth_attempts` (IP PK, `failed_count`, `first_failed_at`). RLS is
  on, so the browser can't read or tamper with the counter.
- **5 failures within 15 minutes → HTTP 429** for that IP until the window
  expires; the 429 is returned *before* the PIN compare, so a locked IP
  learns nothing about its guess.
- A correct PIN clears the counter. Expired rows are pruned lazily on the
  next failure.
- **Dashboard polls are excluded from counting** (only `verifyPin`
  increments): a device holding a stale stored PIN gets 403s on every poll
  but can no longer lock out its own IP (8 parallel polls × 403 would have
  been an instant self-lockout). The lockout *check* still applies to every
  action, and the PIN gate is identical for all of them.
- All DB helpers **fail open** on DB errors — a hiccup never locks the
  operator out; the PIN check itself remains the boundary.

### Frontend session recovery

- The stored PIN lives in `localStorage` (`freebuff_admin_pin`,
  `src/lib/pinStorage.ts`).
- Any admin call that returns **403 or 429** clears the stored PIN and
  dispatches `freebuff:auth-rejected`; `main.tsx` listens, coalesces bursts
  (2s), toasts ("Session expired — enter your PIN" / lockout message), and
  navigates to `/` — so a rejected/expired session always returns to the
  sign-in form instead of spinning on "Loading console…". On the sign-in
  page itself the listener stays silent (the form shows the exact server
  message).
- The `/telegram-webhook` receiver is authenticated by per-bot
  `secret_token` and runs before the PIN gate.

### Database

- RLS is enabled on every public table with zero policies (0007); only the
  service-role key (functions-only) can read/write. The anon key ships in
  the SPA bundle but can't reach any table.

---

## 14. Egress & database usage minimization

To stay inside the Supabase free plan and keep the SPA light:

- **Focused dashboard resources** (§2) — the heavy lists (queue 300,
  history 200, chats 500) poll every **60s**, the feed every **5s**; all
  polls **pause while the tab is hidden**.
- **SQL aggregates** (0024) — `dashboard_counts()` and `dashboard_analytics()`
  replace 2,000–5,000-row JavaScript counting with single-row RPC results.
- **Translation cache** — same input translated once
  (`translation_history.cache_key`), reused across chats.
- **Ingest cap 100/cycle** — queue growth bounded.
- **Delete-after-post** — queue rows deleted once sent.
- **Retention** (`pruneQueueAndRetain`, every cycle):
  - queued >24h → expired; orphaned `publishing/published/expired/
    duplicate/rejected` >1h → deleted
  - `raw_articles` >48h, `published_history` >7d (dedup + analytics),
    `translation_history` >16h, `clusters` >3d, `activity_log` >3d,
    `gemini_call_log` >7d, `translation_failures` >7d, `ai_usage` >30d
  - `rewrite_log` is not pruned here (small volume)
- **Max-queue auto-trim** (0023) — `max_queue_size` (default 150; 0 disables)
  drops the lowest-scored **non-breaking** items beyond the cap, enforced at
  cycle start and right after ingest; breaking items are never trimmed.
- **`admin_auth_attempts`** pruned lazily (15-min window).

---

## 15. Testing & deployment

### Tests

`bun test` — **523 tests across 48 files** (latest verified run):

- `admin_lockout.test.ts` — lockout window/ceiling math
- `arabic_category.test.ts` — Arabic category classifier (+ gaza/syria/lebanon)
- `bot_routing.test.ts` — `botMatchesCategories` whitelist routing (+ new cats)
- `category_ai.test.ts` — AI-assist ambiguity gate + answer whitelist
- `cloudflare_worker.test.ts` — worker route/auth/media logic
- `content_gates.test.ts` — junk/respect/relevance gates
- `dedup_breaking.test.ts` — breaking recency, dedup fingerprints
- `fact_consistency.test.ts` — number/quote preservation guards
- `fingerprint.test.ts` — event fingerprint extraction/matching
- `fingerprint_coverage.test.ts` — reads ⊆ fingerprint manifest guard
- `format_message.test.ts` + `post_format.test.ts` — message formatting
- `glossary.test.ts` — lean-glossary filter
- `hashtag.test.ts` — auto-hashtag mapping + placement + trim preservation
- `json_extraction.test.ts` — robust first-JSON-object extraction
- `model_order.test.ts` — translation model classification
- `provider_health.test.ts` — rewrite dead-provider skip + attempt budget
- `quota.test.ts` — source daily-quota accounting
- `relevance_gate.test.ts` — conflict-beat admission (plural forms, sports block, commodity/context tiers)
- `fragment_guard.test.ts` — lowercase-subject headline/summary guards (+ brand/`al-` exemptions)
- `two_stage_rewrite.test.ts` — EXTRACT→COMPOSE flow, facts-only compose payload, compose-failure degradation, provider exhaustion
- `fulltext_rewrite.test.ts` — item+char chunking budget
- `age_limits.test.ts` — customizable freshness limits + fallbacks
- `publish_delete.test.ts` — delete-post plumbing, message-id capture, sports-gate regressions
- `thin_body.test.ts`, `editorial_evidence.test.ts`, `audit_regressions.test.ts`, `analysis_title.test.ts`, `admin_lockout.test.ts`, `category_policy.test.ts`, …
- `scheduled_engine.test.ts` — campaign time math (DST-safe series)
- `send_post_media.test.ts` — delivery-mode selection (photo/video/text)
- `state_hash.test.ts` + `state_envelope.test.ts` — state-hash round-trip
- `translation_validator.test.ts` — Sorani validation
- `summary_source_routing.test.ts` — extractive lede and bounded AI compression routing
- `telegram_instant.test.ts` — strict Telegram lookback, related-post merging, and instant publishing
- `control_center.test.ts` — pipeline stage state and pause behavior
- `rewrite_analytics.test.ts` — provider success rates, latency, and seven-day trends
- `control_center.test.ts` — AI control-plane routing, test-mode actions, and attempt-log behavior

Typecheck: `bun tsc -b --noEmit` (also run by the platform every turn).
Edge functions are additionally verified by esbuild bundling
(`npx esbuild supabase/functions/<slug>/index.ts --bundle …`).

### Build & deploy

- **Frontend**: build = `vite build` → static `dist/`; preview = Vite dev
  server on `0.0.0.0` (Freebuff-managed). Production env vars via
  `freebuff-deploy env`.
- **Edge Functions**: `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF`
  + `node scripts/_deploy_fn.mjs <slug...>` bundles with esbuild and deploys
  via the Management API. `admin`, `pipeline`, `scheduled`, and
  `telegram-webhook` deploy independently — they are **not** part of the Vite
  build. Latest verified live versions: `pipeline` v172, `admin` v91,
  `scheduled` v4, `telegram-webhook` v2; all reported `ACTIVE`.
- **Migrations**: `bun scripts/apply_supabase_migrations.mjs [filter]`
  runs every listed migration statement (or just the ones matching the filter)
  via the Management API SQL endpoint, then sends `NOTIFY pgrst, 'reload schema'`
  so newly created RPC functions are visible to PostgREST immediately (without
  it, a new RPC 404s as PGRST202). Migration `0049` was applied successfully
  during the latest backend deployment; a subsequent full historical replay
  exceeded the command timeout and must not be treated as a complete replay.
- **Smoke test**: `ADMIN_PIN=<pin> sh ./scripts/admin_smoke.sh` runs live
  assertions against the deployed function (wrong-PIN 403, verifyPin 200,
  unknown action 404, getDashboard payload, listTranslationKeys, models,
  bots round-trip). The wrong-PIN check counts toward the lockout — space
  runs out (max ~4 per 15 min per IP).
- **Cloudflare worker**: `node scripts/deploy_cloudflare_worker.mjs`.
- The Supabase project URL is pinned in `vite.config.ts` (and the cron
  config). If the project is ever recreated, both must be updated.
- **Freebuff hosting verification**: the frontend deployment is active at
  `https://newsi111.freebuff.app`; the latest `freebuff-deploy check` reported
  no problems. This confirms the static SPA deployment, not live Telegram or
  news-channel behavior.

---

## 16. Known operational notes

- The **AI quality scores** on the AI Desk page are intentionally not
  fabricated: the backend tracks calls/tokens/usage/failures, but headline/
  summary/QA scoring is not yet recorded.
- **OpenRouter** has no credits (402 since 2026-08-16); the rewrite chain
  keeps it but Cloudflare is first, and translation never uses it. Adding
  credits (or removing the key) is a config change, not code.
- Some **Gemini keys** return 403/429 — the direct pool skips dead keys and
  the chain falls through; a healthy key substantially lifts translation
  reliability.
- **Rewrite success rate** is provider-bound: each stage walks the chain
  with its own deadline slice (extract ≤60% of the chunk window), and
  degraded chunks are explicit — `extract/compose stage failed on all
  providers`, or the rewrite-log suffix `+facts-fallback` (compose failed,
  key_facts became the brief). All visible in Settings → AI & Translation →
  AI Rewrite Log.
- **English fallback posts**: when EVERY translation model fails (quota
  windows), publish ships the English original rather than skipping the
  news — each case gets a `translation_failures` row + activity warning.
  The alternative policy (hold for retry) is a deliberate operator choice,
  not yet implemented.
- **`rewrite_log`** grows unbounded (not in the retention pass) — a few rows
  per cycle, so effectively negligible on the free plan.
- **`score_parts`** is stored on queue rows but not surfaced in the
  redesigned UI.
- **PostgREST + new RPCs**: any migration creating an RPC function needs a
  PostgREST schema reload (`NOTIFY pgrst, 'reload schema'`) — the migration
  runner does this automatically now; ad-hoc SQL must do it itself.
- `sendTestMessage` and `clearQueue` remain in the `admin` API; `clearQueue`
  has no button in the UI yet (reachable via the API only).
- **Route files** (`src/routes/*`) are pinned by the workspace sync layer —
  edit them via terminal/git, not the file tools.
- **Credential handling**: deployment credentials are process environment
  values only. Never commit `SUPABASE_ACCESS_TOKEN`, service-role keys, bot
  tokens, or AI provider keys to the repository. If a deployment credential is
  pasted into chat or otherwise exposed, revoke it and issue a replacement.
