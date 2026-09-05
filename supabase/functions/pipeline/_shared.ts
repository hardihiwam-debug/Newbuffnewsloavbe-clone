// Shared pure helpers for the pipeline (no Deno / network / DB access) so
// they can be unit-tested directly and imported by the edge function.
// Keep this file dependency-free: importing it must never touch Deno APIs.

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF ]+/g, " ").replace(/\s+/g, " ").trim();
}

// ── Writing-style policy ───────────────────────────────────────────────────
// Styles are an editorial register, not a permission to add facts. The
// registry is shared by the pipeline and the tests so the UI and AI prompt
// always describe the same six operator-visible choices. `auto` is a global
// selection mode, not a prompt style: it resolves to one of these six styles
// before the model is called.
export const TEXT_STYLE_IDS = [
  "current",
  "professional",
  "conversational",
  "casual",
  "explainer",
  "simple",
] as const;
export type TextStyleId = (typeof TEXT_STYLE_IDS)[number];
export const TEXT_STYLE_SELECTION_IDS = ["auto", ...TEXT_STYLE_IDS] as const;
export type TextStyleSelectionId = (typeof TEXT_STYLE_SELECTION_IDS)[number];
export type TextLengthId = "auto" | "brief" | "standard" | "long_form";
export type TextStyleDefinition = { label: string; description: string; rule: string; example: string };

export const TEXT_STYLE_DEFINITIONS: Record<TextStyleId, TextStyleDefinition> = {
  current: {
    label: "Current version",
    description: "Keep the existing wire-editor behavior unchanged.",
    rule: "Use the existing neutral wire-editor rules. Do not introduce a new tone or structure.",
    example: "Officials said the talks would continue, but no agreement was announced.",
  },
  professional: {
    label: "Professional",
    description: "Formal, structured, neutral, and precise.",
    rule: "Write like a professional wire service: formal but readable, neutral, precise, and complete. Use full names and titles when known. Lead with the verified development and keep attribution clear.",
    example: "Officials are weighing a two-week extension of the ceasefire, regional sources said.",
  },
  conversational: {
    label: "Conversational",
    description: "Friendly and clear without becoming informal.",
    rule: "Use a warm, reader-friendly voice and short clear sentences. You may use a light 'Here is what happened' framing, but remain factual, restrained, and suitable for a news channel.",
    example: "Here is what happened: officials said they were open to the proposal, but had not signed anything yet.",
  },
  casual: {
    label: "Casual",
    description: "Relaxed and approachable; use sparingly for hard news.",
    rule: "Use an approachable, relaxed voice with simple sentence rhythm. Never use slang, jokes, hype, contractions that alter meaning, or a casual tone for casualties, attacks, or unverified claims.",
    example: "Gold is climbing again as investors react to market concerns.",
  },
  explainer: {
    label: "Explainer",
    description: "Adds context, significance, and what to watch.",
    rule: "Put the development in context: explain what changed, why it matters, who is affected, and what to watch next. Clearly separate source-reported facts from analysis. Do not invent context that is absent from the source.",
    example: "The extension would buy two more weeks of calm, but the core dispute would remain unresolved.",
  },
  simple: {
    label: "Simple",
    description: "Plain words, short sentences, and low jargon.",
    rule: "Use plain everyday words, short sentences, and an easy reading level. Keep exact figures, names, dates, and attribution. Avoid jargon and do not remove important qualifications.",
    example: "Several cargo ships changed route because of the disruption. Two were stopped, according to the report.",
  },
};

export function normalizeTextStyle(value: unknown): TextStyleId {
  // `auto` is resolved by selectTextStyle; if an old caller disables the
  // policy while the global selection is still auto, use the safe professional
  // fallback rather than accidentally reverting to the legacy current prompt.
  if (String(value) === "auto") return "professional";
  return TEXT_STYLE_IDS.includes(String(value) as TextStyleId) ? String(value) as TextStyleId : "current";
}

export function normalizeTextLength(value: unknown): TextLengthId {
  return ["auto", "brief", "standard", "long_form"].includes(String(value)) ? String(value) as TextLengthId : "auto";
}

export function selectTextStyle(input: {
  defaultStyle?: unknown;
  auto?: unknown;
  byCategory?: unknown;
  category?: string | null;
  breaking?: boolean;
  text?: string;
}): TextStyleId {
  const fallback = normalizeTextStyle(input.defaultStyle);
  if (input.auto === false) return fallback;
  const map = input.byCategory && typeof input.byCategory === "object"
    ? input.byCategory as Record<string, unknown>
    : {};
  const mapped = input.category ? String(map[input.category] ?? "") : "";
  if (TEXT_STYLE_IDS.includes(mapped as TextStyleId)) return mapped as TextStyleId;
  // Auto is deliberately conservative: only strong editorial signals move
  // away from the operator's global default. A blank or malformed policy can
  // therefore never make the channel randomly casual.
  if (input.category === "analysis") return "explainer";
  if (input.breaking) return "simple";
  if (["oil", "gold", "economic-impact"].includes(input.category ?? "")) return "simple";
  return fallback;
}

export function stylePromptParts(style: unknown, customRules?: unknown): { id: TextStyleId; rule: string; example: string } {
  const id = normalizeTextStyle(style);
  const base = TEXT_STYLE_DEFINITIONS[id];
  const overrides = customRules && typeof customRules === "object"
    ? (customRules as Record<string, unknown>)[id]
    : null;
  const custom = overrides && typeof overrides === "object" ? overrides as Record<string, unknown> : {};
  return {
    id,
    rule: String(custom.rule ?? base.rule).trim().slice(0, 1200) || base.rule,
    example: String(custom.example ?? base.example).trim().slice(0, 500) || base.example,
  };
}

// Count how many times `sequence` appears in `tokens` as a contiguous token
// run (non-overlapping). A headline echoed twice in a description is the exact
// EnergyNow / CryptoRank / L'Orient Today junk pattern.
function countTokenSequence(tokens: string[], sequence: string[]): number {
  if (sequence.length === 0 || tokens.length < sequence.length) return 0;
  let count = 0;
  let i = 0;
  while (i <= tokens.length - sequence.length) {
    let match = true;
    for (let j = 0; j < sequence.length; j++) {
      if (tokens[i + j] !== sequence[j]) { match = false; break; }
    }
    if (match) {
      count += 1;
      i += sequence.length;
    } else {
      i += 1;
    }
  }
  return count;
}

// Remove every occurrence of `sequence` from `tokens`, returning what is left.
// A title + publisher echo leaves nothing real behind; genuine reporting
// leaves a residue of non-headline words.
function removeTokenSequence(tokens: string[], sequence: string[]): string[] {
  if (sequence.length === 0) return tokens;
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let match = true;
    for (let j = 0; j < sequence.length; j++) {
      if (i + j >= tokens.length || tokens[i + j] !== sequence[j]) { match = false; break; }
    }
    if (match) {
      i += sequence.length;
    } else {
      out.push(tokens[i]!);
      i += 1;
    }
  }
  return out;
}

// A headline-only source is not evidence for a detailed rewrite. This guard is
// intentionally conservative: a genuinely different description is treated as
// reporting, even when it is short. It only returns true when the description
// is missing or is effectively the title repeated, optionally followed by the
// publisher's boilerplate name.
//
// Why it was hardened: several publisher feeds (EnergyNow, CryptoRank, L'Orient
// Today) duplicate the ENTIRE title inside the description — "<title> -
// <publisher> <title> <publisher>" — and some also truncate the <title> field
// itself. The old prefix-only check (suffix after the FIRST title occurrence
// <= 60 chars) missed them because the suffix contained the second, full copy
// of the title. The guard now also counts headline occurrences (>= 2 = echo)
// and removes EVERY headline occurrence, checking nothing real remains.
// ── #2 Cross-source headline fusion ────────────────────────────────────────
// A title-only wire item whose event is ALSO covered by other fetched outlets
// can be rescued: their headlines (+ any snippet) are fused into a synthetic
// body so extraction sees several independent reports instead of one bare
// headline. Pure text concat of ALREADY-FETCHED material — no new facts are
// invented, and every contributing outlet stays inside the text.
// ── Summary-source routing (Tier 1 extractive lede) ────────────────────────
// Bodies in this band carry a real (short) professional lede: shipping the
// source's own words beats an AI paraphrase of them. Zero LLM calls.
export const EXTRACTIVE_MIN_CHARS = 240;
export const EXTRACTIVE_MAX_CHARS = 800;

/** First 1-2 complete sentences of the body, verbatim — the wire lede.
 *  Returns null when no clean sentence boundary exists in the first half
 *  (then the item is better served by the AI path). */
export function extractiveLede(text: string, maxChars = 650): string | null {
  const t = (text ?? "").trim();
  if (t.length < EXTRACTIVE_MIN_CHARS) return null;
  const ends: number[] = [];
  for (const m of t.matchAll(/[.!?](?:\s|$)/g)) {
    if (m.index !== undefined && m.index >= 40) ends.push(m.index + 1);
  }
  if (ends.length === 0) return null;
  const one = ends[0]!;
  const two = ends.length > 1 ? ends[1]! : -1;
  const cut = two > 0 && two <= maxChars ? two : one;
  const lede = t.slice(0, cut).trim();
  // Sanity: a lede that is basically the whole text is fine, but one that is
  // absurdly long means runaway sentences → let the AI path handle it.
  return lede.length >= 80 && lede.length <= maxChars + 150 ? lede : null;
}

/** Target character budget for the compression call, from text_length. */
export function compressTargetChars(textLength: string | undefined | null): number {
  switch (String(textLength ?? "auto")) {
    case "brief": return 350;
    case "long_form": return 900;
    default: return 550; // standard + auto
  }
}

export function fuseHeadlineTexts(
  targetTitle: string,
  siblings: Array<{ title: string; description?: string | null }>,
): string | null {
  const parts: string[] = [targetTitle.trim()];
  for (const s of siblings.slice(0, 3)) {
    const t = String(s.title ?? "").trim();
    if (!t) continue;
    const d = String(s.description ?? "").trim();
    parts.push(d.length > 60 ? `${t}. ${d.slice(0, 400)}` : t);
  }
  const fused = parts.join(" ").replace(/\s*\.\s*\./g, ".").trim();
  return fused.length >= 240 ? fused : null;
}

export function isHeadlineOnlySource(title: string, description: string | null | undefined, sourceName = ""): boolean {
  const clean = (value: string) => value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const headline = clean(title);
  const bodyRaw = clean(description ?? "");
  if (!headline || !bodyRaw) return true;
  // Drop the publisher name everywhere — feeds append "Title - Publisher" and
  // sometimes repeat it after the duplicated title too.
  let body = bodyRaw;
  const source = clean(sourceName);
  if (source) body = bodyRaw.split(source).join(" ").replace(/\s+/g, " ").trim();
  if (body === headline) return true;
  const titleTokens = headline.split(" ").filter(Boolean);
  const bodyTokens = body.split(" ").filter(Boolean);
  const overlap = titleTokens.length === 0
    ? 0
    : titleTokens.filter((token) => bodyTokens.includes(token)).length / titleTokens.length;

  // The echo class: the full (or truncated) headline appears >= 2 times as a
  // token sequence inside a SHORT description (real reporting never repeats
  // the exact headline phrase, and junk feeds do it every time), or the body
  // is entirely consumed by headline occurrences (nothing real remains). The
  // 400-char bound keeps the >= 2 rule off genuine articles that merely quote
  // their own headline once or twice.
  if (titleTokens.length >= 3) {
    if (countTokenSequence(bodyTokens, titleTokens) >= 2 && body.length <= 400) return true;
    if (removeTokenSequence(bodyTokens, titleTokens).length === 0) return true;
  }

  // Typical feed payload: "<headline> <publisher>" (ABC-style short suffix).
  // Do not classify a real paragraph as title-only.
  const titlePrefix = body.startsWith(headline) ? body.slice(headline.length).trim() : "";
  return Boolean(titlePrefix) && titlePrefix.length <= 60 && overlap >= 0.85;
}

