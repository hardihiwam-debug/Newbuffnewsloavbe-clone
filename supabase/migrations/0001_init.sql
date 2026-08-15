-- Iran Desk Bot — Supabase schema (mirrors the Convex schema in
-- src/convex/schema.ts). Convex `v.string()` -> text, `v.number()` ->
-- double precision (bigint for Telegram ids), `v.boolean()` -> boolean,
-- `v.array(...)` -> type[], `v.any()`/nested objects -> jsonb, optional ->
-- nullable.
--
-- Row Level Security is deliberately NOT enabled yet: this is a private
-- admin console and the pipeline will use the service-role key. RLS policies
-- are a follow-up once the data layer port is done.

create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  default_language text,
  day_start text,
  day_end text,
  day_min_minutes double precision,
  day_max_minutes double precision,
  night_start text,
  night_end text,
  night_min_minutes double precision,
  night_max_minutes double precision,
  breaking_interrupts_night boolean,
  breaking_categories text[],
  oil_move_threshold double precision,
  gold_move_threshold double precision,
  timezone text,
  last_published_at timestamptz,
  next_publish_at timestamptz,
  bot_paused boolean default false,
  bot_paused_at timestamptz,
  bot_paused_reason text,
  event_cooldown_hours double precision,
  event_similarity_threshold double precision,
  send_delay_ms double precision,
  post_footer text,
  post_emoji text,
  post_link_label text,
  post_show_source boolean,
  post_show_timestamp boolean,
  breaking_prefix text,
  link_previews boolean,
  grab_images boolean,
  telegram_defaults_seeded boolean,
  translation_mode text,
  translation_model text,
  translation_glossary text,
  polls_enabled boolean,
  polls_max_per_hour double precision,
  polls_auto_close_minutes double precision,
  polls_categories text[],
  polls_default_language text,
  poll_cadence text,
  gemini_call_stats jsonb,
  translation_cache_stats jsonb,
  pipeline_stats jsonb,
  bulletin_enabled boolean,
  bulletin_time text,
  bulletin_hours double precision,
  last_bulletin_at timestamptz,
  pipeline_run jsonb,
  ingest_interval_minutes double precision,
  publish_interval_minutes double precision,
  bulletin_interval_minutes double precision,
  telegram_signals_interval_minutes double precision,
  min_post_gap_minutes double precision,
  publish_run_lock_at timestamptz,
  last_ingest_at timestamptz,
  last_publish_at timestamptz,
  last_telegram_signals_at timestamptz,
  last_bulletin_check_at timestamptz,
  ai_dedup_enabled boolean,
  ai_dedup_mode text,
  ai_dedup_window_hours double precision,
  ai_dedup_max_posts double precision,
  ai_dedup_provider text,
  ai_news_desk_enabled boolean,
  enrich_summaries boolean,
  source_auto_pause_enabled boolean,
  source_auto_pause_threshold double precision,
  updated_at timestamptz default now()
);

create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  day text not null,
  provider text not null,
  kind text not null,
  calls double precision not null default 0,
  prompt_tokens double precision not null default 0,
  completion_tokens double precision not null default 0
);
create index if not exists ai_usage_day_provider_kind_idx on public.ai_usage (day, provider, kind);

create table if not exists public.topic_queries (
  id uuid primary key default gen_random_uuid(),
  query text not null,
  category text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists topic_queries_query_key on public.topic_queries (query);

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null,
  secret_ref text,
  config jsonb,
  priority double precision not null default 0,
  daily_quota double precision,
  used_today double precision not null default 0,
  quota_date text not null,
  enabled boolean not null default true,
  last_error text,
  retry_after timestamptz,
  retry_backoff_ms double precision,
  last_success_at timestamptz,
  daily_posts_count double precision,
  daily_posts_date text,
  flood_cooldown_until timestamptz,
  published_count double precision,
  rejected_count double precision,
  consecutive_rejects double precision,
  auto_paused boolean,
  auto_pause_reason text,
  created_at timestamptz not null default now()
);
create index if not exists sources_priority_idx on public.sources (priority);
create unique index if not exists sources_kind_name_key on public.sources (kind, name);

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  title text,
  username text,
  type text not null,
  language text,
  polls_enabled boolean,
  active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index if not exists chats_chat_id_key on public.chats (chat_id);

