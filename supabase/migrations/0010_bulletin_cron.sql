-- Iran Desk Bot — scheduler for the Daily Bulletin edge function.
-- Ticks every 5 minutes; the function self-gates on the settings timezone's
-- wall clock (fires once per local day at/after bulletin_time) and reserves
-- the send with a conditional settings PATCH, so extra ticks are free and
-- overlapping ticks can never double-deliver.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Idempotent: drop any previous schedule with this name before (re)creating.
select cron.unschedule(jobid) from cron.job where jobname = 'iran-desk-bulletin';

select cron.schedule(
  'iran-desk-bulletin',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := 'https://ljvdaajfbkqeodglghwn.supabase.co/functions/v1/bulletin',
      headers := '{"Content-Type":"application/json","x-internal-secret":"sbpipe_internal_8f2c1a9d4b6e7f03"}'::jsonb,
      body := '{"trigger":"cron"}'::jsonb
    )
  $job$
);
