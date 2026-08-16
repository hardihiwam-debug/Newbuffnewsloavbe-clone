-- Phase-1 hardening (from the architectural review):
--   1. Publish idempotency: unique (dedup_key, chat_id) + status column on
--      published_history so a crash between "Telegram delivered" and
--      "database written" can never cause a duplicate send on the next cycle.
--      The pipeline inserts a 'sending' reservation BEFORE sendPost, then
--      flips it to 'sent'; 'sending' rows are invisible to the dedup snapshot
--      so a crashed send is retried, and a completed send is protected by the
--      unique index.
--   2. Channel fetch health: consecutive_failures column on sources (the
--      existing consecutive_rejects tracks article REJECTIONS, not fetch
--      failures). The pipeline records last_success_at / last_error /
--      consecutive_failures per Telegram channel and can auto-pause a channel
--      after source_auto_pause_threshold consecutive fetch failures.
--   3. ai_usage: unique (day, provider, kind) so the pipeline can upsert
--      usage counters cleanly (the old index was non-unique, so merge-
--      duplicates could not target it).
--   4. Translation chain: flip the live settings row to MiniMax-first so the
--      exhausted Gemini keys are only a fallback (0001 seeded 'gemini_first').

-- ── 1. Publish idempotency ─────────────────────────────────────────────────
alter table public.published_history
  add column if not exists status text not null default 'sent'
    check (status in ('sending', 'sent'));

-- Existing rows may already contain (dedup_key, chat_id) duplicates from
-- before delete-after-post existed; dedupe before creating the unique index
-- or the migration would fail on the first duplicate pair.
delete from public.published_history a
using public.published_history b
where a.id > b.id
  and a.dedup_key = b.dedup_key
  and a.chat_id = b.chat_id;

create unique index if not exists published_history_dedup_chat_key
  on public.published_history (dedup_key, chat_id);

-- ── 2. Channel fetch health ────────────────────────────────────────────────
alter table public.sources
  add column if not exists consecutive_failures double precision not null default 0;

-- ── 3. ai_usage upsert target ──────────────────────────────────────────────
delete from public.ai_usage a
using public.ai_usage b
where a.id > b.id
  and a.day = b.day
  and a.provider = b.provider
  and a.kind = b.kind;

create unique index if not exists ai_usage_day_provider_kind_unique
  on public.ai_usage (day, provider, kind);

-- ── 4. MiniMax-first translation chain ─────────────────────────────────────
update public.settings
  set translation_mode = 'minimax_first'
  where translation_mode is null or translation_mode = 'gemini_first';
