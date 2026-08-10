"use node";
import { action } from "./_generated/server";
import { v } from "convex/values";
import { createHash } from "crypto";
import { createAccount } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { telegramCall, sendPoll } from "./pipeline/telegram";
import type { TranslationKey } from "./pipeline/ai";
import {
  validateSorani,
  translateToSoraniWithKeys,
  getDefaultGeminiTranslationModel,
  listSupportedGeminiModels,
} from "./pipeline/ai";
import { getTelegramToken } from "./secrets";
import { generatePoll, pickPollLanguage } from "./pipeline/ai";

const FALLBACK_OWNER_EMAILS = ["akam09890@gmail.com"];
const FALLBACK_OWNER_PIN = "200006";

function pinMatches(pin: string | undefined | null): boolean {
  if (!pin) return false;
  return pin.trim() === (process.env["ADMIN_PIN"] ?? FALLBACK_OWNER_PIN).trim();
}

async function requireAdmin(ctx: any, args: { pin?: string } = {}) {
  if (pinMatches(args.pin)) {
    return { email: "pin-admin@freebuff.local", isOwner: true, viaPin: true };
  }
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthorized");
  const email = (identity.email ?? "").toLowerCase().trim();
  const raw = (process.env["OWNER_EMAILS"] ?? process.env["OWNER_EMAIL"] ?? "").trim();
  const allowed = new Set(
    [
      ...raw.split(/[\s,;]+/).map((e: string) => e.trim().toLowerCase()).filter(Boolean),
      ...FALLBACK_OWNER_EMAILS.map((e) => e.toLowerCase()),
    ],
  );
  if (!allowed.has(email)) throw new Error("Forbidden: not an admin");
  return { email, isOwner: allowed.has(email), viaPin: false };
}

async function requireBootstrapKey(args: { bootstrapKey?: string }) {
  const expected = (process.env["CONVEX_BOOTSTRAP_KEY"] ?? "").trim();
  if (!expected) {
    throw new Error(
      "Bootstrap is locked: set CONVEX_BOOTSTRAP_KEY in .env.local to enable first-run account creation, or sign up via the UI.",
    );
  }
  return expected;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export const createAdminUser = action({
  args: { email: v.string(), password: v.string(), bootstrapKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.password.length < 8) throw new Error("Password must be at least 8 characters");
    const existing = await ctx.runQuery(internal.db.findUserByEmail, { email: args.email });
    if (existing) {
      return { ok: true, alreadyExisted: true, email: args.email };
    }
    const expected = await requireBootstrapKey(args);
    if (!args.bootstrapKey || !safeEqual(args.bootstrapKey.trim(), expected)) {
      throw new Error("Invalid bootstrap key");
    }
    const created = await createAccount(ctx, {
      provider: "password",
      account: { id: args.email, secret: args.password },
      profile: { email: args.email } as any,
    });
    return { ok: true, alreadyExisted: false, userId: String(created.user._id), email: args.email };
  },
});

export const testTranslationKey = action({
  args: { pin: v.optional(v.string()), id: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);
    const keyDoc = await ctx.runQuery(internal.db.getTranslationKeyById, { id: args.id });
    if (!keyDoc) throw new Error("Key not found");
    const kd = keyDoc as any;
    const mappedKey = { ...kd, id: kd._id, provider: kd.provider, model: kd.model, apiKey: kd.apiKey } as TranslationKey;
    const result = await translateToSoraniWithKeys("Iran announced a new statement today.", [mappedKey], "gemini_first");
    if (!result.text || !validateSorani(result.text)) throw new Error(result.detail ?? "Translation test failed");
    return { ok: true, preview: result.text };
  },
});

export const refreshBotInfo = action({
  args: { pin: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);
    const me = await telegramCall<{ username?: string; first_name?: string }>("getMe");
    return { username: me.username ?? null, name: me.first_name ?? null };
  },
});

