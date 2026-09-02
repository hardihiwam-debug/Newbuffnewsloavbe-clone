// Ingest: fetch → filter → extract → enqueue (runIngest + fetchTelegramArticles).
// Extracted verbatim from pipeline/index.ts (split refactor) — no behavior change.

import { CATEGORY_PRIORITY, SEVERITY_POINTS, ageLimitsFrom, areTelegramPostsRelated, categoryNeedsAi, categoryScore, categoryKeywordMatch, categoryFreshnessHours, checkNumberConsistency, dedupeSourceName, editorialJunkGate, eventSimilarity, getCategoryPolicies, getCategoryPolicy, isBreaking, isHeadlineOnlySource, isIncompleteHeadline, isLeaderStatement, isInstantTelegramPostInWindow, keywordCategory, kurdHostileGate, matchEventCluster, maxArticleAgeHours, pickKeywordTriggeredCategory, polishRewriteSummary, realDateCheckOk, relevanceGate, sameEvent, selectTextStyle, severityLevel, stripChannelFooter, stripSummaryFiller, stylePromptParts, compressTargetChars, extractiveLede, fuseHeadlineTexts, titleSimilarity, EXTRACTIVE_MAX_CHARS, EXTRACTIVE_MIN_CHARS } from "./_shared.ts";
import { ExtractedFacts, RewriteItem, aiDecideCategory, chunkRewriteItems, compressArticle, flushAiUsage, groqExtractFacts, resetRewriteProviderHealth } from "./ai.ts";
import { Article, CLOUDFLARE_RELAY_KEY, CLOUDFLARE_WORKER_URL, NEWSDATA_API_KEY, NEWSDATA_MAX_GROUPS, RSS_MAX_QUERIES, SettingsRow, TELEGRAM_FAST_LANE_POSTS, TELEGRAM_POSTS_PER_CHANNEL, TELEGRAM_SNAPSHOT_BACKOFF_MINUTES } from "./config.ts";
import { bumpSourceFailure, bumpSourceQuota, enc, getKnownRawKeys, hostname, insertQueueItem, insertRawArticle, listActiveClusters, listSources, listTopicQueries, logActivity, patchSettings, patchSourceHealth, patchSourceSnapshot, reportRunProgress, rest, trimQueueToCap } from "./db.ts";
import { ChannelPost, fetchArticleFullText, fetchGoogleNewsRss, fetchNewsData, fetchPublisherFeeds, fetchTelegramChannel, isValidStoryImage, parseTelegramPostUrl, resetGoogleDecodeBudget } from "./fetch.ts";
import { canonicalKey, cleanEditorialText, freshnessGate, hasIncompleteSummary, isEnglishText, junkGate, neutralityGate, normalizeEditorial, respectGate, sectarianGate, sourceBanGate, stripLinks, stripSourceName } from "./gates.ts";
import { fetchTelegramVideoViaBotApi, recentlyFailedVideoFetch } from "./publish.ts";

