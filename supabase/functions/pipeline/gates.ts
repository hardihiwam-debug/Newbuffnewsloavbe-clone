// Editorial gates: filters, sectarian gate and neutrality gate.
// Extracted verbatim from pipeline/index.ts (split refactor) — no behavior change.

import { STOPWORDS, normalizeTitle } from "./_shared.ts";
import { Article } from "./config.ts";
import { hostOf, hostname, sha256hex } from "./db.ts";

// ── Filters ─────────────────────────────────────────────────────────────────
export const JUNK_DOMAINS = [
  "reddit.com", "quora.com", "pinterest.com", "facebook.com", "tiktok.com",
  "marketscreener.com", "globenewswire.com", "prnewswire.com", "businesswire.com",
  "zacks.com", "simplywall.st", "fool.com", "msn.com",
];
export const BANNED_DOMAINS = [
  "timesofisrael.com", "jpost.com", "ynetnews.com", "ynet.co.il", "israelhayom.com",
  "haaretz.com", "i24news.tv", "arutzsheva.com", "israelnationalnews.com", "jns.org",
  "allisrael.com", "jewishpress.com", "timesofisrael.co.il",
];
export const BANNED_SOURCE_PATTERN =
  /times of israel|jerusalem post|ynet|israel hayom|haaretz|i24|arutz sheva|israel national news|jns|all israel|jewish press/i;