// Sorani connectors that cannot end a sentence. "…گوشار دەخەنە سەر" — a
// translation ending on a preposition (سەر = "on") stopped mid-phrase; it is
// a structural failure, not a stylistic choice. Shared by the headline check,
// the body check and the safe trims so all three agree on what is dangling.
// بێ ("without") is the post-fix miss: "…فێری ژیان دەکات بێ —" ("…learns to
// live without —") ended exactly on it and published.
const SORANI_DANGLING_ENDINGS = new Set([
  "لە", "بە", "بۆ", "و", "کە", "لەسەر", "لەگەڵ", "بەپێی", "دەربارەی", "تا",
  "سەر", "بەسەر", "لەناو", "لەژێر", "پاش", "دوای", "نزیک", "بەڵام", "ئەگەر",
  "کاتێک", "هەر", "لەلایەن", "بەهۆی", "وەک", "بەرەو",
  // Added after the "فێری ژیان دەکات بێ" post: prepositions/conjunctions the
  // model also stops on.
  "بێ", "بەبێ", "پێش", "لەپێش", "لەدوای", "لەبەر", "هەرچەندە", "یان", "بەڵکو", "بۆیە", "هەروەها", "وە", "نەک", "بەرامبەر", "لەدەست", "لەگەڵدا",
]);

// English dangling words plus the Sorani connectors — the headline-level
// incompleteness vocabulary.
const INCOMPLETE_HEADLINE_ENDINGS = new Set([
  "a", "an", "the", "in", "at", "on", "to", "of", "for", "with", "from", "by", "after", "before", "and", "or", "but", "that", "which", "who", "as", "into", "over", "under", "near", "about", "without", "until", "unless", "than", "within", "against",
  ...SORANI_DANGLING_ENDINGS,
]);

// Translation providers occasionally stop after a connector when producing a
// headline block (for example Sorani "... قوتابخانەیەکی کچان لە" = "... girls'
// school in"), or the feed itself truncates the <title> field with a trailing
// dash. A headline that ends on a dash/ellipsis, or on a dangling connector,
// is structurally incomplete — never a stylistic choice.
export function isIncompleteHeadline(headline: string): boolean {
  const trimmed = (headline ?? "").trim();
  if (!trimmed) return true;
  // A rewritten English headline that starts with a lowercase word lost its
  // subject ("challenges Trump claim on Iran's nuclear status" — WHO
  // challenges?). Real headlines name an actor first; quotes, digits and
  // non-Latin scripts are unaffected by this ASCII-lowercase check.
  // Exemptions: Arabic article prefixes (al-Qaeda, al Jazeera) and brands
  // whose names legitimately begin lowercase (i24NEWS, iPhone, eBay).
  if (/^[a-z]/.test(trimmed) && !/^(al[- ]|el[- ]|i24|iphone|ipad|ios|ipod|ebay|etsy|tiktok|whatsapp|youtube|instagram)/i.test(trimmed)) return true;
  // "…بێ —", "…ناوەڕاست —", "…continue…" — a trailing dash or ellipsis is a
  // visible truncation even when the word before it is a noun.
  if (/[—–…]\s*$/.test(trimmed) || /\.{2,}\s*$/.test(trimmed) || /-{2,}\s*$/.test(trimmed)) return true;
  const last = trimmed
    .replace(/[\s.,!?;:،؛…—–-]+$/g, "")
    .trim()
    .split(/\s+/)
    .pop()
    ?.toLocaleLowerCase() ?? "";
  return INCOMPLETE_HEADLINE_ENDINGS.has(last);
}

// Return a complete source headline for the rare case where all translation
// attempts still produce an interrupted title. Removes a trailing dash/
// ellipsis and a single dangling connector — safer than publishing a visibly
// unfinished sentence.
export function safeHeadlineFallback(headline: string): string {
  const value = (headline ?? "").trim();
  if (!value) return value;
  let out = value.replace(/[\s—–…]+$/g, "").trim();
  const last = out
    .replace(/[\s.,!?;:،؛]+$/g, "")
    .trim()
    .split(/\s+/)
    .pop()
    ?.toLocaleLowerCase() ?? "";
  if (INCOMPLETE_HEADLINE_ENDINGS.has(last)) {
    out = out.replace(/\s+\S+\s*$/, "").trim();
  }
  return out.replace(/[\s—–….,!?;:،؛]+$/g, "").trim();
}

// True when the same figure appears more than once in a headline — the garbled
// ticker-translation class ("٥،٤٨٢ تاکای ٥٤٨٢" = one number twice in a single
// title, digits and separators mangled). Only numbers with 3+ digits count, so
// the legit "3 killed, 3 injured" pattern never trips it; identical figures in
// a one-line headline are machine garbage, not reporting.
export function hasRepeatedFigure(headline: string): boolean {
  const value = (headline ?? "").trim();
  if (!value) return false;
  const toLatin = (s: string) => s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  // Accept both Latin and Arabic-Indic digits AND both thousands separators
  // ("5,482" / "٥،٤٨٢" / "٥٬٤٨٢") so "٥،٤٨٢ تاکای ٥٤٨٢" folds to 5482 twice.
  const numbers = value.match(/[\d٠-٩][\d٠-٩,.,،٬]*/g)?.map((n) => n.replace(/[،,٬]/g, "")) ?? [];
  const counts = new Map<string, number>();
  for (const n of numbers) {
    if (n.replace(/\./g, "").length < 3) continue;
    const key = toLatin(n);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].some((c) => c >= 2);
}

// ── Final title completeness resolution (publish-time guarantee) ─────────
// The last line of defense before a post ships: NEVER publish a visibly
// unfinished headline, in EITHER language. The English path can carry a
// feed-truncated <title> and the Sorani path may still be broken if every
// translation retry + fallback failed. This pure resolver encodes the
// decision so it is unit-testable without a DB: trim a dangling connector;
// if nothing complete remains, mark the post for DROP instead of shipping a
// broken title. Callers decide what "drop" means (delete the queue row).
// An empty headline (title-less Telegram items) is exempt — action "kept",
// nothing to do.
export type HeadlineResolution =
  | { drop: true; action: "dropped" }
  | { drop: false; headline: string; action: "kept" | "trimmed" | "figures-fixed" };

export function resolveFinalHeadline(headline: string): HeadlineResolution {
  const value = (headline ?? "").trim();
  if (!value) return { drop: false, headline: "", action: "kept" };
  if (isIncompleteHeadline(value)) {
    const fixed = safeHeadlineFallback(value);
    if (!fixed || isIncompleteHeadline(fixed)) {
      return { drop: true, action: "dropped" };
    }
    return { drop: false, headline: fixed, action: "trimmed" };
  }
  if (hasRepeatedFigure(value)) {
    // Garbled title survived every retry (source headline repeats a figure
    // too) — still never ship the doubled-number garbage when the fallback
    // produces a clean title. If it can't, keep what we have rather than
    // dropping on a number (degraded, never dropped — matches publish.ts
    // behavior before this extraction).
    const fixed = safeHeadlineFallback(value);
    if (fixed && !hasRepeatedFigure(fixed)) {
      return { drop: false, headline: fixed, action: "figures-fixed" };
    }
  }
  return { drop: false, headline: value, action: "kept" };
}

// True when a Sorani translation's last word is a dangling connector — the
// model stopped mid-phrase. Same structural check as isIncompleteHeadline,
// applied to the translated BODY (which is what the channel actually shows
// for Telegram posts, and what carries the truncated "…گوشار دەخەنە سەر"
// endings).
export function isIncompleteSoraniEnding(text: string): boolean {
  const value = (text ?? "").trim();
  if (!value) return false;
  const last = value
    .replace(/[\s.,!?;:،؛…—–-]+$/g, "")
    .trim()
    .split(/\s+/)
    .pop()
    ?.toLocaleLowerCase() ?? "";
  if (SORANI_DANGLING_ENDINGS.has(last)) return true;
  // Mid-word cuts a connector list cannot know: a truncated caption ends on a
  // fragment ("…ئینگلتەر" = ئینگلتەرا cut, "…هەیە ل" = لە cut, "…بەسەرچوو&"
  // = an unterminated HTML entity). A single-letter final token or a raw "&"
  // is structurally a cut, never a complete Sorani word.
  if (last.length === 1 || last.includes("&")) return true;
  return false;
}

// Remove a trailing dangling connector from a Sorani body when every retry
// still produced it — safer than publishing a visibly unfinished sentence.
export function safeSoraniEnding(text: string): string {
  const value = (text ?? "").trim();
  if (!value) return value;
  const last = value
    .replace(/[\s.,!?;:،؛…—–-]+$/g, "")
    .trim()
    .split(/\s+/)
    .pop()
    ?.toLocaleLowerCase() ?? "";
  const dangling = SORANI_DANGLING_ENDINGS.has(last);
  const entityCut = last.includes("&");
  const fragment = last.length === 1;
  if (!dangling && !entityCut && !fragment) return value;
  if (entityCut && !dangling) {
    // "…بەسەرچوو&" → "…بەسەرچوو": strip the raw entity fragment, keep the word.
    return value.replace(/&[^\s]*$/u, "").trimEnd();
  }
  // Drop the dangling connector / single-letter fragment (the final token).
  return value.replace(/\s+\S+\s*$/, "").replace(/[\s,;:،؛]+$/, "").trim();
}

// The translator is handed "<english headline>\n\n<summary>" and sometimes
// echoes the English headline inside its Sorani output (the "English —
// SoraniTitle" leak: the channel showed the headline twice, once in English
// and once translated). English headline text never belongs inside a Sorani
// body, so removing exact occurrences of the source headline is always safe.
export function stripEchoedEnglishHeadline(body: string, headline: string): string {
  if (!body || !headline) return body;
  const h = headline.trim();
  if (!h) return body;
  const escaped = escapeRegExp(h);
  // The boundary class is any non-word separator that can hug a headline:
  // spaces, dashes, pipes, dots, quotes, parens, brackets.
  const separators = `\\s\\-–—|·:;,.'"()\\[\\]`;
  let out = body
    .replace(new RegExp(`(?:^|[${separators}])(?:${escaped})(?=[${separators}]|$)`, "gi"), " ")
    .replace(/\s+/g, " ")
    // Drop a separator left behind where the echo was removed (e.g. the "—"
    // after an English headline in a Sorani body).
    .replace(new RegExp(`^[${separators}]+|[${separators}]+$`, "g"), "")

  // Fuzzy leading echo: the model often echoes a TRUNCATED headline (cut at
  // ~60 chars) that exact-match misses. When the body opens with a long-enough
  // prefix of the headline followed by a separator, that prefix is an echo —
  // strip it. Safe for ckb posts: an English headline prefix in a Sorani body
  // is never legitimate content.
  const longestPrefix = Math.min(60, h.length);
  for (let k = longestPrefix; k >= 24; k -= 3) {
    const prefix = h.slice(0, k);
    if (!prefix.trim()) continue;
    const prefixRe = new RegExp(`^[${separators}]*${escapeRegExp(prefix)}(?=[${separators}]|$)`);
    if (prefixRe.test(out)) {
      out = out.replace(prefixRe, " ").replace(/\\s+/g, " ").trim();
      break;
    }
  }
  return out;
}export function stripEchoedSoraniHeadline(body: string, soraniHeadline: string): string {
  if (!body || !soraniHeadline) return body;
  const h = soraniHeadline.trim();
  if (!h || !/[\u0600-\u06FF]/.test(h)) return body;
  const escaped = escapeRegExp(h);
  // The boundary class is any non-word separator that can hug a soraniHeadline:
  // spaces, dashes, pipes, dots, quotes, parens, brackets.
  const separators = `\\s\\-–—|·:;,.'"()\\[\\]`;
  let out = body
    .replace(new RegExp(`(?:^|[${separators}])(?:${escaped})(?=[${separators}]|$)`, "gi"), " ")
    .replace(/\s+/g, " ")
    // Drop a separator left behind where the echo was removed (e.g. the "—"
    // after an English soraniHeadline in a Sorani body).
    .replace(new RegExp(`^[${separators}]+|[${separators}]+$`, "g"), "")

  // Fuzzy leading echo: the model often echoes a TRUNCATED soraniHeadline (cut at
  // ~60 chars) that exact-match misses. When the body opens with a long-enough
  // prefix of the soraniHeadline followed by a separator, that prefix is an echo —
  // strip it. Safe for ckb posts: an English soraniHeadline prefix in a Sorani body
  // is never legitimate content.
  const longestPrefix = Math.min(60, h.length);
  for (let k = longestPrefix; k >= 24; k -= 3) {
    const prefix = h.slice(0, k);
    if (!prefix.trim()) continue;
    const prefixRe = new RegExp(`^[${separators}]*${escapeRegExp(prefix)}(?=[${separators}]|$)`);
    if (prefixRe.test(out)) {
      out = out.replace(prefixRe, " ").replace(/\\s+/g, " ").trim();
      break;
    }
  }
  return out;
}

