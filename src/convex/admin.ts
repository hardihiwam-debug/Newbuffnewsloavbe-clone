import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { getNewdataKey, getTelegramToken } from "./secrets";
import { internal } from "./_generated/api";

const FALLBACK_OWNER_EMAILS = ["akam09890@gmail.com"];
const FALLBACK_OWNER_PIN = "200006";

function pinMatches(pin: string | undefined | null): boolean {
  if (!pin) return false;
  return pin.trim() === (process.env["ADMIN_PIN"] ?? FALLBACK_OWNER_PIN).trim();
}

// In-memory defaults mirroring db.ensureDefaults. Used so the console always
// renders even if the settings row is missing (e.g. a fresh/empty database).
const DEFAULT_SETTINGS = {
  defaultLanguage: "en",
  botPaused: false,
  botPausedReason: null,
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
  updatedAt: new Date().toISOString(),
};

async function requireAdmin(ctx: any, args: { pin?: string } = {}) {
  // PIN bypass — admins sign in with the configured PIN instead of a password.
  if (pinMatches(args.pin)) {
    return { userId: "pin-admin", email: "pin-admin@freebuff.local", isOwner: true, viaPin: true };
  }
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Unauthorized");
  const user = await ctx.db.get(userId);
  const email = (user?.email ?? "").toLowerCase().trim();
  const raw = (process.env["OWNER_EMAILS"] ?? process.env["OWNER_EMAIL"] ?? "").trim();
  const allowed = new Set(
    [
      ...raw.split(/[\s,;]+/).map((e: string) => e.trim().toLowerCase()).filter(Boolean),
      ...FALLBACK_OWNER_EMAILS.map((e) => e.toLowerCase()),
    ],
  );
  if (!allowed.has(email)) throw new Error("Forbidden: not an admin");
  return { userId, user, email, isOwner: allowed.has(email), viaPin: false };
}

const pinArg = { pin: v.optional(v.string()) };

export const getDashboard = query({
  args: pinArg,
  handler: async (ctx, args) => {
    const { isOwner } = await requireAdmin(ctx, args);
    const settingsRow = await ctx.db.query("settings").first();
    const settings = settingsRow ?? DEFAULT_SETTINGS;
    const chats = await ctx.db.query("chats").take(500);
    chats.sort((a: any, b: any) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""));
    const sources = await ctx.db.query("sources").collect();
    sources.sort((a: any, b: any) => a.priority - b.priority);
    const topics = await ctx.db.query("topicQueries").collect();
    topics.sort((a: any, b: any) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
    const queue = await ctx.db.query("queue")
      .withIndex("by_status", (q: any) => q.eq("status", "queued"))
      .take(200);
    queue.sort((a: any, b: any) => {
      if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
      return (b.score ?? 0) - (a.score ?? 0);
    });
    const history = await ctx.db.query("publishedHistory")
      .withIndex("by_publishedAt")
      .order("desc")
      .take(100);
    const tfails = await ctx.db.query("translationFailures")
      .withIndex("by_createdAt").order("desc").take(50);
    const polls = await ctx.db.query("polls")
      .withIndex("by_createdAt").order("desc").take(100);
    const recentActivity = await ctx.db.query("activityLog")
      .withIndex("by_createdAt").order("desc").take(100);
    const translationHistory = await ctx.db.query("translationHistory")
      .withIndex("by_createdAt").order("desc").take(50);
    return {
      settings, isOwner, chats, sources, topics,
      queue: queue.slice(0, 50), history,
      translationFailures: tfails,
      translationHistory,
      polls,
      recentActivity,
      botConfigured: Boolean(getTelegramToken()),
      newsdataConfigured: Boolean(getNewdataKey()),
    };
  },
});

