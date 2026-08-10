"use node";
import { createHash } from "crypto";
import type { FetchedArticle } from "./types";

export const JUNK_DOMAINS = [
  "reddit.com",
  "quora.com",
  "pinterest.com",
  "facebook.com",
  "tiktok.com",
  "marketscreener.com",
  "globenewswire.com",
  "prnewswire.com",
  "businesswire.com",
  "zacks.com",
  "simplywall.st",
  "fool.com",
];

export const BANNED_DOMAINS = [
  "timesofisrael.com",
  "jpost.com",
  "ynetnews.com",
  "ynet.co.il",
  "israelhayom.com",
  "haaretz.com",
  "i24news.tv",
  "arutzsheva.com",
  "israelnationalnews.com",
  "jns.org",
  "allisrael.com",
  "jewishpress.com",
  "timesofisrael.co.il",
];

export const BANNED_SOURCE_PATTERN =
  /times of israel|jerusalem post|ynet|israel hayom|haaretz|i24|arutz sheva|israel national news|jns|all israel|jewish press/i;

export const JUNK_TITLE_PATTERNS: RegExp[] = [
  /\b(form|files?)\s*(8-k|10-k|10-q|s-1|13[a-z]?)\b/i,
  /\bquiz\b/i,
  /\bhoroscope\b/i,
  /\bcoupon|discount code|deal of the day\b/i,
  /\b(shares?|stock)\s+(rise|fall|gain|drop)s?\s+\d+(\.\d+)?%/i,
  /\bearnings call transcript\b/i,
  /\bcrossword|wordle\b/i,
  /\bgiveaway|sweepstake\b/i,
  /\bwatch (live|online) free\b/i,
  /\b(live updates?|live blog|as it happened)\b/i,
  /\b(in focus|weekly roundup|week in review|sunday shows? preview|podcast|episode)\b/i,
  /\b(election|primary|candidate|hopefuls?|campaign)\b[^.]{0,60}\biran war\b/i,
];

