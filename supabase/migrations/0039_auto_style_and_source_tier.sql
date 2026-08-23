-- 0039: make Auto assist a first-class global writing-style selection.
-- The pipeline still resolves `auto` to a concrete prompt style before calling
-- an AI provider, so this is a settings/UI mode, not a model style.

alter table public.settings
  drop constraint if exists settings_text_style_check;

alter table public.settings
  add constraint settings_text_style_check
  check (text_style in ('auto', 'current', 'professional', 'conversational', 'casual', 'explainer', 'simple'));

-- Preserve the behavior of existing rows that were using the old separate
-- boolean auto policy with the default professional style. Explicitly manual
-- styles with text_style_auto=false are left untouched.
update public.settings
set text_style = 'auto'
where text_style_auto is true
  and text_style = 'professional';
