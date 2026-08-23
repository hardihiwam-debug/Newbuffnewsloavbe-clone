import { expect, test } from "bun:test";
import {
  TEXT_STYLE_DEFINITIONS,
  TEXT_STYLE_SELECTION_IDS,
  lengthPromptRule,
  selectTextStyle,
  stylePromptParts,
} from "../supabase/functions/pipeline/_shared.ts";

test("exposes Auto assist plus the six operator writing styles", () => {
  expect(TEXT_STYLE_SELECTION_IDS).toEqual([
    "auto",
    "current",
    "professional",
    "conversational",
    "casual",
    "explainer",
    "simple",
  ]);
});

test("exposes the six operator writing styles", () => {
  expect(Object.keys(TEXT_STYLE_DEFINITIONS)).toEqual([
    "current",
    "professional",
    "conversational",
    "casual",
    "explainer",
    "simple",
  ]);
});

test("manual mode applies one global style to every story", () => {
  expect(selectTextStyle({ defaultStyle: "casual", auto: false, category: "war", breaking: true })).toBe("casual");
  expect(selectTextStyle({ defaultStyle: "professional", auto: false, category: "analysis" })).toBe("professional");
});

test("explicit category mappings beat the global default", () => {
  expect(selectTextStyle({
    defaultStyle: "professional",
    auto: true,
    byCategory: { iran: "conversational", oil: "simple" },
    category: "iran",
  })).toBe("conversational");
});

test("auto policy uses strong story signals and conservatively falls back", () => {
  expect(selectTextStyle({ defaultStyle: "professional", auto: true, category: "analysis" })).toBe("explainer");
  expect(selectTextStyle({ defaultStyle: "professional", auto: true, category: "war", breaking: true })).toBe("simple");
  expect(selectTextStyle({ defaultStyle: "professional", auto: true, category: "gold" })).toBe("simple");
  expect(selectTextStyle({ defaultStyle: "professional", auto: true, category: "iran" })).toBe("professional");
});

test("Auto assist resolves to a safe style and manual mode remains deterministic", () => {
  expect(selectTextStyle({ defaultStyle: "auto", auto: true, category: "iran" })).toBe("professional");
  expect(selectTextStyle({ defaultStyle: "auto", auto: false, category: "war" })).toBe("professional");
});

test("invalid settings never create an unsupported style", () => {
  expect(selectTextStyle({ defaultStyle: "not-a-style", auto: false })).toBe("current");
  expect(selectTextStyle({ defaultStyle: "professional", auto: true, byCategory: { iran: "not-a-style" }, category: "iran" })).toBe("professional");
});

test("custom prompt rules replace only the selected style", () => {
  const parts = stylePromptParts("professional", {
    professional: { rule: "Use my newsroom voice.", example: "Officials gave a measured update." },
  });
  expect(parts.id).toBe("professional");
  expect(parts.rule).toBe("Use my newsroom voice.");
  expect(parts.example).toBe("Officials gave a measured update.");
});

test("length contracts are explicit and auto remains source-driven", () => {
  expect(lengthPromptRule("brief")).toContain("at most 2");
  expect(lengthPromptRule("standard")).toContain("3–5");
  expect(lengthPromptRule("long_form")).toContain("150–300+");
  expect(lengthPromptRule("auto")).toContain("rich reporting");
});
