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
  const lines: string[] = [];
  if (headline.trim()) lines.push(`<b>${escapeHtml(headline)}</b>`, "");
  lines.push(escapeHtml(summary));
  if (fmt.showSource !== false) {
    const whenPart = fmt.showTimestamp === false || !when ? "" : ` · ${escapeHtml(when)}`;
    lines.push("", `${emoji ? `${escapeHtml(emoji)} ` : ""}<i>${escapeHtml(post.sourceName)}</i>${whenPart}`);
  }
  if (sources.length > 1) {
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
