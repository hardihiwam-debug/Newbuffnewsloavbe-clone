-- Egress fast-win: the admin dashboard used to fetch 2,000–5,000 rows of
-- published_history / polls / translation_failures / queue / ai_usage per
-- poll just to count them in JavaScript. These two RPCs move every aggregate
-- into Postgres and return a handful of rows instead.
--
--   dashboard_counts()      → single-row record: queued_total, 24h published
--                            (distinct stories), 24h polls, 24h translation
--                            failures, and today's AI-usage sums by provider.
--   dashboard_analytics()   → 14 daily buckets (published / breaking / polls)
--                            computed with SQL COUNT(DISTINCT …) FILTER.
--
-- Both are SECURITY INVOKER: the service role (which calls them through the
-- admin Edge Function) already bypasses RLS, and the default PUBLIC EXECUTE
-- grant cannot read the underlying tables because RLS blocks anon anyway.

create or replace function public.dashboard_counts()
returns table (
  queued_total bigint,
  published_24h bigint,
  polls_24h bigint,
  translation_fails_24h bigint,
  ai_calls bigint,
  ai_prompt_tokens bigint,
  ai_completion_tokens bigint,
  ai_by_provider jsonb
)
language sql stable as $$
  select
    (select count(*) from public.queue where status = 'queued'),
    (select count(distinct dedup_key) from public.published_history
      where published_at >= now() - interval '24 hours'),
    (select count(*) from public.polls
      where created_at >= now() - interval '24 hours'),
    (select count(*) from public.translation_failures
      where created_at >= now() - interval '24 hours'),
    (select coalesce(sum(calls), 0) from public.ai_usage
      where day >= to_char(current_date, 'YYYY-MM-DD')),
    (select coalesce(sum(prompt_tokens), 0) from public.ai_usage
      where day >= to_char(current_date, 'YYYY-MM-DD')),
    (select coalesce(sum(completion_tokens), 0) from public.ai_usage
      where day >= to_char(current_date, 'YYYY-MM-DD')),
    (
      select coalesce(
        jsonb_object_agg(
          provider,
          jsonb_build_object('calls', calls, 'promptTokens', prompt_tokens, 'completionTokens', completion_tokens)
        ),
        '{}'::jsonb
      )
      from (
        select provider,
               sum(calls)::bigint as calls,
               sum(prompt_tokens)::bigint as prompt_tokens,
               sum(completion_tokens)::bigint as completion_tokens
        from public.ai_usage
        where day >= to_char(current_date, 'YYYY-MM-DD')
        group by provider
      ) t
    )
$$;

create or replace function public.dashboard_analytics()
returns table (
  date text,
  published bigint,
  breaking bigint,
  polls bigint
)
language sql stable as $$
  select
    (current_date - gs)::text as date,
    (
      select count(distinct dedup_key)
      from public.published_history
      where published_at >= (current_date - gs)::timestamp
        and published_at < (current_date - gs + 1)::timestamp
    ),
    (
      select count(distinct dedup_key)
      from public.published_history
      where published_at >= (current_date - gs)::timestamp
        and published_at < (current_date - gs + 1)::timestamp
        and breaking
    ),
    (
      select count(*)
      from public.polls
      where created_at >= (current_date - gs)::timestamp
        and created_at < (current_date - gs + 1)::timestamp
    )
  from generate_series(13, 0, -1) as gs
$$;
