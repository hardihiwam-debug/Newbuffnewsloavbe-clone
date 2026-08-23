-- 0047: store the English brief that was actually shipped for each post so
-- UPDATE posts can compose a delta ("only what's new") against their parent.
ALTER TABLE published_history ADD COLUMN IF NOT EXISTS english_summary text;

-- Schema cache refresh so new columns are visible to PostgREST immediately.
NOTIFY pgrst, 'reload schema';
