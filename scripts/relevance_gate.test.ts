// Regression tests for the conflict-beat relevance gate — imports the REAL
// function from the pipeline shared module so this guards the exact shipped
// logic that admits/!drops stories before they reach the queue.

import { test, expect } from "bun:test";
import { relevanceGate } from "../supabase/functions/pipeline/_shared.ts";

const gate = (title: string, description = "") => relevanceGate(title, description).ok;

test("drops Tehran Times theatre listing", () => {
  expect(gate('“National Theater Live: Nye” to be shown at Hilaj Theater', "Hilaj Theater in Tehran will show the filmed theater")).toBe(false);
});

test("drops art-gallery exhibition", () => {
  expect(gate("Maryam Salour’s artworks on display at Iranshahr Gallery", "The solo exhibition of artworks")).toBe(false);
});

test("drops student Olympiad result", () => {
  expect(gate("Iran shines at Intl. economics, informatics Olympiads", "Iranian students clinched medals")).toBe(false);
});

test("drops marine-farming feature", () => {
  expect(gate("How China’s marine farming model can reshape Iran’s coasts")).toBe(false);
});

test("drops routine bilateral electricity cooperation", () => {
  expect(gate("Iran ready for technical co-op to improve electricity sector in Tajikistan", "Iran’s Minister of Energy met the Tajik minister")).toBe(false);
});

test("drops bare-Iran weather feature", () => {
  expect(gate("Tehran weather forecast: sunny and mild")).toBe(false);
});

test("keeps Iran policy analysis", () => {
  expect(gate("Gulf states weary of Trump’s Iran policy")).toBe(true);
});

test("keeps Iranian MP security statement", () => {
  expect(gate("Trump should worry about his security: senior Iranian MP")).toBe(true);
});

test("keeps Hamas ceasefire talks", () => {
  expect(gate("Hamas delegation heads to Cairo for Gaza ceasefire talks")).toBe(true);
});

test("keeps Iran-US talks via leadership disputes", () => {
  expect(gate("Iran leadership disputes affect talks with US")).toBe(true);
});

test("keeps pressure-on-Iran story", () => {
  expect(gate("Trump wants more pressure on Iran")).toBe(true);
});

test("keeps oil/energy market story (self-sufficient)", () => {
  expect(gate("Oil prices jump 3% as Gulf tensions rise")).toBe(true);
});

test("keeps SPR / war-on-Iran energy story", () => {
  expect(gate("US strategic petroleum reserve falls to lowest level since 1980s amid war on Iran", "172 million barrels released")).toBe(true);
});

test("keeps Khamenei warning", () => {
  expect(gate("Khamenei warns of response to any aggression")).toBe(true);
});

test("keeps major Russia-Ukraine war news", () => {
  expect(gate("Russia launches major offensive in eastern Ukraine, heavy casualties reported")).toBe(true);
});

test("drops routine Russia-Ukraine warehouse fire", () => {
  expect(gate("Drone attack hits Wildberries warehouse in Moscow")).toBe(false);
});

test("keeps US forces withdrawal from Syria (withdraw verb)", () => {
  expect(gate("US forces withdraw from Syria")).toBe(true);
});

test("keeps troop redeployment (redeploy verb)", () => {
  expect(gate("Iran redeploys troops to the border")).toBe(true);
});

test("keeps official denial (deny verb)", () => {
  expect(gate("Iranian official denies involvement in the attack")).toBe(true);
});

test("keeps Netanyahu Gaza campaign", () => {
  expect(gate("Netanyahu vows to continue Gaza campaign")).toBe(true);
});
