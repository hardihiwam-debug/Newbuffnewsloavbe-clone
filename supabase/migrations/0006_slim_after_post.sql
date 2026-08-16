-- Delete-after-post rollout.
-- Bring the dedup cooldown down from 72h to the original 8-hour window.
-- Smaller dedup window => fewer rows retained in published_history,
-- translation_history, clusters, raw_articles => smaller free-plan DB.
--
-- Touches only rows where event_cooldown_hours is NULL or > 8 — operators
-- who set a custom longer window already know what they're doing.

update public.settings set event_cooldown_hours = 8 where event_cooldown_hours is null or event_cooldown_hours > 8;

-- One-shot deep cleanup of pre-existing rows that the new tighter prune
-- function in pipeline/index.ts will maintain going forward. This brings
-- the table sizes to the steady-state immediately, so the next dashboard
-- refresh is fast and Supabase row counts drop back to the free-plan tier.
delete from public.queue where status in ('published', 'publishing', 'duplicate', 'expired', 'rejected');
delete from public.published_history where published_at < now() - interval '16 hours';
delete from public.translation_history where created_at < now() - interval '16 hours';
delete from public.clusters where last_seen_at < now() - interval '16 hours';
delete from public.raw_articles where fetched_at < now() - interval '48 hours';
delete from public.activity_log where created_at < now() - interval '3 days';
delete from public.gemini_call_log where at < now() - interval '7 days';
delete from public.translation_failures where created_at < now() - interval '7 days';
delete from public.ai_usage where day::date < (current_date - 30);
