-- Iran Desk Bot — translation cache + retention indexes.
-- cache_key = sha256(input text) so the pipeline can reuse a Sorani
-- translation instead of calling Gemini again for the same content.

alter table public.translation_history add column if not exists cache_key text;

create unique index if not exists translation_history_cache_key_idx
  on public.translation_history (cache_key)
  where cache_key is not null;

-- queue status + created_at index speeds up the 48h-expiry / 7d-rolloff
-- DELETE/PATCH runs that happen every pipeline cycle.
create index if not exists queue_status_created_at_idx
  on public.queue (status, created_at);