export const SOFT_NEWS_PATTERNS: RegExp[] = [
  /\b(football|soccer|volleyball|basketball|wrestling|weightlifting|futsal|goalkeep\w*|striker|midfielder|league|premier league|world cup|olympic|championship|tournament|match|derby|coach|club|esteghlal|persepolis|sepahan|tractor)\b/i,
  /\b(film|movie|cinema|festival|actor|actress|director'?s cut|box office|series|drama|music|singer|concert|album|art exhibition|museum|carpet weaving|handicraft)\b/i,
  /\b(recipe|cuisine|restaurant|tourism|tourist|travel guide|hotel|resort|nowruz celebration|fashion|celebrity|royal family|dating|horoscope)\b/i,
  /\b(earthquake drill|weather forecast|air pollution index|traffic accident|road crash|bus crash|train derail)\b/i,
  /\b(school shooting|mass shooting)\b/i,
  /\b(caspian sea convention|delimitation of (the )?(seabed|subsoil)|urmia lake)\b/i,
  /\b(ai kill switch|flock cams|congressional district|special election)\b/i,
];

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

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export interface GateResult {
  ok: boolean;
  reason?: string;
}

export function sourceBanGate(article: FetchedArticle): GateResult {
  const host = hostOf(article.url);
  if (BANNED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { ok: false, reason: `banned source: ${host}` };
  }
  if (article.sourceName && BANNED_SOURCE_PATTERN.test(article.sourceName)) {
    return { ok: false, reason: `banned source: ${article.sourceName}` };
  }
  if (BANNED_SOURCE_PATTERN.test(article.title)) {
    return { ok: false, reason: "banned source attribution in title" };
  }
  return { ok: true };
}

export function junkGate(article: FetchedArticle): GateResult {
  const host = hostOf(article.url);
  if (JUNK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { ok: false, reason: `junk domain: ${host}` };
  }
  const pattern = JUNK_TITLE_PATTERNS.find((p) => p.test(article.title));
  if (pattern) return { ok: false, reason: `junk title pattern` };
  if (article.title.trim().length < 15) {
    return { ok: false, reason: "title too short" };
  }
  return { ok: true };
}

export function respectGate(article: FetchedArticle): GateResult {
  const text = `${article.title} ${article.description ?? ""}`;
  if (DISRESPECT_PATTERNS.some((p) => p.test(text))) {
    return { ok: false, reason: "disrespectful to Kurds/Muslims" };
  }
  if (NEGATIVE_IRAN_PATTERNS.some((p) => p.test(text))) {
    return { ok: false, reason: "demoralising/unsourced negative Iran framing" };
  }
  return { ok: true };
}

const BEAT_PATTERNS: RegExp[] = [
  /\b(iran|iranian|tehran|irgc|khamenei|pezeshkian|qalibaf|ghalibaf|araghchi|larijani|islamic republic|persian gulf|hormuz)\b/i,
  /\b(iraq|iraqi|baghdad|basra|mosul|erbil|sulaymaniyah|kurdistan region|najaf|karbala|sistani|sudani|pmf|hashd)\b/i,
  /\b(hezbollah|houthi|ansar allah|kataib|nujaba|axis of resistance|hamas|militia|proxy|proxies)\b/i,
  /\b(nuclear|uranium|enrich\w*|iaea|sanction\w*|snapback|jcpoa)\b/i,
  /\b(centcom|pentagon|us (navy|military|forces|troops)|carrier strike group|airstrike|air strike|missile|drone|ballistic|ceasefire|war|attack|strike)\b/i,
  /\b(oil|crude|brent|opec|barrel|refinery|tanker|shipping lane|red sea|bab el-?mandeb|gold price|bullion|energy market)\b/i,
  /\b(middle east|gulf states|saudi|riyadh|qatar|uae|oman|bahrain|kuwait|syria|lebanon|yemen|turkey|ankara)\b/i,
];

export function relevanceGate(article: FetchedArticle): GateResult {
  const text = `${article.title} ${article.description ?? ""}`;
  if (SOFT_NEWS_PATTERNS.some((p) => p.test(text))) {
    return { ok: false, reason: "off-beat soft news" };
  }
  const hits = BEAT_PATTERNS.filter((p) => p.test(text)).length;
  if (hits === 0) return { ok: false, reason: "unrelated to the conflict beat" };
  if (hits === 1 && BEAT_PATTERNS[6]!.test(text) && !/iran|iraq|us |u\.s\./i.test(text)) {
    return { ok: false, reason: "only tangential regional mention" };
  }
  const genericWarMention = /\biran war\b/i.test(text);
  const concreteEvent = /\b(attack|strike|missile|drone|killed|wounded|ceasefire|agreement|talks|negotiat|sanction|export|oil|hormuz|nuclear|military|government|minister|president|leader|commander|parliament|statement|announc|warn|percent|%)\b/i.test(text);
  if (genericWarMention && !concreteEvent) {
    return { ok: false, reason: "Iran war is only a passing mention" };
  }
  return { ok: true };
}

const NON_LATIN_SCRIPT =
  /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0900-\u097F\u0980-\u09FF\u0A00-\u0D7F\u0E00-\u0E7F\u10A0-\u10FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/u;
const ACCENTED_LATIN = /[àâäãáçéèêëíìîïñóòôöõúùûüýÿåæøœšžğışİ]/i;

const ENGLISH_MARKERS = new Set(
  "the a an and or but of to in on for from with by as at is are was were has have had will would could should says said after before over into amid about against its their his her this that these those new more not no under during between".split(" "),
);

const FOREIGN_MARKERS = new Set(
  "el los las del una unos unas con por para que como sobre entre desde este esta esos são não uma dos das pelo pela mais após contra"
    .split(" ")
    .concat("les des une aux dans pour avec sur elle ils leur cette entre depuis contre après plus être ont".split(" "))
    .concat(
      "der die das und ist nicht ein eine mit auf für von den dem sich auch werden gli della delle nella sono anche dopo contro het een van zijn niet voor bir ve ile için olarak dan yang dengan untuk"
        .split(" "),
    ),
);

export function isEnglishText(raw: string): GateResult {
  const text = raw.replace(/https?:\/\/\S+/g, " ");
  if (NON_LATIN_SCRIPT.test(text)) return { ok: false, reason: "non-English script" };
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length < 4) return { ok: false, reason: "insufficient English text" };
  const markers = words.filter((word) => ENGLISH_MARKERS.has(word)).length;
  const foreign = words.filter((word) => FOREIGN_MARKERS.has(word)).length;
  if (foreign >= 2 && foreign >= markers) {
    return { ok: false, reason: "non-English (Latin-script) language" };
  }
  const accentRatio = (text.match(new RegExp(ACCENTED_LATIN, "gi")) ?? []).length / text.length;
  if (accentRatio > 0.03) return { ok: false, reason: "heavy non-English diacritics" };
  if (markers < 2 && markers / words.length < 0.08) {
    return { ok: false, reason: "language is not confidently English" };
  }
  return { ok: true };
}

