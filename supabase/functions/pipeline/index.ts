// Iran Desk Bot — Supabase Edge Function pipeline.
// Replaces the Convex ingest/publish crons: fetch → filter → dedup →
// rewrite (Groq) → enqueue → translate (Gemini direct → Groq → MiniMax) →
// publish to Telegram. Persists everything in Supabase Postgres via PostgREST.
//
// Scheduled by pg_cron every minute (net.http_post). The function self-gates
// on the editable intervals (ingestIntervalMinutes) and the day/night window
// cadence, so the schedule is just a ticker.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const INTERNAL_SECRET = Deno.env.get("INTERNAL_SECRET") ?? "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const NEWSDATA_API_KEY = Deno.env.get("NEWSDATA_API_KEY") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const MINIMAX_API_KEY = Deno.env.get("MINIMAX_API_KEY") ?? "";

function geminiKeys(): Array<{ index: number; key: string }> {
  const out: Array<{ index: number; key: string }> = [];
  for (let i = 1; i <= 6; i++) {
    const k = Deno.env.get(`GEMINI_API_KEY_${i}`)?.trim();
    if (k) out.push({ index: i, key: k });
  }
  return out;
}

// ── Types ────────────────────────────────────────────────────────────────────
type Article = {
  provider: string;
  sourceName: string | null;
  url: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  videoUrl?: string | null;
  publishedAt: string | null;
  sourceText?: string | null;
};

type SettingsRow = Record<string, unknown> & { id?: string };

// ── PostgREST helpers ───────────────────────────────────────────────────────
function restHeaders(prefer?: string): HeadersInit {
  const h: Record<string, string> = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) h["Prefer"] = prefer;
  return h;
}