// ── Ingest ──────────────────────────────────────────────────────────────────
// Fetch enabled Telegram channels into Article rows (shared by the 5-minute
// telegram fast lane and the full ingest).
export async function fetchTelegramArticles(
  channelRows: Array<Record<string, unknown>>,
  options: { botApiVideoFetch?: "off" | "bot_api"; stagingChatId?: number | null; autoPause?: { enabled: boolean; threshold: number } | null; deadline?: number; limit?: number; maxPostAgeHours?: number; instantWindowMinutes?: number } = {},
): Promise<{ articles: Article[]; errors: string[]; botApiResolved: number; snapshotsSkipped: number }> {
  const articles: Article[] = [];
  const errors: string[] = [];
  let botApiResolved = 0;
  let snapshotsSkipped = 0;
  const boostByChannel = new Map<string, number>();
  const snapshotByChannel = new Map<string, { fp: string; nextFetchAt: number; instantWatermarkAt: number }>();
  const channels: Array<{ handle: string; rowId: string; wasFailing: boolean; instant: boolean; watermarkAt: number }> = [];
  for (const r of channelRows) {
    const cfg = (r.config as Record<string, unknown> | null) ?? {};
    const handle = String(cfg.channel ?? r.name ?? "").replace(/^@/, "");
    if (!handle) continue;
    const boost = Number(cfg.boost ?? 0) || 0;
    if (boost) boostByChannel.set(handle.toLowerCase(), boost);
    const fp = String(cfg.snapshot_fp ?? "");
    const nextFetchAt = Number(cfg.next_fetch_at ?? 0) || 0;
    const instant = boost >= 2;
    const watermarkAt = Date.parse(String(cfg.instant_watermark_at ?? ""));
    if (fp || Number.isFinite(watermarkAt)) snapshotByChannel.set(handle.toLowerCase(), { fp, nextFetchAt, instantWatermarkAt: Number.isFinite(watermarkAt) ? watermarkAt : 0 });
    channels.push({ handle, rowId: String(r.id ?? ""), wasFailing: Number(r.consecutive_failures ?? 0) > 0, instant, watermarkAt: Number.isFinite(watermarkAt) ? watermarkAt : 0 });
  }
  const autoPause = options.autoPause ?? null;
  const perChannelLimit = options.limit ?? TELEGRAM_POSTS_PER_CHANNEL;
  const instantWindowMinutes = Math.max(1, Number(options.instantWindowMinutes ?? 5) || 5);
  try {
    const posts: ChannelPost[] = [];
    // Channels are independent I/O — run them through a small worker pool so
    // N channels cost ~1 fetch time instead of N × 15s sequential (which used
    // to push a wide ingest past the function timeout and leave the publish
    // lock stuck). Each channel still keeps its own error/health handling.
    const TG_WORKERS = 4;
    let tgCursor = 0;
    const tgWorker = async () => {
      while (tgCursor < channels.length) {
        const src = channels[tgCursor++]!;
        // Egress guard: t.me/s serves a frozen snapshot; if this channel's
        // fingerprint is unchanged and we're inside its backoff window, skip
        // the download entirely.
        const snap = snapshotByChannel.get(src.handle.toLowerCase());
        if (!src.instant && snap && snap.nextFetchAt && Date.now() < snap.nextFetchAt) {
          snapshotsSkipped += 1;
          continue;
        }
        const fetchStartedAt = Date.now();
        const windowStart = src.instant
          ? Math.max(src.watermarkAt, fetchStartedAt - instantWindowMinutes * 60_000)
          : 0;
        try {
          const fetched = await fetchTelegramChannel(src.handle, perChannelLimit);
          const fetchCompletedAt = Date.now();
          const bounded = src.instant
            ? fetched.filter((post) => isInstantTelegramPostInWindow(post.publishedAt, windowStart, fetchCompletedAt))
            : fetched;
          posts.push(...bounded);
          await patchSourceHealth(src.rowId, null, 0);
          // Normal/Fast retain snapshot backoff. Instant sources advance a
          // publication-time watermark only after a successful fetch, so a
          // later run cannot revisit an older anonymous snapshot.
          const newestId = fetched.length ? Number((fetched[0]?.url ?? "").split("/").pop()) || 0 : 0;
          const fp = newestId ? `${newestId}:${fetched.length}` : "";
          if (src.instant) {
            // Advance to the completed fetch boundary, even when the channel
            // had no posts in the window. The next cycle is therefore strictly
            // newer than this fetch and cannot reopen an older snapshot.
            await patchSourceSnapshot(src.rowId, fp, fetchCompletedAt + 5 * 60_000, new Date(fetchCompletedAt).toISOString());
          } else if (fp) {
            const unchanged = fp === snap?.fp;
            await patchSourceSnapshot(src.rowId, fp, fetchCompletedAt + (unchanged ? TELEGRAM_SNAPSHOT_BACKOFF_MINUTES : 5) * 60_000);
          }
          if (src.wasFailing) {
            await logActivity("source", "success", `@${src.handle} recovered — Telegram fetch OK again`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`@${src.handle}: ${msg}`);
          const health = await bumpSourceFailure(src.rowId, msg, autoPause);
          if (health?.first) {
            await logActivity("source", "warning", `@${src.handle} Telegram fetch failed: ${msg}`);
          }
          if (health?.autoPaused) {
            await logActivity("source", "error", `@${src.handle} auto-paused after ${health.failures} consecutive fetch failures: ${msg}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(TG_WORKERS, channels.length) }, () => tgWorker()));
    // Build candidate articles first (no side effects) so the Bot-API video
    // resolution can be gated on "have we already ingested this post?". A
    // fresh video post stays inside the 6h freshness window for ~72 cycles,
    // and re-running forwardMessage + getFile every cycle wastes 3 Telegram
    // API calls per post (plus an activity_log row) for nothing. raw_articles
    // already stores each post's canonical key as dedup memory, so check it
    // before resolving.
    type Candidate = {
      article: Article;
      key: string;
      resolveVideo: boolean;
      handle: string;
      pid: number;
    };
    const candidates: Candidate[] = [];
    for (const post of posts) {
      // Fast-lane freshness: drop channel posts older than the operator's
      // limit (settings.telegram_max_age_hours, default 6h — the original
      // hardcoded value).
      const tgMaxAgeHours = Math.max(1, Number(options.maxPostAgeHours ?? 6) || 6);
      if (post.publishedAt && Date.now() - Date.parse(post.publishedAt) > tgMaxAgeHours * 3_600_000) continue;
      // Strip the channel's own footer ("@handle سەرچاوە کەناڵ #تێگ", trailing
      // hashtags, self-mention) BEFORE it becomes title/description — otherwise
      // it gets translated into the Sorani body and then captured as the title.
      const text = stripChannelFooter(cleanEditorialText(post.text), `@${post.channel}`);
      // Instant channels (per-source speed = "Instant", boost >= 2) may post
      // in any language (e.g. Arabic). Drop the English-only gate for them —
      // the Kurdish translation at publish handles the text. Normal/Fast
      // channels keep the English requirement.
      const chBoost = boostByChannel.get(post.channel.toLowerCase()) ?? 0;
      if (chBoost < 2 && !isEnglishText(text).ok) continue;
      const article: Article = {
        provider: `Telegram/${post.channel}`,
        sourceName: `@${post.channel}`,
        url: post.url,
        title: text.slice(0, 180),
        description: text,
        // For video_thumb posts the listing HTML only ships the JPEG poster
        // frame. Carrying it as `imageUrl` would cascade into a `sendPhoto`
        // (still-image of a video) at publish time, which is the original
        // migration bug. Suppress it here; a real video URL is resolved later
        // either by Bot API (if enabled) or by the per-post page re-fetch.
        imageUrl: post.mediaKind === "video_thumb" ? null : (post.imageUrl ?? null),
        videoUrl: post.videoUrl ?? null,
        publishedAt: post.publishedAt,
        sourceText: post.text,
        mediaKind: post.mediaKind ?? null,
        boost: boostByChannel.get(post.channel.toLowerCase()) ?? 0,
      };
      const key = await canonicalKey(article);
      let resolveVideo = false;
      let handle = "";
      let pid = 0;
      // Optional Bot API path: forwards the source message into a staging
      // chat owned by the bot, then resolves the real .mp4 file_path so the
      // publish path can call sendVideo on actual video bytes (not the JPEG
      // poster frame extracted from the listing HTML).
      if (
        options.botApiVideoFetch === "bot_api" &&
        post.mediaKind === "video_thumb" &&
        !post.videoUrl &&
        /^https?:\/\/t\.me\/[^/]+\/\d+/.test(post.url)
      ) {
        const parsed = parseTelegramPostUrl(post.url);
        if (parsed) {
          resolveVideo = true;
          handle = parsed.channel;
          pid = Number(parsed.postId);
        }
      }
      candidates.push({ article, key, resolveVideo, handle, pid });
    }

    // Instant bursts covering one person/location/event are one Telegram
    // update for readers. Merge only within the newly fetched set, preserving
    // each source sentence verbatim and keeping the newest post as the link.
    const mergedCandidates: Candidate[] = [];
    for (const candidate of candidates) {
      const existing = mergedCandidates.find((prior) => {
        if (Number(prior.article.boost ?? 0) < 2 || Number(candidate.article.boost ?? 0) < 2) return false;
        return areTelegramPostsRelated(
          `${prior.article.title} ${prior.article.description ?? ""}`,
          `${candidate.article.title} ${candidate.article.description ?? ""}`,
        );
      });
      if (!existing) {
        mergedCandidates.push(candidate);
        continue;
      }
      const left = String(existing.article.description ?? "").trim();
      const right = String(candidate.article.description ?? "").trim();
      const parts = new Set([left, right].filter(Boolean));
      existing.article.description = [...parts].join("\n\n");
      existing.article.sourceText = [...new Set([String(existing.article.sourceText ?? "").trim(), String(candidate.article.sourceText ?? "").trim()].filter(Boolean))].join("\n\n");
      const existingAt = existing.article.publishedAt ? Date.parse(existing.article.publishedAt) : NaN;
      const candidateAt = candidate.article.publishedAt ? Date.parse(candidate.article.publishedAt) : NaN;
      if (Number.isFinite(candidateAt) && (!Number.isFinite(existingAt) || candidateAt >= existingAt)) {
        // The merged item represents the newest report. Keep its permalink and
        // media metadata so readers open the latest post and newer video
        // recovery is not lost when an older related post was seen first.
        existing.article.url = candidate.article.url;
        existing.article.publishedAt = candidate.article.publishedAt;
        existing.article.imageUrl = candidate.article.imageUrl ?? existing.article.imageUrl;
        existing.article.videoUrl = candidate.article.videoUrl ?? existing.article.videoUrl;
        existing.article.mediaKind = candidate.article.mediaKind ?? existing.article.mediaKind;
        if (candidate.resolveVideo) {
          existing.resolveVideo = true;
          existing.handle = candidate.handle;
          existing.pid = candidate.pid;
        }
      }
      existing.key = await canonicalKey(existing.article);
    }

    const knownKeys = await getKnownRawKeys(mergedCandidates.map((c) => c.key));
    // Video recovery is the only sequential Telegram work left in ingest
    // (forwardMessage + getFile per post). Cap it per cycle and stop once
    // the time budget is spent so it can never kill the worker again.
    const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
    const MAX_VIDEO_RESOLUTIONS = 3;
    let videoResolutions = 0;
    for (const c of mergedCandidates) {
      if (
        c.resolveVideo &&
        videoResolutions < MAX_VIDEO_RESOLUTIONS &&
        Date.now() < deadline &&
        !knownKeys.has(c.key) &&
        // Skip posts we already failed to resolve in the last 24h so a dead
        // embed/video isn't hammered with forwardMessage every 5 minutes.
        !(await recentlyFailedVideoFetch(c.handle, c.pid))
      ) {
        const resolved = await fetchTelegramVideoViaBotApi(c.handle, c.pid, options.stagingChatId ?? null);
        if (resolved) {
          c.article.videoUrl = resolved.fileUrl;
          videoResolutions += 1;
          botApiResolved += 1;
        }
      }
      articles.push(c.article);
    }
  } catch (err) {
    errors.push(`telegram signals: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { articles, errors, botApiResolved, snapshotsSkipped };
}

export async function runIngest(settings: SettingsRow, mode: "all" | "telegram" = "all", opts: { deadline?: number; reportProgress?: boolean } = {}): Promise<Record<string, unknown>> {
  // Hard time budget (set by runCycle): stop starting new phases once the
  // budget is spent so the cycle returns and releases the publish lock
  // instead of being killed by the worker limit mid-write.
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const budgetLeft = () => Date.now() < deadline;
  // Live progress reporting (manual "Fetch now" only — the cron cycle never
  // passes reportProgress, so its ~12 writes/minute stay off the wire).
  // StartedAt is captured ONCE so the dashboard's elapsed-time readout is
  // stable across writes; every patch reuses it.
  const progressStartedAt = new Date().toISOString();
  const report = (patch: Record<string, unknown>) => {
    if (!opts.reportProgress) return;
    // ETA from observed throughput: (elapsed / done) × remaining. Computed
    // server-side and folded into the message so the dashboard widget shows
    // "how long more" without any frontend math.
    const item = Number(patch.item ?? 0);
    const total = Number(patch.total ?? 0);
    let message = String(patch.message ?? "");
    if (item > 0 && total > item) {
      const elapsedSec = Math.max(0, (Date.now() - Date.parse(progressStartedAt)) / 1000);
      const etaSec = Math.round((elapsedSec / item) * (total - item));
      if (etaSec >= 5) {
        message += ` · ~${etaSec >= 60 ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : `${etaSec}s`} left`;
      }
    }
    void reportRunProgress(String(settings.id), {
      action: "ingest",
      startedAt: progressStartedAt,
      at: new Date().toISOString(),
      done: false,
      ...patch,
      message,
    });
  };
  const stats: Record<string, unknown> = { fetched: 0, junk: 0, offTopic: 0, stale: 0, duplicate: 0, reReports: 0, extractionFails: 0, updates: 0, queued: 0, breakingQueued: 0, errors: [] as string[] };
  // Egress offload wiring status (diagnostic): "cloudflare" when the Worker
  // env is present, "direct" when unset (relayViaWorker falls back silently).
  stats.relayMode = CLOUDFLARE_WORKER_URL && CLOUDFLARE_RELAY_KEY ? "cloudflare" : "direct";
  const errors = stats.errors as string[];

  const topics = await listTopicQueries();
  const sources = await listSources();
  const queries = topics.filter((t) => t.enabled).map((t) => t.query);

  const collected: Article[] = [];

  // Telegram channels (breaking signals) — always fetched.
  const channelRows =
    settings.fetch_telegram_enabled === false
      ? []
      : sources.filter((s) => s.kind === "telegram" && s.enabled !== false);
  // Honour the operator's Telegram video-fetch toggle. "bot_api" runs the
  // forwardMessage + getFile chain for video_thumb posts so sendVideo posts
  // the real .mp4 instead of a still image. "off" leaves post.videoUrl null
  // for those posts, which downstream renders as a clean text-only message.
  const ageLimits = ageLimitsFrom(settings);
  const tgVideoMode = (settings.telegram_video_fetch_mode as string | undefined) ?? "off";
  const tgStagingChatId = Number((settings.telegram_video_staging_chat_id as number | string | null) ?? 0) || null;
  const tg = await fetchTelegramArticles(channelRows, {
    botApiVideoFetch: tgVideoMode === "bot_api" ? "bot_api" : "off",
    stagingChatId: tgStagingChatId,
    maxPostAgeHours: Math.max(1, Number(settings.telegram_max_age_hours ?? 6) || 6),
    autoPause: {
      enabled: settings.source_auto_pause_enabled !== false,
      threshold: Math.max(1, Number(settings.source_auto_pause_threshold ?? 8)),
    },
    deadline,
    limit: mode === "telegram" ? TELEGRAM_FAST_LANE_POSTS : TELEGRAM_POSTS_PER_CHANNEL,
  });
  collected.push(...tg.articles);
  errors.push(...tg.errors);
  if (tg.botApiResolved > 0) {
    await logActivity(
      "telegram_video",
      "success",
      `Bot API recovered ${tg.botApiResolved} real Telegram video URL${tg.botApiResolved === 1 ? "" : "s"} this cycle`,
    );
  }

  // Web sources
  const newsdataRow = sources.find((s) => s.kind === "newsdata");
  if (mode === "all" && budgetLeft() && settings.fetch_newsdata_enabled !== false && newsdataRow && NEWSDATA_API_KEY && queries.length) {
    const groups: string[] = [];
    let current = "";
    for (const q of queries) {
      const candidate = current ? `${current} OR ${q}` : q;
      if (candidate.length > 95) {
        if (current) groups.push(current);
        current = q;
      } else current = candidate;
    }
    if (current) groups.push(current);
    // Respect the provider's own daily cap (free tier = 200 requests/day):
    // fetch only as many groups as the remaining quota allows, and skip
    // entirely once spent (used_today rolls over at midnight via
    // bumpSourceQuota). This avoids burning calls on a quota that is gone.
    const dailyQuota = Math.max(1, Number(newsdataRow.daily_quota ?? 200));
    const usedToday = Number(newsdataRow.used_today ?? 0);
    const quotaSameDay = String(newsdataRow.quota_date ?? "") === new Date().toISOString().slice(0, 10);
    const remaining = dailyQuota - (quotaSameDay ? usedToday : 0);
    const groupBudget = Math.min(NEWSDATA_MAX_GROUPS, Math.max(0, remaining));
    // All groups fire concurrently — sequential NewsData calls (each with a
    // 20s timeout) could alone blow past the function's compute budget.
    let newsdataCalls = 0;
    const newsdataResults = await Promise.all(
      groups.slice(0, groupBudget).map(async (group) => {
        try {
          const articles = await fetchNewsData(NEWSDATA_API_KEY, group);
          newsdataCalls += 1;
          return articles;
        } catch (err) {
          errors.push(`newsdata: ${err instanceof Error ? err.message : String(err)}`);
          return [] as Article[];
        }
      }),
    );
    for (const r of newsdataResults) collected.push(...r);
    await bumpSourceQuota(String(newsdataRow.id ?? ""), newsdataCalls);
  }
  if (mode === "all" && budgetLeft() && sources.some((s) => s.kind === "rss")) {
    // RSS queries are I/O-bound and fetch concurrently; sequential would add
    // up to 12 × 20s worst case to every ingest cycle.
    if (settings.fetch_google_news_enabled !== false) {
      const rssResults = await Promise.all(
        queries.slice(0, RSS_MAX_QUERIES).map(async (query) => {
          try {
            return await fetchGoogleNewsRss(query);
          } catch (err) {
            errors.push(`rss / ${query.slice(0, 40)}: ${err instanceof Error ? err.message : String(err)}`);
            return [] as Article[];
          }
        }),
      );
      for (const r of rssResults) collected.push(...r);
    }
    try {
      const topical = /iran|tehran|irgc|khamenei|israel|hezbollah|houthi|yemen|iraq|syria|lebanon|militia|hormuz|persian gulf|tanker|oil|gold|bullion|natural gas|lng|petrochemical|nuclear|uranium|enrich|iaea|sanction|trump|pentagon|centcom|us navy|missile|drone|airstrike|strike|ceasefire|nato|mossad|gaza|west bank|palestin|kurd|jordan|egypt|amman|cairo/i;
      if (settings.fetch_publisher_feeds_enabled !== false && budgetLeft()) collected.push(...(await fetchPublisherFeeds()).filter((a) => topical.test(`${a.title} ${a.description ?? ""}`) || isLeaderStatement(`${a.title} ${a.description ?? ""}`)));
    } catch {
      /* optional */
    }
  }

  stats.fetched = collected.length;
  report({ message: `Fetched ${collected.length} article${collected.length === 1 ? "" : "s"} — classifying…`, item: 0, total: collected.length || 1 });

  // Per-cycle source breakdown so operators can see at a glance whether
  // NewsData is exhausted, RSS is failing, or publisher feeds came back
  // empty — instead of just "0 queued" with no visibility into why.
  const byProvider = new Map<string, number>();
  for (const a of collected) byProvider.set(a.provider, (byProvider.get(a.provider) ?? 0) + 1);
  const sourceBreakdown = [...byProvider.entries()].map(([p, n]) => `${p}:${n}`).join(", ");
  if (sourceBreakdown) await logActivity("ingest", "info", `Source breakdown: ${sourceBreakdown}`);

  // Gates
  const survivors: Array<{ article: Article; key: string }> = [];
  const seen = new Set<string>();
  for (const article of collected) {
    article.title = cleanEditorialText(article.title);
    article.description = article.description ? cleanEditorialText(article.description) : null;
    const key = await canonicalKey(article);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!sourceBanGate(article).ok) { stats.junk = Number(stats.junk) + 1; continue; }
    if (!junkGate(article).ok) { stats.junk = Number(stats.junk) + 1; continue; }
    if (!respectGate(article).ok) { stats.junk = Number(stats.junk) + 1; continue; }
    if (!sectarianGate(article.title, article.description).ok) { stats.junk = Number(stats.junk) + 1; stats.sectarian = Number(stats.sectarian ?? 0) + 1; continue; }
    if (!neutralityGate(article.title, article.description).ok) { stats.junk = Number(stats.junk) + 1; stats.neutrality = Number(stats.neutrality ?? 0) + 1; continue; }
    if (!editorialJunkGate(article.title, article.description).ok) { stats.junk = Number(stats.junk) + 1; stats.editorialJunk = Number(stats.editorialJunk ?? 0) + 1; continue; }
    if (!kurdHostileGate(article.title, article.description).ok) { stats.junk = Number(stats.junk) + 1; stats.kurdHostile = Number(stats.kurdHostile ?? 0) + 1; continue; }
    // Instant channels (boost >= 2) may post in Arabic etc. The relevance
    // (beat) gate and the English gate are English-pattern gates, so they
    // only apply to normal/fast sources; instant posts flow straight through
    // to the queue + Kurdish translation.
    const instantSrc = Number(article.boost ?? 0) >= 2;
    if (!instantSrc && !relevanceGate(article.title, article.description).ok) { stats.offTopic = Number(stats.offTopic) + 1; continue; }
    if (!instantSrc && !isEnglishText(`${article.title} ${article.description ?? ""}`).ok) { stats.junk = Number(stats.junk) + 1; continue; }
    const textForFreshness = `${article.title} ${article.description ?? ""}`;
    // Operator-customizable limits (Settings → Scheduler → Freshness limits);
    // defaults preserve the original hardcoded 14/22/48h values.
    const maxAge = maxArticleAgeHours(textForFreshness, ageLimits);
    if (!freshnessGate(article, maxAge).ok) { stats.stale = Number(stats.stale) + 1; continue; }
    survivors.push({ article, key });
  }

  // Dedup vs raw_articles
  const known = await getKnownRawKeys(survivors.map((s) => s.key));
  let fresh = survivors.filter((s) => !known.has(s.key));
  stats.duplicate = survivors.length - fresh.length;

  // Pre-queue in-cycle dedup: check fresh items against each other so multiple
  // outlets publishing the exact same story in the same 15m window don't all get queued.
  const uniqueFresh: typeof fresh = [];
  // Precomputed concatenated text per accepted item — rebuilding title+body
  // strings inside the comparison loop made this O(n²) over multi-KB enriched
  // bodies (seconds added to heavy cycles).
  const acceptedTexts: string[] = [];
  const inCycleThreshold = Number(settings.event_similarity_threshold ?? 0.52);
  for (const item of fresh) {
    const rawText = `${item.article.title} ${item.article.description ?? ""}`;
    const isDupe = acceptedTexts.some((uText) => {
      // Use the same event detection logic the cluster/publish paths use
      return sameEvent(uText, rawText, inCycleThreshold) || eventSimilarity(uText, rawText) >= inCycleThreshold;
    });
    if (!isDupe) {
      uniqueFresh.push(item);
      acceptedTexts.push(rawText);
    } else {
      stats.duplicate = Number(stats.duplicate) + 1;
    }
  }
  fresh = uniqueFresh;
  report({ message: `${fresh.length} article${fresh.length === 1 ? "" : "s"} cleared the gates — rewriting…`, item: 0, total: fresh.length || 1 });

  // Enrich EVERY gated web article with its full body — NO fixed per-cycle
  // cap, and no thin-snippet filter: the rewrite model gets the complete
  // article (up to the fetch cap) so summaries carry mechanism/reason/
  // consequence instead of paraphrasing a 2-line RSS description. Bounded by
  // a time window (35s) plus the cycle deadline, and the 4-worker pool, so a
  // big batch of slow/paywalled pages can't blow the ingest budget or starve
  // the rewrite phase that follows. Items whose page can't be fetched keep
  // their feed description as the source text.
  //
  // The SAME page fetch also yields the article's REAL published date. Feeds
  // re-stamp old stories with crawl timestamps (Google News / NewsData /
  // aggregators), so the feed pubDate that passed freshnessGate above is not
  // trustworthy. When the page's own date is outside the freshness window,
  // the item is dropped HERE — before it burns a Groq rewrite call or fills
  // the queue — and the verified date replaces the feed date so scoring and
  // breaking recency use the truth.
  const staleKeys = new Set<string>();
  if (budgetLeft() && settings.enrich_summaries !== false) {
    const targets = fresh.filter((s) => !s.article.provider.startsWith("Telegram/"));
    const enrichDeadline = Math.min(deadline, Date.now() + 35_000);
    let cursor = 0;
    const worker = async () => {
      while (Date.now() < enrichDeadline && cursor < targets.length) {
        const entry = targets[cursor++]!;
        const full = await fetchArticleFullText(entry.article.url);
        if (full?.text && full.text.length > (entry.article.description ?? "").trim().length) entry.article.description = full.text;
        if (full?.imageUrl && !entry.article.imageUrl && isValidStoryImage(full.imageUrl)) {
          entry.article.imageUrl = full.imageUrl;
        }
        if (full?.publishedTime) {
          entry.article.publishedAt = full.publishedTime;
          const check = realDateCheckOk(full.publishedTime, `${entry.article.title} ${entry.article.description ?? ""}`, Date.now(), ageLimits);
          if (!check.ok) {
            staleKeys.add(entry.key);
            stats.stale = Number(stats.stale) + 1;
            await logActivity("ingest", "info", `Real article date ${Math.round(check.ageHours)}h old (> ${check.maxAge}h) — dropped before queue: ${entry.article.title.slice(0, 110)}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
    // Items never claimed before the window closed keep their thin RSS
    // description and will be rewritten from it — the old thin-summary
    // failure mode. Surface that honestly instead of degrading silently.
    const deferred = targets.length - Math.min(cursor, targets.length);
    if (deferred > 0) {
      await logActivity("ingest", "warning", `Full-text window closed with ${deferred} article(s) unfetched — those items rewrite from feed text only`);
    }
  }

  // Phase 2: event identity + material-update detection BEFORE any Groq call.
  //   - items matching an active cluster (same category) are follow-ups;
  //   - a follow-up whose text is essentially the same facts again (event
  //     similarity >= update_material_threshold) is a RE-REPORT: dropped here
  //     so it never burns a Groq call or fills the queue;
  //   - a follow-up with materially new information becomes an "UPDATE —"
  //     item (is_update) tied to the cluster's event_id, so the publish path
  //     can post it as an update of the already-published story instead of a
  //     separate news item.
  const clusters = await listActiveClusters(48);
  const clusterThreshold = Number(settings.event_similarity_threshold ?? 0.52);
  const reReportThreshold = Number(settings.update_material_threshold ?? 0.7);
  const clusterWrites = new Map<string, { event_id: string; label: string; category: string; last_source_text: string }>();
  const followUp = new Map<number, { eventId: string; label: string }>();
  const droppedIdx = new Set<number>();
  const extractionIdx: number[] = [];
  const toExtract: RewriteItem[] = [];
  // Summary-source routing state: items that bypass the two-stage rewrite.
  const directExtracted = new Map<number, ExtractedFacts>();
  const directMeta = new Map<number, { provider: string | null; model: string | null }>();
  const tierDirect = new Set<number>(); // echo-guard exempt: kept-source pairs legitimately agree
  const toCompress: Array<{ idx: number; title: string; description: string; target: number }> = [];
  const extractiveOn = settings.extractive_lede !== false;
  const compressOn = settings.ai_compress !== false;
  const styleByCategory = settings.style_by_category;
  const styleRules = settings.text_style_rules;
  const rewriteItemFor = (article: Article, category: string): RewriteItem => {
    const style = selectTextStyle({
      defaultStyle: settings.text_style,
      auto: settings.text_style_auto,
      byCategory: styleByCategory,
      category,
      text: `${article.title} ${article.description ?? ""}`,
    });
    const parts = stylePromptParts(style, styleRules);
    return {
      title: article.title,
      description: article.description,
      style,
      length: settings.text_length,
      styleRule: parts.rule,
      styleExample: parts.example,
      aiStyleAssist: settings.text_style_ai_assist === true,
    };
  };
  for (let i = 0; i < fresh.length; i++) {
    const item = fresh[i]!;
    const rawText = `${item.article.title} ${item.article.description ?? ""}`;
    const category = keywordCategory(rawText);
    if (!category) continue;
    const matched = matchEventCluster(rawText, category, clusters, clusterThreshold);
    if (matched) {
      const cluster = clusters.find((c) => String(c.event_id) === matched.eventId);
      const lastText = String(cluster?.last_source_text ?? "");
      const reReport = lastText.length > 0 && eventSimilarity(lastText, rawText) >= reReportThreshold;
      if (reReport) {
        stats.reReports = Number(stats.reReports) + 1;
        droppedIdx.add(i);
        continue;
      }
      followUp.set(i, { eventId: matched.eventId, label: matched.label });
    }
    if (item.article.provider.startsWith("Telegram/")) continue;
    // A title-only feed result is not evidence for an AI-generated report,
    // so it never goes through the rewrite. It is dropped at queue time (see
    // the contentless-source guard below) — publishing it produced the
    // duplicated "title — outlet" posts visible in the channel.
    if (isHeadlineOnlySource(item.article.title, item.article.description, item.article.sourceName ?? "")) {
      // #2 Cross-source headline fusion: the same thin-wire event often
      // arrives from 2-3 outlets in one cycle. Fuse their titles/snippets
      // into a synthetic body (fetched material only — nothing invented) so
      // extraction can produce a real brief; otherwise drop as before.
      const siblings = fresh
        .filter((o, j) =>
          j !== i &&
          dedupeSourceName(String(o.article.sourceName ?? "")) !== dedupeSourceName(String(item.article.sourceName ?? "")) &&
          (titleSimilarity(o.article.title, item.article.title) >= 0.45 ||
            eventSimilarity(`${o.article.title} ${o.article.description ?? ""}`, rawText) >= 0.55))
        .slice(0, 3)
        .map((o) => ({ title: o.article.title, description: o.article.description }));
      const fused = fuseHeadlineTexts(item.article.title, siblings);
      if (!fused) continue;
      item.article.description = fused;
      stats.headlineFusion = Number(stats.headlineFusion ?? 0) + 1;
      await logActivity("ingest", "info", `Headline-fusion rescue (${siblings.length} sibling source${siblings.length === 1 ? "" : "s"}): ${item.article.title.slice(0, 90)}`);
    }
    if (toExtract.length >= 60) continue;
    // #4 Breaking stories rewrite SOLO: one item per LLM call so the model's
    // full attention is on the story that matters most. The same isBreaking
    // gate as queue time, evaluated early with the article's own timestamp.
    const earlyAgeHours = item.article.publishedAt ? Math.max(0, (Date.now() - Date.parse(item.article.publishedAt)) / 3_600_000) : 24;
    const earlySolo = isBreaking(
      category,
      rawText,
      (settings.breaking_categories as string[] | undefined) ?? ["war", "iran", "proxies", "usa", "gaza", "syria", "lebanon"],
      earlyAgeHours,
      Math.max(1, Number(settings.breaking_max_age_hours ?? 8)),
    );

    // ── Summary-source routing ────────────────────────────────────────────
    // Tier 1 (extractive_lede): a short REAL body (240–800 chars) already
    // carries a professional lede — keep the source headline and ship the
    // body's own first sentences verbatim. Zero AI calls.
    const bodyLen = (item.article.description ?? "").trim().length;
    if (extractiveOn && !earlySolo && bodyLen >= EXTRACTIVE_MIN_CHARS && bodyLen <= EXTRACTIVE_MAX_CHARS) {
      const lede = extractiveLede(item.article.description!);
      if (lede) {
        directExtracted.set(i, { headline: item.article.title, summary: lede, facts: { confidence: "high", note: "extractive-lede", key_facts: [] } });
        directMeta.set(i, { provider: null, model: "extractive-lede" });
        tierDirect.add(i);
        stats.extractiveLede = Number(stats.extractiveLede ?? 0) + 1;
        continue;
      }
    }
    // Tier 3 (ai_compress): longer bodies skip extract→compose and get one
    // cheap compression call instead ("keep every fact, shrink the text").
    if (compressOn && !earlySolo && bodyLen > EXTRACTIVE_MAX_CHARS) {
      toCompress.push({ idx: i, title: item.article.title, description: item.article.description!, target: compressTargetChars(settings.text_length) });
      continue;
    }
    extractionIdx.push(i);
    const ri = rewriteItemFor(item.article, category);
    if (earlySolo) {
      ri.solo = true;
    }
    toExtract.push(ri);
  }
  // Tier 3 execution: compression runs first (cheap single calls) so any
  // failure still falls back into the normal two-stage rewrite below.
  const COMPRESS_PER_CYCLE = 6;
  let compressed = 0;
  for (const c of toCompress) {
    if (compressed >= COMPRESS_PER_CYCLE || Date.now() > deadline - 30_000) {
      // No budget left → full rewrite path like everyone else.
      extractionIdx.push(c.idx);
      toExtract.push(rewriteItemFor(fresh[c.idx]!.article, keywordCategory(`${fresh[c.idx]!.article.title} ${fresh[c.idx]!.article.description ?? ""}`) ?? "iran"));
      continue;
    }
    const res = await compressArticle(c.title, c.description, c.target, Math.min(deadline, Date.now() + 15_000));
    if (res) {
      directExtracted.set(c.idx, res);
      directMeta.set(c.idx, { provider: null, model: "ai-compress" });
      tierDirect.add(c.idx);
      stats.aiCompressed = Number(stats.aiCompressed ?? 0) + 1;
      compressed += 1;
    } else {
      extractionIdx.push(c.idx);
      toExtract.push(rewriteItemFor(fresh[c.idx]!.article, keywordCategory(`${fresh[c.idx]!.article.title} ${fresh[c.idx]!.article.description ?? ""}`) ?? "iran"));
    }
  }

  // Chunk the rewrite by BOTH item count and total source characters (see
  // chunkRewriteItems): with full article bodies a fixed batch-of-5 could be
  // 60k chars of input — slow free-tier calls and diluted model attention.
  const toExtractChunks = chunkRewriteItems(toExtract);
  // Hard wall-time cap on the whole rewrite phase: the LLM provider chain
  // could previously eat the entire ingest budget and the cycle was killed
  // mid-rewrite, leaving the publish lock stuck for minutes. The cap is 95s
  // (near the 100s cycle budget, still safely under the 150s worker limit):
  // a Mistral-carried batch runs ~10-12s per 5-item chunk, so the old 60s cap
  // guaranteed the tail of any 6+ chunk batch starved — the exact failure
  // seen at 15:46 UTC (6 ok chunks in 44s, then mistral: Signal timed out at
  // the 8s floor, then 2 more chunks with no provider attempted). Combined
  // with the 15s per-attempt floor in groqExtractFacts (Mistral's real
  // latency is 8-12s), the whole batch now fits in one cycle.
  // Fresh provider-health state per cycle: a Cloudflare 429 from yesterday's
  // exhausted neurons (or any other hard failure) must not carry into the next
  // ingest — only the current cycle's failures mark providers dead.
  resetRewriteProviderHealth();
  resetGoogleDecodeBudget();
  // AI-assisted category budget: only ambiguous items (categoryNeedsAi) ask
  // the model, capped per cycle so free-tier quotas and the cycle deadline are
  // never blown. Each call is bounded to 10s by aiDecideCategory's own signal.
  const AI_CATEGORY_PER_CYCLE = 4;
  let aiCategoryBudget = AI_CATEGORY_PER_CYCLE;
  const rewriteDeadline = Math.min(deadline, Date.now() + 95_000);
  // No fixed batch cap: every chunk gets a turn. The wall-clock gate below
  // (rewriteGate = deadline − 15s) is the honest limiter — chunks that cannot
  // start with a full attempt left are deferred with a distinct log line
  // instead of being silently starved.
  const rewriteChunks = toExtractChunks;
  // Run the rewrite chunks sequentially (worker = 1) so concurrent LLM calls
  // don't trigger 429 rate-limit bursts on Groq/Cloudflare/Gemini free tiers.
  const chunkResults: Array<{ items: Array<ExtractedFacts | null>; provider: string | null; model: string | null }> = new Array(rewriteChunks.length);
  const GROQ_WORKERS = 1;
  let chunkCursor = 0;
  // A chunk never STARTS once it cannot get a full attempt (15s): stopping on
  // the margin means the tail is deliberately deferred, not starved mid-call.
  const rewriteGate = rewriteDeadline - 15_000;
  let chunksDone = 0;
  const chunkWorker = async () => {
    while (Date.now() < rewriteGate && chunkCursor < rewriteChunks.length) {
      const i = chunkCursor++;
      chunkResults[i] = await groqExtractFacts(rewriteChunks[i]!, rewriteDeadline);
      chunksDone += 1;
      if (chunksDone % 2 === 0 || chunksDone === rewriteChunks.length) {
        report({ message: `Rewriting ${chunksDone}/${rewriteChunks.length} batch${rewriteChunks.length === 1 ? "" : "es"}…`, item: chunksDone, total: rewriteChunks.length });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GROQ_WORKERS, rewriteChunks.length) }, () => chunkWorker()));
  const deferredByGate = rewriteChunks.length - chunkCursor;
  if (deferredByGate > 0) {
    await logActivity(
      "ingest",
      "warning",
      `Rewrite window closed early — ${deferredByGate} chunk(s) deferred to source-text fallback (${Math.max(0, Math.round((rewriteDeadline - Date.now()) / 1000))}s of budget left)`,
    );
  }
  const extractedArr: Array<ExtractedFacts | null> = [];
  const extractedMetaArr: Array<{ provider: string | null; model: string | null }> = [];
  for (const r of chunkResults) {
    extractedArr.push(...(r?.items ?? []));
    extractedMetaArr.push(...(r?.items ?? []).map(() => ({ provider: r?.provider ?? null, model: r?.model ?? null })));
  }
  const extracted = new Map<number, ExtractedFacts>();
  // Rewrite provenance per item (provider/model that produced the stored
  // headline+summary) — threaded onto queue rows so Story Review can show
  // "original → rewritten, by which model".
  const extractedMeta = new Map<number, { provider: string | null; model: string | null }>();
  extractionIdx.forEach((idx, j) => {
    const ex = extractedArr[j];
    if (ex) {
      extracted.set(idx, ex);
      extractedMeta.set(idx, extractedMetaArr[j] ?? { provider: null, model: null });
    }
  });
  // Tier-routed items bypassed the chunk pipeline entirely — inject directly.
  for (const [idx, ex] of directExtracted) extracted.set(idx, ex);
  for (const [idx, meta] of directMeta) extractedMeta.set(idx, meta);

  for (let i = 0; i < fresh.length; i++) {
    if (!budgetLeft()) break;
    if (droppedIdx.has(i)) continue;
    if (opts.reportProgress && (i % 5 === 0 || i === fresh.length - 1)) {
      report({ message: `Queueing ${Math.min(i + 1, fresh.length)}/${fresh.length}…`, item: Math.min(i + 1, fresh.length), total: fresh.length });
    }
    const { article, key } = fresh[i]!;
    // Verified stale against the article page's own date (see enrichment).
    if (staleKeys.has(key)) continue;
    const articleText = `${article.title} ${article.description ?? ""}`;
    const articleBoost = Number(article.boost ?? 0) || 0;
    const instantSrc = articleBoost >= 2;
    const catPolicies = getCategoryPolicies(settings.category_policy);
    let category = keywordCategory(articleText);
    // Keyword-as-trigger classification: if the built-in classifier found
    // nothing, a category whose REQUIRED keyword list matches the text
    // becomes a valid candidate (excluded keywords still veto; disabled
    // categories never trigger; highest-scoring match wins). This is what
    // makes the Settings keyword lists create classifications instead of
    // only filtering them — e.g. "nuclear" on the iran policy rescues a
    // nuclear story the regex classifier would otherwise drop as off-topic.
    let keywordTriggered = false;
    if (!category) {
      const triggered = pickKeywordTriggeredCategory(catPolicies, articleText);
      if (triggered) {
        category = triggered;
        keywordTriggered = true;
        await logActivity("ingest", "info", `Keyword-triggered category: "${article.title.slice(0, 60)}" → ${triggered}`);
      }
    }
    // AI-assisted category: when the keyword classifier is ambiguous (0
    // keyword matches — normally dropped/defaulted — or a single generic
    // bucket), ask the model once. Budgeted + time-bounded; a null answer
    // falls through to the existing keyword/fallback behavior untouched. A
    // keyword-triggered classification is a deterministic answer, so it
    // never spends an AI call.
    if (aiCategoryBudget > 0 && !keywordTriggered && categoryNeedsAi(articleText) && budgetLeft()) {
      const prev = category;
      const aiCat = await aiDecideCategory(articleText, String(settings.ai_dedup_provider ?? "groq"));
      if (aiCat) {
        aiCategoryBudget -= 1;
        if (aiCat !== prev) {
          category = aiCat;
          await logActivity("ingest", "info", `AI category: "${article.title.slice(0, 60)}" → ${aiCat}${prev ? ` (was ${prev})` : " (rescued from off-topic)"}`);
        }
      }
    }
    // Arabic/foreign instant posts won't match the English category keywords;
    // default them to "war" (operator-chosen conflict-news channels) so they
    // are scored/published instead of dropped as off-topic.
    if (!category) {
      if (instantSrc) category = "war";
      else { stats.offTopic = Number(stats.offTopic) + 1; continue; }
    }
    // ── Category policy gates ──────────────────────────────────────────────
    const catPolicy = getCategoryPolicy(catPolicies, category);
    // Disabled categories are silently skipped; review-only items are
    // still queued but will need manual approval before publishing.
    if (catPolicy.status === "disabled") {
      stats.offTopic = Number(stats.offTopic) + 1;
      continue;
    }
    // Keyword / excluded-keyword gate: an excluded keyword always
    // disqualifies the category; a required keyword must appear — except for
    // instant sources, which are non-English Telegram posts defaulted to
    // "war" with no English keyword match (exclusions still veto them).
    const kwMatch = categoryKeywordMatch(catPolicies, category, articleText, { skipRequired: instantSrc });
    if (!kwMatch.ok) {
      stats.offTopic = Number(stats.offTopic) + 1;
      continue;
    }
    let headline = article.title;
    let summary = article.description ?? "";
    // Contentless-source guard: enrichment already tried to fetch the full
    // article body. If the description is STILL just the headline repeated
    // (or missing), there is no article content to report — the Kitco ticker
    // page and the ABC school-attack post both published this way. Drop it.
    // Telegram posts are exempt: a short post IS the whole report (title is
    // just the first 180 chars of the same text, so it always "matches").
    if (!article.provider.startsWith("Telegram/") && isHeadlineOnlySource(article.title, article.description, article.sourceName ?? "")) {
      stats.headlineOnly = Number(stats.headlineOnly ?? 0) + 1;
      await logActivity("ingest", "info", `Headline-only source (no article body) — dropped: ${article.title.slice(0, 110)}`);
      continue;
    }
    let facts: Record<string, unknown> | null = null;
    // Rewrite provenance: which provider/model produced the stored
    // headline+summary (null when the rewrite was skipped or rejected, so
    // Story Review can tell a real rewrite from a source-text fallback).
    let rewriteMeta: { provider: string | null; model: string | null } = { provider: null, model: null };
    if (!article.provider.startsWith("Telegram/")) {
      const ex = extracted.get(i);
      if (ex) {
        // Phase-2 fact-consistency guard: if the extraction changed or
        // invented a figure (12 killed → 15 killed, or a missile count the
        // source never gave), fall back to the SOURCE text — never publish a
        // hallucinated number.
        const consistency = checkNumberConsistency(articleText, `${ex.headline} ${ex.summary}`);
        if (!consistency.ok) {
          await logActivity("ingest", "warning", `Fact guard — ${consistency.mismatches.slice(0, 2).join("; ")}: falling back to source text for ${article.title.slice(0, 90)}`);
          stats.extractionFails = Number(stats.extractionFails ?? 0) + 1;
        } else {
          headline = ex.headline;
          summary = ex.summary;
          facts = ex.facts;
          rewriteMeta = extractedMeta.get(i) ?? { provider: null, model: null };
        }
      }
    }
    // Deterministic summary backstop: strip filler openers ("A report states
    // that…") and catch the "just reworded the headline" class — a rewrite
    // that adds no information never ships as the post body. When the rewrite
    // was a reword but the (enriched) source text has a real body, fall back
    // to the source's first sentence; when nothing exists beyond the headline,
    // drop the item. Telegram posts are exempt: their text IS the report and
    // the title is a slice of the same body.
    if (tierDirect.has(i)) {
      // Kept-source headline + verbatim/compressed lede: headline↔summary
      // agreement is normal journalism here, not an AI echo. Filler cleanup
      // only — the drop-guards must not punish the operator's chosen style.
      summary = stripSummaryFiller(summary) || summary;
    } else if (!article.provider.startsWith("Telegram/")) {
      const polished = polishRewriteSummary(summary, headline, article.description);
      if (polished === null) {
        stats.junk = Number(stats.junk) + 1;
        await logActivity("ingest", "warning", `AI rewrite added nothing beyond the headline — dropped: ${headline.slice(0, 110)}`);
        continue;
      }
      summary = polished;
    }
    headline = stripSourceName(stripLinks(cleanEditorialText(normalizeEditorial(headline))), article.sourceName ?? "");
    summary = stripSourceName(stripLinks(cleanEditorialText(normalizeEditorial(summary))), article.sourceName ?? "");
    // Incomplete-summary guard only applies to English content; long Arabic
    // posts often end without ASCII sentence punctuation and would be junked.
    if (!instantSrc && hasIncompleteSummary(summary)) { stats.junk = Number(stats.junk) + 1; continue; }
    // Incomplete-headline guard: a feed-truncated <title> (dangling connector
    // or trailing dash/ellipsis) that even the rewrite could not repair is
    // not evidence for a publishable post — the truncated "…school in"
    // class ships straight into the channel title. Skip instant sources:
    // their "title" is the first 180 chars of the same post text and may end
    // mid-word by construction.
    if (!instantSrc && isIncompleteHeadline(headline)) {
      stats.junk = Number(stats.junk) + 1;
      await logActivity("ingest", "info", `Incomplete English headline (truncated feed title) — dropped: ${headline.slice(0, 110)}`);
      continue;
    }

    const boost = Number(article.boost ?? 0) || 0;
    // Per-source speed setting (the Normal/Fast/Instant dropdown on each
    // Telegram source): 0 = normal, 1 = fast (+60 score, no flag), 2 = instant
    // (+150 score AND treated as breaking so it always sorts first).
    const instant = boost >= 2;
    // Instant Telegram channels publish immediately via the 5-minute fast
    // lane (no scoring order, no window gap) and skip the queue's
    // publish-time beat gate — so run the beat gate here: only on-beat posts
    // may go out, off-beat ones are dropped and never queued.
    if (instant && isEnglishText(articleText).ok) {
      const beat = relevanceGate(articleText, "");
      if (!beat.ok) {
        stats.instantOffBeat = Number(stats.instantOffBeat ?? 0) + 1;
        continue;
      }
    }
    const ageHours = article.publishedAt ? Math.max(0, (Date.now() - Date.parse(article.publishedAt)) / 3_600_000) : 24;
    // Per-category freshness override: when the policy sets a custom window,
    // apply it here as a second gate. The first-pass gate used text-based
    // heuristics; this uses the operator's explicit per-category policy.
    const catMaxAge = categoryFreshnessHours(catPolicies, category, 0);
    if (catMaxAge > 0 && ageHours > catMaxAge) {
      stats.stale = Number(stats.stale) + 1;
      continue;
    }
    // Phase-2 breaking gate: breaking requires recency (breaking_max_age_hours)
    // — a 10-hour-old "missile" story entering the pipeline late must not
    // break. Operator-explicit instant channels still break regardless.
    const breaking = instant || isBreaking(category, articleText, (settings.breaking_categories as string[] | undefined) ?? ["war", "iran", "proxies", "usa", "gaza", "syria", "lebanon"], ageHours, Math.max(1, Number(settings.breaking_max_age_hours ?? 8)));
    const leaderStatement = isLeaderStatement(articleText);
    const severity = severityLevel(articleText);
    const priority = categoryScore(catPolicies, category, CATEGORY_PRIORITY[category] ?? 10);
    const freshness = Math.max(0, 60 - ageHours * 5);
    const boostBonus = boost === 2 ? 150 : boost === 1 ? 60 : 0;
    const score = priority + freshness + SEVERITY_POINTS[severity] + (leaderStatement ? 120 : 0) + (breaking ? 42 : 0) + boostBonus;

    // Event identity: reuse the cluster's event_id for follow-ups (phase 1),
    // and mark material follow-ups as updates (phase 2).
    const fu = followUp.get(i);
    const eventId = fu ? fu.eventId : `${category}-${new Date().toISOString().slice(0, 10)}-${key.slice(0, 12)}`;
    if (fu) {
      clusterWrites.set(fu.eventId, { event_id: fu.eventId, label: fu.label, category, last_source_text: articleText.slice(0, 1200) });
    } else {
      clusterWrites.set(eventId, { event_id: eventId, label: headline.slice(0, 300), category, last_source_text: articleText.slice(0, 1200) });
    }
    const isUpdate = Boolean(fu);

    // raw_articles is only used as dedup memory (getKnownRawKeys reads
    // dedup_key), so store the minimal row — no payload/body/media — to keep
    // the free-plan database size flat.
    // Persist the queue row first. If this fails, the article must remain
    // eligible on the next cycle; recording raw_articles first would make a
    // transient queue outage look like a permanent duplicate.
    const queued = await insertQueueItem({
      dedup_key: key,
      original_title: article.title,
      rewrite_provider: rewriteMeta.provider,
      rewrite_model: rewriteMeta.model,
      headline,
      summary,
      category,
      // dedupeSourceName: feeds sometimes store the outlet doubled
      // ("L'Orient Today L'Orient Today") — store the clean single name.
      source_name: dedupeSourceName(article.sourceName ?? hostname(article.url)),
      url: article.url,
      image_url: article.imageUrl ?? null,
      video_url: article.videoUrl ?? null,
      media_kind: article.mediaKind ?? null,
      original_published_at: article.publishedAt ? new Date(article.publishedAt).toISOString() : null,
      source_text: article.sourceText ?? `${article.title} ${article.description ?? ""}`.slice(0, 1500),
      event_id: eventId,
      facts,
      is_update: isUpdate,
      importance: breaking ? "breaking" : isUpdate ? "update" : "minor",
      score,
      score_parts: { priority, freshness, severity: SEVERITY_POINTS[severity], leader: leaderStatement ? 120 : 0, breaking: breaking ? 42 : 0, boost: boostBonus, instant },
      breaking,
      status: catPolicy.status === "review" ? "held" : "queued",
      created_at: new Date().toISOString(),
    });
    if (!queued) {
      stats.duplicate = Number(stats.duplicate) + 1;
      continue;
    }
    await insertRawArticle({
      dedup_key: key,
      provider: article.provider,
      source_name: article.sourceName ?? null,
      url: article.url,
      title: article.title,
      category,
      published_at: article.publishedAt ? new Date(article.publishedAt).toISOString() : null,
      fetched_at: new Date().toISOString(),
    });
    if (breaking) stats.breakingQueued = Number(stats.breakingQueued) + 1;
    if (isUpdate) stats.updates = Number(stats.updates) + 1;
    if (instant) stats.instantQueued = Number(stats.instantQueued ?? 0) + 1;
    stats.queued = Number(stats.queued) + 1;
  }

  // Flush cluster upserts once per cycle (one batched GET + one PATCH/POST
  // per event) so the clusters table mirrors what the queue is carrying.
  const clusterIds = [...clusterWrites.keys()];
  if (clusterIds.length > 0) {
    const existing = await rest<Array<{ id: string; event_id: string; post_count: number }>>("clusters", {
      query: `event_id=in.(${clusterIds.map(enc).join(",")})&limit=200`,
    }).catch(() => []);
    const byEvent = new Map((existing ?? []).map((r) => [String(r.event_id), r]));
    for (const c of clusterWrites.values()) {
      const row = byEvent.get(c.event_id);
      if (row?.id) {
        await rest(`clusters?id=eq.${enc(String(row.id))}`, {
          method: "PATCH",
          body: {
            post_count: Number(row.post_count ?? 1) + 1,
            last_headline: c.label,
            last_source_text: c.last_source_text,
            last_seen_at: new Date().toISOString(),
          },
          prefer: "return=minimal",
        }).catch((err) => {
          // A failed PATCH leaves the cluster stale — the next cycle's
          // matchEventCluster may then miss a follow-up and queue it as new.
          // Surface it; do not change control flow.
          void logActivity("ingest", "warning", `Cluster update failed for ${c.event_id.slice(0, 24)}: ${err instanceof Error ? err.message : String(err)}`);
        });
      } else {
        await rest("clusters", {
          method: "POST",
          body: {
            event_id: c.event_id,
            label: c.label,
            category: c.category,
            last_source_text: c.last_source_text,
            last_seen_at: new Date().toISOString(),
          },
          prefer: "return=minimal",
        }).catch((err) => {
          // A failed POST means this event has no cluster row, so follow-up
          // coverage of it cannot be detected as related until the next
          // successful cycle re-creates it.
          void logActivity("ingest", "warning", `Cluster create failed for ${c.event_id.slice(0, 24)}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  }

  const tsPatch: Record<string, unknown> = { last_telegram_signals_at: new Date().toISOString() };
  if (mode === "all") tsPatch.last_ingest_at = new Date().toISOString();
  await patchSettings(String(settings.id), tsPatch);
  const updateNote = Number(stats.updates) > 0 ? `, ${stats.updates} update${Number(stats.updates) === 1 ? "" : "s"}` : "";
  const filterBreakdown = `Junk: ${stats.junk} | OffTopic: ${stats.offTopic} | Stale: ${stats.stale} | Dup: ${stats.duplicate} | ReReports: ${stats.reReports}`;
  const detailStr = errors.length ? `Errors: ${errors.slice(0, 2).join(" | ")} | ${filterBreakdown}` : filterBreakdown;
  await logActivity("ingest", Number(stats.queued) > 0 ? "success" : "info", `Ingest cycle: ${stats.fetched} fetched, ${stats.queued} queued${updateNote}`, detailStr);
  // Enforce the max-queue cap right after items are added (the cron-cycle
  // trim at cycle start alone lets the count hover above the cap between
  // cycles whenever ingests outpace publishes). Best-effort + never throws.
  await trimQueueToCap().catch(() => {});
  await flushAiUsage();
  return stats;
}

