// Shared pure helpers for the pipeline (no Deno / network / DB access) so
// they can be unit-tested directly and imported by the edge function.
// Keep this file dependency-free: importing it must never touch Deno APIs.

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF ]+/g, " ").replace(/\s+/g, " ").trim();
}
export const STOPWORDS = new Set(
  "the a an of in on at to for and or with by from as is are was were be been says said after over into amid new live update updates latest breaking report reports could would should about against their his her its denies say thought".split(" "),
);

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
// Specific-place aliases (city / port / strait level, NOT country level) so
// two headlines about the same physical location normalize to one token.
// Country-level names are deliberately excluded — "Iran" appears in nearly
// every story and would over-group unrelated events.
const LOCATION_ALIASES: Array<[RegExp, string]> = [
  [/\b(mokha|mukha|al[- ]mokha|mocha)\b/gi, "locmokha"],
  [/\b(strait of hormuz|hormuz strait|hormuz)\b/gi, "lochormuz"],
  [/\b(red sea|bab[- ]al[- ]mandab|bab el mandeb)\b/gi, "locredsea"],
  [/\b(tel aviv|jerusalem|haifa|eilat)\b/gi, "loctelaviv"],
  [/\bgaza\b/gi, "locgaza"],
  [/\bbeirut\b/gi, "locbeirut"],
  [/\bdamascus\b/gi, "locdamascus"],
  [/\b(sanaa|aden|taiz|hodeidah|hudaydah)\b/gi, "locyemen"],
  [/\b(baghdad|basra|erbil|mosul)\b/gi, "lociraq"],
  [/\b(tehran|tabriz)\b/gi, "lociran"],
  [/\b(riyadh|jeddah|dhahran)\b/gi, "locsaudi"],
];
// Action words that make a location-overlap a "same event" signal. Without an
// action on BOTH sides ("Iran seizes tanker near Hormuz" vs "Hormuz shipping
// rates rise") the boost does not apply, so unrelated same-place stories are
// not merged.
const ACTION_PATTERN =
  /\b(strike|strikes|attack|attacked|missile|drone|killed|kills|assassinat|retaliat|launch(ed)?|invasion|war|ceasefire|ultimatum|sanction(s|ed)?|warns?|airstrike|air strike|bomb(ed|ing)?|shelling|barrage|salvo|casualt|death toll|escalat|fired|fires|target(ed|ing)?|seized|seize)\b/i;
function eventTokens(text: string): Set<string> {
  let normalized = text.toLowerCase();
  for (const [pattern, replacement] of EVENT_ALIASES) normalized = normalized.replace(pattern, replacement);
  for (const [pattern, replacement] of LOCATION_ALIASES) normalized = normalized.replace(pattern, replacement);
  return new Set(normalizeTitle(normalized).split(" ").filter((word) => word.length > 3 && !STOPWORDS.has(word)));
}
export function eventSimilarity(a: string, b: string): number {
  const left = eventTokens(a);
  const right = eventTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((token) => right.has(token)).length;
  const containment = shared / Math.min(left.size, right.size);
  const union = left.size + right.size - shared;
  const base = containment * 0.7 + (union ? shared / union : 0) * 0.3;
  // Same specific location + an action word on both sides => very likely the
  // same physical event even when the verbs differ ("Mokha port attack" vs
  // "al-Mokha killed four"). This stops one event being reposted from 6
  // different outlets inside the cooldown window.
  const sharedLocs = [...left].filter((t) => t.startsWith("loc") && right.has(t)).length;
  if (sharedLocs > 0 && ACTION_PATTERN.test(a) && ACTION_PATTERN.test(b)) return Math.min(1, base + 0.28);
  return base;
}
export function sameEvent(a: string, b: string, threshold = 0.52): boolean {
  const semanticThreshold = Math.min(0.78, threshold + 0.04);
  return titleSimilarity(a, b) >= threshold || eventSimilarity(a, b) >= semanticThreshold;
}

export type EventCluster = {
  event_id: string;
  label: string;
  category?: string | null;
  post_count?: number;
};

// Event identity (phase-1 review): the naive event_id scheme derives the id
// from the article itself, so Reuters / AP / Tasnim describing the same strike
// each mint a different event_id and the cluster dedup at publish never fires.
// This matches an article against the active cluster labels (same category
// only) and returns the cluster's event_id so all coverage of one incident
// shares a single id. Follow-up coverage of a known cluster is detected as a
// side effect (any match means the event already has a cluster).
export function matchEventCluster(
  articleText: string,
  category: string,
  clusters: Array<EventCluster>,
  threshold = 0.52,
): { eventId: string; label: string; isFollowUp: boolean } | null {
  let best: { eventId: string; label: string; score: number } | null = null;
  for (const c of clusters) {
    if (c.category && c.category !== category) continue;
    const label = String(c.label ?? "");
    if (!label) continue;
    const score = eventSimilarity(label, articleText);
    if (score >= threshold && (!best || score > best.score)) {
      best = { eventId: String(c.event_id), label, score };
    }
  }
  return best ? { eventId: best.eventId, label: best.label, isFollowUp: true } : null;
}

// ── Fact consistency (phase-2 review, points 1-2, 7-9) ────────────────────
// The AI may reorganize supplied facts but must never change figures and must
// never invent numbers or quotes. These helpers extract number+unit pairs from
// the source and from an AI/translation output, and flag any figure in the
// output the source does not support — the pipeline falls back to the source
// text (or retries the translation) when a guard fires.

const FACT_UNIT_PATTERN =
  /(\d[\d,.]*)\s*(killed|deaths?|dead|injured|wounded|hostages?|prisoners?|detainees?|missiles?|rockets?|drones?|tanks?|vehicles?|barrels?|people|civilians|soldiers|troops|percent|billion|million|thousand)\b/gi;
