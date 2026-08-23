// Unit tests for the deployed Cloudflare egress worker (cloudflare/worker.js).
// Mocks the Worker's fetch + R2 bucket so auth, relay, and media caching are
// guarded without touching the live worker or Telegram.
import { test, expect, beforeEach, afterEach } from "bun:test";
import worker from "../cloudflare/worker.js";

const RELAY_KEY = "test-relay-key";
const PUBLIC_BASE = "https://pub-3c710d357ec24002b36e40f443b4394f.r2.dev";

type Bucket = { get: (k: string) => Promise<unknown>; put: (k: string, bytes: unknown, meta?: unknown) => Promise<void> };
function makeEnv(over: Partial<{ relayKey: string; bucket: Bucket }> = {}) {
  return {
    RELAY_KEY: over.relayKey ?? RELAY_KEY,
    MEDIA_BUCKET: over.bucket ?? { get: async () => null, put: async () => {} },
  };
}

const origFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = origFetch; });
afterEach(() => { globalThis.fetch = origFetch; });

const json = async (res: Response) => JSON.parse(await res.text());

test("/health is public and returns ok", async () => {
  const res = await worker.fetch(new Request("https://worker.test/health"), makeEnv());
  expect(res.status).toBe(200);
  expect(await json(res)).toEqual({ ok: true });
});

test("auth gate: no key → 401, wrong key → 401, correct key → relay", async () => {
  globalThis.fetch = async (input: RequestInfo | URL) =>
    new Response("<html><title>ok</title></html>", { status: 200, headers: { "content-type": "text/html" } });

  const noKey = await worker.fetch(new Request("https://worker.test/tg/channel?handle=aljazeera"), makeEnv());
  expect(noKey.status).toBe(401);

  const wrongKey = await worker.fetch(
    new Request("https://worker.test/tg/channel?handle=aljazeera", { headers: { "x-relay-key": "nope" } }),
    makeEnv(),
  );
  expect(wrongKey.status).toBe(401);

  const ok = await worker.fetch(
    new Request("https://worker.test/tg/channel?handle=aljazeera", { headers: { "x-relay-key": RELAY_KEY } }),
    makeEnv(),
  );
  expect(ok.status).toBe(200);
  expect(ok.headers.get("x-relay")).toBe("cloudflare");
});

test("/tg/channel relays t.me/s/<handle> with a browser user-agent", async () => {
  let called: { url: string; headers: Headers } | null = null;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    called = { url: String(input), headers: new Headers(init?.headers) };
    return new Response("<html>channel</html>", { status: 200 });
  };
  const res = await worker.fetch(
    new Request("https://worker.test/tg/channel?handle=%40lodevnewsbo&limit=10", { headers: { "x-relay-key": RELAY_KEY } }),
    makeEnv(),
  );
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<html>channel</html>");
  expect(called?.url).toBe("https://t.me/s/lodevnewsbo");
  expect(String(called?.headers.get("user-agent"))).toContain("Chrome/124");
});

test("/tg/article refuses news.google.com", async () => {
  const res = await worker.fetch(
    new Request("https://worker.test/tg/article?url=https%3A%2F%2Fnews.google.com%2Frss", { headers: { "x-relay-key": RELAY_KEY } }),
    makeEnv(),
  );
  expect(res.status).toBe(400);
  expect((await json(res)).error).toBe("skip google news");
});

test("media cache miss: downloads, validates content-type, stores under sha1 key", async () => {
  const stored: Array<{ key: string; bytes: ArrayBuffer; meta: unknown }> = [];
  const bucket: Bucket = {
    get: async () => null,
    put: async (key, bytes, meta) => { stored.push({ key, bytes: bytes as ArrayBuffer, meta }); },
  };
  let upstreamCalled = 0;
  globalThis.fetch = async () => {
    upstreamCalled += 1;
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  const res = await worker.fetch(
    new Request("https://worker.test/tg/media?url=https%3A%2F%2Fcdn.example.com%2Fphoto.jpg&kind=image", {
      headers: { "x-relay-key": RELAY_KEY },
    }),
    makeEnv({ bucket }),
  );
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.ok).toBe(true);
  expect(String(body.url)).toMatch(new RegExp(`^${PUBLIC_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/media/[0-9a-f]{40}\\.img$`));
  expect(stored.length).toBe(1);
  expect(upstreamCalled).toBe(1);
  expect(stored[0]!.meta).toMatchObject({ httpMetadata: { contentType: "image/jpeg" } });
});

test("media cache hit skips the upstream fetch", async () => {
  const bucket: Bucket = { get: async () => ({ key: "media/x" }), put: async () => {} };
  let upstreamCalled = 0;
  globalThis.fetch = async () => { upstreamCalled += 1; return new Response("unused", { status: 200 }); };
  const res = await worker.fetch(
    new Request("https://worker.test/tg/media?url=https%3A%2F%2Fcdn.example.com%2Fphoto.jpg&kind=image", {
      headers: { "x-relay-key": RELAY_KEY },
    }),
    makeEnv({ bucket }),
  );
  expect(res.status).toBe(200);
  expect((await json(res)).ok).toBe(true);
  expect(upstreamCalled).toBe(0);
});

