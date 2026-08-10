import type { FetchedArticle } from "./types";

export async function fetchNewsData(
  apiKey: string,
  query: string,
): Promise<FetchedArticle[]> {
  const url = new URL("https://newsdata.io/api/1/latest");
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("language", "en");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NewsData ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    status?: string;
    results?: Array<Record<string, unknown>>;
  };
  if (json.status && json.status !== "success") {
    throw new Error(`NewsData error: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return (json.results ?? [])
    .map((r): FetchedArticle | null => {
      const link = typeof r["link"] === "string" ? r["link"] : null;
      const title = typeof r["title"] === "string" ? r["title"] : null;
      if (!link || !title) return null;
      const srcArr = r["source_name"] ?? r["source_id"];
      return {
        provider: "NewsData.io",
        sourceName: typeof srcArr === "string" ? srcArr : null,
        url: link,
        title,
        description: typeof r["description"] === "string" ? r["description"] : null,
        imageUrl: typeof r["image_url"] === "string" ? r["image_url"] : null,
        publishedAt: typeof r["pubDate"] === "string" ? r["pubDate"] : null,
      };
    })
    .filter((a): a is FetchedArticle => a !== null);
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

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m?.[1] ? decodeEntities(m[1]) : null;
}

function effectivePublishedAt(rssDate: string | null, text: string): string | null {
  if (!rssDate) return null;
  const rssTs = Date.parse(rssDate);
  const match = text.match(/(?:published|last updated|updated)\s*(?:by[^,]{0,80},)?\s*[:\\-]?\s*([A-Z][a-z]{2,8}\s+\d{1,2},?\s+20\d{2})/i);
  if (!match?.[1]) return rssDate;
  const embeddedTs = Date.parse(match[1]);
  if (Number.isNaN(embeddedTs) || Number.isNaN(rssTs)) return rssDate;
  return embeddedTs < rssTs - 12 * 3_600_000 ? new Date(embeddedTs).toISOString() : rssDate;
}

function hostLabel(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (/^(bing|www\.bing|news\.google|google|msn)\./.test(host) || host === "bing.com") return null;
    return host;
  } catch {
    return null;
  }
}

function unwrapAggregatorUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (/(^|\.)bing\.com$/i.test(url.hostname)) {
      const target = url.searchParams.get("url");
      if (target?.startsWith("http")) return target;
    }
    return raw;
  } catch {
    return raw;
  }
}

function parseRssItems(
  xml: string,
  provider: string,
  fallbackSource: string | null,
): FetchedArticle[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items
    .map((block): FetchedArticle | null => {
      const title = tag(block, "title");
      const rawLink = tag(block, "link");
      if (!title || !rawLink) return null;
      const link = unwrapAggregatorUrl(rawLink);
      const rawSource = tag(block, "source") ?? fallbackSource;
      const description = tag(block, "description");
      const source =
        rawSource && !/bing|google|news\.google|msn/i.test(rawSource)
          ? rawSource
          : hostLabel(link);
      return {
        provider,
        sourceName: source,
        url: link,
        title,
        description,
        imageUrl: null,
        publishedAt: effectivePublishedAt(tag(block, "pubDate"), `${title} ${description ?? ""}`),
      };
    })
    .filter((a): a is FetchedArticle => a !== null);
}

const RSS_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

export async function fetchGoogleNewsRss(query: string): Promise<FetchedArticle[]> {
  const bases = [
    "https://news.google.com/rss/search",
    "https://news.google.com/news/rss/search",
  ];
  let lastStatus = 0;
  for (const base of bases) {
    const url = `${base}?q=${encodeURIComponent(query)}+when:1d&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { headers: RSS_HEADERS }).catch(() => null);
    if (res?.ok) return parseRssItems(await res.text(), "Google News RSS", null);
    lastStatus = res?.status ?? 0;
  }
  throw new Error(`Google News RSS ${lastStatus || "unreachable"}`);
}

export async function fetchBingNewsRss(query: string): Promise<FetchedArticle[]> {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=RSS&setmkt=en-US&setlang=en-US&qft=interval%3d"7"`;
  const res = await fetch(url, { headers: RSS_HEADERS });
  if (!res.ok) throw new Error(`Bing News RSS ${res.status}`);
  return parseRssItems(await res.text(), "Bing News RSS", null);
}

export const PUBLISHER_FEEDS: Array<{ name: string; url: string; cap?: number }> = [
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
  { name: "Fars News", url: "https://www.farsnews.ir/en/rss" },
  { name: "Al Mayadeen", url: "https://english.almayadeen.net/rss" },
  { name: "Middle East Eye", url: "https://www.middleeasteye.net/rss", cap: 4 },
  { name: "Defense News Mideast", url: "https://www.defensenews.com/arc/outboundfeeds/rss/category/mideast-africa/?outputType=xml", cap: 6 },
  { name: "OilPrice.com", url: "https://oilprice.com/rss/main", cap: 6 },
  { name: "CNBC Energy", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19836768", cap: 6 },
];

const DEFAULT_FEED_CAP = 15;

export async function fetchPublisherFeeds(): Promise<FetchedArticle[]> {
  const results = await Promise.all(
    PUBLISHER_FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, { headers: RSS_HEADERS });
        if (!res.ok) return [];
        const items = parseRssItems(await res.text(), `${feed.name} RSS`, feed.name);
        return items.slice(0, feed.cap ?? DEFAULT_FEED_CAP);
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

export async function fetchRssSearch(query: string): Promise<FetchedArticle[]> {
  const errors: string[] = [];
  for (const fn of [fetchBingNewsRss]) {
    try {
      const items = await fn(query);
      if (items.length > 0) return items;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length) throw new Error(errors.join(" | "));
  return [];
}