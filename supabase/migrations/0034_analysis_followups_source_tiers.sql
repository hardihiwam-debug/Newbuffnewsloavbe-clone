-- 0034: Analysis follow-ups ("Why it matters") + source trust-tier byline.
--
-- Why-it-matters: when a breaking story in a configured category is published,
-- the pipeline generates a short explainer (context + consequences) and queues
-- it as a separate "analysis" post for the next cycle. queue.analysis_kind and
-- published_history.analysis_kind mark these editorial add-ons so they (a) are
-- exempt from cluster/dedup suppression and (b) never re-trigger the generator.
--
-- Source trust-tier: a small "Wire / State media / Independent / Analysis" tag
-- appended to the byline so the audience can tell a wire service from a state
-- outlet from an opinion/think-tank piece. Mapping lives in the pipeline bundle
-- (sourceTier in _shared.ts); the flag below just turns the tag on/off.

alter table public.settings
  add column if not exists why_it_matters_enabled boolean not null default false,
  add column if not exists why_it_matters_categories jsonb not null default '["war","iran","proxies","gaza","syria","lebanon","iraq","usa"]'::jsonb,
  add column if not exists why_it_matters_max_per_day integer not null default 4,
  add column if not exists why_it_matters_prefix text not null default 'WHY IT MATTERS — ',
  add column if not exists source_tier_enabled boolean not null default true;

alter table public.queue
  add column if not exists analysis_kind text;

alter table public.published_history
  add column if not exists analysis_kind text;