// Set a model-picker action. The admin can swap translation-provider model
// at runtime via the dashboard without redeploying.
export const setTranslationModel = action({
  args: { pin: v.optional(v.string()), model: v.string() },
  handler: async (_ctx, args) => {
    const fallback = (process.env["ADMIN_PIN"] ?? FALLBACK_OWNER_PIN).trim();
    const supplied = (args.pin ?? "").trim();
    if (!supplied || supplied !== fallback) throw new Error("Unauthorized");
    const supported = listSupportedGeminiModels();
    const requested = args.model.trim();
    const normalized = requested.startsWith("google/") || requested.startsWith("gemini-")
      ? requested
      : `google/${requested}`;
    if (!supported.includes(normalized)) {
      throw new Error(
        `Unsupported model "${normalized}". Supported: ${supported.join(", ")}`,
      );
    }
    // Persist into the env so subsequent pipeline runs pick it up. The Convex
    // runtime reads from process.env each call.
    process.env["GEMINI_TRANSLATION_MODEL"] = normalized;
    return { ok: true, model: normalized, supported };
  },
});

export const listTranslationModels = action({
  args: { pin: v.optional(v.string()) },
  handler: async (_ctx, args) => {
    const fallback = (process.env["ADMIN_PIN"] ?? FALLBACK_OWNER_PIN).trim();
    const supplied = (args.pin ?? "").trim();
    if (!supplied || supplied !== fallback) throw new Error("Unauthorized");
    return {
      supported: listSupportedGeminiModels(),
      current: getDefaultGeminiTranslationModel(),
    };
  },
});

// Discover every chat the bot has ever received an update from.
// Telegram has no "list my chats" API, so we pull pending updates
// (getUpdates) — it returns messages from any user who started the bot
// and any group/channel it was added to. Works with or without a webhook
// (if a webhook is set we temporarily remove it, poll, then restore it).
export const syncBotChats = action({
  args: { pin: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);

    const info = await telegramCall<{ url?: string; secret_token?: string }>("getWebhookInfo").catch(() => null);
    const webhookUrl = info?.url;
    const webhookSecret = info?.secret_token;
    if (webhookUrl) {
      await telegramCall("deleteWebhook").catch(() => undefined);
    }

    let updates: Array<Record<string, unknown>> = [];
    try {
      updates = await telegramCall<Array<Record<string, unknown>>>("getUpdates", {
        limit: 100,
        timeout: 2,
      });
    } finally {
      if (webhookUrl) {
        await telegramCall("setWebhook", {
          url: webhookUrl,
          ...(webhookSecret ? { secret_token: webhookSecret } : {}),
        }).catch(() => undefined);
      }
    }

    const seen = new Map<number, Record<string, unknown>>();
    for (const u of updates) {
      const message = (u.message ?? u.edited_message ?? u.channel_post ?? u.my_chat_member) as Record<string, any> | undefined;
      const chat = message?.chat as Record<string, any> | undefined;
      if (!chat?.id) continue;
      seen.set(Number(chat.id), chat);
    }

    const found: Array<Record<string, unknown>> = [];
    for (const chat of seen.values()) {
      const chatId = Number(chat.id);
      const title = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ") ?? undefined;
      await ctx.runMutation(internal.db.upsertChat, {
        chatId,
        title: title ? String(title).slice(0, 128) : undefined,
        username: typeof chat.username === "string" ? chat.username : undefined,
        type: typeof chat.type === "string" ? chat.type : "private",
        active: true,
        lastSeenAt: new Date().toISOString(),
      });
      found.push({
        chatId,
        title: chat.title ?? null,
        username: chat.username ?? null,
        type: chat.type ?? "private",
      });
    }

    return {
      count: found.length,
      found,
      pendingUpdates: updates.length,
      webhookUrl: webhookUrl ?? null,
      note: found.length === 0
        ? "No chats found yet. Open your bot in Telegram, press Start, add it to your channel/group, then run this again."
        : undefined,
    };
  },
});

