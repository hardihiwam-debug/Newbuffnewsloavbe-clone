# Lodev News Bot — Reverse Engineering & Rebuild Specification

This document is the authoritative implementation specification for rebuilding,
deploying, or repairing the Lodev News Bot.

The application is a private, single-admin operations console for an automated
Telegram news bot covering Iran–U.S. developments, Iraq, the wider Middle East,
Iran-aligned armed groups, and related oil/gold market reactions.

**Important:** this document is an implementation specification, not a promise
that a hosting provider can be remotely powered off by browser code. The
application can provide a global emergency stop for all bot/application
workflows. Actually stopping the Vercel/Lovable/Supabase hosting services
themselves requires the corresponding provider controls/API and must not be
faked as an in-app feature.

---

## 1. Current architecture

| Layer | Current technology |
|---|---|
| Frontend/server framework | TanStack Start v1, React 19, Vite 7 |
| Styling | Tailwind CSS v4 |
| Database/auth | Supabase Postgres + Auth + RLS |
| Scheduled jobs | Supabase `pg_cron` + `pg_net` calling public cron routes |
| AI | Existing classifier/rewrite providers + Vercel AI Gateway for the required MiniMax M3 translation path |
| Messaging | Telegram Bot API |
| News | NewsData.io + Bing News RSS + direct publisher RSS feeds + monitored public Telegram channels |
| Deployment target | Must remain portable to a new Lovable/Supabase project or another supported host |

The application has no public news website. The web UI is an admin console.

---

# 2. CRITICAL SECURITY REQUIREMENTS

## 2.1 Never commit AI/API secrets

The Vercel AI Gateway key supplied during development must **not** be written
into source files, Markdown, Git history, database rows, browser code, or the
ZIP archive.

Use:

```text
AI_GATEWAY_API_KEY=<server-side secret>
```

Only server-side code may read it.

If an API key has already been pasted into chat, committed to Git, or exposed in
a public repository, treat it as compromised and rotate/revoke it before
production deployment.

Never expose `AI_GATEWAY_API_KEY` as `VITE_*`.

## 2.2 Portable environment configuration

Use environment variables rather than hard-coded project identifiers.

Required/optional server variables should be documented in `.env.example`:

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_PROJECT_ID=

TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=

NEWSDATA_API_KEY=

AI_GATEWAY_API_KEY=
AI_GATEWAY_MODEL=minimax/minimax-m3

OWNER_EMAIL=
OWNER_BOOTSTRAP_SECRET=
```

Do not copy real secrets into `.env.example`.

---

# 3. OWNER / DEPLOYMENT ACCESS BUG — FIX THIS

## Current problem

The current database uses a "first signed-up user becomes admin" trigger.

That is fragile when:

- the original Supabase project is recreated;
- an existing account is imported;
- the owner signs in after another account already exists;
- the project is moved to another Supabase instance;
- the owner changes email;
- the Auth database and application database are restored separately.

Being the GitHub/Lovable/Vercel project owner does **not automatically make the
Supabase Auth user an application admin**.

This is the likely reason an owner can still receive `Forbidden: not an admin`
and therefore cannot run ingest/publish.

## Required fix

Replace the brittle "first user only" assumption with an explicit owner
bootstrap mechanism.

Recommended behavior:

1. `OWNER_EMAIL` is configured server-side.
2. On authenticated server requests, resolve the current Supabase Auth user.
3. If the authenticated user's email exactly matches `OWNER_EMAIL`, ensure that
   user's UUID exists in `admin_users`.
4. Do not grant admin access based on GitHub username, browser state, or a
   client-side flag.
5. Optionally support a one-time `OWNER_BOOTSTRAP_SECRET` for a fresh database.
6. The bootstrap secret must:
   - work only once;
   - be server-side only;
   - never be returned to the browser;
   - be invalidated after successful claim.
7. Keep all normal admin RLS policies based on `is_admin(auth.uid())`.
8. Provide a visible admin status diagnostic showing:
   - signed-in email;
   - current user UUID;
   - `is_admin` result;
   - owner-email match;
   - database project ID.
9. Never silently give admin to arbitrary authenticated users.

### Rebuild-safe admin flow

For a fresh deployment:

```text
Create Supabase project
        ↓
Run migrations
        ↓
Configure OWNER_EMAIL
        ↓
Create/sign in owner Auth account
        ↓
Server ensures owner UUID exists in admin_users
        ↓
