# Reverse Engineering — Current Architecture (2026-08)

This document describes how the Iran Desk Bot actually works today. The
backend was migrated off Convex to **Supabase** (Postgres + Edge Functions).
Any note referencing Convex, a local dev backend, or a `/convex` proxy is
obsolete and should be ignored.

---

## 1. Stack

- **Frontend**: React 19 + Vite + TanStack Router (file-based routes), Tailwind
  CSS v4, shadcn/ui components, Recharts (dashboard analytics).
- **Backend / database**: Supabase project `ljvdaajfbkqeodglghwn`. Postgres
  stores all state (settings, sources, queue, history, translation cache).
  Two **Edge Functions** do the work:
  - `admin` — PIN-gated JSON API the SPA calls directly.
  - `pipeline` — the full news pipeline (ingest → classify → filter → rewrite
    → dedup → translate → publish → bulletin), triggered by cron.
- **Scheduler**: `pg_cron` ticks the `pipeline` function every minute
  (`supabase/migrations/0002_cron.sql`). The function self-gates on editable
  interval settings and the day/night posting windows — cron is just a ticker.
- **Runtime**: Bun for installs/scripts. Vite dev server binds `0.0.0.0` with
  HMR disabled (Freebuff requirement).
- **Deployment**: Freebuff-managed hosting (`vite build` → `dist/`), preview
  via `freebuff-preview`. Edge Functions are deployed separately via the
  Supabase CLI (`supabase functions deploy`).

The SPA is a static build. It talks to the cloud Supabase `admin` function
(URL + anon key baked in by `vite.config.ts`), never a local backend, so
settings/queue/history persist across preview restarts. Every admin call is
PIN-gated server-side; the service-role key never leaves the Edge Functions.

## 2. Backend layout

| File | Role |
| --- | --- |
| `supabase/migrations/0001_init.sql` | All tables + indexes |
| `supabase/migrations/0002_cron.sql` | `pg_cron` minute ticker → `pipeline` Edge Function |
| `supabase/migrations/0003_cache_and_retention.sql` | Translation cache column/index + queue status index |
| `supabase/functions/pipeline/index.ts` | Entire news pipeline (fetch → gates → AI → publish → bulletin) + retention |
| `supabase/functions/admin/index.ts` | PIN-gated admin API (getDashboard, saveSettings, sources, keys, runPipeline, clearQueue, …) |
| `src/lib/supabase.ts` | Supabase JS client (anon key, calls the `admin` function) |
| `src/lib/adminApi.ts` | Typed client wrapper for every `admin` action |
| `src/lib/supabaseAdminHooks.ts` | React hooks/queries used by the dashboard + settings |
| `scripts/admin_smoke.sh` | Live smoke test against the deployed `admin` function |
| `scripts/apply_supabase_migrations.mjs` | Applies `supabase/migrations/*.sql` via the Management API |
| `scripts/backfill_convex_data.mjs` | Replays dedup memory + published history from the Convex export |
| `scripts/restore_from_convex_export.mjs` | One-off Convex → Supabase data restore (topics/chats) |

## 3. Scheduler

`supabase/migrations/0002_cron.sql` schedules `iran-desk-pipeline` on
`* * * * *`. Each tick POSTs to the `pipeline` Edge Function with an
`x-internal-secret` header; the function rejects calls without the matching
secret, so only cron (or an operator with the secret) can trigger it.

Inside `pipeline`, each work type self-gates on an **editable minutes setting**
(defaults in parentheses):

| Work | Setting | Default |
| --- | --- | --- |
| ingest (web + Telegram) | `ingestIntervalMinutes` | 15 |
| publish | window-gap logic (see below) | day 6–16 min / night 10–20 min |
| bulletin | `bulletinIntervalMinutes` | 15 |

Manual runs (`runPipeline` from the dashboard, or a `clearQueue` auto-refetch)
bypass the interval. All runs respect `botPaused` (STOP ALL).

### Publish cadence + double-send protection

Every publish trigger routes through `windowGapOk` + a serialization lock:

1. **Randomized min–max gap** (`dayMinMinutes`–`dayMaxMinutes` by day,
   `nightMinMinutes`–`nightMaxMinutes` at night; defaults 6–16 / 10–20) is the
   effective gap between posts, floored by `minPostGapMinutes`. A gap is drawn
   fresh each cycle from the current window's range — this is the
   "slower at night" behaviour.
2. **Serialization lock** (`settings.publishRunLockAt`, `acquireLock` /
   `releaseLock`). Only one publish run is in flight at a time across cron /
   breaking / manual. A crashed run's stale lock is reclaimable after **10
   minutes** (was 25 — lowered because Supabase kills Edge Functions at their
   execution-time limit and a killed run skips the release).

The wrapper also writes `lastPublishedAt` whenever a cycle actually sent
something, so the gap gate always has a fresh timestamp.

## 4. Ingest pipeline (`runIngest` in `pipeline/index.ts`)

