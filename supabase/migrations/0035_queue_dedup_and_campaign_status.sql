-- 0035: Audit hardening — queue idempotency + campaign terminal status.
--
-- M1: concurrent ingest cycles (a manual `mode=ingest` racing the 1-minute
-- cron) could insert two queue rows with the same dedup_key because queue had
-- no unique constraint. A unique index makes insertQueueItem idempotent: the
-- second insert hits the index and insertQueueItem's catch ignores it. This
-- also closes the analysis-follow-up race (two cycles both passing
-- hasWhyItMatters and inserting the same analysis:<event_id>). Dedupe existing
-- rows first (keep the oldest) so the index can be created.
--
-- L2: a series whose remaining parts were all auto-skipped (failed after
-- max_attempts) was reported as "completed". Add a "failed" campaign status
-- and let refreshCampaign distinguish the two terminal states.

delete from public.queue a
using public.queue b
where a.dedup_key = b.dedup_key
  and (
    a.created_at > b.created_at
    or (a.created_at = b.created_at and a.id > b.id)
  );

create unique index if not exists queue_dedup_key_unique
  on public.queue (dedup_key);

-- Extend the campaign status enum. Postgres auto-names inline column CHECK
-- constraints "<table>_<column>_check"; drop defensively by constraint type +
-- definition so the migration never depends on the exact generated name, and
-- stays idempotent when re-run (the re-added constraint also matches and is
-- dropped first).
do $$
declare
  cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'public.scheduled_campaigns'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%status%';
  if cname is not null then
    execute format('alter table public.scheduled_campaigns drop constraint %I', cname);
  end if;
end $$;

alter table public.scheduled_campaigns
  add constraint scheduled_campaigns_status_check
  check (status in ('active','paused','completed','expired','failed'));