export function englishGate(article: FetchedArticle): GateResult {
  return isEnglishText(`${article.title} ${article.description ?? ""}`);
}

export function freshnessGate(
  article: FetchedArticle,
  maxAgeHours = 24,
): GateResult {
  if (!article.publishedAt) return { ok: false, reason: "no publish date" };
  const ts = Date.parse(article.publishedAt);
  if (Number.isNaN(ts)) return { ok: false, reason: "unparseable publish date" };
  const ageHours = (Date.now() - ts) / 3_600_000;
  if (ageHours < -1) return { ok: false, reason: "publish date is in the future" };
  if (ageHours > maxAgeHours) {
    return { ok: false, reason: `stale (${Math.round(ageHours)}h old)` };
  }
  return { ok: true };
}

function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.protocol = "https:";
    u.hostname = u.hostname.replace(/^www\./, "").toLowerCase();
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|oc$|amp)/i.test(key)) u.searchParams.delete(key);
    }
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return null;
  }
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set(
  "the a an of in on at to for and or with by from as is are was were be been says said after over into amid new live update updates latest breaking report reports could would should about against their his her its denies say thought".split(" "),
);

function topTokens(title: string, n = 6): string[] {
  return normalizeTitle(title)
    .split(" ")
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .slice(0, n)
    .sort();
}

export function canonicalKey(article: FetchedArticle): string {
  const normalized = normalizeUrl(article.url);
  if (normalized) {
    return "u:" + createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  }
  const day = article.publishedAt
    ? new Date(article.publishedAt).toISOString().slice(0, 10)
    : "nodate";
  const fingerprint = [
    hostOf(article.url) || article.sourceName || "unknown",
    day,
    topTokens(article.title).join("-"),
    normalizeTitle(article.title),
  ].join("|");
  return "f:" + createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
}

