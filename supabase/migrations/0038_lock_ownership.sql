-- 0038: execution-lease ownership.
-- A timestamp alone lets an old invocation clear a newer invocation's lock
-- after the stale window expires. The owner columns make release conditional.

alter table public.settings
  add column if not exists publish_run_lock_owner text,
  add column if not exists scheduled_run_lock_owner text;
