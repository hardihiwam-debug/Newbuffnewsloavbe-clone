-- 0036: configurable AI writing styles.
-- The style is a presentation policy only: it may change register, structure,
-- and wording, never the underlying facts, figures, or attribution.

alter table public.settings
  add column if not exists text_style text not null default 'professional'
    check (text_style in ('auto', 'current', 'professional', 'conversational', 'casual', 'explainer', 'simple'));

alter table public.settings
  add column if not exists text_length text not null default 'auto'
    check (text_length in ('auto', 'brief', 'standard', 'long_form'));

alter table public.settings
  add column if not exists text_style_auto boolean not null default true;

alter table public.settings
  add column if not exists text_style_ai_assist boolean not null default false;

alter table public.settings
  add column if not exists style_by_category jsonb not null default '{}'::jsonb;

alter table public.settings
  add column if not exists text_style_rules jsonb not null default '{}'::jsonb;
