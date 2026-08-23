-- 0031: Scheduled Posts / Campaign engine (series, recurring, one-time).
--
-- A separate automation lane from the news pipeline: the operator authors
-- content (e.g. a 30-part Seerah series), and the dedicated `scheduled` Edge
-- Function (ticked every minute by pg_cron) publishes parts according to the
-- campaign's schedule — advancing a series only after a successful send
-- (or auto-skipping a part after max_attempts failures).
--
-- State lives in the DB (not memory), so restarts never lose progress.
-- updated_at + the shared trigger (0028) keep the tables fingerprint-able for
-- state-hash polling of the Campaigns tab.

alter table public.settings
  add column if not exists scheduled_cron_url text,
  add column if not exists scheduled_run_lock_at timestamptz;

update public.settings
   set scheduled_cron_url = coalesce(
         scheduled_cron_url,
         'https://ljvdaajfbkqeodglghwn.supabase.co/functions/v1/scheduled'
       )
 where scheduled_cron_url is null;

-- Campaign header: what to send, when, to which chats.
create table if not exists public.scheduled_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'series' check (kind in ('one_time','recurring','series')),
  status text not null default 'active' check (status in ('active','paused','completed','expired')),
  timezone text not null default 'Asia/Baghdad',
  start_at timestamptz,
  end_at timestamptz,
  -- kind-specific schedule config:
  --   one_time : { at: "20:00" }                        (date comes from start_at)
  --   recurring: { frequency: "daily"|"weekly"|"custom", interval_days?: N,
  --                weekdays?: [1..7], times?: ["20:00"] }
  --   series   : { cadence: "daily"|"weekly"|"selected_days"|"manual"|"custom",
  --                interval_days?: N, weekdays?: [1..7], times?: ["20:00"] }
  --               part N goes out at start_at + (N-1) * interval; "manual"
  --               uses each item's scheduled_for override.
  schedule jsonb not null default '{}'::jsonb,
  target_chat_ids jsonb not null default '[]'::jsonb,
  max_attempts integer not null default 3 check (max_attempts >= 1),
  -- Recurring progress + next-due preview (series progress lives in items).
  last_sent_at timestamptz,
  next_send_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

-- The posts/parts inside a campaign (ordered by position).
create table if not exists public.scheduled_items (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.scheduled_campaigns(id) on delete cascade,
  position integer not null check (position >= 1),
  title text,
  text text not null,
  image_url text,
  scheduled_for timestamptz,
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  attempts integer not null default 0,
  error text,
  sent_at timestamptz,
  force_due boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (campaign_id, position)
);
create index if not exists scheduled_items_campaign_idx on public.scheduled_items (campaign_id, position);
create index if not exists scheduled_items_due_idx on public.scheduled_items (status, force_due);

-- Delivery history (one row per item × chat).
create table if not exists public.scheduled_log (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.scheduled_campaigns(id) on delete cascade,
  item_id uuid references public.scheduled_items(id) on delete set null,
  chat_id bigint not null,
  ok boolean not null,
  error text,
  sent_at timestamptz not null default now()
);
create index if not exists scheduled_log_item_idx on public.scheduled_log (item_id);
create index if not exists scheduled_log_campaign_idx on public.scheduled_log (campaign_id, sent_at desc);

-- updated_at on the new tables (shared trigger from 0028).
alter table public.scheduled_campaigns add column if not exists updated_at timestamptz;
alter table public.scheduled_items add column if not exists updated_at timestamptz;
update public.scheduled_campaigns set updated_at = created_at where updated_at is null;
update public.scheduled_items set updated_at = created_at where updated_at is null;
do $$
declare t text;
begin
  foreach t in array array['scheduled_campaigns','scheduled_items']
  loop
    execute format('drop trigger if exists trg_%s_updated_at on %I', t, t);
    execute format(
      'create trigger trg_%s_updated_at before update on %I for each row execute function public.set_updated_at()',
      t, t
    );
  end loop;
end;
$$;

-- 1-minute ticker for the dedicated `scheduled` Edge Function. URL + secret
-- are read from the settings row at tick time (mirrors the pipeline cron).
create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'news-desk-scheduled';

select cron.schedule(
  'news-desk-scheduled',
  '* * * * *',
  $job$
    select net.http_post(
      url := coalesce(
        (select scheduled_cron_url from public.settings limit 1),
        'https://ljvdaajfbkqeodglghwn.supabase.co/functions/v1/scheduled'
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
