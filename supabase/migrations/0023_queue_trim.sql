-- Max-queue auto-trim cap.
--
-- When the queued backlog exceeds max_queue_size, the pipeline drops the
-- lowest-scored NON-breaking items beyond the cap so the queue can't
-- balloon. Breaking items are never trimmed; 0 disables the trim.
alter table public.settings add column if not exists max_queue_size double precision not null default 150;