1. **Telegram signals** (`fetchTelegramChannel`) — monitored channels are
   plain DB rows (`kind: "telegram"`). Posts are cleaned, foreign-language
   posts are translated to English via Gemini (telegram job only — the web
   job skips translation to avoid double-billing Gemini), merged into
   "bulletin" chunks, and each channel's daily-post/flood counters are
   updated. Per-channel boost (0 normal / 1 fast / 2 instant) is read from the
   source row config.
2. **Web fetches** (web/all jobs only) — NewsData.io (quota-aware) + Google
   News RSS queries + direct publisher feeds. Capped at **100 fetched per
   cycle** to keep the queue bounded.
3. **Deterministic gates**, in order, short-circuiting:
   1. `sourceBanGate` — banned domains/sources
   2. `junkGate` — junk domains + junk title patterns + too-short titles
   3. `respectGate` — disrespect toward Kurds/Muslims, negative unsourced
      Iran framing
   4. `relevanceGate` — must be Iran-conflict/market relevant
   5. `englishGate` — English text only
   6. `freshnessGate` — generous windows (14h conflict / 48h long-tail / 22h)
   - Then exact-key check against stored `raw_articles` (canonical key from
     `canonicalKey`, never regenerated).
4. **Classification + rewrite**:
   - classification → semantic category; on failure → `keywordCategory` fallback.
   - rewrite → clean headline + richer 2–3 sentence summary (Groq). Telegram
     posts skip rewriting (published verbatim).
5. **Post-AI gates**: near-duplicate collision handling against the queued
   window (higher-trust source wins), event-cooldown against published
   history (cross-language aware).
6. **Score** each survivor: category priority + freshness + per-category
   quota penalty + rotation bonus + breaking bonus + leader-statement bonus +
   severity bonus + telegram boost + source penalty.
7. **Insert** into `queue` with `eventId`, importance, score, scoreParts,
   sourceText (pre-rewrite original), breaking flag. Breaking items trigger
   an immediate breaking publish.
8. **Source-quality tally** — every accepted/rejected article is attributed
   back to its source row; a source with `sourceAutoPauseThreshold`
   consecutive rejections (default 8) is auto-disabled (see §7).

## 5. Publish pipeline (`runPublish`)

1. Paused check, orphaned `publishing` recovery, expire items older than 14h
   by original publish date.
2. Candidate pool = up to 500 queued items, sorted by **decayed** score
   (freshness re-evaluated now, not at ingest time).
3. **Cluster selection** (`selectPublishCandidates`, shared with the preview
   dry-run): one cluster per distinct event and one cluster lead per source.
   Cluster threshold `eventSimilarityThreshold` (0.52 default). Cron sends 1
   story; manual "Publish top 3" forces 3.
4. Per item: policy gates → repeated/dedup checks → **AI final dedup**
   (Groq/OpenRouter/Cloudflare) on borderline candidates only.
5. Image/video resolution once per item: Telegram items use the authoritative
   `t.me/s/CHANNEL/POST_ID` per-post page (never the channel avatar); videos
   are sent as video (with the real video URL, not a thumbnail) — see §9.
6. Per active chat: global language wins (`defaultLanguage`); Sorani
   translation is **cached by content hash** (`translation_history.cache_key`)
   and reused across chats/later publishes. Translation chain: Gemini
   3.6-flash → 3.5-flash → 3.5-flash-lite (per-key round-robin + throttle) →
   MiniMax M3 (normal + strict retry) → English fallback. Groq is never used
   for translation.
7. Delivery outcome (photo vs video vs text) is recorded on history rows;
   chats the bot provably can't post to are deactivated.
8. Optional polls on breaking items (cadence + per-chat + hourly cap).
9. Send delay between posts (`sendDelayMs`), funnel stats updated reactively.

### Preview next batch (dry-run)

`previewNextBatch` runs the same candidate selection, clustering, and
deterministic publish gates — with **no** AI calls, claims, translation, or
sends. The dashboard button shows each candidate with a `ready` / `duplicate`
/ `policy` status and reason.

## 6. Daily bulletin (`sendBulletin`)

- Fires at `bulletinTime` in the configured `timezone`, once per local day,
  looking back `bulletinHours` (24 default).
- Summarises recent published stories with AI, with light editorial cleanup.

## 7. Source quality + auto-pause

- Every article that enters the funnel is attributed to a source row.
- `recordSourceQualityBatch` tallies `publishedCount` / `rejectedCount` /
  `consecutiveRejects` per source in one batched write.
- When `sourceAutoPauseEnabled` (default on) and a source hits
  `sourceAutoPauseThreshold` consecutive rejections (default 8), the source
  is disabled (`enabled=false`, `autoPaused=true`, `autoPauseReason` set).
  Manually toggling the source back on clears the flags and resets the streak.

## 8. AI providers

| Provider | Env key(s) | Used for |
| --- | --- | --- |
| Groq | `GROQ_API_KEY` | AI decision path (dedup, rewrite) — first choice |
| OpenRouter | `OPENROUTER_API_KEY` | AI decision path fallback |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | AI decision path last resort |
| Google Gemini (direct REST) | `GEMINI_API_KEY_1..6` | Translation chain (3.6 → 3.5 → 3.5-lite), telegram-to-English |
| MiniMax M3 | `MINIMAX_API_KEY` (Vercel AI Gateway key) | Translation fallback |