export const saveSettings = mutation({
  args: { ...pinArg, patch: v.any() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);
    const s = await ctx.db.query("settings").first();
    if (!s) throw new Error("Settings not found");
    await ctx.db.patch(s._id, { ...args.patch, updatedAt: new Date().toISOString() });
    await ctx.runMutation(internal.db.logActivity, {
      type: "admin", level: "info", message: "Settings updated",
      detail: Object.keys(args.patch ?? {}).slice(0, 8).join(", ") || undefined,
    });
  },
});

export const updateChat = mutation({
  args: { ...pinArg, id: v.string(), active: v.optional(v.boolean()), language: v.optional(v.union(v.string(), v.null())), pollsEnabled: v.optional(v.union(v.boolean(), v.null())), remove: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);
    if (args.remove) {
      await ctx.db.delete(args.id as any);
      await ctx.runMutation(internal.db.logActivity, {
        type: "chat", level: "info", message: "Chat removed from dashboard", detail: args.id,
      });
      return;
    }
    const patch: Record<string, unknown> = {};
    if (args.active !== undefined) patch.active = args.active;
    if (args.language !== undefined) patch.language = args.language || undefined;
    if (args.pollsEnabled !== undefined) patch.pollsEnabled = args.pollsEnabled ?? undefined;
    await ctx.db.patch(args.id as any, patch);
    await ctx.runMutation(internal.db.logActivity, {
      type: "chat", level: "info", message: "Chat updated",
      detail: Object.keys(patch).map((k) => `${k}=${String(patch[k])}`).join(", ") || undefined,
    });
  },
});

export const upsertTopic = mutation({
  args: { ...pinArg, id: v.optional(v.string()), query: v.optional(v.string()), category: v.optional(v.string()), enabled: v.optional(v.boolean()), remove: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);
    if (args.remove && args.id) {
      await ctx.db.delete(args.id as any);
      await ctx.runMutation(internal.db.logActivity, {
        type: "admin", level: "info", message: `Topic removed: ${args.query ?? args.id}`,
      });
      return;
    }
    if (args.id) {
      const patch: Record<string, unknown> = {};
      if (args.enabled !== undefined) patch.enabled = args.enabled;
      if (args.query) patch.query = args.query;
      if (args.category) patch.category = args.category;
      await ctx.db.patch(args.id as any, patch);
      await ctx.runMutation(internal.db.logActivity, {
        type: "admin", level: "info",
        message: args.enabled !== undefined
          ? `Topic ${args.enabled ? "enabled" : "disabled"}: ${args.query ?? ""}`
          : `Topic updated: ${args.query ?? args.id}`,
      });
    } else if (args.query) {
      await ctx.db.insert("topicQueries", {
        query: args.query, category: args.category ?? "iran", enabled: true, createdAt: new Date().toISOString(),
      });
      await ctx.runMutation(internal.db.logActivity, {
        type: "admin", level: "info", message: `Topic added: ${args.query}`, detail: args.category ?? "iran",
      });
    }
  },
});

export const upsertSource = mutation({
  args: { ...pinArg, id: v.optional(v.string()), name: v.optional(v.string()), kind: v.optional(v.string()), secretRef: v.optional(v.union(v.string(), v.null())), priority: v.optional(v.number()), enabled: v.optional(v.boolean()), remove: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);
    if (args.remove && args.id) {
      await ctx.db.delete(args.id as any);
      await ctx.runMutation(internal.db.logActivity, {
        type: "admin", level: "info", message: `Provider removed: ${args.name ?? args.id}`,
      });
      return;
    }
    if (args.id) {
      const patch: Record<string, unknown> = {};
      if (args.enabled !== undefined) patch.enabled = args.enabled;
      if (args.name) patch.name = args.name;
      if (args.kind) patch.kind = args.kind;
      if (args.secretRef !== undefined) patch.secretRef = args.secretRef || undefined;
      if (args.priority !== undefined) patch.priority = args.priority;
      await ctx.db.patch(args.id as any, patch);
      await ctx.runMutation(internal.db.logActivity, {
        type: "admin", level: "info",
        message: args.enabled !== undefined
          ? `Provider ${args.enabled ? "enabled" : "disabled"}: ${args.name ?? args.id}`
          : `Provider updated: ${args.name ?? args.id}`,
      });
    } else if (args.name && args.kind) {
      await ctx.db.insert("sources", {
        name: args.name, kind: args.kind, secretRef: args.secretRef ?? undefined,
        config: args.kind === "telegram" ? { channel: args.name.replace(/^@/, "").trim() } : {},
        priority: args.priority ?? 100, usedToday: 0, quotaDate: new Date().toISOString().slice(0, 10), enabled: true, createdAt: new Date().toISOString(),
      });
      await ctx.runMutation(internal.db.logActivity, {
        type: "admin", level: "info", message: `Provider added: ${args.name}`, detail: `${args.kind} · priority ${args.priority ?? 100}`,
      });
    }
  },
});