// Telegram channels append their own footer to every post ("@handle سەرچاوە
// کەناڵ #ئێران", a trailing line of hashtags, or a self-mention). That footer
// is content noise that would otherwise be translated straight into the
// Sorani body (and then become the "title" via the first-180-chars rule).
// Strips trailing footer lines and inline footer remnants; never touches
// content lines.
export function stripChannelFooter(text: string, sourceName: string): string {
  let out = (text ?? "").trim();
  if (!out) return out;
  const handle = sourceName.replace(/^@/, "").trim().toLowerCase();
  const MARKERS = ["سەرچاوە", "کەناڵ", "المصدر", "القناة", "source", "channel", "via", "بوو"];
  // Drop trailing footer LINES: empty lines, lines whose tokens are all
  // hashtags (#ئێران #شەڕ), and lines made only of source/channel markers.
  // A content line (Arabic or not) is never classified as a footer.
  const lines = out.split(String.fromCharCode(10));
  while (lines.length > 0) {
    const line = (lines[lines.length - 1] ?? "").trim();
    if (!line) { lines.pop(); continue; }
    const tokens = line.toLowerCase().split(" ").filter(Boolean);
    if (tokens.length === 0) { lines.pop(); continue; }
    const allHashtags = tokens.every((t) => t.startsWith("#"));
    const markerOnly = tokens.every((t) => MARKERS.includes(t) || t.startsWith("#") || t.startsWith("@"));
    if (!allHashtags && !markerOnly) break;
    lines.pop();
  }
  out = lines.join(String.fromCharCode(10)).trim();
  // Inline footer remnant on the last content line: "…سەرچاوە کەناڵ #تێگ".
  // Cut at the EARLIEST marker, and only when the WHOLE tail from there is
  // footer-ish (markers, hashtags, handles, separators) — never a content
  // word that merely contains "کەناڵ" or "سەرچاوە" as a substring.
  const markerIdxs = ["سەرچاوە", "کەناڵ", "المصدر", "القناة"]
    .map((m) => out.lastIndexOf(m))
    .filter((i) => i >= 0);
  if (markerIdxs.length > 0) {
    const remIdx = Math.min(...markerIdxs);
    const tail = out.slice(remIdx);
    const footerish =
      tail.length <= 60 &&
      tail.split(/\s+/).filter(Boolean).every((t) => {
        const low = t.toLowerCase();
        return (
          MARKERS.includes(low) ||
          low.startsWith("#") ||
          low.startsWith("@") ||
          /^[·:|—–-]+$/.test(t)
        );
      });
    if (footerish) out = out.slice(0, remIdx).trim();
  }
  if (handle.length >= 4) {
    const tail = " " + handle;
    if (out.toLowerCase().endsWith(tail)) out = out.slice(0, -tail.length).trim();
  }
  return out;
}

// Collapse a source name the feed duplicated ("L'Orient Today L'Orient
// Today", "@InsiderPaper @InsiderPaper") back to the single name — those
// doubled names ship straight into the Telegram byline. Only fires when the
// whole name is the name twice (first half of the words == second half); any
// other name passes through untouched.
export function dedupeSourceName(name: string): string {
  const value = (name ?? "").trim();
  if (!value) return value;
  const words = value.split(/\s+/).filter(Boolean);
  // A single word can't be a duplicated name; 2+ words are checked (the halves
  // must be equal, so "The National" and "L'Orient Today" pass through).
  if (words.length < 2) return value;
  const half = Math.floor(words.length / 2);
  const foldWord = (w: string) => w.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/gi, "");
  const left = words.slice(0, half).map(foldWord).join(" ");
  const right = words.slice(half).map(foldWord).join(" ");
  return left === right ? words.slice(0, half).join(" ") : value;
}

export function lengthPromptRule(length: unknown): string {
  switch (normalizeTextLength(length)) {
    case "brief": return "Keep the summary to at most 2 concise factual sentences.";
    case "standard": return "Write 3–5 informative factual sentences; include the most important context available.";
    case "long_form": return "Write a detailed 150–300+ word summary only when the source contains enough facts; never pad a thin source.";
    default: return "Choose length from the source: rich reporting may be 150–300+ words, while thin reporting stays short but includes every concrete fact. Never pad or invent.";
  }
}

// True when a provider call failed in a way that will not self-heal within
// the current pipeline cycle (quota exhausted, auth rejected, missing
// credits, rate-limited, server error) — such providers are skipped for the
// rest of the cycle instead of re-burning wall-clock on every chunk.
// Transient failures (timeouts, network, JSON parse) are NOT hard failures.
export function isHardProviderFailure(message: string): boolean {
  return /\b(?:401|402|403|404|429|5\d\d)\b/.test(message);
}