create table if not exists public.raw_articles (
  id uuid primary key default gen_random_uuid(),
  dedup_key text not null,
  provider text not null,
  source_name text,
  url text not null,
  title text not null,
  description text,
  image_url text,
  video_url text,
  category text,
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  rejected boolean not null default false,
  reject_reason text,
  payload jsonb
);
create index if not exists raw_articles_dedup_key_idx on public.raw_articles (dedup_key);
create index if not exists raw_articles_fetched_at_idx on public.raw_articles (fetched_at);

create table if not exists public.queue (
  id uuid primary key default gen_random_uuid(),
  dedup_key text not null,
  article_id uuid,
  headline text not null,
  summary text not null,
  category text not null,
  source_name text not null,
  url text not null,
  image_url text,
  video_url text,
  original_published_at timestamptz,
  source_text text,
  event_id text,
  importance text,
  score double precision not null default 0,
  score_parts jsonb,
  breaking boolean not null default false,
  status text not null,
  created_at timestamptz not null default now()
);
create index if not exists queue_status_idx on public.queue (status);
create index if not exists queue_created_at_idx on public.queue (created_at);

create table if not exists public.published_history (
  id uuid primary key default gen_random_uuid(),
  dedup_key text not null,
  chat_id bigint not null,
  headline text,
  english_headline text,
  source_text text,
  event_id text,
  source_name text,
  category text,
  breaking boolean not null default false,
  original_published_at timestamptz,
  image_url text,
  video_url text,
  delivery_mode text,
  image_error text,
  published_at timestamptz not null default now()
);
create index if not exists published_history_published_at_idx on public.published_history (published_at);

create table if not exists public.clusters (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  label text not null,
  category text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  post_count double precision not null default 1,
  last_headline text,
  last_source_text text
);
create index if not exists clusters_event_id_idx on public.clusters (event_id);
create index if not exists clusters_last_seen_at_idx on public.clusters (last_seen_at);

create table if not exists public.translation_failures (
  id uuid primary key default gen_random_uuid(),
  dedup_key text,
  headline text,
  target_language text not null,
  models_tried text[],
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists translation_failures_created_at_idx on public.translation_failures (created_at);
create index if not exists translation_failures_dedup_key_idx on public.translation_failures (dedup_key);

create table if not exists public.translation_provider_keys (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  label text not null,
  api_key text not null,
  model text not null,
  enabled boolean not null default true,
  priority double precision not null default 100,
  cooldown_until timestamptz,
  consecutive_failures double precision not null default 0,
  last_status double precision,
  last_error text,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index if not exists translation_provider_keys_provider_idx on public.translation_provider_keys (provider);

create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  level text not null,
  message text not null,
  detail text,
  chat_id bigint,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_created_at_idx on public.activity_log (created_at);
create index if not exists activity_log_type_idx on public.activity_log (type);

create table if not exists public.translation_history (
  id uuid primary key default gen_random_uuid(),
  english_text text not null,
  kurdish_text text not null,
  model text not null,
  chat_id bigint,
  dedup_key text,
  created_at timestamptz not null default now()
);
create index if not exists translation_history_created_at_idx on public.translation_history (created_at);
create index if not exists translation_history_dedup_key_idx on public.translation_history (dedup_key);

create table if not exists public.gemini_throttle (
  id uuid primary key default gen_random_uuid(),
  key_index double precision not null,
  next_available_at double precision not null
);
create index if not exists gemini_throttle_key_index_idx on public.gemini_throttle (key_index);

create table if not exists public.gemini_call_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  key_index double precision not null,
  model text not null,
  direction text not null,
  ok boolean not null,
  code double precision not null,
  message text not null
);
create index if not exists gemini_call_log_at_idx on public.gemini_call_log (at);

create table if not exists public.gemini_key_usage (
  id uuid primary key default gen_random_uuid(),
  day text not null,
  key_index double precision not null,
  model text not null,
  calls double precision not null default 0,
  ok double precision not null default 0,
  rate_limited double precision not null default 0,
  other_errors double precision not null default 0
);
create index if not exists gemini_key_usage_day_key_model_idx on public.gemini_key_usage (day, key_index, model);

create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(),
  dedup_key text not null,
  chat_id bigint not null,
  item_headline text,
  item_category text,
  language text not null,
  question text not null,
  options text[],
  telegram_message_id bigint,
  closed_at timestamptz,
  total_voter_count double precision,
  most_voted_index double precision,
  created_at timestamptz not null default now()
);
create index if not exists polls_chat_id_idx on public.polls (chat_id);
create index if not exists polls_created_at_idx on public.polls (created_at);
create index if not exists polls_dedup_key_idx on public.polls (dedup_key);

