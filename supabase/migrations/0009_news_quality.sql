-- Phase-2 news-content-quality rollout (from the content-quality review):
--   1. queue.facts — structured fact object from the extraction step
--      (event / actor / action / target / location / time / claimed_result /
--      confirmed_result / source_attribution / confidence / numbers). The
--      summary and headline are generated ONLY from these facts, so the AI can
--      never make a thin source sound more complete than it is.
--   2. queue.is_update + published_history.is_update — material follow-ups of
--      an already-published event publish as "UPDATE — …" posts tied to the
--      same event_id instead of unrelated news items (review point 5).
--   3. Content-quality settings with sane defaults:
--      breaking_max_age_hours     — a story older than this never breaks
--                                   (review point 6)
--      update_material_threshold  — event similarity above this = re-report
--                                   (dropped as duplicate); below = material
--                                   update (review point 5)
--      update_cooldown_hours      — min gap between updates of one event
--      max_updates_per_cycle      — cap on update posts per publish cycle
--      update_prefix              — prefix prepended to update headlines

alter table public.queue
  add column if not exists facts jsonb,
  add column if not exists is_update boolean not null default false;

alter table public.published_history
  add column if not exists is_update boolean not null default false;

alter table public.settings
  add column if not exists breaking_max_age_hours double precision not null default 8,
  add column if not exists update_material_threshold double precision not null default 0.7,
  add column if not exists update_cooldown_hours double precision not null default 1,
  add column if not exists max_updates_per_cycle double precision not null default 2,
  add column if not exists update_prefix text not null default 'UPDATE — ';