// Per-attempt timeout for the rewrite provider chain: a chunk has a hard
// wall-time budget (rewriteDeadline), and each provider call used to be
// allowed the ENTIRE remaining window — so one slow response (a shared
// free-tier model stalling 15-30s) consumed the budget and the fallback
// providers never got a turn, logging "rewrite budget exhausted before any
// provider responded" and shipping raw source titles for the tail chunks of
// the batch. Instead, each attempt gets at most half the remaining window
// (capped 30s, floored 15s) so a second provider can still get a turn when
// the window is healthy. The 15s floor is deliberate: the measured rewrite
// workhorse (Mistral small — which carries the batch whenever Groq's free
// tier hard-fails) takes 8-12s per 5-item chunk, and the previous 8s floor
// sat BELOW that latency, so a tight window killed Mistral at 8s even though
// it would have succeeded a moment later.
export function rewriteAttemptTimeoutMs(remainingMs: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 15_000;
  return Math.min(30_000, Math.max(15_000, Math.floor(remainingMs / 2)));
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
  /\b(strike|strikes|attack|attacked|missiles?|drone|killed|kills|assassinat|retaliat|launch(ed)?|invasion|war|ceasefires?|ultimatum|sanction(s|ed)?|warns?|airstrikes?|air strike|bomb(ed|ing)?|shelling|barrage|salvo|casualt|death toll|escalat|fired|fires|target(ed|ing)?|seized|seize)\b/i;
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

// Instant Telegram uses a bounded fetch window rather than the normal rolling
// snapshot. A post must have a real publication timestamp inside the window;
// posts without one are intentionally ignored once a watermark exists because
// accepting them would re-open the entire anonymous channel snapshot.
export function isInstantTelegramPostInWindow(
  publishedAt: string | null | undefined,
  windowStartMs: number,
  fetchCompletedAtMs: number,
): boolean {
  if (!publishedAt) return false;
  const at = Date.parse(publishedAt);
  return Number.isFinite(at) && at > windowStartMs && at <= fetchCompletedAtMs;
}

// Related Instant posts are merged verbatim before queueing. Shared generic
// categories are not enough: require a shared named entity/location and either
// a shared action or enough semantic overlap to describe the same development.
export function areTelegramPostsRelated(a: string, b: string, threshold = 0.52): boolean {
  const left = fingerprintArticle("", a);
  const right = fingerprintArticle("", b);
  const overlap = (xs: string[], ys: string[]) => xs.some((x) => ys.includes(x));
  const sharedEntity =
    overlap(left.actors, right.actors) ||
    overlap(left.targets, right.targets) ||
    Boolean(left.specificLocation && left.specificLocation === right.specificLocation) ||
    Boolean(left.location && left.location === right.location);
  if (!sharedEntity) return false;
  const sharedAction = Boolean(left.action && right.action && left.action === right.action);
  return sharedAction || eventSimilarity(a, b) >= threshold;
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

// ── Real article-date freshness (shared by ingest + publish) ───────────────
// Feeds (Google News RSS, NewsData, aggregator RSS) re-stamp old stories with
// crawl timestamps, so the feed's pubDate is NOT a trustworthy age signal —
// that is how a 2-month-old article from a re-crawled feed can pass the
// ingest freshness gate. The only honest signal is the article page's own
// published date, and both layers that touch a queue candidate must agree on
// the same window. These two helpers are that single source of truth.
export function maxArticleAgeHours(text: string, limits: AgeLimits = DEFAULT_AGE_LIMITS): number {
  if (/\b(attack|strike|missiles?|drone|war|explosion|airstrikes?|houthi|hezbollah|irgc|centcom|hormuz|nuclear)\b/i.test(text)) return limits.breaking;
  if (/\b(analysis|explainer|commentary|opinion)\b/i.test(text)) return limits.analysis;
  return limits.news;
}
// ── Real article-date freshness (shared by ingest + publish) ───────────────
// Age limits are operator-customizable (Settings → Scheduler → Freshness
// limits; settings columns max_age_*_hours / telegram_max_age_hours). The
// defaults preserve the original hardcoded values.
export type AgeLimits = { breaking: number; news: number; analysis: number };
export const DEFAULT_AGE_LIMITS: AgeLimits = { breaking: 14, news: 22, analysis: 48 };
export function ageLimitsFrom(row: Record<string, unknown> | null | undefined): AgeLimits {
  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    breaking: num(row?.max_age_breaking_hours, DEFAULT_AGE_LIMITS.breaking),
    news: num(row?.max_age_news_hours, DEFAULT_AGE_LIMITS.news),
    analysis: num(row?.max_age_analysis_hours, DEFAULT_AGE_LIMITS.analysis),
  };
}
export function realDateCheckOk(
  publishedTimeIso: string,
  text: string,
  now = Date.now(),
  limits: AgeLimits = DEFAULT_AGE_LIMITS,
): { ok: boolean; ageHours: number; maxAge: number; verified: boolean } {
  const ts = Date.parse(publishedTimeIso);
  if (Number.isNaN(ts)) return { ok: true, ageHours: 0, maxAge: maxArticleAgeHours(text, limits), verified: false };
  const ageHours = Math.max(0, (now - ts) / 3_600_000);
  const maxAge = maxArticleAgeHours(text, limits);
  return { ok: ageHours <= maxAge, ageHours, maxAge, verified: true };
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
const SEVERITY_L2 = /\b(airstrikes?|air strike|bombed|bombing|shelling|missile (attack|strike|barrage|salvo)|drone (attack|strike)|strikes? on|casualt|death toll|massacr|\d+ killed|killed \d+|escalat|intense (fighting|clashes)|mass casualties)\b/i;
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
// Specific conflict-region keyword blocks (English). Checked BEFORE the
// generic war/middle-east/proxies buckets so a Gaza school strike, a Beirut
// hit, or a Damascus drone raid routes to its own category (own filter, own
// bot whitelist, own priority) instead of the catch-all buckets.
const GAZA_RE = /\bgaza|rafah|khan younis|khan yunis|jabalia|jabaliya|nuseirat|al-shifa|west bank|jenin|palestin/;
const SYRIA_RE = /\bsyria|damascus|aleppo|homs|idlib|deir ez-?zor|raqqa|daraa|lattakia|latakia|tartus|assad\b/;
const LEBANON_RE = /\blebanon|beirut|hezbollah|baalbek|nabatieh|litani/;
const GAZA_AR_RE = /غزة|رفح|خان يونس|جباليا|نصيرات|الشجاعية|الضفة|جنين|طولكرم|فلسطين/;
const SYRIA_AR_RE = /سوريا|سورية|دمشق|حلب|حمص|إدلب|دير الزور|الرقة|درعا|اللاذقية|طرطوس/;
const LEBANON_AR_RE = /لبنان|بيروت|الضاحية|جنوب لبنان|بعلبك|النبطية|حزب الله/;

// The complete, canonical category set. Single source of truth: the AI
// categorizer is whitelisted against it (never trusts the model blindly), the
// admin bot-whitelist and the Settings pickers mirror it, and the fingerprint
// coverage test pins it to the SQL migration.
export const ALLOWED_CATEGORIES = [
  "iraq", "war", "iran", "middle-east", "analysis", "proxies", "gold",
  "usa", "oil", "economic-impact", "gaza", "syria", "lebanon",
] as const;

// Generic buckets: a text that matches NONE of the keyword blocks (0 hits —
// today it would be dropped as off-topic or defaulted to "war") or only ONE
// generic bucket (iran / war / middle-east — any of which could be several
// specific stories) is genuinely ambiguous. Everything else is confident
// keyword routing. This is the gate for the AI-assisted categorizer.
export function categoryNeedsAi(text: string): boolean {
  const cats = allCategoriesOf(text);
  if (cats.length === 0) return true;
  if (cats.length === 1 && (cats[0] === "iran" || cats[0] === "war" || cats[0] === "middle-east")) return true;
  return false;
}

// Whitelist an LLM's category answer against the canonical set. The model is
// free-form text; we never insert a raw string into the queue.
export function normalizeAiCategory(raw: string): string | null {
  const c = raw.trim().toLowerCase().replace(/[^a-z-]/g, "");
  return (ALLOWED_CATEGORIES as readonly string[]).includes(c) ? c : null;
}

export function arabicCategoriesOf(text: string): string[] {
  const t = text.toLowerCase();
  const found = new Set<string>();
  if (/العراق|بغداد|البصرة|الموصل|أربيل|اربيل|السليمانية|كركوك|الأنبار|نينوى|الحشد الشعبي|السوداني|كردستان العراق/.test(t)) found.add("iraq");
  const iranRelated = /إيران|ايران|طهران|الحرس الثوري|خامنئي|بزشكيان|بيزشكيان|قاليباف|عراقجي|الخليج الفارسي|مضيق هرمز|المرشد الأعلى|حزب الله|الحوثي|الحوثيون|أنصار الله|حماس|محور المقاومة|الحشد الشعبي|ميليشيا|ميليشيات|النجباء|سرايا/.test(t);
  if (iranRelated) {
    if (GAZA_AR_RE.test(t)) found.add("gaza");
    if (SYRIA_AR_RE.test(t)) found.add("syria");
    if (LEBANON_AR_RE.test(t)) found.add("lebanon");
    if (/الحوثي|الحوثيون|أنصار الله|كتائب|ميليشيا|ميليشيات|حماس|محور المقاومة|النجباء|سرايا|الحشد الشعبي/.test(t)) found.add("proxies");
    if (/هجوم|هجمات|ضربة|ضربات|صاروخ|صواريخ|مسيرة|مسيرات|قصف|غارة|غارات|انفجار|انفجارات|قتلى|قتيل|تصعيد|استهداف|عملية عسكرية|حرب|قوات|توغل|اشتباك|اشتباكات|غزو/.test(t)) found.add("war");
    if (/نفط|خام|أوبك|ناقلة|ناقلات|مصفاة|مصافي|برميل|بتروكيماويات|الطاقة|أسعار النفط|الغاز الطبيعي/.test(t)) found.add("oil");
    if (/ذهب|سبائك|أسعار الذهب/.test(t)) found.add("gold");
    if (/عقوبات|تضخم|أسواق|سوق|اقتصاد|صادرات|واردات|عملة|احتياطي|بورصة/.test(t)) found.add("economic-impact");
    if (/أمريكا|أميركا|الولايات المتحدة|البيت الأبيض|ترامب|واشنطن|البنتاغون|الكونغرس/.test(t)) found.add("usa");
    if (found.size === 0) found.add("iran");
  } else {
    if (GAZA_AR_RE.test(t)) found.add("gaza");
    if (SYRIA_AR_RE.test(t)) found.add("syria");
    if (LEBANON_AR_RE.test(t)) found.add("lebanon");
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
    if (GAZA_RE.test(t)) found.add("gaza");
    if (SYRIA_RE.test(t)) found.add("syria");
    if (LEBANON_RE.test(t)) found.add("lebanon");
    if (/houthi|kataib|militia|hamas|axis of resistance/.test(t)) found.add("proxies");
    if (/strike|missiles?|drone|attack|airstrikes?|war|bomb|troops|centcom|carrier|explosion/.test(t)) found.add("war");
    if (/oil|crude|opec|tanker|hormuz|refinery|barrel/.test(t)) found.add("oil");
    if (/gold|bullion/.test(t)) found.add("gold");
    if (/sanction|inflation|market|economy|export/.test(t)) found.add("economic-impact");
    if (/trump|pentagon|washington|white house|congress|u\.s\.|united states/.test(t)) found.add("usa");
    if (found.size === 0) found.add("iran");
  } else {
    if (GAZA_RE.test(t)) found.add("gaza");
    if (SYRIA_RE.test(t)) found.add("syria");
    if (LEBANON_RE.test(t)) found.add("lebanon");
    if (/strike|missiles?|drone|attack|airstrikes?|air strike|bomb|shelling|barrage|killed|kills|casualt|invasion|troops|hostage|military operation/.test(t)) found.add("war");
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
    // Specific conflict regions first — a Gaza school strike, a Beirut hit or
    // a Damascus drone raid is its own story, not a generic "war"/"middle-east"
    // item. This is what gives the gaza/syria/lebanon filters + bot routes a
    // real category to match, and lets the 5-minute Telegram fast lane publish
    // them immediately instead of parking them in the queue.
    if (GAZA_RE.test(t)) return "gaza";
    if (SYRIA_RE.test(t)) return "syria";
    if (LEBANON_RE.test(t)) return "lebanon";
    // Regional war stories without an Iran keyword (Yemen strikes, casualties,
    // missiles) are breaking "war" items — not generic "middle-east".
    if (/strike|missiles?|drone|attack|airstrikes?|air strike|bomb|shelling|barrage|killed|kills|casualt|invasion|troops|hostage|military operation/.test(t)) return "war";
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
  // Iran-linked text: the specific fronts (Gaza/Hamas, Syria, Hezbollah) are
  // checked before the generic proxy/war buckets so "Hezbollah strikes
  // Haifa" routes to lebanon, not proxies.
  if (GAZA_RE.test(t)) return "gaza";
  if (SYRIA_RE.test(t)) return "syria";
  if (LEBANON_RE.test(t)) return "lebanon";
  if (/houthi|kataib|militia|hamas|axis of resistance/.test(t)) return "proxies";
  if (/strike|missiles?|drone|attack|airstrikes?|war|bomb|troops|centcom|carrier|explosion/.test(t)) return "war";
  if (/oil|crude|opec|tanker|hormuz|refinery|barrel/.test(t)) return "oil";
  if (/gold|bullion/.test(t)) return "gold";
  if (/sanction|inflation|market|economy|export/.test(t)) return "economic-impact";
  if (/trump|pentagon|washington|white house|congress|u\.s\.|united states/.test(t)) return "usa";
  return "iran";
}
export const CATEGORY_PRIORITY: Record<string, number> = {
  iraq: 70, gaza: 62, war: 60, syria: 57, lebanon: 57, iran: 50, proxies: 45,
  "middle-east": 42, analysis: 34, gold: 30, usa: 30, oil: 25, "economic-impact": 20,
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
  category?: string | null;
  // The source's editorial type is kept separate from its publisher. This
  // prevents a publisher that carries both reporting and analysis from being
  // labeled Analysis on every post.
  articleType?: "news" | "analysis" | string;
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
  // Auto-hashtag (Settings → Posting): append the post's category as a
  // localized hashtag at the VERY bottom of the message. The tag follows the
  // language the post is actually sent in (hashtagLang: "en" | "ckb").
  autoHashtag?: boolean;
  hashtagLang?: string;
  hashtagRules?: unknown;
  // Source trust-tier byline (Settings → Posting): append a small
  // "Wire / State media / Independent / Analysis" tag after the source name.
  // undefined → on (matching the master-toggle convention); false → off.
  showSourceTier?: boolean;
  sourceTierLang?: string;
};

// Localized category → hashtag labels. English is Title Case (with USA
// special-cased); Kurdish Sorani uses the Arabic script (no case). The tag
// that ships is "#" + the label with spaces/hyphens removed — Telegram
// hashtags cannot contain either, so "Middle East" → #MiddleEast and
// "economic-impact" → #EconomicImpact. Multi-word Kurdish tags join with
// underscores (the convention on Kurdish news channels):
// "ڕۆژهەڵاتی ناوەڕاست" → #ڕۆژهەڵاتی_ناوەڕاست. Unknown category or
// language → null (no hashtag line).
const CATEGORY_HASHTAGS: Record<string, Record<string, string>> = {
  en: {
    iraq: "Iraq", war: "War", iran: "Iran", "middle-east": "Middle East",
    analysis: "Analysis", proxies: "Proxies", gold: "Gold", usa: "USA",
    oil: "Oil", "economic-impact": "Economic Impact", gaza: "Gaza",
    syria: "Syria", lebanon: "Lebanon",
  },
  ckb: {
    iraq: "عێراق", war: "شەڕ", iran: "ئێران", "middle-east": "ڕۆژهەڵاتی_ناوەڕاست",
    analysis: "شیکاری", proxies: "پرۆکسی", gold: "زێڕ", usa: "ئەمریکا",
    oil: "نەوت", "economic-impact": "ئابووری", gaza: "غەززە",
    syria: "سووریا", lebanon: "لوبنان",
  },
};

export function categoryHashtag(category: string, lang = "en"): string | null {
  const label = CATEGORY_HASHTAGS[lang]?.[category] ?? CATEGORY_HASHTAGS.en[category];
  if (!label) return null;
  // Telegram hashtags cannot contain spaces or hyphens; strip both while
  // preserving explicit underscores in the labels.
  return `#${label.replace(/[\s-]/g, "")}`;
}

export type HashtagTopicRule = {
  en?: string;
  ckb?: string;
  keywords?: string[];
  enabled?: boolean;
};
export type HashtagCategoryRule = {
  categoryEn?: string;
  categoryCkb?: string;
  topicLimit?: number;
  topics?: HashtagTopicRule[];
};

export function normalizeHashtagRules(value: unknown): Record<string, HashtagCategoryRule> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, HashtagCategoryRule> = {};
  for (const [category, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const topics = Array.isArray(row.topics)
      ? row.topics.filter((topic): topic is Record<string, unknown> => Boolean(topic) && typeof topic === "object").map((topic) => ({
          en: String(topic.en ?? "").trim(),
          ckb: String(topic.ckb ?? "").trim(),
          keywords: Array.isArray(topic.keywords) ? topic.keywords.map(String).map((word) => word.trim()).filter(Boolean) : [],
          enabled: topic.enabled !== false,
        }))
      : [];
    out[category] = {
      categoryEn: String(row.categoryEn ?? "").trim() || undefined,
      categoryCkb: String(row.categoryCkb ?? "").trim() || undefined,
      topicLimit: Number(row.topicLimit) === 2 ? 2 : 1,
      topics,
    };
  }
  return out;
}

function customHashtag(label: string, fallback: string | null, lang = "en"): string | null {
  const clean = label.trim();
  if (!clean) return fallback;
  const withoutHash = clean.replace(/^#/, "");
  const tag = lang === "ckb"
    ? withoutHash.replace(/-/g, "").replace(/\s+/g, "_").replace(/_+/g, "_")
    : withoutHash.replace(/[\s-]/g, "");
  return tag ? `#${tag}` : fallback;
}

// Returns the category tag plus up to one or two enabled topic tags. Topic
// rules are selected in Settings and only fire when one of their keywords is
// present in the source text, preventing unrelated tags from being attached
// to every post in a category. Unknown categories intentionally return none.
export function selectHashtags(category: string, text: string, lang = "en", rawRules?: unknown): string[] {
  const baseCategory = categoryHashtag(category, lang);
  if (!baseCategory) return [];
  const rules = normalizeHashtagRules(rawRules);
  const rule = rules[category];
  const categoryTag = customHashtag(lang === "ckb" ? String(rule?.categoryCkb ?? "") : String(rule?.categoryEn ?? ""), baseCategory, lang);
  const result = categoryTag ? [categoryTag] : [];
  if (!rule) return result;
  const haystack = text.toLocaleLowerCase();
  const limit = rule.topicLimit === 2 ? 2 : 1;
  for (const topic of rule.topics ?? []) {
    if (topic.enabled === false) continue;
    const label = lang === "ckb" ? String(topic.ckb ?? "") : String(topic.en ?? "");
    if (!label || !topic.keywords?.length) continue;
    if (!topic.keywords.some((keyword) => haystack.includes(keyword.toLocaleLowerCase()))) continue;
    const tag = customHashtag(label, null, lang);
    if (tag && !result.includes(tag)) result.push(tag);
    if (result.length - 1 >= limit) break;
  }
  return result;
}

// ── Source trust-tier byline ───────────────────────────────────────────────
// Curated outlet classification so the channel can label who is reporting,
// not just what: a state-media headline presented as a neutral wire report
// was the original "source inconsistency" complaint. Deterministic name/domain
// matching — no LLM call, no new infra. Unknown sources resolve to null (no
// tag) so a partial list can never mislabel an outlet.
export type SourceTier = "wire" | "state-media" | "independent" | "analysis";

const SOURCE_TIER_RULES: Array<{ tier: SourceTier; patterns: RegExp[] }> = [
  {
    tier: "state-media",
    patterns: [
      /press tv/i, /presstv/i, /\birna\b/i, /tasnim/i, /mehr news/i, /tehran times/i,
      /fars news/i, /al mayadeen/i, /\bsana\b/i, /\btass\b/i, /ria novosti/i,
      /\brt\b/i, /xinhua/i, /cgtn/i, /anadolu/i, /isna/i, /al alam/i,
      /sputnik/i,
    ],
  },
  {
    tier: "analysis",
    patterns: [
      /war on the rocks/i, /responsible statecraft/i, /atlantic council/i,
      /middle east institute/i, /\bfdd\b/i, /foundation for defense of democracies/i,
      /crisis group/i, /\brand\b/i, /brookings/i, /carnegie/i, /foreign affairs/i,
      /foreign policy/i, /iran desk/i,
    ],
  },
  {
    tier: "wire",
    patterns: [
      /reuters/i, /associated press/i, /\bap\b/i, /\bafp\b/i, /\bbbc\b/i,
      /al jazeera/i, /the guardian/i, /washington post/i, /new york times/i,
      /\bcnn\b/i, /bloomberg/i, /financial times/i, /\bnbc\b/i, /\babc news\b/i,
      /\bcbs\b/i, /cnbc/i, /sky news/i, /the telegraph/i, /\bthe times\b/i,
      /axios/i, /politico/i, /wall street journal/i,
    ],
  },
  {
    tier: "independent",
    patterns: [
      /middle east eye/i, /middle east monitor/i, /l'orient today/i, /the national/i, /shafaq/i,
      /rudaw/i, /amwaj/i, /financial tribune/i, /defense news/i,
      /gulf business/i, /arabian business/i, /oilprice/i, /iran international/i,
      /al arabiya/i, /energynow/i, /financial tribune/i,
    ],
  },
];

export function sourceTier(sourceName: string, url = "", articleType = "news"): SourceTier | null {
  const hay = `${sourceName} ${url}`.toLowerCase();
  // Middle East Eye publishes both straight reporting and analysis. Its
  // publisher name alone is therefore insufficient: only an explicit
  // analysis-type post receives the Analysis label; ordinary reports are
  // labeled Independent.
  if (/middle east eye|middleeasteye\.net/i.test(hay)) {
    return /analysis|opinion|commentary|explainer/i.test(articleType) ? "analysis" : "independent";
  }
  for (const rule of SOURCE_TIER_RULES) {
    if (rule.patterns.some((p) => p.test(hay))) return rule.tier;
  }
  return null;
}

const SOURCE_TIER_LABELS: Record<SourceTier, Record<string, string>> = {
  wire: { en: "Wire", ckb: "ئاژانسی هەواڵ" },
  "state-media": { en: "State media", ckb: "میدیای دەوڵەتی" },
  independent: { en: "Independent", ckb: "سەربەخۆ" },
  analysis: { en: "Analysis", ckb: "شیکاری" },
};

export function sourceTierLabel(tier: SourceTier | null, lang = "en"): string | null {
  if (!tier) return null;
  return SOURCE_TIER_LABELS[tier]?.[lang] ?? SOURCE_TIER_LABELS[tier]?.en ?? null;
}

// ── Category policy ──────────────────────────────────────────────────────
// Unified per-category control stored as a JSONB object on the settings row.
// Each entry is partial; missing fields use safe defaults at read time.
export type CategoryPolicyStatus = "enabled" | "disabled" | "review";
export type CategoryPolicyPriority = "very_high" | "high" | "normal" | "low";
export type CategoryPolicyEntry = {
  status?: CategoryPolicyStatus;
  priority?: CategoryPolicyPriority;
  scoreOverride?: number;
  freshnessHours?: number;
  maxPostsPerDay?: number;
  keywords?: string[];
  excludedKeywords?: string[];
  hashtagsEnabled?: boolean;
  maxHashtags?: number;
};
export type CategoryPolicies = Record<string, CategoryPolicyEntry>;

const CATEGORY_PRIORITY_PRESETS: Record<CategoryPolicyPriority, number> = {
  very_high: 80,
  high: 60,
  normal: 40,
  low: 20,
};

export function getCategoryPolicies(raw: unknown): CategoryPolicies {
  if (!raw || typeof raw !== "object") return {};
  return raw as CategoryPolicies;
}

export function getCategoryPolicy(policies: CategoryPolicies, category: string): Required<Pick<CategoryPolicyEntry, "status" | "priority">> & CategoryPolicyEntry {
  const entry = policies[category] ?? {};
  return {
    status: entry.status ?? "enabled",
    priority: entry.priority ?? "normal",
    scoreOverride: entry.scoreOverride ?? 0,
    freshnessHours: entry.freshnessHours ?? 0,
    maxPostsPerDay: entry.maxPostsPerDay ?? 0,
    keywords: entry.keywords ?? [],
    excludedKeywords: entry.excludedKeywords ?? [],
    hashtagsEnabled: entry.hashtagsEnabled ?? true,
    maxHashtags: entry.maxHashtags ?? 0,
  };
}

// Score override takes precedence; otherwise use the priority preset.
export function categoryScore(policies: CategoryPolicies, category: string, fallback: number): number {
  if (!(category in policies)) return fallback;
  const policy = getCategoryPolicy(policies, category);
  if (policy.scoreOverride > 0) return policy.scoreOverride;
  return CATEGORY_PRIORITY_PRESETS[policy.priority] ?? fallback;
}

// Per-category freshness: 0 = use the global maxArticleAgeHours default.
export function categoryFreshnessHours(policies: CategoryPolicies, category: string, fallback: number): number {
  const policy = getCategoryPolicy(policies, category);
  return policy.freshnessHours > 0 ? policy.freshnessHours : fallback;
}

// Excluded-keyword check: if any excluded keyword appears in the text, the
// article must NOT be classified as this category (returns false). Required
// keywords require at least one match for the article to qualify — unless
// skipRequired is set (instant Telegram sources default to "war" without any
// English keyword match, so a required-keyword list would silently drop every
// non-English post; exclusions still veto).
export function categoryKeywordMatch(
  policies: CategoryPolicies,
  category: string,
  text: string,
  opts?: { skipRequired?: boolean },
): { ok: boolean; reason?: string } {
  const policy = getCategoryPolicy(policies, category);
  const lower = text.toLowerCase();
  if (policy.excludedKeywords.length > 0 && policy.excludedKeywords.some((kw) => lower.includes(kw.toLowerCase()))) {
    return { ok: false, reason: "excluded keyword" };
  }
  if (!opts?.skipRequired && policy.keywords.length > 0 && !policy.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
    return { ok: false, reason: "missing required keyword" };
  }
  return { ok: true };
}

// Daily post cap: returns true when the category has hit its limit.
export function categoryAtDailyCap(policies: CategoryPolicies, category: string, countToday: number): boolean {
  const policy = getCategoryPolicy(policies, category);
  if (policy.maxPostsPerDay <= 0) return false;
  return countToday >= policy.maxPostsPerDay;
}

// Keyword-as-trigger classification: when the built-in classifier finds
// nothing (off-topic drop), any category whose REQUIRED keyword list matches
// the text becomes a valid candidate classification — excluded keywords still
// veto, disabled categories are skipped, and the highest-scoring match wins
// when several categories trigger. Empty keyword lists never trigger (the
// default category_policy has no keywords, so behavior is unchanged).
export function pickKeywordTriggeredCategory(policies: CategoryPolicies, text: string): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const cat of Object.keys(policies)) {
    const policy = getCategoryPolicy(policies, cat);
    if (policy.status === "disabled") continue;
    if (policy.keywords.length === 0) continue;
    if (!categoryKeywordMatch(policies, cat, text).ok) continue;
    const score = categoryScore(policies, cat, 0);
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return best;
}

// "Why it matters" follow-up headline: the generator falls back to the literal
// "Why it matters" when it produced no significance title, and prepending the
// configured prefix would double the phrase ("WHY IT MATTERS — Why it matters").
// Keep a real title; otherwise reuse the story headline the explainer covers.
export function whyItMattersTitleBase(modelTitle: string, fallbackHeadline: string): string {
  const t = modelTitle.trim();
  return t && !/^why\s+it\s+matters$/i.test(t) ? t : fallbackHeadline.trim();
}
const DEFAULT_FOOTER = "⚡ Delivered by Freebuff";
const DEFAULT_EMOJI = "🗞";
const DEFAULT_LINK_LABEL = "Read the full report";

// The model is given "<headline>\n\n<summary>" and told to preserve line
// breaks; it sometimes echoes the headline as the body's first paragraph, or
// repeats a paragraph verbatim. Collapse those so the channel never shows the
// same text twice (the "texts repetition" bug). Pure + idempotent: blocks are
// compared case-insensitively with punctuation/whitespace folded away.
export function dedupePostBody(summary: string, headline: string): string {
  if (!summary) return summary;
  const fold = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  const headFold = fold(headline);
  const blocks = summary.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const out: string[] = [];
  let prev: string | null = null;
  for (const b of blocks) {
    const f = fold(b);
    // A leading block that only restates the headline is the echoed-title case.
    if (headFold && f === headFold && out.length === 0) continue;
    // Consecutive identical paragraphs are a model echo, not content.
    if (prev !== null && f === prev) continue;
    out.push(b);
    prev = f;
  }
  return out.join("\n\n").trim();
}

// When a rewrite produced almost nothing (source was just a headline, so the
// model echoed a one-liner), render headline + body as ONE merged paragraph
// instead of a bold headline followed by a near-duplicate sentence. Returns
// { headline, summary, merged } — merged posts are rendered on a single line.
export function mergeThinBody(
  headline: string,
  summary: string,
  sourceName = "",
  minBodyChars = 160,
): { headline: string; summary: string; merged: boolean } {
  const h = headline.trim();
  const s = summary.trim();
  if (!h) return { headline: "", summary: s, merged: false };
  if (!s) return { headline: h, summary: "", merged: false };
  // A normal rewritten body (>= minBodyChars) is left untouched.
  if (s.length >= minBodyChars) return { headline: h, summary: s, merged: false };
  // Thin body → strip a duplicated headline prefix ("…Lebanon Washington
  // Times" starts with the headline) and a trailing site name (the footer
  // already shows the source).
  let rest = s;
  const hNorm = h.toLowerCase().replace(/[^a-z0-9]+/gi, " ").replace(/\s+/g, " ").trim();
  const sNorm = s.toLowerCase().replace(/[^a-z0-9]+/gi, " ").replace(/\s+/g, " ").trim();
  if (hNorm && sNorm.startsWith(hNorm)) {
    rest = s.slice(h.length).replace(/^[\s\-–—:;,.'"()]+/, "").trim();
  }
  const src = sourceName.trim().replace(/^@/, "");
  if (src && rest.toLowerCase().endsWith(src.toLowerCase())) {
    rest = rest.slice(0, rest.length - src.length).trim().replace(/[\s\-–—:;,.'"()]+$/, "").trim();
  }
  // Nothing meaningful left (e.g. the body was just the headline + site name).
  if (rest.length < 24) return { headline: h, summary: "", merged: true };
  return { headline: h, summary: rest, merged: true };
}

export function formatMessage(post: Post, fmt: PostFormat = {}): string {
  const when = post.originalPublishedAt
    ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: post.timezone }).format(new Date(post.originalPublishedAt))
    : "";
  const sources = [{ name: post.sourceName, url: post.url }, ...(post.extraSources ?? [])];
  const breakingPrefix = post.breaking && fmt.breakingPrefix ? fmt.breakingPrefix : "";
  const hasTitle = Boolean(post.headline.trim());
  const headline = hasTitle ? `${breakingPrefix}${post.headline}` : "";
  const summary = hasTitle ? post.summary : `${breakingPrefix}${post.summary}`;
  // Thin bodies are merged into the headline line so the channel never shows
  // "headline + a one-liner that repeats it".
  const merged = mergeThinBody(headline, summary, post.sourceName);
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
  if (merged.merged) {
    // Merged thin body: single line "<b>headline</b> — body" (or just the
    // headline when the body added nothing beyond the headline + site name).
    lines.push(
      merged.summary
        ? `<b>${escapeHtml(merged.headline)}</b> — ${escapeHtml(merged.summary)}`
        : `<b>${escapeHtml(merged.headline)}</b>`,
    );
  } else {
    if (headline.trim()) lines.push(`<b>${escapeHtml(headline)}</b>`, "");
    lines.push(escapeHtml(summary));
  }
  if (sourceShown) {
    const tier =
      fmt.showSourceTier !== false
        ? sourceTier(post.sourceName, post.url, post.articleType ?? "news")
        : null;
    const tierLabel = tier
      ? sourceTierLabel(tier, fmt.sourceTierLang ?? fmt.hashtagLang ?? "en")
      : null;
    const tierPart = tierLabel ? ` · ${escapeHtml(tierLabel)}` : "";
    const whenPart = fmt.showTimestamp === false || !when ? "" : ` · ${escapeHtml(when)}`;
    lines.push("", `${emoji ? `${escapeHtml(emoji)} ` : ""}<i>${escapeHtml(dedupeSourceName(post.sourceName))}</i>${tierPart}${whenPart}`);
  }
  // Multi-source posts replace the "Read more" link with a source list. When
  // source names are hidden for this post's type, fall back to the link so a
  // hidden attribution never costs the reader the clickable reference.
  if (sources.length > 1 && sourceShown) {
    lines.push(`Sources: ${sources.map((s) => escapeHtml(dedupeSourceName(s.name))).join(", ")}`);
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
  // Auto-hashtags are the category plus the enabled, keyword-matched topic
  // tags selected in Settings. They stay below every operator link.
  if (fmt.autoHashtag && post.category) {
    const tags = selectHashtags(post.category, `${post.headline} ${post.summary}`, fmt.hashtagLang ?? "en", fmt.hashtagRules);
    if (tags.length > 0) lines.push("", ...tags);
  }
  return lines.join("\n");
}


// A hard caption cut must never leave a visibly broken tail: a dangling
// connector ("…جەختی لە", "…school in"), a mid-word fragment ("…هەیە ل"), or a
// raw "&" (unterminated HTML entity). Removes the offending trailing token
// when one of those shapes survives the cut.
export function cleanTruncatedTail(text: string): string {
  let out = text.replace(/[\s.,!?;:،؛…—–]+$/g, "").trim();
  const last = out.split(/\s+/).pop() ?? "";
  const folded = last.replace(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase();
  if (!folded) return out;
  const dangling =
    INCOMPLETE_HEADLINE_ENDINGS.has(folded) || SORANI_DANGLING_ENDINGS.has(folded);
  const entityCut = last.includes("&");
  const fragment = folded.length === 1;
  if (!dangling && !entityCut && !fragment) return out;
  if (entityCut && !dangling) {
    // "…بەسەرچوو&" → "…بەسەرچوو": strip the raw entity fragment, keep the word.
    out = out.replace(/&[^\s]*$/u, "").trimEnd();
  } else {
    // Dangling connector (EN or Sorani) or single-letter fragment: drop the
    // final token — match whitespace + the last non-space token only, so the
    // cut never eats more than one word.
    out = out.replace(/\s+\S+\s*$/, "").trim();
  }
  return out.replace(/[\s.,!?;:،؛…—–]+$/g, "").trim();
}

function trimSentenceTo(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = text.slice(0, budget);
  const boundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf(".\n"), head.lastIndexOf("!\n"), head.lastIndexOf("?\n"));
  if (boundary > 20) return `${cleanTruncatedTail(head.slice(0, boundary + 1))}…`;
  const space = head.lastIndexOf(" ");
  if (space > 20) return `${cleanTruncatedTail(head.slice(0, space))}…`;
  return `${cleanTruncatedTail(head)}…`;
}
export function fitCaption(text: string, maxChars = 1024): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  let tailStart = lines.findIndex((l) => l.startsWith("🗞 ") || l.startsWith("Sources:") || l.startsWith("<a href=") || l.startsWith("<i>") || l.startsWith("#"));
  if (tailStart === -1) tailStart = lines.length;
  // Normal layout: line 0 = "<b>headline</b>", line 1 = "", summary starts at
  // line 2. Merged thin-body layout: line 0 = "<b>headline</b> — body" (no
  // separate summary block) — treat it as its own block, headStart = 0.
  const firstLine = lines[0] ?? "";
  const headStart = firstLine.startsWith("<b>") && !firstLine.includes("</b> — ") ? 2 : 0;
  if (headStart >= tailStart) return `${cleanTruncatedTail(text.slice(0, maxChars - 1))}…`;
  const summaryBlock = lines.slice(headStart, tailStart).join("\n");
  const overhead = text.length - summaryBlock.length;
  const budget = Math.max(60, maxChars - overhead);
  if (summaryBlock.length <= budget) return cleanTruncatedTail(text.slice(0, maxChars));
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
// Lean glossary: only the terms that actually occur in the source text are
// sent, so a large glossary isn't re-sent verbatim on every translation call.
// Glossary format (Settings → AI & Translation): one entry per line,
// "English = Kurdish Sorani". The term is the part before the first `=`/`:`;
// only that part has to appear in the text (case-insensitive). Entries whose
// term never appears are dropped. Empty input → empty block (no glossary
// section in the prompt at all).
//
// Wrapped entries: a line WITHOUT a `=`/`:` is a CONTINUATION of the previous
// entry (a long translation that spilled onto the next line — e.g. pasted
// text) and is merged back into it, instead of becoming a broken standalone
// "entry" whose term is a useless fragment that never matches the source and
// silently kills the glossary line. A separator-less FIRST line is still a
// valid term-only entry (matched by its whole text), preserving the original
// behavior for that case.
export type GlossaryEntry = { term: string; translation: string; text: string };

// Parse the operator's glossary (Settings → AI & Translation, one entry per
// line, "English = Kurdish Sorani"). Continuation lines (no `=`/`:`) are
// merged into the previous entry's translation. Exposed separately so both
// the prompt builder and the output sanitizer share one parser.
export function parseGlossaryEntries(glossary: string | undefined): GlossaryEntry[] {
  const raw = glossary?.trim();
  if (!raw) return [];
  const entries: GlossaryEntry[] = [];
  for (const line of raw.split("\n")) {
    const entryLine = line.trim();
    if (!entryLine) continue;
    const sep = entryLine.search(/[=:]/);
    if (sep >= 0) {
      const term = entryLine.slice(0, sep).trim();
      const translation = entryLine.slice(sep + 1).trim();
      if (!term) continue;
      entries.push({ term, translation, text: entryLine });
    } else if (entries.length > 0) {
      // Continuation of the previous entry's translation.
      const last = entries[entries.length - 1]!;
      last.translation = `${last.translation} ${entryLine}`.trim();
      last.text = `${last.text} ${entryLine}`.trim();
    } else {
      // Separator-less first line → term-only entry (whole text is the term).
      entries.push({ term: entryLine, translation: "", text: entryLine });
    }
  }
  return entries;
}

export function buildGlossaryBlock(glossary: string | undefined, text: string): string {
  const entries = parseGlossaryEntries(glossary);
  if (entries.length === 0) return "";
  const lower = text.toLowerCase();
  const matched = entries.filter((e) => lower.includes(e.term.toLowerCase())).map((e) => e.text);
  if (matched.length === 0) return "";
  return `TRANSLATION GLOSSARY — use these exact translations for key terms:\n${matched.join("\n")}\n\n`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "ئێران = ئێران" — a model re-translating the term itself produces an X = X
// self-mapping. Real news prose never contains a self-mapping, so removing it
// is always safe.
const GLOSSARY_SELF_MAPPING_RE =
  /([A-Za-z0-9\u0600-\u06FF][A-Za-z0-9\u0600-\u06FF\s.،,-]{0,80}?)\s*[=:]\s*\1/g;

// A model given "TRANSLATION GLOSSARY — use these exact translations …" in its
// prompt sometimes echoes that instruction back (often re-translated into
// Kurdish) at the top of its answer, e.g.
// "فەرهەنگی وەرگێڕان — …: Iran = ئێران Iraq = عێراق". This removes that leak so
// the instruction never reaches the channel. It only removes: self-mappings,
// exact sent glossary entries, and leading header lines (English "glossary" or
// the Kurdish "وەرگێڕان" rendering) — none of which appear in real news prose.
export function stripGlossaryLeak(text: string, glossary?: string | null, sourceText = ""): string {
  if (!text) return text;
  const entries = parseGlossaryEntries(glossary ?? undefined);
  const lower = sourceText.toLowerCase();
  const sent = entries.filter((e) => e.term && lower.includes(e.term.toLowerCase()));

  let out = text;
  // (1) Self-mappings anywhere: "ئێران = ئێران", "نرخی نەوت = نرخی نەوت".
  out = out.replace(GLOSSARY_SELF_MAPPING_RE, " ");
  // (2) Exact sent entries anywhere: "Iran = ئێران", "Iraq : عێراق".
  for (const e of sent) {
    if (!e.term || !e.translation) continue;
    out = out.replace(
      new RegExp(`${escapeRegExp(e.term)}\\s*[=:]\\s*${escapeRegExp(e.translation)}`, "gi"),
      " ",
    );
  }
  // (3) Drop leading glossary-header lines, now stripped of their entries.
  const lines = out.split("\n");
  const kept: string[] = [];
  let started = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!started && !t) {
      kept.push(raw);
      continue;
    }
    // English instruction or the Kurdish "وەرگێڕان" (translation) preamble.
    const header = /glossary/i.test(t) || /وەرگێڕان/.test(t);
    if (!started && header) continue;
    started = true;
    kept.push(raw);
  }
  out = kept.join("\n");
  // (4) Collapse residue: spaces only, preserve paragraph breaks.
  return out.replace(/[ \t]{2,}/g, " ").replace(/^\s+|\s+$/g, "").trim();
}

// Cache key for the translation_history row. The glossary is part of the key
// so an operator editing a term invalidates stale cached Sorani: otherwise a
// previously-translated text keeps returning the OLD translation and the
// updated glossary never reaches the channel. An empty/absent glossary keeps
// the exact legacy key (the raw input text) so existing rows are reused.
export function translationCacheKey(inputText: string, glossary?: string | null): string {
  const g = (glossary ?? "").trim();
  return g ? `${inputText}\n\n---glossary---\n${g}` : inputText;
}

// Split a Sorani translation back into headline + body for titled (web) posts.
// translateToSorani is asked to return "<headline>\n\n<body>". When the model
// honours that, the first block is the title and the rest is the body. When it
// returns a SINGLE block (no blank-line separator) the old code routed the
// WHOLE text to both fields — duplicating the full translation in the channel
// as "<b>full</b>\n\nfull". So a single block keeps the source headline as the
// title and treats the whole translation as the body. Never duplicates.
export function splitTranslatedPost(
  translatedText: string,
  headline: string,
  summary: string,
  isTelegramItem: boolean,
): { headline: string; summary: string } {
  if (isTelegramItem) return { headline: "", summary: translatedText };
  const parts = translatedText.split("\n\n");
  if (parts.length > 1) {
    return {
      headline: parts[0] ?? headline,
      summary: parts.slice(1).join("\n\n").trim() || summary,
    };
  }
  return { headline, summary: translatedText };
}

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
  // Martial arts and other common sports missing from the pattern above — the
  // "Iran wins … Taekwondo President's Cup" class slipped through because the
  // soft-news list only knew football-era terms and the concrete-check matched
  // "president" in "President's Cup". A sports result is never conflict-beat
  // news no matter which country name appears in it.
  /\b(taekwondo|karate|judo|kickboxing|boxing|boxer|mma|mixed martial arts|martial arts|gymnastics|swimming|swimmer|athletics|tennis|cricket|hockey|badminton|bodybuilding|wrestler|chess|grand prix)\b/i,

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
  /\b(centcom|pentagon|us (navy|military|forces|troops)|carrier strike group|airstrikes?|air strike|missiles?|drone|ballistic|ceasefires?|war|attack|strike)\b/i,
  /\b(oil|crude|brent|opec|barrel|refinery|tanker|shipping lane|red sea|bab el-?mandeb|gold (price|prices?|market|rally|climb|slip|fall|rise|surge|trad\w*|futures)|bullion|natural gas|lng|petrochemical|energy market)\b/i,
  /\b(middle east|gulf(?:\s+states)?|saudi|riyadh|qatar|uae|oman|bahrain|kuwait|syria|lebanon|yemen|turkey|ankara|israel|israeli|netanyahu|tel aviv|idf|golan|jordan|amman|egypt|cairo|gaza|west bank|palestin\w*|kurdish|kurd|peshmerga|sdf)\b/i,
];

export function relevanceGate(
  title: string,
  description?: string | null,
): { ok: boolean; reason?: string } {
  const text = `${title} ${description ?? ""}`;
  if (SOFT_NEWS_PATTERNS.some((p) => p.test(text))) return { ok: false, reason: "off-beat soft news" };

  // Self-sufficient signals — conflict/security terms pass on their own
  // without needing a country word. Commodity words (oil, gold, crude, etc.)
  // are intentionally EXCLUDED: "gold price today" or "oil outlook 2026" is
  // not a conflict story. They only pass when paired with conflict context
  // via the inBeat+conflictAction path below.
  const selfSufficient = /\b(hezbollah|houthi|ansar allah|hamas|militia|axis of resistance|irgc|kataib|kata.?ib|nujaba|popular mobilization|badr|asayib|saraya|resistance front|proxy|proxies|missiles?|ballistic|airstrikes?|air strike|ceasefires?|invasion|offensive|shelling|bombings?|death toll|massacre|hostages?|captives?|carrier strike group|centcom|pentagon|hormuz|nuclear|uranium|enrich\w*|iaea|sanction\w*|snapback|jcpoa)\b/i.test(text);
  if (selfSufficient) return { ok: true };

  // Actor/location inside the beat (Iran, Iraq, wider Middle East) plus US
  // military engagement in the region.
  const inBeat = [BEAT_PATTERNS[0], BEAT_PATTERNS[1], BEAT_PATTERNS[6]].some((p) => p!.test(text));
  const usRegional = /\b(centcom|pentagon|us (navy|military|forces|troops)|carrier strike group)\b/i.test(text);
  // A concrete CONFLICT DEVELOPMENT is required when only a location matched
  // — a bare "Iran" mention (domestic policy, housing, gold prices) is not a
  // conflict-beat story. We split into two tiers:
  //   Tier 1: hard conflict actions — pass immediately with inBeat.
  //   Tier 2: governance/diplomacy words — only pass if a conflict-context
  //           signal also appears (sanctions, military, strike, war, etc.).
  const conflictAction = /\b(attack\w*|strike\w*|clash\w*|escalat\w*|tension\w*|threat\w*|vow\w*|warn\w*|retaliat\w*|respond\w*|killed|dead|death|wounded|injured|casualt\w*|military|troops|forces|navy|army|defense|defence|security|deploy\w*|redeploy\w*|reinforce\w*|mobiliz\w*|intercept\w*|withdraw\w*|missiles?|drones?|war|conflict|ceasefires?|bombings?|shelling|blockade|embargo|sanction\w*|snapback|jcpoa|force\w*|expel\w*|displace\w*|evict\w*|demolish\w*|raid\w*|invade\w*|occupy\w*|siege|besiege|policy|policies|pressure)\b/i.test(text);
  const governance = /\b(ministry|minister|president|prime minister|leader|leadership|commander|official\w*|parliament|government|regime|diploma\w*|negotiat\w*|talks|agreement|deal|protest\w*|uprising|arrest\w*|detain\w*|execut\w*|sentenc\w*|intelligence|spy|espionage|security|border|crossing|smuggl\w*|pipeline|oil|crude|brent|opec|barrel|refiner\w*|tanker|natural gas|lng|petrochemical|gold|bullion)\b/i.test(text);
  if ((inBeat || usRegional) && conflictAction) return { ok: true };
  // Governance-only match: only passes if the headline also contains a
  // conflict-context signal (e.g. "Iran minister warns of military strike"
  // passes, but "Iran housing plan at Transport Ministry" does not).
  const conflictContext = /\b(sanction\w*|military|strike\w*|attack\w*|war|conflict|missile|drone|bomb|kill|dead|troops|forces|deploy\w*|blockade|embargo|ceasefire|escalat\w*|tension\w*|threat\w*|retaliat\w*|nuclear|uranium|hormuz|centcom|pentagon|negotiat\w*|talks|deal|agreement|diploma\w*)\b/i.test(text);
  if ((inBeat || usRegional) && governance && conflictContext) return { ok: true };

  // Operator carve-out: only MAJOR Russia–Ukraine war news (invasion,
  // offensive, casualties, mass strikes) — never routine "drone hit a
  // warehouse" noise.
  const ru = /\b(russia|russian|ukrain\w*|kyiv|moscow|zelensky|putin|kremlin|donbass|crimea)\b/i.test(text);
  const ruMajor = /\b(invasion|offensive|counter[- ]?offensive|front[- ]?line|escalat\w+|war|ceasefires?|peace (talks|deal|negotiat\w+)|surrender|casualt\w*|\d+\s+(killed|dead)|deadly|massacre|mass[- ]?grave|mobiliz\w+|annex\w+|territor\w+|massive (airstrikes?|strike|attack|barrage)|missile barrage|energy (grid|infrastructure)|blackout)\b/i.test(text);
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
  "gemini-3.8-flash",
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

// ── Event fingerprints (structured event identity) ─────────────────────────
// The keyword similarity layer (eventSimilarity / sameEvent) fails on
// rephrased coverage: "US strikes western Yemen overnight" and "American
// aircraft hit Houthi positions in Yemen" share almost no tokens yet describe
// the same event. These helpers extract a structured fingerprint (actors /
// targets / action / location / weapon / result / casualties) from
// headline+summary and match two fingerprints with weighted scoring, so the
// publish-time dedup can catch what token overlap misses. Deterministic (no
// AI calls), English + Arabic, dependency-free.

export type EventFingerprint = {
  actors: string[];
  targets: string[];
  action: string | null;
  location: string | null;
  specificLocation: string | null;
  weapon: string | null;
  result: string | null;
  casualties: string | null;
  timeBucket: string | null;
};

const FP_ENTITIES: Array<[RegExp, string]> = [
  [/united states|\bus\b|\bu\.s\.\b|american|america|واشنطن|أمريكا|الأمريكي|الولايات المتحدة/gi, "usa"],
  [/trump|ترامب/gi, "trump"],
  [/islamic revolutionary guard|revolutionary guards?|\birgc\b|pasdaran|الحرس الثوري/gi, "irgc"],
  [/iran|iranian|tehran|إيران|الإيراني|طهران/gi, "iran"],
  [/israel|israeli|إسرائيل|الإسرائيلي/gi, "israel"],
  [/hezbollah|hizbullah|حزب الله/gi, "hezbollah"],
  [/houthis?|ansar allah|أنصار الله|الحوثي/gi, "houthi"],
  [/russia|russian|moscow|روسيا|الروسية/gi, "russia"],
  [/ukraine|ukrainian|أوكرانيا/gi, "ukraine"],
  [/iraq|iraqi|العراق|العراقي/gi, "iraq"],
  [/turkey|turkish|تركيا|التركي/gi, "turkey"],
  [/saudi|riyadh|السعودية|الرياض/gi, "saudi"],
  [/kurdish|kurds|kurdistan|peshmerga|الأكراد|الكردية|البيشمركة/gi, "kurds"],
  [/syria|syrian|سوريا|السوري/gi, "syria"],
  [/lebanon|lebanese|لبنان|اللبناني/gi, "lebanon"],
  // Yemen is deliberately NOT an actor: it is the battleground in this beat
  // ("US strikes Houthi positions in Yemen") and would pollute the actor
  // overlap on nearly every story. It stays in FP_LOCATIONS below.
  [/gaza|palestin|غزة|فلسطين/gi, "gaza"],
];

// Entities that are more often the TARGET of an event than the actor. When a
// headline names one of these alongside another entity, the biased one goes
// to targets and the rest to actors ("US strikes Houthi positions").
const FP_TARGET_BIAS = new Set(["hezbollah", "houthi", "kurds", "ukraine", "gaza"]);

// Ordered: more specific/salient verbs win. Bare "fire"/"launch" are
// deliberately excluded — "Iran launches satellite" must not look like a
// strike.
const FP_ACTIONS: Array<[RegExp, string]> = [
  [/ceasefires?|truce|وقف إطلاق النار|هدنة/gi, "ceasefire"],
  [/airstrikes?|air strike|strik(?:e|es|ing)?|struck|hit(?:s|ting)?|attack(?:s|ed|ing)?|bomb(?:s|ed|ing)?|shelling|barrage|raid|غارات?|قصف|ضربات?|هجوم|هاجم/gi, "strike"],
  [/tests?|tested|يختبر|اختبر/gi, "test"],
  [/seize[sd]?|seizure|captur(?:e|ed|ing)|مصادرة|احتجاز/gi, "seizure"],
  [/withdraw(?:s|ing)?|withdrawal|pull(?:s)? out|انسحاب/gi, "withdraw"],
  [/assassinat(?:e|ion|ed)?|اغتيال/gi, "assassination"],
  [/sanction(?:s|ed|ing)?|عقوبات/gi, "sanctions"],
  [/deploy(?:s|ing|ed)?|deployment|تعزيزات|نشر قوات/gi, "deploy"],
  [/talks?|negotiations?|meeting|discussions?|محادثات|مفاوضات|اجتماع/gi, "talks"],
  [/warns?|warning|announc(?:es|ed|ing)?|statement|declar(?:es|ed)?|claims?|den(?:ies|ied)|says?|said|يعلن|أعلن|يحذر|حذر|يؤكد|أكد/gi, "statement"],
];

const FP_WEAPONS: Array<[RegExp, string]> = [
  [/missiles?|ballistic|rockets?|صاروخ|صواريخ/gi, "missile"],
  [/drones?|\buav\b|طائرات? مسيرة|مسيرات?|درون/gi, "drone"],
  [/aircraft|warplanes?|jets?|fighter|طائرات حربية|مقاتلات/gi, "aircraft"],
  [/tanks?|دبابات/gi, "tank"],
  [/ships?|vessels?|warships?|سفن|بارجة/gi, "ship"],
];

const FP_LOCATIONS: Array<[RegExp, string]> = [
  [/yemen|yemeni|اليمن|اليمني/gi, "yemen"],
  [/iran|iranian|tehran|إيران|الإيراني|طهران/gi, "iran"],
  [/iraq|iraqi|العراق|العراقي/gi, "iraq"],
  [/lebanon|lebanese|لبنان|اللبناني/gi, "lebanon"],
  [/israel|israeli|إسرائيل|الإسرائيلي/gi, "israel"],
  [/syria|syrian|سوريا|السوري/gi, "syria"],
  [/gaza|غزة/gi, "gaza"],
  [/russia|russian|روسيا|الروسية/gi, "russia"],
  [/ukraine|ukrainian|أوكرانيا/gi, "ukraine"],
  [/saudi|السعودية/gi, "saudi"],
];

// City / port / strait level — deliberately NOT country or region level so
// two different strikes in one country never merge on the country alone.
const FP_SPECIFIC_LOCATIONS: Array<[RegExp, string]> = [
  [/mokha|mukha|al[- ]?mokha|مخا/gi, "mokha"],
  [/hormuz|هرمز/gi, "hormuz"],
  [/tel aviv|jerusalem|haifa|eilat|تل أبيب|القدس/gi, "telaviv"],
  [/baghdad|basra|erbil|mosul|بغداد|البصرة|أربيل|الموصل/gi, "iraqcity"],
  [/tehran|tabriz|طهران|تبريز/gi, "irancity"],
  [/riyadh|jeddah|dhahran|الرياض|جدة/gi, "saudicity"],
  [/sanaa|aden|taiz|hodeidah|hudaydah|صنعاء|عدن|تعز|الحديدة/gi, "yemencity"],
  [/beirut|بيروت/gi, "beirut"],
  [/damascus|دمشق/gi, "damascus"],
];

const FP_RESULT: Array<[RegExp, string]> = [
  [/killed|kills|deaths?|dead|injured|wounded|casualt|fatal|قتلى|قتيل|قتل|جرحى|إصابات|شهداء/gi, "casualties"],
  [/claim(?:s|ed)? responsibility|responsibility for/gi, "claim"],
  [/reached|agreed|signed|توصل|اتفق/gi, "agreement"],
];

const FP_WORD_NUMBERS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
};

const FP_CASUALTIES_PATTERN =
  /(\d[\d,.]*)\s*(killed|deaths?|dead|injured|wounded|civilians|soldiers|قتلى|جرحى|قتيل)/i;

function fpEntityHits(text: string): string[] {
  const found: string[] = [];
  for (const [re, id] of FP_ENTITIES) {
    re.lastIndex = 0; // /g regexes keep lastIndex between calls — reset it
    if (re.test(text) && !found.includes(id)) found.push(id);
  }
  return found;
}

export function fingerprintArticle(
  title: string,
  extra = "",
  publishedAt?: string | null,
): EventFingerprint {
  const text = `${title} ${extra}`;
  const found = fpEntityHits(text);
  const biased = found.filter((e) => FP_TARGET_BIAS.has(e));
  // Target-biased entities (hezbollah, houthi, kurds, ukraine, gaza) go to
  // targets whenever they appear, so "US strikes Houthi positions" reads
  // actor=usa / target=houthi. Deliberately conservative for the lone case:
  // "Houthis strike Tel Aviv" keeps actors empty — with only one party
  // named we can't tell which role it plays, and treating it as a target is
  // the fewer-merges direction.
  const actors = found.filter((e) => !FP_TARGET_BIAS.has(e));
  const targets = biased;

  let action: string | null = null;
  for (const [re, id] of FP_ACTIONS) { re.lastIndex = 0; if (re.test(text)) { action = id; break; } }
  let weapon: string | null = null;
  for (const [re, id] of FP_WEAPONS) { re.lastIndex = 0; if (re.test(text)) { weapon = id; break; } }
  let location: string | null = null;
  for (const [re, id] of FP_LOCATIONS) { re.lastIndex = 0; if (re.test(text)) { location = id; break; } }
  let specificLocation: string | null = null;
  for (const [re, id] of FP_SPECIFIC_LOCATIONS) { re.lastIndex = 0; if (re.test(text)) { specificLocation = id; break; } }
  let result: string | null = null;
  for (const [re, id] of FP_RESULT) { re.lastIndex = 0; if (re.test(text)) { result = id; break; } }
  let casualties: string | null = null;
  // Both word orders ("4 killed" / "kills four") and spelled-out numbers
  // ("kills four"). Normalized to the bare number so "4 killed" ===
  // "kills 4" (same toll) but "40 killed" !== "4".
  const m =
    text.match(FP_CASUALTIES_PATTERN) ??
    text.match(/(?:killed|kills|deaths?|dead|injured|wounded|قتلى|جرحى|قتيل)\s+(\d[\d,.]*|[a-z]+)/i);
  if (m) {
    const raw = (m[1] ?? "").toLowerCase().trim();
    const num = FP_WORD_NUMBERS[raw] ?? raw.replace(/[.,]/g, "").trim();
    casualties = num || null;
  }

  const timeBucket =
    publishedAt && !Number.isNaN(Date.parse(publishedAt))
      ? new Date(publishedAt).toISOString().slice(0, 13)
      : null;

  return { actors, targets, action, location, specificLocation, weapon, result, casualties, timeBucket };
}

const FP_WEIGHTS = {
  actors: 0.22,
  action: 0.22,
  targets: 0.14,
  location: 0.1,
  specific: 0.16,
  weapon: 0.1,
  result: 0.06,
};

// Weighted match score in [0,1], renormalized over the factors both sides
// actually carry (a field absent on both sides doesn't dilute the score).
export function fingerprintMatch(a: EventFingerprint, b: EventFingerprint): number {
  let applicable = 0;
  let matched = 0;
  const add = (weight: number, present: boolean, hit: boolean) => {
    if (!present) return;
    applicable += weight;
    if (hit) matched += weight;
  };
  const overlap = (x: string[], y: string[]) => x.some((v) => y.includes(v));
  add(FP_WEIGHTS.actors, a.actors.length > 0 && b.actors.length > 0, overlap(a.actors, b.actors));
  add(FP_WEIGHTS.action, Boolean(a.action && b.action), a.action === b.action);
  // Targets are the strongest differentiator: when BOTH sides name targets and
  // they don't overlap ("US strikes Houthis" vs "US strikes Hezbollah"), the
  // target weight counts against the match instead of merely not counting for
  // it — so same-actor/same-action/different-target stays apart even when the
  // remaining factors would clear the threshold.
  const bothTargets = a.targets.length > 0 && b.targets.length > 0;
  add(FP_WEIGHTS.targets, bothTargets, overlap(a.targets, b.targets));
  if (bothTargets && !overlap(a.targets, b.targets)) {
    applicable += FP_WEIGHTS.targets;
    matched -= FP_WEIGHTS.targets;
  }
  add(FP_WEIGHTS.location, Boolean(a.location && b.location), a.location === b.location);
  add(FP_WEIGHTS.specific, Boolean(a.specificLocation && b.specificLocation), a.specificLocation === b.specificLocation);
  add(FP_WEIGHTS.weapon, Boolean(a.weapon && b.weapon), a.weapon === b.weapon);
  add(FP_WEIGHTS.result, Boolean(a.result && b.result), a.result === b.result && a.casualties === b.casualties);
  if (applicable === 0) return 0;
  return matched / applicable;
}

// Physical/military actions strong enough to anchor a merge on their own. A
// generic "statement"/"talks" overlap is NOT strong — two Iran statements a
// day apart are different events even when the actor matches.
const FP_STRONG_ACTIONS = new Set(["ceasefire", "strike", "test", "seizure", "withdraw", "assassination"]);

export function sameEventFingerprint(a: EventFingerprint, b: EventFingerprint, threshold = 0.65): boolean {
  if (fingerprintMatch(a, b) < threshold) return false;
  const strongAction = Boolean(a.action && a.action === b.action && FP_STRONG_ACTIONS.has(a.action));
  const strongSpecific = Boolean(a.specificLocation && a.specificLocation === b.specificLocation);
  const strongTarget = a.targets.length > 0 && b.targets.length > 0 && a.targets.some((t) => b.targets.includes(t));
  return strongAction || strongSpecific || strongTarget;
}

type PublishedRowLike = {
  headline?: unknown;
  english_headline?: unknown;
  summary?: unknown;
  source_text?: unknown;
  published_at?: unknown;
};

function isEventFingerprint(row: PublishedRowLike | EventFingerprint): row is EventFingerprint {
  return Array.isArray((row as EventFingerprint).actors);
}

// Row-level helper for the publish-time dedup: does the candidate fingerprint
// match any recently published story still inside the cooldown window?
// Accepts raw published_history rows (extracted lazily) or precomputed
// fingerprints — buildDedupContext passes the precomputed list so extraction
// runs once per cycle instead of once per candidate × per row.
export function matchPublishedFingerprint(
  candidate: EventFingerprint,
  published: Array<PublishedRowLike | EventFingerprint>,
  threshold = 0.65,
): boolean {
  for (const row of published) {
    const other = isEventFingerprint(row)
      ? row
      : (() => {
          const title = String(row.english_headline || row.headline || "");
          if (!title) return null;
          return fingerprintArticle(title, String(row.summary || row.source_text || ""));
        })();
    if (!other) continue;
    if (sameEventFingerprint(candidate, other, threshold)) return true;
  }
  return false;
}

// ── Summary polish (deterministic backstop) ─────────────────────────────────
// The AI rewrite prompt asks for a wire-service brief, but models sometimes
// slip: filler openers ("A report states that…") or a one-line reword of the
// headline that adds no information. These helpers catch that class so a bad
// rewrite never ships as the post body. The fallback reuses the enriched
// source text (which, post-Google-News-decode, is the real article body).
const FILLER_PREFIXES: RegExp[] = [
  /\ba report states that\s+/i,
  /\ba report says that\s+/i,
  /\ba report described how\s+/i,
  /\ba report has said that\s+/i,
  /\bit has been reported that\s+/i,
  /\baccording to a report,?\s+/i,
  /\baccording to reports,?\s+/i,
  /\bthe report said that\s+/i,
  /\bthe report says that\s+/i,
  /\breports say that\s+/i,
  /\breports said that\s+/i,
  /\bin a statement,?\s+/i,
  /\bthe news comes as\s+/i,
  /\bit comes as\s+/i,
];
export function stripSummaryFiller(text: string): string {
  let value = text.trim();
  for (const re of FILLER_PREFIXES) value = value.replace(re, "");
  value = value.replace(/\s+according to (?:a|the) reports?\.?$/i, "");
  return value.trim();
}

function summaryTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .split(" ")
    .filter(Boolean)
    // light plural stem: "tensions" → "tension", "companies" → "compani"
    .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
}

// True when the summary is short AND mostly made of headline words — the
// "just reworded the headline" class that adds no information.
export function isHeadlineReword(summary: string, headline: string): boolean {
  const s = summary.trim();
  if (!s || s.length >= 220) return false;
  const st = summaryTokens(s);
  const ht = summaryTokens(headline);
  if (st.length === 0 || ht.length < 3) return false;
  const set = new Set(ht);
  const overlap = st.filter((t) => set.has(t)).length / st.length;
  return overlap >= 0.6;
}

// Returns the polished summary, or null when the rewrite is unusable (filler
// only / headline reword with no real source text to fall back on).
// Content words for echo detection: stopwords and generic news verbs are
// removed so a PARAPHRASE of the headline ("asks if" -> "asks whether",
// "US" -> "United States", "oil rose" -> "prices climbed") cannot hide the
// overlap from a naive token-set check.
const ECHO_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "as", "at", "by",
  "from", "that", "this", "it", "its", "is", "are", "was", "were", "be", "been", "has",
  "have", "had", "will", "would", "can", "could", "may", "might", "after", "over", "amid",
  "during", "into", "about", "against", "their", "his", "her", "our", "your", "who", "which",
  "what", "when", "where", "why", "how", "not", "no", "if", "but", "while", "than", "then",
  "more", "most", "report", "reports", "reported", "according", "says", "said", "say", "told",
]);
function echoTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 2 && !ECHO_STOPWORDS.has(t))
    // light plural stem, matching summaryTokens
    .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
}

