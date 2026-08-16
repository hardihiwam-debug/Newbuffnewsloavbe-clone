// Iran Desk Bot — Supabase Edge Function pipeline.
// Replaces the Convex ingest/publish crons: fetch → filter → dedup →
// fact-extract (Groq) → enqueue → translate (MiniMax → Gemini direct) →
// publish to Telegram. Persists everything in Supabase Postgres via PostgREST.
//
// Scheduled by pg_cron every minute (net.http_post). The function self-gates
// on the editable intervals (ingestIntervalMinutes) and the day/night window
// cadence, so the schedule is just a ticker.

import {
  CATEGORY_PRIORITY,
  SEVERITY_POINTS,
  STOPWORDS,
  buildUpdateHeadline,
  checkDigitPreservation,
  checkNumberConsistency,
  chooseDeliveryMode,
  crossLanguageSimilarity,
  eventSimilarity,
  fitCaption,
  formatMessage,
  isBreaking,
  isLeaderStatement,
  keywordCategory,
  matchEventCluster,
  normalizeTitle,
  sameEvent,
  severityLevel,
  type Post,
  type PostFormat,
} from "./_shared.ts";


const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const INTERNAL_SECRET = Deno.env.get("INTERNAL_SECRET") ?? "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const NEWSDATA_API_KEY = Deno.env.get("NEWSDATA_API_KEY") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const MINIMAX_API_KEY = Deno.env.get("MINIMAX_API_KEY") ?? "";
// AI final-dedup provider chain (settings.ai_dedup_provider): only the
// configured provider + Groq fallback are used; these stay empty unless the
// operator adds the keys in the Freebuff Keys UI.
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const CLOUDFLARE_API_TOKEN = Deno.env.get("CLOUDFLARE_API_TOKEN") ?? "";
const CLOUDFLARE_ACCOUNT_ID = Deno.env.get("CLOUDFLARE_ACCOUNT_ID") ?? "";

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
  boost?: number;
  mediaKind: "photo" | "video_thumb" | null;
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
  // Google proxy/placeholder hosts (lh3.googleusercontent.com, gstatic, ggpht)
  // serve 300px thumbnails or logos — never the actual story image.
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (/googleusercontent\.com$|gstatic\.com$|ggpht\.com$|google\.com$/.test(host)) return false;
  } catch {
    return false;
  }
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
  // Google News redirect URLs only resolve (via JS) to a reader page whose
  // og:image is Google's own 300px placeholder — never the story image. Skip.
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "news.google.com") return null;
  } catch {
    return null;
  }
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

