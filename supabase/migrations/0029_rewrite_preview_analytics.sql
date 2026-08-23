-- 0029: rewrite preview + analytics support.
--
-- Story Review shows "original title → rewritten headline+summary, by which
-- model" before publish: queue keeps the source title and the rewrite
-- provenance that produced the stored headline/summary. The AI & Translation
-- tab's Rewrite Analytics card measures per-provider latency, so rewrite_log
-- gains the duration of each attempt.

alter table public.queue add column if not exists original_title text;
alter table public.queue add column if not exists rewrite_provider text;
alter table public.queue add column if not exists rewrite_model text;

alter table public.rewrite_log add column if not exists duration_ms integer;
