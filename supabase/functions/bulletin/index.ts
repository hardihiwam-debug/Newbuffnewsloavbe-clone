// Iran Desk Bot — Daily Bulletin edge function.
//
// The settings UI advertises "Daily Bulletin — Auto-generated morning summary"
// (bulletin_enabled / bulletin_time / bulletin_hours); previously those
// columns were another configuration illusion — nothing ever read them. This
// function wires them to a real once-per-day recap:
//
//   1. self-gates on the settings timezone's wall clock (fires at/after
//      bulletin_time, once per local day — see _shared/bulletin.ts),
//   2. reserves the send with a conditional settings PATCH (compare-and-set
//      on last_bulletin_at), so overlapping cron ticks can never double-send,
//   3. reads published_history for the lookback window — the recap only
//      covers what actually went out,
//   4. summarizes the top headlines with Groq under the same fact-fidelity
//      rules as posts (numbers/places preserved, never invent),
//   5. sends the digest in the channel's language (Sorani via the MiniMax →
//      Gemini chain when default_language is ckb/both, same prompts as the
//      main pipeline) to every active chat.
//
// Scheduled by pg_cron (migration 0010) every 5 minutes; the due check makes
// the extra ticks free (no DB writes on non-due runs).

import { bulletinDueToday, localDateInTz } from "./_shared.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const INTERNAL_SECRET = Deno.env.get("INTERNAL_SECRET") ?? "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const MINIMAX_API_KEY = Deno.env.get("MINIMAX_API_KEY") ?? "";

function geminiKeys(): Array<{ index: number; key: string }> {
  const out: Array<{ index: number; key: string }> = [];
  for (let i = 1; i <= 6; i++) {
    const k = Deno.env.get(`GEMINI_API_KEY_${i}`)?.trim();
    if (k) out.push({ index: i, key: k });
  }
  return out;
}

// ── PostgREST helpers (same shape as the pipeline) ─────────────────────────
async function rest<T = unknown>(
  table: string,
  opts: { method?: "GET" | "POST" | "PATCH"; query?: string; body?: unknown; prefer?: string } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (opts.query) url += `?${opts.query}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.prefer ? { Prefer: opts.prefer } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PostgREST ${method} ${table} [${res.status}]: ${text.slice(0, 300)}`);
  }
  if (method === "GET" || opts.prefer === "return=representation") {
    return (await res.json().catch(() => null)) as T;
  }
  return undefined as T;
}

const enc = encodeURIComponent;

async function getSettings(): Promise<Record<string, unknown> | null> {
  const rows = await rest<Array<Record<string, unknown>>>("settings", { query: "select=*&limit=1" });
  return rows?.[0] ?? null;
}

async function listActiveChats(): Promise<Array<{ id: string; chat_id: number }>> {
  return (await rest<Array<{ id: string; chat_id: number }>>("chats", { query: "select=id,chat_id&active=eq.true" })) ?? [];
}

async function logActivity(type: string, level: string, message: string): Promise<void> {
  try {
    await rest("activity_log", { method: "POST", body: { type, level, message }, prefer: "return=minimal" });
  } catch {
    /* never break the bulletin */
  }
}

async function telegramCall(method: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  const json = JSON.parse(body) as { ok?: boolean; description?: string };
  if (!res.ok || !json.ok) throw new Error(`Telegram ${method} [${res.status}]: ${json.description ?? body.slice(0, 200)}`);
}

