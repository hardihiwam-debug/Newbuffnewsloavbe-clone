# Iran Conflict Watch

I am muslim , fan of iran, from iraq , i wnat create a website or software in lovable.dev that fetches news about iran usa war and every impacts by this war oil reaction sometimes , iran proxies , fetches this war news and send it to my telegram bot then bot sends to wohever joins the bot or the bot is admin from channel or group,  send news based on a range but breaking news like new attakcs trump or iranian leaders speak theie should be no timframe . Ask me questions to make this project better I am Build a private admin web application — not a public news site — that runs a fully

automated Telegram news bot covering the Iran–U.S. conflict and its regional and

economic effects: Iran's proxies (Hezbollah, Houthis, Iraqi militias), Israel, and

market reactions such as oil and gold prices. There is exactly one authenticated

admin (me) and no public-facing pages.

Backend

Connect a dedicated Supabase project for this app — do not use the default

Lovable Cloud backend. I need direct Supabase Cron / pg_cron access for a reliable

recurring background job, which the default Cloud backend does not expose.

Data pipeline (triggered on a schedule by Supabase Cron → Edge Function)

Fetch — call NewsData.io first (primary; returns an image_url field

directly, 200 free requests/day), then Google News RSS + Iranian feeds as the

free fallback when NewsData is out of quota or fails. Store each article's

image_url when the provider supplies one — NewsData includes this natively,

Google News RSS generally does not. Run a configurable list of topic queries

each cycle (Iran, oil, Iran-Saudi relations, Hezbollah, Houthis, Iraqi

militias, Israel, gold price, Strait of Hormuz, etc.). Store both the query

list and the provider list in a settings/sources table, editable from the

dashboard — build it so a third provider can be added later just by inserting

a row and a key, no redeploy needed.

Filter — hard-gated, in this exact order. Each gate short-circuits; an

article rejected at one gate never reaches the next.

Junk gate: reject known junk domains (e.g. reddit.com) and junk title

patterns (stock filings, quizzes). Must run before category tagging, not

in parallel with it — a keyword match on category should never override a

junk rejection.

Respect gate: reject anything disrespectful toward Kurds or Muslims.

Category gate: classify into iran / oil / war / gold / usa / proxies /

economic-impact using semantic classification (LLM call or embedding

similarity against category descriptions) — not plain keyword substring

matching. Keyword matching causes false positives (e.g. a "God of War"

game article getting tagged as war news).

Freshness gate: reject anything older than 24 hours.

Deduplicate on a stable canonical key computed before any AI rewriting:

prefer a normalized-URL hash; fall back to a fingerprint of (source domain +

publish date + top named entities + normalized title). Never regenerate this

key later — if an AI step rewrites the headline, the same key stays attached.

Compare new articles against a rolling window of the last ~100 queued or

published items using title similarity (simhash or embeddings) to catch the

same event reported by different providers with different headlines. On a

collision, keep the item from the higher-trust source (wire services like

Reuters/AP/BBC ranked above unnamed or lesser outlets).

Summarize/rewrite — send survivors to an LLM for a clean headline plus a

2-3 sentence summary that doesn't just repeat the headline, and make sure any

key figure or quote is pulled into the summary itself rather than left at the

end where truncation could cut it off. Never publish a summary that ends

mid-sentence with "…". When a claim comes from one side of the conflict (a

government statement, military spokesperson, or state media) and isn't

independently confirmed, keep the attribution inside the sentence — "Iran

says…", "Israel says…", "the Pentagon says…" — instead of rewriting it as a

flat, unattributed fact. No separate tag or field for this; it's just how

the sentence gets written.

Score each queued item: category priority (war > iran > proxies/israel >

gold/usa > oil), freshness bonus, a per-category hourly quota penalty to avoid

flooding one topic, a rotation bonus for categories starved for 2+ hours, and

a breaking-news override (below).

Breaking news — no timeframe, bypasses both the normal posting interval

and the night-time quiet window. Triggers on: a direct US/Iran government

action (strikes, official statements from Trump or Iranian leadership), OR

anything directly involving Iran's proxies or Israel, OR a major oil/gold

