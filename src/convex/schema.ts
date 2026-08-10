import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

const schema = defineSchema({
  ...authTables,

  settings: defineTable({
    defaultLanguage: v.string(),
    dayStart: v.string(),
    dayEnd: v.string(),
    dayMinMinutes: v.number(),
    dayMaxMinutes: v.number(),
    nightStart: v.string(),
    nightEnd: v.string(),
    nightMinMinutes: v.number(),
    nightMaxMinutes: v.number(),
    breakingInterruptsNight: v.boolean(),
    breakingCategories: v.array(v.string()),
    oilMoveThreshold: v.number(),
    goldMoveThreshold: v.number(),
    timezone: v.string(),
    lastPublishedAt: v.optional(v.string()),
    nextPublishAt: v.optional(v.string()),
    botPaused: v.boolean(),
    botPausedAt: v.optional(v.string()),
    botPausedReason: v.optional(v.string()),
    eventCooldownHours: v.number(),
    eventSimilarityThreshold: v.number(),
    translationMode: v.string(),
    translationModel: v.string(),
    pollsEnabled: v.optional(v.boolean()),
    pollsMaxPerHour: v.optional(v.number()),
    pollsAutoCloseMinutes: v.optional(v.number()),
    pollsCategories: v.optional(v.array(v.string())),
    pollsDefaultLanguage: v.optional(v.string()), // "ckb" | "en" | "chat"
    updatedAt: v.optional(v.string()),
  }),

  topicQueries: defineTable({
    query: v.string(),
    category: v.string(),
    enabled: v.boolean(),
    createdAt: v.string(),
  }).index("by_query", ["query"]),

  sources: defineTable({
    name: v.string(),
    kind: v.string(),
    secretRef: v.optional(v.string()),
    config: v.any(),
    priority: v.number(),
    dailyQuota: v.optional(v.number()),
    usedToday: v.number(),
    quotaDate: v.string(),
    enabled: v.boolean(),
    lastError: v.optional(v.string()),
    createdAt: v.string(),
  }).index("by_priority", ["priority"]),

  chats: defineTable({
    chatId: v.number(),
    title: v.optional(v.string()),
    username: v.optional(v.string()),
    type: v.string(),
    language: v.optional(v.string()),
    pollsEnabled: v.optional(v.boolean()),
    active: v.boolean(),
    lastSeenAt: v.string(),
    createdAt: v.string(),
  }).index("by_chatId", ["chatId"]),

  rawArticles: defineTable({
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
  }).index("by_dedupKey", ["dedupKey"]).index("by_fetchedAt", ["fetchedAt"]),

  queue: defineTable({
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
  }).index("by_status", ["status"]).index("by_createdAt", ["createdAt"]),

  publishedHistory: defineTable({
    dedupKey: v.string(),
    chatId: v.number(),
    headline: v.optional(v.string()),
    sourceName: v.optional(v.string()),
    category: v.optional(v.string()),
    breaking: v.boolean(),
    originalPublishedAt: v.optional(v.string()),
    publishedAt: v.string(),
  }).index("by_publishedAt", ["publishedAt"]),

  translationFailures: defineTable({
    dedupKey: v.optional(v.string()),
    headline: v.optional(v.string()),
    targetLanguage: v.string(),
    modelsTried: v.array(v.string()),
    detail: v.optional(v.string()),
    createdAt: v.string(),
  }).index("by_createdAt", ["createdAt"]),

  translationProviderKeys: defineTable({
    provider: v.string(),
    label: v.string(),
    apiKey: v.string(),
    model: v.string(),
    enabled: v.boolean(),
    priority: v.number(),
    cooldownUntil: v.optional(v.string()),
    consecutiveFailures: v.number(),
    lastStatus: v.optional(v.number()),
    lastError: v.optional(v.string()),
    lastUsedAt: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.optional(v.string()),
  }).index("by_provider", ["provider"]),

  polls: defineTable({
    dedupKey: v.string(),
    chatId: v.number(),
    itemHeadline: v.optional(v.string()),
    itemCategory: v.optional(v.string()),
    language: v.string(), // "ckb" | "en"
    question: v.string(),
    options: v.array(v.string()),
    telegramMessageId: v.optional(v.number()),
    closedAt: v.optional(v.string()), // ISO; if auto-close used
    totalVoterCount: v.optional(v.number()),
    mostVotedIndex: v.optional(v.number()),
    createdAt: v.string(),
  }).index("by_chatId", ["chatId"]).index("by_createdAt", ["createdAt"]).index("by_dedupKey", ["dedupKey"]),
});

export default schema;