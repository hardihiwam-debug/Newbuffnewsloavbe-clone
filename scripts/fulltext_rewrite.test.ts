// Regression tests for the full-article rewrite architecture (Stage 2):
// chunking must respect BOTH the item cap and the total source-character
// budget, so full-length bodies never produce oversized provider calls.

import { describe, expect, test } from "bun:test";

// NOTE: this shim defines the Deno env for the FIRST evaluation of the
// pipeline config module in the whole bun run (files load alphabetically).
// GROQ_API_KEY must be present so two_stage_rewrite.test.ts's provider-chain
// tests see a configured provider; other keys stay unset on purpose.
(globalThis as any).Deno = { env: { get: (k: string) => (k === "GROQ_API_KEY" ? "test-key" : undefined) } };

const { chunkRewriteItems, REWRITE_CHUNK_MAX_ITEMS, REWRITE_CHUNK_MAX_CHARS } = await import(
  "../supabase/functions/pipeline/ai.ts"
);

type RewriteItem = {
  title: string;
  description: string | null;
};

const mk = (title: string, descLen: number): RewriteItem => ({
  title,
  description: "x".repeat(descLen),
});
const charsOf = (c: RewriteItem[]) => c.reduce((s, it) => s + it.title.length + (it.description?.length ?? 0), 0);

describe("chunkRewriteItems (full-article batching)", () => {
  test("empty input → no chunks", () => {
    expect(chunkRewriteItems([])).toHaveLength(0);
  });

  test("respects max items per chunk", () => {
    const items = Array.from({ length: 12 }, (_, i) => mk(`t${i}`, 100));
    const chunks = chunkRewriteItems(items as any);
    expect(chunks.map((c) => c.length)).toEqual([5, 5, 2]);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(REWRITE_CHUNK_MAX_ITEMS);
  });

  test("short items pack to the item cap", () => {
    const items = Array.from({ length: 5 }, (_, i) => mk(`t${i}`, 200));
    const chunks = chunkRewriteItems(items as any);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(5);
  });

  test("full-length bodies split by character budget", () => {
    const items = Array.from({ length: 4 }, (_, i) => mk(`body${i}`, 12_000));
    const chunks = chunkRewriteItems(items as any);
    expect(chunks).toHaveLength(4);
    for (const c of chunks) expect(charsOf(c as any)).toBeLessThanOrEqual(REWRITE_CHUNK_MAX_CHARS);
  });

  test("mixed sizes: a big body starts a new chunk", () => {
    const items = [mk("a", 4_000), mk("b", 4_000), mk("big", 12_000), mk("c", 1_000)];
    const chunks = chunkRewriteItems(items as any);
    // [a,b]=8k fits; [big,c]=13k fits under the 16k budget → 2 chunks.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.map((i) => i.title)).toEqual(["a", "b"]);
    expect(chunks[1]!.map((i) => i.title)).toEqual(["big", "c"]);
  });

  test("single item over budget still gets its own chunk", () => {
    const chunks = chunkRewriteItems([mk("huge", 20_000)] as any);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });
});
