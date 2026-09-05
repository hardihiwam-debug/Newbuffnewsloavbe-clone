# Iran Desk — Project Summary

> A plain-English summary of what this project is, what news it covers, how it
> decides what gets published, and what it deliberately filters out.
> Technical details live in `REVERSE-ENGINEERING.md`; the UI is documented in
> `UI-REVERSE-ENGINEERING.md`.

---

## 1. What this project is

**Iran Desk is a fully automated Telegram news bot, run by a single private
admin, that reports on the Iran–U.S. conflict and everything connected to it.**
It is not a public news website. It is an operations console (a PIN-gated
admin app) plus a backend pipeline that continuously watches the news,
filters it through a strict editorial system, rewrites it in a professional
wire style, and posts it to Telegram channels/groups the bot belongs to.

The editorial standpoint is stated plainly in the code: the channel is
**pro-Iranian, Iraqi, and Kurdish**, and its coverage is Iraq-first, Iran
second, then the wider region. That viewpoint shapes *what gets covered*,
*how stories are framed*, and *which content is rejected* — but within that
line, reporting stays factual, attributed, and professional. This is a news
operation with a clear identity, not an aggregator that reposts anything.

The whole system is built to be cheap and reliable: free/cheap AI tiers,
minimal database traffic, no third-party backend (Supabase directly), and a
resilient pipeline that never double-posts, never posts junk, and never
posts broken or corrupt text.

---

## 2. What news it covers (the beat)

The pipeline tracks one core beat: **the Iran–U.S. conflict and its regional
and economic fallout.** Concretely:

- **Iran** — the Islamic Republic, its government, military (IRGC), nuclear
  program, and its confrontation with the United States.
- **Iraq** — covered **first and most prominently**. Iraqi news outranks
  everything else in the scoring system (highest category priority).
- **Iran's proxies / the axis of resistance** — Hezbollah (covered under its
  own `lebanon` category), Houthis (Yemen), Iraqi militias.
- **Israel and the Gaza front** — Israel–Palestine, Gaza, the West Bank
  (own `gaza` category), the Hezbollah–Israel front.
- **Syria** — strikes, the Turkey border, the regime (own `syria` category).
- **The United States** — US policy, sanctions, Pentagon/Centcom activity,
  carrier deployments, statements from US leadership.
- **Economic impact** — oil and gold price moves driven by the conflict,
  sanctions fallout, market reactions. This is why the channel covers
  markets: a Hormuz tanker strike or a sanctions round moves oil, and the
  channel reports that link explicitly.

There are **13 canonical categories** in the system: `iraq, war, iran,
middle-east, analysis, proxies, gold, usa, oil, economic-impact, gaza,
syria, lebanon`.

**Where the news comes from** (multiple independent paths so the channel
keeps flowing even if one provider fails):

1. **Monitored Telegram channels** — public `t.me/s/<channel>` pages of
   channels the operator has configured. These are the "signals": their
   posts are matched against later stories and boost them to breaking. Some
   channels are "Instant" sources that publish every new on-beat post
   immediately, no queue wait.
2. **NewsData.io** — the paid news API, quota-aware (per-source daily
   budget, auto-stops when exhausted).
3. **Google News RSS** — per-topic query feeds (free).
4. **Direct publisher feeds** — Al Jazeera, BBC, The Guardian, Al Arabiya,
   Rudaw, Shafaq, and Iranian English outlets (Press TV, Mehr, Tehran
   Times, Tasnim, IRNA, Fars, Al Mayadeen), plus analysis/markets outlets
   (Middle East Eye, Defense News, OilPrice, CNBC Energy), each capped so
   no single outlet dominates a cycle.

---

## 3. The editorial line (pro-Iranian, Kurdish, professional)

The rewrite prompts make the channel's voice explicit. Every story is
rewritten by an AI "wire editor" with these rules:

- **Wire-style headlines and summaries** — factual, under 110 characters,
  active voice, no clickbait, no emojis, no feed labels ("LIVE:", "BREAKING:").
