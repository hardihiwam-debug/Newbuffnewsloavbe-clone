// Tests for the shared logic that was moved OUT of the edge function so it
// could be unit-tested: greeting/prefix stripping (the "hello" post fix),
// translation model classification (direct Gemini vs gateway), and the
// deterministic multi-bot chat dedup (primary-bot row wins).
import { test, expect } from "bun:test";
import {
  cleanGeminiTranslation,
  classifyModel,
  dedupeChats,
  GEMINI_DIRECT_MODELS,
  MINIMAX_MODEL,
  type ChatRow,
} from "../supabase/functions/pipeline/_shared.ts";

// ── cleanGeminiTranslation (greeting / prefix stripping) ───────────────────
test("greeting-only output becomes empty (never publishes a bare hello)", () => {
  expect(cleanGeminiTranslation("سڵاو")).toBe("");
  expect(cleanGeminiTranslation("Hello")).toBe("");
  expect(cleanGeminiTranslation("مرحبا")).toBe("");
  expect(cleanGeminiTranslation("بەخێربێن")).toBe("");
});

test("leading greeting line is stripped, real content is kept", () => {
  expect(cleanGeminiTranslation("سڵاو\nبەغدا ڕایگەیاند کە هێرشەکە بەرپەرچ دراوە")).toBe(
    "بەغدا ڕایگەیاند کە هێرشەکە بەرپەرچ دراوە",
  );
});

test("English 'Translation:' / 'Here is' prefixes are stripped", () => {
  // Prefix on its own line is removed, content survives.
  expect(cleanGeminiTranslation("Translation:\nئەمە وەرگێڕانێکە")).toBe("ئەمە وەرگێڕانێکە");
  expect(cleanGeminiTranslation("Here is the translation\nنووسینەکە")).toBe("نووسینەکە");
  // A single line that STARTS with the prefix is dropped entirely (models
  // emit the prefix on its own line, so inline content is not expected).
  expect(cleanGeminiTranslation("Translation: ئەمە وەرگێڕانێکە")).toBe("");
});

test("markdown emphasis and list bullets are stripped", () => {
  expect(cleanGeminiTranslation("**سەرنووسە**\n- خاڵی یەکەم")).toBe("سەرنووسە\nخاڵی یەکەم");
});

test("legitimate content is untouched", () => {
  const t = "ئێران وەزارەتی دەرەوە لە هەموو هێرشێک بەرپەرچ دەداتەوە";
  expect(cleanGeminiTranslation(t)).toBe(t);
});

// ── classifyModel ───────────────────────────────────────────────────────────
test("bare Gemini ids classify as direct (GEMINI_API_KEY pool)", () => {
  for (const m of GEMINI_DIRECT_MODELS) expect(classifyModel(m)).toBe("direct");
});

test("google/* and minimax/* ids classify as gateway", () => {
  expect(classifyModel(MINIMAX_MODEL)).toBe("gateway");
  expect(classifyModel("google/gemini-2.5-flash")).toBe("gateway");
  expect(classifyModel("google/gemini-2.5-flash-lite")).toBe("gateway");
  expect(classifyModel("minimax/anything-else")).toBe("gateway");
});

test("unknown ids are rejected from the chain", () => {
  expect(classifyModel("gpt-4o")).toBe("unknown");
  expect(classifyModel("gemini-9.9-flash")).toBe("unknown");
  expect(classifyModel("")).toBe("unknown");
});

// ── dedupeChats ─────────────────────────────────────────────────────────────
const row = (id: string, chat_id: number, bot_id: string | null): ChatRow => ({ id, chat_id, bot_id });

test("collapses duplicate chat_ids", () => {
  const out = dedupeChats([row("a", 1, null), row("b", 1, "bot-x")]);
  expect(out.length).toBe(1);
});

test("primary-bot row (bot_id null) wins when both rows exist", () => {
  const out = dedupeChats([row("a", 1, "bot-x"), row("b", 1, null)]);
  expect(out.length).toBe(1);
  expect(out[0]!.id).toBe("b");
  expect(out[0]!.bot_id).toBeNull();
});

test("missing chat_id is dropped (never routed to an empty target)", () => {
  const out = dedupeChats([row("a", null as unknown as number, null), row("b", 1, null)]);
  expect(out.length).toBe(1);
  expect(out[0]!.chat_id).toBe(1);
});

test("distinct chats all kept, input order preserved for non-duplicates", () => {
  const out = dedupeChats([row("a", 1, null), row("b", 2, "bot-x"), row("c", 3, "bot-y")]);
  expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
});

test("bot_id is preserved on the surviving row", () => {
  const out = dedupeChats([row("a", 7, "bot-x"), row("b", 8, "bot-y")]);
  expect(out.map((c) => c.bot_id)).toEqual(["bot-x", "bot-y"]);
});