export const setPauseState = mutation({
  args: { ...pinArg, paused: v.boolean(), reason: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);
    const s = await ctx.db.query("settings").first();
    if (!s) throw new Error("Settings not found");
    await ctx.db.patch(s._id, {
      botPaused: args.paused, botPausedReason: args.paused ? (args.reason ?? "Paused by admin") : undefined,
      botPausedAt: args.paused ? new Date().toISOString() : undefined, nextPublishAt: args.paused ? undefined : s.nextPublishAt,
    });
    await ctx.runMutation(internal.db.logActivity, {
      type: "system",
      level: args.paused ? "warning" : "success",
      message: args.paused ? `Bot paused${args.reason ? ` — ${args.reason}` : ""}` : "Bot services resumed",
    });
  },
});

export const listTranslationKeys = query({
  args: pinArg,
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);
    const keys = await ctx.db.query("translationProviderKeys").collect();
    keys.sort((a, b) => a.provider.localeCompare(b.provider) || a.priority - b.priority);
    const masked = keys.map((k) => ({ ...k, apiKey: k.apiKey ? k.apiKey.slice(0, 6) + "..." : null }));
    return {
      keys: masked,
      envDefaults: {
        gemini: [1, 2, 3].filter((i) => Boolean(process.env[`GEMINI_API_KEY_${i}`])).length,
        minimax: Boolean(process.env["VERCEL_AI_GATEWAY_API_KEY"] ?? process.env["AI_GATEWAY_API_KEY"]),
      },
    };
  },
});

export const upsertTranslationKey = mutation({
  args: { ...pinArg, id: v.optional(v.string()), provider: v.string(), label: v.string(), apiKey: v.optional(v.string()), model: v.string(), enabled: v.optional(v.boolean()), priority: v.optional(v.number()), remove: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);
    if (args.remove && args.id) {
      await ctx.db.delete(args.id as any);
      await ctx.runMutation(internal.db.logActivity, {
        type: "translation", level: "info", message: `Translation key removed: ${args.label}`,
      });
      return;
    }
    const row: Record<string, unknown> = {
      provider: args.provider, label: args.label, model: args.model,
      enabled: args.enabled ?? true, priority: args.priority ?? 100, updatedAt: new Date().toISOString(),
    };
    if (args.apiKey?.trim()) row.apiKey = args.apiKey.trim();
    if (args.id) { await ctx.db.patch(args.id as any, row); }
    else {
      if (!args.apiKey?.trim()) throw new Error("API key is required");
      await ctx.db.insert("translationProviderKeys", {
        ...row as any, apiKey: args.apiKey.trim(), createdAt: new Date().toISOString(), consecutiveFailures: 0,
      });
    }
    await ctx.runMutation(internal.db.logActivity, {
      type: "translation", level: "info",
      message: args.id ? `Translation key updated: ${args.label}` : `Translation key added: ${args.label}`,
      detail: `${args.provider} · ${args.model}`,
    });
  },
});
