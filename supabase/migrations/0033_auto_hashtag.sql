-- Auto-hashtag (Settings → Posting): append the post's category as a
-- localized hashtag at the very bottom of every news post, following the
-- post's language (en / ckb). Default ON; the toggle in the Posting tab
-- persists here. The mapping itself lives in the pipeline bundle
-- (categoryHashtag in _shared.ts) — no schema beyond the flag is needed.
alter table public.settings add column if not exists auto_hashtag boolean not null default true;
