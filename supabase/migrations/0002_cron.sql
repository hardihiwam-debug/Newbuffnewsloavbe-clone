-- Iran Desk Bot — Supabase scheduler for the Edge Function pipeline.
-- pg_cron ticks every minute; the Edge Function self-gates on the editable
-- intervals and the day/night posting windows, so this is just a ticker.
--
-- The target URL + internal secret are read from the settings row at tick time
-- (seeded by 0013_cron_config.sql) instead of being hardcoded here, so they can
-- be changed without editing and re-running this migration. Keep
-- settings.pipeline_cron_secret equal to the INTERNAL_SECRET deployed on the
-- pipeline Edge Function (clear both to disable the secret check).

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Idempotent: drop any previous schedule with this name before (re)creating.
select cron.unschedule(jobid) from cron.job where jobname = 'iran-desk-pipeline';

select cron.schedule(
  'iran-desk-pipeline',
  '* * * * *',
  $job$
    select net.http_post(
      url := coalesce(
        (select pipeline_cron_url from public.settings limit 1),
        'https://ljvdaajfbkqeodglghwn.supabase.co/functions/v1/pipeline'
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-internal-secret', coalesce(
          (select pipeline_cron_secret from public.settings limit 1), ''
        )
      ),
      body := '{"trigger":"cron"}'::jsonb
    )
  $job$
);
