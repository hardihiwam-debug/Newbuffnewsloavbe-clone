-- Per-source-type attribution toggles.
--
-- Two independent switches for the source-name line in published posts:
--   post_show_telegram_source — Telegram channel names (e.g. "@ajanews")
--   post_show_web_source      — RSS/NewsData/website names (e.g. "Mehr News")
--
-- Both default to true, which matches the previous behavior (source names were
-- always shown). post_show_source remains as the master kill-switch handled by
-- formatMessage: if the master is off, no source line is shown at all.
alter table public.settings add column if not exists post_show_telegram_source boolean not null default true;
alter table public.settings add column if not exists post_show_web_source boolean not null default true;
