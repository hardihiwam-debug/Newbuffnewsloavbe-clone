# Iran Desk — Full Architecture Reference (2026-08)

This document is the authoritative description of how the Iran Desk Bot
actually works today. The backend was migrated off Convex to **Supabase**
(Postgres + Edge Functions), and the frontend was re-architected from a
"settings form with a dashboard" into a newsroom operations app. Any note
referencing Convex, a local dev backend, a `/convex` proxy, or the old
`/dashboard` route is obsolete.

---

## 1. Stack

- **Frontend**: React 19 + Vite + **TanStack Router** (file-based routes),
  Tailwind CSS v4, shadcn/ui components, `lucide-react` icons, `sonner`
  toasts. Charts use Recharts.
- **Backend / database**: Supabase project `ljvdaajfbkqeodglghwn`. Postgres
  holds all state. Two **Edge Functions** do the work:
  - `admin` — the PIN-gated JSON API the SPA calls directly.
  - `pipeline` — the full news pipeline (ingest → classify → filter →
    cluster → rewrite → dedup → translate → publish → bulletin) + retention.
- **Scheduler**: `pg_cron` ticks the `pipeline` function every minute
  (`0002_cron.sql`). The function self-gates on editable interval settings
  and the day/night posting windows — cron is just a ticker. A separate cron
  job drives the daily bulletin (`0010_bulletin_cron.sql`).
- **Runtime**: Bun for installs/scripts. Vite dev server binds `0.0.0.0` with
  HMR disabled (Freebuff requirement).
- **Deployment**: Freebuff-managed hosting (`vite build` → `dist/`), preview
  via `freebuff-preview`. Edge Functions are deployed separately through the
  Supabase Management API (see §15).

The SPA is a static build. It talks to the cloud Supabase `admin` function
(URL + anon key baked in by `vite.config.ts`), never a local backend, so
settings/queue/history persist across preview restarts. Every admin call is
PIN-gated server-side; the service-role key never leaves the Edge Functions.

---

## 2. Frontend layout

Routing is file-based under `src/routes/`. The route tree is generated into
`src/routeTree.gen.ts` (regenerate with `node scripts/_gen_routes.mjs`).

| Route | File | Purpose |
| --- | --- | --- |
| `/` | `src/routes/index.tsx` | PIN sign-in (restrained product entrance) |
| (layout) | `src/routes/_authenticated/route.tsx` | Auth guard + `AppShell` wrapper |
| `/overview` | `_authenticated/overview.tsx` | Command bar, KPI strip, live newsroom feed |
| `/inbox` | `_authenticated/inbox.tsx` | Editorial queue with ALL/REVIEW/READY/HELD/FAILED tabs |
| `/review` | `_authenticated/review.tsx` | 3-column editorial workspace (source · generated · facts) |
| `/events` | `_authenticated/events.tsx` | Event clusters + timeline |
| `/published` | `_authenticated/published.tsx` | Archive with filters (Today/Breaking/Iran/Iraq/Military/Economy) |
| `/sources` | `_authenticated/sources.tsx` | Source health + per-source profile |
| `/aidesk` | `_authenticated/aidesk.tsx` | AI pipeline stages, usage, Gemini key health, translations |
| `/analytics` | `_authenticated/analytics.tsx` | 14-day analytics charts |
| `/settings` | `_authenticated/settings.tsx` | 9-category settings console |

### Shell & shared UI

- `src/components/AppShell.tsx` — sidebar (brand, nav, live Inbox badge,
  bot-status + last-run footer, lock console) + mobile top bar, drawer, and
  bottom nav (Overview / Inbox / Events / Sources / More). It owns
  `useNewsroomData()`, the single `getDashboard` query shared by the shell
  and every page.
- `src/components/newsroom.tsx` — reusable primitives: `Kpi`, `StoryCard`,
  `StatusPill`, `CategoryPill`, `ConfirmAction`, `EditQueueItemDialog`,
  `SectionTitle`, `EmptyState`, time helpers.
- `src/components/AddChat.tsx`, `src/components/TelegramChannels.tsx` —
  chat + Telegram-channel management, reused inside Settings → Telegram.
- `src/components/ui/*` — shadcn/ui primitives (button, dialog, switch,
  tabs, alert-dialog, …).

### Data access layer