const FACT_PERCENT_PATTERN = /(\d[\d,.]*)\s*%/gi;

export function extractFactFigures(text: string): Array<{ value: string; unit: string }> {
  const out: Array<{ value: string; unit: string }> = [];
  for (const m of text.matchAll(FACT_UNIT_PATTERN)) {
    out.push({ value: m[1]!.replace(/[.,]/g, ""), unit: m[2]!.toLowerCase() });
  }
  for (const m of text.matchAll(FACT_PERCENT_PATTERN)) {
    out.push({ value: m[1]!.replace(/[.,]/g, ""), unit: "percent" });
  }
  return out;
}

// Every countable figure in the output must exist in the source with the same
// value: "12 killed" may not become "15 killed", and "2 drones" may not
// appear if the source never mentioned drones. Percent is normalized to
// "percent" so "45%" and "45 percent" match each other.
export function checkNumberConsistency(source: string, output: string): { ok: boolean; mismatches: string[] } {
  const sourceFigures = new Map<string, Set<string>>();
  for (const f of extractFactFigures(source)) {
    if (!sourceFigures.has(f.unit)) sourceFigures.set(f.unit, new Set());
    sourceFigures.get(f.unit)!.add(f.value);
  }
  const mismatches: string[] = [];
  for (const f of extractFactFigures(output)) {
    const allowed = sourceFigures.get(f.unit);
    if (!allowed) {
      mismatches.push(`${f.value} ${f.unit} (not in source)`);
    } else if (!allowed.has(f.value)) {
      mismatches.push(`${f.value} ${f.unit} (source: ${[...allowed].join("/")})`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// Lighter guard for translations: every digit sequence in the Sorani output
// must also appear in the English source (Sorani uses Latin digits, so "12"
// must stay "12" — a model that writes "15" has mistranslated a figure).
export function checkDigitPreservation(source: string, output: string): { ok: boolean; missing: string[] } {
  const normalize = (d: string) => d.replace(/[.,]/g, "");
  const sourceDigits = new Set((source.match(/\d[\d,.]*/g) ?? []).map(normalize));
  const missing: string[] = [];
  for (const d of output.match(/\d[\d,.]*/g) ?? []) {
    const n = normalize(d);
    if (!sourceDigits.has(n)) missing.push(n);
  }
  return { ok: missing.length === 0, missing };
}

// "UPDATE — " prefix for material follow-ups of an already-published event
// (phase-2 review, point 5). Idempotent: never double-prefixes.
export function buildUpdateHeadline(headline: string, prefix = "UPDATE — "): string {
  const trimmed = (headline ?? "").trim();
  if (!trimmed) return trimmed;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^${escaped}`, "i").test(trimmed)) return trimmed;
  return `${prefix}${trimmed}`;
}
const ARABIC_SCRIPT = /[\u0600-\u06FF]/u;
export function crossLanguageSimilarity(a: string, b: string): number {
  const aArabic = ARABIC_SCRIPT.test(a);
  const bArabic = ARABIC_SCRIPT.test(b);
  if (aArabic === bArabic) return 0;
  const latinTokens = (text: string): Set<string> => {
    const set = new Set<string>();
    for (const w of text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) {
      if (w.length < 4 || STOPWORDS.has(w)) continue;
      set.add(w);
    }
    return set;
  };
  const left = latinTokens(a);
  const right = latinTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const t of left) if (right.has(t)) shared += 1;
  if (shared < 2) return 0;
  if (shared < 3 && Math.min(left.size, right.size) < 4) return 0;
  return shared / Math.min(left.size, right.size);
}

const LEADER_PATTERN =
  /\b(khamenei|pezeshkian|qalibaf|ghalibaf|larijani|araghchi|salami|bagheri|shamkhani|raisi|zarif|supreme leader|iran'?s? president|parliament speaker|irgc (chief|commander)|foreign minister|trump|vance|rubio|hegseth|netanyahu|nasrallah|qassem|al[- ]sudani|sistani|erdogan|mbs|bin salman)\b/i;
const SPEECH_PATTERN =
  /\b(speech|speaks?|spoke|address(?:es|ed)?|remarks?|statement|declares?|declared|warns?|warned|vows?|vowed|says?|said|tells?|told|announce[sd]?|threatens?|ultimatum|press conference|sermon|interview)\b/i;
export function isLeaderStatement(text: string): boolean {
  return LEADER_PATTERN.test(text) && SPEECH_PATTERN.test(text);
}
const SEVERITY_L3 = /\b(all-?out war|full-?scale (war|offensive|invasion)|ground (offensive|invasion|operation)|invasion of|nuclear (strike|attack|exchange)|state of war)\b/i;
const SEVERITY_L2 = /\b(airstrike|air strike|bombed|bombing|shelling|missile (attack|strike|barrage|salvo)|drone (attack|strike)|strikes? on|casualt|death toll|massacr|\d+ killed|killed \d+|escalat|intense (fighting|clashes)|mass casualties)\b/i;
const SEVERITY_L1 = /\b(war|military (action|operation|strike)|clash(es)?|fighting|mobiliz|deploy(ed|ment)?|naval (movement|buildup|deployment)|ultimatum|sanctions?|ceasefire)\b/i;
export function severityLevel(text: string): number {
  if (SEVERITY_L3.test(text)) return 3;
  if (SEVERITY_L2.test(text)) return 2;
  if (SEVERITY_L1.test(text)) return 1;
  return 0;
}
export const SEVERITY_POINTS: Record<number, number> = { 0: 0, 1: 20, 2: 45, 3: 80 };

// ── Arabic category classifier ─────────────────────────────────────────────
// Arabic-sourced Telegram channels (al-Mayadeen, Iraqi militia channels, …)
// post in Arabic, and the English keyword blocks in keywordCategory /
// allCategoriesOf can never see them — which previously dumped every such
// post into the generic "war" fallback and starved category-specific bots
// (a bot subscribed to "iraq" never received an Arabic Iraq story). This
// pass mirrors the English precedence rules with Arabic keywords:
//   iraq → proxies → war → oil → gold → economic-impact → usa → iran
//   (non-Iran branch: war → middle-east)
export function arabicCategoriesOf(text: string): string[] {
  const t = text.toLowerCase();
  const found = new Set<string>();
  if (/العراق|بغداد|البصرة|الموصل|أربيل|اربيل|السليمانية|كركوك|الأنبار|نينوى|الحشد الشعبي|السوداني|كردستان العراق/.test(t)) found.add("iraq");
  const iranRelated = /إيران|ايران|طهران|الحرس الثوري|خامنئي|بزشكيان|بيزشكيان|قاليباف|عراقجي|الخليج الفارسي|مضيق هرمز|المرشد الأعلى|حزب الله|الحوثي|الحوثيون|أنصار الله|حماس|محور المقاومة|الحشد الشعبي|ميليشيا|ميليشيات|النجباء|سرايا/.test(t);
  if (iranRelated) {
    if (/حزب الله|الحوثي|الحوثيون|أنصار الله|كتائب|ميليشيا|ميليشيات|حماس|محور المقاومة|النجباء|سرايا|الحشد الشعبي/.test(t)) found.add("proxies");
    if (/هجوم|هجمات|ضربة|ضربات|صاروخ|صواريخ|مسيرة|مسيرات|قصف|غارة|غارات|انفجار|انفجارات|قتلى|قتيل|تصعيد|استهداف|عملية عسكرية|حرب|قوات|توغل|اشتباك|اشتباكات|غزو/.test(t)) found.add("war");
    if (/نفط|خام|أوبك|ناقلة|ناقلات|مصفاة|مصافي|برميل|بتروكيماويات|الطاقة|أسعار النفط|الغاز الطبيعي/.test(t)) found.add("oil");
    if (/ذهب|سبائك|أسعار الذهب/.test(t)) found.add("gold");
    if (/عقوبات|تضخم|أسواق|سوق|اقتصاد|صادرات|واردات|عملة|احتياطي|بورصة/.test(t)) found.add("economic-impact");
    if (/أمريكا|أميركا|الولايات المتحدة|البيت الأبيض|ترامب|واشنطن|البنتاغون|الكونغرس/.test(t)) found.add("usa");
    if (found.size === 0) found.add("iran");
  } else {
    if (/هجوم|هجمات|ضربة|ضربات|صاروخ|صواريخ|مسيرة|مسيرات|قصف|غارة|غارات|انفجار|انفجارات|قتلى|قتيل|تصعيد|استهداف|عملية عسكرية|حرب|قوات|توغل|اشتباك|اشتباكات|غزو/.test(t)) found.add("war");
    if (/إسرائيل|اسرائيل|فلسطين|غزة|لبنان|سوريا|اليمن|السعودية|الرياض|قطر|الإمارات|الامارات|تركيا|أنقرة|الأردن|الاردن|مصر/.test(t)) found.add("middle-east");
  }
  return [...found];
}

// Every category this text belongs to (same rules as keywordCategory, no
// early return). Used by the multi-bot router so a bot subscribed to ANY
// matching category receives the article, even when the primary category is
// a different one. Runs the English pass plus the Arabic pass, so Arabic-
// sourced Telegram posts route to category bots too.
export function allCategoriesOf(text: string): string[] {
  const t = text.toLowerCase();
  const found = new Set<string>();
  if (/\biraq|baghdad|basra|mosul|kurdistan region|erbil|sulaymaniyah|iraqi\b/.test(t)) found.add("iraq");
  if (/\bmiddle east eye\b/.test(t) && /analysis|explainer|opinion|why |how /.test(t)) found.add("analysis");
  const iranRelated = /iran|tehran|irgc|khamenei|persian gulf|hormuz|hezbollah|houthi|kataib|axis of resistance/.test(t);
  if (iranRelated) {
    if (/hezbollah|houthi|kataib|militia|hamas|axis of resistance/.test(t)) found.add("proxies");
    if (/strike|missile|drone|attack|airstrike|war|bomb|troops|centcom|carrier|explosion/.test(t)) found.add("war");
    if (/oil|crude|opec|tanker|hormuz|refinery|barrel/.test(t)) found.add("oil");
    if (/gold|bullion/.test(t)) found.add("gold");
    if (/sanction|inflation|market|economy|export/.test(t)) found.add("economic-impact");
    if (/trump|pentagon|washington|white house|congress|u\.s\.|united states/.test(t)) found.add("usa");
    if (found.size === 0) found.add("iran");
  } else {
    if (/strike|missile|drone|attack|airstrike|air strike|bomb|shelling|barrage|killed|kills|casualt|invasion|troops|hostage|military operation/.test(t)) found.add("war");
    if (/israel|palestin|gaza|lebanon|syria|yemen|saudi|qatar|uae|turkey/.test(t)) found.add("middle-east");
    if (/russia|russian|ukrain|kyiv|moscow|zelensky|putin|kremlin|donbass|crimea/.test(t)) found.add("war");
  }
  // Arabic pass: the instant Telegram channels the operator follows post in
  // Arabic, and the English blocks above never match them.
  for (const c of arabicCategoriesOf(t)) found.add(c);
  return [...found];
}

// Category-whitelist match for the multi-bot router. An article belongs to
// its primary category PLUS every category its source text hits (English and
// Arabic passes combined). An empty whitelist = ALL categories. A bot
// subscribed to ANY matching category receives the article.
export function botMatchesCategories(
  botCategories: string[],
  itemCategory: string,
  sourceText: string,
): boolean {
  if (botCategories.length === 0) return true;
  const itemCats = new Set<string>([itemCategory]);
  for (const c of allCategoriesOf(sourceText)) itemCats.add(c);
  return botCategories.some((c) => itemCats.has(c));
}

export function keywordCategory(text: string): string | null {
  const t = text.toLowerCase();
  if (/\biraq|baghdad|basra|mosul|kurdistan region|erbil|sulaymaniyah|iraqi\b/.test(t)) return "iraq";
  if (/\bmiddle east eye\b/.test(t) && /analysis|explainer|opinion|why |how /.test(t)) return "analysis";
  const iranRelated = /iran|tehran|irgc|khamenei|persian gulf|hormuz|hezbollah|houthi|kataib|axis of resistance/.test(t);
  if (!iranRelated) {
    // Regional war stories without an Iran keyword (Gaza/Israel/Lebanon/Yemen
    // strikes, casualties, missiles) are breaking "war" items — not generic
    // "middle-east". This is what lets the 5-minute Telegram fast lane publish
    // them immediately instead of parking them in the queue.
    if (/strike|missile|drone|attack|airstrike|air strike|bomb|shelling|barrage|killed|kills|casualt|invasion|troops|hostage|military operation/.test(t)) return "war";
    if (/israel|palestin|gaza|lebanon|syria|yemen|saudi|qatar|uae|turkey/.test(t)) return "middle-east";
    // Operator carve-out: major Russia–Ukraine war news (already admitted by
    // the ingest relevanceGate) is published as a "war" item.
    if (/russia|russian|ukrain|kyiv|moscow|zelensky|putin|kremlin|donbass|crimea/.test(t)) return "war";
    // Arabic-sourced posts (the bulk of instant Telegram channels) never
    // match the English keyword blocks; classify them with the Arabic pass so
    // they carry a real category (iraq, proxies, oil, …) instead of the
    // generic "war" fallback — this is what lets category-specific bots
    // actually receive Arabic stories about their topics.
    const ar = arabicCategoriesOf(t);
    if (ar.length > 0) return ar[0];
    return null;
  }
  if (/hezbollah|houthi|kataib|militia|hamas|axis of resistance/.test(t)) return "proxies";
  if (/strike|missile|drone|attack|airstrike|war|bomb|troops|centcom|carrier|explosion/.test(t)) return "war";
  if (/oil|crude|opec|tanker|hormuz|refinery|barrel/.test(t)) return "oil";
  if (/gold|bullion/.test(t)) return "gold";
  if (/sanction|inflation|market|economy|export/.test(t)) return "economic-impact";
  if (/trump|pentagon|washington|white house|congress|u\.s\.|united states/.test(t)) return "usa";
  return "iran";
}
export const CATEGORY_PRIORITY: Record<string, number> = {
  iraq: 70, war: 60, iran: 50, "middle-east": 42, analysis: 34, proxies: 45,
  gold: 30, usa: 30, oil: 25, "economic-impact": 20,
};
// Retrospectives / historical discussion must never be "breaking" just
// because the severity keywords appear in them: "Iranian officials discuss
// missile attacks from last year" contains "missile attacks" but is not
// breaking. We only suppress when the text points at a past period AND has
// no present-tense urgency marker ("tonight", "now", "this morning"…), so
// a genuinely fresh strike that references last year's war still breaks.
const STALE_TIME_MARKERS =
  /\b(last year|last month|last week|a year ago|years ago|months ago|weeks ago|in 20(0[0-9]|1[0-9]|2[0-5])\b|previous (year|month|week)|past (year|month|week)|anniversary|retrospective|documentary)\b/i;
const NOW_MARKERS =
  /\b(breaking|urgent|now|tonight|today|this (morning|evening|afternoon|week)|just now|minutes (ago|later)|hours (ago|later)|fresh|new(ly)? (attack|strike|wave|round|airstrike))\b/i;

export function isBreaking(
  category: string,
  text: string,
  breakingCategories: string[],
  ageHours?: number,
  maxAgeHours = 8,
): boolean {
  if (!breakingCategories.includes(category)) return false;
  // Breaking = a real strike/casualty/escalation (severity L2/L3) or an
  // official leader statement/address — AND it must be recent. A 10-hour-old
  // article containing "missile" must not become breaking just because it
  // entered the pipeline late (phase-2 review, point 6).
  if (typeof ageHours === "number" && ageHours > maxAgeHours) return false;
  // A routine mention of "war", "warns", "sanctions", "ceasefire", or
  // "ultimatum" alone no longer flags a post as breaking — that was why
  // almost every item carried the 🚨 prefix.
  if (STALE_TIME_MARKERS.test(text) && !NOW_MARKERS.test(text)) return false;
  return severityLevel(text) >= 2 || isLeaderStatement(text);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export type Post = {
  headline: string;
  summary: string;
  sourceName: string;
  url: string;
  imageUrl: string | null;
  videoUrl: string | null;
  originalPublishedAt: string | null;
  breaking: boolean;
  timezone: string;
  extraSources: Array<{ name: string; url: string }>;
};
export type PostFormat = {
  footer?: string | null;
  emoji?: string | null;
  linkLabel?: string | null;
  showSource?: boolean;
  showTimestamp?: boolean;
  // Per-source-type attribution toggles. Telegram sources have @-prefixed
  // names ("@ajanews"), everything else (RSS/NewsData/websites) is a plain
  // name ("Mehr News"). undefined means "on", matching the master toggle's
  // convention of treating null/undefined as the default.
  showTelegramSource?: boolean;
  showWebSource?: boolean;
  breakingPrefix?: string | null;
  linkPreview?: boolean;
  links?: Array<{ url: string; text: string }> | null;
};
const DEFAULT_FOOTER = "⚡ Delivered by Freebuff";
const DEFAULT_EMOJI = "🗞";
const DEFAULT_LINK_LABEL = "Read the full report";

export function formatMessage(post: Post, fmt: PostFormat = {}): string {
  const when = post.originalPublishedAt
    ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: post.timezone }).format(new Date(post.originalPublishedAt))
    : "";
  const sources = [{ name: post.sourceName, url: post.url }, ...(post.extraSources ?? [])];
  const breakingPrefix = post.breaking && fmt.breakingPrefix ? fmt.breakingPrefix : "";
  const hasTitle = Boolean(post.headline.trim());
  const headline = hasTitle ? `${breakingPrefix}${post.headline}` : "";
  const summary = hasTitle ? post.summary : `${breakingPrefix}${post.summary}`;
  // PostgREST returns NULL for unset settings, so treat null like "use the
  // default"; an empty string still means "disable this line" explicitly.
  const footer = fmt.footer == null ? DEFAULT_FOOTER : fmt.footer;
  const emoji = fmt.emoji == null ? DEFAULT_EMOJI : fmt.emoji;
  const linkLabel = fmt.linkLabel == null ? DEFAULT_LINK_LABEL : fmt.linkLabel;
  // Telegram channels use @-prefixed names; web sources (RSS/NewsData/
  // websites) use plain site names. Per-type toggles let the operator hide
  // one family without touching the other. undefined → shown, like the
  // master toggle.
  const isTelegramSource = post.sourceName.trim().startsWith("@");
  const typeShown = isTelegramSource ? fmt.showTelegramSource !== false : fmt.showWebSource !== false;
  const sourceShown = fmt.showSource !== false && typeShown;
  const lines: string[] = [];
  if (headline.trim()) lines.push(`<b>${escapeHtml(headline)}</b>`, "");
  lines.push(escapeHtml(summary));
  if (sourceShown) {
    const whenPart = fmt.showTimestamp === false || !when ? "" : ` · ${escapeHtml(when)}`;
    lines.push("", `${emoji ? `${escapeHtml(emoji)} ` : ""}<i>${escapeHtml(post.sourceName)}</i>${whenPart}`);
  }
  // Multi-source posts replace the "Read more" link with a source list. When
  // source names are hidden for this post's type, fall back to the link so a
  // hidden attribution never costs the reader the clickable reference.
  if (sources.length > 1 && sourceShown) {
    lines.push(`Sources: ${sources.map((s) => escapeHtml(s.name)).join(", ")}`);
  } else {
    lines.push(`<a href="${escapeHtml(post.url)}">${escapeHtml(linkLabel || "")}</a>`);
  }
  if (footer) lines.push("", `<i>${escapeHtml(footer)}</i>`);
  // Operator-configured hyperlinks are the very last lines of every post.
  for (const link of fmt.links ?? []) {
    const url = String(link?.url ?? "").trim();
    const label = String(link?.text ?? "").trim();
    if (url && label) lines.push(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`);
  }
  return lines.join("\n");
}

function trimSentenceTo(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = text.slice(0, budget);
  const boundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf(".\n"), head.lastIndexOf("!\n"), head.lastIndexOf("?\n"));
  if (boundary > 20) return head.slice(0, boundary + 1).trimEnd();
  const space = head.lastIndexOf(" ");
  if (space > 20) return `${head.slice(0, space).trimEnd()}…`;
  return `${head.trimEnd()}…`;
}
export function fitCaption(text: string, maxChars = 1024): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  let tailStart = lines.findIndex((l) => l.startsWith("🗞 ") || l.startsWith("Sources:") || l.startsWith("<a href=") || l.startsWith("<i>"));
  if (tailStart === -1) tailStart = lines.length;
  const headStart = (lines[0] ?? "").startsWith("<b>") ? 2 : 0;
  if (headStart >= tailStart) return `${text.slice(0, maxChars - 1).trimEnd()}…`;
  const summaryBlock = lines.slice(headStart, tailStart).join("\n");
  const overhead = text.length - summaryBlock.length;
  const budget = Math.max(60, maxChars - overhead);
  if (summaryBlock.length <= budget) return text.slice(0, maxChars).trimEnd();
  lines.splice(headStart, tailStart - headStart, trimSentenceTo(summaryBlock, budget));
  return lines.join("\n");
}