async function rest<T = unknown>(
  table: string,
  opts: { method?: "GET" | "POST" | "PATCH" | "DELETE"; query?: string; body?: unknown; prefer?: string } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (opts.query) url += `?${opts.query}`;
  const res = await fetch(url, {
    method,
    headers: restHeaders(opts.prefer),
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PostgREST ${method} ${table} [${res.status}]: ${text.slice(0, 300)}`);
  }
  if (method === "GET" || opts.prefer === "return=representation") {
    return (await res.json().catch(() => null)) as T;
  }
  return undefined as T;
}

const enc = encodeURIComponent;

// ── Crypto / URL helpers ────────────────────────────────────────────────────
async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function hostname(url: string): string {
  const h = hostOf(url);
  return h || "Unknown source";
}

// ── Images ──────────────────────────────────────────────────────────────────
function isValidStoryImage(url: string | null | undefined): boolean {
  if (!url) return false;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return false;
  const lower = u.toLowerCase();
  if (/\.svg(\?|#|$)/i.test(lower)) return false;
  const bad = [
    "logo", "avatar", "favicon", "icon", "spacer", "pixel", "placeholder",
    "sprite", "gravatar", "badge", "branding", "userpic", "profile-pic", "profile_pic",
  ];
  if (bad.some((t) => lower.includes(t))) return false;
  return true;
}

function decodeAttr(value: string): string {
  return value
    .replace(/&#x2f;/gi, "/")
    .replace(/&#x3a;/gi, ":")
    .replace(/&#x26;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/gi, "&")
    .trim();
}

function extractOgImageFromHtml(html: string, baseUrl: string): string | null {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const OG = new Set(["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]);
  const ordered: Array<{ prop: string; url: string }> = [];
  for (const tag of metaTags) {
    const prop = (tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1] ?? "").toLowerCase();
    if (!OG.has(prop)) continue;
    const content = tag.match(/content=["']([^"']+)["']/i)?.[1];
    if (content) ordered.push({ prop, url: decodeAttr(content) });
  }
  const rank = (p: string) =>
    p.startsWith("og:image") ? (p === "og:image:url" || p === "og:image:secure_url" ? 0 : 1) : 2;
  ordered.sort((a, b) => rank(a.prop) - rank(b.prop));
  const imageSrc = html.match(/<link[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["']/i)?.[1];
  const candidates = ordered.map((c) => c.url);
  if (imageSrc) candidates.push(decodeAttr(imageSrc));
  for (const raw of candidates) {
    try {
      const abs = new URL(raw, baseUrl).toString();
      if (isValidStoryImage(abs)) return abs;
    } catch {
      /* skip */
    }
  }
  return null;
}

const SCRAPE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

async function fetchArticleOgImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: SCRAPE_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;
    const html = await res.text();
    const head =
      html.slice(0, 200_000).match(/<head[^>]*>[\s\S]*?<\/head>/i)?.[0] ?? html.slice(0, 200_000);
    return extractOgImageFromHtml(head, res.url || url);
  } catch {
    return null;
  }
}

// ── Fetchers ────────────────────────────────────────────────────────────────
async function fetchNewsData(apiKey: string, query: string): Promise<Article[]> {
  const url = new URL("https://newsdata.io/api/1/latest");
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("language", "en");
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`NewsData ${res.status}`);
  const json = (await res.json()) as { status?: string; results?: Array<Record<string, unknown>> };
  if (json.status && json.status !== "success") throw new Error(`NewsData error: ${json.status}`);
  return (json.results ?? [])
    .map((r): Article | null => {
      const link = typeof r["link"] === "string" ? r["link"] : null;
      const title = typeof r["title"] === "string" ? r["title"] : null;
      if (!link || !title) return null;
      const rawImage = typeof r["image_url"] === "string" ? r["image_url"] : null;
      return {
        provider: "NewsData.io",
        sourceName: typeof r["source_name"] === "string" ? r["source_name"] : null,
        url: link,
        title,
        description: typeof r["description"] === "string" ? r["description"] : null,
        imageUrl: isValidStoryImage(rawImage) ? rawImage : null,
        publishedAt: typeof r["pubDate"] === "string" ? r["pubDate"] : null,
      };
    })
    .filter((a): a is Article => a !== null);
}

function decodeEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&(?:amp;)?nbsp;|&#160;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function rssTag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m?.[1] ? decodeEntities(m[1]) : null;
}

function extractRssImage(block: string): string | null {
  const candidates: Array<{ url: string; tiny: boolean }> = [];
  const mediaContent = block.match(/<media:content[^>]*\burl=["']([^"']+)["']/i)?.[1];
  if (mediaContent) candidates.push({ url: mediaContent, tiny: false });
  const enclosureTag = block.match(/<enclosure[^>]*>/i)?.[0];
  if (enclosureTag) {
    const encUrl = enclosureTag.match(/\burl=["']([^"']+)["']/i)?.[1];
    const encType = (enclosureTag.match(/\btype=["']([^"']+)["']/i)?.[1] ?? "").toLowerCase();
    if (encUrl && (encType.startsWith("image/") || /\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(encUrl))) {
      candidates.push({ url: encUrl, tiny: false });
    }
  }
  const thumbTag = block.match(/<media:thumbnail[^>]*>/i)?.[0];
  if (thumbTag) {
    const thumbUrl = thumbTag.match(/\burl=["']([^"']+)["']/i)?.[1];
    if (thumbUrl) {
      const w = Number(thumbTag.match(/\bwidth=["'](\d+)["']/i)?.[1] ?? 0);
      const h = Number(thumbTag.match(/\bheight=["'](\d+)["']/i)?.[1] ?? 0);
      candidates.push({ url: thumbUrl, tiny: w > 0 && h > 0 && (w < 100 || h < 100) });
    }
  }
  const descriptionImg = block.match(/<img[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
  if (descriptionImg) candidates.push({ url: descriptionImg, tiny: false });
  for (const c of candidates) if (!c.tiny && isValidStoryImage(c.url)) return c.url;
  for (const c of candidates) if (isValidStoryImage(c.url)) return c.url;
  return null;
}

const RSS_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

function parseRssItems(xml: string, provider: string, fallbackSource: string | null): Article[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items
    .map((block): Article | null => {
      const title = rssTag(block, "title");
      const rawLink = rssTag(block, "link");
      if (!title || !rawLink) return null;
      let link = rawLink;
      try {
        const u = new URL(rawLink);
        if (/(^|\.)bing\.com$/i.test(u.hostname)) {
          const t = u.searchParams.get("url");
          if (t?.startsWith("http")) link = t;
        }
      } catch {
        /* keep raw */
      }
      try {
        const host = new URL(link).hostname.replace(/^www\./, "").toLowerCase();
        if (host === "msn.com" || host.endsWith(".msn.com")) return null;
      } catch {
        /* unparseable */
      }
      const rawSource = rssTag(block, "source") ?? fallbackSource;
      const description = rssTag(block, "description");
      const source =
        rawSource && !/bing|google|news\.google|msn/i.test(rawSource)
          ? rawSource
          : hostOf(link) || null;
      return {
        provider,
        sourceName: source,
        url: link,
        title,
        description,
        imageUrl: extractRssImage(block),
        publishedAt: rssTag(block, "pubDate"),
      };
    })
    .filter((a): a is Article => a !== null);
}

async function fetchGoogleNewsRss(query: string): Promise<Article[]> {
  for (const base of ["https://news.google.com/rss/search", "https://news.google.com/news/rss/search"]) {
    const url = `${base}?q=${encodeURIComponent(query)}+when:1d&hl=en-US&gl=US&ceid=US:en`;
    try {
      const res = await fetch(url, { headers: RSS_HEADERS, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return parseRssItems(await res.text(), "Google News RSS", null);
    } catch {
      /* try next */
    }
  }
  return [];
}

const PUBLISHER_FEEDS: Array<{ name: string; url: string; cap?: number }> = [
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml" },
  { name: "The Guardian World", url: "https://www.theguardian.com/world/rss" },
  { name: "Al Arabiya", url: "https://english.alarabiya.net/tools/rss" },
  { name: "Rudaw", url: "https://www.rudaw.net/rss/english" },
  { name: "Shafaq News", url: "https://shafaq.com/en/rss" },
  { name: "Press TV", url: "https://www.presstv.ir/rss.xml" },
  { name: "Mehr News", url: "https://en.mehrnews.com/rss" },
  { name: "Tehran Times", url: "https://www.tehrantimes.com/rss" },
  { name: "Tasnim News", url: "https://www.tasnimnews.com/en/rss/feed/0/8/0/" },
  { name: "IRNA English", url: "https://en.irna.ir/rss" },
  { name: "Al Mayadeen", url: "https://english.almayadeen.net/rss" },
  { name: "Middle East Eye", url: "https://www.middleeasteye.net/rss", cap: 4 },
  { name: "Defense News Mideast", url: "https://www.defensenews.com/arc/outboundfeeds/rss/category/mideast-africa/?outputType=xml", cap: 6 },
  { name: "OilPrice.com", url: "https://oilprice.com/rss/main", cap: 6 },
  { name: "CNBC Energy", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19836768", cap: 6 },
];

async function fetchPublisherFeeds(): Promise<Article[]> {
  const results = await Promise.all(
    PUBLISHER_FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, { headers: RSS_HEADERS, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) return [] as Article[];
        const items = parseRssItems(await res.text(), `${feed.name} RSS`, feed.name);
        return items.slice(0, feed.cap ?? 15);
      } catch {
        return [] as Article[];
      }
    }),
  );
  return results.flat();
}

// ── Article full text ───────────────────────────────────────────────────────
function extractArticleTextFromHtml(html: string): string {
  if (!html) return "";
  const stripChrome = (s: string) =>
    s
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<(nav|header|footer|aside|form|figure|noscript|iframe|svg|button)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const cleaned = stripChrome(html);
  const article = cleaned.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i)?.[1] ?? cleaned;
  return article
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:p|div|h[1-6]|li|blockquote|section|tr|table)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&(?:amp;)?nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function fetchArticleFullText(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url, {
      headers: SCRAPE_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;
    const text = extractArticleTextFromHtml(await res.text()).slice(0, 3000).trim();
    return text.length >= 80 ? text : null;
  } catch {
    return null;
  }
}

// ── Telegram channel fetch ──────────────────────────────────────────────────
function isTelegramMediaImage(url: string | null | undefined): boolean {
  if (!url || !isValidStoryImage(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host !== "telegram.org" && !host.endsWith(".telegram.org");
  } catch {
    return false;
  }
}

function extractPostImage(block: string): string | null {
  const anchor = block.match(/<a\b[^>]*class="[^"]*tgme_widget_message_photo_wrap[^"]*"[^>]*>/i)?.[0];
  if (anchor) {
    const bg = anchor.match(/background-image:\s*url\(\s*['"]?([^)'"]+)['"]?\s*\)/i)?.[1];
    if (bg && isTelegramMediaImage(bg)) return bg.trim();
    const from = block.indexOf(anchor);
    const end = block.indexOf("</a>", from);
    const inner = end > from ? block.slice(from, end) : "";
    const img = inner.match(/<img[^>]+src="([^"]+)"/i)?.[1];
    if (img && isTelegramMediaImage(img)) return img;
  }
  const video = block.match(/<i\b[^>]*class="[^"]*tgme_widget_message_video_thumb[^"]*"[^>]*>/i)?.[0];
  if (video) {
    const vbg = video.match(/background-image:\s*url\(\s*['"]?([^)'"]+)['"]?\s*\)/i)?.[1];
    if (vbg && isTelegramMediaImage(vbg)) return vbg.trim();
  }
  return null;
}

function isTelegramVideoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /^cdn\d*\.telesco\.pe$/i.test(u.hostname) && /\.mp4(\?|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

function extractPostVideo(block: string): string | null {
  const wrap = block.match(
    /<a\b[^>]*class="[^"]*tgme_widget_message_video_player[^"]*"[^>]*>[\s\S]*?<\/a>/i,
  )?.[0];
  if (!wrap) return null;
  const candidates = wrap.match(/<video\b[^>]*>/gi) ?? [];
  for (const tag of candidates) {
    if (/blured/i.test(tag)) continue;
    const src = tag.match(/src="([^"]+)"/i)?.[1];
    if (src && isTelegramVideoUrl(src)) return src.trim();
  }
  return null;
}

const TELEGRAM_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
};

const TELEGRAM_ENTITY_RE = /&(#x?[0-9a-f]+|[a-z]+);/gi;
function decodeHtmlEntities(html: string): string {
  return html.replace(TELEGRAM_ENTITY_RE, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    switch (entity.toLowerCase()) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      case "nbsp": return " ";
      case "hellip": return "…";
      case "mdash": return "—";
      case "ndash": return "–";
      case "rsquo": return "’";
      case "lsquo": return "‘";
      case "ldquo": return "“";
      case "rdquo": return "”";
      default: return match;
    }
  });
}

function stripTags(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).replace(/…\s*$/, "").trim();
}

type ChannelPost = {
  channel: string;
  text: string;
  url: string;
  publishedAt: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
};

function parseTelegramPostUrl(url: string): { channel: string; postId: string } | null {
  try {
    const u = new URL(url);
    if (!/^(t\.me|telegram\.me|telegram\.dog)$/i.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    let channel: string | undefined;
    let postId: string | undefined;
    if (parts[0]?.toLowerCase() === "s") {
      if (parts.length !== 3) return null;
      channel = parts[1];
      postId = parts[2];
    } else {
      if (parts.length !== 2) return null;
      channel = parts[0];
      postId = parts[1];
    }
    if (!channel || !postId || !/^\d+$/.test(postId)) return null;
    return { channel: decodeURIComponent(channel).replace(/^@/, ""), postId };
  } catch {
    return null;
  }
}

function extractSinglePostMedia(html: string, channel: string, postId: string): string | null {
  const wanted = `${channel}/${postId}`;
  const start = html.indexOf(`data-post="${wanted}"`);
  if (start < 0) return null;
  const nextWrap = html.indexOf('<div class="tgme_widget_message_wrap', start);
  const end = nextWrap > start ? nextWrap : start + 20_000;
  return extractPostImage(html.slice(start, end));
}

async function fetchTelegramPostImage(postUrl: string): Promise<string | null> {
  const parsed = parseTelegramPostUrl(postUrl);
  if (!parsed) return null;
  try {
    const res = await fetch(`https://t.me/s/${enc(parsed.channel)}/${parsed.postId}`, {
      headers: TELEGRAM_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return extractSinglePostMedia(await res.text(), parsed.channel, parsed.postId);
  } catch {
    return null;
  }
}

async function fetchTelegramPostVideo(postUrl: string): Promise<string | null> {
  const parsed = parseTelegramPostUrl(postUrl);
  if (!parsed) return null;
  try {
    const res = await fetch(`https://t.me/s/${enc(parsed.channel)}/${parsed.postId}`, {
      headers: TELEGRAM_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const wanted = `${parsed.channel}/${parsed.postId}`;
    const start = html.indexOf(`data-post="${wanted}"`);
    if (start < 0) return null;
    const nextWrap = html.indexOf('<div class="tgme_widget_message_wrap', start);
    return extractPostVideo(html.slice(start, nextWrap > start ? nextWrap : start + 20_000));
  } catch {
    return null;
  }
}

async function fetchTelegramChannel(channel: string, limit = 20): Promise<ChannelPost[]> {
  const name = channel.replace(/^@/, "").trim();
  const res = await fetch(`https://t.me/s/${enc(name)}`, {
    headers: TELEGRAM_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`t.me/s/${name} ${res.status}`);
  const html = await res.text();
  const blocks = html.match(/<div class="tgme_widget_message[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g) ?? [];
  const posts: ChannelPost[] = [];
  for (const block of blocks.slice(-limit)) {
    const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
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
      imageUrl: extractPostImage(block),
      videoUrl: extractPostVideo(block),
    });
  }
  return posts.reverse();
}

// ── Filters ─────────────────────────────────────────────────────────────────
const JUNK_DOMAINS = [
  "reddit.com", "quora.com", "pinterest.com", "facebook.com", "tiktok.com",
  "marketscreener.com", "globenewswire.com", "prnewswire.com", "businesswire.com",
  "zacks.com", "simplywall.st", "fool.com", "msn.com",
];
const BANNED_DOMAINS = [
  "timesofisrael.com", "jpost.com", "ynetnews.com", "ynet.co.il", "israelhayom.com",
  "haaretz.com", "i24news.tv", "arutzsheva.com", "israelnationalnews.com", "jns.org",
  "allisrael.com", "jewishpress.com", "timesofisrael.co.il",
];
const BANNED_SOURCE_PATTERN =
  /times of israel|jerusalem post|ynet|israel hayom|haaretz|i24|arutz sheva|israel national news|jns|all israel|jewish press/i;
const JUNK_TITLE_PATTERNS: RegExp[] = [
  /\b(form|files?)\s*(8-k|10-k|10-q|s-1|13[a-z]?)\b/i,
  /\bquiz\b/i, /\bhoroscope\b/i,
  /\bcoupon|discount code|deal of the day\b/i,
  /\b(shares?|stock)\s+(rise|fall|gain|drop)s?\s+\d+(\.\d+)?%/i,
  /\bearnings call transcript\b/i,
  /\bcrossword|wordle\b/i, /\bgiveaway|sweepstake\b/i,
  /\bwatch (live|online) free\b/i,
  /\b(live updates?|live blog|as it happened)\b/i,
  /\b(in focus|weekly roundup|week in review|sunday shows? preview|podcast|episode)\b/i,
];
const DISRESPECT_PATTERNS: RegExp[] = [
  /\b(dirty|filthy|savage|barbaric|inferior)\s+(kurds?|muslims?|arabs?|persians?|iranians?)\b/i,
  /\b(kurds?|muslims?|iranians?)\s+(are|is)\s+(terrorists?|animals?|vermin|scum|subhuman)\b/i,
  /\b(all|every)\s+muslims?\s+(are|is)\b/i,
  /\bislam(ic)?\s+(cancer|plague|virus|disease)\b/i,
  /\bdeath to (islam|muslims|kurds)\b/i,
  /\bexterminate\s+(the\s+)?(kurds?|muslims?)\b/i,
  /\b(kurds?|kurdish|peshmerga|kurdistan)\b[^.]{0,40}\b(terrorists?|traitors?|separatist threat|must be crushed|deserve)\b/i,
  /\b(anti[- ]?(islam|muslim)|islamophob\w+|ban (the )?(quran|hijab|mosques?))\b/i,
  /\b(quran|koran|mosque|prophet muhammad)\b[^.]{0,30}\b(burn(ed|ing)?|desecrat\w+|insult\w*|mock\w*)\b/i,
];
const NEGATIVE_IRAN_PATTERNS: RegExp[] = [
  /\b(khamenei|supreme leader|pezeshkian|qalibaf|ghalibaf|larijani|araghchi|salami|irgc chief)\b[^.]{0,60}\b(could die|near death|dying|critical condition|dead|health crisis|incapacitat\w+|coma|fled|hiding|ousted|toppl\w+)\b/i,
  /\b(iran(ian)?|tehran|islamic republic)\b[^.]{0,60}\b(regime (change|collapse|fall|crumbl\w+)|on the brink of collapse|about to fall|humiliat\w+|defeated|surrender\w*|begging|desperate|crushed|obliterat\w+|kneel\w*|doomed|hopeless)\b/i,
  /\b(uprising|revolt|protests?)\b[^.]{0,40}\b(topple|overthrow|end of the (regime|islamic republic))\b/i,
  /\bpost[- ]?(khamenei|islamic republic) (iran|era)\b/i,
  /\b(report claims?|a report claims?|sources? claim|rumou?rs? (say|claim|suggest))\b[^.]{0,60}\b(die|death|dead|dying|assassinat\w+|flee|fled)\b/i,
  /\biran(?:ian|'s)?\b[^.]{0,80}\b(propaganda|brainwash\w*|deception|disinformation machine|war spectacle)\b/i,
];
const SOFT_NEWS_PATTERNS: RegExp[] = [
  /\b(football|soccer|volleyball|basketball|wrestling|weightlifting|futsal|goalkeep\w*|striker|midfielder|league|premier league|world cup|olympic|championship|tournament|match|derby|coach|club|esteghlal|persepolis|sepahan|tractor)\b/i,
  /\b(film|movie|cinema|festival|actor|actress|director'?s cut|box office|series|drama|music|singer|concert|album|art exhibition|museum|carpet weaving|handicraft)\b/i,
  /\b(recipe|cuisine|restaurant|tourism|tourist|travel guide|hotel|resort|nowruz celebration|fashion|celebrity|royal family|dating|horoscope)\b/i,
  /\b(earthquake drill|weather forecast|air pollution index|traffic accident|road crash|bus crash|train derail)\b/i,
  /\b(school shooting|mass shooting)\b/i,
  /\b(caspian sea convention|delimitation of (the )?(seabed|subsoil)|urmia lake)\b/i,
];
const BEAT_PATTERNS: RegExp[] = [
  /\b(iran|iranian|tehran|irgc|khamenei|pezeshkian|qalibaf|ghalibaf|araghchi|larijani|islamic republic|persian gulf|hormuz)\b/i,
  /\b(iraq|iraqi|baghdad|basra|mosul|erbil|sulaymaniyah|kurdistan region|najaf|karbala|sistani|sudani|pmf|hashd)\b/i,
  /\b(hezbollah|houthi|ansar allah|kataib|nujaba|axis of resistance|hamas|militia|proxy|proxies)\b/i,
  /\b(nuclear|uranium|enrich\w*|iaea|sanction\w*|snapback|jcpoa)\b/i,
  /\b(centcom|pentagon|us (navy|military|forces|troops)|carrier strike group|airstrike|air strike|missile|drone|ballistic|ceasefire|war|attack|strike)\b/i,
  /\b(oil|crude|brent|opec|barrel|refinery|tanker|shipping lane|red sea|bab el-?mandeb|gold price|bullion|energy market)\b/i,
  /\b(middle east|gulf states|saudi|riyadh|qatar|uae|oman|bahrain|kuwait|syria|lebanon|yemen|turkey|ankara)\b/i,
];

function gateOk(ok: boolean, reason: string): { ok: boolean; reason?: string } {
  return ok ? { ok: true } : { ok: false, reason };
}

function sourceBanGate(a: Article): { ok: boolean; reason?: string } {
  const host = hostOf(a.url);
  if (BANNED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return gateOk(false, `banned source: ${host}`);
  if (a.sourceName && BANNED_SOURCE_PATTERN.test(a.sourceName)) return gateOk(false, `banned source: ${a.sourceName}`);
  if (BANNED_SOURCE_PATTERN.test(a.title)) return gateOk(false, "banned source attribution in title");
  return gateOk(true, "");
}
function junkGate(a: Article): { ok: boolean; reason?: string } {
  const host = hostOf(a.url);
  if (JUNK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return gateOk(false, `junk domain: ${host}`);
  if (JUNK_TITLE_PATTERNS.some((p) => p.test(a.title))) return gateOk(false, "junk title pattern");
  if (a.title.trim().length < 15) return gateOk(false, "title too short");
  return gateOk(true, "");
}
function respectGate(a: Article): { ok: boolean; reason?: string } {
  const text = `${a.title} ${a.description ?? ""}`;
  if (DISRESPECT_PATTERNS.some((p) => p.test(text))) return gateOk(false, "disrespectful to Kurds/Muslims");
  if (NEGATIVE_IRAN_PATTERNS.some((p) => p.test(text))) return gateOk(false, "demoralising/unsourced negative Iran framing");
  return gateOk(true, "");
}
function relevanceGate(a: Article): { ok: boolean; reason?: string } {
  const text = `${a.title} ${a.description ?? ""}`;
  if (SOFT_NEWS_PATTERNS.some((p) => p.test(text))) return gateOk(false, "off-beat soft news");
  const hits = BEAT_PATTERNS.filter((p) => p.test(text)).length;
  if (hits === 0) return gateOk(false, "unrelated to the conflict beat");
  if (hits === 1 && BEAT_PATTERNS[6]!.test(text) && !/iran|iraq|us |u\.s\./i.test(text)) {
    return gateOk(false, "only tangential regional mention");
  }
  const genericWarMention = /\biran war\b/i.test(text);
  const concreteEvent = /\b(attack|strike|missile|drone|killed|wounded|ceasefire|agreement|talks|negotiat|sanction|export|oil|hormuz|nuclear|military|government|minister|president|leader|commander|parliament|statement|announc|warn|percent|%)\b/i.test(text);
  if (genericWarMention && !concreteEvent) return gateOk(false, "Iran war is only a passing mention");
  return gateOk(true, "");
}

const NON_LATIN_SCRIPT = /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0900-\u097F\u0980-\u09FF\u0A00-\u0D7F\u0E00-\u0E7F\u10A0-\u10FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/u;
const ACCENTED_LATIN = /[àâäãáçéèêëíìîïñóòôöõúùûüýÿåæøœšžğışİ]/i;
const ENGLISH_MARKERS = new Set(
  "the a an and or but of to in on for from with by as at is are was were has have had will would could should says said after before over into amid about against its their his her this that these those new more not no under during between".split(" "),
);
const FOREIGN_MARKERS = new Set(
  "el los las del una unos unas con por para que como sobre entre desde este esta são não uma dos das pelo pela mais após contra les des une aux dans pour avec sur elle ils leur cette entre depuis contre après plus être ont der die das und ist nicht ein eine mit auf für von den dem sich auch werden gli della delle nella sono anche dopo contro het een van zijn niet voor bir ve ile için olarak dan yang dengan untuk".split(" "),
);

function isEnglishText(raw: string): { ok: boolean; reason?: string } {
  const text = raw.replace(/https?:\/\/\S+/g, " ");
  if (NON_LATIN_SCRIPT.test(text)) return gateOk(false, "non-English script");
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length < 4) return gateOk(false, "insufficient English text");
  const markers = words.filter((w) => ENGLISH_MARKERS.has(w)).length;
  const foreign = words.filter((w) => FOREIGN_MARKERS.has(w)).length;
  if (foreign >= 2 && foreign >= markers) return gateOk(false, "non-English (Latin-script) language");
  const accentRatio = (text.match(new RegExp(ACCENTED_LATIN, "gi")) ?? []).length / text.length;
  if (accentRatio > 0.03) return gateOk(false, "heavy non-English diacritics");
  if (markers < 2 && markers / words.length < 0.08) return gateOk(false, "language is not confidently English");
  return gateOk(true, "");
}
function freshnessGate(a: Article, maxAgeHours = 24): { ok: boolean; reason?: string } {
  if (!a.publishedAt) return gateOk(false, "no publish date");
  const ts = Date.parse(a.publishedAt);
  if (Number.isNaN(ts)) return gateOk(false, "unparseable publish date");
  const ageHours = (Date.now() - ts) / 3_600_000;
  if (ageHours < -1) return gateOk(false, "publish date is in the future");
  if (ageHours > maxAgeHours) return gateOk(false, `stale (${Math.round(ageHours)}h old)`);
  return gateOk(true, "");
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF ]+/g, " ").replace(/\s+/g, " ").trim();
}
const STOPWORDS = new Set(
  "the a an of in on at to for and or with by from as is are was were be been says said after over into amid new live update updates latest breaking report reports could would should about against their his her its denies say thought".split(" "),
);
function topTokens(title: string, n = 6): string[] {
  return normalizeTitle(title).split(" ").filter((w) => w.length > 3 && !STOPWORDS.has(w)).slice(0, n).sort();
}
function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.protocol = "https:";
    u.hostname = u.hostname.replace(/^www\./, "").toLowerCase();
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref|oc$|amp)/i.test(key)) u.searchParams.delete(key);
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return null;
  }
}
async function canonicalKey(a: Article): Promise<string> {
  const normalized = normalizeUrl(a.url);
  if (normalized) return "u:" + (await sha256hex(normalized)).slice(0, 32);
  const day = a.publishedAt ? new Date(a.publishedAt).toISOString().slice(0, 10) : "nodate";
  const fp = [hostOf(a.url) || a.sourceName || "unknown", day, topTokens(a.title).join("-"), normalizeTitle(a.title)].join("|");
  return "f:" + (await sha256hex(fp)).slice(0, 32);
}
function titleSimilarity(a: string, b: string): number {
  const sa = new Set(normalizeTitle(a).split(" ").filter((w) => w.length > 2));
  const sb = new Set(normalizeTitle(b).split(" ").filter((w) => w.length > 2));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}
