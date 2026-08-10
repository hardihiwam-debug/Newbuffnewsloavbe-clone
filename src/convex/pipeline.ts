"use node";
import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { fetchPublisherFeeds, fetchRssSearch, fetchNewsData } from "./pipeline/fetchers";
import {
  canonicalKey,
  cleanEditorialText,
  englishGate,
  freshnessGate,
  junkGate,
  respectGate,
  sourceTrust,
  sameEvent,
  relevanceGate,
  sourceBanGate,
  isLeaderStatement,
  isEnglishText,
  hasIncompleteSummary,
} from "./pipeline/filters";
import {
  classifyBatch,
  isBreaking,
  rewriteBatch,
  translateTelegramToEnglish,
  translateToSoraniWithKeys,
  isKeyAvailable,
  geminiTranslate,
  minimaxTranslate,
  validateSorani,
  generatePoll,
  pickPollLanguage,
  type TranslationKey,
} from "./pipeline/ai";
import { sendPost, sendPoll, type OutgoingPost, type PostSource } from "./pipeline/telegram";
import {
  DEFAULT_TELEGRAM_CHANNELS,
  fetchTelegramSignals,
  isArabicOrPersian,
} from "./pipeline/telegram_channels";
import { CATEGORY_PRIORITY, type Category, type FetchedArticle } from "./pipeline/types";
import { internal } from "./_generated/api";
import { getNewdataKey } from "./secrets";

type SettingsDoc = {
  _id: string;
  defaultLanguage: string;
  dayStart: string;
  dayEnd: string;
  dayMinMinutes: number;
  dayMaxMinutes: number;
  nightStart: string;
  nightEnd: string;
  nightMinMinutes: number;
  nightMaxMinutes: number;
  breakingInterruptsNight: boolean;
  breakingCategories: string[];
  oilMoveThreshold: number;
  goldMoveThreshold: number;
  timezone: string;
  lastPublishedAt?: string;
  nextPublishAt?: string;
  botPaused: boolean;
  botPausedAt?: string;
  botPausedReason?: string;
  eventCooldownHours: number;
  eventSimilarityThreshold: number;
  translationMode: string;
  translationModel: string;
  pollsEnabled: boolean;
  pollsMaxPerHour: number;
  pollsAutoCloseMinutes: number;
  pollsCategories: string[];
  pollsDefaultLanguage: string;
};

function isPaused(settings: SettingsDoc): boolean {
  return Boolean(settings.botPaused);
}

// ── INGEST ─────────────────────────────────────────────────────────────────

