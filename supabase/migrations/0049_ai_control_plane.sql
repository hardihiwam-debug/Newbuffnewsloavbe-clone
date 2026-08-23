-- AI control plane: providers are global, route membership is action-local.
-- API keys stay server-side in this table and are never returned by admin reads.
create table if not exists public.ai_providers (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  instance_key text not null default 'default',
  label text not null,
  kind text not null default 'openai_compatible',
  base_url text,
  api_key text,
  api_key_env text,
  default_model text,
  enabled boolean not null default true,
  last_status text,
  last_error text,
  last_latency_ms integer,
  last_tested_at timestamptz,
  cooldown_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slug, instance_key)
);

create table if not exists public.ai_action_routes (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  provider_id uuid not null references public.ai_providers(id) on delete cascade,
  position integer not null default 0,
  enabled boolean not null default true,
  fallback_mode text not null default 'continue',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (action, provider_id)
);
create index if not exists ai_action_routes_action_position_idx
  on public.ai_action_routes (action, position);

create table if not exists public.ai_attempt_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  action text not null,
  article_id text,
  queue_id text,
  source text,
  provider text,
  model text,
  attempt_number integer,
  success boolean not null default false,
  fallback_used boolean not null default false,
  latency_ms integer,
  input_chars integer,
  output_chars integer,
  prompt_tokens integer,
  completion_tokens integer,
  http_status integer,
  http_status_category text,
  validation_result text,
  failure_reason text,
  final_decision text,
  test_mode boolean not null default false,
  scenario jsonb
);
create index if not exists ai_attempt_log_created_action_idx
  on public.ai_attempt_log (created_at desc, action);
create index if not exists ai_attempt_log_article_idx
  on public.ai_attempt_log (article_id);

alter table public.ai_providers enable row level security;
alter table public.ai_action_routes enable row level security;
alter table public.ai_attempt_log enable row level security;

-- Seed provider definitions idempotently. Keys are intentionally absent; the
-- operator supplies them through Settings or the Keys/API keys UI.
insert into public.ai_providers (slug, label, kind, base_url, api_key_env, default_model)
values
  ('groq', 'Groq', 'openai_compatible', 'https://api.groq.com/openai/v1', 'GROQ_API_KEY', 'openai/gpt-oss-20b'),
  ('openrouter', 'OpenRouter', 'openai_compatible', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY', 'meta-llama/llama-3.3-70b-instruct'),
  ('cloudflare', 'Cloudflare Workers AI', 'cloudflare', null, 'CLOUDFLARE_API_TOKEN', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
  ('mistral', 'Mistral', 'openai_compatible', 'https://api.mistral.ai/v1', 'MISTRAL_API_KEY', 'mistral-small-latest'),
  ('gemini', 'Google Gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta', 'GEMINI_API_KEY_1', 'gemini-2.5-flash'),
  ('cerebras', 'Cerebras', 'openai_compatible', 'https://api.cerebras.ai/v1', 'CEREBRAS_API_KEY', 'llama-3.3-70b'),
  ('openai', 'OpenAI', 'openai_compatible', 'https://api.openai.com/v1', 'OPENAI_API_KEY', 'gpt-4o-mini'),
  ('minimax', 'MiniMax', 'openai_compatible', 'https://api.minimax.chat/v1', 'MINIMAX_API_KEY', 'MiniMax-M2')
on conflict (slug, instance_key) do update set
  label = excluded.label,
  kind = excluded.kind,
  base_url = excluded.base_url,
  api_key_env = excluded.api_key_env,
  default_model = excluded.default_model,
  updated_at = now();

notify pgrst, 'reload schema';