| File | Role |
| --- | --- |
| `src/lib/supabase.ts` | Supabase JS client + `adminFunctionUrl()` |
| `src/lib/adminApi.ts` | Typed wrapper for every `admin` action |
| `src/lib/supabaseAdminHooks.ts` | `useAdminQuery` (5s poll, `"skip"` support), `useAdminMutation`, `useAdminAction`, and the `api.*` string proxy |

The SPA never calls PostgREST directly. Every read/write goes through the
`admin` Edge Function with the stored PIN.

### Settings categories

`settings.tsx` is restructured into one tab at a time (sidebar nav on
desktop, horizontal scroll on mobile):

- **General** — post format (footer text/emoji, "read more" label, breaking
  prefix, timestamp/link-preview/image toggles, rich summaries), **footer
  hyperlinks** (`post_links`, add/edit/delete), default language.
- **Publishing** — publishing speed (delay), daily bulletin, posting windows,
  breaking-news criteria.
- **AI & Quality** — AI final dedup, news quality (breaking recency, fact
  consistency, update cadence).
- **Sources** — AI providers, source quality/auto-pause.
- **Translation** — provider/model, glossary, API keys, Gemini key usage,
  translation history, translation failures.
- **Telegram** — bot connection (webhook/test), channels, topic queries,
  chats, polls.
- **Scheduler** — interval minutes for each job.
- **System** — deployed backend health, schema migration status.
- **Security** — PIN behavior/notes.

Every control auto-saves through `saveSettings` (camelCase key →
`camelToSnake` → PATCH on the single `settings` row). Inputs use an
optimistic overlay so typing doesn't fight the 5s poll.

---

## 3. Backend layout

| File | Role |
| --- | --- |
| `supabase/migrations/0001_init.sql` … `0012_post_links.sql` | Schema + cron + column additions (see §4) |
| `supabase/functions/pipeline/index.ts` | The entire news pipeline + retention |
| `supabase/functions/pipeline/_shared.ts` | Pure/shared helpers (`formatMessage`, gates, similarity, categories) |
| `supabase/functions/admin/index.ts` | PIN-gated admin API |
| `src/lib/supabase.ts`, `src/lib/adminApi.ts`, `src/lib/supabaseAdminHooks.ts` | SPA data layer |
| `scripts/apply_supabase_migrations.mjs` | Applies `supabase/migrations/*.sql` via Management API |
| `scripts/_deploy_fn.mjs` | Bundles (esbuild) + deploys an Edge Function via Management API |
| `scripts/_gen_routes.mjs` | Regenerates `src/routeTree.gen.ts` |
| `scripts/*_tests.ts` | Unit + wiring tests (see §14) |

---

## 4. Migrations (0001 → 0012)

| File | What it adds |
| --- | --- |
| `0001_init.sql` | All tables + indexes (settings, ai_usage, topic_queries, sources, chats, raw_articles, queue, published_history, clusters, translation_failures, translation_provider_keys, activity_log, translation_history, gemini_throttle, gemini_call_log, gemini_key_usage, polls) |
| `0002_cron.sql` | `pg_cron` minute ticker → `pipeline` |
| `0003_cache_and_retention.sql` | Translation cache column/index + queue status index |
| `0004_slim.sql` | DB size reduction on the free plan |
| `0005_telegram_video_bot.sql` | Bot-API video mode + media columns |
| `0006_slim_after_post.sql` | Post-publish retention slimming |
| `0007_enable_rls.sql` | Row-level security enablement |
| `0008_ai_and_idempotency.sql` | AI dedup settings + idempotent publish |
| `0009_news_quality.sql` | `facts`, `is_update`, `breaking_max_age_hours`, `update_prefix`, update cadence |
| `0010_bulletin_cron.sql` | Daily bulletin `pg_cron` schedule |
| `0011_gemini_first_translation.sql` | Flips live `translation_mode` to `gemini_first` |
| `0012_post_links.sql` | `settings.post_links jsonb` (operator footer hyperlinks) |

The pipeline reads columns from 0005/0009/0011/0012; if migrations lag the
deployed functions, `getDashboard` returns `schemaMigrations` drift info and
the SPA shows a "database schema is behind" banner.

### Data model (key tables)

- **settings** — single row; every operator control (`default_language`,
  `bot_paused`, intervals, windows, `post_footer`, `post_links`,
  `translation_mode`, `breaking_max_age_hours`, …).
