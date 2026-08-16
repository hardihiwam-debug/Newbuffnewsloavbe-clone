-- Operator-configured footer hyperlinks appended to every published post.
-- Stored as a jsonb array of { url, text } objects.
alter table public.settings
  add column if not exists post_links jsonb;
