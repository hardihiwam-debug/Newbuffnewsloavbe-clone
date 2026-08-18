-- Iran Desk Bot — gateway-hosted Google Gemini models in the translation chain.
--
-- google/gemini-2.5-flash and google/gemini-2.5-flash-lite run through the
-- Vercel AI Gateway (same MINIMAX_API_KEY gateway token as MiniMax), NOT the
-- direct Google REST API / GEMINI_API_KEY_1..6 pool. This keeps translation
-- alive when the free Gemini keys are quota-exhausted, paid via the Vercel
-- account instead.
--
-- Seed the default order for rows that never set one: direct Gemini models
-- first (free keys, unchanged priority), then gateway Gemini 2.5, then MiniMax.
update public.settings
set translation_model_order = '["gemini-3.7-flash","gemini-3.6-flash","gemini-3.5-flash","gemini-3.5-flash-lite","google/gemini-2.5-flash","google/gemini-2.5-flash-lite","minimax/minimax-m3"]'::jsonb
where translation_model_order is null;