// True when the FIRST sentence of the summary carries essentially only
// headline information - the paraphrase-echo class ("EnergyNow asks if US and
// Iran can bridge differences" -> "EnergyNow asks whether the United States
// and Iran can bridge their differences") that a verbatim token check misses.
// Only the opening sentence counts: later sentences adding figures/details is
// exactly what a good brief does. Needs >= 3 headline content words so vague
// one-word headlines never trip it.
export function summaryOpensAsEcho(headline: string, summary: string): boolean {
  const s = (summary ?? "").trim();
  if (!s) return false;
  let first = s;
  const m = s.match(/[.!?](?:\s|$)/);
  if (m && m.index !== undefined && m.index >= 30) first = s.slice(0, m.index + 1);
  const ht = new Set(echoTokens(headline));
  if (ht.size < 3) return false;
  const st = echoTokens(first);
  if (st.length < 5) return false;
  // Synonym swaps and function words ("if"->"whether", "US"->"United States",
  // "talks"->"ongoing talks") are NOT information. Only a SPECIFIC new token -
  // a place, date, figure, or named actor - makes an opening carry something
  // the headline does not. Flag the echo class when the first sentence adds
  // zero specific content beyond the headline's own words.
  let novelSpecific = 0;
  for (const t of st) {
    if (ht.has(t) || ECHO_GENERIC_NOVEL.has(t)) continue;
    novelSpecific++;
  }
  return novelSpecific === 0;
}