- Per-key throttle state lives in the `gemini_throttle` table and every call
  is logged to `gemini_call_log` so per-minute vs daily quota exhaustion is
  visible per key × model in the dashboard.
- The AI **decision** path is Groq → OpenRouter → Cloudflare only — never
  Gemini — and its usage is recorded per day/provider/kind in `ai_usage`.

## 9. Telegram specifics

- **Webhook**: the `admin` function's `setWebhook`/`syncBotChats` actions
  manage the bot; the fallback bot token comes from `TELEGRAM_BOT_TOKEN`.
- **Channel fetch** uses public `t.me/s/<channel>` pages — no API ID/hash/bot
  token needed.
- **Post media**: images are parsed from the per-post preview page. For
  videos, `extractPostVideo`/`fetchTelegramPostVideo` capture the actual video
  URL (and a thumbnail) so the bot sends a real video, not a thumbnail-as-photo
  — channel avatars, og images, favicons, and logos are rejected. No media →
  text-only post (never an avatar placeholder).

## 10. Secrets & configuration

Secrets live in Supabase Edge Function secrets and/or the Freebuff Keys tab.
Required names: `ADMIN_PIN`, `OWNER_EMAILS`, `TELEGRAM_BOT_TOKEN`,
`NEWSDATA_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `MINIMAX_API_KEY`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GEMINI_API_KEY_1..6`,
`GEMINI_TRANSLATION_MODEL` (optional). The Supabase service-role key is a
deployed-function secret only. Public values (`VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`) are baked into the SPA by `vite.config.ts`. Do not
hardcode secrets in source.

## 11. Admin console

- PIN sign-in (`ADMIN_PIN`) → `/dashboard` (protected route).
- Dashboard: stat cards (queued, published 24h, active chats, polls,
  translation fails, AI tokens), 14-day analytics chart, live pipeline funnel,
  queue status tabs (queued / published / rejected / last 100 with score
  breakdowns), manual **Fetch now / Preview next batch / Publish top 3 /
  Clear queue** (clears the queue then auto-refetches), STOP ALL / RESUME,
  and a preview dialog for the next publish batch.
- Settings: Publishing (speed, format, scheduler intervals, AI dedup window,
  bulletin, language, posting windows, breaking criteria, glossary),
  Sources & Translation (providers, Telegram channels, topic queries,
  translation provider/model, translation keys, Gemini key usage, translation
  history/failures, source quality + auto-pause), and System (bot connection,
  chats, polls).
- Every settings control saves automatically and persists in Postgres.

The `admin` function actions: `verifyPin`, `getDashboard`, `saveSettings`,
`setPauseState`, `setTranslationModel`, `updateChat`, `addChat`, `upsertTopic`,
`upsertSource`, `listTranslationKeys`, `upsertTranslationKey`,
`listTranslationModels`, `testTranslationKey`, `testSource`, `refreshBotInfo`,
`setWebhook`, `syncBotChats`, `sendTestMessage`, `testPoll`, `testGeminiKeys`,
`revealGeminiKey`, `runPipeline`, `clearQueue`, `previewNextBatch`.

## 12. Database usage minimization

To stay inside the Supabase free plan:

- **Translation cache** — same input text is translated once
  (`translation_history.cache_key`, unique index), not re-billed per chat.
- **Ingest cap 100/cycle** — queue growth is bounded.
- **Dedup-only `raw_articles`** — the row stores just `dedup_key` + title/url;
  no full `payload`, body text, or media, so dedup memory stays tiny.
- **Queue pruning** — queued >48h → expired; published/duplicate/rejected
  >7d → deleted.
- **Retention** (`pruneQueueAndRetain`, runs every cycle):
  - `raw_articles` >21d deleted
  - `published_history`, `translation_history`, `clusters`, `activity_log`
    >30d deleted
  - `translation_failures`, `gemini_call_log` >14d deleted
  - `ai_usage` >60d deleted

## 13. Testing

- `sh ./scripts/admin_smoke.sh` — live smoke test of the deployed `admin`
  function (PIN gate, getDashboard shape, translation keys/models, unknown
  action → 404). 9 checks.
- Unit + wiring tests in `scripts/*_tests.ts` run with
  `bun test ./scripts/<file>_tests.ts` (editorial gates, AI dedup, rewrite
  prompts, source-quality, publish-cadence wiring).
- Typecheck: `bun tsc -b --noEmit` (run by the platform after every turn).

## 14. Deployment

- Build = `vite build` → static `dist/`. No server starts at build time.
- Preview = Vite dev server on `0.0.0.0` with the platform's PORT.
- Edge Functions are deployed with
  `supabase functions deploy admin` / `supabase functions deploy pipeline`
  (Supabase CLI + access token) — they are **not** part of the Vite build.
- Production env vars are separate from sandbox `.env`: manage via
  `freebuff-deploy env` or the Deploy UI. Secrets live in the Keys tab and in
  Supabase function secrets.
- The Supabase project URL is pinned in `vite.config.ts` (and `0002_cron.sql`).
  If the project is ever recreated, both must be updated.