- **sources** — RSS / NewsData / Telegram sources with priority, boost,
  `published_count` / `rejected_count` / `consecutive_rejects`,
  auto-pause flags.
- **queue** — ingest output: `dedup_key`, `headline`, `summary`, `category`,
  `source_name`, `url`, `image_url`, `video_url`, `media_kind`, `event_id`,
  `facts` (jsonb), `is_update`, `importance`, `score`, `score_parts`,
  `status` (`queued` / `held` / `rejected`).
- **published_history** — idempotency rows keyed by `(dedup_key, chat_id)`,
  status `sending` → `sent`.
- **clusters** — cross-outlet event grouping (`event_id`, `label`,
  `last_headline`, `last_source_text`, `post_count`).
- **translation_history** — content-hash cache (`cache_key`) of
  English → Sorani pairs.
- **translation_failures** — failed translations (honest "translation fails"
  stat).
- **activity_log** — operational events shown in the Overview feed / Inbox
  FAILED tab.
- **ai_usage** — per-day/provider/kind token+calls (rewrite, dedup).
- **gemini_throttle / gemini_call_log / gemini_key_usage** — per-key × model
  quota health.

---

## 5. Scheduler

`0002_cron.sql` schedules `iran-desk-pipeline` on `* * * * *`. Each tick POSTs
to the `pipeline` Edge Function with an `x-internal-secret` header; calls
without the matching secret are rejected. Inside `pipeline`, each work type
self-gates on an editable minutes setting (defaults in parentheses):

| Work | Setting | Default |
| --- | --- | --- |
| ingest (web + Telegram) | `ingestIntervalMinutes` | 15 |
| publish | window-gap logic | day 6–16 min / night 10–20 min |
| bulletin | `bulletinIntervalMinutes` | 15 |

Manual runs (`runPipeline` from the dashboard) bypass the interval. All runs
respect `botPaused` (STOP ALL).

### Publish cadence + double-send protection

1. **Randomized min–max gap** (`dayMinMinutes`–`dayMaxMinutes` by day,
   `nightMinMinutes`–`nightMaxMinutes` at night), floored by
   `minPostGapMinutes`. A gap is drawn fresh each cycle — this is the
   "slower at night" behaviour.
2. **Serialization lock** (`settings.publishRunLockAt`, `acquireLock` /
   `releaseLock`) — one publish run in flight across cron / breaking /
   manual. A crashed run's stale lock is reclaimable after **10 minutes**.
3. `lastPublishedAt` is written whenever a cycle actually sent something.

---

## 6. Ingest pipeline (`runIngest` in `pipeline/index.ts`)

1. **Telegram signals** — monitored Telegram channels (`sources.kind =
   "telegram"`), fetched from public `t.me/s/<channel>` pages, cleaned,
   foreign text translated to English via Gemini (telegram job only),
   merged into "bulletin" chunks. Per-channel boost (0 normal / 1 fast /
   2 instant) comes from the source row.
2. **Web fetches** (web/all jobs) — NewsData.io (quota-aware) + Google News
   RSS queries + direct publisher feeds. **Capped at 100 fetched/cycle.**
3. **Deterministic gates**, in order, short-circuiting:
   1. `sourceBanGate` — banned domains/sources
   2. `junkGate` — junk domains, junk title patterns, too-short titles
   3. `respectGate` — disrespect toward Kurds/Muslims; unsourced negative
      Iran framing
   4. `relevanceGate` — strict conflict beat (see below)
   5. `englishGate` — English source text only
   6. `freshnessGate` — 14h conflict / 48h analysis / 22h default
   - Then exact-key dedup against `raw_articles` (canonical key).
4. **Event clustering** (48h active window, `eventSimilarity` with alias
   normalization): no match → new `event_id`; match with ≥ re-report
   threshold → dropped (zero AI spend); match with materially new info →
   `is_update` row sharing the cluster's `event_id`.
5. **AI rewrite / fact extraction** (`groqExtractFacts`) — **chunked 5 items
   per call** so `max_tokens` never truncates the JSON. Two-step prompt:
   extract structured facts first (`actor/action/target/location/time/
   claimed_result/confirmed_result/source_attribution/confidence/numbers`),
   then write headline + summary **from those facts only**. A
   number-consistency guard rejects hallucinated figures and falls back to
   source text. Telegram items **skip** rewriting.