Owner can access dashboard and run pipeline
```

This must work even if the owner is not the first Auth user.

---

# 4. GLOBAL STOP / EMERGENCY SHUTDOWN

Add a prominent red **STOP ALL** button to the admin dashboard.

This is a global application kill switch.

## STOP ALL must stop

- scheduled ingest;
- scheduled publishing;
- manual "Fetch now";
- manual "Publish";
- Telegram webhook processing that would mutate/process bot work;
- AI translation/classification/rewrite work started after the stop;
- queue claims;
- new Telegram sends;
- new background pipeline actions.

## Database setting

Add to `settings`:

```text
system_paused boolean NOT NULL DEFAULT false
system_pause_reason text
system_paused_at timestamptz
system_paused_by uuid
```

Every entry point must check this flag.

Required checks:

```text
/api/public/cron/ingest
/api/public/cron/publish
/api/public/telegram/webhook
runIngest()
runPublish()
manual admin pipeline actions
```

The check must happen before expensive work.

## In-flight jobs

STOP ALL cannot reliably terminate a server process that is already inside an
external HTTP request. Therefore:

- check the pause flag between pipeline stages;
- check it before every AI request;
- check it before every Telegram send;
- check it before queue claim;
- check it before final database commit.

If paused, safely return:

```text
stopped_by_admin
```

and do not continue.

Any queue item already in `publishing` must be safely returned to `queued`
unless a Telegram delivery has definitely succeeded.

## UI

The dashboard header must show:

```text
● RUNNING
```

or:

```text
■ STOPPED
```

When stopped:

- disable Fetch now;
- disable Publish;
- disable automatic processing;
- show the reason/time;
- show a **RESUME SERVICES** button.

STOP ALL should require confirmation because it is destructive to automation.

## Do not pretend to stop hosting

The button must **not** claim it shut down Vercel, Supabase, or the website
server itself.

It stops Lodev's application services/workflows.

Actually deleting/stopping hosting infrastructure belongs to the hosting
provider's dashboard/API.

---

# 5. QUEUE STATUS — STANDARDIZE

The queue schema and documentation must use one status vocabulary.

Use:

```text
queued
publishing
published
duplicate
expired
rejected-language
rejected-policy
```

Do **not** use `sent` as a queue status.

When delivery succeeds:

```text
queue.status = 'published'
```

`published_history` is the delivery ledger.

Any code/documentation saying:

```text
queue.status = 'sent'
```

must be removed.

---

# 6. EVENT-LEVEL DEDUPLICATION

Headline/token similarity alone is insufficient.

The same event can be described very differently by Reuters, AP, Iranian
media, Israeli media, Telegram channels, and local outlets.

Build an event fingerprint from normalized structured facts:

```text
people
countries
locations
action
target
date/time
event aliases
organizations
weapons/platforms
```

Example:

```text
Iran launches missiles at Israel
Iran confirms another missile wave
Iranian missiles target Israeli territory
```

These should map to the same event when the underlying event is identical.

## Event fingerprint

Persist an event identity/fingerprint for queue/history records.

Suggested representation:

```json
{
  "people": [],
  "countries": ["Iran", "Israel"],
  "locations": [],
  "action": "missile_launch",
  "target": "Israel",
  "date_bucket": "2026-08-10",
  "aliases": ["missile wave", "missile launch", "Iranian strike"]
}
```

The exact implementation may use deterministic hashing plus normalized
semantic fields.

---

# 7. EVENT COOLDOWN

Cooldown applies to the **event**, not the headline.

Default:

```text
72 hours
```

But make cooldown configurable by event type:

| Event type | Default cooldown |
|---|---:|
| Breaking attack | 6h |
| Leader statement | 12h |
| Military development | 12h |
| Diplomatic development | 24h |
| Economic/market event | 12h |
| Analysis | 48h |

The cooldown must not blindly suppress meaningful developments.

---

# 8. NEW-DEVELOPMENT TEST

A related event is publishable when it contains materially new information.

Examples:

### Duplicate

```text
Iran launches missiles.
Iran confirms missile launch.
```

If they describe the same launch with no material new information:
reject the second.

### New development

```text
US intercepts Iranian missiles.
```

Publish.

```text
Iran says another wave is imminent.
```

Publish.

```text
Casualty count rises from 4 to 12.
```

Publish/update.

```text
Israel officially confirms the strike.
```

Publish if it adds meaningful confirmation.

Before rejecting an event collision, compare the new article's facts with the
latest published event state.

Store structured new-information reasons where possible:

```text
new_casualties
new_location
new_target
new_actor
new_response
new_confirmation
new_denial
new_damage
new_timing
new_military_action
new_statement
no_material_change
```

---

# 9. TELEGRAM CHANNEL INGESTION

Public Telegram channels are signals/sources, not automatic truth.

The system must:

1. fetch recent posts;
2. normalize Arabic/Persian text;
3. translate Arabic/Persian to English before semantic event comparison;
4. merge rapid same-channel bulletins;
5. detect the underlying event;
6. preserve new details;
7. avoid repeatedly publishing the same claim.

## Attribution

Never convert an attributed claim into a confirmed fact.

Use:

```text
Iran says...
Israel says...
US officials say...
The Pentagon says...
According to...
```

If the claim is unverified, retain the attribution.

---

# 10. SOURCE COMPETITION

Do not globally penalize a source because it published several stories.

A source penalty/damping rule must apply only when the source is repeatedly
covering the **same event**.

Bad behavior:

```text
Source A publishes 5 unrelated important stories
→ Source A gets globally penalized
```

Correct behavior:

```text
Source A publishes 5 updates about the same event
→ damp Source A only for that event
```

High-value sources may still win when they add authoritative new information.

---

# 11. STALE-NEWS HANDLING

Do not use one universal freshness window.

Use:

| Category | Freshness |
|---|---:|
| Breaking/conflict | 3–6h |
| Normal news | ~10h |
| Analysis | ~24h |

The exact value should be configurable.

Never allow an old article to outrank a genuinely new development merely because
the old source has a higher static score.

---

# 12. AI CLASSIFICATION FALLBACK

Regex classification is a fallback only.

If AI classification fails:

- mark classification as fallback;
- assign lower confidence;
- do not treat regex output as equivalent to AI semantic classification;
- prevent weak regex matches from automatically promoting irrelevant stories.

Suggested fields:

```text
classification_method = ai | fallback_regex
classification_confidence = 0.0 - 1.0
```

If confidence is too low, reject or hold for review rather than pollute the
queue.

---

# 13. AI REWRITE QUALITY

Every rewritten story should answer:

```text
What happened?
Who did it?
Where?
When?
Why does it matter?
```

Only include information actually supported by the source.

Never invent:

- casualties;
- locations;
- military actions;
- motivations;
- official confirmations;
- dates;
- quotes.

If the source does not provide enough information, write a shorter factual
summary instead of filling gaps with speculation.

## Required structure

A good summary should naturally communicate:

```text
What happened → who/where/when → why it matters
```

---

# 14. CLAIM / FACT SEPARATION

For contested reporting, preserve attribution.

Examples:

```text
Iran says...
Israel says...
US officials say...
The Pentagon said...
According to Iranian state media...
```

Never rewrite:

```text
Iran says X
```

as:

```text
Iran did X
```

unless independently established by the source material.

---

# 15. BREAKING NEWS

Breaking-news logic is independent from normal cadence.

A breaking item may bypass the normal posting interval, but it must still pass:

```text
junk
respect
language
relevance
event dedup
minimum quality
claim/fact safety
```

Breaking priority must not be implemented as an absurd numeric score such as
`+1000`.

Use a priority tier or normalized multiplier.

Example:

```text
priority tier:
breaking = 3
normal = 2
analysis = 1
```

Then combine with normalized freshness, source trust, event novelty, and
category rotation.

---

# 16. SCORING

Replace the current arbitrary scoring dominance with normalized components.

Suggested components:

```text
freshness_score
source_trust_score
event_novelty_score
category_rotation_score
leader_statement_score
breaking_priority
source_event_damping
market_relevance_score
```

Breaking should be a priority tier/multiplier rather than a huge additive
number.

---

# 17. MARKET STORY FILTER

Gold and oil must remain connected to monitored geopolitical events.

Allow:

```text
Gold rises as Iran tensions escalate.
Oil rises amid Strait of Hormuz disruption.
```

Reject:

```text
Generic gold technical analysis.
Unrelated oil-company earnings.
Unrelated commodity commentary.
```

Market stories require an actual connection to the monitored event set.

---

# 18. REJECTION REASONS

Do not store only an opaque rejection string.

Use structured reasons such as:

```text
junk
non_english
stale
duplicate_url
duplicate_event
irrelevant
respect
low_quality
market_irrelevant
ai_failure
low_confidence
policy
translation_failure
```

Optional human-readable detail may accompany the structured code.

This makes the pipeline debuggable.

---

# 19. OBSERVABILITY

Every ingest run should report the funnel:

```text
fetched
cleaned
junk
respect
language
stale
duplicate_url
classified
irrelevant
duplicate_event
rewritten
queued
```

Every publish run should report:

```text
eligible
cadence_blocked
expired
duplicate_event
claimed
translated
translation_failed
sent
failed
stopped_by_admin
```

The dashboard should expose these counters for the latest run.

---

# 20. PUBLISHING RACE CONDITIONS

Publishing must be protected against overlapping cron/manual executions.

Use one transactional reservation/claim flow around:

```text
cadence check
reservation
queue claim
```

Do not rely on separate unprotected reads and writes.

Use row locking/advisory locking or an atomic conditional update.

A second publish invocation must receive:

```text
already_locked
```

or safely exit without sending.

Never allow two workers to claim the same queue item.

---

# 21. TRANSLATION — MANDATORY MODEL POLICY

## Kurdish Sorani

For Kurdish Sorani translation, use **only MiniMax M3** through Vercel AI
Gateway.

Model identifier:

```text
minimax/minimax-m3
```

Vercel documents this exact model identifier for AI Gateway. MiniMax M3 is
available through the gateway and supports automatic prompt caching. citeturn1search0turn1search1

### Remove from Sorani translation

Do not use:

```text
google/gemini-3.6-flash
Gemini translation fallback
Groq translation fallback
another translation model
```

There must be exactly one Sorani translation model:

```text
MiniMax M3
```

If MiniMax fails, do **not** silently switch to another paid model.

The item should remain retryable or follow the configured destination-language
policy.

---

# 22. VERCEL AI GATEWAY / $5 MONTHLY BUDGET

Vercel currently states that free users who have not made a payment receive
**$5 of AI Gateway credits every 30 days**. AI Gateway routes models through
one endpoint and supports usage/cost monitoring. citeturn0search0turn0search1

The application must therefore be designed as a strict low-budget system.

## Required environment variable

```text
AI_GATEWAY_API_KEY
```

Never expose it to the browser.

## Required gateway endpoint

Use Vercel AI Gateway rather than a direct MiniMax provider credential.

The implementation must keep the model fixed:

```text
minimax/minimax-m3
```

Do not allow an arbitrary model string from the browser.

---

# 23. MINIMIZE TOKEN CONSUMPTION

The $5 monthly budget is a hard operational constraint.

Translation must be optimized as follows:

### A. Translate only at final delivery

Do NOT translate every fetched article.

Do NOT translate every queued article.

Do NOT translate every candidate.

Only translate the final item that is actually going to a Sorani destination.

### B. Translate once per item

If multiple Sorani chats receive the same item:

```text
English item
      ↓
