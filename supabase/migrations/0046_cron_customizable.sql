-- Operator-customizable pipeline ticker schedule.
--
-- The cron wake-up interval quantizes publish gaps (the window-gap check only
-- runs when pg_cron wakes), so the operator can choose the cadence from
-- Settings. Free-form cron strings are a foot-gun, so only minute-step
-- schedules are allowed: *, */2, */5, */10, */15.
--
-- set_pipeline_cron_schedule(p_schedule) is SECURITY DEFINER (owned by the
-- migration role = postgres) because cron.* lives outside the exposed
-- schemas. It re-arms job 'iran-desk-pipeline' with the exact invocation
-- seeded by 0013/0045 (pipeline_cron_url + pipeline_cron_secret from
-- settings). Also stores the choice on settings.cron_schedule for display.

alter table settings add column if not exists cron_schedule text;
update settings set cron_schedule = coalesce(cron_schedule, '*/5 * * * *');

create or replace function public.set_pipeline_cron_schedule(p_schedule text)
returns text
language plpgsql
security definer
set search_path = public, cron
as $$
declare
  v_url text;
  v_secret text;
begin
  -- Whitelist: whole-catalog minute steps only.
  if p_schedule not in ('* * * * *', '*/2 * * * *', '*/5 * * * *', '*/10 * * * *', '*/15 * * * *') then
    raise exception 'unsupported schedule % (allowed: *, */2, */5, */10, */15)', p_schedule;
  end if;

  select pipeline_cron_url, pipeline_cron_secret into v_url, v_secret from settings limit 1;

  perform cron.unschedule(jobid) from cron.job where jobname = 'iran-desk-pipeline';

  perform cron.schedule(
    'iran-desk-pipeline',
    p_schedule,
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

  -- NOTE: no settings UPDATE here - PostgREST mis-classifies functions that
  -- write tables ("UPDATE requires a WHERE clause" 400). The caller stores
  -- the choice via the normal saveSettings path instead.
  return p_schedule;
end;
$$;

grant execute on function public.set_pipeline_cron_schedule(text) to service_role;