-- ── New-season seed data (idempotent) ─────────────────────────────────────
-- Settings uses a fixed id; topics/sources/chats conflict on their unique
-- keys, so this migration can be re-run without duplicating rows.

insert into public.settings (
  id, default_language, day_start, day_end, day_min_minutes, day_max_minutes,
  night_start, night_end, night_min_minutes, night_max_minutes,
  breaking_interrupts_night, breaking_categories, oil_move_threshold,
  gold_move_threshold, timezone, bot_paused, event_cooldown_hours,
  event_similarity_threshold, send_delay_ms, bulletin_enabled, bulletin_time,
  bulletin_hours, translation_mode, translation_model, polls_enabled,
  polls_max_per_hour, polls_auto_close_minutes, polls_categories,
  polls_default_language, poll_cadence, ingest_interval_minutes,
  publish_interval_minutes, bulletin_interval_minutes,
  telegram_signals_interval_minutes, min_post_gap_minutes, ai_dedup_enabled,
  ai_dedup_mode, ai_dedup_window_hours, ai_dedup_max_posts, ai_dedup_provider,
  enrich_summaries, source_auto_pause_enabled, source_auto_pause_threshold,
  updated_at
) values (
  '00000000-0000-4000-8000-000000000001', 'en', '08:00', '23:00', 6, 16,
  '23:00', '08:00', 10, 20,
  true, array['war','iran','proxies','usa'], 3,
  2, 'Asia/Baghdad', false, 72,
  0.52, 3000, false, '08:00',
  24, 'gemini_first', 'google/gemini-3.6-flash', true,
  1, 60, array['war','iran','proxies','usa'],
  'chat', 'breaking', 15,
  10, 15,
  5, 1, true,
  'both', 72, 30, 'groq',
  true, true, 8,
  now()
) on conflict (id) do nothing;

insert into public.topic_queries (query, category, enabled) values
  ('Iran United States', 'usa', true),
  ('Iran strike attack', 'war', true),
  ('Iran nuclear talks', 'iran', true),
  ('Hezbollah', 'proxies', true),
  ('Houthi Red Sea', 'proxies', true),
  ('Iraqi militias Iran', 'proxies', true),
  ('Israel Iran', 'war', true),
  ('oil price', 'oil', true),
  ('gold price', 'gold', true),
  ('Strait of Hormuz', 'oil', true),
  ('Iran Saudi Arabia relations', 'iran', true),
  ('Trump Iran', 'usa', true)
on conflict (query) do nothing;

insert into public.sources (
  name, kind, secret_ref, config, priority, daily_quota, used_today,
  quota_date, enabled
) values
  ('NewsData.io', 'newsdata', 'NEWSDATA_API_KEY', '{}'::jsonb, 10, 200, 0, to_char(now(), 'YYYY-MM-DD'), true),
  ('Google News RSS', 'rss', null, '{}'::jsonb, 50, null, 0, to_char(now(), 'YYYY-MM-DD'), true),
  ('@ajanews', 'telegram', null, '{"channel":"ajanews"}'::jsonb, 30, null, 0, to_char(now(), 'YYYY-MM-DD'), true),
  ('@insiderpaper', 'telegram', null, '{"channel":"insiderpaper"}'::jsonb, 30, null, 0, to_char(now(), 'YYYY-MM-DD'), true),
  ('@middle_east_spectator', 'telegram', null, '{"channel":"middle_east_spectator"}'::jsonb, 30, null, 0, to_char(now(), 'YYYY-MM-DD'), true),
  ('@thecradlemedia', 'telegram', null, '{"channel":"thecradlemedia"}'::jsonb, 30, null, 0, to_char(now(), 'YYYY-MM-DD'), true)
on conflict (kind, name) do nothing;