test("media with a non-image content-type is rejected (no store)", async () => {
  const stored: string[] = [];
  const bucket: Bucket = {
    get: async () => null,
    put: async (key) => { stored.push(key); },
  };
  globalThis.fetch = async () =>
    new Response("html not an image", { status: 200, headers: { "content-type": "text/html" } });
  const res = await worker.fetch(
    new Request("https://worker.test/tg/media?url=https%3A%2F%2Fcdn.example.com%2Fpage&kind=image", {
      headers: { "x-relay-key": RELAY_KEY },
    }),
    makeEnv({ bucket }),
  );
  expect(res.status).toBe(502);
  expect(stored.length).toBe(0);
});

test("/fetch requires auth (401 without key)", async () => {
  const res = await worker.fetch(
    new Request("https://worker.test/fetch?url=https%3A%2F%2Fexample.com%2Ffeed.xml"),
    makeEnv(),
  );
  expect(res.status).toBe(401);
});

test("/fetch relays a feed URL with cache-control and content-type", async () => {
  let called: string | null = null;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    called = String(input);
    return new Response("<rss><channel><title>t</title></channel></rss>", {
      status: 200,
      headers: { "content-type": "application/rss+xml; charset=utf-8" },
    });
  };
  const res = await worker.fetch(
    new Request("https://worker.test/fetch?url=https%3A%2F%2Fexample.com%2Ffeed.xml&ttl=600", {
      headers: { "x-relay-key": RELAY_KEY },
    }),
    makeEnv(),
  );
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<rss><channel><title>t</title></channel></rss>");
  expect(called).toBe("https://example.com/feed.xml");
  expect(res.headers.get("cache-control")).toBe("public, max-age=600");
  expect(res.headers.get("x-relay")).toBe("cloudflare");
  expect(String(res.headers.get("content-type"))).toContain("application/rss+xml");
});

test("/fetch caches a miss and serves a hit without touching upstream", async () => {
  let upstreamCalled = 0;
  let putKey: string | null = null;
  const cacheStore = new Map<string, Response>();
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      match: async (req: Request) => cacheStore.get(req.url) ?? null,
      put: async (req: Request, res: Response) => {
        putKey = req.url;
        cacheStore.set(req.url, res);
      },
    },
  };
  globalThis.fetch = async () => {
    upstreamCalled += 1;
    return new Response("<rss>fresh</rss>", { status: 200, headers: { "content-type": "application/rss+xml" } });
  };

  const url = "https://worker.test/fetch?url=https%3A%2F%2Fexample.com%2Ffeed.xml&ttl=600";
  const first = await worker.fetch(new Request(url, { headers: { "x-relay-key": RELAY_KEY } }), makeEnv());
  expect(first.status).toBe(200);
  expect(await first.text()).toBe("<rss>fresh</rss>");
  expect(upstreamCalled).toBe(1);
  expect(putKey).toBe("https://example.com/feed.xml");

  const second = await worker.fetch(new Request(url, { headers: { "x-relay-key": RELAY_KEY } }), makeEnv());
  expect(second.status).toBe(200);
  expect(second.headers.get("x-cache")).toBe("hit");
  expect(await second.text()).toBe("<rss>fresh</rss>");
  expect(upstreamCalled).toBe(1); // still 1 — served from cache

  delete (globalThis as unknown as { caches: unknown }).caches;
});

test("/fetch rejects non-http URLs", async () => {
  const res = await worker.fetch(
    new Request("https://worker.test/fetch?url=ftp%3A%2F%2Fexample.com%2Fx", { headers: { "x-relay-key": RELAY_KEY } }),
    makeEnv(),
  );
  expect(res.status).toBe(400);
  expect((await json(res)).error).toBe("bad url");
});

test("/fetch clamps ttl to a sane range", async () => {
  globalThis.fetch = async () => new Response("x", { status: 200, headers: { "content-type": "text/plain" } });
  const clamped = await worker.fetch(
    new Request("https://worker.test/fetch?url=https%3A%2F%2Fexample.com%2Ff&ttl=99999999", {
      headers: { "x-relay-key": RELAY_KEY },
    }),
    makeEnv(),
  );
  expect(clamped.headers.get("cache-control")).toBe("public, max-age=86400");
});

test("oversized media is rejected (10MB image cap)", async () => {
  const bucket: Bucket = { get: async () => null, put: async () => {} };
  const big = new Uint8Array(11 * 1024 * 1024);
  globalThis.fetch = async () =>
    new Response(big, { status: 200, headers: { "content-type": "image/png" } });
  const res = await worker.fetch(
    new Request("https://worker.test/tg/media?url=https%3A%2F%2Fcdn.example.com%2Fbig.png&kind=image", {
      headers: { "x-relay-key": RELAY_KEY },
    }),
    makeEnv({ bucket }),
  );
  expect(res.status).toBe(502);
});
