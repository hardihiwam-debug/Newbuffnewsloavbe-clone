// Regression tests for the Google News CBMi URL decode path (fetch.ts).
// Pins the pure helpers plus the EXACT runtime regex forms against real Google
// page fragments and the real batchexecute response captured 2026-08-22 —
// the escape-layer class that silently broke before. All patterns are
// backslash-free so the deployed bundle cannot regress into literal-backslash
// matches.
import { test, expect } from "bun:test";

(globalThis as Record<string, unknown>).Deno = { env: { get: () => undefined } };

const {
  extractGoogleNewsId,
  parseGoogleDecodeResponse,
  GOOGLE_TS_RE,
  GOOGLE_SIG_RE,
  googleDecodeBudgetLeft,
  resetGoogleDecodeBudget,
  GOOGLE_DECODE_CAP_PER_CYCLE,
} = await import("../supabase/functions/pipeline/fetch.ts");

const REAL_CBMI_ID = "CBMihwFBVV95cUxOUFdpWWZwaWJNWkh3ZHBZdVVRa3BGRnpUWXZrM";

test("extractGoogleNewsId pulls the CBMi id from real wrapper URLs", () => {
  expect(
    extractGoogleNewsId(`https://news.google.com/rss/articles/${REAL_CBMI_ID}?oc=5`),
  ).toBe(REAL_CBMI_ID);
  expect(extractGoogleNewsId(`https://news.google.com/articles/${REAL_CBMI_ID}?hl=en`)).toBe(
    REAL_CBMI_ID,
  );
});

test("extractGoogleNewsId rejects non-Google and malformed URLs", () => {
  expect(extractGoogleNewsId("https://www.nytimes.com/2026/08/22/world/")).toBe(null);
  expect(extractGoogleNewsId("https://news.google.com/")).toBe(null);
  expect(extractGoogleNewsId("https://news.google.com/rss/articles/")).toBe(null);
  expect(extractGoogleNewsId("not a url")).toBe(null);
});

test("GOOGLE_TS_RE and GOOGLE_SIG_RE match the real article-page fragment (both attribute orders)", () => {
  const html =
    '<div data-n-a-ts="1787407697" data-n-a-sg="Ae5Wzi_vI9MsUgnydsLNRueGJy2u" data-n-dnlg="false"></div>';
  expect(html.match(GOOGLE_TS_RE)?.[1]).toBe("1787407697");
  expect(html.match(GOOGLE_SIG_RE)?.[1]).toBe("Ae5Wzi_vI9MsUgnydsLNRueGJy2u");
  // The reverse attribute order seen on the live page must also extract.
  const html2 = '<div data-n-a-sg="Ae5Wzi_c89I-Qx2dW8mZQiB3MocN" data-n-a-ts="1787407689"></div>';
  expect(html2.match(GOOGLE_TS_RE)?.[1]).toBe("1787407689");
  expect(html2.match(GOOGLE_SIG_RE)?.[1]).toBe("Ae5Wzi_c89I-Qx2dW8mZQiB3MocN");
});

test("parseGoogleDecodeResponse decodes the real batchexecute response", () => {
  const real =
    ")]}'\n\n" +
    '[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.canberratimes.com.au/story/9186379/israel-strikes-iran-again-after-killing-supreme-leader/\\",1]",null,null,null,""],["di",22],["af.httprm",21,"x"]]';
  expect(parseGoogleDecodeResponse(real)).toBe(
    "https://www.canberratimes.com.au/story/9186379/israel-strikes-iran-again-after-killing-supreme-leader/",
  );
});

test("parseGoogleDecodeResponse returns null on malformed or empty shapes", () => {
  expect(parseGoogleDecodeResponse("")).toBe(null);
  expect(parseGoogleDecodeResponse(")]}'\n\n{}")).toBe(null);
  expect(parseGoogleDecodeResponse(")]}'\n\n[[\"wrb.fr\",\"Fbv4je\",\"[]\"]]")).toBe(null);
  expect(
    parseGoogleDecodeResponse(')]}\'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"not a url\\",1]"]]'),
  ).toBe(null);
});

test("google decode budget starts at the cap and resets", () => {
  resetGoogleDecodeBudget();
  expect(GOOGLE_DECODE_CAP_PER_CYCLE).toBe(14);
  expect(googleDecodeBudgetLeft()).toBe(GOOGLE_DECODE_CAP_PER_CYCLE);
});