one MiniMax M3 translation
      ↓
reuse exact translated result for all Sorani chats
```

Do not make one AI request per chat.

### C. Cache translations

Persist:

```text
dedup_key
source_hash
target_language
model
translated_headline
translated_summary
created_at
```

If the source text has not changed, reuse the cached translation.

### D. Short prompts

Do not send the entire article, metadata, RSS payload, or previous history.

Send only:

```text
headline
summary
translation instructions
```

### E. Constrain output

Require:

```text
Kurdish Sorani only
Arabic-script Sorani
headline + summary only
no explanation
no notes
no translation commentary
```

Use an appropriate low output-token ceiling.

### F. Avoid retries

Do not perform repeated automatic retries that can consume the budget.

Recommended:

```text
maximum 1 immediate retry
then queue for later retry
```

A retry should occur only when there is a transient transport failure, not
because the model generated an imperfect sentence.

### G. Hard budget guard

Before an AI call, check the application's tracked monthly spend.

When the configured safety limit is reached, stop new translation calls.

Suggested internal guard:

```text
monthly_ai_budget_usd = 5.00
monthly_ai_soft_limit_usd = 4.50
```

The exact provider billing amount remains authoritative, but the application
should maintain its own conservative counter.

---

# 24. SORANI VALIDATION

Sorani output must be validated without rejecting legitimate Latin tokens.

Allowed examples:

```text
USA
US
NATO
F-35
X
URLs
@handles
acronyms
proper names
```

Validation should check that the natural-language portion is Sorani
Arabic-script text.

Do not use a simplistic rule such as:

```text
contains any Latin character → reject
```

If validation fails:

```text
translation_failure
```

and retry according to the single-model retry policy.

Never substitute Gemini or another model.

---

# 25. TRANSLATION FAILURE POLICY

If the destination chat requires Sorani:

```text
MiniMax translation fails
        ↓
