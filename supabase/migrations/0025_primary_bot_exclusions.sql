-- Primary-bot category blocklist (Option B): the main bot keeps delivering
-- every category EXCEPT the ones listed here. NULL / empty = no exclusions
-- (the historical "deliver everything" behavior, unchanged until configured).
alter table public.settings
  add column if not exists primary_bot_excluded_categories text[];
