-- Telegram video handling — settings toggle + queue discriminator.
-- The toggle chooses how we resolve a Telegram video's actual MP4 URL when the
-- public `t.me/s/<channel>` HTML only ships a thumbnail. Default is `bot_api`
-- so fresh installs (and any existing row still on the old default) start
-- doing real video recovery on the very next ingest cycle.
--
-- Flow under the hood:
--   bot_api    → ingest sees a `video_thumb` indicator in the listing HTML,
--                drops the misleading poster thumb from the queue, then runs
--                the bot flow: forwardMessage → getFile → real
--                `https://api.telegram.org/file/bot<TOKEN>/<file_path>` URL is
--                stored as `video_url`. The publish path calls sendVideo with
--                that URL, and subscribers see a real playable video.
--   off        → the operator explicitly opted out. Telegram video posts
--                degrade to text-only with the source permalink so subscribers
--                never receive the misleading thumbnail-as-photo.
--
-- `telegram_video_staging_chat_id` is optional. When NULL the pipeline resolves
-- the bot's own user id via `getMe` and uses Saved Messages as the staging
-- destination (zero-config). Operators may pin a private channel instead.

alter table settings
  add column if not exists telegram_video_fetch_mode text not null default 'bot_api'
    check (telegram_video_fetch_mode in ('off', 'bot_api'));

alter table settings
  add column if not exists telegram_video_staging_chat_id bigint;

-- Discriminator carrying the kind of media a queue item came in with, so the
-- publish path can pick the right sendPhoto / sendVideo / sendMessage branch.
alter table queue
  add column if not exists media_kind text
    check (media_kind in ('photo', 'video_thumb') or media_kind is null);

create index if not exists queue_media_kind_idx
  on public.queue (media_kind)
  where media_kind is not null;


-- Roll out the new default: any settings row still on the old 'off'
-- value picks up 'bot_api' so the pipeline starts attempting real Telegram
-- video recovery on the next ingest cycle. Idempotent: only flips 'off'.
update public.settings set telegram_video_fetch_mode = 'bot_api' where telegram_video_fetch_mode = 'off';