6. **Score** each survivor: category priority + freshness + severity +
   leader-statement + breaking + boost bonuses (full breakdown stored in
   `score_parts`).
7. **Insert** into `queue` with `eventId`, `facts`, `is_update`,
   `sourceText` (pre-rewrite), `score`, `scoreParts`, breaking flag.
   Breaking items trigger an immediate breaking publish.
8. **Source-quality tally** — every accepted/rejected article is attributed
   back to its source row; `sourceAutoPauseThreshold` consecutive rejections
   auto-disables the source (default 8, see §8).

### Relevance gate (strict conflict beat)

`relevanceGate` (index.ts) admits a story only if it hits:

- **Core beat**: Iran, Iraq, proxies/axis-of-resistance, nuclear, oil/energy,
  or the Middle-East region (BEAT_PATTERNS indices 0–3, 5–6); **or**
- **US military in-region**: Centcom / Pentagon / carrier strike groups;
- **Major Russia–Ukraine war news** (operator carve-out): invasion,
  offensive, ceasefire, casualties, mass strikes — but **not** routine
  "drone hit a warehouse" noise.

`SOFT_NEWS_PATTERNS` rejects sports, film/cinema, music, theatre, galleries,
exhibitions, tourism, recipes, weather, traffic accidents, etc. The generic
`war|attack|strike` keyword alone no longer qualifies a story (that used to
let any global strike through).

---

## 7. Publish pipeline (`runPublish`)

1. Paused check, orphaned `publishing` recovery, expire items older than 14h
   by original publish date.
2. Candidate pool = up to 500 queued items, sorted by **decayed** score
   (freshness re-evaluated now), breaking first.
3. **Cluster selection** — one cluster lead per distinct event and per
   source. Cron sends 1 story; manual "Run pipeline"/`force` sends more.
4. Per item: repeated/dedup checks → cluster event-id suppression →
   **AI final dedup** (Groq/OpenRouter/Cloudflare) on borderline candidates
   only, controlled by `ai_dedup_enabled` / `ai_dedup_provider`.
5. **Media resolution** once per item: Telegram items use the authoritative
   `t.me/s/CHANNEL/POST_ID` per-post page; `extractPostVideo` scans the whole
   post block for the real `cdn…telesco.pe/….mp4` (not the thumbnail). Web
   items use og:image.
6. **Translation** (see §9) — Sorani output is cached by content hash and
   reused across chats/later publishes.
7. **Format + send** — `formatMessage` builds Telegram HTML (`<b>` headline,
   summary, `📰 <i>source</i>`, main link, footer, then operator footer
   hyperlinks as the last lines). Sent per active chat with an idempotent
   `published_history` reservation (`sending` → `sent`), then the queue row is
   **deleted** (delete-after-post).
8. Optional polls on breaking items (cadence + per-chat + hourly cap).

### Preview next batch (dry-run)

`previewNextBatch` runs the same candidate selection/clustering/gates with
**no** AI calls, translation, or sends. The Overview dialog shows each
candidate with `ready` / `duplicate` / `policy` status + reason.

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

## 9. AI providers & the translation chain

| Provider | Env key(s) | Used for |
| --- | --- | --- |
| Groq | `GROQ_API_KEY` | rewrite + AI dedup (first choice) |
| OpenRouter | `OPENROUTER_API_KEY` | rewrite + AI dedup fallback (`meta-llama/llama-3.3-70b-instruct`) |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | rewrite + AI dedup last resort (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| Google Gemini (direct REST) | `GEMINI_API_KEY_1..6` | Sorani translation chain + Telegram→English |
| MiniMax M3 | `MINIMAX_API_KEY` (Vercel AI Gateway) | Sorani translation fallback |

### Rewrite chain (`groqExtractFacts`)

- The prompt is shared; the function walks **Groq → OpenRouter → Cloudflare**
  (all OpenAI-compatible chat/completions) and takes the first usable
  response. Cloudflare's call omits `response_format` (its compat layer
  rejects it); JSON parsing strips code fences.
- `finish_reason === "length"` is treated as failure (truncation), and every
  failed provider is logged to `activity_log`. Usage is recorded per
  provider in `ai_usage`.

### Translation chain (`translateToSorani`)

