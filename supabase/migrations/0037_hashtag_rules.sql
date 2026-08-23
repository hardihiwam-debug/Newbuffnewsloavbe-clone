-- 0037: configurable category + topic hashtags.
-- Rules are JSON so the operator can maintain localized labels, keyword
-- triggers, enabled topic tags, and a one/two-topic limit without schema churn.

alter table public.settings
  add column if not exists hashtag_rules jsonb not null default '{}'::jsonb;