export async function runIngest(ctx: any): Promise<Record<string, any>> {
  await ctx.runMutation(internal.db.ensureDefaults);
  const settings = (await ctx.runQuery(internal.db.getSettings)) as SettingsDoc | null;
  if (!settings) throw new Error("Settings not found");
  if (isPaused(settings)) {
    await ctx.runMutation(internal.db.logActivity, {
      type: "system", level: "warning", message: "Ingest skipped — bot is paused",
    });
    return { fetched: 0, queued: 0, breaking: 0, errors: ["bot paused"] };
  }

  const stats: any = {
    fetched: 0, junk: 0, disrespect: 0, offTopic: 0, stale: 0,
    duplicate: 0, queued: 0, breaking: 0, signals: 0, errors: [],
  };
  function s(key: string, val?: any) { return val !== undefined ? val : stats[key]; }

  const topics = (await ctx.runQuery(internal.db.listTopicQueries)) as Array<any>;
  const sources = ((await ctx.runQuery(internal.db.listSources)) as Array<any>)
    .slice()
    .sort((a: any, b: any) => a.priority - b.priority);

  const queries = topics
    .filter((t: any) => t.enabled)
    .map((t: any) => t.query as string);
  const collected: FetchedArticle[] = [];

  // Breaking signals from monitored Telegram channels
  const channelRows = sources.filter((s: any) => s.kind === "telegram");
  const channels = channelRows.length
    ? channelRows.map((r: any) => String(r.config?.channel ?? r.name ?? "").replace(/^@/, "")).filter(Boolean)
    : DEFAULT_TELEGRAM_CHANNELS;
  let signalTexts: string[] = [];
  try {
    const posts = (await fetchTelegramSignals(channels))
      .filter((p) => {
        if (!p.publishedAt) return true;
        const ts = Date.parse(p.publishedAt);
        return Number.isNaN(ts) || Date.now() - ts < 6 * 3_600_000;
      });
    const cleaned = posts.map((post) => cleanEditorialText(post.text));
    const foreignIndexes = cleaned
      .map((text, index) => (isArabicOrPersian(text) ? index : -1))
      .filter((index) => index >= 0);
    if (foreignIndexes.length) {
      const translated = await translateTelegramToEnglish(
        foreignIndexes.map((idx) => cleaned[idx] ?? ""),
      );
      foreignIndexes.forEach((idx, ti) => { cleaned[idx] = translated[ti] ?? cleaned[idx] ?? ""; });
    }
    const mergedPosts: Array<{ post: (typeof posts)[number]; text: string }> = [];
    for (let idx = 0; idx < posts.length; idx++) {
      const text = cleaned[idx];
      const post = posts[idx];
      if (!text || !post || !isEnglishText(text).ok) continue;
      const previous = mergedPosts.at(-1);
      const previousTime = previous?.post.publishedAt ? Date.parse(previous.post.publishedAt) : 0;
      const currentTime = post.publishedAt ? Date.parse(post.publishedAt) : 0;
      const sameBulletin = previous?.post.channel === post.channel &&
        previousTime && currentTime &&
        Math.abs(currentTime - previousTime) <= 12 * 60_000 &&
        eventSimilarityForBulletin(previous.text, text);
      if (sameBulletin && previous) {
        previous.text = `${previous.text} ${text}`.slice(0, 1800);
        if (currentTime > previousTime) previous.post = post;
      } else {
        mergedPosts.push({ post, text });
      }
    }
    signalTexts = mergedPosts.map((entry) => entry.text);
    for (const { post, text } of mergedPosts) {
      collected.push({
        provider: `Telegram/${post.channel}`,
        sourceName: `@${post.channel}`,
        url: post.url,
        title: text.slice(0, 180),
        description: text,
        imageUrl: null,
        publishedAt: post.publishedAt,
      });
    }
    stats.signals = signalTexts.length;
  } catch (err) {
    stats["errors"].push(`telegram signals: ${err instanceof Error ? err.message : String(err)}`);
  }
  const similarityThreshold = Number(settings.eventSimilarityThreshold ?? 0.52);
  const hasSignal = (text: string) => signalTexts.some((s) => sameEvent(s, text, similarityThreshold));

  // Batch queries for NewsData
  const groups: string[] = [];
  let current = "";
  for (const q of queries) {
    const candidate = current ? `${current} OR ${q}` : q;
    if (candidate.length > 95) {
      if (current) groups.push(current);
      current = q;
    } else {
      current = candidate;
    }
  }
  if (current) groups.push(current);
  const newsDataGroups = groups.slice(0, 2);

  const today = new Date().toISOString().slice(0, 10);

  for (const source of sources) {
    try {
      if (source.kind === "newsdata") {
        if (source.quotaDate !== today) {
          await ctx.runMutation(internal.db.recordSourceStats, {
            id: source._id,
            usedToday: 0,
            quotaDate: today,
            lastError: null,
          });
          source.usedToday = 0;
        }
        // Resolve the NewsData key: explicit env, table-stored secret ref, or hardcoded fallback.
        const envKey = source.secretRef ? process.env[source.secretRef] : undefined;
        const key = envKey || getNewdataKey();
        if (!key) continue;
        for (const group of newsDataGroups) {
          if (source.dailyQuota && (source.usedToday ?? 0) >= source.dailyQuota) {
            stats.errors.push("NewsData.io: daily quota reached, using free feeds");
            break;
          }
          const items = await fetchNewsData(key, group);
          source.usedToday = (source.usedToday ?? 0) + 1;
          await ctx.runMutation(internal.db.recordSourceStats, {
            id: source._id,
            usedToday: source.usedToday,
          });
          collected.push(...items);
        }
      } else if (source.kind === "rss") {
        for (const query of queries) {
          try {
            collected.push(...(await fetchRssSearch(query)));
          } catch (err) {
            stats.errors.push(`rss / ${query.slice(0, 40)}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        try {
          const topical =
            /iran|tehran|irgc|khamenei|israel|hezbollah|houthi|yemen|iraq|syria|lebanon|militia|hormuz|persian gulf|tanker|oil|gold|nuclear|uranium|enrich|iaea|sanction|trump|pentagon|centcom|us navy|missile|drone|airstrike|strike|ceasefire|nato|mossad/i;
          collected.push(
            ...(await fetchPublisherFeeds()).filter((a) => {
              const text = `${a.title} ${a.description ?? ""}`;
              return topical.test(text) || isLeaderStatement(text);
            }),
          );
        } catch { /* optional safety net */ }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push(`${source.name}: ${msg}`);
      await ctx.runMutation(internal.db.recordSourceStats, {
        id: source._id,
        lastError: msg,
      });
    }
  }

  stats["fetched"] = collected.length;

  // Gates 1, 2, 4
  const survivors: Array<{ article: FetchedArticle; key: string }> = [];
  const rejects: any[] = [];
  const seenKeys = new Set<string>();

  for (const article of collected) {
    article.title = cleanEditorialText(article.title);
    article.description = article.description ? cleanEditorialText(article.description) : null;
    const key = canonicalKey(article);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const banned = sourceBanGate(article);
    if (!banned.ok) { stats["junk"] += 1; rejects.push(rejectRow(article, key, banned.reason!)); continue; }
    const junk = junkGate(article);
    if (!junk.ok) { stats["junk"] += 1; rejects.push(rejectRow(article, key, junk.reason!)); continue; }
    const respect = respectGate(article);
    if (!respect.ok) { stats["disrespect"] += 1; rejects.push(rejectRow(article, key, respect.reason!)); continue; }
    const relevant = relevanceGate(article);
    if (!relevant.ok) { stats["offTopic"] += 1; rejects.push(rejectRow(article, key, relevant.reason!)); continue; }
    const english = englishGate(article);
    if (!english.ok) { stats["junk"] += 1; rejects.push(rejectRow(article, key, english.reason!)); continue; }
    const textForFreshness = `${article.title} ${article.description ?? ""}`;
    const fresh = freshnessGate(article,
      /\b(attack|strike|missile|drone|war|explosion|airstrike|houthi|hezbollah|irgc|centcom|hormuz|nuclear)\b/i.test(textForFreshness) ? 6 :
      /\b(analysis|explainer|commentary|opinion)\b/i.test(textForFreshness) ? 24 : 10);
    if (!fresh.ok) { stats["stale"] += 1; rejects.push(rejectRow(article, key, fresh.reason!)); continue; }
    survivors.push({ article, key });
  }

  // Dedup against known keys
  const keys = survivors.map((s) => s.key);
  const known = new Set<string>();
  for (const key of keys) {
    const existing = await ctx.runQuery(internal.db.getRawArticleByDedupKey, { dedupKey: key });
    if (existing) known.add(key);
  }
  const fresh = survivors.filter((s) => !known.has(s.key));
  stats["duplicate"] += survivors.length - fresh.length;

  // GATE 3 — classification
  let categories: Array<Category | null> = [];
  let rewritten: Array<{ headline: string; summary: string }> = [];
  if (fresh.length) {
    // Small batches: LLMs truncate JSON output on long prompts (max_tokens
    // caps), and a truncated array makes the whole batch fail the shape check.
    // 10 items keeps output well under the token cap.
    for (let offset = 0; offset < fresh.length; offset += 10) {
      const batch = fresh.slice(offset, offset + 10);
      try {
        categories.push(...await classifyBatch(
          batch.map((s) => ({ title: s.article.title, description: s.article.description })),
        ));
      } catch (err) {
        stats.errors.push(`classification: ${err instanceof Error ? err.message : String(err)}`);
        categories.push(...batch.map((s) => keywordCategory(`${s.article.title} ${s.article.description ?? ""}`)));
      }
      try {
        rewritten.push(...await rewriteBatch(
          batch.map((s) => ({ title: s.article.title, description: s.article.description, sourceName: s.article.sourceName })),
        ));
      } catch (err) {
        stats.errors.push(`rewrite: ${err instanceof Error ? err.message : String(err)}`);
        rewritten.push(...batch.map((s) => ({ headline: s.article.title, summary: s.article.description ?? "" })));
      }
    }
  }

  // Rolling dedup window from queue
  const recentQueue = (await ctx.runQuery(internal.db.listQueuedQueueItems, { take: 100 })) as Array<any>;
  const window = recentQueue.map((r: any) => ({
    title: r.headline,
    trust: sourceTrust(r.sourceName ?? "", r.url),
    key: r.dedupKey,
  }));

  for (let i = 0; i < fresh.length; i++) {
    const entry = fresh[i];
    if (!entry) continue;
    const { article, key } = entry;
    const category = categories[i] ?? null;

    if (!category) { stats["offTopic"] += 1; rejects.push(rejectRow(article, key, "off-topic")); continue; }

    const trust = sourceTrust(article.sourceName, article.url);
    const collision = window.find((w: { title: string; trust: number; key: string }) => sameEvent(w.title, article.title, similarityThreshold));
    if (collision) {
      if (trust < collision.trust) {
        // Replace: delete old queue item and continue
        const old = recentQueue.find((r: any) => r.dedupKey === collision.key);
        if (old) await ctx.runMutation(internal.db.deleteQueueItemById, { id: old._id });
      } else {
        stats["duplicate"] += 1;
        rejects.push(rejectRow(article, key, "near-duplicate of queued story", category));
        continue;
      }
    }

    let headline = article.title;
    let summary = article.description ?? "";
    if (rewritten[i]) {
      headline = rewritten[i]!.headline;
      summary = rewritten[i]!.summary;
    }
    if (hasIncompleteSummary(summary)) {
      stats["junk"] += 1;
      rejects.push(rejectRow(article, key, "incomplete or truncated summary", category));
      continue;
    }

    const recentEventWindow = new Date(Date.now() - Number(settings.eventCooldownHours ?? 72) * 3_600_000).toISOString();
    const recentHistory = (await ctx.runQuery(internal.db.listRecentPublished, { take: 200 })) as Array<any>;
    const sameEventAlreadyPublished = recentHistory
      .filter((h: any) => h.publishedAt >= recentEventWindow)
      .some((h: any) =>
        sameEvent(`${h.headline ?? ""} ${h.sourceName ?? ""}`, `${headline} ${summary}`, Number(settings.eventSimilarityThreshold ?? 0.52)),
      );
    if (sameEventAlreadyPublished) {
      stats["duplicate"] += 1;
      rejects.push(rejectRow(article, key, "duplicate event cooldown", category));
      continue;
    }

    const insertedId = await ctx.runMutation(internal.db.insertRawArticle, {
      dedupKey: key,
      provider: article.provider,
      sourceName: article.sourceName ?? undefined,
      url: article.url,
      title: article.title,
      description: article.description ?? undefined,
      imageUrl: article.imageUrl ?? undefined,
      category,
      publishedAt: article.publishedAt ? new Date(article.publishedAt).toISOString() : undefined,
      fetchedAt: new Date().toISOString(),
      rejected: false,
      payload: JSON.parse(JSON.stringify(article)),
    });

    const articleText = `${article.title} ${article.description ?? ""}`;
    const signalled = hasSignal(articleText);
    const breaking = article.provider.startsWith("Telegram/") ||
      isBreaking(category as Category, article.title, settings.breakingCategories ?? []) || signalled;
    const leaderStatement = isLeaderStatement(`${article.title} ${article.description ?? ""}`);

    const priority = CATEGORY_PRIORITY[category as Category] ?? 10;
    const ageHours = article.publishedAt
      ? Math.max(0, (Date.now() - Date.parse(article.publishedAt)) / 3_600_000)
      : 24;
    const freshness = Math.max(0, 60 - ageHours * 5);

    const sinceHour = new Date(Date.now() - 3_600_000).toISOString();
    const postedThisHour = recentHistory.filter(
      (h: any) => h.category === category && h.publishedAt >= sinceHour,
    ).length;
    const quotaPenalty = -(postedThisHour ?? 0) * 12;

    const lastOfCategory = recentHistory.filter((h: any) => h.category === category).slice(0, 1);
    const starvedHours = lastOfCategory.length
      ? (Date.now() - Date.parse(lastOfCategory[0]!.publishedAt)) / 3_600_000
      : 99;
    const rotationBonus = starvedHours >= 2 ? 15 : 0;

    const breakingBonus = breaking ? 42 : 0;
    const leaderBonus = leaderStatement ? 120 : 0;

    let sourcePenalty = 0;
    if (article.sourceName) {
      const fromSource = recentHistory.filter(
        (h: any) => h.sourceName === article.sourceName && h.publishedAt >= new Date(Date.now() - 3 * 3_600_000).toISOString(),
      ).length;
      sourcePenalty = -(fromSource ?? 0) * 20;
    }

    const total = priority + freshness + quotaPenalty + rotationBonus + breakingBonus + leaderBonus + sourcePenalty;
    await ctx.runMutation(internal.db.insertQueueItem, {
      dedupKey: key,
      articleId: insertedId,
      headline,
      summary,
      category,
      sourceName: article.sourceName ?? hostname(article.url),
      url: article.url,
      imageUrl: article.imageUrl ?? undefined,
      originalPublishedAt: article.publishedAt ? new Date(article.publishedAt).toISOString() : undefined,
      score: total + (signalled ? 150 : 0),
      scoreParts: { priority, freshness, quotaPenalty, rotationBonus, breakingBonus, leaderBonus, sourcePenalty, signalBonus: signalled ? 150 : 0 },
      breaking,
      status: "queued",
      createdAt: new Date().toISOString(),
    });

    stats["queued"] += 1;
    if (breaking) {
      stats["breaking"] += 1;
      await ctx.runMutation(internal.db.logActivity, {
        type: "breaking",
        level: "warning",
        message: `Breaking: ${headline.slice(0, 140)}`,
        detail: `${category} · ${article.sourceName ?? hostname(article.url)}`,
      });
    }
    window.unshift({ title: headline, trust, key });
  }

  if (rejects.length) {
    for (const row of rejects) {
      const existing = await ctx.runQuery(internal.db.getRawArticleByDedupKey, { dedupKey: row.dedupKey });
      if (!existing) {
        await ctx.runMutation(internal.db.insertRawArticle, row);
      }
    }
  }

  // Prune old data
  await ctx.runMutation(internal.db.pruneOldData);

  // Activity log
  await ctx.runMutation(internal.db.logActivity, {
    type: "ingest",
    level: stats["queued"] > 0 ? "success" : "info",
    message: `Ingest cycle: ${stats["fetched"]} fetched, ${stats["queued"]} queued, ${stats["breaking"]} breaking, ${stats["signals"]} telegram signals`,
    detail: stats["errors"].length
      ? `Errors: ${(stats["errors"] as string[]).slice(0, 3).join(" | ")}`
      : undefined,
  });
  for (const err of stats["errors"] as string[]) {
    await ctx.runMutation(internal.db.logActivity, {
      type: "ingest",
      level: "warning",
      message: `Ingest error: ${String(err).slice(0, 220)}`,
    });
  }

  // Breaking news bypass
  if (stats["breaking"] > 0) {
    await ctx.runMutation(internal.db.logActivity, {
      type: "breaking", level: "success", message: `${stats["breaking"]} breaking item(s) — scheduling instant publish`,
    });
    await ctx.scheduler.runAfter(0, internal.pipeline.publish, { breakingOnly: true });
  }

  return stats;
}

function eventSimilarityForBulletin(a: string, b: string): boolean {
  const speaker = /\b(khamenei|pezeshkian|qalibaf|araghchi|velayati|barzani|sudani|trump|vance|rubio|hegseth|irgc|foreign minister|oil minister|prime minister|president)\b/i;
  const left = a.match(speaker)?.[0]?.toLowerCase();
  const right = b.match(speaker)?.[0]?.toLowerCase();
  return Boolean(left && right && left === right) || sameEvent(a, b, 0.45);
}

function keywordCategory(text: string): Category | null {
  const t = text.toLowerCase();
  if (/\biraq|baghdad|basra|mosul|kurdistan region|erbil|sulaymaniyah|iraqi\b/.test(t)) return "iraq";
  if (/\bmiddle east eye\b/.test(t) && /analysis|explainer|opinion|why |how /.test(t)) return "analysis";
  const iranRelated = /iran|tehran|irgc|khamenei|persian gulf|hormuz|hezbollah|houthi|kataib|axis of resistance/.test(t);
  if (!iranRelated) {
    if (/israel|palestin|gaza|lebanon|syria|yemen|saudi|qatar|uae|turkey/.test(t)) return "middle-east";
    return null;
  }
  if (/hezbollah|houthi|kataib|militia|hamas|axis of resistance/.test(t)) return "proxies";
  if (/strike|missile|drone|attack|airstrike|war|bomb|troops|centcom|carrier|explosion/.test(t)) return "war";
  if (/oil|crude|opec|tanker|hormuz|refinery|barrel/.test(t)) return "oil";
  if (/gold|bullion/.test(t)) return "gold";
  if (/sanction|inflation|market|economy|export/.test(t)) return "economic-impact";
  if (/trump|pentagon|washington|white house|congress|u\.s\.|united states/.test(t)) return "usa";
  return "iran";
}

function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Unknown source"; }
}

function rejectRow(article: FetchedArticle, key: string, reason: string, category?: string) {
  return {
    dedupKey: key,
    provider: article.provider,
    sourceName: article.sourceName ?? undefined,
    url: article.url,
    title: article.title,
    description: article.description ?? undefined,
    imageUrl: article.imageUrl ?? undefined,
    category: category ?? undefined,
    publishedAt: article.publishedAt ? safeDate(article.publishedAt) : undefined,
    fetchedAt: new Date().toISOString(),
    rejected: true,
    rejectReason: reason,
    payload: JSON.parse(JSON.stringify(article)),
  };
}

function safeDate(value: string): string | undefined {
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

// ── PUBLISH ────────────────────────────────────────────────────────────────

function minutesOfDay(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone,
  }).format(d);
  const [h, m] = parts.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function parseTime(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function inWindow(now: number, start: number, end: number): boolean {
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

function isNight(settings: SettingsDoc, at = new Date()): boolean {
  const now = minutesOfDay(at, settings.timezone ?? "Asia/Baghdad");
  return inWindow(now, parseTime(settings.nightStart), parseTime(settings.nightEnd));
}

function randomGapMinutes(settings: SettingsDoc, night: boolean): number {
  const min = night ? settings.nightMinMinutes : settings.dayMinMinutes;
  const max = night ? settings.nightMaxMinutes : settings.dayMaxMinutes;
  return Math.round(min + Math.random() * Math.max(0, max - min));
}

export async function runPublish(
  ctx: any,
  opts: { breakingOnly?: boolean; force?: number } = {},
): Promise<Record<string, any>> {
  const settings = (await ctx.runQuery(internal.db.getSettings)) as SettingsDoc | null;
  if (!settings) throw new Error("Settings not found");
  if (isPaused(settings)) {
    await ctx.runMutation(internal.db.logActivity, {
      type: "system", level: "warning", message: "Publish skipped — bot is paused",
    });
    return { sent: 0, chats: 0, skipped: "bot paused", items: [] };
  }

  const night = isNight(settings);
  const result: any = { sent: 0, chats: 0, skipped: "", items: [] };

  if (!opts.force && !opts.breakingOnly) {
    const next = settings.nextPublishAt ? Date.parse(settings.nextPublishAt) : 0;
    if (next && Date.now() < next) {
      result["skipped"] = "waiting for next scheduled slot";
      await ctx.runMutation(internal.db.logActivity, {
        type: "publish", level: "info", message: "Publish cycle skipped — waiting for next scheduled slot",
      });
      return result;
    }
  }
  if (opts.breakingOnly && night && !settings.breakingInterruptsNight) {
    result["skipped"] = "night quiet window; breaking interrupts disabled";
    await ctx.runMutation(internal.db.logActivity, {
      type: "publish", level: "info", message: "Breaking publish skipped — night quiet window",
    });
    return result;
  }

  // Reserve next slot
  if (!opts.force && !opts.breakingOnly) {
    const gap = randomGapMinutes(settings, night);
    const reservedUntil = new Date(Date.now() + gap * 60_000).toISOString();
    const currentSettings = (await ctx.runQuery(internal.db.getSettings)) as SettingsDoc | null;
    if (currentSettings && (!currentSettings.nextPublishAt || currentSettings.nextPublishAt <= new Date().toISOString())) {
      await ctx.runMutation(internal.db.setNextPublishAt, {
        id: currentSettings._id,
        nextPublishAt: reservedUntil,
      });
    } else {
      result["skipped"] = "another publisher reserved this scheduled slot";
      return result;
    }
  }

  // Expire old items
  const shelfLife = new Date(Date.now() - 14 * 3_600_000).toISOString();
  const oldItems = (await ctx.runQuery(internal.db.listAllQueuedQueueItems)) as Array<any>;
  for (const item of oldItems) {
    if (item.originalPublishedAt && item.originalPublishedAt < shelfLife) {
      await ctx.runMutation(internal.db.setSingleQueueStatus, {
        id: item._id,
        status: "expired",
      });
    }
  }

  // Pull candidate pool
  const pool = (await ctx.runQuery(internal.db.listQueuedQueueItems, { take: 500 })) as Array<any>;

  let candidates = pool;
  if (opts.breakingOnly) candidates = candidates.filter((q: any) => q.breaking);
  candidates.sort((a, b) => {
    if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });
  const limit = opts.force ?? 1;
  const shortlist = candidates.slice(0, Math.max(limit * 8, 24));

  // Event clustering
  const clusters: Array<{ lead: any; members: any[] }> = [];
  const claimed = new Set<string>();
  for (const candidate of shortlist) {
    if (claimed.has(candidate._id)) continue;
    claimed.add(candidate._id);
    const members = [candidate];
    for (const other of shortlist) {
      if (claimed.has(other._id) || members.length >= 4) continue;
      if (sameEvent(`${candidate.headline} ${candidate.summary}`, `${other.headline} ${other.summary}`, Number(settings.eventSimilarityThreshold ?? 0.52))) {
        claimed.add(other._id);
        members.push(other);
      }
    }
    members.sort(
      (a: any, b: any) =>
        sourceTrust(a.sourceName ?? "", a.url) - sourceTrust(b.sourceName ?? "", b.url) ||
        (b.summary?.length ?? 0) - (a.summary?.length ?? 0),
    );
    clusters.push({ lead: members[0]!, members });
    if (clusters.length >= limit) break;
  }

  const items = clusters.map((c) => ({ ...c.lead, _members: c.members }));
  if (!items.length) {
    result["skipped"] = "queue empty";
    await ctx.runMutation(internal.db.logActivity, {
      type: "publish", level: "info", message: "Publish cycle skipped — queue is empty",
    });
    return result;
  }

  const chats = (await ctx.runQuery(internal.db.listAllChats)) as Array<any>;
  const activeChats = chats.filter((c: any) => c.active);
  result["chats"] = activeChats.length;

  const cooldownHours = Number(settings.eventCooldownHours ?? 72);
  const cooldownStart = new Date(Date.now() - cooldownHours * 3_600_000).toISOString();

  const recentPublished = (await ctx.runQuery(internal.db.listRecentPublished, { take: 200 })) as Array<any>;
  const publishedTitles: string[] = recentPublished.map((r: any) => r.headline).filter(Boolean);
  const publishedKeys = new Set(recentPublished.map((r: any) => r.dedupKey));
  const sentToChat = new Set(recentPublished.map((r: any) => `${r.dedupKey}:${r.chatId}`));

  // Load translation keys once (map _id to id for the AI pipeline)
  const rawKeys = await ctx.runQuery(internal.db.getTranslationKeys);
  const translationKeys = (rawKeys as any[]).map((k: any) => ({ ...k, id: k._id }));
  const translationMode = (settings.translationMode ?? "gemini_first") as "gemini_first" | "minimax_first" | "both";

  for (const item of items as any[]) {
    const memberIds = (item._members ?? [item]).map((m: any) => m._id);
    const claimedIds = await ctx.runMutation(internal.db.claimQueueItems, { ids: memberIds });
    if (claimedIds.length !== memberIds.length) {
      if (claimedIds.length) await ctx.runMutation(internal.db.releaseQueueItems, { ids: claimedIds });
      continue;
    }

    // Editorial guard
    const asArticle: FetchedArticle = {
      provider: "queue",
      sourceName: item.sourceName ?? null,
      url: item.url,
      title: item.headline,
      description: item.summary,
      imageUrl: item.imageUrl ?? null,
      publishedAt: item.originalPublishedAt ?? null,
    };
    if (!sourceBanGate(asArticle).ok || !respectGate(asArticle).ok || !relevanceGate(asArticle).ok) {
      await ctx.runMutation(internal.db.setQueueStatus, { ids: memberIds, status: "rejected-policy" });
      continue;
    }

    const repeated = publishedKeys.has(item.dedupKey) ||
      publishedTitles.some((t) => sameEvent(t, item.headline, Number(settings.eventSimilarityThreshold ?? 0.52)));
    if (repeated) {
      await ctx.runMutation(internal.db.setQueueStatus, { ids: memberIds, status: "duplicate" });
      continue;
    }

    const translationCache = new Map<string, { headline: string; summary: string } | null>();

    let sentThisItem = 0;
    for (const chat of activeChats as any[]) {
      if (sentToChat.has(`${item.dedupKey}:${chat.chatId}`)) continue;

      const language = chat.language ?? settings.defaultLanguage ?? "en";
      let headline = item.headline;
      let summary = item.summary;

      if (language === "ckb") {
        if (!translationCache.has("ckb")) {
          const translated = await translateToSoraniWithKeys(
            `${headline}\n\n${summary}`,
            translationKeys as TranslationKey[],
            translationMode,
            settings.translationModel || undefined,
          );
          if (translated.text) {
            const [h, ...rest] = translated.text.split("\n\n");
            translationCache.set("ckb", {
              headline: h ?? headline,
              summary: rest.join("\n\n") || summary,
            });
          } else {
            // Translation failed — cache null so we fall through to English
            // instead of retrying on every chat. The news still gets delivered.
            translationCache.set("ckb", null);
            await ctx.runMutation(internal.db.logTranslationFailure, {
              dedupKey: item.dedupKey,
              headline: item.headline,
              targetLanguage: "ckb",
              modelsTried: translated.modelsTried,
              detail: translated.detail,
              createdAt: new Date().toISOString(),
            });
            await ctx.runMutation(internal.db.logActivity, {
              type: "translation",
              level: "error",
              message: `Sorani translation failed: ${item.headline.slice(0, 110)}`,
              detail: `${(translated.modelsTried ?? []).join(", ")} — ${translated.detail ?? ""}`.slice(0, 280),
            });
          }
        }
        const cached = translationCache.get("ckb");
        if (cached) {
          headline = cached.headline;
          summary = cached.summary;
        }
        // When translation failed (cached is null), keep the English
        // headline/summary — better to send English than nothing.
      }

      if (language !== "ckb" && !isEnglishText(`${headline} ${summary}`).ok) {
        await ctx.runMutation(internal.db.setQueueStatus, { ids: memberIds, status: "rejected-language" });
        continue;
      }

      const extraSources: PostSource[] = (item._members ?? []).slice(1).map((m: any) => ({
        name: m.sourceName || hostname(m.url),
        url: m.url,
      }));

      const post: OutgoingPost = {
        headline,
        summary,
        sourceName: item.sourceName || hostname(item.url),
        url: item.url,
        imageUrl: item.imageUrl ?? null,
        originalPublishedAt: item.originalPublishedAt ?? null,
        breaking: item.breaking,
        category: item.category,
        timezone: settings.timezone ?? "Asia/Baghdad",
        extraSources,
      };

      try {
        await sendPost(Number(chat.chatId), post);
        await ctx.runMutation(internal.db.insertPublishedHistory, {
          dedupKey: item.dedupKey,
          chatId: chat.chatId,
          headline,
          sourceName: post.sourceName,
          category: item.category,
          breaking: item.breaking,
          originalPublishedAt: item.originalPublishedAt ?? undefined,
          publishedAt: new Date().toISOString(),
        });
        result["sent"] += 1;
        sentThisItem += 1;
        publishedTitles.unshift(item.headline);
        publishedKeys.add(item.dedupKey);
        sentToChat.add(`${item.dedupKey}:${chat.chatId}`);

        // Optional follow-up: Telegram poll on breaking items.
        // Gated by global setting + per-chat override + category + hourly cap.
        try {
          if (
            item.breaking &&
            settings.pollsEnabled !== false &&
            chat.pollsEnabled !== false &&
            (settings.pollsCategories ?? []).includes(item.category)
          ) {
            const since = new Date(Date.now() - 60 * 60_000).toISOString();
            const recentCount = await ctx.runQuery(internal.db.countPollsForChatSince, {
              chatId: Number(chat.chatId),
              since,
            });
            const max = Number(settings.pollsMaxPerHour ?? 1);
            if (recentCount < max) {
              const pollLang = pickPollLanguage(
                chat.language ?? null,
                settings.defaultLanguage ?? "en",
                settings.pollsDefaultLanguage ?? "chat",
              );
              const generated = await generatePoll(
                { headline, summary, category: item.category },
                pollLang,
              );
              if (generated) {
                const openPeriod = Math.max(
                  5,
                  Math.min(
                    600,
                    Number(settings.pollsAutoCloseMinutes ?? 60) * 60,
                  ),
                );
                const messageId = await sendPoll(
                  Number(chat.chatId),
                  generated.question,
                  generated.options,
                  { openPeriodSec: openPeriod, isAnonymous: true },
                );
                await ctx.runMutation(internal.db.insertPoll, {
                  dedupKey: `${item.dedupKey}:${chat.chatId}`,
                  chatId: Number(chat.chatId),
                  itemHeadline: item.headline,
                  itemCategory: item.category,
                  language: pollLang,
                  question: generated.question,
                  options: generated.options,
                  telegramMessageId: messageId,
                  closedAt:
                    openPeriod >= 5 && openPeriod <= 600
                      ? new Date(Date.now() + openPeriod * 1000).toISOString()
                      : undefined,
                  createdAt: new Date().toISOString(),
                });
                await ctx.runMutation(internal.db.logActivity, {
                  type: "poll",
                  level: "info",
                  message: `Poll sent: ${generated.question.slice(0, 110)}`,
                  detail: `chat ${chat.chatId} · ${pollLang}`,
                  chatId: Number(chat.chatId),
                });
              }
            }
          }
        } catch (pollErr) {
          if (!Array.isArray(result["errors"])) result["errors"] = [];
          (result["errors"] as string[]).push(
            `poll: ${pollErr instanceof Error ? pollErr.message : String(pollErr)}`,
          );
        }

        await new Promise((r) => setTimeout(r, 3_000));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/chat not found|bot was kicked|blocked/i.test(msg)) {
          await ctx.runMutation(internal.db.deactivateChat, { id: chat._id });
          await ctx.runMutation(internal.db.logActivity, {
            type: "chat",
            level: "warning",
            message: `Chat ${chat.chatId} deactivated — bot kicked, blocked, or chat not found`,
          });
        }
      }
    }

    await ctx.runMutation(internal.db.setQueueStatus, {
      ids: memberIds,
      status: sentThisItem > 0 ? "published" : "queued",
    });
    for (const m of (item._members ?? []) as any[]) {
      publishedTitles.unshift(m.headline);
      publishedKeys.add(m.dedupKey);
    }
    result["items"].push(
      memberIds.length > 1 ? `${item.headline} (+${memberIds.length - 1} sources)` : item.headline,
    );
    if (sentThisItem > 0) {
      await ctx.runMutation(internal.db.logActivity, {
        type: "publish",
        level: "success",
        message: `Published: ${item.headline.slice(0, 140)}`,
        detail: `${sentThisItem} chat(s) · ${item.category}${item.breaking ? " · breaking" : ""}`,
      });
    }
  }

  if (!opts.breakingOnly) {
    const settingsDoc = (await ctx.runQuery(internal.db.getSettings)) as SettingsDoc | null;
    if (settingsDoc) {
      await ctx.runMutation(internal.db.patchSettingsLastPublishedAt, {
        id: settingsDoc._id,
        lastPublishedAt: new Date().toISOString(),
      });
    }
  }

  return result;
}

// ── Internal actions (callable by crons & dashboard) ──────────────────────

export const ingest = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, any>> => {
    return await runIngest(ctx);
  },
});

export const publish = internalAction({
  args: { breakingOnly: v.optional(v.boolean()), force: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Record<string, any>> => {
    return await runPublish(ctx, {
      breakingOnly: args.breakingOnly ?? false,
      ...(args.force !== undefined ? { force: args.force } : {}),
    });
  },
});

export const runPipelineNow = action({
  args: { action: v.string() },
  handler: async (ctx, args): Promise<{ result: Record<string, any> }> => {
    let result: Record<string, any>;
    if (args.action === "ingest") result = (await ctx.runAction(internal.pipeline.ingest, {})) as Record<string, any>;
    else result = (await ctx.runAction(internal.pipeline.publish, { force: 3 })) as Record<string, any>;
    return { result };
  },
});