const EVENT_ALIASES: Array<[RegExp, string]> = [
  [/\b(united states|u\.s\.|us|america|american)\b/gi, "usa"],
  [/\b(donald trump|president trump|trump)\b/gi, "trump"],
  [/\b(pete hegseth|hegseth)\b/gi, "hegseth"],
  [/\b(islamic revolutionary guard corps|revolutionary guards?|irgc)\b/gi, "irgc"],
  [/\b(houthis?|ansar allah)\b/gi, "houthi"],
  [/\b(hezbollah|hizbullah)\b/gi, "hezbollah"],
  [/\b(strait of hormuz|hormuz strait)\b/gi, "hormuz"],
  [/\b(missiles?|rockets?|interceptors?|ammunition|munitions)\b/gi, "missile"],
  [/\b(stockpiles?|inventor(?:y|ies)|running low|shortages?)\b/gi, "stockpile"],
  [/\b(clash(?:ed)?|confront(?:ed|ation)?|disput(?:e|ed)|den(?:y|ies|ied))\b/gi, "dispute"],
  [/\b(strik(?:e|es|ing)|attack(?:s|ed)?|bomb(?:s|ed|ing)?|hit(?:s)?)\b/gi, "attack"],
  [/\b(reopen(?:ing)?|open(?:ing)?|restore(?:d|s)? access)\b/gi, "reopen"],
  [/\b(deal|agreement|memorandum|understanding|talks?|negotiations?)\b/gi, "agreement"],
  [/\b(ship|vessel|tanker)\b/gi, "vessel"],
  [/\b(conditions?|demands?|terms?|requirements?)\b/gi, "condition"],
];
function eventTokens(text: string): Set<string> {
  let normalized = text.toLowerCase();
  for (const [pattern, replacement] of EVENT_ALIASES) normalized = normalized.replace(pattern, replacement);
  return new Set(normalizeTitle(normalized).split(" ").filter((word) => word.length > 3 && !STOPWORDS.has(word)));
}
function eventSimilarity(a: string, b: string): number {
  const left = eventTokens(a);
  const right = eventTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((token) => right.has(token)).length;
  const containment = shared / Math.min(left.size, right.size);
  const union = left.size + right.size - shared;
  return containment * 0.7 + (union ? shared / union : 0) * 0.3;
}
function sameEvent(a: string, b: string, threshold = 0.52): boolean {
  const semanticThreshold = Math.min(0.78, threshold + 0.04);
  return titleSimilarity(a, b) >= threshold || eventSimilarity(a, b) >= semanticThreshold;
}
const ARABIC_SCRIPT = /[\u0600-\u06FF]/u;
function crossLanguageSimilarity(a: string, b: string): number {
  const aArabic = ARABIC_SCRIPT.test(a);
  const bArabic = ARABIC_SCRIPT.test(b);
  if (aArabic === bArabic) return 0;
  const latinTokens = (text: string): Set<string> => {
    const set = new Set<string>();
    for (const w of text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) {
      if (w.length < 4 || STOPWORDS.has(w)) continue;
      set.add(w);
    }
    return set;
  };
  const left = latinTokens(a);
  const right = latinTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const t of left) if (right.has(t)) shared += 1;
  if (shared < 2) return 0;
  if (shared < 3 && Math.min(left.size, right.size) < 4) return 0;
  return shared / Math.min(left.size, right.size);
}

