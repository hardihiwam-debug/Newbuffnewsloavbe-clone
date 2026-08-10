import type { FetchedArticle } from "./types";

export const DEFAULT_TELEGRAM_CHANNELS = [
  "ajanews",
  "insiderpaper",
  "middle_east_spectator",
  "thecradlemedia",
];

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
};

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ChannelPost {
  channel: string;
  text: string;
  url: string;
  publishedAt: string | null;
}

export function isArabicOrPersian(text: string): boolean {
  return /[\u0600-\u06ff]/u.test(text);
}

export async function fetchTelegramChannel(
  channel: string,
  limit = 20,
): Promise<ChannelPost[]> {
  const name = channel.replace(/^@/, "").trim();
  const res = await fetch(`https://t.me/s/${encodeURIComponent(name)}`, {
    headers: HEADERS,
  });
  if (!res.ok) throw new Error(`t.me/s/${name} ${res.status}`);
  const html = await res.text();

  const blocks = html.match(/<div class="tgme_widget_message[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g) ?? [];
  const posts: ChannelPost[] = [];

  for (const block of blocks.slice(-limit)) {
    const textMatch = block.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    );
    if (!textMatch?.[1]) continue;
    const text = stripTags(textMatch[1]);
    if (text.length < 25) continue;

    const linkMatch = block.match(/data-post="([^"]+)"/);
    const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
    posts.push({
      channel: name,
      text,
      url: linkMatch?.[1] ? `https://t.me/${linkMatch[1]}` : `https://t.me/s/${name}`,
      publishedAt: timeMatch?.[1] ?? null,
    });
  }
  return posts.reverse();
}

export async function fetchTelegramSignals(
  channels: string[],
): Promise<ChannelPost[]> {
  const results = await Promise.all(
    channels.map(async (c) => {
      try {
        return await fetchTelegramChannel(c);
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

export function signalArticles(posts: ChannelPost[]): FetchedArticle[] {
  return posts.map((p) => ({
    provider: `Telegram/${p.channel}`,
    sourceName: `@${p.channel}`,
    url: p.url,
    title: p.text.slice(0, 160),
    description: p.text.slice(0, 600),
    imageUrl: null,
    publishedAt: p.publishedAt,
  }));
}