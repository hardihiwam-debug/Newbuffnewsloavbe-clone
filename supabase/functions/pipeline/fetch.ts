// Outbound fetchers: images, Cloudflare relay, NewsData/RSS/Google News,
// article full text and Telegram channel listings.
// Extracted verbatim from pipeline/index.ts (split refactor) — no behavior change.

import { Article, CLOUDFLARE_RELAY_KEY, CLOUDFLARE_WORKER_URL, PUBLISHER_FEED_CAP, RSS_PER_QUERY_CAP, TELEGRAM_POSTS_PER_CHANNEL } from "./config.ts";
import { enc, hostOf, hostname, logActivity } from "./db.ts";

// ── Images ──────────────────────────────────────────────────────────────────
export function isValidStoryImage(url: string | null | undefined): boolean {
  if (!url) return false;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return false;
  // Google News RSS ships story images via googleusercontent / gstatic CDN
  // hosts. They are real article thumbnails (not logos) — accept them; the
  // bad-token list below still rejects actual logo/avatar/placeholder URLs.
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (host === "google.com" || host.endsWith(".google.com")) return false;
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

export function decodeAttr(value: string): string {
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

export function extractOgImageFromHtml(html: string, baseUrl: string): string | null {
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

export const SCRAPE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

// ── Cloudflare egress offload helpers ──────────────────────────────────────
// Every call falls back to a direct fetch when the worker is unset or fails,
// so quality and availability never depend on Cloudflare being up.
export type RelayResult = { html: string } | null;

export async function relayViaWorker(path: string, params: Record<string, string>): Promise<RelayResult> {
  if (!CLOUDFLARE_WORKER_URL || !CLOUDFLARE_RELAY_KEY) return null;
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${CLOUDFLARE_WORKER_URL}${path}?${qs}`, {
      headers: { "x-relay-key": CLOUDFLARE_RELAY_KEY },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    if (!relayLogShown) {
      relayLogShown = true;
      await logActivity("egress", "success", "Cloudflare egress offload active — Telegram/article/media fetches now relay via Cloudflare").catch(() => {});
    }
    return { html: await res.text() };
  } catch {
    return null;
  }
}

// One-time activity-log marker so the dashboard shows (and the operator can
// confirm) that the Cloudflare egress offload is live. Cleared per process,
// so it appears at most once per cold start.
export let relayLogShown = false;

// Cache media bytes once into R2 via the Worker and return the public URL,
// so Telegram pulls the bytes from Cloudflare instead of this function.
export async function cachedMediaUrl(url: string, kind: "image" | "video"): Promise<string | null> {
  if (!CLOUDFLARE_WORKER_URL || !CLOUDFLARE_RELAY_KEY) return null;
  try {
    const qs = new URLSearchParams({ url, kind }).toString();
    const res = await fetch(`${CLOUDFLARE_WORKER_URL}/tg/media?${qs}`, {
      headers: { "x-relay-key": CLOUDFLARE_RELAY_KEY },
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; url?: string };
    return data.ok && data.url ? data.url : null;
  } catch {
    return null;
  }
}

// ── Google News URL decode ──────────────────────────────────────────────────
// Google News RSS items link to news.google.com/rss/articles/CBMi… wrappers
// that never server-redirect: they render a JS-only reader shell whose visible
// text is empty and whose og:image is Google's 300px placeholder. The REAL
// publisher URL is recovered through Google's own garturlreq batchexecute
// endpoint: the article page embeds a per-request signature (data-n-a-sg) +
// timestamp (data-n-a-ts); POSTing them to /_/DotsSplashUi/data/batchexecute
// returns the canonical article URL, which then yields the real og:image +
// body. Verified live 2026-08-22. Each decode costs 2 small fetches, so a
// per-cycle budget caps the work (reset at ingest cycle start).
let googleDecodesThisCycle = 0;
export function resetGoogleDecodeBudget(): void {
  googleDecodesThisCycle = 0;
}
export const GOOGLE_DECODE_CAP_PER_CYCLE = 14;
export function googleDecodeBudgetLeft(): number {
  return Math.max(0, GOOGLE_DECODE_CAP_PER_CYCLE - googleDecodesThisCycle);
}
const GOOGLE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

// Pure: pull the base64 article id out of a news.google.com wrapper URL.
// Path-based, no regex — nothing for the escape layers to mangle.
export function extractGoogleNewsId(articleUrl: string): string | null {
  try {
    const u = new URL(articleUrl);
    if (u.hostname.toLowerCase() !== "news.google.com") return null;
    const after = u.pathname.split("/articles/")[1];
    if (!after) return null;
    return after.split("/")[0] || null;
  } catch {
    return null;
  }
}

// Regexes are kept backslash-free ([0-9] instead of \d) so the deployed
// bundle can never get the escaped-backslash form that silently fails to
// match. Exported so tests pin them against real Google page fragments.
export const GOOGLE_TS_RE = /data-n-a-ts="([0-9]+)"/;
export const GOOGLE_SIG_RE = /data-n-a-sg="([^"]+)"/;

// Pure: parse Google's batchexecute garturlres response into the canonical
// publisher URL. Returns null on any shape mismatch (never throws).
export function parseGoogleDecodeResponse(text: string): string | null {
  const line = text.split("\n\n")[1];
  if (!line) return null;
  let top: unknown;
  try {
    top = JSON.parse(line);
  } catch {
    top = JSON.parse(line.slice(0, -2));
  }
  const row = (top as unknown[])?.[0] as [unknown, unknown, string] | undefined;
  if (!row?.[2]) return null;
  let decoded: unknown;
  try {
    decoded = (JSON.parse(row[2]) as unknown[])?.[1];
  } catch {
    return null;
  }
  return typeof decoded === "string" && (decoded.startsWith("http://") || decoded.startsWith("https://"))
    ? decoded
    : null;
}

// Log the first decode failure per process so a broken Google format is
// diagnosable ("no signature/timestamp on article page", "batchexecute HTTP
// 400", …) without spamming the activity feed 14x per cycle.
let googleDecodeFailuresLogged = false;
function logGoogleDecodeFailure(reason: string, articleUrl: string): void {
  if (googleDecodeFailuresLogged) return;
  googleDecodeFailuresLogged = true;
  let host = articleUrl.slice(0, 60);
  try {
    host = new URL(articleUrl).hostname;
  } catch {
    /* keep truncated url */
  }
  void logActivity(
    "media",
    "warning",
    `Google News decode failed (${reason.slice(0, 90)}) — ${host} items fall back to text-only`,
  ).catch(() => {});
}

export async function googleNewsDecode(articleUrl: string): Promise<string | null> {
  const id = extractGoogleNewsId(articleUrl);
  if (!id) return null;
  if (googleDecodesThisCycle >= GOOGLE_DECODE_CAP_PER_CYCLE) return null;
  googleDecodesThisCycle += 1;
  let failReason = "";
  try {
    // 1. Read the per-request signature + timestamp Google embeds on the
    // article page (the reader shell carries them on a c-wiz child div).
    const page = await fetch(`https://news.google.com/articles/${id}`, {
      headers: { "user-agent": GOOGLE_UA },
      signal: AbortSignal.timeout(9000),
    });
    if (!page.ok) {
      failReason = `article page HTTP ${page.status}`;
      return null;
    }
    const html = await page.text();
    const ts = html.match(GOOGLE_TS_RE)?.[1];
    const sig = html.match(GOOGLE_SIG_RE)?.[1];
    if (!ts || !sig) {
      failReason = "no signature/timestamp on article page";
      return null;
    }
    // 2. Ask Google to resolve the canonical publisher URL.
    const inner = JSON.stringify([
      "garturlreq",
      [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
      id,
      Number(ts),
      sig,
    ]);
    const res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": GOOGLE_UA,
      },
      body: "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner]]])),
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) {
      failReason = `batchexecute HTTP ${res.status}`;
      return null;
    }
    const decoded = parseGoogleDecodeResponse(await res.text());
    if (!decoded) {
      failReason = "batchexecute returned no URL";
      return null;
    }
    return decoded;
  } catch (e) {
    failReason = e instanceof Error ? e.message : String(e);
    return null;
  } finally {
    if (failReason) logGoogleDecodeFailure(failReason, articleUrl);
  }
}

