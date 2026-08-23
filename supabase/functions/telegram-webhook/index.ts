// Real-time Telegram chat discovery endpoint.
// Kept separate from the large admin dispatcher so Telegram receives a real
// non-2xx response when persistence fails and can retry the update.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

function headers(): HeadersInit {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function rest<T = unknown>(
  table: string,
  opts: { method?: "GET" | "POST" | "PATCH"; query?: string; body?: unknown } = {},
): Promise<T> {
  const url = `${SUPABASE_URL}/rest/v1/${table}${opts.query ? `?${opts.query}` : ""}`;
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: headers(),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`PostgREST ${opts.method ?? "GET"} ${table} [${res.status}]: ${detail.slice(0, 200)}`);
  }
  if (opts.method === "GET" || res.headers.get("content-type")?.includes("json")) {
    return (await res.json().catch(() => null)) as T;
  }
  return undefined as T;
}

async function webhookSecretFor(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`telegram-webhook:${token}`),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function verifyBot(provided: string): Promise<{ ok: boolean; botId: string | null; label: string }> {
  if (!provided) return { ok: false, botId: null, label: "" };
  if (TELEGRAM_BOT_TOKEN && (await webhookSecretFor(TELEGRAM_BOT_TOKEN)) === provided) {
    return { ok: true, botId: null, label: "primary bot" };
  }
  const bots = await rest<Array<{ id: string; name?: string | null; token?: string | null }>>("bots", {
    query: "select=id,name,token&enabled=eq.true&limit=100",
  });
  for (const bot of bots ?? []) {
    const token = String(bot.token ?? "");
    if (token && (await webhookSecretFor(token)) === provided) {
      return { ok: true, botId: String(bot.id), label: bot.name ?? "bot" };
    }
  }
  return { ok: false, botId: null, label: "" };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  try {
    const auth = await verifyBot(req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "");
    if (!auth.ok) return json(401, { error: "Unauthorized" });

    const update = JSON.parse(await req.text()) as Record<string, unknown>;
    const message = (update.message ?? update.channel_post ?? update.edited_channel_post ?? update.my_chat_member) as Record<string, unknown> | undefined;
    const chat = message?.chat as Record<string, unknown> | undefined;
    const chatId = Number(chat?.id ?? 0);
    if (!chatId) return json(200, { ok: true, ignored: true });

    const member = update.my_chat_member as Record<string, unknown> | undefined;
    const memberStatus = (member?.new_chat_member as Record<string, unknown> | undefined)?.status;
    if (memberStatus === "left" || memberStatus === "kicked") {
      await rest("chats", {
        method: "PATCH",
        query: `chat_id=eq.${chatId}`,
        body: { active: false, last_seen_at: new Date().toISOString() },
      });
      return json(200, { ok: true });
    }

    const title = chat?.title ?? chat?.username ?? null;
    const username = chat?.username ?? null;
    const type = chat?.type ?? null;
    const existing = await rest<Array<{ id: string }>>("chats", {
      query: `chat_id=eq.${chatId}&limit=1`,
    });
    if ((existing ?? []).length > 0) {
      const patch: Record<string, unknown> = { active: true, last_seen_at: new Date().toISOString() };
      if (title !== null) patch.title = title;
      if (username !== null) patch.username = username;
      if (type !== null) patch.type = type;
      await rest("chats", { method: "PATCH", query: `chat_id=eq.${chatId}`, body: patch });
      return json(200, { ok: true, refreshed: true });
    }

    await rest("chats", {
      method: "POST",
      body: {
        chat_id: chatId,
        title,
        username,
        type: type ?? "private",
        active: true,
        bot_id: auth.botId,
        last_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    });
    return json(200, { ok: true });
  } catch {
    // Telegram retries non-2xx updates; do not acknowledge a chat that was
    // not actually persisted.
    return json(500, { ok: false, error: "chat persistence failed" });
  }
});
