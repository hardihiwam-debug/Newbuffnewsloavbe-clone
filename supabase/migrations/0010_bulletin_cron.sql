-- Iran Desk Bot — scheduler for the Daily Bulletin edge function.
-- Ticks every 5 minutes; the function self-gates on the settings timezone's
-- wall clock (fires once per local day at/after bulletin_time) and reserves
-- the send with a conditional settings PATCH, so extra ticks are free and
-- overlapping ticks can never double-deliver.
--
-- The target URL + internal secret are read from the settings row at tick time
-- (seeded by 0013_cron_config.sql) instead of being hardcoded here, so they can
-- be changed without editing and re-running this migration. Keep
-- settings.pipeline_cron_secret equal to the INTERNAL_SECRET deployed on the
-- bulletin Edge Function (clear both to disable the secret check).

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Idempotent: drop any previous schedule with this name before (re)creating.
select cron.unschedule(jobid) from cron.job where jobname = 'iran-desk-bulletin';

select cron.schedule(
  'iran-desk-bulletin',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := coalesce(
        (select bulletin_cron_url from public.settings limit 1),
        'https://ljvdaajfbkqeodglghwn.supabase.co/functions/v1/bulletin'
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