export async function fetchArticleMeta(url: string): Promise<{ imageUrl: string | null; publishedTime: string | null }> {
  // Google News wrappers never redirect server-side; decode to the real
  // publisher page first (that page has the canonical og:image). The old
  // hard skip here is why every Google News post shipped text-only.
  let target = url;
  try {
    if (new URL(url).hostname.toLowerCase() === "news.google.com") {
      const decoded = await googleNewsDecode(url);
      if (!decoded) return { imageUrl: null, publishedTime: null };
      target = decoded;
    }
  } catch {
    return { imageUrl: null, publishedTime: null };
  }
  try {
    const relayed = await relayViaWorker("/tg/article", { url: target });
    let res: Response;
    if (relayed) {
      res = new Response(relayed.html, { headers: { "content-type": "text/html; charset=utf-8" } });
    } else {
      res = await fetch(target, {
        headers: SCRAPE_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
    }
    if (!res.ok) return { imageUrl: null, publishedTime: null };
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ct)) return { imageUrl: null, publishedTime: null };
    const html = await res.text();
    const head =
      html.slice(0, 200_000).match(/<head[^>]*>[\s\S]*?<\/head>/i)?.[0] ?? html.slice(0, 200_000);
    // The Worker relays after following redirects, so the original URL is the
    // correct base for resolving relative og:image paths on the relay path; the
    // direct-fallback path keeps the final post-redirect URL (res.url) instead.
    return {
      imageUrl: extractOgImageFromHtml(head, relayed ? target : res.url || target),
      publishedTime: extractArticlePublishedTime(head + "\n" + html.slice(0, 200_000)),
    };
  } catch {
    return { imageUrl: null, publishedTime: null };
  }
}

