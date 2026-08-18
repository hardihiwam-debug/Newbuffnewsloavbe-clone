-- Remove the Daily Bulletin feature entirely: unschedule the bulletin cron
-- job (created by 0010_bulletin_cron.sql) and drop every bulletin-related
-- settings column (0001_init.sql + 0013_cron_config.sql). The bulletin edge
-- function is deleted from the repo alongside this migration.
select cron.unschedule(jobid)
  from cron.job
 where jobname = 'iran-desk-bulletin';

alter table public.settings
  drop column if exists bulletin_enabled,
  drop column if exists bulletin_time,
  drop column if exists bulletin_hours,
  drop column if exists bulletin_interval_minutes,
  drop column if exists last_bulletin_at,
  drop column if exists last_bulletin_check_at,
  drop column if exists bulletin_cron_url;
