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

const counters = { channel: 0, post: 0, article: 0, media: 0, mediaCacheHit: 0, rejected: 0 };

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