function normalizeEditorial(text: string): string {
  if (!text) return text;
  let out = text;
  out = out
    .replace(/\bnorthern\s+iraq\b/gi, "Kurdistan Region")
    .replace(/\bnorth\s+of\s+iraq\b/gi, "Kurdistan Region")
    .replace(/\bnorthern\s+iraqi\b/gi, "Kurdistan Region");
  out = out.replace(/باکو[وڕر]*[یي]?\s*(?:ع|ئ)[ێيی]?راق/g, "هەرێمی کوردستان");
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", quot: '"', apos: "'", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C",
  rdquo: "\u201D", hellip: "\u2026", ndash: "\u2013", mdash: "\u2014", lt: "<", gt: ">", amp: "&",
};
function decodeAllEntities(input: string): string {
  let out = input;
  for (let pass = 0; pass < 3; pass++) {
    const next = out
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
    if (next === out) break;
    out = next;
  }
  return out;
}
function cleanEditorialText(value: string): string {
  return decodeAllEntities(
    decodeAllEntities(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/https?:\/\/t\.co\/\S+/gi, " ")
    .replace(/pic\.twitter\.com\/\S+/gi, " ")
    .replace(/\s*The post .{0,160}? appeared first on .{0,60}?\.?\s*$/i, "")
    .replace(/\b(?:Iran[–-]?(?:US|USA)|US[–-]?Iran)\s+(?:live\s+)?updates?\s*[:|–-]?/gi, "")
    .replace(/\b(?:live updates?|live blog|as it happened)\s*[:|–-]?/gi, "")
    .replace(/\s*\*\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:©\s*\d{4}|copyright\b)[^]*?all rights reserved\.?/gi, " ")
    .replace(/\ball rights reserved\.?/gi, " ")
    .replace(/\b(?:reproduction|redistribution|republish(?:ing)?|reprint(?:ing)?)\s+(?:is|are)\s+(?:prohibited|not\s+(?:permitted|allowed))\b[^.!?]*/gi, " ")
    .replace(/\b(?:this material|this content|this article|this story)\s+(?:is protected by copyright and )?may\s+(?:not\s+)?be\s+(?:published|broadcast|rewritten|redistributed|reproduced|transmitted|republished|reprinted|copied)[^.!?]*/gi, " ")
    .replace(/نابێت بڵاوبکرێتەوە[^.!?]*/g, " ")
    .replace(/\b(?:read more|read (?:the )?full (?:story|article)|continue reading|read next)\b\.?/gi, " ")
    .replace(/\b(?:sign up for|subscribe to|download our|follow us on|access the unrivaled)\b[^.!?]*/gi, " ")
    .replace(/([.!?])\s+[.!?،؛]+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function hasIncompleteSummary(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  if (/(?:\.\.\.|…)$/.test(value)) return true;
  return value.length > 120 && !/[.!?""']$/.test(value);
}
function leadSentences(text: string, maxChars = 550): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= maxChars) return value;
  const head = value.slice(0, maxChars);
  const boundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("\n"));
  if (boundary > 60) return head.slice(0, boundary + 1).trim();
  const space = head.lastIndexOf(" ");
  const cut = space > 60 ? head.slice(0, space).trim() : head.trim();
  return /[.!?]$/.test(cut) ? cut : `${cut}.`;
}