export const JUNK_TITLE_PATTERNS: RegExp[] = [
  /\b(form|files?)\s*(8-k|10-k|10-q|s-1|13[a-z]?)\b/i,
  /\bquiz\b/i, /\bhoroscope\b/i,
  /\bcoupon|discount code|deal of the day\b/i,
  /\b(shares?|stock)\s+(rise|fall|gain|drop)s?\s+\d+(\.\d+)?%/i,
  /\bearnings call transcript\b/i,
  /\bcrossword|wordle\b/i, /\bgiveaway|sweepstake\b/i,
  /\bwatch (live|online) free\b/i,
  /\b(live updates?|live blog|as it happened)\b/i,
  /\b(in focus|weekly roundup|week in review|sunday shows? preview|podcast|episode)\b/i,
];
// Price-ticker / quote-widget pages (Kitco, Investing.com tickers, exchange
// rate converters). Their "title" is a UI label ("Gold Price Canada Today |
// Live Gold Price in CAD"), not news — they used to sail through every gate
// and publish as a meaningless duplicated label. The commodity phrase must be
// paired with a strong widget marker (live/real-time/chart/spot/converter);
// a plain "gold price rises" headline is real news and must still pass.
export const PRICE_TICKER_TITLE_PATTERNS: RegExp[] = [
  /\b(?:gold|silver|platinum|palladium|oil|crude|brent|wti|gas|copper|wheat|bitcoin|ethereum|crypto|forex|currency|xau|dollar)\s+price\b[^]{0,60}\b(?:live|real[- ]time|chart|spot|convert(?:er)?|calculator|historical)\b/i,
  /\b(?:live|real[- ]time|spot)\s+(?:gold|silver|oil|crude|bitcoin|ethereum|forex|currency)?\s*(?:price|prices|chart|charts|quote|quotes|rate|rates)\b/i,
  /\b(?:price|rate|rates)\s+(?:of\s+)?(?:gold|silver|oil|dollar|bitcoin)\b[^]{0,40}\bin\s+(?:usa|us|canada|uk|india|pakistan|iraq|iran|europe|dubai|uae|turkey)\b[^]{0,20}\btoday\b/i,
  /\b(?:gold|silver|oil|dollar|bitcoin)\s+(?:price|rate|rates?)\s+in\s+(?:usa|us|canada|uk|india|pakistan|iraq|iran|europe|dubai|uae|turkey)\b[^]{0,20}\btoday\b/i,
  /\b(?:exchange\s+rate|currency\s+convert(?:er)?)\b[^]{0,40}\b(?:live|today|now|calculator)\b/i,
];
export function isPriceTickerTitle(title: string): boolean {
  return PRICE_TICKER_TITLE_PATTERNS.some((p) => p.test(title));
}
export const DISRESPECT_PATTERNS: RegExp[] = [
  /\b(dirty|filthy|savage|barbaric|inferior)\s+(kurds?|muslims?|arabs?|persians?|iranians?)\b/i,
  /\b(kurds?|muslims?|iranians?)\s+(are|is)\s+(terrorists?|animals?|vermin|scum|subhuman)\b/i,
  /\b(all|every)\s+muslims?\s+(are|is)\b/i,
  /\bislam(ic)?\s+(cancer|plague|virus|disease)\b/i,
  /\bdeath to (islam|muslims|kurds)\b/i,
  /\bexterminate\s+(the\s+)?(kurds?|muslims?)\b/i,
  /\b(kurds?|kurdish|peshmerga|kurdistan)\b[^.]{0,40}\b(terrorists?|traitors?|separatist threat|must be crushed|deserve)\b/i,
  /\b(anti[- ]?(islam|muslim)|islamophob\w+|ban (the )?(quran|hijab|mosques?))\b/i,
  /\b(quran|koran|mosque|prophet muhammad)\b[^.]{0,30}\b(burn(ed|ing)?|desecrat\w+|insult\w*|mock\w*)\b/i,
];
export const NEGATIVE_IRAN_PATTERNS: RegExp[] = [
  /\b(khamenei|supreme leader|pezeshkian|qalibaf|ghalibaf|larijani|araghchi|salami|irgc chief)\b[^.]{0,60}\b(could die|near death|dying|critical condition|dead|health crisis|incapacitat\w+|coma|fled|hiding|ousted|toppl\w+)\b/i,
  /\b(iran(ian)?|tehran|islamic republic)\b[^.]{0,60}\b(regime (change|collapse|fall|crumbl\w+)|on the brink of collapse|about to fall|humiliat\w+|defeated|surrender\w*|begging|desperate|crushed|obliterat\w+|kneel\w*|doomed|hopeless)\b/i,
  /\b(uprising|revolt|protests?)\b[^.]{0,40}\b(topple|overthrow|end of the (regime|islamic republic))\b/i,
  /\bpost[- ]?(khamenei|islamic republic) (iran|era)\b/i,
  /\b(report claims?|a report claims?|sources? claim|rumou?rs? (say|claim|suggest))\b[^.]{0,60}\b(die|death|dead|dying|assassinat\w+|flee|fled)\b/i,
  /\biran(?:ian|'s)?\b[^.]{0,80}\b(propaganda|brainwash\w*|deception|disinformation machine|war spectacle)\b/i,
];

export function gateOk(ok: boolean, reason: string): { ok: boolean; reason?: string } {
  return ok ? { ok: true } : { ok: false, reason };
}

export function sourceBanGate(a: Article): { ok: boolean; reason?: string } {
  const host = hostOf(a.url);
  if (BANNED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return gateOk(false, `banned source: ${host}`);
  if (a.sourceName && BANNED_SOURCE_PATTERN.test(a.sourceName)) return gateOk(false, `banned source: ${a.sourceName}`);
  if (BANNED_SOURCE_PATTERN.test(a.title)) return gateOk(false, "banned source attribution in title");
  return gateOk(true, "");
}
export function junkGate(a: Article): { ok: boolean; reason?: string } {
  const host = hostOf(a.url);
  if (JUNK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return gateOk(false, `junk domain: ${host}`);
  if (JUNK_TITLE_PATTERNS.some((p) => p.test(a.title))) return gateOk(false, "junk title pattern");
  if (isPriceTickerTitle(a.title)) return gateOk(false, "price ticker/quote-widget page");
  if (a.title.trim().length < 15) return gateOk(false, "title too short");
  return gateOk(true, "");
}
export function respectGate(a: Article): { ok: boolean; reason?: string } {
  const text = `${a.title} ${a.description ?? ""}`;
  if (DISRESPECT_PATTERNS.some((p) => p.test(text))) return gateOk(false, "disrespectful to Kurds/Muslims");
  if (NEGATIVE_IRAN_PATTERNS.some((p) => p.test(text))) return gateOk(false, "demoralising/unsourced negative Iran framing");
  return gateOk(true, "");
}

// ── Sectarian content gate ───────────────────────────────────────────────────
// Operator decision: this channel is not a Shia religious outlet. Many source
// channels are Shia and post religious observances (Ashura, Arbaeen, majlis,
// marja statements, mourning processions). Those are dropped; secular news
// about the same region/cities passes through normally.
export const SECTARIAN_PATTERNS: RegExp[] = [
  /عاشوراء|أربعين|الأربعين|زيارة الأربعين|الإمام الحسين|الحسين عليه السلام|الإمام علي|أمير المؤمنين|المجالس الحسينية|الحسينية|اللطمية|اللطم|الموكب الحسيني|ذكرى استشهاد|أهل البيت|المرجعية الدينية|المرجع الديني|الحوزة العلمية|الإمام المهدي|عيد الغدير|محرم الحرام|شهر محرم|زيارة الأئمة|مراسم العزاء|مواكب العزاء|السيستاني/i,
  /\bashura\b|\barbaeen\b|\bmuharram\b|\bimam (hussein|ali|mahdi|khomeini)\b|\bahl[- ]?ul[- ]?bayt\b|\bmarja\b|\bmaraji'?\b|\bhawza\b|\blatmiya\b|\blatm\b|\bmajlis\b|\bhusseiniya\b|\bmourning procession\b|\beid al[- ]ghadir\b|\bshia pilgrimage\b|\bsistani\b/i,
];
export function sectarianGate(title: string, description?: string | null): { ok: boolean; reason?: string } {
  const text = `${title} ${description ?? ""}`;
  if (SECTARIAN_PATTERNS.some((p) => p.test(text))) return gateOk(false, "Shia religious content");
  return gateOk(true, "");
}

// ── Neutrality gate ──────────────────────────────────────────────────────────
// The channel reports from the middle, it is not a combatant. Partisan war
// framing that labels a regional state actor (GCC, Saudi, UAE, Syria, Iran)
// "the enemy" is dropped so the feed stays neutral news, not militia rhetoric.
export const NEUTRALITY_PATTERNS: RegExp[] = [
  /(العدو|أعداء)\s*(السعودي|السعودية|الإماراتي|الإمارات|الامارات|الخليجي|الخليج|القطري|البحريني|الكويتي|العماني|السوري|النظام السوري|الإيراني|إيران|ايران)/i,
  /(السعودية|الإمارات|الامارات|الخليج|قطر|البحرين|الكويت|عمان|سوريا|النظام السوري|إيران|ايران)\s*(هو|هي|هم)?\s*(العدو|أعداء)/i,
  /\b(enemy|enemies)\b[^.\n]{0,40}\b(saudi|uae|emirati|emirates|gulf|gcc|qatar|bahrain|kuwait|oman|syria|syrian|iran|iranian)\b/i,
  /\b(saudi|uae|emirati|emirates|gulf|gcc|qatar|bahrain|kuwait|oman|syria|syrian|iran|iranian)\b[^.\n]{0,40}\b(enemy|enemies)\b/i,
];
export function neutralityGate(title: string, description?: string | null): { ok: boolean; reason?: string } {
  const text = `${title} ${description ?? ""}`;
  if (NEUTRALITY_PATTERNS.some((p) => p.test(text))) return gateOk(false, "partisan enemy framing (not neutral news)");
  return gateOk(true, "");
}


export const NON_LATIN_SCRIPT = /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0900-\u097F\u0980-\u09FF\u0A00-\u0D7F\u0E00-\u0E7F\u10A0-\u10FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/u;
export const ACCENTED_LATIN = /[àâäãáçéèêëíìîïñóòôöõúùûüýÿåæøœšžğışİ]/i;
export const ENGLISH_MARKERS = new Set(
  "the a an and or but of to in on for from with by as at is are was were has have had will would could should says said after before over into amid about against its their his her this that these those new more not no under during between".split(" "),
);
export const FOREIGN_MARKERS = new Set(
  "el los las del una unos unas con por para que como sobre entre desde este esta são não uma dos das pelo pela mais após contra les des une aux dans pour avec sur elle ils leur cette entre depuis contre après plus être ont der die das und ist nicht ein eine mit auf für von den dem sich auch werden gli della delle nella sono anche dopo contro het een van zijn niet voor bir ve ile için olarak dan yang dengan untuk".split(" "),
);

export function isEnglishText(raw: string): { ok: boolean; reason?: string } {
  const text = raw.replace(/https?:\/\/\S+/g, " ");
  if (NON_LATIN_SCRIPT.test(text)) return gateOk(false, "non-English script");
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length < 4) return gateOk(false, "insufficient English text");
  const markers = words.filter((w) => ENGLISH_MARKERS.has(w)).length;
  const foreign = words.filter((w) => FOREIGN_MARKERS.has(w)).length;
  if (foreign >= 2 && foreign >= markers) return gateOk(false, "non-English (Latin-script) language");
  const accentRatio = (text.match(new RegExp(ACCENTED_LATIN, "gi")) ?? []).length / text.length;
  if (accentRatio > 0.03) return gateOk(false, "heavy non-English diacritics");
  if (markers < 2 && markers / words.length < 0.08) return gateOk(false, "language is not confidently English");
  return gateOk(true, "");
}
export function freshnessGate(a: Article, maxAgeHours = 24): { ok: boolean; reason?: string } {
  if (!a.publishedAt) return gateOk(false, "no publish date");
  const ts = Date.parse(a.publishedAt);
  if (Number.isNaN(ts)) return gateOk(false, "unparseable publish date");
  const ageHours = (Date.now() - ts) / 3_600_000;
  if (ageHours < -1) return gateOk(false, "publish date is in the future");
  if (ageHours > maxAgeHours) return gateOk(false, `stale (${Math.round(ageHours)}h old)`);
  return gateOk(true, "");
}


export function topTokens(title: string, n = 6): string[] {
  return normalizeTitle(title).split(" ").filter((w) => w.length > 3 && !STOPWORDS.has(w)).slice(0, n).sort();
}
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.protocol = "https:";
    u.hostname = u.hostname.replace(/^www\./, "").toLowerCase();
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref|oc$|amp)/i.test(key)) u.searchParams.delete(key);
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return null;
  }
}
export async function canonicalKey(a: Article): Promise<string> {
  const normalized = normalizeUrl(a.url);
  if (normalized) return "u:" + (await sha256hex(normalized)).slice(0, 32);
  const day = a.publishedAt ? new Date(a.publishedAt).toISOString().slice(0, 10) : "nodate";
  const fp = [hostOf(a.url) || a.sourceName || "unknown", day, topTokens(a.title).join("-"), normalizeTitle(a.title)].join("|");
  return "f:" + (await sha256hex(fp)).slice(0, 32);
}



