-- Iran Desk Bot — cron health view for the admin dashboard.
--
-- pg_cron / pg_net live in non-public schemas that PostgREST does not expose,
-- so the admin Edge Function cannot read cron.job / cron.job_run_details
-- directly. This public view projects the scheduler state (active, schedule,
-- last run time, last status + message) so the dashboard can show whether the
-- automatic pipeline ticker is actually running.
--
-- The view is owned by postgres, and (pre-Postgres-16 default) views execute
-- with the owner's privileges, so the service role only needs SELECT here —
-- not on the underlying cron.* relations.

create or replace view public.cron_job_health as
select
  j.jobname,
  j.schedule,
  j.active,
  d.start_time as last_run_started_at,
  d.end_time as last_run_finished_at,
  d.status as last_run_status,
  left(d.return_message, 500) as last_run_message
from cron.job j
left join lateral (
  select jrd.start_time, jrd.end_time, jrd.status, jrd.return_message
  from cron.job_run_details jrd
  where jrd.jobid = j.jobid
  order by jrd.start_time desc
  limit 1
) d on true;

grant select on public.cron_job_health to anon, authenticated, service_role;