const LEADER_PATTERN =
  /\b(khamenei|pezeshkian|qalibaf|ghalibaf|larijani|araghchi|salami|bagheri|shamkhani|raisi|zarif|supreme leader|iran'?s? president|parliament speaker|irgc (chief|commander)|foreign minister|trump|vance|rubio|hegseth|netanyahu|nasrallah|qassem|al[- ]sudani|sistani|erdogan|mbs|bin salman)\b/i;
const SPEECH_PATTERN =
  /\b(speech|speaks?|spoke|address(?:es|ed)?|remarks?|statement|declares?|declared|warns?|warned|vows?|vowed|says?|said|tells?|told|announce[sd]?|threatens?|ultimatum|press conference|sermon|interview)\b/i;
function isLeaderStatement(text: string): boolean {
  return LEADER_PATTERN.test(text) && SPEECH_PATTERN.test(text);
}
const SEVERITY_L3 = /\b(all-?out war|full-?scale (war|offensive|invasion)|ground (offensive|invasion|operation)|invasion of|nuclear (strike|attack|exchange)|state of war)\b/i;
const SEVERITY_L2 = /\b(airstrike|air strike|bombed|bombing|shelling|missile (attack|strike|barrage|salvo)|drone (attack|strike)|strikes? on|casualt|death toll|massacr|\d+ killed|killed \d+|escalat|intense (fighting|clashes)|mass casualties)\b/i;
const SEVERITY_L1 = /\b(war|military (action|operation|strike)|clash(es)?|fighting|mobiliz|deploy(ed|ment)?|naval (movement|buildup|deployment)|ultimatum|sanctions?|ceasefire)\b/i;
function severityLevel(text: string): number {
  if (SEVERITY_L3.test(text)) return 3;
  if (SEVERITY_L2.test(text)) return 2;
  if (SEVERITY_L1.test(text)) return 1;
  return 0;
}
const SEVERITY_POINTS: Record<number, number> = { 0: 0, 1: 20, 2: 45, 3: 80 };

function keywordCategory(text: string): string | null {
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
const CATEGORY_PRIORITY: Record<string, number> = {
  iraq: 70, war: 60, iran: 50, "middle-east": 42, analysis: 34, proxies: 45,
  gold: 30, usa: 30, oil: 25, "economic-impact": 20,
};
function isBreaking(category: string, text: string, breakingCategories: string[]): boolean {
  if (!breakingCategories.includes(category)) return false;
  const hardSignals =
    /\b(strike|strikes|attack|attacked|missile|drone|killed|kills|assassinat|retaliat|launch(ed)?|invasion|war|ceasefire|ultimatum|sanction(s|ed)?|warns?|airstrike|air strike|bomb(ed|ing)?|shelling|barrage|salvo|casualt|death toll|escalat)\b/i;
  return hardSignals.test(text) || severityLevel(text) >= 2;
}

// ── AI: Groq rewrite (rich English summary) ────────────────────────────────
async function groqRewrite(items: Array<{ title: string; description: string | null }>): Promise<Array<{ headline: string; summary: string }>> {
  if (!GROQ_API_KEY || items.length === 0) return items.map((i) => ({ headline: i.title, summary: i.description ?? "" }));
  const messages = [
    {
      role: "system",
      content: `You are a wire editor for an Iraqi, Muslim, pro-Iran regional news channel. Return ONLY a JSON object mapping each item's number to its rewrite, one {"headline": string, "summary": string} per input, e.g. {"1": {"headline": "...", "summary": "..."}}.\nRules:\n- Headline: factual, under 110 characters, no clickbait or feed labels.\n- Summary: write a RICH, COMPLETE, self-contained news summary (3-5 sentences) that stands alone — a reader must understand the full story WITHOUT opening the source link. Lead with who did what, where and when. Then explain why it matters and, when the source provides it, weave in the background and context and any conflicting accounts, attributed inline ("Iran says…", "Israel says…", "the Pentagon says…"). Carry over every concrete fact — names, numbers, quotes, places, casualty counts, prices, percentages.\n- Aim for roughly 60-150 words; a terse one-liner is a failure. Never just repeat the headline.\n- Do NOT invent facts. Do not add opinion or hostile framing about Iran. Professional English only.\n- Never end with an ellipsis or an unfinished clause.`,
    },
    {
      role: "user",
      content: JSON.stringify(items.map((item, i) => ({ [String(i + 1)]: { title: item.title, description: item.description?.slice(0, 2400) ?? null } }))),
    },
  ];
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, temperature: 0, max_tokens: 4000, response_format: { type: "json_object" } }),
      signal: AbortSignal.timeout(45_000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Groq ${res.status}`);
    const json = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content) as Record<string, { headline?: string; summary?: string }>;
    return items.map((item, i) => {
      const row = parsed[String(i + 1)] ?? {};
      let summary = String(row.summary ?? "").trim();
      if (!summary) summary = item.description ?? "";
      if (!/[.!?]$/.test(summary) && summary.length > 0) summary += ".";
      return { headline: String(row.headline ?? item.title ?? "").trim(), summary };
    });
  } catch {
    return items.map((i) => ({ headline: i.title, summary: i.description ?? "" }));
  }
}

// ── AI: Gemini direct translation (Sorani) ─────────────────────────────────
const GEMINI_DIRECT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_DIRECT_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]; // chain: 3.6 -> 3.5 -> 3.5-lite (never hit limits on lite)
const SORANI_SYSTEM_PROMPT =
  "Translate the following message into Kurdish Sorani (Central Kurdish, in the Sorani script). Output ONLY the translation — no commentary, no \"Translation:\" prefix, no quotes around the text. Preserve emojis, links, line breaks, and any formatting exactly.";
const SORANI_SYSTEM_PROMPT_STRICT =
  "Translate the following message into Kurdish Sorani (Central Kurdish). You MUST output ONLY the translation in the Sorani Arabic script (ئەلفوبێی عەرەبیی سۆرانی). Do NOT answer in English or Latin script — translate every word into Sorani script except widely-recognised abbreviations (CIA, US, UN, NATO, CEO). Do NOT add commentary, explanations, a \"Translation:\" prefix, or quotes. Output ONLY the Sorani translation. Preserve emojis, links, line breaks, and formatting exactly.";

const SORANI_ALLOWED =
  /^[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF0-9\s\p{P}\p{S}\p{Extended_Pictographic}A-Za-z.-]*$/u;
function validateSorani(text: string): boolean {
  if (!text.trim()) return false;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const arabic = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) ?? []).length;
  if (arabic < 2) return false;
  if (latin > Math.max(24, arabic * 0.35)) return false;
  return SORANI_ALLOWED.test(text);
}

function cleanGeminiTranslation(raw: string): string {
  let text = raw.trim();
  const lines = text.split(/\r?\n/);
  while (lines.length > 0) {
    const head = (lines[0] ?? "").trim();
    if (!head) break;
    if (/^(here(\u2019s|'s| is)?|translation[:\uFF1A]|the (standard |english |kurdish )?translation|in (kurdish|sorani|english)[:\uFF1A]?|output[:\uFF1A])/i.test(head) && !/^[\u0600-\u06FF]/.test(head)) {
      lines.shift();
    } else break;
  }
  text = lines.join("\n").trim();
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  return text.replace(/^\s*[-*]\s+/gm, "").trim();
}

// Best-effort Gemini usage logging so the admin console per-key × per-model
// cards stay truthful (they read gemini_call_log + gemini_key_usage). Never
// throws — usage logging must not break translation.
async function logGeminiCall(c) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await rest("gemini_call_log", {
      method: "POST",
      body: {
        key_index: c.keyIndex, model: c.model, direction: "sorani",
        ok: c.ok, code: c.code, message: String(c.message).slice(0, 200),
      },
      prefer: "return=minimal",
    });
    const existing = await rest("gemini_key_usage", {
      query: `day=eq.${today}&key_index=eq.${c.keyIndex}&model=eq.${encodeURIComponent(c.model)}&limit=1`,
    });
    const row = Array.isArray(existing) ? existing[0] : undefined;
    const inc = {
      calls: 1, ok: c.ok ? 1 : 0,
      rate_limited: c.code === 429 ? 1 : 0,
      other_errors: !c.ok && c.code !== 429 ? 1 : 0,
    };
    if (row?.id) {
      await rest(`gemini_key_usage?id=eq.${row.id}`, {
        method: "PATCH",
        body: {
          calls: Number(row.calls ?? 0) + inc.calls,
          ok: Number(row.ok ?? 0) + inc.ok,
          rate_limited: Number(row.rate_limited ?? 0) + inc.rate_limited,
          other_errors: Number(row.other_errors ?? 0) + inc.other_errors,
        },
        prefer: "return=minimal",
      });
    } else {
      await rest("gemini_key_usage", {
        method: "POST",
        body: {
          day: today, key_index: c.keyIndex, model: c.model,
          calls: inc.calls, ok: inc.ok,
          rate_limited: inc.rate_limited, other_errors: inc.other_errors,
        },
        prefer: "return=minimal",
      });
    }
  } catch { /* best-effort only */ }
}

const GEMINI_MIN_INTERVAL_MS = 6500;
const keyNextAt = new Map<number, number>();

async function geminiTranslateOnce(text: string, glossary: string | undefined): Promise<{ text: string; model: string; keyIndex: number } | null> {
  const keys = geminiKeys();
  if (keys.length === 0) return null;
  const deadKeys = new Set<number>();
  for (const model of GEMINI_DIRECT_MODELS) {
    for (const { index, key } of keys) {
      if (deadKeys.has(index)) continue;
      const now = Date.now();
      const wait = (keyNextAt.get(index) ?? 0) - now;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      keyNextAt.set(index, Date.now() + GEMINI_MIN_INTERVAL_MS);

      const glossaryBlock = glossary?.trim() ? `TRANSLATION GLOSSARY — use these exact translations for key terms:\n${glossary.trim()}\n\n` : "";
      const prompt = `${glossaryBlock}${SORANI_SYSTEM_PROMPT}\n\nMessage:\n${text.slice(0, 2500)}`;
      let res: Response;
      try {
        res = await fetch(`${GEMINI_DIRECT_ENDPOINT}/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 4096 },
          }),
          signal: AbortSignal.timeout(45_000),
        });
      } catch (fetchErr) {
        await logGeminiCall({ keyIndex: index, model, ok: false, code: 0, message: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) });
        continue;
      }
      const data = (await res.json().catch(() => null)) as {
        error?: { code?: number; message?: string };
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      };
      if (!res.ok || data?.error) {
        const code = data?.error?.code ?? res.status;
        await logGeminiCall({ keyIndex: index, model, ok: false, code, message: data?.error?.message ?? `HTTP ${res.status}` });
        if (code === 400 || code === 401 || code === 403) deadKeys.add(index);
        continue;
      }
      if (data?.candidates?.[0]?.finishReason === "MAX_TOKENS") {
        await logGeminiCall({ keyIndex: index, model, ok: false, code: 500, message: "MAX_TOKENS truncation" });
        continue;
      }
      const out = cleanGeminiTranslation((data?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? "").join(""));
      if (out && validateSorani(out)) {
        await logGeminiCall({ keyIndex: index, model, ok: true, code: 200, message: "ok" });
        return { text: out, model, keyIndex: index };
      }
      await logGeminiCall({ keyIndex: index, model, ok: false, code: 500, message: "invalid Sorani output" });
    }
  }
  return null;
}