- Default mode **`gemini_first`** (`settings.translation_mode`, set by
  0011): 6 Gemini keys × 3 models — `gemini-3.6-flash` →
  `gemini-3.5-flash` → `gemini-3.5-flash-lite` — with 6.5s per-key throttle
  and dead-key skipping on 400/401/403. Then MiniMax M3 (normal + strict
  retry). `*_only` and `minimax_first` modes remain operator-selectable.
- **Sorani validator** (`validateSorani`): rejects output with <2 Arabic
  script chars, or Latin count `> max(50, arabic)`. The relaxed Latin bound
  lets legitimate translations keep proper nouns (Israel, Merkava, place
  names) without being mistaken for English.
- **Digit-preservation guard**: a translation must keep the source's exact
  figures; one retry, then accept + log (never silently ship changed digits).
- **English fallback** is a **last resort only** — published when every
  Gemini key and MiniMax fail, with a `translation_failures` row and an
  activity-log warning.

---

## 10. Telegram specifics

- **Webhook**: `admin` actions `setWebhook` / `syncBotChats` manage the bot;
  token from `TELEGRAM_BOT_TOKEN`.
- **Channel fetch** uses public `t.me/s/<channel>` pages — no API ID/hash.
- **Telegram items are never titled**: they go out as body-only
  (translated), because the "headline" for a Telegram post is just the first
  180 chars of the same text (this is what previously caused the duplicated
  opening line).
- **Video**: `extractPostVideo` scans the whole post block for the real mp4
  from the listing/per-post page and sends it as a real video; avatars,
  og images, favicons and logos are rejected. Embeds with no real mp4 in
  Telegram storage degrade to text + source link (nothing else is possible
  for those).
- **Bot-API video mode** (`try Bot API for Telegram videos`, default on):
  forwards a candidate video into the bot's Saved Messages, calls `getFile`,
  and posts the real `.mp4` when the public-page scrape has no mp4.

---

## 11. Daily bulletin (`sendBulletin`)

- Fires at `bulletinTime` in the configured `timezone`, once per local day,
  looking back `bulletinHours` (24 default). Summarises recent published
  stories with AI + light editorial cleanup. Cron schedule in
  `0010_bulletin_cron.sql`.

---

## 12. Admin console & API

### Pages (current IA)

- **Overview** — command bar (Fetch now / Preview / Run pipeline /
  Pause·Resume / Lock), operational strip (status · date · last run), schema
  drift banner, KPI strip (published today, in queue, held for review, source
  failures), and a merged **live newsroom feed** (published history + queue +
  activity), plus live pipeline progress and the preview dialog.
- **Inbox** — tabs ALL / REVIEW (breaking + updates) / READY / HELD /
  FAILED (rejected + operational failures + translation failures). Actions:
  review, edit, publish-now, reject.
- **Story Review** — 3 columns: original source text · editable generated
  story (headline/summary/category/breaking) · extracted facts + checks.
  Actions: Reject / Hold / Requeue / Publish now.
- **Events** — cluster list (post count, timeline length, last seen) + per
  event timeline from queue + published rows sharing the `event_id`.
- **Published** — archive with TODAY / BREAKING / IRAN / IRAQ / MILITARY /
  ECONOMY / ALL filters.
- **Sources** — health (healthy/degraded/failing) + source profile
  (kind, priority, articles today, rejections, failures, auto-paused, last
  error).
- **AI Desk** — pipeline stage status, today's calls/tokens/published/
  translation-failures, per-provider load, per-key Gemini usage, recent
  translations + failures. Quality scores are an explicit "not yet tracked"
  placeholder (no fake metrics).
- **Analytics** — 14-day charts (published/rejected/held/duplicates/
  follow-ups/breaking) + AI usage.
- **Settings** — 9 categories (see §2). Every control persists in Postgres.

### `admin` function actions

`verifyPin`, `getDashboard`, `saveSettings`, `setPauseState`,
`setTranslationModel`, `updateChat`, `addChat`, `upsertTopic`,
`upsertSource`, `listTranslationKeys`, `upsertTranslationKey`,
`listTranslationModels`, `testTranslationKey`, `testSource`,
`refreshBotInfo`, `setWebhook`, `syncBotChats`, `sendTestMessage`,
`testPoll`, `testGeminiKeys`, `runPipeline`, `clearQueue`,
`previewNextBatch`, `editQueueItem`, `publishQueueItem`, `setQueueStatus`.

