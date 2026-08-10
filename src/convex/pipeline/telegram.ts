"use node";
import { getTelegramToken } from "../secrets";

const DIRECT_API = "https://api.telegram.org";

// Backwards-compatible alias used everywhere in the codebase.
export function botToken(): string {
  const token = getTelegramToken();
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  return token;
}

export async function telegramCall<T = Record<string, unknown>>(
  method: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const token = botToken();
  const direct = await fetch(`${DIRECT_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!direct.ok) {
    const body = await direct.text();
    throw new Error(`Telegram ${method} [${direct.status}]: ${body.slice(0, 300)}`);
  }
  const json = (await direct.json()) as { ok?: boolean; result?: T };
  if (!json.ok) throw new Error(`Telegram ${method}: failed`);
  return json.result as T;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface PostSource {
  name: string;
  url: string;
}

export interface OutgoingPost {
  headline: string;
  summary: string;
  sourceName: string;
  url: string;
  imageUrl: string | null;
  originalPublishedAt: string | null;
  breaking: boolean;
  category: string;
  timezone: string;
  extraSources?: PostSource[];
}

export function formatMessage(post: OutgoingPost): string {
  const when = post.originalPublishedAt
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: post.timezone,
      }).format(new Date(post.originalPublishedAt))
    : "";

  const sources: PostSource[] = [
    { name: post.sourceName, url: post.url },
    ...(post.extraSources ?? []),
  ];

  const lines = [
    `📰 <b>${escapeHtml(post.category.replace(/-/g, " ").toUpperCase())}</b>`,
    "",
    `<b>${escapeHtml(post.headline)}</b>`,
    "",
    escapeHtml(post.summary),
    "",
    `🗞 <i>${escapeHtml(post.sourceName)}</i>${when ? ` · ${escapeHtml(when)}` : ""}`,
  ];

  if (sources.length > 1) {
    lines.push(
      ...sources.map(
        (s, i) => `${i === 0 ? "🔗" : "•"} <a href="${escapeHtml(s.url)}">${escapeHtml(s.name)}</a>`,
      ),
    );
  } else {
    lines.push(`<a href="${escapeHtml(post.url)}">Read the full report</a>`);
  }

  lines.push("");
  lines.push(`<i>⚡ Delivered by Freebuff</i>`);

  return lines.filter((l) => l !== undefined).join("\n");
}

export async function sendPost(chatId: number, post: OutgoingPost): Promise<void> {
  const text = formatMessage(post);
  if (post.imageUrl) {
    try {
      await telegramCall("sendPhoto", {
        chat_id: chatId,
        photo: post.imageUrl,
        caption: text.slice(0, 1024),
        parse_mode: "HTML",
      });
      return;
    } catch {
      // image rejected by Telegram -> fall through to text-only, no placeholder
    }
  }
  await telegramCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: !post.imageUrl ? false : true },
  });
}

// Send a Telegram native poll. Telegram polls only allow plain text, so strip
// HTML brackets. open_period (when provided) is in seconds; auto-close.
export async function sendPoll(
  chatId: number,
  question: string,
  options: string[],
  opts: { openPeriodSec?: number; isAnonymous?: boolean } = {},
): Promise<number | undefined> {
  const cleanQuestion = question.replace(/[<>]/g, "");
  const cleanOptions = options.map((o) => String(o).replace(/[<>]/g, ""));
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    question: cleanQuestion,
    options: cleanOptions,
    is_anonymous: opts.isAnonymous ?? true,
  };
  if (typeof opts.openPeriodSec === "number" && opts.openPeriodSec >= 5 && opts.openPeriodSec <= 600) {
    payload["open_period"] = opts.openPeriodSec;
  }
  const res = await telegramCall<
    { message_id?: number; poll?: { id?: string; total_voter_count?: number } }
  >("sendPoll", payload);
  return res?.message_id;
}