// Tokens that may appear in an opening sentence without making it informative.
// Deliberately excludes places, dates, figures and named actors - those ARE
// the added detail this detector exists to require.
const ECHO_GENERIC_NOVEL = new Set([
  "whether", "ongoing", "latest", "current", "recent", "entire", "whole", "full",
  "still", "yet", "also", "now", "amidst", "regarding", "concerning", "united",
  "state", "nation", "national", "official", "officials", "authority", "authorities",
  "source", "sources", "report", "reports", "update", "updates", "americas",
]);

export function polishRewriteSummary(
  summary: string,
  headline: string,
  description: string | null | undefined,
): string | null {
  let s = stripSummaryFiller(summary);
  if (!s) return null;
  // A summary that starts with a lowercase word is a clipped mid-sentence
  // fragment ("that Donald Trump faces challenges...") - the model echoed
  // the tail of its own lede. Repair from the source body like a
  // headline-reword, or drop when no real body exists.
  const desc = (description ?? "").trim();
  const fragmentStart = /^[a-z]/.test(s);
  if (!fragmentStart && !isHeadlineReword(s, headline) && !summaryOpensAsEcho(headline, s)) return s;
  // Only drop when the source itself has nothing beyond the headline (thin
  // snippet or its own reword). A real body means the rewrite just failed to
  // use it — fall back to the first sentence of the source text instead.
  if (desc.length < 120 || isHeadlineReword(desc, headline)) return null;
  const fallback = desc.slice(0, 700);
  // First 1-2 complete sentences of the source lede (skips decimals early in
  // the text). Keeps the fallback brief meaty, not a one-liner.
  const ends: number[] = [];
  for (const m of fallback.matchAll(/[.!?](?:\s|$)/g)) {
    if (m.index !== undefined && m.index >= 40) ends.push(m.index + 1);
  }
  const cut = ends[1] ?? ends[0] ?? -1;
  const brief = cut > 40 ? fallback.slice(0, cut).trim() : fallback;
  return brief || null;
}
