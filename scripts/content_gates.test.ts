// Tests for the content gates — imports the REAL functions from the pipeline
// shared module (single source of truth). These gates run on every article at
// ingest AND publish time, and a false positive silently drops real news, so
// the true-positive + near-miss split below is the critical contract:
//   - true positives  = posts that must NEVER be published
//   - near misses     = legit headlines that LOOK similar but must pass
import { test, expect } from "bun:test";
import {
  ARABIC_JUNK_PATTERNS,
  editorialJunkGate,
  KURD_HOSTILE_PATTERNS,
  kurdHostileGate,
} from "../supabase/functions/pipeline/_shared.ts";

// ── KURD_HOSTILE_PATTERNS sanity ────────────────────────────────────────────

test("patterns are bounded (no catastrophic backtracking shapes)", () => {
  for (const p of [...KURD_HOSTILE_PATTERNS, ...ARABIC_JUNK_PATTERNS]) {
    const src = p.source;
    // No nested unbounded quantifiers like (a+)+ or (a*)* that enable ReDoS.
    expect(src).not.toMatch(/\(\s*[^)]*\*[^)]*\)\s*[+*]/);
    expect(src).not.toMatch(/\(\s*[^)]*\+[^)]*\)\s*[+*]/);
  }
});

// ── kurdHostileGate: true positives (must be blocked) ──────────────────────

test("Arabic call to disband the Peshmerga is blocked", () => {
  expect(kurdHostileGate("دعوة لهەڵوەشاندنەوەی هێزەکانی پێشمەرگە").ok).toBe(false);
});

test("the exact al-Mayadeen post the user flagged is blocked", () => {
  // "عەکاق: کەتائیبی حیزبوڵڵای عێراق: هەڵوەشاندنەوەی هێزەکانی پێشمەرگە وەک چەکدارترین"
  const r = kurdHostileGate(
    "کتائب حزب الله العراق: هەڵوەشاندنەوەی هێزەکانی پێشمەرگە",
    "تعتبرهم أخطر ميليشيا مسلحة على وحدة العراق",
  );
  expect(r.ok).toBe(false);
});

test("Peshmerga labelled an outlaw militia in Arabic is blocked", () => {
  expect(kurdHostileGate("البيشمركة ميليشيا خارج عن القانون").ok).toBe(false);
});

test("Kurds framed as a threat to Iraq's unity is blocked", () => {
  expect(kurdHostileGate("الأكراد خطر على وحدة العراق").ok).toBe(false);
});

test("English 'Peshmerga must be disbanded' is blocked", () => {
  expect(kurdHostileGate("Peshmerga must be disbanded").ok).toBe(false);
});

test("English 'Kurds are traitors' framing is blocked", () => {
  expect(kurdHostileGate("The Kurds are traitors to the nation").ok).toBe(false);
});

test("hostile phrase in the description alone is still blocked", () => {
  expect(kurdHostileGate("بيان جديد", "يدعو إلى حل قوات البشمركة فورا").ok).toBe(false);
});

// ── kurdHostileGate: near misses (must pass) ────────────────────────────────

test("Peshmerga CONFRONTING ISIS threats passes (lookahead fix)", () => {
  // "البيشمركة تتصدى لتهديدات داعش" — neutral news, previously dropped.
  expect(kurdHostileGate("البيشمركة تتصدى لتهديدات داعش في ديالى").ok).toBe(true);
});

test("Peshmerga defending against an attack passes", () => {
  expect(kurdHostileGate("البيشمركة تتصدى لهجوم عنيف قرب الموصل").ok).toBe(true);
});

test("legit Kurdish-politics headline passes", () => {
  expect(kurdHostileGate("رئيس إقليم كوردستان يلتقي مسؤولين عراقيين في بغداد").ok).toBe(true);
});

test("English Peshmerga operations news passes", () => {
  expect(kurdHostileGate("Kurdish Peshmerga forces confront ISIS militants near Mosul").ok).toBe(true);
});

test("legit condemnation of an attack on Erbil passes", () => {
  expect(kurdHostileGate("إدانة واسعة للهجوم على أربيل", "قادة إقليم كوردستان ينددون بالقصف").ok).toBe(true);
});

// ── editorialJunkGate: true positives (must be blocked) ────────────────────

test("dialectal poetry line is blocked", () => {
  expect(editorialJunkGate("يا الشاب إسمع كلامي", "من الشعر الشعبي").ok).toBe(false);
});

test("food/lifestyle post is blocked", () => {
  expect(editorialJunkGate("وجبة العشاء الليلة سهمكم العافية").ok).toBe(false);
});

test("militia statement / propaganda rant is blocked", () => {
  expect(editorialJunkGate("العساف", "لقد صبرنا كثيرا ودماؤنا تنزف").ok).toBe(false);
});

test("opinion essay marker is blocked", () => {
  expect(editorialJunkGate("تساؤلات حول ما إذا كان هذا تطور خطير يهدد المنطقة").ok).toBe(false);
});

test("junk phrase in the description alone is still blocked", () => {
  expect(editorialJunkGate("خبر عاجل", "أيسرّك يا شاب أن ترى هذا المنظر؟").ok).toBe(false);
});

// ── editorialJunkGate: near misses (must pass) ─────────────────────────────

test("legit Arabic war news passes", () => {
  expect(editorialJunkGate("غارة إسرائيلية على جنوب لبنان تسفر عن قتلى وجرحى").ok).toBe(true);
});

test("legit Iraq political news passes", () => {
  expect(editorialJunkGate("العراق يستنكر الهجوم على قاعدة عين الأسد ويؤكد دعمه للحكومة").ok).toBe(true);
});

test("legit Sorani news passes", () => {
  expect(editorialJunkGate("هێرشەکانی ئیسرائیل بەردەوام بوون لە باشووری لوبنان", "بەپێی سەرچاوە ناوخۆییەکان").ok).toBe(true);
});

test("legit English headline passes", () => {
  expect(editorialJunkGate("Iran, US resume nuclear talks in Vienna amid rising tensions").ok).toBe(true);
});

test("the word 'militia' alone does not over-block (no Peshmerga context)", () => {
  expect(kurdHostileGate("Hezbollah militia claims drone attack on Israeli base").ok).toBe(true);
});

test("gates never crash on empty or null inputs (length-gating lives upstream)", () => {
  expect(() => kurdHostileGate("")).not.toThrow();
  expect(() => kurdHostileGate("x", null)).not.toThrow();
  expect(() => editorialJunkGate("")).not.toThrow();
  expect(() => editorialJunkGate("x", null)).not.toThrow();
});
