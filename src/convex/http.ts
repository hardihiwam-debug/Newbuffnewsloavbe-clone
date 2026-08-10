import { httpRouter } from "convex/server";

const http = httpRouter();

async function sha256Base64Url(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  // Convert to base64url
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function expectedSecret(token: string): Promise<string> {
  return sha256Base64Url(`telegram-webhook:${token}`);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

http.route({
  path: "/telegram/webhook",
  method: "POST",
  handler: (async (ctx: any, request: Request) => {
    const token = process.env["TELEGRAM_BOT_TOKEN"];
    if (!token) return new Response("Not configured", { status: 500 });

    const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    const secret = await expectedSecret(token);
    if (!safeEqual(provided, secret)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { getBotPaused } = await import("./db");
    const botPaused = await ctx.runQuery(getBotPaused);
    if (botPaused) return Response.json({ ok: true, paused: true });

    const update = (await request.json()) as any;
    const message =
      update.message ??
      update.edited_message ??
      update.channel_post ??
      update.my_chat_member;
    const chat = message?.chat;
    if (!chat?.id) return Response.json({ ok: true, ignored: true });

    const status = update.my_chat_member?.new_chat_member?.status;
    const removed = status === "left" || status === "kicked";

    const { upsertChat } = await import("./db");
    await ctx.runMutation(upsertChat, {
      chatId: chat.id,
      title: chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ") ?? null,
      username: chat.username ?? null,
      type: chat.type ?? "private",
      active: !removed,
      lastSeenAt: new Date().toISOString(),
    });

    // Log membership events (bot added/removed) — regular messages aren't
    // logged here to avoid flooding the activity feed.
    if (removed || update.my_chat_member) {
      const { logActivity } = await import("./db");
      const name = chat.title ?? chat.username ?? String(chat.id);
      await ctx.runMutation(logActivity, {
        type: "chat",
        level: removed ? "warning" : "info",
        message: removed
          ? `Bot left or was kicked from ${name}`
          : `Bot ${update.my_chat_member?.new_chat_member?.status ?? "added"} in ${name}`,
        chatId: chat.id,
      });
    }

    return Response.json({ ok: true });
  }) as any,
});

export default http;