-- 0042: Preserve the pre-policy publish ranking.
--
-- 0041 seeded every category into category_policy, which made the pipeline
-- score with the four priority PRESETS (80/60/40/20) instead of the tuned
-- per-category CATEGORY_PRIORITY values used before (iraq 70, gaza 62,
-- war 60, syria/lebanon 57, ...). That silently re-ordered the channel
-- (war jumped 60 -> 80; syria/lebanon dropped 57 -> 40; oil rose 25 -> 40).
--
-- This backfills each category's scoreOverride with its legacy score so
-- publish ordering is exactly what it was pre-0041. scoreOverride only wins
-- while it is non-zero; the Settings UI clears it (sets 0) when the operator
-- picks a priority preset, so the coarse preset control still takes effect.
--
-- The update only runs when NO category already has a non-zero override, so
-- an operator who has already customized priorities is never clobbered.

update public.settings
set category_policy = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
  category_policy,
  '{iraq,scoreOverride}', '70'),
  '{gaza,scoreOverride}', '62'),
  '{war,scoreOverride}', '60'),
  '{syria,scoreOverride}', '57'),
  '{lebanon,scoreOverride}', '57'),
  '{iran,scoreOverride}', '50'),
  '{proxies,scoreOverride}', '45'),
  '{middle-east,scoreOverride}', '42'),
  '{analysis,scoreOverride}', '34'),
  '{gold,scoreOverride}', '30'),
  '{usa,scoreOverride}', '30'),
  '{oil,scoreOverride}', '25'),
  '{economic-impact,scoreOverride}', '20')
where category_policy is not null
  and not exists (
    select 1
    from jsonb_each(category_policy) e
    where e.value ->> 'scoreOverride' is not null
      and e.value ->> 'scoreOverride' <> '0'
  );