price move past a configurable threshold. A breaking item still passes the

junk and dedup gates first, just skips the scheduling queue.

Translate (when Kurdish Sorani is enabled for a given chat) — call Gemini

with a fallback model chain. After translation, validate the output contains

only Arabic-script Unicode ranges (for Kurdish Sorani) plus standard

punctuation, digits, and emoji. If any character falls outside that range,

discard the result and retry with the next model in the chain rather than

publishing it. If every model fails validation, fall back to English text but

log it as a translation failure visible in the dashboard — never publish

silently-corrupted text.

Publish to Telegram — resolve the byline strictly from the article's own

data (provider's source_name field, else the article's domain). Never default

to this bot's own name as the byline. Include the article's original publish

timestamp (not fetch time), localized. Attach the article's image when one

was captured at fetch time; if none is available, send a text-only message —

no placeholder graphic. Send to every chat the bot belongs to,

respecting each chat's own language and schedule settings. Wait ~60 seconds

between sends. Record every publish in a history table keyed on the canonical

dedup key, checked over an 8-hour window, so nothing gets re-sent.

Editorial policy

No story is suppressed because of which side of the conflict it favors or

embarrasses. If it passes the junk/respect/category/freshness/dedup gates,

it's eligible to publish regardless of whether it's good or bad news for

Iran, the US, or Israel.

No source or government is excluded outright. Claims from any side —

Iranian, Israeli, American — are reported with in-line attribution rather

than as flat fact (see step 4 above). That's the only "claims" handling in

the system — no separate disputed-claim flag or dashboard field for it.

Admin dashboard

Single authenticated admin login (Supabase Auth, email/password is fine). Build:

Bot connection: paste the Telegram bot token; store it as a server-side

secret, never expose it to the browser after saving (show only a masked

confirmation). List of chats the bot currently belongs to, auto-refreshed,

each with a mute/remove toggle.

Language: global default (Kurdish Sorani only / English only / both), plus

a per-chat override so different chats can get different languages.

Posting cadence:

Daytime window — start time, end time, and min–max minutes between posts,

all editable in the UI.

Night window — its own separate start time, end time, and min–max minutes

between posts.

Toggle for whether breaking news may interrupt the night window (default: yes).

Breaking-news criteria: toggles for which categories count as breaking, and

a numeric threshold for what counts as a "major" oil/gold move.

Sources: NewsData.io and Google News RSS, each with their key/config

stored as secrets, and live daily quota usage (NewsData's 200/day free cap)

so exhaustion is visible before it silently forces an RSS-only fallback.

Built as a table, not a fixed list, so another provider can be added later

from the UI.

Queue/history view: what's currently queued, what's published in the last

24h, and a manual "publish top 3 now" button.

Translation failures log: a list of items where every Gemini model failed

validation, for manual review.

Non-negotiables

Junk filter is a hard gate before category tagging, never parallel to it.

Dedup key is computed pre-rewrite and never regenerated.

Byline never defaults to the bot's own name.

Translated text is validated for script/Unicode range before sending —

retry, then flag; never publish silently-corrupted output.

All API keys (NewsData, LLM provider, Gemini, Telegram bot token, and any

provider added later) live only in server-side secrets — never in frontend

code, never hardcoded in the repo.

Suggested data model (give this to lovable if it asks for schema guidance)

settings — single row: language default, daytime/night windows, breaking

toggles, thresholds

chats — telegram chat_id, type (channel/group), language override, active flag

sources — provider name, api key secret ref, daily quota, used-today counter

raw_articles — provider payload, canonical dedup key, category, junk/respect

flags, image_url (nullable), fetched_at

queue — scored items awaiting publish, score components, breaking flag

published_history — dedup key, chat_id, published_at, original publish

timestamp, source name , my newsdata io api key pub_03222875f0e146b6bc15f37cb4dad540                 my @connector:telegram:"Telegram" Bot token @secret:TELEGRAM_BOT_TOKEN  Show usernames that has joined this bot or if u can show the channel namel that this bot exist

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://lodevnewsbo.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/8183f918-6f2b-4a81-aaf7-eaf7dd0acff7).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