const PUBLISHER_FEEDS: Array<{ name: string; url: string; cap?: number; group?: string }> = [
  // Iran & Gulf
  { name: "Al Arabiya", url: "https://english.alarabiya.net/tools/rss", group: "Iran & Gulf" },
  { name: "Press TV", url: "https://www.presstv.ir/rss.xml", group: "Iran & Gulf" },
  { name: "Mehr News", url: "https://en.mehrnews.com/rss", group: "Iran & Gulf" },
  { name: "Tehran Times", url: "https://www.tehrantimes.com/rss", group: "Iran & Gulf" },
  { name: "Tasnim News", url: "https://www.tasnimnews.com/en/rss/feed/0/8/0/", group: "Iran & Gulf" },
  { name: "IRNA English", url: "https://en.irna.ir/rss", group: "Iran & Gulf" },
  { name: "Rudaw", url: "https://www.rudaw.net/rss/english", group: "Iran & Gulf" },
  { name: "Amwaj.media", url: "https://amwaj.media/rss", cap: 4, group: "Iran & Gulf" },
  { name: "Financial Tribune", url: "https://financialtribune.com/rss", cap: 4, group: "Iran & Gulf" },
  { name: "Defense News Mideast", url: "https://www.defensenews.com/arc/outboundfeeds/rss/category/mideast-africa/?outputType=xml", cap: 6, group: "Iran & Gulf" },
  // Lebanon & Levant
  { name: "Al Mayadeen", url: "https://english.almayadeen.net/rss", group: "Lebanon & Levant" },
  { name: "L'Orient Today", url: "https://today.lorientlejour.com/feed/", cap: 6, group: "Lebanon & Levant" },
  { name: "Middle East Monitor", url: "https://www.middleeastmonitor.com/feed/", cap: 6, group: "Lebanon & Levant" },
  { name: "The National", url: "https://www.thenationalnews.com/arcio/rss/", cap: 6, group: "Lebanon & Levant" },
  { name: "Shafaq News", url: "https://shafaq.com/en/rss", group: "Lebanon & Levant" },
  // Gulf business & energy
  { name: "OilPrice.com", url: "https://oilprice.com/rss/main", cap: 6, group: "Gulf business & energy" },
  { name: "CNBC Energy", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19836768", cap: 6, group: "Gulf business & energy" },
  { name: "Gulf Business", url: "https://gulfbusiness.com/feed/", cap: 6, group: "Gulf business & energy" },
  { name: "The National Business", url: "https://www.thenationalnews.com/business/arcio/rss/", cap: 6, group: "Gulf business & energy" },
  { name: "Arabian Business", url: "https://www.arabianbusiness.com/feed/", cap: 6, group: "Gulf business & energy" },
  // Independent analysis
  { name: "Middle East Eye", url: "https://www.middleeasteye.net/rss", cap: 4, group: "Independent analysis" },
  { name: "War on the Rocks", url: "https://warontherocks.com/feed/", cap: 4, group: "Independent analysis" },
  { name: "Responsible Statecraft", url: "https://responsiblestatecraft.org/feed/", cap: 4, group: "Independent analysis" },
  { name: "Atlantic Council MENASource", url: "https://www.atlanticcouncil.org/blogs/menasource/feed/", cap: 4, group: "Independent analysis" },
  { name: "Middle East Institute", url: "https://www.mei.edu/rss.xml", cap: 4, group: "Independent analysis" },
  // General wire
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", group: "General wire" },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml", group: "General wire" },
  { name: "The Guardian World", url: "https://www.theguardian.com/world/rss", group: "General wire" },
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

function extractPostImage(block: string): { url: string; kind: "photo" | "video_thumb" } | null {
  // Two distinct wrappers ship media on the public preview page; we tag the
  // kind so the publish path can choose photo vs "video thumb only" without
  // ever sending the thumb-as-photo by accident.
  const photoAnchor = block.match(/<a\b[^>]*class="[^"]*tgme_widget_message_photo_wrap[^"]*"[^>]*>/i)?.[0];
  if (photoAnchor) {
    const bg = photoAnchor.match(/background-image:\s*url\(\s*['"]?([^)'"]+)['"]?\s*\)/i)?.[1];
    if (bg && isTelegramMediaImage(bg)) return { url: bg.trim(), kind: "photo" };
    const from = block.indexOf(photoAnchor);
    const end = block.indexOf("</a>", from);
    const inner = end > from ? block.slice(from, end) : "";
    const img = inner.match(/<img[^>]+src="([^"]+)"/i)?.[1];
    if (img && isTelegramMediaImage(img)) return { url: img, kind: "photo" };
  }
  const videoThumb = block.match(/<i\b[^>]*class="[^"]*tgme_widget_message_video_thumb[^"]*"[^>]*>/i)?.[0];
  if (videoThumb) {
    const vbg = videoThumb.match(/background-image:\s*url\(\s*['"]?([^)'"]+)['"]?\s*\)/i)?.[1];
    if (vbg && isTelegramMediaImage(vbg)) return { url: vbg.trim(), kind: "video_thumb" };
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
  // The public preview HTML places the real <video src="...mp4"> as a SIBLING
  // of the tgme_widget_message_video_player anchor — the anchor only carries
  // the poster thumb. Scanning the anchor alone found nothing, which forced
  // every video post down the Bot-API path (fails when the bot isn't a member
  // of the source channel) and ultimately published text + a source link.
  // Scan the whole block so real mp4s on the listing page are captured.
  const candidates = block.match(/<video\b[^>]*>/gi) ?? [];
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
  mediaKind: "photo" | "video_thumb" | null;
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

function extractSinglePostMedia(html: string, channel: string, postId: string): { url: string; kind: "photo" | "video_thumb" } | null {
  const wanted = `${channel}/${postId}`;
  const start = html.indexOf(`data-post="${wanted}"`);
  if (start < 0) return null;
  const nextWrap = html.indexOf('<div class="tgme_widget_message_wrap', start);
  const end = nextWrap > start ? nextWrap : start + 20_000;
  return extractPostImage(html.slice(start, end));
}

async function fetchTelegramPostImage(postUrl: string): Promise<{ url: string; kind: "photo" | "video_thumb" } | null> {
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
      imageUrl: extractPostImage(block)?.url ?? null,
      videoUrl: extractPostVideo(block),
      mediaKind: extractPostImage(block)?.kind ?? null,
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
  /\b(hezbollah|houthi|ansar allah|kataib|kata.?ib|nujaba|axis of resistance|hamas|militia|proxy|proxies|popular mobilization|badr|asayib|saraya|resistance front)\b/i,
  /\b(nuclear|uranium|enrich\w*|iaea|sanction\w*|snapback|jcpoa)\b/i,
  /\b(centcom|pentagon|us (navy|military|forces|troops)|carrier strike group|airstrike|air strike|missile|drone|ballistic|ceasefire|war|attack|strike)\b/i,
  /\b(oil|crude|brent|opec|barrel|refinery|tanker|shipping lane|red sea|bab el-?mandeb|gold (price|prices?|market|rally|climb|slip|fall|rise|surge|trad\w*|futures)|bullion|natural gas|lng|petrochemical|energy market)\b/i,
  /\b(middle east|gulf states|saudi|riyadh|qatar|uae|oman|bahrain|kuwait|syria|lebanon|yemen|turkey|ankara|israel|israeli|netanyahu|tel aviv|idf|golan|jordan|amman|egypt|cairo|gaza|west bank|palestin\w*|kurdish|kurd|peshmerga|sdf)\b/i,
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



function normalizeEditorial(text: string): string {
  if (!text) return text;
  let out = text;
  out = out
    .replace(/\bnorthern\s+iraq\b/gi, "Kurdistan Region")
    .replace(/\bnorth\s+of\s+iraq\b/gi, "Kurdistan Region")
    .replace(/\bnorthern\s+iraqi\b/gi, "Kurdistan Region");
  out = out.replace(/باکو[وڕر]*[یي]?\s*(?:ع|ئ)[ێيي]?راق/g, "هەرێمی کوردستان");
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



// ── AI: structured fact extraction (phase 2) ────────────────────────────────
// Replaces the old free-form "rewrite" with a two-step model: the model first
// extracts the facts it can actually see in the source (actor/action/target/
// location/time/claimed vs confirmed results/attribution/confidence/numbers),
// THEN writes the headline + summary using ONLY those facts. The summary can
// never be more complete than the source, exact figures must survive, quotes
// are preserved verbatim, and claims keep their attribution verb ("says").
type ExtractedFacts = {
  headline: string;
  summary: string;
  facts: Record<string, unknown>;
};

async function groqExtractFacts(items: Array<{ title: string; description: string | null }>): Promise<Array<ExtractedFacts | null>> {
  if (!GROQ_API_KEY || items.length === 0) return items.map(() => null);
  const messages = [
    {
      role: "system",
      content: `You are a wire editor for an Iraqi, Muslim, pro-Iran regional news channel. For each supplied news item, FIRST extract the facts the source actually states, THEN write the headline and a clean summary USING ONLY those facts. Return ONLY a JSON object mapping each item's number to its extraction, one object per input, e.g. {"1": {"headline": "...", "summary": "...", "event": "...", "actor": "...", "action": "...", "target": "...", "location": "...", "time": "...", "claimed_result": "...", "confirmed_result": null, "source_attribution": "...", "confidence": "high", "numbers": ["12 killed", "3 missiles"]}}.\nRules:\n- HEADLINE: Who → did what → where → important consequence. Under 100 characters. If the news is only a claim, KEEP the attribution verb ("Iran says…", "US claims…", "report says…") — never turn a claim into the channel's assertion. Never be more dramatic than the source. Do not copy the source headline verbatim.\n- SUMMARY: write a COMPREHENSIVE, detailed news summary using ONLY the supplied facts that provides substantial information beyond the headline. Include specific details: who, what, where, when, why, and how. Add context, background information, relevant statistics, quotes, and implications. The summary should be significantly longer and more detailed than the headline, offering real value to readers. Make the summary LENGTH DYNAMIC based on the actual report - if the source has rich information, write a longer detailed summary (150-300+ words). If the source is thin, the summary must be thin.\n- Ensure the summary contains NEW information not found in the headline. Do not repeat headline content in the summary.\n- NUMBERS: preserve exact figures — "3 missiles" must stay "3 missiles", never "several missiles". List every figure the source states in the "numbers" array. Never round, never add.\n- QUOTES: preserve quoted statements verbatim with attribution ("an Iranian official said, …"). Never turn a quote into an implied promise or intent.\n- CLAIMED vs CONFIRMED: claimed_result is what the source SAYS happened; confirmed_result is only what the source states as verified/confirmed (often null).\n- CONFIDENCE: high = specific, attributed, concrete; medium = some specifics but hedged; low = vague or single-source claims.\n- Never end with ellipsis or unfinished sentences.`,
    },
    {
      role: "user",
      content: JSON.stringify(items.map((item, i) => ({ [String(i + 1)]: { title: item.title, description: item.description?.slice(0, 3000) ?? null } }))),
    },
  ];
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, temperature: 0.1, max_tokens: 6000, response_format: { type: "json_object" } }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Groq ${res.status}`);
    const json = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content) as Record<string, Record<string, unknown>>;
    recordAiUsage("groq", "rewrite", Number(json.usage?.prompt_tokens ?? 0), Number(json.usage?.completion_tokens ?? 0));
    return items.map((item, i) => {
      const row = parsed[String(i + 1)] ?? {};
      const headline = String(row.headline ?? "").trim() || item.title;
      let summary = String(row.summary ?? "").trim();
      if (!summary) summary = item.description ?? "";
      if (!/[.!?]$/.test(summary) && summary.length > 0) summary += ".";
      const facts: Record<string, unknown> = {
        event: row.event ?? null,
        actor: row.actor ?? null,
        action: row.action ?? null,
        target: row.target ?? null,
        location: row.location ?? null,
        time: row.time ?? null,
        claimed_result: row.claimed_result ?? null,
        confirmed_result: row.confirmed_result ?? null,
        source_attribution: row.source_attribution ?? null,
        confidence: row.confidence ?? null,
        numbers: Array.isArray(row.numbers) ? row.numbers : [],
      };
      return { headline, summary, facts };
    });
  } catch {
    return items.map(() => null);
  }
}

// ── AI: Gemini direct translation (Sorani) ─────────────────────────────────
const GEMINI_DIRECT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_DIRECT_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]; // chain: 3.6 -> 3.5 -> 3.5-lite (never hit limits on lite)
const SORANI_SYSTEM_PROMPT =
  "Translate the following message into Kurdish Sorani (Central Kurdish, in the Sorani script). Output ONLY the translation — no commentary, no \"Translation:\" prefix, no quotes around the text. Preserve emojis, links, line breaks, and any formatting exactly. Preserve all numbers, dates, times, percentages and quoted statements exactly as given — never change, round or reword a figure.";
const SORANI_SYSTEM_PROMPT_STRICT =
  "Translate the following message into Kurdish Sorani (Central Kurdish). You MUST output ONLY the translation in the Sorani Arabic script (ئەلفوبێی عەرەبیی سۆرانی). Do NOT answer in English or Latin script — translate every word into Sorani script except widely-recognised abbreviations (CIA, US, UN, NATO, CEO). Do NOT add commentary, explanations, a \"Translation:\" prefix, or quotes. Output ONLY the Sorani translation. Preserve emojis, links, line breaks, and formatting exactly. Preserve all numbers, dates, times and quoted statements exactly as given — never change, round or reword a figure.";

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
    if (/^(here(\u2019s|'s| is)?|translation[:：]|the (standard |english |kurdish )?translation|in (kurdish|sorani|english)[:：]?|output[:：])/i.test(head) && !/^[\u0600-\u06FF]/.test(head)) {
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

// MiniMax via the Vercel AI Gateway, used as the fallback behind the
// Gemini key pool (gemini_first default). MiniMax does not carry the
// per-key daily/RPM quota cliffs that burn through Gemini keys.
async function minimaxTranslate(text: string, glossary: string | undefined, strict: boolean): Promise<string | null> {
  if (!MINIMAX_API_KEY) return null;
  try {
    const glossaryBlock = glossary?.trim() ? `TRANSLATION GLOSSARY — use these exact translations for key terms:\n${glossary.trim()}\n\n` : "";
    const res = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MINIMAX_API_KEY}` },
      body: JSON.stringify({
        model: "minimax/minimax-m3",
        messages: [
          { role: "system", content: strict ? SORANI_SYSTEM_PROMPT_STRICT : SORANI_SYSTEM_PROMPT },
          { role: "user", content: `${glossaryBlock}${text.slice(0, 1500)}` },
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

async function translateToSorani(
  text: string,
  glossary: string | undefined,
  mode = "gemini_first",
): Promise<{ text: string | null; model: string }> {
  // Operator-controllable chain order (settings.translation_mode).
  // "gemini_first" (default) runs the Gemini key pool first — the operator
  // pays for those keys and wants them used; MiniMax is the fallback.
  // "minimax_first" keeps the AI-Gateway call in front; the "*_only" modes
  // skip the other provider.
  const m = mode || "gemini_first";
  const useMinimax = m !== "gemini_only";
  const useGemini = m !== "minimax_only";
  const minimaxFirst = m === "minimax_first" || m === "minimax_only";

  const tryMinimax = async (): Promise<string | null> => {
    if (!useMinimax) return null;
    return (await minimaxTranslate(text, glossary, false)) ?? (await minimaxTranslate(text, glossary, true));
  };
  const tryGemini = async (): Promise<{ text: string; model: string } | null> => {
    if (!useGemini) return null;
    return await geminiTranslateOnce(text, glossary);
  };

  if (minimaxFirst) {
    const mm = await tryMinimax();
    if (mm) return { text: mm, model: "minimax/minimax-m3" };
    const g = await tryGemini();
    if (g) return { text: g.text, model: g.model };
  } else {
    const g = await tryGemini();
    if (g) return { text: g.text, model: g.model };
    const mm = await tryMinimax();
    if (mm) return { text: mm, model: "minimax/minimax-m3" };
  }
  return { text: null, model: "none" };
}

// ── AI decision usage accounting + final-dedup provider chain ─────────────
// The operator-facing "AI final dedup" settings (ai_dedup_enabled,
// ai_dedup_provider, ai_dedup_window_hours, ai_dedup_max_posts) used to be
// configuration illusions — nothing in the pipeline read them. This wires
// them to a real LLM duplicate check at publish time and records usage in
// ai_usage (previously only ever deleted, so the dashboard "AI" stat was
// permanently zero). Usage is buffered per cycle and flushed once per
// (provider, kind) so accounting never becomes a per-call database tax.

const _aiUsageBuffer = new Map<
  string,
  { provider: string; kind: string; calls: number; prompt: number; completion: number }
>();

async function recordAiUsage(provider: string, kind: string, promptTokens: number, completionTokens: number): Promise<void> {
  const key = `${provider}:${kind}`;
  const cur = _aiUsageBuffer.get(key) ?? { provider, kind, calls: 0, prompt: 0, completion: 0 };
  cur.calls += 1;
  cur.prompt += promptTokens;
  cur.completion += completionTokens;
  _aiUsageBuffer.set(key, cur);
}

async function flushAiUsage(): Promise<void> {
  if (_aiUsageBuffer.size === 0) return;
  const entries = [..._aiUsageBuffer.values()];
  _aiUsageBuffer.clear();
  const day = new Date().toISOString().slice(0, 10);
  for (const e of entries) {
    try {
      const rows = await rest<Array<{ id: string; calls: number; prompt_tokens: number; completion_tokens: number }>>("ai_usage", {
        query: `day=eq.${enc(day)}&provider=eq.${enc(e.provider)}&kind=eq.${enc(e.kind)}&limit=1`,
      });
      const row = rows?.[0];
      if (row?.id) {
        await rest(`ai_usage?id=eq.${enc(String(row.id))}`, {
          method: "PATCH",
          body: {
            calls: Number(row.calls ?? 0) + e.calls,
            prompt_tokens: Number(row.prompt_tokens ?? 0) + e.prompt,
            completion_tokens: Number(row.completion_tokens ?? 0) + e.completion,
          },
          prefer: "return=minimal",
        });
      } else {
        await rest("ai_usage", {
          method: "POST",
          body: { day, provider: e.provider, kind: e.kind, calls: e.calls, prompt_tokens: e.prompt, completion_tokens: e.completion },
          prefer: "return=minimal",
        });
      }
    } catch {
      /* usage accounting must never break the pipeline */
    }
  }
}

// Strict-JSON duplicate verdict. Provider chain follows settings.ai_dedup_provider
// (groq | openrouter | cloudflare), with Groq as the always-available fallback
// when the chosen provider's env key is not configured. Returns null when no
// provider is reachable — the publish path then proceeds on the fast
// keyword/fingerprint dedup alone rather than blocking on AI.
async function aiDecideIsDuplicate(
  candidateText: string,
  publishedTexts: string[],
  providerSetting: string,
): Promise<{ verdict: "duplicate" | "new" } | null> {
  const texts = publishedTexts.slice(0, 20);
  if (texts.length === 0) return null;
  const system =
    'You are a news-desk duplicate checker for an Iran/Iraq war news channel. Given a candidate news item and a list of already-published items, decide whether the candidate reports the SAME EVENT as one already published (including a clear follow-up of the same incident) or is genuinely NEW. Same actor + action + target + location + time = duplicate. A material new development (new casualty count, new official statement, new attack wave) is NEW. Respond with ONLY JSON: {"verdict":"duplicate"|"new","reason":"short reason"}.';
  const user = JSON.stringify({ candidate: candidateText.slice(0, 2000), already_published: texts.map((t) => t.slice(0, 1200)) });
  const order: Array<{ name: string; url: string; headers: Record<string, string>; model: string }> = [];
  const pushProvider = (name: string) => {
    if (name === "groq" && GROQ_API_KEY) {
      order.push({ name, url: "https://api.groq.com/openai/v1/chat/completions", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` }, model: "llama-3.3-70b-versatile" });
    } else if (name === "openrouter" && OPENROUTER_API_KEY) {
      order.push({ name, url: "https://openrouter.ai/api/v1/chat/completions", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENROUTER_API_KEY}` }, model: "meta-llama/llama-3.3-70b-instruct" });
    } else if (name === "cloudflare" && CLOUDFLARE_API_TOKEN && CLOUDFLARE_ACCOUNT_ID) {
      order.push({ name, url: `https://api.cloudflare.com/client/v4/accounts/${enc(CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    }
  };
  if (providerSetting === "openrouter") {
    pushProvider("openrouter"); pushProvider("cloudflare"); pushProvider("groq");
  } else if (providerSetting === "cloudflare") {
    pushProvider("cloudflare"); pushProvider("openrouter"); pushProvider("groq");
  } else {
    pushProvider("groq"); pushProvider("openrouter"); pushProvider("cloudflare");
  }
  for (const cfg of order) {
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature: 0,
          max_tokens: 120,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      const content = json?.choices?.[0]?.message?.content ?? "";
      let raw = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const firstBrace = raw.indexOf("{");
      if (firstBrace > 0) raw = raw.slice(firstBrace);
      const parsed = JSON.parse(raw) as { verdict?: string };
      if (parsed.verdict === "duplicate" || parsed.verdict === "new") {
        recordAiUsage(cfg.name, "dedup", Number(json?.usage?.prompt_tokens ?? 0), Number(json?.usage?.completion_tokens ?? 0));
        return { verdict: parsed.verdict };
      }
    } catch {
      /* try the next provider */
    }
  }
  return null;
}

// ── Telegram send ───────────────────────────────────────────────────────────


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

// ── Bot-API video recovery ─────────────────────────────────────────────────
// The public `t.me/s/<channel>` SSR HTML only ships the JPEG poster frame for
// a video post (it lazy-loads the actual .mp4 via JS when a client clicks).
// That is what `extractPostImage` picks up — so without this path every
// Telegram video post would default to "sendPhoto(thumb)" and look like a
// still image to subscribers.
//
// The Bot API path:
//   1. forwardMessage(from public channel -> staging chat) -> server returns
//      the forwarded Message object, which carries the media's `file_id`.
//   2. getFile(file_id) -> returns a server-side `file_path`.
//   3. Construct `https://api.telegram.org/file/bot<TOKEN>/<file_path>` and
//      store it as `video_url` so `sendVideo` posts the real video bytes.
//
// Staging chat defaults to the bot's own Saved Messages (resolved from
// `getMe`), so this works zero-config; operators can override with a private
// channel's chat_id via the `telegram_video_staging_chat_id` setting.

let _botSelfId: number | null | undefined = undefined;
async function getBotSelfId(): Promise<number | null> {
  if (_botSelfId !== undefined) return _botSelfId;
  if (!TELEGRAM_BOT_TOKEN) return (_botSelfId = null);
  try {
    const me = await telegramCall("getMe");
    const id = Number(me?.id ?? 0);
    return (_botSelfId = id > 0 ? id : null);
  } catch {
    return (_botSelfId = null);
  }
}

// Dead Telegram video posts (e.g. embed posts where forwardMessage returns
// 400) must not be retried on every 5-minute ingest cycle. Each failure is
// logged to activity_log with detail = "<channel>/<postId>"; this checks that
// log so a known-dead post is skipped for 24h.
async function recentlyFailedVideoFetch(channelHandle: string, postId: number): Promise<boolean> {
  try {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const rows = await rest<Array<{ id: string }>>("activity_log", {
      query: `select=id&type=eq.telegram_video&level=eq.warning&detail=eq.${enc(`${channelHandle}/${postId}`)}&created_at=gte.${enc(since)}&limit=1`,
    });
    return (rows?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function fetchTelegramVideoViaBotApi(
  channelHandle: string,
  postId: number,
  stagingOverride: number | null,
): Promise<{ fileUrl: string; fileId: string } | null> {
  if (!TELEGRAM_BOT_TOKEN) return null;
  const staging = stagingOverride ?? await getBotSelfId();
  if (!staging) return null;

  let fwdMessageId: number | null = null;
  try {
    // forwardMessage accepts a channel username for from_chat_id; we prefix
    // '@' if the operator passed a bare handle.
    const fromChatId = channelHandle.startsWith("@") ? channelHandle : `@${channelHandle}`;
    const fwd = await telegramCall("forwardMessage", {
      chat_id: staging,
      from_chat_id: fromChatId,
      message_id: postId,
      disable_notification: true,
    });
    fwdMessageId = Number(fwd?.message_id ?? 0) || null;
    if (!fwdMessageId) return null;

    // The forwarded Message is `result`. Video media exposes a `video` object
    // with `file_id`. Photos use `photo: [{file_id, ...}, ...]`. We only
    // resolve videos here; photos still go through the selector on Post.
    const video = fwd?.video;
    if (!video?.file_id) return null;
    const fileId = String(video.file_id);

    const gf = await telegramCall("getFile", { file_id: fileId });
    const filePath = String(gf?.file_path ?? "");
    if (!filePath) return null;

    return {
      fileUrl: `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`,
      fileId,
    };
  } catch (err) {
    // Any failure path: log quietly and let the caller fall back to the
    // text-with-source-link publish branch. Never block ingest on this.
    await logActivity?.("telegram_video", "warning",
      `Bot-API video fetch failed for ${channelHandle}/${postId}: ${err instanceof Error ? err.message : String(err)}`,
      `${channelHandle}/${postId}`);
    return null;
  } finally {
    // Always clean up the staging copy so Saved Messages / the staging
    // channel don't accumulate forwarded posts over time.
    if (fwdMessageId && staging) {
      await telegramCall("deleteMessage", {
        chat_id: staging,
        message_id: fwdMessageId,
      }).catch(() => { /* ignore cleanup failures */ });
    }
  }
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

async function sendPost(
  chatId: number,
  post: Post,
  fmt?: PostFormat,
  mediaKind: "photo" | "video_thumb" | null = null,
): Promise<{ mode: "photo" | "video" | "text" }> {
  const text = formatMessage(post, fmt);
  const mode = chooseDeliveryMode(post, mediaKind);

  // Real video → sendVideo. Wins over any image, since for Telegram posts a
  // recovered .mp4 URL is strictly better than a poster-frame fallback.
  if (mode === "video" && post.videoUrl) {
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

  // Real photo → sendPhoto. We refuse to sendPhoto a video_thumb: the public
  // listing HTML only carries the JPEG poster frame for a real Telegram
  // video, and shipping that as a still image is misleading — subscribers
  // cannot tell it apart from a photo post. The video-thumb fallback is the
  // text-only branch below.
  if (mode === "photo" && post.imageUrl) {
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

  // Build the fallback caption. For Telegram video posts that we couldn't
  // recover a real .mp4 for, append an explicit "open in Telegram" pointer
  // so the source video isn't lost — subscribers just have to tap through.
  let fallbackText = text;
  if (mediaKind === "video_thumb" && post.url) {
    fallbackText = `${text}\n\n🎬 ${post.url}`;
  }
  await telegramCall("sendMessage", {
    chat_id: chatId,
    text: fallbackText,
    parse_mode: "HTML",
    link_preview_options: {
      is_disabled: fmt?.linkPreview === false ? true : Boolean(post.imageUrl),
    },
  });
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
// delete-after-post: once a queue row lands in every active chat we drop it
// from Postgres immediately, so the queue table does not grow with each
// published story. Dedup memory moves to published_history and is sized by
// the configured cooldown window (see pruneQueueAndRetain).
async function deleteQueueRow(id: string): Promise<void> {
  await rest("queue", { method: "DELETE", query: `id=eq.${enc(id)}`, prefer: "return=minimal" });
}
async function listRecentPublished(take = 200): Promise<Array<Record<string, unknown>>> {
  return (await rest<Array<Record<string, unknown>>>("published_history", { query: `select=*&order=published_at.desc&limit=${take}` })) ?? [];
}
// Active event clusters for cluster-aware event_id assignment (see
// matchEventCluster in _shared.ts). Only clusters seen within the cutoff are
// candidates so a 3-day-old event never swallows a genuinely new one.
async function listActiveClusters(cutoffHours = 48): Promise<Array<Record<string, unknown>>> {
  const cutoff = new Date(Date.now() - cutoffHours * 3_600_000).toISOString();
  return (await rest<Array<Record<string, unknown>>>("clusters", {
    query: `select=event_id,label,category,post_count,last_source_text&last_seen_at=gte.${enc(cutoff)}&limit=300`,
  })) ?? [];
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

// ── Source fetch health ─────────────────────────────────────────────────────
// Per-channel last_success_at / last_error / consecutive_failures so the
// dashboard can show exactly why a channel went quiet instead of the old
// silent `catch { /* skip channel */ }`.
async function patchSourceHealth(id: string, lastError: string | null, consecutiveFailures: number): Promise<void> {
  if (!id) return;
  const patch: Record<string, unknown> = { consecutive_failures: consecutiveFailures };
  if (lastError === null) patch.last_success_at = new Date().toISOString();
  else patch.last_error = lastError.slice(0, 300);
  await rest("sources", { method: "PATCH", query: `id=eq.${enc(id)}`, body: patch, prefer: "return=minimal" }).catch(() => {});
}

async function bumpSourceFailure(
  id: string,
  msg: string,
  autoPause: { enabled: boolean; threshold: number } | null,
): Promise<{ first: boolean; autoPaused: boolean; failures: number } | null> {
  if (!id) return null;
  try {
    const rows = await rest<Array<{ consecutive_failures: number; enabled: boolean }>>("sources", {
      query: `id=eq.${enc(id)}&select=consecutive_failures,enabled&limit=1`,
    });
    const row = rows?.[0];
    if (!row) return null;
    const failures = Number(row.consecutive_failures ?? 0) + 1;
    const patch: Record<string, unknown> = { consecutive_failures: failures, last_error: msg.slice(0, 300) };
    let autoPaused = false;
    if (autoPause?.enabled && failures >= autoPause.threshold && row.enabled !== false) {
      patch.enabled = false;
      patch.auto_paused = true;
      patch.auto_pause_reason = `Telegram fetch failed ${failures} consecutive times: ${msg.slice(0, 120)}`;
      autoPaused = true;
    }
    await rest("sources", { method: "PATCH", query: `id=eq.${enc(id)}`, body: patch, prefer: "return=minimal" });
    return { first: failures === 1, autoPaused, failures };
  } catch {
    return null;
  }
}

// ── Queue pruning + table retention (free-plan row hygiene) ─────────────
// Runs at the top of every cycle; keeps the DB from growing unbounded:
//   queue:                queued older than 24h -> expired; non-queued > 1h -> deleted
//   raw_articles:         > 48h deleted (dedup memory — freshness window is <= 24h)
//   published_history:    > 7d deleted (dedup cooldown + the dashboard's
//                         24h/7d analytics read this table)
//   translation_history:  > 16h deleted (cache — cooldown window is 8h)
//   clusters:             > 3d deleted (event identity window)
//   activity_log:         > 3d deleted
//   translation_failures / gemini_call_log: > 7d deleted
//   ai_usage:             > 30d deleted
async function pruneQueueAndRetain(): Promise<void> {
  // Delete-after-post sweep. Defaults below match the operator's
  // "minimum Supabase consumption" stance: rows are kept only as long as
  // they serve an active dedup / audit / translation-cache purpose.
  //   - queue rows get DELETE-d in runPublish() on successful publish
  //     (see `deleteQueueRow`). This prune just sweeps the trailing
  //     orphans (function crash left status="publishing", plus the
  //     expired/duplicate/rejected rows that the publish path marks).
  //   - published_history is the dedup memory AND the dashboard analytics
  //     source (Published 24h stat + 7-day chart), so it is retained for 7d.
  //   - translation_history / clusters serve the cooldown window only.
  //   - raw_articles, ai_usage, activity_log, gemini_call_log: tighter
  //     since none are read in the publish hot path.
  const now = Date.now();
  const queuedCutoff = new Date(now - 24 * 3_600_000).toISOString();
  const orphanQueueCutoff = new Date(now - 1 * 3_600_000).toISOString();
  const dedupWindowCutoff = new Date(now - 16 * 3_600_000).toISOString();
  const publishedHistoryCutoff = new Date(now - 7 * 86_400_000).toISOString();   // 7d — dashboard analytics + dedup
  const clusterCutoff = new Date(now - 3 * 86_400_000).toISOString();            // 3d — event identity window
  const rawCutoff = new Date(now - 48 * 3_600_000).toISOString();                // was 21d
  const activityCutoff = new Date(now - 3 * 86_400_000).toISOString();           // was 30d
  const geminiCutoff = new Date(now - 7 * 86_400_000).toISOString();             // was 14d
  const usageDayCutoff = new Date(now - 30 * 86_400_000).toISOString().slice(0, 10);
  try {
    // Anything still "queued" after 24h is no longer news — mark expired.
    await rest("queue", {
      method: "PATCH",
      query: `status=eq.queued&created_at=lt.${enc(queuedCutoff)}`,
      body: { status: "expired" },
      prefer: "return=minimal",
    });
    // Orphaned rows (cycle crashed mid-publish) older than 1h → delete so
    // they can be re-queued. Successfully published rows normally get
    // deleted inline by runPublish(); this catches survivors AND sweeps the
    // expired/duplicate/rejected rows so they never accumulate (the old code
    // only ever deleted publishing/published, so "expired" rows leaked
    // forever and slowly filled the dashboard's queue window with dead rows).
    await rest("queue", {
      method: "DELETE",
      query: `status=in.(publishing,published,expired,duplicate,rejected)&created_at=lt.${enc(orphanQueueCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("raw_articles", {
      method: "DELETE",
      query: `fetched_at=lt.${enc(rawCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("published_history", {
      method: "DELETE",
      query: `published_at=lt.${enc(publishedHistoryCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("translation_history", {
      method: "DELETE",
      query: `created_at=lt.${enc(dedupWindowCutoff)}`,
      prefer: "return=minimal",
    });
    await rest("clusters", {
      method: "DELETE",
      query: `last_seen_at=lt.${enc(clusterCutoff)}`,
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
// Fetch enabled Telegram channels into Article rows (shared by the 5-minute
// telegram fast lane and the full ingest).
async function fetchTelegramArticles(
  channelRows: Array<Record<string, unknown>>,
  options: { botApiVideoFetch?: "off" | "bot_api"; stagingChatId?: number | null; autoPause?: { enabled: boolean; threshold: number } | null } = {},
): Promise<{ articles: Article[]; errors: string[]; botApiResolved: number }> {
  const articles: Article[] = [];
  const errors: string[] = [];
  let botApiResolved = 0;
  const boostByChannel = new Map<string, number>();
  const channels: Array<{ handle: string; rowId: string; wasFailing: boolean }> = [];
  for (const r of channelRows) {
    const cfg = (r.config as Record<string, unknown> | null) ?? {};
    const handle = String(cfg.channel ?? r.name ?? "").replace(/^@/, "");
    if (!handle) continue;
    const boost = Number(cfg.boost ?? 0) || 0;
    if (boost) boostByChannel.set(handle.toLowerCase(), boost);
    channels.push({ handle, rowId: String(r.id ?? ""), wasFailing: Number(r.consecutive_failures ?? 0) > 0 });
  }
  const autoPause = options.autoPause ?? null;
  try {
    const posts: ChannelPost[] = [];
    for (const src of channels) {
      try {
        posts.push(...(await fetchTelegramChannel(src.handle)));
        await patchSourceHealth(src.rowId, null, 0);
        if (src.wasFailing) {
          await logActivity("source", "success", `@${src.handle} recovered — Telegram fetch OK again`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`@${src.handle}: ${msg}`);
        const health = await bumpSourceFailure(src.rowId, msg, autoPause);
        if (health?.first) {
          await logActivity("source", "warning", `@${src.handle} Telegram fetch failed: ${msg}`);
        }
        if (health?.autoPaused) {
          await logActivity("source", "error", `@${src.handle} auto-paused after ${health.failures} consecutive fetch failures: ${msg}`);
        }
      }
    }
    // Build candidate articles first (no side effects) so the Bot-API video
    // resolution can be gated on "have we already ingested this post?". A
    // fresh video post stays inside the 6h freshness window for ~72 cycles,
    // and re-running forwardMessage + getFile every cycle wastes 3 Telegram
    // API calls per post (plus an activity_log row) for nothing. raw_articles
    // already stores each post's canonical key as dedup memory, so check it
    // before resolving.
    type Candidate = {
      article: Article;
      key: string;
      resolveVideo: boolean;
      handle: string;
      pid: number;
    };
    const candidates: Candidate[] = [];
    for (const post of posts) {
      if (post.publishedAt && Date.now() - Date.parse(post.publishedAt) > 6 * 3_600_000) continue;
      const text = cleanEditorialText(post.text);
      if (!isEnglishText(text).ok) continue;
      const article: Article = {
        provider: `Telegram/${post.channel}`,
        sourceName: `@${post.channel}`,
        url: post.url,
        title: text.slice(0, 180),
        description: text,
        // For video_thumb posts the listing HTML only ships the JPEG poster
        // frame. Carrying it as `imageUrl` would cascade into a `sendPhoto`
        // (still-image of a video) at publish time, which is the original
        // migration bug. Suppress it here; a real video URL is resolved later
        // either by Bot API (if enabled) or by the per-post page re-fetch.
        imageUrl: post.mediaKind === "video_thumb" ? null : (post.imageUrl ?? null),
        videoUrl: post.videoUrl ?? null,
        publishedAt: post.publishedAt,
        sourceText: post.text,
        mediaKind: post.mediaKind ?? null,
        boost: boostByChannel.get(post.channel.toLowerCase()) ?? 0,
      };
      const key = await canonicalKey(article);
      let resolveVideo = false;
      let handle = "";
      let pid = 0;
      // Optional Bot API path: forwards the source message into a staging
      // chat owned by the bot, then resolves the real .mp4 file_path so the
      // publish path can call sendVideo on actual video bytes (not the JPEG
      // poster frame extracted from the listing HTML).
      if (
        options.botApiVideoFetch === "bot_api" &&
        post.mediaKind === "video_thumb" &&
        !post.videoUrl &&
        /^https?:\/\/t\.me\/[^/]+\/\d+/.test(post.url)
      ) {
        const parsed = parseTelegramPostUrl(post.url);
        if (parsed) {
          resolveVideo = true;
          handle = parsed.channel;
          pid = Number(parsed.postId);
        }
      }
      candidates.push({ article, key, resolveVideo, handle, pid });
    }

    const knownKeys = await getKnownRawKeys(candidates.map((c) => c.key));
    for (const c of candidates) {
      if (
        c.resolveVideo &&
        !knownKeys.has(c.key) &&
        // Skip posts we already failed to resolve in the last 24h so a dead
        // embed/video isn't hammered with forwardMessage every 5 minutes.
        !(await recentlyFailedVideoFetch(c.handle, c.pid))
      ) {
        const resolved = await fetchTelegramVideoViaBotApi(c.handle, c.pid, options.stagingChatId ?? null);
        if (resolved) {
          c.article.videoUrl = resolved.fileUrl;
          botApiResolved += 1;
        }
      }
      articles.push(c.article);
    }
  } catch (err) {
    errors.push(`telegram signals: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { articles, errors, botApiResolved };
}

async function runIngest(settings: SettingsRow, mode: "all" | "telegram" = "all"): Promise<Record<string, unknown>> {
  const stats: Record<string, unknown> = { fetched: 0, junk: 0, offTopic: 0, stale: 0, duplicate: 0, reReports: 0, extractionFails: 0, updates: 0, queued: 0, breakingQueued: 0, errors: [] as string[] };
  const errors = stats.errors as string[];

  const topics = await listTopicQueries();
  const sources = await listSources();
  const queries = topics.filter((t) => t.enabled).map((t) => t.query);

  const collected: Article[] = [];

  // Telegram channels (breaking signals) — always fetched.
  const channelRows = sources.filter((s) => s.kind === "telegram" && s.enabled !== false);
  // Honour the operator's Telegram video-fetch toggle. "bot_api" runs the
  // forwardMessage + getFile chain for video_thumb posts so sendVideo posts
  // the real .mp4 instead of a still image. "off" leaves post.videoUrl null
  // for those posts, which downstream renders as a clean text-only message.
  const tgVideoMode = (settings.telegram_video_fetch_mode as string | undefined) ?? "off";
  const tgStagingChatId = Number((settings.telegram_video_staging_chat_id as number | string | null) ?? 0) || null;
  const tg = await fetchTelegramArticles(channelRows, {
    botApiVideoFetch: tgVideoMode === "bot_api" ? "bot_api" : "off",
    stagingChatId: tgStagingChatId,
    autoPause: {
      enabled: settings.source_auto_pause_enabled !== false,
      threshold: Math.max(1, Number(settings.source_auto_pause_threshold ?? 8)),
    },
  });
  collected.push(...tg.articles);
  errors.push(...tg.errors);
  if (tg.botApiResolved > 0) {
    await logActivity(
      "telegram_video",
      "success",
      `Bot API recovered ${tg.botApiResolved} real Telegram video URL${tg.botApiResolved === 1 ? "" : "s"} this cycle`,
    );
  }

  // Web sources
  const newsdataRow = sources.find((s) => s.kind === "newsdata");
  if (mode === "all" && newsdataRow && NEWSDATA_API_KEY && queries.length) {
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
  if (mode === "all" && sources.some((s) => s.kind === "rss")) {
    for (const query of queries.slice(0, 4)) {
      try {
        collected.push(...(await fetchGoogleNewsRss(query)));
      } catch (err) {
        errors.push(`rss / ${query.slice(0, 40)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      const topical = /iran|tehran|irgc|khamenei|israel|hezbollah|houthi|yemen|iraq|syria|lebanon|militia|hormuz|persian gulf|tanker|oil|gold|bullion|natural gas|lng|petrochemical|nuclear|uranium|enrich|iaea|sanction|trump|pentagon|centcom|us navy|missile|drone|airstrike|strike|ceasefire|nato|mossad|gaza|west bank|palestin|kurd|jordan|egypt|amman|cairo/i;
      collected.push(...(await fetchPublisherFeeds()).filter((a) => topical.test(`${a.title} ${a.description ?? ""}`) || isLeaderStatement(`${a.title} ${a.description ?? ""}`)));
    } catch {
      /* optional */
    }
  }

  // Free-plan hygiene: cap how many articles enter the funnel each cycle so
  // raw_articles + queue growth stay bounded (~100 items is plenty of variety).
  if (collected.length > 40) {
    collected.length = 40;
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
    const targets = fresh.filter((s) => !s.article.provider.startsWith("Telegram/") && (s.article.description ?? "").trim().length < 240).slice(0, 4);
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

  // Phase 2: event identity + material-update detection BEFORE any Groq call.
  //   - items matching an active cluster (same category) are follow-ups;
  //   - a follow-up whose text is essentially the same facts again (event
  //     similarity >= update_material_threshold) is a RE-REPORT: dropped here
  //     so it never burns a Groq call or fills the queue;
  //   - a follow-up with materially new information becomes an "UPDATE —"
  //     item (is_update) tied to the cluster's event_id, so the publish path
  //     can post it as an update of the already-published story instead of a
  //     separate news item.
  const clusters = await listActiveClusters(48);
  const clusterThreshold = Number(settings.event_similarity_threshold ?? 0.52);
  const reReportThreshold = Number(settings.update_material_threshold ?? 0.7);
  const clusterWrites = new Map<string, { event_id: string; label: string; category: string; last_source_text: string }>();
  const followUp = new Map<number, { eventId: string; label: string }>();
  const droppedIdx = new Set<number>();
  const extractionIdx: number[] = [];
  const toExtract: Array<{ title: string; description: string | null }> = [];
  for (let i = 0; i < fresh.length; i++) {
    const item = fresh[i]!;
    const rawText = `${item.article.title} ${item.article.description ?? ""}`;
    const category = keywordCategory(rawText);
    if (!category) continue;
    const matched = matchEventCluster(rawText, category, clusters, clusterThreshold);
    if (matched) {
      const cluster = clusters.find((c) => String(c.event_id) === matched.eventId);
      const lastText = String(cluster?.last_source_text ?? "");
      const reReport = lastText.length > 0 && eventSimilarity(lastText, rawText) >= reReportThreshold;
      if (reReport) {
        stats.reReports = Number(stats.reReports) + 1;
        droppedIdx.add(i);
        continue;
      }
      followUp.set(i, { eventId: matched.eventId, label: matched.label });
    }
    if (item.article.provider.startsWith("Telegram/")) continue;
    extractionIdx.push(i);
    toExtract.push({ title: item.article.title, description: item.article.description });
  }
  const extractedArr = await groqExtractFacts(toExtract);
  const extracted = new Map<number, ExtractedFacts>();
  extractionIdx.forEach((idx, j) => {
    const ex = extractedArr[j];
    if (ex) extracted.set(idx, ex);
  });

  for (let i = 0; i < fresh.length; i++) {
    if (droppedIdx.has(i)) continue;
    const { article, key } = fresh[i]!;
    const articleText = `${article.title} ${article.description ?? ""}`;
    const category = keywordCategory(articleText);
    if (!category) { stats.offTopic = Number(stats.offTopic) + 1; continue; }
    let headline = article.title;
    let summary = article.description ?? "";
    let facts: Record<string, unknown> | null = null;
    if (!article.provider.startsWith("Telegram/")) {
      const ex = extracted.get(i);
      if (ex) {
        // Phase-2 fact-consistency guard: if the extraction changed or
        // invented a figure (12 killed → 15 killed, or a missile count the
        // source never gave), fall back to the SOURCE text — never publish a
        // hallucinated number.
        const consistency = checkNumberConsistency(articleText, `${ex.headline} ${ex.summary}`);
        if (!consistency.ok) {
          await logActivity("ingest", "warning", `Fact guard — ${consistency.mismatches.slice(0, 2).join("; ")}: falling back to source text for ${article.title.slice(0, 90)}`);
          stats.extractionFails = Number(stats.extractionFails ?? 0) + 1;
        } else {
          headline = ex.headline;
          summary = ex.summary;
          facts = ex.facts;
        }
      }
    }
    headline = cleanEditorialText(normalizeEditorial(headline));
    summary = cleanEditorialText(normalizeEditorial(summary));
    if (hasIncompleteSummary(summary)) { stats.junk = Number(stats.junk) + 1; continue; }

    const boost = Number(article.boost ?? 0) || 0;
    // Per-source speed setting (the Normal/Fast/Instant dropdown on each
    // Telegram source): 0 = normal, 1 = fast (+60 score, no flag), 2 = instant
    // (+150 score AND treated as breaking so it always sorts first).
    const instant = boost >= 2;
    const ageHours = article.publishedAt ? Math.max(0, (Date.now() - Date.parse(article.publishedAt)) / 3_600_000) : 24;
    // Phase-2 breaking gate: breaking requires recency (breaking_max_age_hours)
    // — a 10-hour-old "missile" story entering the pipeline late must not
    // break. Operator-explicit instant channels still break regardless.
    const breaking = instant || isBreaking(category, articleText, (settings.breaking_categories as string[] | undefined) ?? ["war", "iran", "proxies", "usa"], ageHours, Math.max(1, Number(settings.breaking_max_age_hours ?? 8)));
    const leaderStatement = isLeaderStatement(articleText);
    const severity = severityLevel(articleText);
    const priority = CATEGORY_PRIORITY[category] ?? 10;
    const freshness = Math.max(0, 60 - ageHours * 5);
    const boostBonus = boost === 2 ? 150 : boost === 1 ? 60 : 0;
    const score = priority + freshness + SEVERITY_POINTS[severity] + (leaderStatement ? 120 : 0) + (breaking ? 42 : 0) + boostBonus;

    // Event identity: reuse the cluster's event_id for follow-ups (phase 1),
    // and mark material follow-ups as updates (phase 2).
    const fu = followUp.get(i);
    const eventId = fu ? fu.eventId : `${category}-${new Date().toISOString().slice(0, 10)}-${key.slice(0, 12)}`;
    if (fu) {
      clusterWrites.set(fu.eventId, { event_id: fu.eventId, label: fu.label, category, last_source_text: articleText.slice(0, 1200) });
    } else {
      clusterWrites.set(eventId, { event_id: eventId, label: headline.slice(0, 300), category, last_source_text: articleText.slice(0, 1200) });
    }
    const isUpdate = Boolean(fu);

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
      media_kind: article.mediaKind ?? null,
      original_published_at: article.publishedAt ? new Date(article.publishedAt).toISOString() : null,
      source_text: article.sourceText ?? `${article.title} ${article.description ?? ""}`.slice(0, 1500),
      event_id: eventId,
      facts,
      is_update: isUpdate,
      importance: breaking ? "breaking" : isUpdate ? "update" : "minor",
      score,
      score_parts: { priority, freshness, severity: SEVERITY_POINTS[severity], leader: leaderStatement ? 120 : 0, breaking: breaking ? 42 : 0, boost: boostBonus },
      breaking,
      status: "queued",
      created_at: new Date().toISOString(),
    });
    if (breaking) stats.breakingQueued = Number(stats.breakingQueued) + 1;
    if (isUpdate) stats.updates = Number(stats.updates) + 1;
    stats.queued = Number(stats.queued) + 1;
  }

  // Flush cluster upserts once per cycle (one batched GET + one PATCH/POST
  // per event) so the clusters table mirrors what the queue is carrying.
  const clusterIds = [...clusterWrites.keys()];
  if (clusterIds.length > 0) {
    const existing = await rest<Array<{ id: string; event_id: string; post_count: number }>>("clusters", {
      query: `event_id=in.(${clusterIds.map(enc).join(",")})&limit=200`,
    }).catch(() => []);
    const byEvent = new Map((existing ?? []).map((r) => [String(r.event_id), r]));
    for (const c of clusterWrites.values()) {
      const row = byEvent.get(c.event_id);
      if (row?.id) {
        await rest(`clusters?id=eq.${enc(String(row.id))}`, {
          method: "PATCH",
          body: {
            post_count: Number(row.post_count ?? 1) + 1,
            last_headline: c.label,
            last_source_text: c.last_source_text,
            last_seen_at: new Date().toISOString(),
          },
          prefer: "return=minimal",
        }).catch(() => {});
      } else {
        await rest("clusters", {
          method: "POST",
          body: {
            event_id: c.event_id,
            label: c.label,
            category: c.category,
            last_source_text: c.last_source_text,
            last_seen_at: new Date().toISOString(),
          },
          prefer: "return=minimal",
        }).catch(() => {});
      }
    }
  }

  const tsPatch: Record<string, unknown> = { last_telegram_signals_at: new Date().toISOString() };
  if (mode === "all") tsPatch.last_ingest_at = new Date().toISOString();
  await patchSettings(String(settings.id), tsPatch);
  const updateNote = Number(stats.updates) > 0 ? `, ${stats.updates} update${Number(stats.updates) === 1 ? "" : "s"}` : "";
  await logActivity("ingest", Number(stats.queued) > 0 ? "success" : "info", `Ingest cycle: ${stats.fetched} fetched, ${stats.queued} queued${updateNote}`, errors.length ? `Errors: ${errors.slice(0, 3).join(" | ")}` : undefined);
  await flushAiUsage();
  return stats;
}

// ── Publish ─────────────────────────────────────────────────────────────────
const DEDUP_STOPWORDS = new Set(
  "the a an of in on at to for and or with by from as is are was were be been says said after over into amid new live update updates latest breaking report reports could would should about against their his her its denies say thought".split(" "),
);

type DedupContext = {
  publishedKeys: Set<string>;
  publishedFingerprints: Set<string>;
  publishedTitles: string[];
  publishedSourceTexts: string[];
};

// Shared dedup snapshot built from the recent published_history window. Both
// runPublish (real sends) and computePublishPreview (dry-run) use the same
// snapshot so the dashboard's "Preview next batch" verdict matches what will
// actually happen when the publish button is pressed. Rows still in 'sending'
// state (a crashed publish that reserved the idempotency row before sending)
// are invisible here so the story is retried instead of being swallowed.
function buildDedupContext(recentPublished: Array<Record<string, unknown>>, cooldownHours: number): DedupContext {
  const cooldownStart = new Date(Date.now() - cooldownHours * 3_600_000).toISOString();
  const inCooldown = recentPublished.filter(
    (r) => String(r.status ?? "sent") !== "sending" && (!r.published_at || String(r.published_at) >= cooldownStart),
  );
  const publishedTitles = inCooldown.map((r) => String(r.english_headline || r.headline || "")).filter(Boolean);
  const publishedFingerprints = new Set(
    publishedTitles.map((t) => normalizeTitle(t).split(" ").filter((w) => w.length > 3 && !DEDUP_STOPWORDS.has(w)).join(" ")),
  );
  const publishedSourceTexts = inCooldown.map((r) => String(r.source_text || "")).filter(Boolean);
  const publishedKeys = new Set(inCooldown.map((r) => String(r.dedup_key)));
  return { publishedKeys, publishedFingerprints, publishedTitles, publishedSourceTexts };
}

function isRepeated(
  item: { dedup_key: string; headline: string; summary: string },
  dedup: DedupContext,
  simThreshold: number,
): boolean {
  const candidateFp = normalizeTitle(item.headline).split(" ").filter((w) => w.length > 3 && !DEDUP_STOPWORDS.has(w)).join(" ");
  const candidateText = `${item.headline} ${item.summary}`;
  return (
    dedup.publishedKeys.has(item.dedup_key) ||
    (candidateFp.length > 0 && dedup.publishedFingerprints.has(candidateFp)) ||
    dedup.publishedTitles.some((t) => sameEvent(t, item.headline, simThreshold)) ||
    dedup.publishedSourceTexts.some((t) => crossLanguageSimilarity(t, candidateText) >= 0.5)
  );
}

function queueEffectiveScore(q: Record<string, unknown>): number {
  const base = Number(q.score ?? 0);
  const parts = (q.score_parts as Record<string, unknown>) ?? {};
  const ageSource = (q.original_published_at as string) ?? (q.created_at as string);
  const ageHours = ageSource ? Math.max(0, (Date.now() - Date.parse(ageSource)) / 3_600_000) : 24;
  return base + (Math.max(0, 60 - ageHours * 5) - Number(parts.freshness ?? 0));
}


async function runPublish(settings: SettingsRow, force = 1, onlyId?: string | null): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { sent: 0, items: [] as string[] };
  const chats = await listActiveChats();
  if (chats.length === 0) {
    await logActivity("publish", "warning", "Publish skipped — no active destination chats configured");
    return { ...result, skipped: "no chats" };
  }

  const pool = onlyId
    ? (await rest<Array<Record<string, unknown>>>("queue", { query: `select=*&id=eq.${enc(onlyId)}&limit=1` })) ?? []
    : await listQueued();
  if (pool.length === 0) return { ...result, skipped: onlyId ? "item not found or no longer queued" : "queue empty" };

  const recentPublished = await listRecentPublished(200);
  const cooldownHours = Number(settings.event_cooldown_hours ?? 8);
  const dedup = buildDedupContext(recentPublished, cooldownHours);
  const cooldownStart = new Date(Date.now() - cooldownHours * 3_600_000).toISOString();
  const sentToChat = new Set(
    recentPublished
      .filter((r) => String(r.status ?? "sent") !== "sending" && (!r.published_at || String(r.published_at) >= cooldownStart))
      .map((r) => `${r.dedup_key}:${r.chat_id}`),
  );
  // Cluster-aware dedup set: event_ids published within the cooldown window.
  // Follow-up coverage sharing one of these event_ids is dropped even when its
  // dedup key differs (cross-outlet same-event suppression).
  const publishedEventIds = new Set(
    recentPublished
      .filter((r) => String(r.status ?? "sent") !== "sending" && (!r.published_at || String(r.published_at) >= cooldownStart))
      .map((r) => String(r.event_id ?? ""))
      .filter(Boolean),
  );
  const sorted = [...pool].sort((a, b) => {
    if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
    return queueEffectiveScore(b) - queueEffectiveScore(a);
  });

  const language = (settings.default_language ?? "en") === "both" ? "ckb" : String(settings.default_language ?? "en");
  const timezone = String(settings.timezone ?? "Asia/Baghdad");
  const simThreshold = Number(settings.event_similarity_threshold ?? 0.52);

  let sentThisCycle = 0;
  let updatesPublishedThisCycle = 0;
  for (const item of sorted.slice(0, Math.max(force, 1))) {
    if (sentThisCycle >= Math.max(force, 1)) break;
    const id = String(item.id);
    const dedupKey = String(item.dedup_key);
    const headline = String(item.headline ?? "");
    const summary = String(item.summary ?? "");
    const url = String(item.url ?? "");
    const sourceName = String(item.source_name ?? "");
    if (isRepeated({ dedup_key: dedupKey, headline, summary }, dedup, simThreshold)) {
      await deleteQueueRow(id);
      continue;
    }

    // Cluster-aware dedup (phase 1) + material updates (phase 2): follow-up
    // coverage sharing the same event_id as a recently published story is a
    // duplicate — UNLESS the ingest step flagged it as a material update
    // (is_update), in which case it publishes as an "UPDATE —" post of the
    // same event (subject to the update cooldown + per-cycle cap) instead of
    // a separate story.
    const itemEventId = String(item.event_id ?? "");
    const isUpdate = Boolean(item.is_update);
    if (itemEventId && publishedEventIds.has(itemEventId)) {
      if (!isUpdate) {
        await deleteQueueRow(id);
        await logActivity("publish", "info", `Cluster duplicate (event ${itemEventId.slice(0, 16)}…) — dropped: ${headline.slice(0, 110)}`);
        continue;
      }
      const updateCooldownHours = Math.max(0.5, Number(settings.update_cooldown_hours ?? 1));
      const updateStart = new Date(Date.now() - updateCooldownHours * 3_600_000).toISOString();
      const recentUpdateForEvent = recentPublished.some(
        (r) =>
          String(r.event_id ?? "") === itemEventId &&
          Boolean(r.is_update) &&
          (!r.published_at || String(r.published_at) >= updateStart),
      );
      if (recentUpdateForEvent) {
        await deleteQueueRow(id);
        await logActivity("publish", "info", `Update cooldown — dropped follow-up update: ${headline.slice(0, 110)}`);
        continue;
      }
      if (updatesPublishedThisCycle >= Math.max(1, Number(settings.max_updates_per_cycle ?? 2))) {
        await deleteQueueRow(id);
        await logActivity("publish", "info", `Max updates this cycle — dropped: ${headline.slice(0, 110)}`);
        continue;
      }
    }

    // AI final dedup (settings.ai_dedup_enabled / ai_dedup_provider): an LLM
    // double-checks borderline candidates against the cooldown window's
    // published stories. Only reached when the fast checks above passed, so
    // the API cost stays bounded to ~1-3 calls per publish cycle.
    const hasAiDecisionProvider = Boolean(GROQ_API_KEY || OPENROUTER_API_KEY || (CLOUDFLARE_API_TOKEN && CLOUDFLARE_ACCOUNT_ID));
    const aiDedupEnabled = settings.ai_dedup_enabled !== false && hasAiDecisionProvider;
    if (aiDedupEnabled && dedup.publishedSourceTexts.length > 0) {
      const ai = await aiDecideIsDuplicate(`${headline}\n\n${summary}`, dedup.publishedSourceTexts, String(settings.ai_dedup_provider ?? "groq"));
      if (ai?.verdict === "duplicate") {
        await deleteQueueRow(id);
        await logActivity("publish", "info", `AI final dedup flagged duplicate — dropped: ${headline.slice(0, 110)}`);
        continue;
      }
    }

    let resolvedImageUrl: string | null = isValidStoryImage(item.image_url) ? String(item.image_url) : null;
    let resolvedVideoUrl: string | null = typeof item.video_url === "string" && /^https:\/\//.test(item.video_url) ? String(item.video_url) : null;
    // media_kind is the discriminator set at ingest: "photo" for a real photo,
    // "video_thumb" when the listing HTML only shipped a video poster frame
    // (no <video src=...>). The publish path uses it below so a thumb-only
    // video post never falls into "sendPhoto(thumb)" (the original migration
    // bug). If the per-post page re-fetch finds a real .mp4 URL, we upgrade
    // the queue row's media_kind to "photo" so the queue reflects reality.
    let resolvedMediaKind: "photo" | "video_thumb" | null = (item.media_kind as "photo" | "video_thumb" | null | undefined) ?? null;
    if (settings.grab_images !== false) {
      if (/^https?:\/\/t\.me\//i.test(url)) {
        const [img, vid] = await Promise.all([fetchTelegramPostImage(url), fetchTelegramPostVideo(url)]);
        if (vid) {
          resolvedVideoUrl = vid;
        }
        if (img) {
          // Only accept the per-post image fetch if it's a real photo. A
          // video_thumb there would just be the same poster frame — keeping
          // it suppressed avoids the "sendPhoto(thumb)" misdelivery.
          if (img.kind === "photo") {
            resolvedImageUrl = img.url;
            resolvedMediaKind = "photo";
          }
        }
      } else if (url) {
        resolvedImageUrl = (await fetchArticleOgImage(url)) ?? resolvedImageUrl;
      }
    }

    const isTelegramItem = sourceName.startsWith("@");
    const updatePrefix = String(settings.update_prefix ?? "UPDATE — ");
    let finalHeadline = isTelegramItem ? "" : headline;
    let finalSummary = summary;
    // Material updates of an already-published event carry the UPDATE prefix:
    // titled posts get it on the headline AFTER translation (so the Sorani
    // headline stays intact); untitled Telegram posts get it on the body
    // after translation too, because translating the body overwrites
    // finalSummary (buildUpdateHeadline is idempotent, so the non-ckb path
    // stays safe).
    let usedModel = "none";

    if (language === "ckb") {
      // Telegram posts go out as-is after translation (no title line). The
      // headline for a Telegram item is just the first 180 chars of the SAME
      // summary text, so prepending it made the model repeat the opening in
      // the translated output — the "texts repetition" in the channel.
      const toTranslate = isTelegramItem ? summary : `${headline}\n\n${summary}`;
      const cached = await getTranslationCache(toTranslate);
      const glossary = settings.translation_glossary as string | undefined;
      const mode = String(settings.translation_mode ?? "gemini_first");
      let translated = cached ? { text: cached.kurdish, model: cached.model } : await translateToSorani(toTranslate, glossary, mode);
      if (translated.text && translated.model !== "none" && !cached) {
        // Phase-2 digit-preservation guard: a translation must keep the exact
        // figures of the source ("12 killed" may not become "15 killed").
        // One retry, then accept and log — we never block publication on a
        // digit, but we never silently ship a changed figure either.
        const digits = checkDigitPreservation(toTranslate, translated.text);
        if (!digits.ok) {
          const retry = await translateToSorani(toTranslate, glossary, mode);
          const retryOk = Boolean(retry.text) && checkDigitPreservation(toTranslate, retry.text).ok;
          if (retryOk) translated = retry;
          await logActivity("translation", "warning", `Digit guard — ${digits.missing.slice(0, 3).join(", ")} not in source${retryOk ? " (fixed on retry)" : ""}: ${headline.slice(0, 90)}`);
        }
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
        // Record the failure so the dashboard "Translation fails" stat is
        // honest instead of always reading 0.
        await rest("translation_failures", {
          method: "POST",
          body: {
            dedup_key: dedupKey,
            headline: headline.slice(0, 300),
            target_language: "ckb",
            models_tried: ["minimax", "gemini"],
            detail: "All translation models failed or returned non-Sorani output",
          },
          prefer: "return=minimal",
        }).catch(() => {});
        usedModel = "english-fallback";
      }
    }

    // Telegram (untitled) updates must get the prefix AFTER translation —
    // translating the body overwrites finalSummary and would wipe it.
    // buildUpdateHeadline is idempotent, so the non-ckb path stays safe.
    if (isUpdate && isTelegramItem) finalSummary = buildUpdateHeadline(finalSummary, updatePrefix);
    finalHeadline = normalizeEditorial(finalHeadline);
    finalSummary = normalizeEditorial(finalSummary);
    if (isUpdate && !isTelegramItem) finalHeadline = buildUpdateHeadline(finalHeadline, updatePrefix);

    const post: Post & { mediaKind: "photo" | "video_thumb" | null } = {
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
      mediaKind: settings.grab_images === false ? null : resolvedMediaKind,
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
      // Idempotency: reserve the (dedup_key, chat_id) published_history row
      // BEFORE sending so a crash between "Telegram delivered" and "database
      // written" can never cause a duplicate send on the next cycle. The
      // unique index on (dedup_key, chat_id) is the backstop; 'sending' rows
      // are invisible to the dedup snapshot (so a crashed send retries) and a
      // completed send is flipped to 'sent'.
      let historyId: string | null = null;
      try {
        const inserted = await rest<Array<{ id: string }>>("published_history", {
          method: "POST",
          body: {
            dedup_key: dedupKey,
            chat_id: Number(chat.chat_id),
            headline: isTelegramItem ? headline : finalHeadline,
            english_headline: headline,
            source_text: item.source_text ?? null,
            event_id: item.event_id ?? null,
            source_name: post.sourceName,
            category: String(item.category ?? ""),
            breaking: Boolean(item.breaking),
            is_update: isUpdate,
            original_published_at: post.originalPublishedAt,
            image_url: post.imageUrl ?? null,
            video_url: post.videoUrl ?? null,
            status: "sending",
            published_at: new Date().toISOString(),
          },
          prefer: "return=representation",
        });
        historyId = (inserted as Array<{ id: string }> | null)?.[0]?.id ?? null;
      } catch {
        // Unique (dedup_key, chat_id) already exists: either a completed send
        // ('sent' — safe to skip) or a crashed reservation ('sending' — retry
        // by adopting the existing row).
        const existing = await rest<Array<{ id: string; status: string | null }>>("published_history", {
          query: `dedup_key=eq.${enc(dedupKey)}&chat_id=eq.${Number(chat.chat_id)}&limit=1`,
        }).catch(() => []);
        const ex = existing?.[0];
        if (ex && String(ex.status ?? "sent") === "sent") continue;
        historyId = ex?.id ?? null;
      }
      try {
        const delivery = await sendPost(Number(chat.chat_id), post, fmt, post.mediaKind ?? null);
        const flip = () =>
          rest(`published_history?id=eq.${enc(String(historyId))}`, {
            method: "PATCH",
            body: { status: "sent", delivery_mode: delivery.mode },
            prefer: "return=minimal",
          });
        try {
          await flip();
        } catch {
          await flip().catch(() => {});
        }
        result.sent = Number(result.sent) + 1;
        sentThisItem += 1;
        sentToChat.add(`${dedupKey}:${chat.chat_id}`);
        dedup.publishedKeys.add(dedupKey);
        if (isUpdate) updatesPublishedThisCycle += 1;
        await logActivity("publish", "success", `Published${isUpdate ? " (UPDATE)" : ""}: ${headline.slice(0, 140)}`, `${usedModel} · ${delivery.mode}`);
      } catch (err) {
        // Send failed — remove the reservation so the story retries cleanly on
        // the next cycle ('sending' rows are excluded from the dedup snapshot,
        // so a delivered-but-unrecorded send is the only remaining blind spot,
        // and it is far rarer than a plain failed send).
        if (historyId) {
          await rest(`published_history?id=eq.${enc(String(historyId))}`, { method: "DELETE", prefer: "return=minimal" }).catch(() => {});
        }
        await logActivity("publish", "warning", `Send failed to chat ${chat.chat_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (sentThisItem > 0) {
      // "delete after post" — the post already landed in every chat it
      // reached. Leaving the queue row around until pruneQueueAndRetain
      // (1h sweep) wastes Supabase rows; an immediate DELETE keeps the
      // free-plan table flat. On any subsequent restage the canonical
      // dedup_key already lives in published_history until the cooldown
      // window expires, so dup-detection still works.
      await deleteQueueRow(id);
      sentThisCycle += 1;
      (result.items as string[]).push(headline);
      dedup.publishedTitles.unshift(headline);
      // Same-cycle event suppression: refresh the cluster set + source texts
      // with what just went out, so a second outlet of the SAME brand-new
      // event queued behind this one is dropped by the cluster check instead
      // of slipping through until the next cycle's snapshot.
      if (itemEventId) publishedEventIds.add(itemEventId);
      const srcText = String(item.source_text ?? "");
      if (srcText) dedup.publishedSourceTexts.unshift(srcText);
    } else {
      // Nothing went out — leave the row queued for the next cycle.
      await setQueueStatus(id, "queued");
    }
  }

  if (Number(result.sent) > 0) {
    await patchSettings(String(settings.id), { last_published_at: new Date().toISOString() });
  }
  await flushAiUsage();
  return result;
}

// ── Main handler ────────────────────────────────────────────────────────────
// Dry-run of runPublish's selection step: same scoring + dedup gates, no
// sends, no row mutations. Powers the dashboard "Preview next batch" dialog
// so each candidate shows an honest ready / duplicate / blocked status with
// a reason instead of the old "dump raw queue rows and call them blocked".
async function computePublishPreview(settings: SettingsRow, limit = 5): Promise<Record<string, unknown>> {
  const chats = await listActiveChats();
  const pool = await listQueued();
  const recentPublished = await listRecentPublished(200);
  const cooldownHours = Number(settings.event_cooldown_hours ?? 8);
  const dedup = buildDedupContext(recentPublished, cooldownHours);
  const simThreshold = Number(settings.event_similarity_threshold ?? 0.52);
  const language = (settings.default_language ?? "en") === "both" ? "ckb" : String(settings.default_language ?? "en");

  const blockedReason = settings.bot_paused
    ? "Bot is paused"
    : chats.length === 0
      ? "No active destination chats configured"
      : null;

  const sorted = [...pool].sort((a, b) => {
    if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
    return queueEffectiveScore(b) - queueEffectiveScore(a);
  });

  const items = sorted.slice(0, limit).map((q) => {
    const headline = String(q.headline ?? "");
    const summary = String(q.summary ?? "");
    const repeated = isRepeated({ dedup_key: String(q.dedup_key ?? ""), headline, summary }, dedup, simThreshold);
    const status = blockedReason ? "blocked" : repeated ? "duplicate" : "ready";
    const reason = blockedReason
      ? blockedReason
      : repeated
        ? "Already published (or too similar) within the cooldown window"
        : "Would publish next";
    return {
      _id: q.id,
      headline,
      summary,
      category: String(q.category ?? ""),
      score: Number(q.score ?? 0),
      sourceName: String(q.source_name ?? ""),
      breaking: Boolean(q.breaking),
      members: [],
      status,
      reason,
    };
  });

  return {
    paused: Boolean(settings.bot_paused),
    chats: chats.length,
    queued: pool.length,
    language,
    items,
  };
}


async function acquireLock(settings: SettingsRow): Promise<boolean> {
  // Atomic compare-and-set: ONE conditional UPDATE claims the lock only when
  // it is free (NULL) or older than the 10-minute stale window, and
  // return=representation makes the winning row the proof of ownership. This
  // replaces the old check-then-set (two separate database round-trips) that
  // let two concurrent invocations both read "unlocked" and both proceed to
  // publish.
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  const claimed = await rest<Array<{ id: string }>>("settings", {
    method: "PATCH",
    query: `id=eq.${enc(String(settings.id))}&or=(publish_run_lock_at.is.null,publish_run_lock_at.lt.${enc(staleBefore)})`,
    body: { publish_run_lock_at: new Date().toISOString() },
    prefer: "return=representation",
  }).catch(() => []);
  return Array.isArray(claimed) && claimed.length > 0;
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
    // Telegram fast lane: check channels every N minutes and publish any
    // breaking story immediately (no queue wait, no window-gap gate).
    const lastTg = settings.last_telegram_signals_at as string | undefined;
    const tgInterval = Math.max(1, Number(settings.telegram_signals_interval_minutes ?? 5));
    const tgDue = force || !lastTg || Date.now() - Date.parse(lastTg) >= tgInterval * 60_000;
    let tgStats: Record<string, unknown> | null = null;
    if (tgDue) {
      try {
        tgStats = await runIngest(settings, "telegram");
      } catch (err) {
        await logActivity("ingest", "error", `Telegram signals failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      settings = (await getSettings()) ?? settings;
    }

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

    // Telegram fast lane: publish any NEW related post within the 5-minute
    // fetch cadence, 24/7 (not just "breaking" ones, not just the day window)
    // so the channel always feels live. Cap at 3 per cycle so a burst doesn't
    // flood subscribers. Web/news/RSS content still follows the day/night gap
    // cadence in the fall-through path below.
    if (tgStats && Number(tgStats.queued) > 0) {
      const publishStats = await runPublish(settings, Math.min(3, Math.max(1, Number(tgStats.queued))));
      return { telegram: tgStats, ingest: ingestStats, publish: publishStats };
    }

    const gap = windowGapOk(settings);
    if (!force && !gap.ok) return { skipped: `window gap (${gap.gapMinutes} min ${gap.night ? "night" : "day"})`, telegram: tgStats, ingest: ingestStats };

    const publishStats = await runPublish(settings, force ? 3 : 1);
    return { telegram: tgStats, ingest: ingestStats, publish: publishStats };
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
    if (mode === "preview") {
      const settings = await getSettings();
      if (!settings) throw new Error("Settings row missing");
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") ?? 5)));
      const stats = await computePublishPreview(settings, limit);
      return new Response(JSON.stringify(stats), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (mode === "ingest") {
      const settings = await getSettings();
      if (!settings) throw new Error("Settings row missing");
      const stats = await runIngest(settings);
      return new Response(JSON.stringify(stats), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (mode === "publish") {
      const settings = await getSettings();
      if (!settings) throw new Error("Settings row missing");
      const onlyId = url.searchParams.get("id");
      const stats = await runPublish(settings, force || onlyId ? 3 : 1, onlyId);
      return new Response(JSON.stringify(stats), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const result = await runCycle(force);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });
  }
});