// Pull the article's REAL publish date out of the page: OpenGraph/meta tags
// (both attribute orders), schema.org itemprop, JSON-LD datePublished (double
// or single quotes), the <time> element, and generic data-* date attributes.
// Feeds often re-stamp old content with crawl timestamps (aggregators, gov PR
// sites, Google News), so this is the only trustworthy age signal before a
// story is queued or sent — the June-22 re-crawl leak was exactly this: the
// feed said "today", the article page said two months old.
export function extractArticlePublishedTime(html: string): string | null {
  const pick = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const ts = Date.parse(raw);
    return Number.isNaN(ts) ? null : new Date(ts).toISOString();
  };
  const DATE_META_KEYS =
    "article:published_time|og:article:published_time|date|pubdate|publishdate|article_date_original|parsely-pub-date|datepublished";
  // <meta property/name="…" content="…"> and the reversed attribute order.
  const tagRe = new RegExp(`<meta[^>]+(?:property|name)=["'](?:${DATE_META_KEYS})["'][^>]*content=["']([^"']+)["']`, "i");
  const revRe = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:${DATE_META_KEYS})["']`, "i");
  const meta = pick((html.match(tagRe) ?? html.match(revRe))?.[1]);
  if (meta) return meta;
  // <meta itemprop="datePublished|dateCreated|dateModified" …> (both orders).
  const itemRe = /<meta[^>]+itemprop=["'](?:datePublished|dateCreated|dateModified)["'][^>]*content=["']([^"']+)["']/i;
  const itemRev = /<meta[^>]+content=["']([^"']+)["'][^>]*itemprop=["'](?:datePublished|dateCreated|dateModified)["']/i;
  const item = pick((html.match(itemRe) ?? html.match(itemRev))?.[1]);
  if (item) return item;
  // JSON-LD: "datePublished": "…" with double or single quotes, any spacing.
  const j = pick(html.match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1]);
  if (j) return j;
  // <time … datetime="…"> (schema.org markup; also covers itemprop variants).
  const t = pick(html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1]);
  if (t) return t;
  // Generic data-published / data-date / data-datetime attributes.
  const d = pick(html.match(/\bdata-(?:published|date|datetime)=["']([^"']+)["']/i)?.[1]);
  if (d) return d;
  return null;
}

// ── Fetchers ────────────────────────────────────────────────────────────────
export async function fetchNewsData(apiKey: string, query: string): Promise<Article[]> {
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

export function decodeEntities(input: string): string {
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

export function rssTag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m?.[1] ? decodeEntities(m[1]) : null;
}

export function extractRssImage(block: string): string | null {
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

export const RSS_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

export function parseRssItems(xml: string, provider: string, fallbackSource: string | null): Article[] {
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

export async function fetchGoogleNewsRss(query: string): Promise<Article[]> {
  for (const base of ["https://news.google.com/rss/search", "https://news.google.com/news/rss/search"]) {
    const url = `${base}?q=${encodeURIComponent(query)}+when:1d&hl=en-US&gl=US&ceid=US:en`;
    try {
      // Egress fast-win: Google News RSS is fetched every ingest cycle (up to
      // every 15 min per query) and is one of the biggest outbound byte
      // consumers. Relay it through the Cloudflare worker's /fetch TTL cache
      // (10 min), so most cycles are served by Cloudflare instead of Supabase.
      // Falls back to the direct fetch when the relay is unconfigured/down.
      const relayed = await relayViaWorker("/fetch", { url, ttl: "600" });
      let res: Response;
      if (relayed) {
        res = new Response(relayed.html, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
      } else {
        res = await fetch(url, { headers: RSS_HEADERS, signal: AbortSignal.timeout(20_000) });
      }
      if (res.ok) return parseRssItems(await res.text(), "Google News RSS", null).slice(0, RSS_PER_QUERY_CAP);
    } catch {
      /* try next */
    }
  }
  return [];
}

export const PUBLISHER_FEEDS: Array<{ name: string; url: string; cap?: number; group?: string }> = [
  // Iran & Gulf
  { name: "Al Arabiya", url: "https://english.alarabiya.net/tools/rss", group: "Iran & Gulf" },
  { name: "Press TV", url: "https://www.presstv.ir/rss.xml", group: "Iran & Gulf" },
  { name: "Mehr News", url: "https://en.mehrnews.com/rss", group: "Iran & Gulf" },
  { name: "Tehran Times", url: "https://www.tehrantimes.com/rss", group: "Iran & Gulf" },
  { name: "Tasnim News", url: "https://www.tasnimnews.com/en/rss/feed/0/8/0/", group: "Iran & Gulf" },
  { name: "IRNA English", url: "https://en.irna.ir/rss", group: "Iran & Gulf" },
  { name: "Rudaw", url: "https://www.rudaw.net/rss/english", group: "Iran & Gulf" },
  { name: "Amwaj.media", url: "https://amwaj.media/rss", cap: 15, group: "Iran & Gulf" },
  { name: "Financial Tribune", url: "https://financialtribune.com/rss", cap: 15, group: "Iran & Gulf" },
  { name: "Defense News Mideast", url: "https://www.defensenews.com/arc/outboundfeeds/rss/category/mideast-africa/?outputType=xml", cap: 15, group: "Iran & Gulf" },
  // Lebanon & Levant
  { name: "Al Mayadeen", url: "https://english.almayadeen.net/rss", group: "Lebanon & Levant" },
  { name: "L'Orient Today", url: "https://today.lorientlejour.com/feed/", cap: 15, group: "Lebanon & Levant" },
  { name: "Middle East Monitor", url: "https://www.middleeastmonitor.com/feed/", cap: 15, group: "Lebanon & Levant" },
  { name: "The National", url: "https://www.thenationalnews.com/arcio/rss/", cap: 15, group: "Lebanon & Levant" },
  { name: "Shafaq News", url: "https://shafaq.com/en/rss", group: "Lebanon & Levant" },
  // Gulf business & energy
  { name: "OilPrice.com", url: "https://oilprice.com/rss/main", cap: 15, group: "Gulf business & energy" },
  { name: "CNBC Energy", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19836768", cap: 15, group: "Gulf business & energy" },
  { name: "Gulf Business", url: "https://gulfbusiness.com/feed/", cap: 15, group: "Gulf business & energy" },
  { name: "The National Business", url: "https://www.thenationalnews.com/business/arcio/rss/", cap: 15, group: "Gulf business & energy" },
  { name: "Arabian Business", url: "https://www.arabianbusiness.com/feed/", cap: 15, group: "Gulf business & energy" },
  // Independent analysis
  { name: "Middle East Eye", url: "https://www.middleeasteye.net/rss", cap: 15, group: "Independent analysis" },
  { name: "War on the Rocks", url: "https://warontherocks.com/feed/", cap: 15, group: "Independent analysis" },
  { name: "Responsible Statecraft", url: "https://responsiblestatecraft.org/feed/", cap: 15, group: "Independent analysis" },
  { name: "Atlantic Council MENASource", url: "https://www.atlanticcouncil.org/blogs/menasource/feed/", cap: 15, group: "Independent analysis" },
  { name: "Middle East Institute", url: "https://www.mei.edu/rss.xml", cap: 15, group: "Independent analysis" },
  // General wire
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", group: "General wire" },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml", group: "General wire" },
  { name: "The Guardian World", url: "https://www.theguardian.com/world/rss", group: "General wire" },
];

export async function fetchPublisherFeeds(): Promise<Article[]> {
  const results = await Promise.all(
    PUBLISHER_FEEDS.map(async (feed) => {
      try {
        // Egress fast-win: same relay-through-Cloudflare pattern as Google
        // News RSS — publisher feeds are polled every cycle; the worker's
        // 10-min TTL cache serves most cycles without Supabase egress.
        const relayed = await relayViaWorker("/fetch", { url: feed.url, ttl: "600" });
        let res: Response;
        if (relayed) {
          res = new Response(relayed.html, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
        } else {
          res = await fetch(feed.url, { headers: RSS_HEADERS, signal: AbortSignal.timeout(20_000) });
        }
        if (!res.ok) return [] as Article[];
        const items = parseRssItems(await res.text(), `${feed.name} RSS`, feed.name);
        return items.slice(0, feed.cap ?? PUBLISHER_FEED_CAP);
      } catch {
        return [] as Article[];
      }
    }),
  );
  return results.flat();
}

// ── Article full text ───────────────────────────────────────────────────────
export function extractArticleTextFromHtml(html: string): string {
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

// Fetch an article page once and return BOTH the readable body (for rewrite
// enrichment) and the page's own published date (for the real-date freshness
// check). One relayed download serves both jobs — the ingest path never needs
// a second article fetch just to verify a feed re-stamp.
export async function fetchArticleFullText(url: string): Promise<{ text: string | null; publishedTime: string | null; imageUrl: string | null } | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  // Google News RSS items are CBMi wrappers (no server redirect, JS-only
  // shell with no article text). Decode to the real publisher page first so
  // the rewrite gets a real body and the queue row gets the real og:image.
  let target = url;
  try {
    if (new URL(url).hostname.toLowerCase() === "news.google.com") {
      const decoded = await googleNewsDecode(url);
      if (!decoded) return null;
      target = decoded;
    }
  } catch {
    return null;
  }
  try {
    const relayed = await relayViaWorker("/tg/article", { url: target });
    let res: Response;
    if (relayed) {
      res = new Response(relayed.html, { headers: { "content-type": "text/html; charset=utf-8" } });
    } else {
      res = await fetch(target, {
        headers: SCRAPE_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(7000),
      });
    }
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;
    const html = await res.text();
    const head = html.slice(0, 200_000).match(/<head[^>]*>[\s\S]*?<\/head>/i)?.[0] ?? html.slice(0, 200_000);
    // FULL ARTICLE, full length: the rewrite model needs the mechanism /
    // reason / consequence sentences that only exist in the body — 3000 chars
    // cut most wire stories mid-paragraph and produced the thin one-liner
    // summaries. 12k chars ≈ a complete article while staying inside the
    // batch token budget (see chunkRewriteItems in ai.ts).
    const text = extractArticleTextFromHtml(html).slice(0, 12_000).trim();
    return {
      text: text.length >= 80 ? text : null,
      publishedTime: extractArticlePublishedTime(head + "\n" + html.slice(0, 200_000)),
      // The SAME page fetch yields the article's og:image — the canonical
      // story image. Stored at ingest so publish rarely needs a live hunt.
      imageUrl: extractOgImageFromHtml(head, target),
    };
  } catch {
    return null;
  }
}

// ── Telegram channel fetch ──────────────────────────────────────────────────
export function isTelegramMediaImage(url: string | null | undefined): boolean {
  if (!url || !isValidStoryImage(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host !== "telegram.org" && !host.endsWith(".telegram.org");
  } catch {
    return false;
  }
}

export function extractPostImage(block: string): { url: string; kind: "photo" | "video_thumb" } | null {
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

export function isTelegramVideoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /^cdn\d*\.telesco\.pe$/i.test(u.hostname) && /\.mp4(\?|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

export function extractPostVideo(block: string): string | null {
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

export const TELEGRAM_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
};

export const TELEGRAM_ENTITY_RE = /&(#x?[0-9a-f]+|[a-z]+);/gi;
export function decodeHtmlEntities(html: string): string {
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

export function stripTags(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).replace(/…\s*$/, "").trim();
}

export type ChannelPost = {
  channel: string;
  text: string;
  url: string;
  publishedAt: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  mediaKind: "photo" | "video_thumb" | null;
};

export function parseTelegramPostUrl(url: string): { channel: string; postId: string } | null {
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

export function extractSinglePostMedia(html: string, channel: string, postId: string): { url: string; kind: "photo" | "video_thumb" } | null {
  const wanted = `${channel}/${postId}`;
  const start = html.indexOf(`data-post="${wanted}"`);
  if (start < 0) return null;
  const nextWrap = html.indexOf('<div class="tgme_widget_message_wrap', start);
  const end = nextWrap > start ? nextWrap : start + 20_000;
  return extractPostImage(html.slice(start, end));
}

export async function fetchTelegramPostImage(postUrl: string): Promise<{ url: string; kind: "photo" | "video_thumb" } | null> {
  const parsed = parseTelegramPostUrl(postUrl);
  if (!parsed) return null;
  const postPage = `https://t.me/s/${enc(parsed.channel)}/${parsed.postId}`;
  try {
    const relayed = await relayViaWorker("/tg/post", { url: postPage });
    let html: string;
    if (relayed) {
      html = relayed.html;
    } else {
      const res = await fetch(postPage, {
        headers: TELEGRAM_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      html = await res.text();
    }
    return extractSinglePostMedia(html, parsed.channel, parsed.postId);
  } catch {
    return null;
  }
}

export async function fetchTelegramPostVideo(postUrl: string): Promise<string | null> {
  const parsed = parseTelegramPostUrl(postUrl);
  if (!parsed) return null;
  const postPage = `https://t.me/s/${enc(parsed.channel)}/${parsed.postId}`;
  try {
    const relayed = await relayViaWorker("/tg/post", { url: postPage });
    let html: string;
    if (relayed) {
      html = relayed.html;
    } else {
      const res = await fetch(postPage, {
        headers: TELEGRAM_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      html = await res.text();
    }
    const wanted = `${parsed.channel}/${parsed.postId}`;
    const start = html.indexOf(`data-post="${wanted}"`);
    if (start < 0) return null;
    const nextWrap = html.indexOf('<div class="tgme_widget_message_wrap', start);
    return extractPostVideo(html.slice(start, nextWrap > start ? nextWrap : start + 20_000));
  } catch {
    return null;
  }
}

export async function fetchTelegramChannel(channel: string, limit = TELEGRAM_POSTS_PER_CHANNEL): Promise<ChannelPost[]> {
  const name = channel.replace(/^@/, "").trim();
  const relayed = await relayViaWorker("/tg/channel", { handle: name, limit: String(limit) });
  let html: string;
  if (relayed) {
    html = relayed.html;
  } else {
    const res = await fetch(`https://t.me/s/${enc(name)}`, {
      headers: TELEGRAM_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`t.me/s/${name} ${res.status}`);
    html = await res.text();
  }
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

