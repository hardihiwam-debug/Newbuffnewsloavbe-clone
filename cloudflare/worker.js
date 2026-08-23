// ────────────────────────────────────────────────────────────────────────────
// news-fetch — Cloudflare Worker that offloads the news bot's heavy egress
// from Supabase Edge Functions to Cloudflare's network (free/unmetered).
//
// Routes (all except /health require the X-Relay-Key header set on the
// deployed pipeline as CLOUDFLARE_RELAY_KEY):
//   GET /tg/channel?handle=X&limit=N     → raw HTML of https://t.me/s/X
//   GET /tg/post?url=<t.me/...>          → raw HTML of a single Telegram post page
//   GET /tg/article?url=<https://...>    → raw HTML of an article page
//   GET /tg/media?url=X&kind=image|video → downloads the media once into R2,
//                                          returns { ok, url } = public R2 URL;
//                                          Telegram then pulls the bytes from
//                                          Cloudflare instead of Supabase
//   GET /fetch?url=<https://...>&ttl=N   → fetches any URL (RSS/XML feeds)
//                                          and serves it from the worker's
//                                          Cache API for ttl seconds, so the
//                                          pipeline's repeated feed polls
//                                          (Google News RSS, publisher feeds)
//                                          are served by Cloudflare instead
//                                          of Supabase egress
//   GET /health                          → { ok: true } (no auth)
//
// Parsing of the relayed HTML happens in the pipeline (unchanged), so moving
// the download to Cloudflare never changes what gets published. No secrets in
// this file: the R2 bucket comes from the MEDIA_BUCKET binding and the relay
// key from the RELAY_KEY binding, both set at deploy time.
// ────────────────────────────────────────────────────────────────────────────

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
// Public R2 dev URL for the "newsbuff" bucket (Telegram fetches media from here).
const PUBLIC_R2_BASE = "https://pub-3c710d357ec24002b36e40f443b4394f.r2.dev";

const counters = { channel: 0, post: 0, article: 0, media: 0, mediaCacheHit: 0, fetch: 0, fetchCacheHit: 0, rejected: 0 };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function auth(request, env) {
  const key = env.RELAY_KEY || "";
  if (!key) return false; // binding missing → deny (fail closed)
  return request.headers.get("x-relay-key") === key;
}

async function sha1hex(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function relayHtml(targetUrl) {
  const res = await fetch(targetUrl, {
    headers: { "user-agent": UA, accept: HTML_ACCEPT, "accept-language": "en-US,en;q=0.9" },
    redirect: "follow",
  });
  if (!res.ok) return new Response(`upstream ${res.status}`, { status: res.status });
  const html = await res.text();
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-relay": "cloudflare",
    },
  });
}

// Generic TTL fetch for the pipeline's RSS/feed polls. The worker's Cache
// API stores the response with `Cache-Control: max-age=<ttl>` (which the
// default cache honors for expiry), so repeated polls of the same URL are
// served from Cloudflare's cache — the Supabase edge function never sees the
// bytes again until the TTL lapses. Falls back to a plain fetch when the
// Cache API is unavailable (e.g. unit tests).
async function fetchWithTtl(targetUrl, ttlSeconds) {
  const ttl = Math.max(1, Math.min(Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 300, 86400));
  const cacheKey = new Request(targetUrl, { method: "GET" });
  try {
    if (typeof caches !== "undefined") {
      const hit = await caches.default.match(cacheKey);
      if (hit) {
        counters.fetchCacheHit += 1;
        return new Response(hit.body, {
          status: hit.status,
          headers: { "content-type": hit.headers.get("content-type") || "text/plain; charset=utf-8", "x-relay": "cloudflare", "x-cache": "hit" },
        });
      }
    }
  } catch {
    /* cache unavailable — fetch through */
  }
  const res = await fetch(targetUrl, {
    headers: {
      "user-agent": UA,
      accept: "application/rss+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.7",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) return new Response(`upstream ${res.status}`, { status: res.status });
  const body = await res.text();
  const out = new Response(body, {
    headers: {
      "content-type": res.headers.get("content-type") || "text/plain; charset=utf-8",
      "cache-control": `public, max-age=${ttl}`,
      "x-relay": "cloudflare",
    },
  });
  try {
    if (typeof caches !== "undefined") await caches.default.put(cacheKey, out.clone());
  } catch {
    /* cache unavailable */
  }
  return out;
}

async function cacheMedia(bucket, mediaUrl, kind) {
  const key = "media/" + (await sha1hex(mediaUrl)) + (kind === "video" ? ".mp4" : ".img");
  const existing = await bucket.get(key);
  if (existing) {
    counters.mediaCacheHit += 1;
    return key;
  }
  const res = await fetch(mediaUrl, {
    headers: {
      "user-agent": UA,
      accept: kind === "image" ? "image/avif,image/webp,image/*,*/*;q=0.8" : "video/mp4,video/*;q=0.9,*/*;q=0.8",
      referer: "https://t.me/",
    },
    redirect: "follow",
  });
  if (!res.ok) return null;
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!ct.startsWith(kind === "image" ? "image/" : "video/")) return null;
  const bytes = await res.arrayBuffer();
  const cap = kind === "image" ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
  if (!bytes.byteLength || bytes.byteLength > cap) return null;
  await bucket.put(key, bytes, { httpMetadata: { contentType: ct } });
  return key;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return json({ ok: true });

    if (!auth(request, env)) {
      counters.rejected += 1;
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    try {
      if (path === "/tg/channel") {
        const handle = (url.searchParams.get("handle") || "").replace(/^@/, "").trim();
        if (!handle) return json({ ok: false, error: "handle required" }, 400);
        counters.channel += 1;
        return await relayHtml(`https://t.me/s/${encodeURIComponent(handle)}`);
      }
      if (path === "/tg/post") {
        const postUrl = url.searchParams.get("url") || "";
        if (!/^https?:\/\/t\.me\//i.test(postUrl)) return json({ ok: false, error: "bad url" }, 400);
        counters.post += 1;
        return await relayHtml(postUrl);
      }
      if (path === "/tg/article") {
        const articleUrl = url.searchParams.get("url") || "";
        if (!/^https?:\/\//i.test(articleUrl)) return json({ ok: false, error: "bad url" }, 400);
        try {
          if (new URL(articleUrl).hostname.toLowerCase() === "news.google.com") {
            return json({ ok: false, error: "skip google news" }, 400);
          }
        } catch {
          return json({ ok: false, error: "bad url" }, 400);
        }
        counters.article += 1;
        return await relayHtml(articleUrl);
      }
      if (path === "/fetch") {
        const targetUrl = url.searchParams.get("url") || "";
        const ttl = Number(url.searchParams.get("ttl") || "300");
        if (!/^https?:\/\//i.test(targetUrl)) return json({ ok: false, error: "bad url" }, 400);
        counters.fetch += 1;
        return await fetchWithTtl(targetUrl, ttl);
      }
      if (path === "/tg/media") {
        const mediaUrl = url.searchParams.get("url") || "";
        const kind = url.searchParams.get("kind") === "video" ? "video" : "image";
        if (!/^https?:\/\//i.test(mediaUrl)) return json({ ok: false, error: "bad url" }, 400);
        if (!env.MEDIA_BUCKET) return json({ ok: false, error: "r2 binding missing" }, 500);
        counters.media += 1;
        const key = await cacheMedia(env.MEDIA_BUCKET, mediaUrl, kind);
        if (!key) return json({ ok: false, error: "fetch or store failed" }, 502);
        return json({ ok: true, url: `${PUBLIC_R2_BASE}/${key}`, key, kind });
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  },
};
