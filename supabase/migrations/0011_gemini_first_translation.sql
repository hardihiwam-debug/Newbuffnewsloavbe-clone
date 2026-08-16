-- ── Gemini-first translation chain ─────────────────────────────────────────
-- Operator wants the paid Gemini keys used first. Migration 0008 had set the
-- settings row to 'minimax_first', which would override any code default, so
-- flip the live value here.
update public.settings
  set translation_mode = 'gemini_first'
  where translation_mode = 'minimax_first' or translation_mode is null;
