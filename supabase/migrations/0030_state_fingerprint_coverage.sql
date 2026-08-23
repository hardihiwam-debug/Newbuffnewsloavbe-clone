-- 0030: close the state-hash fingerprint-coverage gaps.
--
-- Now that unchanged polls are answered with { __unchanged: true }, a resource
-- whose READ set is wider than its fingerprint goes silently stale until some
-- fingerprinted table changes. Two resources read more than they fingerprint:
--
--   dashboardSummary  → also renders cron_job_health (scheduler run status);
--                       a job finishing would leave the Cron health panel
--                       frozen on the old "running" label.
--   dashboardQueue    → also joins chats titles into published history; a
--                       renamed channel would leave stale "→ chat" titles.
--
-- Both tables join their resource's fingerprint below (the cron composite also
-- carries the active-job count so enabling/disabling a job moves the
-- fingerprint too). Replaces the 0028 function wholesale (create or replace).

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
    'activity',  (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.activity_log),
    'cron',      (select count(*) || '|' || count(*) filter (where active) || '|' || coalesce(max(last_run_started_at)::text, '') from public.cron_job_health)
  ),
  'dashboardFeed', jsonb_build_object(
    'queue',    (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.queue),
    'activity', (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.activity_log)
  ),
  'dashboardQueue', jsonb_build_object(
    'queue',     (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.queue),
    'published', (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.published_history),
    'chats',     (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.chats)
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
