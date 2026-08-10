import { internalMutation } from "./_generated/server";

export const seed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("settings").first();
    if (existing) return;

    const now = new Date().toISOString();
    const today = now.slice(0, 10);

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
      updatedAt: now,
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
        createdAt: now,
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
      quotaDate: today,
      enabled: true,
      createdAt: now,
    });

    await ctx.db.insert("sources", {
      name: "Google News RSS",
      kind: "rss",
      config: {},
      priority: 50,
      usedToday: 0,
      quotaDate: today,
      enabled: true,
      createdAt: now,
    });
  },
});