// Fire a test message straight to any chat ID so the admin can verify the
// bot can deliver right now. Also registers the chat in the dashboard.
export const sendTestMessage = action({
  args: { pin: v.optional(v.string()), chatId: v.number(), message: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);
    const text =
      args.message?.trim() ||
      "⚡ Test message from your Iran Desk news bot — if you can read this, delivery works. Delivered by Freebuff.";
    await telegramCall("sendMessage", {
      chat_id: args.chatId,
      text,
      parse_mode: "HTML",
    });

    // Register the chat so it appears in the dashboard and receives future posts.
    const me = await telegramCall<{ username?: string; first_name?: string }>("getMe");
    await ctx.runMutation(internal.db.upsertChat, {
      chatId: args.chatId,
      title: undefined,
      username: undefined,
      type: "private",
      active: true,
      lastSeenAt: new Date().toISOString(),
    });
    return { ok: true, chatId: args.chatId, botUsername: me.username ?? null };
  },
});

export const setWebhook = action({
  args: { pin: v.optional(v.string()), baseUrl: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);
    const token = getTelegramToken();
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    const secret = createHash("sha256")
      .update(`telegram-webhook:${token}`)
      .digest("base64url");
    await telegramCall("setWebhook", {
      url: `${args.baseUrl.replace(/\/$/, "")}/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ["message", "edited_message", "channel_post", "my_chat_member"],
    });
    return { ok: true };
  },
});

// Send a one-off test poll straight to a chat ID, so the admin can verify polls.
export const testPoll = action({
  args: {
    pin: v.optional(v.string()),
    chatId: v.number(),
    question: v.optional(v.string()),
    options: v.optional(v.array(v.string())),
    language: v.optional(v.union(v.literal("ckb"), v.literal("en"))),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args);
    const lang = args.language ?? "ckb";
    const fallbackTemplates = {
      en: {
        question: "How should the US respond to Iran's latest move?",
        options: ["Diplomacy", "Sanctions", "Military strikes", "Status quo"],
      },
      ckb: {
        question: "ئایا وڵامی ئێران بۆ هەنگاوەکەی ئەمەریکا چی دەبێت؟",
        options: ["دیپلۆماسی", "سزا ئابوورییەکان", "هێرشی سەربازی", "هیچ کاردانەوەیەک نییە"],
      },
    };
    let generated: { question: string; options: string[] } | null = null;
    if (args.question && args.options && args.options.length >= 2) {
      generated = { question: args.question, options: args.options };
    } else {
      try {
        generated = await generatePoll(
          {
            headline:
              "Trump says new sanctions will hit Iran's oil exports within 48 hours",
            summary:
              "From the White House podium, the US president announced a fresh sanctions package targeting Iran's oil exports. Tehran has not responded yet.",
            category: "war",
          },
          lang,
        );
      } catch {
        generated = null;
      }
      if (!generated) {
        generated = fallbackTemplates[lang];
      }
    }
    const openPeriodSec = Math.min(600, Math.max(5, Number(process.env["POLL_TEST_OPENS"] ?? "300")));
    const messageId = await sendPoll(
      args.chatId,
      generated.question,
      generated.options,
      { openPeriodSec, isAnonymous: true },
    );
    await ctx.runMutation(internal.db.insertPoll, {
      dedupKey: `test:${args.chatId}:${Date.now()}`,
      chatId: args.chatId,
      itemHeadline: undefined,
      itemCategory: undefined,
      language: lang,
      question: generated.question,
      options: generated.options,
      telegramMessageId: messageId,
      closedAt: new Date(Date.now() + openPeriodSec * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    return {
      ok: true,
      chatId: args.chatId,
      question: generated.question,
      options: generated.options,
      language: lang,
      telegramMessageId: messageId ?? null,
    };
  },
});

export const runPipeline = action({
  args: { pin: v.optional(v.string()), action: v.string() },
  handler: async (ctx, args): Promise<{ result: Record<string, any> }> => {
    await requireAdmin(ctx, args);
    let result: Record<string, any>;
    if (args.action === "ingest") result = (await ctx.runAction(internal.pipeline.ingest, {})) as Record<string, any>;
    else result = (await ctx.runAction(internal.pipeline.publish, { force: 3 })) as Record<string, any>;
    return { result };
  },
});
