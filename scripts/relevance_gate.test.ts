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

test("keeps plural-missile strike headline (missiles)", () => {
  expect(gate("Iran fires missiles at Tel Aviv overnight", "IRGC launched a wave of ballistic missiles toward Israeli cities")).toBe(true);
});

test("keeps plural-drone / plural-airstrike headlines", () => {
  expect(gate("Israeli drones hit Hezbollah outpost near the border")).toBe(true);
  expect(gate("US airstrikes target Houthi missile launchers in Yemen", "CENTCOM confirms strikes on launch sites")).toBe(true);
});

test("keeps plural-ceasefire talks headline", () => {
  expect(gate("Hamas delegation heads to Cairo for Gaza ceasefires talks", "Parties discuss a permanent truce")).toBe(true);
});

test("keeps plural-hostage crisis headline", () => {
  expect(gate("Talks stall over release of hostages held by Hamas", "Families demand a deal")).toBe(true);
});

test("still drops off-beat sports despite the plural fix", () => {
  expect(gate("Iran wins senior kyorugi, Pakistan tops poomsae at World Taekwondo President's Cup")).toBe(false);
});

// ── Commodity-gate tightening: gold/oil/domestic policy false positives ───

test("drops bare gold price news (no conflict context)", () => {
  expect(gate("Gold prices in Egypt rise 5.8% in one week")).toBe(false);
  expect(gate("Harmony Gold (NYSE:HMY): An Affordable Growth Play")).toBe(false);
  expect(gate("Egypt gold price surge 5.8 percent")).toBe(false);
});

test("drops domestic policy news even when country name matches", () => {
  expect(gate("Iran drafts two-phase housing plan at Transport Ministry")).toBe(false);
  expect(gate("IEA: Southeast Asia needs grid investment to nearly quadruple by 2050")).toBe(false);
});

test("keeps gold/oil WITH conflict context", () => {
  expect(gate("Gold sanctions imposed on Iranian proxies")).toBe(true);
  expect(gate("Oil tanker struck in Strait of Hormuz amid tensions")).toBe(true);
  expect(gate("How the US and Middle East allies flipped the oil script on Iran",
    "Washington imposed new sanctions on Iranian oil exports")).toBe(true);
});

test("keeps Iran+negotiations (governance + conflict context)", () => {
  expect(gate("US-Iran marathon negotiations resume in Oman")).toBe(true);
  expect(gate("Iran nuclear talks reach critical stage as sanctions loom")).toBe(true);
  expect(gate("Marathon Gaza ceasefire talks enter third day in Cairo")).toBe(true);
});

test("keeps forced displacement stories", () => {
  expect(gate("Israeli settlers force Palestinians from homes in West Bank's Area B")).toBe(true);
});

test("keeps Iran minister WITH conflict signal", () => {
  expect(gate("Iran's acting deputy defence minister says military remains intact")).toBe(true);
  expect(gate("Senior Khamenei adviser warns of preemptive Iranian response to threats")).toBe(true);
});
