-- Enable Row Level Security on every public table.
--
-- The dashboard SPA never talks to PostgREST directly — it calls the
-- PIN-gated `admin` Edge Function over HTTPS, and both the `admin` and
-- `pipeline` Edge Functions use the service-role key, which bypasses RLS.
-- Turning RLS on with zero policies therefore closes the "public table that
-- anyone holding the anon key can read/write" hole (the anon key ships in the
-- Vite bundle) without changing how the bot itself works.
alter table public.settings enable row level security;
alter table public.ai_usage enable row level security;
alter table public.topic_queries enable row level security;
alter table public.sources enable row level security;
alter table public.chats enable row level security;
alter table public.raw_articles enable row level security;
alter table public.queue enable row level security;
alter table public.published_history enable row level security;
alter table public.clusters enable row level security;
alter table public.translation_failures enable row level security;
alter table public.translation_provider_keys enable row level security;
alter table public.activity_log enable row level security;
alter table public.translation_history enable row level security;
alter table public.gemini_throttle enable row level security;
alter table public.gemini_call_log enable row level security;
alter table public.gemini_key_usage enable row level security;
alter table public.polls enable row level security;