// Pure decision for sendPost: which Telegram send* method should be attempted
// for a post + its ingest media_kind. Lives here (not inline) so the unit
// tests exercise the exact same branch logic the live function uses.
export function chooseDeliveryMode(
  post: Post,
  mediaKind: "photo" | "video_thumb" | null,
): "photo" | "video" | "text" {
  // Real video -> sendVideo. Wins over any image, since for Telegram posts a
  // recovered .mp4 URL is strictly better than a poster-frame fallback.
  if (post.videoUrl) return "video";
  // Real photo -> sendPhoto. We refuse to sendPhoto a video_thumb: the public
  // listing HTML only carries the JPEG poster frame for a real Telegram video,
  // and shipping that as a still image is misleading. Web/RSS/NewsData
  // articles carry mediaKind = null (the discriminator only exists for
  // Telegram posts), so a null kind with an image is a real photo and must
  // still be sent as one.
  if (post.imageUrl && mediaKind !== "video_thumb") return "photo";
  return "text";
}


// ── Sorani translation validator ────────────────────────────────────────────
// Rejects outputs that are clearly not Kurdish Sorani (English or
// Latin-transliterated text). The allowed charset deliberately includes the
// U+FE0F variation selector (FE00-FEFF) so valid translations that preserve
// Telegram emojis like "❗️" / "⭕️" are NOT rejected — that regression used to
// bounce every emoji-prefixed Telegram post to the English fallback.
export const SORANI_ALLOWED =
  /^[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE00-\uFEFF0-9\s\p{P}\p{S}\p{Extended_Pictographic}A-Za-z.-]*$/u;
