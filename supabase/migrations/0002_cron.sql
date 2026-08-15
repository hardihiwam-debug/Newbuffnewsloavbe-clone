-- Iran Desk Bot — Supabase scheduler for the Edge Function pipeline.
-- pg_cron ticks every minute; the Edge Function self-gates on the editable
-- intervals and the day/night posting windows, so this is just a ticker.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Idempotent: drop any previous schedule with this name before (re)creating.
select cron.unschedule(jobid) from cron.job where jobname = 'iran-desk-pipeline';

select cron.schedule(
  'iran-desk-pipeline',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://ljvdaajfbkqeodglghwn.supabase.co/functions/v1/pipeline',
      headers := '{"Content-Type":"application/json","x-internal-secret":"sbpipe_internal_8f2c1a9d4b6e7f03"}'::jsonb,
      body := '{"trigger":"cron"}'::jsonb
    )
  $job$
);