export function normalizeEditorial(text: string): string {
  if (!text) return text;
  let out = text;
  out = out
    .replace(/\bnorthern\s+iraq\b/gi, "Kurdistan Region")
    .replace(/\bnorth\s+of\s+iraq\b/gi, "Kurdistan Region")
    .replace(/\bnorthern\s+iraqi\b/gi, "Kurdistan Region");
  out = out.replace(/باکو[وڕر]*[یي]?\s*(?:ع|ئ)[ێيي]?راق/g, "هەرێمی کوردستان");
  return out;
}

export const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", quot: '"', apos: "'", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C",
  rdquo: "\u201D", hellip: "\u2026", ndash: "\u2013", mdash: "\u2014", lt: "<", gt: ">", amp: "&",
};
export function decodeAllEntities(input: string): string {
  let out = input;
  for (let pass = 0; pass < 3; pass++) {
    const next = out
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
    if (next === out) break;
    out = next;
  }
  return out;
}
// Headlines and summaries must never carry links — source content (RSS
// descriptions, Telegram post text) frequently embeds URLs, and the channel
// is text-only by design. Strips http(s)/www URLs and bare t.me links.
export const STRIP_LINK_RE = /(?:https?:\/\/|www\.)[^\s<>"')\]}]+/gi;
export const STRIP_TME_RE = /\bt\.me\/[^\s<>"')\]}]+/gi;
export const STRIP_TGSCHEME_RE = /\btg:\/\/[^\s<>"')\]}]+/gi;
// Telegram-style @handle mentions ("…waters @Middle_East_Spectator"). The
// negative lookbehind strips a handle at a word/dot boundary or after
// punctuation ("(@handle)", "source:@handle") while leaving emails
// (foo@bar.com) intact — an email's @ is always preceded by a word char.
export const STRIP_AT_RE = /(?<![\w.])@[A-Za-z0-9_]{2,}/g;
// A bare domain with a path ("spectator.org/12345") whose scheme was dropped
// during HTML/RSS cleanup. The "/" path requirement keeps a bare name
// ("Reuters.com") and abbreviations ("U.S.", "Aug. 21") intact; the @
// exclusion keeps email domains intact.
export const STRIP_BARE_DOMAIN_RE =
  /(?<![\w.@])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s<>"')\]}]*)/gi;
export function stripLinks(text: string): string {
  if (!text) return text;
  return text
    .replace(STRIP_LINK_RE, " ")
    .replace(STRIP_TME_RE, " ")
    .replace(STRIP_TGSCHEME_RE, " ")
    .replace(STRIP_BARE_DOMAIN_RE, " ")
    .replace(STRIP_AT_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Feed providers commonly append the outlet to the title ("Headline -
// Reuters") and models sometimes copy it into the summary. Remove only the
// item's known source in an attribution-shaped position; never remove a
// source name appearing as ordinary story content.
export function stripSourceName(text: string, sourceName: string): string {
  const value = text.trim();
  const source = sourceName.trim();
  if (!value || !source) return text;
  const bareSource = source.replace(/^@/, "").trim();
  if (!bareSource) return text;
  const sourcePattern = regexEscape(bareSource);
  const withoutSuffix = value
    .replace(new RegExp(`\\s*(?:[-–—:|·]\\s*|\\bvia\\s+|)@?${sourcePattern}(?:\\s*[-–—:|·]\\s*\\S+){0,2}[.!?]?\\s*$`, "iu"), "")
    .trim()
  if (withoutSuffix && withoutSuffix !== value) return withoutSuffix;
  const withoutPrefix = value.replace(
    new RegExp(`^@?${sourcePattern}\\s+(?:reports?|says?|writes?|via)\\s*[:,—–-]?\\s*`, "iu"),
    "",
  ).trim();
  return withoutPrefix || value;
}

export function cleanEditorialText(value: string): string {
  return decodeAllEntities(
    decodeAllEntities(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/https?:\/\/t\.co\/\S+/gi, " ")
    .replace(/pic\.twitter\.com\/\S+/gi, " ")
    .replace(/\s*The post .{0,160}? appeared first on .{0,60}?\.?\s*$/i, "")
    .replace(/\b(?:Iran[–-]?(?:US|USA)|US[–-]?Iran)\s+(?:live\s+)?updates?\s*[:|–-]?/gi, "")
    .replace(/\b(?:live updates?|live blog|as it happened)\s*[:|–-]?/gi, "")
    .replace(/\s*\*\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:©\s*\d{4}|copyright\b)[^]*?all rights reserved\.?/gi, " ")
    .replace(/\ball rights reserved\.?/gi, " ")
    .replace(/\b(?:reproduction|redistribution|republish(?:ing)?|reprint(?:ing)?)\s+(?:is|are)\s+(?:prohibited|not\s+(?:permitted|allowed))\b[^.!?]*/gi, " ")
    .replace(/\b(?:this material|this content|this article|this story)\s+(?:is protected by copyright and )?may\s+(?:not\s+)?be\s+(?:published|broadcast|rewritten|redistributed|reproduced|transmitted|republished|reprinted|copied)[^.!?]*/gi, " ")
    .replace(/نابێت بڵاوبکرێتەوە[^.!?]*/g, " ")
    .replace(/\b(?:read more|read (?:the )?full (?:story|article)|continue reading|read next)\b\.?/gi, " ")
    .replace(/\b(?:sign up for|subscribe to|download our|follow us on|access the unrivaled)\b[^.!?]*/gi, " ")
    .replace(/([.!?])\s+[.!?،؛]+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasIncompleteSummary(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  if (/(?:\.\.\.|…)$/.test(value)) return true;
  return value.length > 120 && !/[.!?""']$/.test(value);
}

