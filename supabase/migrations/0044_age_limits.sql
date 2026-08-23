-- Operator-customizable article-age limits (previously hardcoded):
--   max_age_breaking_hours  — breaking/conflict stories (was 14)
--   max_age_news_hours      — regular news (was 22)
--   max_age_analysis_hours  — analysis/explainer/opinion (was 48)
--   telegram_max_age_hours  — Telegram fast-lane drop age (was 6)
alter table settings add column if not exists max_age_breaking_hours double precision;
alter table settings add column if not exists max_age_news_hours double precision;
alter table settings add column if not exists max_age_analysis_hours double precision;
alter table settings add column if not exists telegram_max_age_hours double precision;

update settings set
  max_age_breaking_hours = coalesce(max_age_breaking_hours, 14),
  max_age_news_hours = coalesce(max_age_news_hours, 22),
  max_age_analysis_hours = coalesce(max_age_analysis_hours, 48),
  telegram_max_age_hours = coalesce(telegram_max_age_hours, 6);
