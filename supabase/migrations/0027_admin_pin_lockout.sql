-- Admin PIN brute-force lockout.
--
-- The admin Edge Function is publicly reachable (anon key, PIN-gated). To
-- stop an attacker from guessing the PIN forever, every wrong attempt is
-- recorded per client IP here — the function returns HTTP 429 once an IP
-- exceeds 5 failed attempts within 15 minutes, until the window expires.
-- Written by the admin function via the service-role key (RLS bypass), read
-- only by that same function. Rows are pruned lazily by the function
-- (expired windows deleted on the next failure), so steady-state row count
-- stays near zero.

create table if not exists public.admin_auth_attempts (
  ip text primary key,
  failed_count integer not null default 0,
  first_failed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Same RLS treatment as every other public table (migration 0007): zero
-- policies + RLS on = the anon key (which ships in the Vite bundle) cannot
-- read or write this table, so the lockout state itself is not tamperable.
alter table public.admin_auth_attempts enable row level security;
