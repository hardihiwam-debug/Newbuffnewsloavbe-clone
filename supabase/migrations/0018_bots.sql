-- N-bot delivery: a general bot table so the operator can register any number
-- of Telegram bots from Settings. Each bot owns a token (stored in the DB per
-- operator decision) and an optional category whitelist (null/[] = all).
-- Chats reference a bot: NULL bot_id = the primary bot (env
-- TELEGRAM_BOT_TOKEN, all categories, current behaviour unchanged).

create table if not exists public.bots (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  token text,
  categories jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.chats add column if not exists bot_id uuid references public.bots(id) on delete set null;

create index if not exists bots_enabled_idx on public.bots (enabled);

-- Same RLS treatment as every other public table (migration 0007): zero
-- policies + RLS on = the anon key (which ships in the Vite bundle) cannot
-- read or write the bots table — where bot tokens are stored. The admin /
-- pipeline Edge Functions use the service-role key, which bypasses RLS, so
-- nothing about the bot's operation changes.
alter table public.bots enable row level security;