// ── Groq digest ─────────────────────────────────────────────────────────────
// Same fact-fidelity contract as the pipeline's rewrite: the digest may only
// reorganize the supplied headlines, never add facts, and every number/place
// must survive verbatim.
async function groqBuildBulletinDigest(headlines: string[], lookbackHours: number): Promise<string | null> {
  if (!GROQ_API_KEY || headlines.length === 0) return null;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: `You write a compact morning digest for an Iraqi, Muslim, pro-Iran regional news channel. You are given the headlines of everything the channel published in the last ${lookbackHours} hours. Write at most 8 bullet points, one per line, each starting with "• ", each a single sentence under 170 characters, in English. Merge duplicate coverage of the same event into ONE bullet. Keep every concrete number and named place exactly as given; never add facts, names, figures, weapons, casualties or consequences that are not in the supplied headlines. Never editorialize, soften or dramatize. Output ONLY the bullets, no headers, no markdown, no commentary.`,
          },
          { role: "user", content: headlines.join("\n") },
        ],
        temperature: 0.2,
        max_tokens: 700,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Groq ${res.status}`);
    const json = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    // Same accounting table as the pipeline's AI work (ai_usage, day/provider/kind).
    try {
      const day = new Date().toISOString().slice(0, 10);
      const rows = await rest<Array<{ id: string; prompt_tokens: number; completion_tokens: number; calls: number }>>(
        "ai_usage",
        { query: `day=eq.${enc(day)}&provider=eq.groq&kind=eq.bulletin&limit=1` },
      );
      if (rows?.[0]?.id) {
        await rest(`ai_usage?id=eq.${enc(rows[0].id)}`, {
          method: "PATCH",
          body: {
            calls: Number(rows[0].calls ?? 0) + 1,
            prompt_tokens: Number(rows[0].prompt_tokens ?? 0) + Number(json.usage?.prompt_tokens ?? 0),
            completion_tokens: Number(rows[0].completion_tokens ?? 0) + Number(json.usage?.completion_tokens ?? 0),
          },
          prefer: "return=minimal",
        });
      } else {
        await rest("ai_usage", {
          method: "POST",
          body: {
            day,
            provider: "groq",
            kind: "bulletin",
            calls: 1,
            prompt_tokens: Number(json.usage?.prompt_tokens ?? 0),
            completion_tokens: Number(json.usage?.completion_tokens ?? 0),
          },
          prefer: "return=minimal",
        });
      }
    } catch {
      /* accounting must never break the bulletin */
    }
    const text = (json.choices?.[0]?.message?.content ?? "").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

// ── Sorani translation (same prompts/validation as the main pipeline) ──────
const SORANI_SYSTEM_PROMPT =
  "Translate the following message into Kurdish Sorani (Central Kurdish, in the Sorani script). Output ONLY the translation — no commentary, no \"Translation:\" prefix, no quotes around the text. Preserve emojis, links, line breaks, and any formatting exactly. Preserve all numbers, dates, times, percentages and quoted statements exactly as given — never change, round or reword a figure.";
const SORANI_SYSTEM_PROMPT_STRICT =
  "Translate the following message into Kurdish Sorani (Central Kurdish). You MUST output ONLY the translation in the Sorani Arabic script (ئەلفوبێی عەرەبیی سۆرانی). Do NOT answer in English or Latin script — translate every word into Sorani script except widely-recognised abbreviations (CIA, US, UN, NATO, CEO). Do NOT add commentary, explanations, a \"Translation:\" prefix, or quotes. Output ONLY the Sorani translation. Preserve emojis, links, line breaks, and formatting exactly. Preserve all numbers, dates, times and quoted statements exactly as given — never change, round or reword a figure.";

function validateSorani(text: string): boolean {
  if (!text.trim()) return false;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const arabic = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) ?? []).length;
  if (arabic < 2) return false;
  if (latin > Math.max(24, arabic * 0.35)) return false;
  return /^[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF0-9\s\p{P}\p{S}\p{Extended_Pictographic}A-Za-z.-]*$/u.test(text);
}

function cleanGeminiTranslation(raw: string): string {
  let text = raw.trim();
  const lines = text.split(/\r?\n/);
  while (lines.length > 0) {
    const head = (lines[0] ?? "").trim();
    if (!head) break;
    if (/^(here(\u2019s|'s| is)?|translation[:：]|the (standard |english |kurdish )?translation|in (kurdish|sorani|english)[:：]?|output[:：])/i.test(head) && !/^[\u0600-\u06FF]/.test(head)) {
      lines.shift();
    } else break;
  }
  text = lines.join("\n").trim();
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  return text.replace(/^\s*[-*]\s+/gm, "").trim();
}

async function translateBulletinToSorani(
  text: string,
  glossary: string | undefined,
  mode = "gemini_first",
): Promise<{ text: string | null; model: string }> {
  const m = mode || "gemini_first";
  const useMinimax = m !== "gemini_only";
  const useGemini = m !== "minimax_only";
  const minimaxFirst = m === "minimax_first" || m === "minimax_only";
  const glossaryBlock = glossary?.trim() ? `TRANSLATION GLOSSARY — use these exact translations for key terms:\n${glossary.trim()}\n\n` : "";
  const slice = text.slice(0, 1400); // keep the digest under both providers' slice limits

  const tryMinimax = async (): Promise<string | null> => {
    if (!useMinimax || !MINIMAX_API_KEY) return null;
    for (const strict of [false, true]) {
      try {
        const res = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${MINIMAX_API_KEY}` },
          body: JSON.stringify({
            model: "minimax/minimax-m3",
            messages: [
              { role: "system", content: strict ? SORANI_SYSTEM_PROMPT_STRICT : SORANI_SYSTEM_PROMPT },
              { role: "user", content: `${glossaryBlock}${slice}` },
            ],
            temperature: 0.2,
            max_tokens: 4096,
          }),
          signal: AbortSignal.timeout(45_000),
        });
        if (!res.ok) continue;
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const out = (json.choices?.[0]?.message?.content ?? "").trim();
        if (validateSorani(out)) return out;
      } catch {
        /* try next */
      }
    }
    return null;
  };

  const tryGemini = async (): Promise<{ text: string; model: string } | null> => {
    if (!useGemini) return null;
    const keys = geminiKeys();
    if (keys.length === 0) return null;
    const models = ["gemini-2.5-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b"];
    for (const model of models) {
      for (const { key } of keys) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: `${glossaryBlock}${SORANI_SYSTEM_PROMPT}\n\nMessage:\n${slice}` }] }],
              generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 4096 },
            }),
            signal: AbortSignal.timeout(45_000),
          });
          if (!res.ok) continue;
          const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          const out = cleanGeminiTranslation((data?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? "").join(""));
          if (out && validateSorani(out)) return { text: out, model };
        } catch {
          /* try next */
        }
      }
    }
    return null;
  };

  if (minimaxFirst) {
    const mm = await tryMinimax();
    if (mm) return { text: mm, model: "minimax/minimax-m3" };
    const g = await tryGemini();
    if (g) return { text: g.text, model: g.model };
  } else {
    const g = await tryGemini();
    if (g) return { text: g.text, model: g.model };
    const mm = await tryMinimax();
    if (mm) return { text: mm, model: "minimax/minimax-m3" };
  }
  return { text: null, model: "none" };
}

