import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

// ── Queries ────────────────────────────────────────────────────────────────

export const findUserByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const normalized = email.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", normalized))
      .first();
    if (!user) return null;
    return { userId: String(user._id), email: normalized };
  },
});

// Pipeline reads (used by ingest/publish internalAction)
export const getSettings = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("settings").first();
  },
});

export const listTopicQueries = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("topicQueries").collect();
  },
});

export const listSources = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("sources").collect();
  },
});

export const getRawArticleByDedupKey = internalQuery({
  args: { dedupKey: v.string() },
  handler: async (ctx, { dedupKey }) => {
    return await ctx.db
      .query("rawArticles")
      .withIndex("by_dedupKey", (q) => q.eq("dedupKey", dedupKey))
      .first();
  },
});

export const listQueuedQueueItems = internalQuery({
  args: { take: v.number() },
  handler: async (ctx, { take }) => {
    return await ctx.db
      .query("queue")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .take(take);
  },
});

export const listAllQueuedQueueItems = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("queue")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .collect();
  },
});

export const listRecentPublished = internalQuery({
  args: { take: v.number() },
  handler: async (ctx, { take }) => {
    return await ctx.db
      .query("publishedHistory")
      .withIndex("by_publishedAt")
      .order("desc")
      .take(take);
  },
});

export const listAllChats = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("chats").collect();
  },
});

export const insertRawArticle = internalMutation({
  args: {
    dedupKey: v.string(),
    provider: v.string(),
    sourceName: v.optional(v.string()),
    url: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    category: v.optional(v.string()),
    publishedAt: v.optional(v.string()),
    fetchedAt: v.string(),
    rejected: v.boolean(),
    rejectReason: v.optional(v.string()),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("rawArticles", args);
  },
});

export const insertQueueItem = internalMutation({
  args: {
    dedupKey: v.string(),
    articleId: v.optional(v.string()),
    headline: v.string(),
    summary: v.string(),
    category: v.string(),
    sourceName: v.string(),
    url: v.string(),
    imageUrl: v.optional(v.string()),
    originalPublishedAt: v.optional(v.string()),
    score: v.number(),
    scoreParts: v.any(),
    breaking: v.boolean(),
    status: v.string(),
    createdAt: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("queue", args);
  },
});

export const setNextPublishAt = internalMutation({
  args: { id: v.string(), nextPublishAt: v.string() },
  handler: async (ctx, { id, nextPublishAt }) => {
    await ctx.db.patch(id as any, { nextPublishAt });
  },
});

export const patchSettingsLastPublishedAt = internalMutation({
  args: { id: v.string(), lastPublishedAt: v.string() },
  handler: async (ctx, { id, lastPublishedAt }) => {
    await ctx.db.patch(id as any, { lastPublishedAt });
  },
});

export const deleteQueueItemById = internalMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id as any);
  },
});

export const setSingleQueueStatus = internalMutation({
  args: { id: v.string(), status: v.string() },
  handler: async (ctx, { id, status }) => {
    await ctx.db.patch(id as any, { status });
  },
});

export const getBotPaused = internalQuery({
  args: {},
  handler: async (ctx) => {
    const s = await ctx.db.query("settings").first();
    return s?.botPaused ?? false;
  },
});

export const getTranslationKeys = internalQuery({
  args: {},
  handler: async (ctx) => {
    const keys = await ctx.db
      .query("translationProviderKeys")
      .withIndex("by_provider")
      .collect();
    return keys
      .filter((k) => k.enabled && (!k.cooldownUntil || Date.parse(k.cooldownUntil) <= Date.now()))
      .sort((a, b) => a.priority - b.priority);
  },
});

export const getTranslationKeyById = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id as any);
  },
});

// ── Mutations ──────────────────────────────────────────────────────────────

export const upsertChat = internalMutation({
  args: {
    chatId: v.number(),
    title: v.optional(v.string()),
    username: v.optional(v.string()),
    type: v.string(),
    active: v.boolean(),
    lastSeenAt: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        title: args.title,
        username: args.username,
        type: args.type,
        active: args.active,
        lastSeenAt: args.lastSeenAt,
      });
    } else {
      await ctx.db.insert("chats", {
        chatId: args.chatId,
        title: args.title,
        username: args.username,
        type: args.type,
        language: undefined,
        active: args.active,
        lastSeenAt: args.lastSeenAt,
        createdAt: args.lastSeenAt,
      });
    }
  },
});

export const insertPoll = internalMutation({
  args: {
    dedupKey: v.string(),
    chatId: v.number(),
    itemHeadline: v.optional(v.string()),
    itemCategory: v.optional(v.string()),
    language: v.string(),
    question: v.string(),
    options: v.array(v.string()),
    telegramMessageId: v.optional(v.number()),
    closedAt: v.optional(v.string()),
    createdAt: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("polls", args);
  },
});