- **Iraq-first, pro-Iran framing** — summaries add "why it matters for Iraq,
  Iran, or the region". Coverage is written from an Iraqi/Muslim/pro-Iran
  perspective.
- **No hostile or demoralising framing of Iran** — the system actively
  rejects stories framed as "Iran is collapsing", "the regime is falling",
  "the leader is dying", and unsourced "reports claim…" death/flee stories.
- **Attribution on disputed claims** — one-sided claims (a government
  statement, a military spokesperson, state media) are reported as *"Iran
  says…"*, *"the Pentagon says…"*, not as flat facts.
- **No inventing facts** — the AI is only allowed to write from facts that
  were extracted from the source text; hallucinated numbers are detected and
  replaced with the source text.
- **Kurdish output** — chats configured for Kurdish Sorani receive a full
  translation into proper Sorani (Arabic script, standard Kurdish letters
  ێ ڕ ۆ ڵ ڤ etc.), in the style of Rudaw/NRT/BBC Kurdish media.

---

## 4. The filtering gates (what gets rejected — in order)

Every single article must pass a strict chain of gates **before any AI money
is spent**. Each gate short-circuits: a story rejected at gate 2 never even
reaches gate 3. This is the "no junk, no bad words, no duplicates, no
off-topic" guarantee. The gates, in order:

### 4.1 Banned sources
A hard blocklist of outlets the channel will never carry (matched on domain,
source name, or even attribution inside the title). These are primarily
Israeli outlets and other sources outside the editorial line.

