-- Iran Desk Bot — pipeline cron tick 1/min -> 1/5min (egress reduction).
--
-- Nothing in the pipeline needs a 1-minute tick: ingest is gated at
-- ingest_interval_minutes (15), the Telegram fast lane at
-- telegram_signals_interval_minutes (5), and publishing at
-- publish_interval_minutes (10). Each 1-minute tick still wakes the Edge
-- Function, reads settings, and (when gated work is due) downloads feeds —
-- so a 5-minute ticker removes ~80% of the pointless wakeups with zero
-- change in cadence. Retries of a failed cycle simply wait up to 5 minutes.
--
-- The target URL + internal secret are still read from the settings row at
-- tick time (seeded by 0013_cron_config.sql), so this only touches the
-- schedule.

-- Idempotent: drop the previous schedule with this name before (re)creating.
select cron.unschedule(jobid) from cron.job where jobname = 'iran-desk-pipeline';

select cron.schedule(
  'iran-desk-pipeline',
  '*/5 * * * *',
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