// ── Message building ────────────────────────────────────────────────────────
function escapeBulletinHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildBulletinMessage(s: Record<string, unknown>, digest: string): string {
  const tz = String(s.timezone ?? "Asia/Baghdad");
  const header = `📋 <b>Daily Bulletin — ${localDateInTz(new Date(), tz)}</b>\n\n`;
  const footerRaw = s.post_footer == null ? "" : String(s.post_footer);
  const footer = footerRaw ? `\n\n<i>${escapeBulletinHtml(footerRaw)}</i>` : "";
  return header + escapeBulletinHtml(digest) + footer;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function runBulletin(): Promise<Record<string, unknown>> {
  const settings = await getSettings();
  if (!settings) return { skipped: "no settings row" };
  if (settings.bot_paused === true) return { skipped: "bot paused" };
  if (settings.bulletin_enabled === false) return { skipped: "disabled" };
  if (!bulletinDueToday(settings)) return { skipped: "not due" };

  // Compare-and-set claim: ONE conditional PATCH reserves the send so two
  // overlapping cron ticks (or a manual trigger) can never double-deliver.
  // A row comes back only when last_bulletin_at is empty or >22h old.
  const staleCutoff = new Date(Date.now() - 22 * 3_600_000).toISOString();
  const id = String(settings.id ?? "");
  if (!id) return { skipped: "no settings id" };
  const claimed = await rest<Array<Record<string, unknown>>>("settings", {
    method: "PATCH",
    query: `id=eq.${enc(id)}&or=(last_bulletin_at.is.null,last_bulletin_at.lt.${enc(staleCutoff)})`,
    body: { last_bulletin_at: new Date().toISOString() },
    prefer: "return=representation",
  }).catch(() => null);
  if (!claimed || claimed.length === 0) return { skipped: "already sent recently" };

  const lookbackHours = Math.max(1, Math.min(72, Number(settings.bulletin_hours ?? 24)));
  const cutoff = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();
  const rows = (await rest<Array<Record<string, unknown>>>("published_history", {
    query: `select=english_headline,headline,is_update,published_at&published_at=gte.${enc(cutoff)}&order=published_at.desc&limit=150`,
  }).catch(() => [])) ?? [];

  const headlines = rows
    .map((r) => String(r.english_headline ?? r.headline ?? "").trim())
    .filter((h) => h.length >= 15);
  const unique = [...new Set(headlines)].slice(0, 24);
  if (unique.length === 0) {
    await logActivity("bulletin", "info", "Bulletin skipped — no posts in the lookback window");
    return { skipped: "no posts in lookback" };
  }

  const digest = GROQ_API_KEY ? await groqBuildBulletinDigest(unique, lookbackHours) : null;
  const finalDigest = digest ?? unique.slice(0, 8).map((h) => `• ${h}`).join("\n");
  const english = buildBulletinMessage(settings, finalDigest);

  const language = (settings.default_language ?? "en") === "both" ? "ckb" : String(settings.default_language ?? "en");
  let body = english;
  let usedModel = "none";
  if (language === "ckb") {
    const translated = await translateBulletinToSorani(
      english,
      settings.translation_glossary as string | undefined,
      String(settings.translation_mode ?? "gemini_first"),
    );
    if (translated.text && translated.model !== "none") {
      body = translated.text;
      usedModel = translated.model;
    } else {
      await logActivity("bulletin", "warning", "Sorani unavailable — bulletin sent in English fallback");
      usedModel = "english-fallback";
    }
  }

  const chats = await listActiveChats();
  if (chats.length === 0) {
    await logActivity("bulletin", "warning", "Bulletin generated but no active destination chats");
    return { skipped: "no chats", stories: unique.length };
  }
  let sent = 0;
  for (const chat of chats) {
    try {
      await telegramCall("sendMessage", {
        chat_id: Number(chat.chat_id),
        text: body,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      sent += 1;
    } catch (err) {
      await logActivity("bulletin", "warning", `Bulletin send failed to chat ${chat.chat_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await logActivity("bulletin", "success", `Daily bulletin sent to ${sent}/${chats.length} chat(s) · ${unique.length} stories · ${usedModel}`);
  return { sent, chats: chats.length, stories: unique.length, model: usedModel };
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
  }
  if (INTERNAL_SECRET) {
    const provided = req.headers.get("x-internal-secret") ?? "";
    if (provided !== INTERNAL_SECRET) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
  }
  try {
    const result = await runBulletin();
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logActivity("bulletin", "error", `Bulletin failed: ${message}`);
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
});
