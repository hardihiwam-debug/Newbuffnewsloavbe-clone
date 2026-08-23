-- 0028: change tracking for state-hash conditional polling (egress fast-win).
--
-- The SPA polls 9 dashboard resources on fixed cadences. Most polls find
-- nothing changed, yet each returns a full payload (queue rows, history,
-- chats, usage). This migration gives every table the dashboard reads a
-- cheap "count | max(updated_at)" fingerprint via admin_fingerprints(), so
-- the admin function can answer an unchanged poll with a ~100-byte
-- { __unchanged: true } response and the SPA keeps its copy.
--
-- updated_at is added (with a shared BEFORE UPDATE trigger) to every table
-- the dashboard polls. created_at-only tables are backfilled from created_at
-- so the first fingerprint is meaningful immediately. settings already had
-- updated_at; the trigger just keeps it honest.

alter table public.bots add column if not exists updated_at timestamptz;
alter table public.queue add column if not exists updated_at timestamptz;
alter table public.published_history add column if not exists updated_at timestamptz;
alter table public.chats add column if not exists updated_at timestamptz;
alter table public.activity_log add column if not exists updated_at timestamptz;
alter table public.sources add column if not exists updated_at timestamptz;
alter table public.topic_queries add column if not exists updated_at timestamptz;
alter table public.translation_history add column if not exists updated_at timestamptz;
alter table public.translation_failures add column if not exists updated_at timestamptz;
alter table public.clusters add column if not exists updated_at timestamptz;
alter table public.polls add column if not exists updated_at timestamptz;
alter table public.ai_usage add column if not exists updated_at timestamptz;
alter table public.translation_provider_keys add column if not exists updated_at timestamptz;
alter table public.gemini_key_usage add column if not exists updated_at timestamptz;
alter table public.gemini_call_log add column if not exists updated_at timestamptz;

-- Backfill from created_at (every table above has one) so existing rows get
-- a truthful fingerprint instead of NULL (NULL max would never match a
-- client fingerprint, forcing a full refetch once per table — harmless, but
-- this avoids it).
update public.bots set updated_at = created_at where updated_at is null;
update public.queue set updated_at = created_at where updated_at is null;
update public.published_history set updated_at = published_at where updated_at is null;
update public.chats set updated_at = coalesce(last_seen_at, created_at) where updated_at is null;
update public.activity_log set updated_at = created_at where updated_at is null;
update public.sources set updated_at = created_at where updated_at is null;
update public.topic_queries set updated_at = created_at where updated_at is null;
update public.translation_history set updated_at = created_at where updated_at is null;
update public.translation_failures set updated_at = created_at where updated_at is null;
update public.clusters set updated_at = last_seen_at where updated_at is null;
update public.polls set updated_at = created_at where updated_at is null;
-- ai_usage / gemini_key_usage have no timestamp column (per-day counters);
-- stamping existing rows with now() is fine — count is their real signal.
update public.ai_usage set updated_at = now() where updated_at is null;
update public.translation_provider_keys set updated_at = created_at where updated_at is null;
update public.gemini_key_usage set updated_at = now() where updated_at is null;
update public.gemini_call_log set updated_at = "at" where updated_at is null;
update public.settings set updated_at = now() where updated_at is null;

-- Shared trigger: bump updated_at on any UPDATE so fingerprints move when a
-- row's content changes (status flips, edits, health patches), not just on
-- INSERT.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'settings','bots','queue','published_history','chats','activity_log',
    'sources','topic_queries','translation_history','translation_failures',
    'clusters','polls','ai_usage','translation_provider_keys',
    'gemini_key_usage','gemini_call_log'
  ]
  loop
    execute format('drop trigger if exists trg_%s_updated_at on %I', t, t);
    execute format(
      'create trigger trg_%s_updated_at before update on %I for each row execute function public.set_updated_at()',
      t, t
    );
  end loop;
end;
$$;

-- Per-resource fingerprints: "count | max(updated_at)" for the exact tables
-- each dashboard resource reads. All lookups use existing indexes (count is
-- a cheap seq scan on small tables; max uses the btree). One RPC replaces
-- the full payload for unchanged polls.
create or replace function public.admin_fingerprints()
returns jsonb
language sql
stable
as $$
select jsonb_build_object(
  'dashboardSummary', jsonb_build_object(
    'settings',  (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.settings),
    'bots',      (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.bots),
    'queue',     (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.queue),
    'published', (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.published_history),
    'polls',     (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.polls),
    'fails',     (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.translation_failures),
    'usage',     (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.ai_usage),
    'activity',  (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.activity_log)
  ),
  'dashboardFeed', jsonb_build_object(
    'queue',    (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.queue),
    'activity', (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.activity_log)
  ),
  'dashboardQueue', jsonb_build_object(
    'queue',     (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.queue),
    'published', (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.published_history)
  ),
  'dashboardChats', jsonb_build_object(
    'chats', (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.chats)
  ),
  'dashboardSources', jsonb_build_object(
    'sources', (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.sources),
    'topics',  (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.topic_queries)
  ),
  'dashboardAnalytics', jsonb_build_object(
    'published', (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.published_history),
    'polls',     (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.polls)
  ),
  'dashboardAi', jsonb_build_object(
    'fails',   (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.translation_failures),
    'history', (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.translation_history)
  ),
  'dashboardEvents', jsonb_build_object(
    'clusters', (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.clusters)
  ),
  'dashboardPublished', jsonb_build_object(
    'polls', (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.polls)
  )
);
$$;