export function titleSimilarity(a: string, b: string): number {
  const sa = new Set(normalizeTitle(a).split(" ").filter((w) => w.length > 2));
  const sb = new Set(normalizeTitle(b).split(" ").filter((w) => w.length > 2));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

const EVENT_ALIASES: Array<[RegExp, string]> = [
  [/\b(united states|u\.s\.|us|america|american)\b/gi, "usa"],
  [/\b(donald trump|president trump|trump)\b/gi, "trump"],
  [/\b(pete hegseth|hegseth)\b/gi, "hegseth"],
  [/\b(islamic revolutionary guard corps|revolutionary guards?|irgc)\b/gi, "irgc"],
  [/\b(houthis?|ansar allah)\b/gi, "houthi"],
  [/\b(hezbollah|hizbullah)\b/gi, "hezbollah"],
  [/\b(strait of hormuz|hormuz strait)\b/gi, "hormuz"],
  [/\b(missiles?|rockets?|interceptors?|ammunition|munitions)\b/gi, "missile"],
  [/\b(stockpiles?|inventor(?:y|ies)|running low|shortages?)\b/gi, "stockpile"],
  [/\b(clash(?:ed)?|confront(?:ed|ation)?|disput(?:e|ed)|den(?:y|ies|ied))\b/gi, "dispute"],
  [/\b(strik(?:e|es|ing)|attack(?:s|ed)?|bomb(?:s|ed|ing)?|hit(?:s)?)\b/gi, "attack"],
  [/\b(reopen(?:ing)?|open(?:ing)?|restore(?:d|s)? access)\b/gi, "reopen"],
  [/\b(deal|agreement|memorandum|understanding|talks?|negotiations?)\b/gi, "agreement"],
  [/\b(ship|vessel|tanker)\b/gi, "vessel"],
  [/\b(conditions?|demands?|terms?|requirements?)\b/gi, "condition"],
];

function eventTokens(text: string): Set<string> {
  let normalized = text.toLowerCase();
  for (const [pattern, replacement] of EVENT_ALIASES) normalized = normalized.replace(pattern, replacement);
  return new Set(normalizeTitle(normalized).split(" ").filter((word) => word.length > 3 && !STOPWORDS.has(word)));
}

export function eventSimilarity(a: string, b: string): number {
  const left = eventTokens(a);
  const right = eventTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((token) => right.has(token)).length;
  const containment = shared / Math.min(left.size, right.size);
  const union = left.size + right.size - shared;
  return containment * 0.7 + (union ? shared / union : 0) * 0.3;
}

export function sameEvent(a: string, b: string, threshold = 0.52): boolean {
  const semanticThreshold = Math.min(0.78, threshold + 0.04);
  return titleSimilarity(a, b) >= threshold || eventSimilarity(a, b) >= semanticThreshold;
}

export function hasIncompleteSummary(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  if (/(?:\.\.\.|…)$/.test(value)) return true;
  return value.length > 120 && !/[.!?""']$/.test(value);
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  quot: '"',
  apos: "'",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  hellip: "\u2026",
  ndash: "\u2013",
  mdash: "\u2014",
  lt: "<",
  gt: ">",
  amp: "&",
};

function decodeAllEntities(input: string): string {
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
    .trim();
}

const TRUSTED_TIERS: Array<{ rank: number; match: RegExp }> = [
  { rank: 1, match: /reuters|apnews|associated press|bbc|afp|bloomberg/i },
  { rank: 2, match: /middle east eye|al jazeera|the guardian|nytimes|washingtonpost|ft\.com|wsj/i },
  { rank: 3, match: /cnn|nbc|cbs|abcnews|npr|dw\.com|france24|times of israel/i },
  { rank: 4, match: /irna|mehr|tasnim|press ?tv|rudaw|shafaq|amwaj/i },
];

export function sourceTrust(sourceName: string | null, url: string): number {
  const hay = `${sourceName ?? ""} ${hostOf(url)}`;
  for (const tier of TRUSTED_TIERS) if (tier.match.test(hay)) return tier.rank;
  return 9;
}

export const LEADER_PATTERN =
  /\b(khamenei|pezeshkian|qalibaf|ghalibaf|larijani|araghchi|salami|bagheri|shamkhani|raisi|zarif|supreme leader|iran'?s? president|parliament speaker|irgc (chief|commander)|foreign minister|trump|vance|rubio|hegseth|netanyahu|nasrallah|qassem|al[- ]sudani|sistani|erdogan|mbs|bin salman)\b/i;

const SPEECH_PATTERN =
  /\b(speech|speaks?|spoke|address(?:es|ed)?|remarks?|statement|declares?|declared|warns?|warned|vows?|vowed|says?|said|tells?|told|announce[sd]?|threatens?|ultimatum|press conference|sermon|interview)\b/i;

export function isLeaderStatement(text: string): boolean {
  return LEADER_PATTERN.test(text) && SPEECH_PATTERN.test(text);
}