export const updatePollResults = internalMutation({
  args: {
    id: v.string(),
    totalVoterCount: v.optional(v.number()),
    mostVotedIndex: v.optional(v.number()),
    closedAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.totalVoterCount !== undefined) patch.totalVoterCount = args.totalVoterCount;
    if (args.mostVotedIndex !== undefined) patch.mostVotedIndex = args.mostVotedIndex;
    if (args.closedAt !== undefined) patch.closedAt = args.closedAt;
    await ctx.db.patch(args.id as any, patch);
  },
});

export const listRecentPolls = internalQuery({
  args: { take: v.number() },
  handler: async (ctx, { take }) => {
    return await ctx.db.query("polls").withIndex("by_createdAt").order("desc").take(take);
  },
});

export const listPollsSince = internalQuery({
  args: { since: v.string() },
  handler: async (ctx, { since }) => {
    return await ctx.db
      .query("polls")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
      .collect();
  },
});

export const countPollsForChatSince = internalQuery({
  args: { chatId: v.number(), since: v.string() },
  handler: async (ctx, { chatId, since }) => {
    const rows = await ctx.db
      .query("polls")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .collect();
    return rows.filter((r) => r.createdAt >= since).length;
  },
});

export const deactivateChat = internalMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id as any, { active: false });
  },
});

export const insertPublishedHistory = internalMutation({
  args: {
    dedupKey: v.string(),
    chatId: v.number(),
    headline: v.optional(v.string()),
    sourceName: v.optional(v.string()),
    category: v.optional(v.string()),
    breaking: v.boolean(),
    originalPublishedAt: v.optional(v.string()),
    publishedAt: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("publishedHistory", args);
  },
});

export const logTranslationFailure = internalMutation({
  args: {
    dedupKey: v.optional(v.string()),
    headline: v.optional(v.string()),
    targetLanguage: v.string(),
    modelsTried: v.array(v.string()),
    detail: v.optional(v.string()),
    createdAt: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("translationFailures", args);
  },
});

export const logTranslationSuccess = internalMutation({
  args: {
    englishText: v.string(),
    kurdishText: v.string(),
    model: v.string(),
    chatId: v.optional(v.number()),
    dedupKey: v.optional(v.string()),
    createdAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("translationHistory", {
      englishText: args.englishText.slice(0, 2000),
      kurdishText: args.kurdishText.slice(0, 2000),
      model: args.model,
      chatId: args.chatId,
      dedupKey: args.dedupKey,
      createdAt: args.createdAt ?? new Date().toISOString(),
    });

    // Keep only the newest 200 entries to prevent unbounded growth.
    const newest = await ctx.db
      .query("translationHistory")
      .withIndex("by_createdAt")
      .order("desc")
      .take(201);
    if (newest.length > 200) {
      for (const doc of newest.slice(200)) {
        await ctx.db.delete(doc._id);
      }
    }
  },
});

// Unified activity log with retention: entries are auto-deleted once they're
// older than 48h, and the table is capped at the newest 500 entries so a busy
// bot can't consume unbounded database storage.
export const logActivity = internalMutation({
  args: {
    type: v.string(),
    level: v.optional(v.string()),
    message: v.string(),
    detail: v.optional(v.string()),
    chatId: v.optional(v.number()),
    createdAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const createdAt = args.createdAt ?? new Date().toISOString();
    await ctx.db.insert("activityLog", {
      type: args.type,
      level: args.level ?? "info",
      message: args.message.slice(0, 320),
      detail: args.detail ? args.detail.slice(0, 600) : undefined,
      chatId: args.chatId,
      createdAt,
    });

    // Retention 1: drop anything older than 48 hours.
    const cutoff = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const expired = await ctx.db
      .query("activityLog")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(500);
    for (const doc of expired) await ctx.db.delete(doc._id);

    // Retention 2: keep only the newest 500 entries.
    const newest = await ctx.db
      .query("activityLog")
      .withIndex("by_createdAt")
      .order("desc")
      .take(501);
    if (newest.length > 500) {
      const keep = new Set(newest.slice(0, 500).map((d) => d._id));
      for (const doc of newest.slice(500)) {
        await ctx.db.delete(doc._id);
      }
    }
  },
});

export const claimQueueItems = internalMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const claimed: string[] = [];
    for (const id of ids) {
      const doc = await ctx.db.get(id as any);
      if (doc && (doc as any).status === "queued") {
        await ctx.db.patch(id as any, { status: "publishing" });
        claimed.push(id);
      }
    }
    return claimed;
  },
});

export const releaseQueueItems = internalMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      await ctx.db.patch(id as any, { status: "queued" });
    }
  },
});

export const setQueueStatus = internalMutation({
  args: { ids: v.array(v.string()), status: v.string() },
  handler: async (ctx, { ids, status }) => {
    for (const id of ids) {
      await ctx.db.patch(id as any, { status });
    }
  },
});

export const expireOldQueue = internalMutation({
  args: { shelfLife: v.string() },
  handler: async (ctx, { shelfLife }) => {
    const items = await ctx.db
      .query("queue")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .take(500);
    const expired = items.filter(
      (i: any) => i.originalPublishedAt && i.originalPublishedAt < shelfLife,
    );
    for (const item of expired) {
      await ctx.db.patch(item._id, { status: "expired" });
    }
  },
});

