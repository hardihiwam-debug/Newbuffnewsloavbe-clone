-- 0041: Unified category policy — one configurable profile per category.
--
-- category_policy stores a JSONB object keyed by category slug. Each entry:
-- {
--   "status": "enabled"|"disabled"|"review",
--   "priority": "very_high"|"high"|"normal"|"low",
--   "score_override": 0,          -- 0 = use priority preset
--   "freshness_hours": 0,         -- 0 = use global per-category default
--   "max_posts_per_day": 0,       -- 0 = unlimited
--   "keywords": [],               -- must-match keywords for classification
--   "excluded_keywords": [],      -- if ANY present → reject classification
--   "hashtags_enabled": true,     -- per-category hashtag toggle
--   "max_hashtags": 0             -- 0 = use global setting
-- }
--
-- All fields are optional; missing fields use safe defaults at read time.

alter table public.settings
  add column category_policy jsonb default '{}'::jsonb;

-- Seed sensible defaults for all 13 canonical categories so the UI
-- always has a row to show. Existing settings rows get an empty object
-- (no policy entries = everything uses defaults = same behavior as before).
update public.settings
set category_policy = '{
  "iraq":     { "status": "enabled", "priority": "high" },
  "gaza":     { "status": "enabled", "priority": "high" },
  "war":      { "status": "enabled", "priority": "very_high" },
  "syria":    { "status": "enabled", "priority": "normal" },
  "lebanon":  { "status": "enabled", "priority": "normal" },
  "iran":     { "status": "enabled", "priority": "high" },
  "proxies":  { "status": "enabled", "priority": "normal" },
  "middle-east": { "status": "enabled", "priority": "normal" },
  "analysis": { "status": "enabled", "priority": "low" },
  "gold":     { "status": "enabled", "priority": "normal" },
  "usa":      { "status": "enabled", "priority": "normal" },
  "oil":      { "status": "enabled", "priority": "normal" },
  "economic-impact": { "status": "enabled", "priority": "low" }
}'::jsonb
where category_policy = '{}'::jsonb or category_policy is null;