`getDashboard` returns: settings (snake→camel), chats, sources, topics,
`queue` (queued only), `queueAll` (all statuses), history,
`recentActivity`, `analytics` (14-day series), `queuedTotal`,
`published24h`, `polls24h`, `translationFails24h`, `aiUsage24h`,
`translationFailures`, `translationHistory`, `polls`, `schemaMigrations`,
`botConfigured`, `newsdataConfigured`, `clusters`.

`setQueueStatus` (hold / reject / requeue) is how Inbox/Review gate items:
the pipeline only auto-publishes rows with `status = 'queued'`.

---

## 13. Secrets & configuration

Secrets live in Supabase Edge Function secrets and/or the Freebuff Keys tab.
Required names:

- `ADMIN_PIN`, `OWNER_EMAILS`
- `TELEGRAM_BOT_TOKEN`
- `NEWSDATA_API_KEY`
- `GROQ_API_KEY`, `OPENROUTER_API_KEY`
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- `MINIMAX_API_KEY`
- `GEMINI_API_KEY_1..6`, `GEMINI_TRANSLATION_MODEL` (optional)
- `INTERNAL_SECRET` (cron → pipeline auth)

The Supabase service-role key is a deployed-function secret only. Public
values (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) are baked into the
SPA by `vite.config.ts`. Do not hardcode secrets in source.

---

## 14. Database usage minimization

To stay inside the Supabase free plan:

- **Translation cache** — same input translated once
  (`translation_history.cache_key`, unique index), reused across chats.
- **Ingest cap 100/cycle** — queue growth bounded.
- **Dedup-only `raw_articles`** — stores `dedup_key` + title/url, no
  payload/body/media.
- **Delete-after-post** — queue rows are deleted once sent.
- **Retention** (`pruneQueueAndRetain`, every cycle):
  - `raw_articles` >21d deleted
  - `published_history`, `translation_history`, `clusters`, `activity_log`
    >30d deleted
  - `translation_failures`, `gemini_call_log` >14d deleted
  - `ai_usage` >60d deleted
  - queued >48h expired; published/duplicate/rejected >7d deleted

---

## 15. Testing & deployment

### Tests

`bun test ./scripts/*_tests.ts` — **48 tests / 5 files**:

- `format_message_tests.ts` — footer, brand line, permalinks, breaking
  prefix, custom footer links.
- `send_post_media_tests.ts` — delivery-mode selection (photo/video/text),
  including the web-article-with-image regression case.
- `dedup_breaking_tests.ts` — breaking recency, dedup fingerprints.
- `fact_consistency_tests.ts` — number/quote preservation guards.
- `bulletin_tests.ts` — bulletin wiring.

Typecheck: `bun tsc -b --noEmit` (also run by the platform every turn).
Convex codegen (`bun convex dev --once`) only applies if `src/convex/` is
touched — this project no longer uses it.

### Build & deploy

- **Frontend**: build = `vite build` → static `dist/`; preview = Vite dev
  server on `0.0.0.0`. Production env vars via `freebuff-deploy env`.
- **Edge Functions**: `node scripts/_deploy_fn.mjs <slug>` bundles with
  esbuild and deploys through the Supabase Management API
  (`POST /v1/projects/{ref}/functions/deploy?slug=…`). `admin` and `pipeline`
  deploy independently — they are **not** part of the Vite build.
- **Migrations**: `node scripts/apply_supabase_migrations.mjs` runs every
  `supabase/migrations/*.sql` statement via the Management API SQL endpoint.
- **Routes**: `node scripts/_gen_routes.mjs` regenerates
  `src/routeTree.gen.ts` after adding/removing route files.
- The Supabase project URL is pinned in `vite.config.ts` (and the cron SQL).
  If the project is ever recreated, both must be updated.

---

## 16. Known operational notes

- The **AI quality scores** on the AI Desk page are intentionally not
  fabricated: the backend tracks calls/tokens/usage/failures, but headline/
  summary/QA scoring is not yet recorded.
- The **OpenRouter/Cloudflare rewrite fallback** only fires if their env
  keys exist; the chain skips missing providers silently.
- **Score breakdown** (`score_parts`) is stored on queue rows but is not yet
  surfaced in the redesigned UI (the old dashboard's expandable breakdown was
  removed during the redesign).
- `sendTestMessage` and `clearQueue` remain in the `admin` API; `clearQueue`
  has no button in the redesigned UI yet (reachable via the API only).
