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