// MiniMax fallback via the Vercel AI Gateway (same as the old pipeline).
async function minimaxTranslate(text: string, strict: boolean): Promise<string | null> {
  if (!MINIMAX_API_KEY) return null;
  try {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MINIMAX_API_KEY}` },
      body: JSON.stringify({
        model: "minimax/minimax-m3",
        messages: [
          { role: "system", content: strict ? SORANI_SYSTEM_PROMPT_STRICT : SORANI_SYSTEM_PROMPT },
          { role: "user", content: text.slice(0, 1500) },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const out = (json.choices?.[0]?.message?.content ?? "").trim();
    return validateSorani(out) ? out : null;
  } catch {
    return null;
  }
}

async function translateToSorani(text: string, glossary: string | undefined): Promise<{ text: string | null; model: string }> {
  const direct = await geminiTranslateOnce(text, glossary);
  if (direct) return { text: direct.text, model: direct.model };
  // NO Groq in the translation chain — the user wants Gemini → MiniMax → English.
  const mmNormal = await minimaxTranslate(text, false);
  if (mmNormal) return { text: mmNormal, model: "minimax/minimax-m3" };
  const mmStrict = await minimaxTranslate(text, true);
  if (mmStrict) return { text: mmStrict, model: "minimax/minimax-m3" };
  return { text: null, model: "none" };
}

// ── Telegram send ───────────────────────────────────────────────────────────
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
type Post = {
  headline: string;
  summary: string;
  sourceName: string;
  url: string;
  imageUrl: string | null;
  videoUrl: string | null;
  originalPublishedAt: string | null;
  breaking: boolean;
  timezone: string;
  extraSources: Array<{ name: string; url: string }>;
};
type PostFormat = {
  footer?: string | null;
  emoji?: string | null;
  linkLabel?: string | null;
  showSource?: boolean;
  showTimestamp?: boolean;
  breakingPrefix?: string | null;
  linkPreview?: boolean;
};
const DEFAULT_FOOTER = "⚡ Delivered by Freebuff";
const DEFAULT_EMOJI = "🗞";
const DEFAULT_LINK_LABEL = "Read the full report";

function formatMessage(post: Post, fmt: PostFormat = {}): string {
  const when = post.originalPublishedAt
    ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: post.timezone }).format(new Date(post.originalPublishedAt))
    : "";
  const sources = [{ name: post.sourceName, url: post.url }, ...(post.extraSources ?? [])];
  const breakingPrefix = post.breaking && fmt.breakingPrefix ? fmt.breakingPrefix : "";
  const hasTitle = Boolean(post.headline.trim());
  const headline = hasTitle ? `${breakingPrefix}${post.headline}` : "";
  const summary = hasTitle ? post.summary : `${breakingPrefix}${post.summary}`;
  // PostgREST returns NULL for unset settings, so treat null like "use the
  // default"; an empty string still means "disable this line" explicitly.
  const footer = fmt.footer == null ? DEFAULT_FOOTER : fmt.footer;
  const emoji = fmt.emoji == null ? DEFAULT_EMOJI : fmt.emoji;
  const linkLabel = fmt.linkLabel == null ? DEFAULT_LINK_LABEL : fmt.linkLabel;
  const lines: string[] = [];
  if (headline.trim()) lines.push(`<b>${escapeHtml(headline)}</b>`, "");
  lines.push(escapeHtml(summary));
  if (fmt.showSource !== false) {
    const whenPart = fmt.showTimestamp === false || !when ? "" : ` · ${escapeHtml(when)}`;
    lines.push("", `${emoji ? `${escapeHtml(emoji)} ` : ""}<i>${escapeHtml(post.sourceName)}</i>${whenPart}`);
  }
  if (sources.length > 1) {
    lines.push(`Sources: ${sources.map((s) => escapeHtml(s.name)).join(", ")}`);
  } else {
    lines.push(`<a href="${escapeHtml(post.url)}">${escapeHtml(linkLabel || "")}</a>`);
  }
  if (footer) lines.push("", `<i>${escapeHtml(footer)}</i>`);
  return lines.join("\n");
}

function trimSentenceTo(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = text.slice(0, budget);
  const boundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf(".\n"), head.lastIndexOf("!\n"), head.lastIndexOf("?\n"));
  if (boundary > 20) return head.slice(0, boundary + 1).trimEnd();
  const space = head.lastIndexOf(" ");
  if (space > 20) return `${head.slice(0, space).trimEnd()}…`;
  return `${head.trimEnd()}…`;
}
function fitCaption(text: string, maxChars = 1024): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  let tailStart = lines.findIndex((l) => l.startsWith("🗞 ") || l.startsWith("Sources:") || l.startsWith("<a href=") || l.startsWith("<i>"));
  if (tailStart === -1) tailStart = lines.length;
  const headStart = (lines[0] ?? "").startsWith("<b>") ? 2 : 0;
  if (headStart >= tailStart) return `${text.slice(0, maxChars - 1).trimEnd()}…`;
  const summaryBlock = lines.slice(headStart, tailStart).join("\n");
  const overhead = text.length - summaryBlock.length;
  const budget = Math.max(60, maxChars - overhead);
  if (summaryBlock.length <= budget) return text.slice(0, maxChars).trimEnd();
  lines.splice(headStart, tailStart - headStart, trimSentenceTo(summaryBlock, budget));
  return lines.join("\n");
}

async function telegramCall(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  const json = JSON.parse(body) as { ok?: boolean; result?: unknown; description?: string };
  if (!res.ok || !json.ok) throw new Error(`Telegram ${method} [${res.status}]: ${json.description ?? body.slice(0, 200)}`);
  return json.result as Record<string, unknown>;
}

type Downloaded = { bytes: ArrayBuffer; filename: string; contentType: string };
async function downloadImage(url: string, kind: "image" | "video"): Promise<Downloaded | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: kind === "image" ? "image/avif,image/webp,image/*,*/*;q=0.8" : "video/mp4,video/*;q=0.9,*/*;q=0.8",
        referer: "https://t.me/",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(kind === "image" ? 15_000 : 60_000),
    });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.startsWith(kind === "image" ? "image/" : "video/")) return null;
    const bytes = await res.arrayBuffer();
    const cap = kind === "image" ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
    if (bytes.byteLength === 0 || bytes.byteLength > cap) return null;
    const ext = (ct.split("/")[1] || (kind === "image" ? "jpg" : "mp4")).replace(/^jpeg$/, "jpg").split(";")[0].trim();
    return { bytes, filename: `${kind === "image" ? "photo" : "video"}.${ext || (kind === "image" ? "jpg" : "mp4")}`, contentType: ct };
  } catch {
    return null;
  }
}
async function sendPhotoFile(chatId: number, image: Downloaded, caption: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("photo", new Blob([image.bytes], { type: image.contentType }), image.filename);
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
  const json = (await res.json()) as { ok?: boolean; description?: string };
  if (!res.ok || !json.ok) throw new Error(`Telegram sendPhoto upload: ${json.description ?? "failed"}`);
}
async function sendVideoUrl(chatId: number, videoUrl: string, thumbUrl: string | null, caption: string): Promise<void> {
  const payload: Record<string, unknown> = { chat_id: String(chatId), video: videoUrl, caption, parse_mode: "HTML", supports_streaming: true };
  if (thumbUrl) payload.thumb = thumbUrl;
  await telegramCall("sendVideo", payload);
}
async function sendVideoFileUpload(chatId: number, video: Downloaded, thumb: Downloaded | null, caption: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("supports_streaming", "true");
  form.append("video", new Blob([video.bytes], { type: video.contentType }), video.filename);
  if (thumb) form.append("thumb", new Blob([thumb.bytes], { type: thumb.contentType }), thumb.filename);
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  const json = (await res.json()) as { ok?: boolean; description?: string };
  if (!res.ok || !json.ok) throw new Error(`Telegram sendVideo upload: ${json.description ?? "failed"}`);
}

async function sendPost(chatId: number, post: Post, fmt?: PostFormat): Promise<{ mode: "photo" | "video" | "text" }> {
  const text = formatMessage(post, fmt);
  if (post.videoUrl) {
    const video = post.videoUrl;
    const thumb = post.imageUrl ?? null;
    try {
      await sendVideoUrl(chatId, video, thumb, fitCaption(text));
      return { mode: "video" };
    } catch {
      const downloadedVideo = await downloadImage(video, "video");
      if (downloadedVideo) {
        try {
          const downloadedThumb = thumb ? await downloadImage(thumb, "image") : null;
          await sendVideoFileUpload(chatId, downloadedVideo, downloadedThumb, fitCaption(text));
          return { mode: "video" };
        } catch {
          /* fall through */
        }
      }
    }
  }
  if (post.imageUrl) {
    try {
      await telegramCall("sendPhoto", { chat_id: chatId, photo: post.imageUrl, caption: fitCaption(text), parse_mode: "HTML" });
      return { mode: "photo" };
    } catch {
      const downloaded = await downloadImage(post.imageUrl, "image");
      if (downloaded) {
        try {
          await sendPhotoFile(chatId, downloaded, fitCaption(text));
          return { mode: "photo" };
        } catch {
          /* fall through to text */
        }
      }
    }
  }
  await telegramCall("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: fmt?.linkPreview === false ? true : Boolean(post.imageUrl) } });
  return { mode: "text" };
}

// ── Cadence ─────────────────────────────────────────────────────────────────
function minutesOfDay(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(d);
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
function isNight(s: SettingsRow): boolean {
  const now = minutesOfDay(new Date(), String(s.timezone ?? "Asia/Baghdad"));
  return inWindow(now, parseTime(String(s.night_start ?? s.nightStart ?? "23:00")), parseTime(String(s.night_end ?? s.nightEnd ?? "08:00")));
}
function randomInt(lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function localDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// ── Data access ─────────────────────────────────────────────────────────────
async function getSettings(): Promise<SettingsRow | null> {
  const rows = await rest<SettingsRow[]>("settings", { query: "select=*&limit=1" });
  return rows?.[0] ?? null;
}
async function patchSettings(id: string, patch: Record<string, unknown>): Promise<void> {
  await rest("settings", { method: "PATCH", query: `id=eq.${enc(id)}`, body: patch, prefer: "return=minimal" });
}
async function listSources(): Promise<Array<Record<string, unknown>>> {
  return (await rest<Array<Record<string, unknown>>>("sources", { query: "select=*&order=priority.asc" })) ?? [];
}
async function listTopicQueries(): Promise<Array<{ query: string; category: string; enabled: boolean }>> {
  return (await rest<Array<{ query: string; category: string; enabled: boolean }>>("topic_queries", { query: "select=query,category,enabled" })) ?? [];
}
async function listActiveChats(): Promise<Array<{ id: string; chat_id: number }>> {
  return (await rest<Array<{ id: string; chat_id: number }>>("chats", { query: "select=id,chat_id&active=eq.true" })) ?? [];
}
async function logActivity(type: string, level: string, message: string, detail?: string): Promise<void> {
  try {
    await rest("activity_log", { method: "POST", body: { type, level, message, detail }, prefer: "return=minimal" });
  } catch {
    /* never break the pipeline */
  }
}
async function getKnownRawKeys(keys: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const rows = await rest<Array<{ dedup_key: string }>>("raw_articles", {
      query: `select=dedup_key&dedup_key=in.(${chunk.map(enc).join(",")})`,
    });
    for (const r of rows ?? []) known.add(r.dedup_key);
  }
  return known;
}
async function insertRawArticle(row: Record<string, unknown>): Promise<void> {
  try {
    await rest("raw_articles", { method: "POST", body: row, prefer: "return=minimal" });
  } catch {
    /* duplicate race — ignore */
  }
}
async function insertQueueItem(row: Record<string, unknown>): Promise<void> {
  try {
    await rest("queue", { method: "POST", body: row, prefer: "return=minimal" });
  } catch {
    /* ignore */
  }
}
async function listQueued(): Promise<Array<Record<string, unknown>>> {
  return (await rest<Array<Record<string, unknown>>>("queue", { query: "select=*&status=eq.queued&order=created_at.desc&limit=60" })) ?? [];
}
async function setQueueStatus(id: string, status: string): Promise<void> {
  await rest("queue", { method: "PATCH", query: `id=eq.${enc(id)}`, body: { status }, prefer: "return=minimal" });
}
async function listRecentPublished(take = 200): Promise<Array<Record<string, unknown>>> {
  return (await rest<Array<Record<string, unknown>>>("published_history", { query: `select=*&order=published_at.desc&limit=${take}` })) ?? [];
}
async function insertPublishedHistory(row: Record<string, unknown>): Promise<void> {
  await rest("published_history", { method: "POST", body: row, prefer: "return=minimal" });
}

// ── Translation cache (saves Gemini calls when the same text is republished) ─
async function getTranslationCache(inputText: string): Promise<{ kurdish: string; model: string } | null> {
  try {
    const key = await sha256hex(inputText);
    const rows = await rest<Array<{ kurdish_text: string; model: string }>>("translation_history", {
      query: `select=kurdish_text,model&cache_key=eq.${enc(key)}&limit=1`,
    });
    const r = rows?.[0];
    return r && r.kurdish_text ? { kurdish: r.kurdish_text, model: r.model } : null;
  } catch {
    return null;
  }
}
async function saveTranslationCache(inputText: string, kurdish: string, model: string): Promise<void> {
  try {
    const key = await sha256hex(inputText);
    await rest("translation_history", {
      method: "POST",
      body: { english_text: inputText.slice(0, 900), kurdish_text: kurdish, model, cache_key: key, created_at: new Date().toISOString() },
      prefer: "return=minimal",
    });
  } catch {
    /* cache must never break publish */
  }
}

// ── Queue pruning + table retention (free-plan row hygiene) ─────────────
// Runs at the top of every cycle; keeps the DB from growing unbounded:
//   queue:                queued older than 48h -> expired; non-queued > 7d -> deleted
//   raw_articles:         > 21d deleted (dedup memory — freshness window is <= 48h)
//   published_history / translation_history / clusters / activity_log: > 30d deleted
//   translation_failures / gemini_call_log: > 14d deleted; ai_usage: > 60d deleted
async function pruneQueueAndRetain(): Promise<void> {
  const now = Date.now();
  const queuedCutoff = new Date(now - 48 * 3_600_000).toISOString();
  const doneCutoff = new Date(now - 7 * 86_400_000).toISOString();
  const rawCutoff = new Date(now - 21 * 86_400_000).toISOString();
  const activityCutoff = new Date(now - 30 * 86_400_000).toISOString();
  const geminiCutoff = new Date(now - 14 * 86_400_000).toISOString();
  const usageDayCutoff = new Date(now - 60 * 86_400_000).toISOString().slice(0, 10);
  try {
    await rest("queue", {
      method: "PATCH",
      query: `status=eq.queued&created_at=lt.${enc(queuedCutoff)}`,
      body: { status: "expired" },
      prefer: "return=minimal",
    });
    await rest("queue", {
      method: "DELETE",
      query: `status=neq.queued&created_at=lt.${enc(doneCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("raw_articles", {
      method: "DELETE",
      query: `fetched_at=lt.${enc(rawCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("activity_log", {
      method: "DELETE",
      query: `created_at=lt.${enc(activityCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("gemini_call_log", {
      method: "DELETE",
      query: `at=lt.${enc(geminiCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("published_history", {
      method: "DELETE",
      query: `published_at=lt.${enc(activityCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("translation_history", {
      method: "DELETE",
      query: `created_at=lt.${enc(activityCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("clusters", {
      method: "DELETE",
      query: `last_seen_at=lt.${enc(activityCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("translation_failures", {
      method: "DELETE",
      query: `created_at=lt.${enc(geminiCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("ai_usage", {
      method: "DELETE",
      query: `day=lt.${enc(usageDayCutoff)}`,
      prefer: "return=minimal",
    });
  } catch {
    /* retention must never break the cycle */
  }
}

// ── Ingest ──────────────────────────────────────────────────────────────────
async function runIngest(settings: SettingsRow): Promise<Record<string, unknown>> {
  const stats: Record<string, unknown> = { fetched: 0, junk: 0, offTopic: 0, stale: 0, duplicate: 0, queued: 0, errors: [] as string[] };
  const errors = stats.errors as string[];

  const topics = await listTopicQueries();
  const sources = await listSources();
  const queries = topics.filter((t) => t.enabled).map((t) => t.query);

  const collected: Article[] = [];

  // Telegram channels (breaking signals)
  const channelRows = sources.filter((s) => s.kind === "telegram" && s.enabled !== false);
  const channels = channelRows.map((r) => String((r.config as Record<string, unknown> | null)?.channel ?? r.name ?? "").replace(/^@/, "")).filter(Boolean);
  try {
    const posts: ChannelPost[] = [];
    for (const ch of channels) {
      try {
        posts.push(...(await fetchTelegramChannel(ch)));
      } catch {
        /* skip channel */
      }
    }
    for (const post of posts) {
      if (post.publishedAt && Date.now() - Date.parse(post.publishedAt) > 6 * 3_600_000) continue;
      const text = cleanEditorialText(post.text);
      if (!isEnglishText(text).ok) continue;
      collected.push({
        provider: `Telegram/${post.channel}`,
        sourceName: `@${post.channel}`,
        url: post.url,
        title: text.slice(0, 180),
        description: text,
        imageUrl: post.imageUrl ?? null,
        videoUrl: post.videoUrl ?? null,
        publishedAt: post.publishedAt,
        sourceText: post.text,
      });
    }
  } catch (err) {
    errors.push(`telegram signals: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Web sources
  const newsdataRow = sources.find((s) => s.kind === "newsdata");
  if (newsdataRow && NEWSDATA_API_KEY && queries.length) {
    const groups: string[] = [];
    let current = "";
    for (const q of queries) {
      const candidate = current ? `${current} OR ${q}` : q;
      if (candidate.length > 95) {
        if (current) groups.push(current);
        current = q;
      } else current = candidate;
    }
    if (current) groups.push(current);
    for (const group of groups.slice(0, 2)) {
      try {
        collected.push(...(await fetchNewsData(NEWSDATA_API_KEY, group)));
      } catch (err) {
        errors.push(`newsdata: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
  }
  if (sources.some((s) => s.kind === "rss")) {
    for (const query of queries) {
      try {
        collected.push(...(await fetchGoogleNewsRss(query)));
      } catch (err) {
        errors.push(`rss / ${query.slice(0, 40)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      const topical = /iran|tehran|irgc|khamenei|israel|hezbollah|houthi|yemen|iraq|syria|lebanon|militia|hormuz|persian gulf|tanker|oil|gold|nuclear|uranium|enrich|iaea|sanction|trump|pentagon|centcom|us navy|missile|drone|airstrike|strike|ceasefire|nato|mossad/i;
      collected.push(...(await fetchPublisherFeeds()).filter((a) => topical.test(`${a.title} ${a.description ?? ""}`) || isLeaderStatement(`${a.title} ${a.description ?? ""}`)));
    } catch {
      /* optional */
    }
  }

  // Free-plan hygiene: cap how many articles enter the funnel each cycle so
  // raw_articles + queue growth stay bounded (~100 items is plenty of variety).
  if (collected.length > 100) {
    collected.length = 100;
  }
  stats.fetched = collected.length;

  // Gates
  const survivors: Array<{ article: Article; key: string }> = [];
  const seen = new Set<string>();
  for (const article of collected) {
    article.title = cleanEditorialText(article.title);
    article.description = article.description ? cleanEditorialText(article.description) : null;
    const key = await canonicalKey(article);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!sourceBanGate(article).ok) { stats.junk = Number(stats.junk) + 1; continue; }
    if (!junkGate(article).ok) { stats.junk = Number(stats.junk) + 1; continue; }
    if (!respectGate(article).ok) { stats.junk = Number(stats.junk) + 1; continue; }
    if (!relevanceGate(article).ok) { stats.offTopic = Number(stats.offTopic) + 1; continue; }
    if (!isEnglishText(`${article.title} ${article.description ?? ""}`).ok) { stats.junk = Number(stats.junk) + 1; continue; }
    const textForFreshness = `${article.title} ${article.description ?? ""}`;
    const maxAge = /\b(attack|strike|missile|drone|war|explosion|airstrike|houthi|hezbollah|irgc|centcom|hormuz|nuclear)\b/i.test(textForFreshness) ? 14
      : /\b(analysis|explainer|commentary|opinion)\b/i.test(textForFreshness) ? 48 : 22;
    if (!freshnessGate(article, maxAge).ok) { stats.stale = Number(stats.stale) + 1; continue; }
    survivors.push({ article, key });
  }

  // Dedup vs raw_articles
  const known = await getKnownRawKeys(survivors.map((s) => s.key));
  const fresh = survivors.filter((s) => !known.has(s.key));
  stats.duplicate = survivors.length - fresh.length;

  // Enrich thin web snippets
  if (settings.enrich_summaries !== false) {
    const targets = fresh.filter((s) => !s.article.provider.startsWith("Telegram/") && (s.article.description ?? "").trim().length < 240).slice(0, 24);
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const entry = targets[cursor++]!;
        const full = await fetchArticleFullText(entry.article.url);
        if (full && full.length > (entry.article.description ?? "").trim().length) entry.article.description = full;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
  }

  // Rewrite (rich English summary via Groq) + enqueue
  const toRewrite = fresh.map((s) => ({ title: s.article.title, description: s.article.description }));
  const rewritten = await groqRewrite(toRewrite);

  for (let i = 0; i < fresh.length; i++) {
    const { article, key } = fresh[i]!;
    const category = keywordCategory(`${article.title} ${article.description ?? ""}`);
    if (!category) { stats.offTopic = Number(stats.offTopic) + 1; continue; }
    let headline = article.title;
    let summary = article.description ?? "";
    if (!article.provider.startsWith("Telegram/")) {
      headline = rewritten[i]?.headline ?? headline;
      summary = rewritten[i]?.summary ?? summary;
    }
    headline = cleanEditorialText(normalizeEditorial(headline));
    summary = cleanEditorialText(normalizeEditorial(summary));
    if (hasIncompleteSummary(summary)) { stats.junk = Number(stats.junk) + 1; continue; }

    const articleText = `${article.title} ${article.description ?? ""}`;
    const breaking = isBreaking(category, articleText, (settings.breaking_categories as string[] | undefined) ?? ["war", "iran", "proxies", "usa"]);
    const leaderStatement = isLeaderStatement(articleText);
    const severity = severityLevel(articleText);
    const priority = CATEGORY_PRIORITY[category] ?? 10;
    const ageHours = article.publishedAt ? Math.max(0, (Date.now() - Date.parse(article.publishedAt)) / 3_600_000) : 24;
    const freshness = Math.max(0, 60 - ageHours * 5);
    const score = priority + freshness + SEVERITY_POINTS[severity] + (leaderStatement ? 120 : 0) + (breaking ? 42 : 0);

    // raw_articles is only used as dedup memory (getKnownRawKeys reads
    // dedup_key), so store the minimal row — no payload/body/media — to keep
    // the free-plan database size flat.
    await insertRawArticle({
      dedup_key: key,
      provider: article.provider,
      source_name: article.sourceName ?? null,
      url: article.url,
      title: article.title,
      category,
      published_at: article.publishedAt ? new Date(article.publishedAt).toISOString() : null,
      fetched_at: new Date().toISOString(),
    });
    await insertQueueItem({
      dedup_key: key,
      headline,
      summary,
      category,
      source_name: article.sourceName ?? hostname(article.url),
      url: article.url,
      image_url: article.imageUrl ?? null,
      video_url: article.videoUrl ?? null,
      original_published_at: article.publishedAt ? new Date(article.publishedAt).toISOString() : null,
      source_text: article.sourceText ?? `${article.title} ${article.description ?? ""}`.slice(0, 1500),
      event_id: `${category}-${new Date().toISOString().slice(0, 10)}-${key.slice(0, 12)}`,
      importance: breaking ? "breaking" : "minor",
      score,
      score_parts: { priority, freshness, severity: SEVERITY_POINTS[severity], leader: leaderStatement ? 120 : 0, breaking: breaking ? 42 : 0 },
      breaking,
      status: "queued",
      created_at: new Date().toISOString(),
    });
    stats.queued = Number(stats.queued) + 1;
  }

  await patchSettings(String(settings.id), { last_ingest_at: new Date().toISOString() });
  await logActivity("ingest", Number(stats.queued) > 0 ? "success" : "info", `Ingest cycle: ${stats.fetched} fetched, ${stats.queued} queued`, errors.length ? `Errors: ${errors.slice(0, 3).join(" | ")}` : undefined);
  return stats;
}

// ── Publish ─────────────────────────────────────────────────────────────────
const DEDUP_STOPWORDS = new Set(
  "the a an of in on at to for and or with by from as is are was were be been says said after over into amid new live update updates latest breaking report reports could would should about against their his her its denies say thought".split(" "),
);

async function runPublish(settings: SettingsRow, force = 1): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { sent: 0, items: [] as string[] };
  const chats = await listActiveChats();
  if (chats.length === 0) {
    await logActivity("publish", "warning", "Publish skipped — no active destination chats configured");
    return { ...result, skipped: "no chats" };
  }

  const pool = await listQueued();
  if (pool.length === 0) return { ...result, skipped: "queue empty" };

  const recentPublished = await listRecentPublished(200);
  const cooldownHours = Number(settings.event_cooldown_hours ?? 72);
  const cooldownStart = new Date(Date.now() - cooldownHours * 3_600_000).toISOString();
  const inCooldown = recentPublished.filter((r) => !r.published_at || String(r.published_at) >= cooldownStart);
  const publishedTitles = inCooldown.map((r) => String(r.english_headline || r.headline || "")).filter(Boolean);
  const publishedFingerprints = new Set(publishedTitles.map((t) => normalizeTitle(t).split(" ").filter((w) => w.length > 3 && !DEDUP_STOPWORDS.has(w)).join(" ")));
  const publishedSourceTexts = inCooldown.map((r) => String(r.source_text || "")).filter(Boolean);
  const publishedKeys = new Set(inCooldown.map((r) => String(r.dedup_key)));
  const sentToChat = new Set(inCooldown.map((r) => `${r.dedup_key}:${r.chat_id}`));

  const effectiveScore = (q: Record<string, unknown>): number => {
    const base = Number(q.score ?? 0);
    const parts = (q.score_parts as Record<string, unknown>) ?? {};
    const ageSource = (q.original_published_at as string) ?? (q.created_at as string);
    const ageHours = ageSource ? Math.max(0, (Date.now() - Date.parse(ageSource)) / 3_600_000) : 24;
    return base + (Math.max(0, 60 - ageHours * 5) - Number(parts.freshness ?? 0));
  };
  const sorted = [...pool].sort((a, b) => {
    if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
    return effectiveScore(b as Record<string, unknown>) - effectiveScore(a as Record<string, unknown>);
  });

  const language = (settings.default_language ?? "en") === "both" ? "ckb" : String(settings.default_language ?? "en");
  const timezone = String(settings.timezone ?? "Asia/Baghdad");
  const simThreshold = Number(settings.event_similarity_threshold ?? 0.52);

  let sentThisCycle = 0;
  for (const item of sorted.slice(0, Math.max(force, 1))) {
    if (sentThisCycle >= Math.max(force, 1)) break;
    const id = String(item.id);
    const dedupKey = String(item.dedup_key);
    const headline = String(item.headline ?? "");
    const summary = String(item.summary ?? "");
    const url = String(item.url ?? "");
    const sourceName = String(item.source_name ?? "");
    const candidateText = `${headline} ${summary}`;

    const candidateFp = normalizeTitle(headline).split(" ").filter((w) => w.length > 3 && !DEDUP_STOPWORDS.has(w)).join(" ");
    const repeated =
      publishedKeys.has(dedupKey) ||
      (candidateFp.length > 0 && publishedFingerprints.has(candidateFp)) ||
      publishedTitles.some((t) => sameEvent(t, headline, simThreshold)) ||
      publishedSourceTexts.some((t) => crossLanguageSimilarity(t, candidateText) >= 0.5);
    if (repeated) {
      await setQueueStatus(id, "duplicate");
      continue;
    }

    let resolvedImageUrl: string | null = isValidStoryImage(item.image_url) ? String(item.image_url) : null;
    let resolvedVideoUrl: string | null = typeof item.video_url === "string" && /^https:\/\//.test(item.video_url) ? String(item.video_url) : null;
    if (settings.grab_images !== false) {
      if (/^https?:\/\/t\.me\//i.test(url)) {
        const [img, vid] = await Promise.all([fetchTelegramPostImage(url), fetchTelegramPostVideo(url)]);
        resolvedImageUrl = img ?? resolvedImageUrl;
        resolvedVideoUrl = vid ?? resolvedVideoUrl;
      } else if (url) {
        resolvedImageUrl = (await fetchArticleOgImage(url)) ?? resolvedImageUrl;
      }
    }

    const isTelegramItem = sourceName.startsWith("@");
    let finalHeadline = isTelegramItem ? "" : headline;
    let finalSummary = summary;
    let usedModel = "none";

    if (language === "ckb") {
      const toTranslate = `${headline}\n\n${summary}`;
      const cached = await getTranslationCache(toTranslate);
      let translated = cached ? { text: cached.kurdish, model: cached.model } : await translateToSorani(toTranslate, settings.translation_glossary as string | undefined);
      if (translated.text && translated.model !== "none" && !cached) {
        await saveTranslationCache(toTranslate, translated.text, translated.model).catch(() => {});
      }
      if (translated.text) {
        usedModel = translated.model;
        const parts = translated.text.split("\n\n");
        if (isTelegramItem) {
          finalHeadline = "";
          finalSummary = translated.text;
        } else {
          finalHeadline = parts[0] ?? headline;
          finalSummary = parts.slice(1).join("\n\n") || translated.text;
        }
      } else {
        await logActivity("translation", "warning", `Sorani unavailable — published English fallback: ${headline.slice(0, 110)}`);
        usedModel = "english-fallback";
      }
    }

    finalHeadline = normalizeEditorial(finalHeadline);
    finalSummary = normalizeEditorial(finalSummary);

    const post: Post = {
      headline: finalHeadline,
      summary: finalSummary,
      sourceName: sourceName || hostname(url),
      url,
      imageUrl: settings.grab_images === false ? null : resolvedImageUrl,
      videoUrl: settings.grab_images === false ? null : resolvedVideoUrl,
      originalPublishedAt: (item.original_published_at as string) ?? null,
      breaking: Boolean(item.breaking),
      timezone,
      extraSources: [],
    };
    const fmt: PostFormat = {
      footer: settings.post_footer as string | null | undefined,
      emoji: settings.post_emoji as string | null | undefined,
      linkLabel: settings.post_link_label as string | null | undefined,
      showSource: settings.post_show_source as boolean | undefined,
      showTimestamp: settings.post_show_timestamp as boolean | undefined,
      breakingPrefix: settings.breaking_prefix as string | null | undefined,
      linkPreview: settings.link_previews as boolean | undefined,
    };

    let sentThisItem = 0;
    for (const chat of chats) {
      if (sentToChat.has(`${dedupKey}:${chat.chat_id}`)) continue;
      try {
        const delivery = await sendPost(Number(chat.chat_id), post, fmt);
        await insertPublishedHistory({
          dedup_key: dedupKey,
          chat_id: Number(chat.chat_id),
          headline: isTelegramItem ? headline : finalHeadline,
          english_headline: headline,
          source_text: item.source_text ?? null,
          event_id: item.event_id ?? null,
          source_name: post.sourceName,
          category: String(item.category ?? ""),
          breaking: Boolean(item.breaking),
          original_published_at: post.originalPublishedAt,
          image_url: post.imageUrl ?? null,
          video_url: post.videoUrl ?? null,
          delivery_mode: delivery.mode,
          published_at: new Date().toISOString(),
        });
        result.sent = Number(result.sent) + 1;
        sentThisItem += 1;
        sentToChat.add(`${dedupKey}:${chat.chat_id}`);
        publishedKeys.add(dedupKey);
        await logActivity("publish", "success", `Published: ${headline.slice(0, 140)}`, `${usedModel} · ${delivery.mode}`);
      } catch (err) {
        await logActivity("publish", "warning", `Send failed to chat ${chat.chat_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await setQueueStatus(id, sentThisItem > 0 ? "published" : "queued");
    if (sentThisItem > 0) {
      sentThisCycle += 1;
      (result.items as string[]).push(headline);
      publishedTitles.unshift(headline);
    }
  }

  if (Number(result.sent) > 0) {
    await patchSettings(String(settings.id), { last_published_at: new Date().toISOString() });
  }
  return result;
}

// ── Main handler ────────────────────────────────────────────────────────────
async function acquireLock(settings: SettingsRow): Promise<boolean> {
  // 10-minute stale window (was 25): Supabase kills edge functions at their
  // execution-time limit and a killed run can skip the try/finally release,
  // which used to silence the bot for 25 minutes on every crash.
  const lockAt = settings.publish_run_lock_at as string | undefined;
  if (lockAt && Date.now() - Date.parse(lockAt) < 10 * 60_000) return false;
  await patchSettings(String(settings.id), { publish_run_lock_at: new Date().toISOString() });
  return true;
}
async function releaseLock(settings: SettingsRow): Promise<void> {
  await patchSettings(String(settings.id), { publish_run_lock_at: null });
}

function windowGapOk(settings: SettingsRow, now = Date.now()): { ok: boolean; gapMinutes: number; night: boolean } {
  const floor = Math.max(0, Number(settings.min_post_gap_minutes ?? 1));
  const night = isNight(settings);
  const dayLo = Math.max(floor, Number(settings.day_min_minutes ?? 6));
  const dayHi = Math.max(dayLo, Number(settings.day_max_minutes ?? 16));
  const nightLo = Math.max(floor, Number(settings.night_min_minutes ?? 10));
  const nightHi = Math.max(nightLo, Number(settings.night_max_minutes ?? 20));
  const gapMinutes = night ? randomInt(nightLo, nightHi) : randomInt(dayLo, dayHi);
  const last = settings.last_published_at as string | undefined;
  if (!last) return { ok: true, gapMinutes, night };
  const since = now - Date.parse(last);
  if (Number.isFinite(since) && since >= 0 && since < gapMinutes * 60_000) {
    return { ok: false, gapMinutes, night };
  }
  return { ok: true, gapMinutes, night };
}

async function runCycle(force: boolean): Promise<Record<string, unknown>> {
  let settings = await getSettings();
  if (!settings) throw new Error("Settings row missing");
  if (settings.bot_paused) return { skipped: "bot paused" };

  // Retention/pruning runs even while a publish lock is held (cheap PATCH/DELETEs).
  await pruneQueueAndRetain().catch(() => {});

  if (!(await acquireLock(settings))) return { skipped: "publish run in progress" };
  try {
    const lastIngest = settings.last_ingest_at as string | undefined;
    const ingestInterval = Math.max(1, Number(settings.ingest_interval_minutes ?? 15));
    const ingestDue = force || !lastIngest || Date.now() - Date.parse(lastIngest) >= ingestInterval * 60_000;
    let ingestStats: Record<string, unknown> | null = null;
    if (ingestDue) {
      try {
        ingestStats = await runIngest(settings);
      } catch (err) {
        await logActivity("ingest", "error", `Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      settings = (await getSettings()) ?? settings;
    }

    const gap = windowGapOk(settings);
    if (!force && !gap.ok) return { skipped: `window gap (${gap.gapMinutes} min ${gap.night ? "night" : "day"})`, ingest: ingestStats };

    const publishStats = await runPublish(settings, force ? 3 : 1);
    return { ingest: ingestStats, publish: publishStats };
  } finally {
    await releaseLock(settings).catch(() => {});
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
  }
  if (INTERNAL_SECRET) {
    const provided = req.headers.get("x-internal-secret") ?? "";
    if (provided !== INTERNAL_SECRET) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
  }
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "cycle";
  const force = url.searchParams.get("force") === "1";
  try {
    if (mode === "ingest") {
      const settings = await getSettings();
      if (!settings) throw new Error("Settings row missing");
      const stats = await runIngest(settings);
      return new Response(JSON.stringify(stats), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (mode === "publish") {
      const settings = await getSettings();
      if (!settings) throw new Error("Settings row missing");
      const stats = await runPublish(settings, force ? 3 : 1);
      return new Response(JSON.stringify(stats), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const result = await runCycle(force);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });
  }
});
