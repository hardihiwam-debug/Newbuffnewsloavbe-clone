-- 24h auto chat discovery (manual Sync chats + daily auto-sync).
-- The pipeline re-scans every bot's getUpdates stream at most once per 24h and
-- stamps this column so the gate survives redeploys/restarts. NULL = never
-- synced yet (first cycle after deploy runs discovery immediately).
alter table public.settings
  add column if not exists last_chat_sync_at timestamptz;