export function validateSorani(text: string): boolean {
  if (!text.trim()) return false;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const arabic = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) ?? []).length;
  if (arabic < 2) return false;
  // A real Sorani translation of a Lebanon/Israel story keeps many Latin
  // proper nouns (Israel, Merkava, place names). Reject only when Latin
  // clearly dominates the Sorani script — English output has ~0 Arabic
  // chars and is already rejected above.
  if (latin > Math.max(50, arabic)) return false;
  return SORANI_ALLOWED.test(text);
}


// ── Robust LLM JSON extraction ──────────────────────────────────────────────
// Llama-class models (Groq / OpenRouter / Cloudflare all serve Llama 3.3)
// frequently emit a valid JSON object followed by trailing prose, or two
// concatenated objects. JSON.parse on the whole string then throws
// "Unexpected non-whitespace character after JSON". This returns just the
// FIRST balanced {...} object so the parser only ever sees clean JSON.
export function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
// ── Relevance / beat gate ───────────────────────────────────────────────────
// Pure classification: does a story belong to the Iran/Iraq conflict beat?
// Moved here (from the edge function) so it is unit-testable. `title` and
// `description` are the raw ENGLISH source text.

export const SOFT_NEWS_PATTERNS: RegExp[] = [
  /\b(football|soccer|volleyball|basketball|wrestling|weightlifting|futsal|goalkeep\w*|striker|midfielder|league|premier league|world cup|olympic|olympiad|championship|tournament|match|derby|coach|club|esteghlal|persepolis|sepahan|tractor)\b/i,
  /\b(film|movie|cinema|festival|actor|actress|director'?s cut|box office|series|drama|music|singer|concert|album|art exhibition|exhibition|gallery|artwork(?:s)?|painting|sculpture|photography|pottery|ceramic|theatre|theater|dance|ballet|opera|poetry|poem|museum|carpet weaving|handicraft)\b/i,
  /\b(recipe|cuisine|restaurant|tourism|tourist|travel guide|hotel|resort|nowruz celebration|fashion|celebrity|royal family|dating|horoscope)\b/i,
  /\b(aquaculture|mariculture|marine farm(?:ing)?|fish farm(?:ing)?|fisheries)\b/i,
  /\b(electricity (?:sector|grid|co-?op(?:eration)?|transmission)|power (?:grid|sector|transmission))\b/i,
  /\b(earthquake drill|weather forecast|air pollution index|traffic accident|road crash|bus crash|train derail)\b/i,
  /\b(school shooting|mass shooting)\b/i,
  /\b(caspian sea convention|delimitation of (the )?(seabed|subsoil)|urmia lake)\b/i,
];

export const BEAT_PATTERNS: RegExp[] = [
  /\b(iran|iranian|tehran|irgc|khamenei|pezeshkian|qalibaf|ghalibaf|araghchi|larijani|islamic republic|persian gulf|hormuz)\b/i,
  /\b(iraq|iraqi|baghdad|basra|mosul|erbil|sulaymaniyah|kurdistan region|najaf|karbala|sistani|sudani|pmf|hashd)\b/i,
  /\b(hezbollah|houthi|ansar allah|kataib|kata.?ib|nujaba|axis of resistance|hamas|militia|proxy|proxies|popular mobilization|badr|asayib|saraya|resistance front)\b/i,
  /\b(nuclear|uranium|enrich\w*|iaea|sanction\w*|snapback|jcpoa)\b/i,
  /\b(centcom|pentagon|us (navy|military|forces|troops)|carrier strike group|airstrike|air strike|missile|drone|ballistic|ceasefire|war|attack|strike)\b/i,
  /\b(oil|crude|brent|opec|barrel|refinery|tanker|shipping lane|red sea|bab el-?mandeb|gold (price|prices?|market|rally|climb|slip|fall|rise|surge|trad\w*|futures)|bullion|natural gas|lng|petrochemical|energy market)\b/i,
  /\b(middle east|gulf states|saudi|riyadh|qatar|uae|oman|bahrain|kuwait|syria|lebanon|yemen|turkey|ankara|israel|israeli|netanyahu|tel aviv|idf|golan|jordan|amman|egypt|cairo|gaza|west bank|palestin\w*|kurdish|kurd|peshmerga|sdf)\b/i,
];

export function relevanceGate(
  title: string,
  description?: string | null,
): { ok: boolean; reason?: string } {
  const text = `${title} ${description ?? ""}`;
  if (SOFT_NEWS_PATTERNS.some((p) => p.test(text))) return { ok: false, reason: "off-beat soft news" };

  // Self-sufficient signals — conflict/security, proxies, nuclear and the
  // oil/gold/energy market pass on their own, without needing a country word.
  const selfSufficient = /\b(hezbollah|houthi|ansar allah|hamas|militia|axis of resistance|irgc|kataib|kata.?ib|nujaba|popular mobilization|badr|asayib|saraya|resistance front|proxy|proxies|missile|ballistic|airstrike|air strike|ceasefire|invasion|offensive|shelling|bombing|death toll|massacre|hostage|captive|carrier strike group|centcom|pentagon|hormuz|nuclear|uranium|enrich\w*|iaea|sanction\w*|snapback|jcpoa|oil|crude|brent|opec|barrel|refiner\w*|tanker|natural gas|lng|petrochemical|gold|bullion)\b/i.test(text);
  if (selfSufficient) return { ok: true };

  // Actor/location inside the beat (Iran, Iraq, wider Middle East) plus US
  // military engagement in the region.
  const inBeat = [BEAT_PATTERNS[0], BEAT_PATTERNS[1], BEAT_PATTERNS[6]].some((p) => p!.test(text));
  const usRegional = /\b(centcom|pentagon|us (navy|military|forces|troops)|carrier strike group)\b/i.test(text);
  // A concrete development is required when only a location matched — a bare
  // "Iran" mention (a feature, a student prize, a routine bilateral meeting)
  // is not a conflict-beat story.
  const concrete = /\b(attack\w*|strike\w*|clash\w*|escalat\w*|tension\w*|threat\w*|warn\w*|vow\w*|denounce|condemn|retaliat\w*|respond\w*|response|deni\w*|killed|dead|death|wounded|injured|casualt\w*|military|troops|forces|navy|army|defense|defence|deploy\w*|redeploy\w*|reinforce\w*|mobiliz\w*|intercept\w*|withdraw\w*|ministry|minister|president|prime minister|leader|leadership|commander|official\w*|parliament|government|regime|diploma\w*|negotiat\w*|talks|agreement|deal|policy|policies|pressure|election\w*|protest\w*|uprising|arrest\w*|detain\w*|execut\w*|sentenc\w*|intelligence|spy|espionage|security|border|crossing|smuggl\w*|missile|drone|war|conflict|ceasefire|sanction\w*|export\w*|import\w*|pipeline)\b/i.test(text);
  if ((inBeat || usRegional) && concrete) return { ok: true };

  // Operator carve-out: only MAJOR Russia–Ukraine war news (invasion,
  // offensive, casualties, mass strikes) — never routine "drone hit a
  // warehouse" noise.
  const ru = /\b(russia|russian|ukrain\w*|kyiv|moscow|zelensky|putin|kremlin|donbass|crimea)\b/i.test(text);
  const ruMajor = /\b(invasion|offensive|counter[- ]?offensive|front[- ]?line|escalat\w+|war|ceasefire|peace (talks|deal|negotiat\w+)|surrender|casualt\w*|\d+\s+(killed|dead)|deadly|massacre|mass[- ]?grave|mobiliz\w+|annex\w+|territor\w+|massive (airstrike|strike|attack|barrage)|missile barrage|energy (grid|infrastructure)|blackout)\b/i.test(text);
  if (ru && ruMajor) return { ok: true };

  return { ok: false, reason: "unrelated to the conflict beat" };
}

// ── Source daily quota accounting (pure — unit-tested) ─────────────────────
// Same-day calls accumulate; the counter resets the first time we touch it on
// a new day. `today` is the caller's date key (YYYY-MM-DD, UTC for now).
export function computeQuotaPatch(
  today: string,
  usedToday: number | null | undefined,
  quotaDate: string | null | undefined,
  calls: number,
): { used_today: number; quota_date: string } {
  const sameDay = quotaDate === today;
  return {
    used_today: (sameDay ? Number(usedToday ?? 0) : 0) + calls,
    quota_date: today,
  };
}

// ── Translation cleanup (greeting / prefix stripping) ──────────────────────
// Models (MiniMax, Gemini 2.5 via gateway, …) sometimes open a translation
// with a greeting — "سڵاو" (hello) etc. A news post never needs one, and one
// bad case published ONLY the greeting as the whole post. Strip leading
// greeting lines; a greeting-only output becomes empty and is then rejected
// by validateSorani, so the chain falls through to the next model.
export const GREETING_LINE_RE =
  /^(سڵاو(ی|تان|یە)?|سڵا|بەخێربێ(ن|یت|ی)?|السلام عليكم|السلام علیکم|اهلا|اهلاً|مرحبا|hello|hi|hallo|hey)[.!،,]*\s*$/i;

export function cleanGeminiTranslation(raw: string): string {
  let text = raw.trim();
  const lines = text.split(/\r?\n/);
  while (lines.length > 0) {
    const head = (lines[0] ?? "").trim();
    if (!head) break;
    if (GREETING_LINE_RE.test(head)) {
      lines.shift();
      continue;
    }
    if (/^(here(\u2019s|'s| is)?|translation[:：]|the (standard |english |kurdish )?translation|in (kurdish|sorani|english)[:：]?|output[:：])/i.test(head) && !/^[\u0600-\u06FF]/.test(head)) {
      lines.shift();
    } else break;
  }
  text = lines.join("\n").trim();
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  return text.replace(/^\s*[-*]\s+/gm, "").trim();
}

// ── Translation model classification ───────────────────────────────────────
// Direct-REST Gemini model chain (runs against the GEMINI_API_KEY_1..6 pool)
// and the MiniMax model id as surfaced in Settings → Translation model order.
// Kept in sync with migration 0017's seed and the Settings page default.
export const GEMINI_DIRECT_MODELS = [
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
];
export const MINIMAX_MODEL = "minimax/minimax-m3";

// Classify a model id from the translation_model_order list: gateway-hosted
// (google/*, minimax/*) route through the Vercel AI Gateway; bare direct
// Gemini ids (gemini-3.7-flash, …) hit the Google REST API with the
// GEMINI_API_KEY_1..6 pool.
export function classifyModel(id: string): "gateway" | "direct" | "unknown" {
  if (id === MINIMAX_MODEL || id.startsWith("google/") || id.startsWith("minimax/")) return "gateway";
  if (GEMINI_DIRECT_MODELS.includes(id)) return "direct";
  return "unknown";
}

// ── Multi-bot chat dedup ────────────────────────────────────────────────────
// The same chat can end up registered more than once (the primary bot and an
// additional bot are both members of one channel, or a group was re-added).
// Publishing to each duplicate row double-sends every story, so collapse to
// unique chat_ids before any send loop.
//
// When a chat has BOTH a primary-bot row (bot_id = null) and an additional-
// bot row, the primary row wins deterministically: the additive design keeps
// the primary bot delivering everything, and an additional bot only ADDS
// category-filtered copies to chats the primary bot cannot reach. Without a
// stable preference, row order decides which bot sends, so a channel where
// both bots are members would nondeterministically get either all categories
// or only the whitelisted ones.
export type ChatRow = { id: string; chat_id: number; bot_id: string | null };

export function dedupeChats(chats: Array<ChatRow>): Array<ChatRow> {
  const seen = new Set<string>();
  const sorted = [...chats].sort((a, b) => {
    const aPrimary = a.bot_id === null || a.bot_id === undefined ? 0 : 1;
    const bPrimary = b.bot_id === null || b.bot_id === undefined ? 0 : 1;
    return aPrimary - bPrimary;
  });
  return sorted.filter((c) => {
    const key = String(c.chat_id ?? "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function gateVerdict(ok: boolean, reason: string): { ok: boolean; reason?: string } {
  return ok ? { ok: true } : { ok: false, reason };
}

// ── Anti-Kurd hostile framing gate ──────────────────────────────────────────
// Operator rule: the channel is neutral and never carries hostile content
// against Kurds. Many Shia/militia channels publish statements attacking the
// Peshmerga or Kurdistan (calls to disband them, "most armed militia",
// "danger to Iraq's unity", "traitors"). Those are dropped in Arabic, Sorani
// and English; neutral or pro-Kurd news (condemnations of attacks on Erbil,
// friendly statements) passes normally.
export const KURD_HOSTILE_PATTERNS: RegExp[] = [
  // calls to disband / dismantle the Peshmerga
  /حل (قوات )?(البيشمركة|البشمركة|البيشمرگة)|حل قوات البشمركة|هەڵوەشاندنەوەی (هێزەکانی )?پێشمەرگە|هەڵوەشاندنەوەی پێشمەرگە/i,
  // Peshmerga labelled a militia / outlaw / danger / threat (not when it is
  // the target — "تتصدى لتهديدات داعش" (confronts ISIS threats) is neutral
  // news and must pass)
  /(البيشمركة|البشمركة|پێشمەرگە)(?!\s*(تتصدى|تصد|يدافع|تدافع|يقاوم|ترد|تردع|تصدي))[^.]{0,40}(ميليشيا|ميليشيات|الميليشيات|خارج عن القانون|خطر|خطورة|تهديد|تهديدات|مترسی|مەترسی|هەڕەشە|خەطر)/i,
  /(ميليشيا|ميليشيات|الميليشيات|ميليشيا مسلحة)[^.]{0,40}(البيشمركة|البشمركة|پێشمەرگە)/i,
  // Kurds / Kurdistan framed as a threat to Iraq's unity or as traitors
  /(الأكراد|أكراد|الاكراد|كردستان|كوردستان|کوردستان|کورد|كورد)[^.]{0,50}(خطر|تهديد|خطورة|مؤامرة|خونة|خونة|خيانة|عمالة|عملاء|غدر|تقسيم العراق|وحدة العراق)/i,
  /(وحدة العراق|تقسيم العراق)[^.]{0,50}(الأكراد|أكراد|الاكراد|كردستان|كوردستان|البيشمركة|البشمركة)/i,
  /(الأكراد|أكراد|الاكراد)[^.]{0,40}(إرهابيون|إرهابيين|ارهابيون|ارهابيين|داعشيون)/i,
  /(کورد|كورد)[^.]{0,40}(خیانەت|نابەدڵ|تیرۆریست)/i,
  /(کوردستان|كوردستان)[^.]{0,50}(مەترسی|هەڕەشە|خەطر|تیرۆر)/i,
  // English mirror of the Arabic/Sorani patterns
  /\bdisband\b[^.]{0,40}\bpeshmerga\b/i,
  /\bpeshmerga\b[^.]{0,40}\b(militia|terrorists?|traitors?|danger|threat|must be (disbanded|crushed))\b/i,
  /\b(kurds?|kurdish|kurdistan)\b[^.]{0,50}\b(traitors?|terrorists?|danger to|threat to|must be crushed)\b/i,
];

export function kurdHostileGate(title: string, description?: string | null): { ok: boolean; reason?: string } {
  const text = `${title} ${description ?? ""}`;
  if (KURD_HOSTILE_PATTERNS.some((p) => p.test(text))) return gateVerdict(false, "anti-Kurd hostile framing (not neutral news)");
  return gateVerdict(true, "");
}

// ── Arabic / editorial junk gate ────────────────────────────────────────────
// Many Telegram channels mix real news with dialectal poetry, militia
// statements, food/lifestyle posts and opinion essays that carry no factual
// news value. The English JUNK_TITLE_PATTERNS cannot see these, so a
// dedicated Arabic blocklist keeps the feed factual.
export const ARABIC_JUNK_PATTERNS: RegExp[] = [
  // dialectal poetry / riddles
  /أيسرُّك|ما بعت|ما خفت|ما صافحت|يا (الشاب|شاب)|التشوفه|تلگى بيه|عنده نخوة|الزّلم|الملثم|من ينفذ صبرها/i,
  // food / lifestyle
  /وجبة (العشاء|الغداء|الفطور)|سهمكم العافية/i,
  // militia statements / propaganda rants
  /العساف|ابو مجاهد|كتائب حزب ابو|المسؤول الأمني لكتائب|لقد صبرنا|صبرنا لاكثر|فإننا نذكر|نذكر الزيدي|دماؤنا تنزف|خزائنك بالمليارات|إنك كنت تمارس التجارة/i,
  // self-attributed opinion essays / editorializing
  /مصدر كردي للفقار|تساؤلات حول ما إذا كان|ليس (حادثًا|حادثا) عرضيًا|تطور خطير يهدد|(وهو|وهي) ما يخدم|التي تخدم المشاريع/i,
];

export function editorialJunkGate(title: string, description?: string | null): { ok: boolean; reason?: string } {
  const text = `${title} ${description ?? ""}`;
  if (ARABIC_JUNK_PATTERNS.some((p) => p.test(text))) return gateVerdict(false, "Arabic junk/opinion/poetry");
  return gateVerdict(true, "");
}
