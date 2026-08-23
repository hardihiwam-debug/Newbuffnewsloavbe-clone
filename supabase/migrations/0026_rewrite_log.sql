-- AI rewrite log: one row per rewrite attempt (chunk), success or failure,
-- so the operator can see what the rewrite step is doing without digging
-- through the newsroom feed. Written by the pipeline (service role) and read
-- by the admin function for the Settings → AI & Translation "Rewrite log"
-- card. Row volume is tiny (a few rows per ingest cycle) and the table is
-- pruned alongside the other activity tables by the pipeline's retention
-- pass (activity_log retention window applies).

create table if not exists public.rewrite_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ok boolean not null default true,
  provider text,
  model text,
  item_count integer not null default 0,
  -- Up to ~5 headline previews (the chunk size): rewritten headlines on
  -- success, source titles on failure, so the operator sees WHAT was affected.
  headlines jsonb,
  error text
);

create index if not exists rewrite_log_created_idx on public.rewrite_log (created_at desc);

-- Same RLS treatment as every other public table (migration 0007): zero
-- policies + RLS on = the anon key (which ships in the Vite bundle) cannot
-- read or write this table. The admin / pipeline Edge Functions use the
-- service-role key, which bypasses RLS, so nothing about operation changes.
alter table public.rewrite_log enable row level security;
