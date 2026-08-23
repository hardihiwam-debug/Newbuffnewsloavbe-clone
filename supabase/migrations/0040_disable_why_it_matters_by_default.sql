-- 0040: automatic Why-it-matters follow-ups are opt-in.
-- Existing operators can still enable them from Settings → Posting.

alter table public.settings
  alter column why_it_matters_enabled set default false;

update public.settings
set why_it_matters_enabled = false;
