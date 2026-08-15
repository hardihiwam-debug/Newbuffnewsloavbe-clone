-- Iran Desk Bot — reclaim space from pre-slim raw_articles rows.
-- Before the pipeline stored dedup-only rows, it persisted the full fetched
-- article (payload jsonb + body/media columns). Dedup only ever reads
-- dedup_key, so null out the heavy columns to shrink the free-plan database.
update public.raw_articles
   set payload = null,
       description = null,
       image_url = null,
       video_url = null
 where payload is not null
    or description is not null
    or image_url is not null
    or video_url is not null;
