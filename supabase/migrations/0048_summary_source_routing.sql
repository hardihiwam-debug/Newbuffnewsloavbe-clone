-- 0048: summary-source routing (Tier 1 + Tier 3)
--   extractive_lede: ON → web articles with a short real body (240–800 chars)
--     ship the SOURCE headline + the body's own first sentences verbatim —
--     zero AI calls. The wire lede IS the professional summary.
--   ai_compress: ON → longer bodies skip extract→compose and get one cheap
--     AI call: "compress this article to ~N chars", preserving every figure,
--     name, date, quote and attribution verb from the original.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS extractive_lede boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_compress boolean NOT NULL DEFAULT true;

NOTIFY pgrst, 'reload schema';