### 4.2 Junk gate
Kills spam and noise: junk domains (Reddit, PR wires, stock-screeners…),
junk title patterns (quizzes, horoscopes, earnings calls, coupons, "live
updates" labels), price-ticker pages, and titles shorter than 15 characters.

### 4.3 Respect gate ("no bad words")
Rejects content that is **disrespectful toward Kurds or Muslims** — slurs
("dirty/filthy/savage + Kurds/Muslims", "Kurds are terrorists/animals/vermin/
subhuman"), Islamophobic patterns, desecration/mockery of the Quran or the
Prophet, "death to Islam" style language, and anti-Kurd hostile framing
("Peshmerga are traitors/terrorists, must be crushed"). It also drops
**demoralising, unsourced negative Iran framing** ("regime collapse",
"leader could die", "Iran is desperate/doomed", "reports claim… death").

### 4.4 Sectarian gate
The channel is **not a Shia religious outlet**. Religious-observance content
from Shia channels (Ashura, Arbaeen, majlis, marja statements, mourning
processions) is dropped; secular news about the same region passes normally.

### 4.5 Neutrality gate
The channel reports **from the middle, not as a combatant**. Partisan war
framing that labels a regional state (Saudi, UAE, Gulf, Syria, Iran) "the
enemy" is dropped, so the feed stays news, not militia rhetoric.

### 4.6 Relevance gate
Keeps the feed strictly on-beat. Soft news (sports, cinema, tourism,
weather, celebrity, recipes, traffic) is rejected. A bare mention of
"war/attack/strike" no longer qualifies — the story must actually be about
the conflict beat (Iran, Iraq, proxies, nuclear, oil/energy, US military
in-region, or major Russia–Ukraine war news as an operator carve-out).
Commodity words alone ("gold prices in Egypt rise") are blocked; "oil tanker
struck in Hormuz" passes. **This gate also runs at publish time**, so even a
manually forced post can't bypass it.

### 4.7 English gate
The channel publishes English (plus Kurdish Sorani where configured).
Non-Latin scripts, heavy foreign-language text, and heavy non-English
diacritics are rejected. (Arabic/Persian Telegram posts are translated to
English *first*, then passed through the gates.)

### 4.8 Freshness gate
Old news is rejected. Age limits are operator-editable (defaults: breaking
14h, news 22h, analysis 48h, with a second tighter breaking-age window).
Future-dated items are rejected. Crucially, the pipeline re-verifies the
**real article date from the article page itself** (not the feed timestamp,
which aggregators re-stamp) — both at ingest and again right before send —
so recirculated old stories never reach the channel.

### 4.9 Deduplication ("no duplicates")
Three layers:
- **Exact-key dedup** — a canonical key is computed from the normalized URL
  (tracking params stripped) before any rewriting, and compared against the
  dedup memory. The same story can never be processed twice.
- **Event-level dedup** — similar stories about the same event from
  different outlets are detected by text similarity with alias
  normalization ("US/u.s./america" → usa, "attack/strike/bomb" → attack).
  A re-report of an event already covered is dropped; a report with
  materially new information becomes an *update* attached to the same event
  cluster. An event cooldown (default 8h) prevents re-posting what was just
  published.
- **AI final dedup** — borderline candidates get a final AI judgment before
  send, so the channel never posts the same event twice under different
  headlines.

### 4.10 Source quality & auto-pause
Every article is attributed back to its source row. Sources that
consistently fail the gates get **auto-paused** (after a configurable
consecutive-rejection threshold) so a bad feed can't keep flooding the
funnel.

**What rejection looks like:** nothing rejected is ever published. Failures
are logged to the activity log and counted per source — visible in the admin
console for auditing. The channel treats rejection as the default and
publication as the exception.

---

## 5. What happens after the gates: rewrite, score, publish

1. **Rewrite** — survivors are rewritten in two stages (EXTRACT facts from
   the article → COMPOSE headline + summary using only those facts), with
   post-rewrite guards: no summaries that just repeat the headline, no
   summaries ending mid-sentence with "…", no hallucinated numbers, no
   subject-less fragments, no incomplete headlines.
2. **Score** — every story is scored: category priority (Iraq highest),
   freshness, severity, breaking bonus, leader-statement bonus, and boost
   for Telegram signals. Breaking news (strikes, attacks, official
   statements from Trump or Iranian leadership) bypasses the normal posting
   schedule and goes out immediately, even at night.
3. **Cluster & send** — stories about the same event are grouped so 2–4
   outlets covering one strike become **one post with multiple source
   links** (the most trusted source leads). Posts are sent per chat with
   media, source byline, localized timestamp, and an auto-hashtag of the
   category.
4. **Translate (Kurdish Sorani chats)** — translated through a configurable
   chain of AI providers (Vercel gateway Gemini 3.8/3.7/3.6 → direct free
   Gemini pool → MiniMax), each output validated: must be proper Sorani
   Arabic script, digits preserved exactly, cached by content so the same
   story isn't re-translated for every chat. If every model fails, the
   English version is posted and the failure is logged — never silently
   corrupt text.
5. **Reliable delivery** — send state is tracked per chat; a failed send is
   retried on the next cycle, and rate-limited chats (Telegram 420/429
   flood control) are handled so a story can never get **permanently wedged**
   in a half-sent state. Posts are recorded with their Telegram message IDs
   so they can be deleted from every chat on demand.

---

## 6. What this project is NOT

- ❌ Not a public news site — there is exactly one admin, PIN-gated.
- ❌ Not a repost aggregator — everything is filtered, rewritten, deduplicated.
- ❌ Not a Shia religious outlet — religious observances are filtered out.
- ❌ Not a militia mouthpiece — partisan "enemy" framing is filtered out.
- ❌ Not neutral-wire either — it has an explicit pro-Iran, Iraqi, Kurdish
  editorial line; within that line it reports attributed facts.
- ❌ Not free of checks — every post passes deterministic gates *and* AI
  safety checks; a story can only be published by passing both.

---

## 7. Where the money goes (providers & costs)

The system is designed to run on **free or near-free AI tiers**. Every
provider is a fallback for the ones before it, and a provider that hard-fails
is skipped for the rest of the cycle.

**Rewrite chain (writing headlines + summaries):**
1. **Groq** — `gpt-oss-20b`, free tier, no card, no expiry (the primary writer).
2. **Google Gemini direct pool** — `gemini-3.5-flash-lite` via
   `GEMINI_API_KEY_1..6`, free AI Studio tier (≈1,500 requests/day per key;
   multiple keys across Google projects stack to ~7,500/day).
3. **Mistral** — `mistral-small-latest`, free tier.
4. **Cloudflare Workers AI** — free daily neuron allocation (10k/day, then 429s).
5. **OpenRouter** — `:free` open models. Currently **dead (402, no credits
   since 2026-08-16)** — the chain skips it; optional to top up or remove.

**Translation chain (Kurdish Sorani, translation-only per operator rule):**
1. **Vercel AI Gateway (paid Vercel plan)** — `google/gemini-3.8-flash` →
   `3.7-flash` → `3.6-flash` → `3.5-flash-lite` → `minimax/minimax-m3`,
   all through the operator's paid Vercel gateway key. **Vercel is used for
   nothing else** in the system.
2. **Direct Gemini free pool** — bare models (`gemini-3.7-flash` etc.) hit
   the same free AI Studio keys directly when the order routes that way.

**News sources:** NewsData.io is the only paid source (quota-aware, stops
itself when the daily budget is spent). Google News RSS, publisher feeds, and
Telegram channel pages are free.

**How cost is kept low:** keyword-first classification (AI only rescues the
ambiguous cases, max 4 calls per cycle), all deterministic gates run before
any AI call, dedup before AI, batched rewrite chunks (≤5 items and ≤16k
chars per call), translation cached by content hash so the same story is
translated once, and the pipeline fetches article full text through a
Cloudflare relay so page-fetch egress never counts against Supabase.

---

## 8. The admin console (the operator's dashboard)

A PIN-gated SPA (React + TanStack Router) at `newsi111.freebuff.app` with
one signed-in operator. Every read/write goes through the `admin` Edge
Function — the browser never touches the database directly.

**Pages:**
- **Overview** — command bar (Fetch now / Preview / Run pipeline / Pause ·
  Resume / Lock console), KPI strip (published today, in queue, held for
  review, source failures), live newsroom feed, pipeline progress, dry-run
  preview dialog.
- **Inbox** — the editorial queue with ALL / REVIEW / READY / HELD / FAILED
  tabs. Actions: review, edit, publish-now, reject, hold.
- **Story Review** — 3-column workspace: original source text · editable
  generated story (headline/summary/category/breaking) · extracted facts +
  checks. Actions: Reject / Hold / Requeue / Publish now.
- **Events** — event clusters and per-event timelines (the "no duplicates"
  view).
- **Published** — archive with filters (Today / Breaking / Iran / Iraq /
  Gaza / Syria / Lebanon / Military / Economy), plus delete-a-post (removes
  it from every chat via Telegram).
- **Sources** — source health (healthy/degraded/failing), per-source
  profile, auto-pause flags.
- **AI Desk** — pipeline stage status, calls/tokens/published today,
  per-provider load, per-key Gemini usage, translation history + failures.
- **Analytics** — 14-day charts: published/breaking/polls, per-chat
  breakdown, top categories, scheduler (pg_cron) health, activity timeline.
- **Settings** — 9 tabs in 4 groups, every control auto-saves (600 ms
  debounce), cards are collapsible and searchable (⌘K):

| Group | Tabs | What the operator controls |
|---|---|---|
| Channels | Telegram, Sources | Bot connection & webhooks, additional bots with per-bot category whitelists, chats (language/active per chat), monitored Telegram channels (Normal/Fast/Instant speed), providers & topic queries, source auto-pause |
| Content | Style, Editorial, Categories | AI writing style (global + per category), summary source, post format & footer, languages, auto-hashtags, breaking-news criteria, news quality (dedup/cooldown), per-category policy |
| Delivery | Scheduling, Campaigns | Scheduler intervals (ingest cadence, pipeline ticker), freshness limits, publishing delays, day/night posting windows, breaking interrupt, manual multi-part campaigns |
| Intelligence & System | AI & Translation, System & Security | AI Control Plane (provider registry, fallback routes, Scenario Laboratory, attempt log), translation model order (drag-drop), translation keys & usage, glossary editor, system status, security (PIN, lockout, lock console) |

---

## 9. The data model (key tables)

- **settings** — one row with every operator control (language, windows,
  intervals, footer, translation order, freshness limits, pauses…).
- **bots** — additional Telegram bots with per-bot category whitelists.
- **chats** — destination chats: id, type, language override, active, bot.
- **sources** — RSS/NewsData/Telegram sources with priority, boost, quality
  tallies and auto-pause flags.
- **raw_articles** — minimal dedup memory (canonical keys, pruned >48h).
- **queue** — scored stories awaiting publish (headline, summary, category,
  media, event_id, facts, score parts, status queued/held/rejected/expired).
- **published_history** — idempotency rows per (story, chat), status
  sending → sent, with the Telegram message id (enables delete-a-post).
- **clusters** — cross-outlet event grouping (the dedup clusters).
- **translation_history** — cached English → Sorani pairs.
- **translation_failures** — honest record of every failed translation.
- **rewrite_log** — per-chunk AI rewrite attempts (provider, model, error).
- **activity_log** — operational events (shown in Overview feed / FAILED tab).
- **ai_usage** — per-day provider token/call counts.
- **gemini_throttle / gemini_call_log / gemini_key_usage** — per-key ×
  model health for the free-key pool.
- **admin_auth_attempts** — per-IP PIN-failure counters (brute-force lockout).

---

## 10. Deployment & operations

**Two independent deployment targets:**

1. **Frontend (the admin console)** — Freebuff-managed hosting. Build =
   `vite build` → static `dist/`, deployed to `newsi111.freebuff.app`.
   Production env vars managed via the Freebuff deploy env commands.
2. **Backend (4 Supabase Edge Functions)** — deployed independently through
   the Supabase Management API:
   - `pipeline` — the news engine (fetch → gate → rewrite → publish).
   - `admin` — the PIN-gated API the console calls.
   - `scheduled` — campaigns and series posts.
   - `telegram-webhook` — chat discovery webhook receiver.
   - Deploy: `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` env vars +
     `node scripts/_deploy_fn.mjs <slug...>` (esbuild bundle → upload).
   - Migrations: `bun scripts/apply_supabase_migrations.mjs` applies
     `supabase/migrations/*.sql` and reloads PostgREST schema.
   - Cloudflare worker (egress relay): `node scripts/deploy_cloudflare_worker.mjs`.
   - Smoke test: `ADMIN_PIN=<pin> sh ./scripts/admin_smoke.sh`.

**Secrets (server-side only, never in the repo or frontend):** `ADMIN_PIN`,
`TELEGRAM_BOT_TOKEN`, `NEWSDATA_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`,
`OPENROUTER_API_KEY`, `CLOUDFLARE_*`, `MINIMAX_API_KEY` (Vercel gateway),
`GEMINI_API_KEY_1..6`, `INTERNAL_SECRET` (cron auth), `SUPABASE_ACCESS_TOKEN`
+ `SUPABASE_PROJECT_REF` (deploy tooling). The service-role key is a
deployed-function secret only; the SPA only carries the URL + anon key.

**Verification:** `bun tsc -b --noEmit` typechecks; `bun test` runs the unit
suite (531 tests / 49 files, all green at last full run).

---

## 11. Known operational notes & troubleshooting

- **Wedged "sending" rows** — a send that neither confirmed nor failed could
  previously stick forever. Now: definitive Telegram failures (4xx, 420/429
  flood control) drop the reservation and retry next cycle; ambiguous
  failures (timeout/5xx) keep it to avoid double-delivery. Stuck rows can
  still be reconciled manually via the Published page (resolve-sending).
- **Dead providers are normal** — OpenRouter has no credits (402); some
  Gemini keys 403/429. The chains skip them automatically; check AI Desk /
  Settings → AI & Translation for per-key and per-provider health.
- **English fallback posts** — if every translation model is quota-limited,
  the English version is posted with a logged `translation_failures` row
  rather than skipping the news. That policy is a deliberate operator choice.
- **Stop-everything recipe** — Pause (Settings) blocks all publishing; Clear
  queue (Inbox) clears the backlog. Total stop = Pause + Clear queue. A
  manual "Fetch now" still fetches while paused but publishes nothing.
- **Schema drift** — if migrations lag the deployed functions, the console
  shows a "database schema is behind" banner; apply migrations to clear it.
- **PostgREST & new RPCs** — migrations that create SQL functions need a
  schema reload; the migration runner does this automatically.
- **Route files** — `src/routes/*` are pinned by the workspace sync layer;
  edit them via terminal/git, not the file tools.
- **Credential hygiene** — never commit `SUPABASE_ACCESS_TOKEN`, service-role
  keys, bot tokens, or AI provider keys. If a deployment credential is
  exposed (e.g. pasted into chat), revoke it and issue a replacement.

---

## 12. Non-negotiables (hard rules the system never breaks)

1. **Junk/respect gates run before any AI spend** — and before category
   tagging. A keyword match can never override a junk rejection.
2. **The dedup key is computed before rewriting and never regenerated** —
   rewriting a headline can't create a "new" story.
3. **No double posts** — exact-key dedup + event clustering + AI final dedup
   + idempotent per-chat reservations. The same event is never sent twice,
   and a story that failed ambiguously is never re-sent as a duplicate.
4. **No slurs or dehumanising language** — about Kurds, Muslims, or anyone.
   No sectarian religious content, no partisan "enemy" framing.
5. **No hostile or demoralising Iran framing** — "regime collapse", "leader
   dying", unsourced death claims are rejected; disputed claims are written
   with attribution ("Iran says…", "the Pentagon says…").
6. **No incomplete or invented content** — summaries never end with "…",
   never just repeat the headline, never contain hallucinated numbers.
7. **No silently-corrupt translations** — Sorani output is validated for
   script and digits; failure → retry → flag → English fallback, never
   garbage text.
8. **No hidden failures** — every rejection, translation failure, rewrite
   failure, and delivery problem is logged and visible in the console.
9. **The byline never defaults to the bot's own name** — it comes from the
   article's own source data.
10. **Secrets never leave the server** — no keys in frontend code, no keys
    in the repo; the admin console is fail-closed (no PIN secret = locked).
11. **RLS everywhere** — every public table has row-level security with zero
    policies; only the functions' service-role key can touch data.

---

## 13. TL;DR (one-screen version)

**Iran Desk** is a private, single-admin Telegram news bot covering the
Iran–U.S. conflict: Iraq first, then Iran, its proxies (Hezbollah, Houthis,
Iraqi militias), Israel/Gaza, Syria, Lebanon, US policy, and the oil/gold
economic fallout. It pulls from Telegram channels, NewsData.io, Google News
RSS, and publisher feeds; filters everything through strict gates (banned
sources, junk, respect/no-slurs, sectarian, neutrality, relevance, English,
freshness) plus three layers of dedup; rewrites each story in wire style
with a pro-Iran, Kurdish, Iraqi voice — attributed, no hostile framing, no
invented facts; scores and clusters so one event = one post with multiple
links; sends to the operator's Telegram chats (breaking news bypasses the
schedule); and translates into proper Kurdish Sorani with validated output
for Kurdish chats. It runs cheap (free AI tiers + one paid news API),
deletes what it can't trust, logs every failure, and never double-posts.
Everything is controlled from a PIN-gated dashboard: sources, categories,
style, scheduling, translation models, and full queue/history visibility.