-- Iran Desk Bot — cron configuration (single source of truth for the
-- scheduler's HTTP targets + internal secret).
--
-- The cron jobs (0002_pipeline, 0010_bulletin) read these from the settings
-- row at tick time. Keep `pipeline_cron_secret` equal to the INTERNAL_SECRET
-- deployed on the pipeline/bulletin Edge Functions; set it to NULL to disable
-- the secret check on those functions.
--
-- The secret is seeded with the value the previous hardcoded cron jobs used so
-- this migration is a drop-in replacement for existing behaviour. If the
-- deployed INTERNAL_SECRET differs, update this row (or the Settings → System
-- UI) — there is no code change required anymore.

alter table public.settings
  add column if not exists pipeline_cron_url text,
  add column if not exists bulletin_cron_url text,
  add column if not exists pipeline_cron_secret text;

update public.settings
   set pipeline_cron_url = coalesce(
         pipeline_cron_url,
         'https://ljvdaajfbkqeodglghwn.supabase.co/functions/v1/pipeline'
       ),
       bulletin_cron_url = coalesce(
         bulletin_cron_url,
         'https://ljvdaajfbkqeodglghwn.supabase.co/functions/v1/bulletin'
       ),
       pipeline_cron_secret = coalesce(
         pipeline_cron_secret,
         'sbpipe_internal_8f2c1a9d4b6e7f03'
       );
