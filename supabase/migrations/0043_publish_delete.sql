-- Support "delete a published post" from the console.
--
-- The publish path now records the Telegram message id returned by each send
-- (sendMessage / sendPhoto / sendVideo) on the published_history row, so the
-- admin's deletePublishedPost action can call Telegram deleteMessage for every
-- chat a story reached. Rows written before this migration have NULL here —
-- those posts are already gone from the retention window anyway, and the
-- delete action reports "no message id recorded" instead of failing silently.

alter table public.published_history
  add column if not exists telegram_message_id bigint;