export const pruneOldData = internalMutation({
  args: {},
  handler: async (ctx) => {
    const sevenDays = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const thirtyDays = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const fourteenDays = new Date(Date.now() - 14 * 86_400_000).toISOString();

    // Rejected raw articles older than 7 days
    const oldRejects = await ctx.db
      .query("rawArticles")
      .withIndex("by_fetchedAt", (q) => q.lt("fetchedAt", sevenDays))
      .filter((q) => q.eq(q.field("rejected"), true))
      .take(500);
    for (const doc of oldRejects) await ctx.db.delete(doc._id);

    // Translation failures older than 30 days
    const oldTfails = await ctx.db
      .query("translationFailures")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", thirtyDays))
      .take(500);
    for (const doc of oldTfails) await ctx.db.delete(doc._id);

    // Published history older than 14 days
    const oldHistory = await ctx.db
      .query("publishedHistory")
      .withIndex("by_publishedAt", (q) => q.lt("publishedAt", fourteenDays))
      .take(500);
    for (const doc of oldHistory) await ctx.db.delete(doc._id);
  },
});

export const recordSourceStats = internalMutation({
  args: {
    id: v.string(),
    usedToday: v.optional(v.number()),
    quotaDate: v.optional(v.string()),
    lastError: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const patch: any = {};
    if (args.usedToday !== undefined) patch.usedToday = args.usedToday;
    if (args.quotaDate !== undefined) patch.quotaDate = args.quotaDate;
    if (args.lastError !== undefined) {
      if (args.lastError === null) {
        patch.lastError = undefined;
      } else {
        patch.lastError = args.lastError;
      }
    }
    await ctx.db.patch(args.id as any, patch);
  },
});

export const ensureDefaults = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("settings").first();
    if (existing) return;

    await ctx.db.insert("settings", {
      defaultLanguage: "en",
      dayStart: "08:00",
      dayEnd: "23:00",
      dayMinMinutes: 25,
      dayMaxMinutes: 60,
      nightStart: "23:00",
      nightEnd: "08:00",
      nightMinMinutes: 90,
      nightMaxMinutes: 180,
      breakingInterruptsNight: true,
      breakingCategories: ["war", "iran", "proxies", "usa"],
      oilMoveThreshold: 3,
      goldMoveThreshold: 2,
      timezone: "Asia/Baghdad",
      eventCooldownHours: 72,
      eventSimilarityThreshold: 0.52,
      translationMode: "gemini_first",
      translationModel: "gemini-2.5-flash",
      pollsEnabled: true,
      pollsMaxPerHour: 1,
      pollsAutoCloseMinutes: 60,
      pollsCategories: ["war", "iran", "proxies", "usa"],
      pollsDefaultLanguage: "chat",
      botPaused: false,
      updatedAt: new Date().toISOString(),
    });

    const queries = [
      ["Iran United States", "usa"],
      ["Iran strike attack", "war"],
      ["Iran nuclear talks", "iran"],
      ["Hezbollah", "proxies"],
      ["Houthi Red Sea", "proxies"],
      ["Iraqi militias Iran", "proxies"],
      ["Israel Iran", "war"],
      ["oil price", "oil"],
      ["gold price", "gold"],
      ["Strait of Hormuz", "oil"],
      ["Iran Saudi Arabia relations", "iran"],
      ["Trump Iran", "usa"],
    ];
    for (const [query, category] of queries) {
      await ctx.db.insert("topicQueries", {
        query,
        category,
        enabled: true,
        createdAt: new Date().toISOString(),
      });
    }

    await ctx.db.insert("sources", {
      name: "NewsData.io",
      kind: "newsdata",
      secretRef: "NEWSDATA_API_KEY",
      config: {},
      priority: 10,
      dailyQuota: 200,
      usedToday: 0,
      quotaDate: new Date().toISOString().slice(0, 10),
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    await ctx.db.insert("sources", {
      name: "Google News RSS",
      kind: "rss",
      config: {},
      priority: 50,
      usedToday: 0,
      quotaDate: new Date().toISOString().slice(0, 10),
      enabled: true,
      createdAt: new Date().toISOString(),
    });
  },
});

export const markTranslationKeyResult = internalMutation({
  args: {
    id: v.string(),
    status: v.optional(v.number()),
    error: v.optional(v.string()),
    cooldownUntil: v.optional(v.string()),
    consecutiveFailures: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: any = {
      lastUsedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (args.status !== undefined) patch.lastStatus = args.status;
    if (args.error !== undefined) patch.lastError = args.error;
    if (args.cooldownUntil !== undefined) patch.cooldownUntil = args.cooldownUntil;
    if (args.consecutiveFailures !== undefined) patch.consecutiveFailures = args.consecutiveFailures;
    await ctx.db.patch(args.id as any, patch);
  },
});