do not send bad Sorani
        ↓
keep item retryable / queued
        ↓
log translation failure
```

English fallback is allowed only if that destination chat is explicitly
configured to accept English.

Never send English into a Sorani-only destination just because translation
failed.

---

# 26. AI COST ARCHITECTURE

To protect the $5 budget:

```text
FETCH
  ↓
cheap deterministic filters
  ↓
URL dedup
  ↓
freshness
  ↓
relevance
  ↓
event similarity
  ↓
only then expensive AI
  ↓
queue
  ↓
final selection
  ↓
MiniMax M3 Sorani translation ONLY if needed
  ↓
Telegram
```

Never call the translation model during ingestion.

Never call translation for rejected/duplicate/stale articles.

---

# 27. TELEGRAM PUBLISHING

Before every send:

1. check global stop;
2. check queue status;
3. check duplicate/event state;
4. check destination language;
5. translate only if required;
6. validate translation;
7. check global stop again;
8. send;
9. record successful delivery;
10. set queue status to `published`.

If Telegram returns an error:

- do not mark as published;
- record the error;
- keep the item retryable when safe.

---

# 28. DEPLOYMENT PORTABILITY

The project must be deployable into a new environment without relying on the
original project ID.

Avoid hard-coded:

```text
Supabase project ID
Supabase URL
Lovable project ID
Vercel project ID
webhook URL
AI model credentials
Telegram secrets
```

Webhook URLs must be generated from the current deployment origin.

Fresh deployment checklist:

```text
1. Create new Supabase project.
2. Apply every migration in order.
3. Configure environment variables.
4. Create owner Auth account.
5. Run owner bootstrap.
6. Verify is_admin.
7. Configure Telegram bot token.
8. Register webhook.
9. Configure cron/pg_net.
10. Verify STOP ALL.
11. Verify RESUME.
12. Verify ingest.
13. Verify queue.
14. Verify publish.
15. Verify Sorani translation with MiniMax M3.
16. Verify duplicate-event rejection.
```

---

# 29. CRON SAFETY

Every public cron endpoint must:

- authenticate the cron request;
- check `system_paused`;
- avoid concurrent execution;
- return quickly when stopped;
- never expose secrets;
- report structured run status.

When stopped:

```json
{
  "ok": false,
  "status": "stopped_by_admin"
}
```

Do not return a fake success that makes the dashboard think the bot is
running.

---

# 30. ADMIN DASHBOARD REQUIREMENTS

The dashboard must show:

### Header

```text
Lodev News
RUNNING / STOPPED
[ STOP ALL ]
```

When stopped:

```text
Lodev News
STOPPED
Reason: ...
Paused: ...
[ RESUME SERVICES ]
```

### Owner diagnostics

Show:

```text
Signed-in email
Admin: YES/NO
Owner match: YES/NO
Database connection: OK/ERROR
Telegram: CONNECTED/ERROR
AI Gateway: CONFIGURED/MISSING
MiniMax M3: CONFIGURED/MISSING
```

Never display actual secrets.

### Pipeline stats

```text
Fetched
Rejected
Duplicates
AI classified
Queued
Published
Translation failures
Stopped runs
```

---

# 31. CURRENT SOURCE/DATA RULES

Keep the existing useful source architecture:

- NewsData.io quota-capped;
- Bing News RSS;
- direct publisher feeds;
- Iranian sources such as Press TV, IRNA, Mehr, Tasnim and Fars;
- monitored public Telegram channels.

Do not let any single feed flood the queue.

Source diversity must be event-aware rather than globally punitive.

---

# 32. NEWS QUALITY RULES

The system must reject:

- obvious spam;
- irrelevant stories;
- stale stories;
- non-English source material where English is required;
- unrelated gold/oil content;
- low-quality automated content;
- duplicate URLs;
- duplicate events with no new information.

The system must preserve:

- legitimate Iranian viewpoints;
- competing claims;
- official statements;
- meaningful corrections;
- casualty updates;
- new military developments;
- diplomatic developments;
- new evidence/confirmation/denial.

---

# 33. REQUIRED REJECTION AUDIT

Every rejection should be explainable.

Example:

```json
{
  "decision": "reject",
  "reason": "duplicate_event",
  "event_id": "...",
  "similar_event": "...",
  "new_information": false,
  "source": "..."
}
```

This is essential for debugging why an article did not publish.

---

# 34. WHAT NOT TO IMPLEMENT

Do not add features that cannot be reliably implemented by this application.

In particular:

- Do not claim that an in-app button physically shuts down Vercel/Supabase.
- Do not claim GitHub ownership automatically grants Supabase admin access.
- Do not use a browser-only secret for AI or Telegram.
- Do not make an AI fallback consume another paid model when the requirement is
  MiniMax-only Sorani translation.
- Do not treat Telegram posts as independently verified facts.
- Do not suppress every related story merely because the event cooldown exists.

The correct solution is a cooperative application-level emergency stop plus
provider-level controls for actual infrastructure shutdown.

---

# 35. ACCEPTANCE TESTS

A rebuild is not complete until all tests pass.

## Admin

- Owner can sign in after a fresh database.
- Owner is admin even if another user was created first.
- Non-owner authenticated users are not automatically admins.
- Admin diagnostics correctly show authorization state.

## Stop

- STOP ALL pauses cron ingest.
- STOP ALL pauses cron publish.
- STOP ALL blocks manual ingest.
- STOP ALL blocks manual publish.
- STOP ALL prevents new Telegram sends.
- STOP ALL prevents new AI requests.
- RESUME restores normal operation.
- No false "service stopped" claim is shown for hosting infrastructure.

## Queue

- `published` is the only successful queue status.
- No code uses `sent`.
- Concurrent publish calls cannot send the same item twice.

## Dedup

- Same URL is rejected.
- Same event with different wording is rejected.
- Same event with meaningful new information is allowed.
- Source competition is event-specific.
- 72h default cooldown works.
- Event-type cooldown overrides work.

## Translation

- Gemini is not called.
- Only `minimax/minimax-m3` is used for Sorani.
- One translation is reused across multiple Sorani chats.
- Translation occurs only after final item selection.
- Cached translations do not cause another AI request.
- Latin tokens such as `USA`, `NATO`, `F-35`, `X` and URLs do not cause false
  Sorani validation failures.
- No automatic fallback to another paid translation model.

## Budget

- AI calls are counted.
- Monthly soft limit is enforced.
- Translation is not performed during ingest.
- Duplicate/stale/rejected articles do not consume translation tokens.
- Prompts contain only necessary text.

## Deployment

- Project works with a new Supabase project.
- No original project ID is required in source code.
- Owner bootstrap works.
- Telegram webhook uses the current deployment origin.
- Secrets are server-side only.

---

# 36. AUTHORITATIVE MODEL CONFIGURATION

For Sorani translation:

```text
Provider: Vercel AI Gateway
Model: minimax/minimax-m3
API key: AI_GATEWAY_API_KEY
```

No Gemini translation.

Vercel currently lists MiniMax M3 at the model identifier
`minimax/minimax-m3`; the gateway page also states that free users receive
$5 of credits every 30 days. citeturn1search1turn0search1

Vercel's current AI Gateway documentation also describes usage/cost
observability and API-key management, which should be used to monitor the
monthly budget. citeturn0search0

---

# 37. FINAL IMPLEMENTATION PRIORITY

Implement in this order:

### P0 — Security / control

1. Rotate any exposed AI key.
2. Fix owner/admin bootstrap.
3. Add global STOP ALL.
4. Add RESUME.
5. Add stop checks to every pipeline entry point.
6. Remove secrets from source/client.

### P1 — Correctness

7. Standardize queue status to `published`.
8. Fix publishing race conditions.
9. Implement event fingerprint.
10. Implement event-level cooldown.
11. Implement material-new-information test.
12. Fix source damping to be event-specific.
13. Fix stale-news windows.
14. Make fallback classification lower-confidence.
15. Fix attribution/fact handling.

### P2 — AI / cost

16. Remove Gemini Sorani translation.
17. Use only `minimax/minimax-m3` for Sorani.
18. Translate only at final delivery.
19. Cache translations.
20. Reuse one translation across chats.
21. Add monthly budget guard.
22. Minimize prompts/output.
23. Never silently fall back to another paid translation model.

### P3 — Quality / operations

24. Improve normalized scoring.
25. Add structured rejection reasons.
26. Add pipeline observability.
27. Add owner/deployment diagnostics.
28. Make deployment portable.
29. Add acceptance tests.

This document supersedes older statements in the repository that mention
`sent`, Gemini Sorani translation, global source penalties, a single universal
freshness window, or the first-user-only admin assumption.
