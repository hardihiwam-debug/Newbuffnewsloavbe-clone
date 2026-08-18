-- Per-fetch-type master switches. Each controls one of the four distinct
-- fetch paths in the ingest pipeline:
--   fetch_telegram_enabled      — Telegram channel snapshots (t.me/s/<handle>)
--   fetch_newsdata_enabled      — NewsData.io API (up to 8 query groups)
--   fetch_google_news_enabled   — Google News RSS (up to 12 topic queries)
--   fetch_publisher_feeds_enabled — the 28 built-in publisher RSS feeds
--
-- All default to true, so existing behavior is unchanged until an operator
-- flips one. Disabling a fetcher only skips its network polls; the rest of
-- the pipeline (translation, routing, publishing) is untouched.
alter table public.settings add column if not exists fetch_telegram_enabled boolean not null default true;
alter table public.settings add column if not exists fetch_newsdata_enabled boolean not null default true;
alter table public.settings add column if not exists fetch_google_news_enabled boolean not null default true;
alter table public.settings add column if not exists fetch_publisher_feeds_enabled boolean not null default true;
