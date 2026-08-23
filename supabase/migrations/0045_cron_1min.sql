-- Restore pipeline cron tick 1/5min -> 1/1min.
--
-- The 5-minute ticker (0015) quantizes publish gaps to 5-minute steps: an
-- operator gap of 4–6 minutes produces ~5 min or ~10 min spacing because the
-- window-gap check only runs when the cron wakes. A 1-minute ticker honors
-- the operator's gap setting exactly. Gated work (ingest / telegram fast
-- lane) keeps its own interval settings — extra ticks just read settings and
-- skip.
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
