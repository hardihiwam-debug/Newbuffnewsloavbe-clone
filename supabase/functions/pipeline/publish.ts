// Publishing: bot-API video recovery, Telegram sends and runPublish selection.
// Extracted verbatim from pipeline/index.ts (split refactor) — no behavior change.

import { Post, PostFormat, ageLimitsFrom, botMatchesCategories, buildUpdateHeadline, checkDigitPreservation, chooseDeliveryMode, crossLanguageSimilarity, dedupeChats, dedupePostBody, editorialJunkGate, fingerprintArticle, fitCaption, formatMessage, getCategoryPolicies, getCategoryPolicy, hasRepeatedFigure, isIncompleteHeadline, isIncompleteSoraniEnding, kurdHostileGate, matchPublishedFingerprint, normalizeTitle, realDateCheckOk, relevanceGate, resolveFinalHeadline, safeHeadlineFallback, safeSoraniEnding, sameEvent, splitTranslatedPost, stripEchoedEnglishHeadline, stripEchoedSoraniHeadline, stripGlossaryLeak, whyItMattersTitleBase, type EventFingerprint } from "./_shared.ts";
import { aiDecideIsDuplicate, composeUpdateDelta, flushAiUsage, generateWhyItMatters, translateToSorani } from "./ai.ts";
import { Article, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, GROQ_API_KEY, INSTANT_POST_GAP_MS, OPENROUTER_API_KEY, PUBLISH_SCAN_CAP, SettingsRow, TELEGRAM_BOT_TOKEN } from "./config.ts";
import { BotRow, countCategoryPublishedToday, deleteQueueRow, enc, getTranslationCache, hostname, insertQueueItem, listActiveChats, listBots, listQueued, listRecentPublished, logActivity, patchSettings, rest, saveTranslationCache, setQueueStatus } from "./db.ts";
import { cachedMediaUrl, fetchArticleMeta, fetchTelegramPostImage, fetchTelegramPostVideo, isValidStoryImage } from "./fetch.ts";
import { neutralityGate, normalizeEditorial, respectGate, sectarianGate, stripLinks, stripSourceName } from "./gates.ts";
import { telegramCall } from "./telegram.ts";

class DeliveryUnknownError extends Error {
  constructor(cause: unknown) {
    super(`Telegram delivery outcome is unknown: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DeliveryUnknownError";
  }
}

function isDefinitiveTelegramFailure(err: unknown): boolean {
  // Telegram rejects malformed content/media before delivery with a 4xx. A
  // timeout, 5xx, or rate-limit response is ambiguous: the API may have
  // accepted the message even when this function did not receive confirmation.
  return /Telegram .* \[(400|401|403|404|413)\]/i.test(err instanceof Error ? err.message : String(err));
}

// ── Bot-API video recovery ─────────────────────────────────────────────────
// The public `t.me/s/<channel>` SSR HTML only ships the JPEG poster frame for
// a video post (it lazy-loads the actual .mp4 via JS when a client clicks).
// That is what `extractPostImage` picks up — so without this path every
// Telegram video post would default to "sendPhoto(thumb)" and look like a
// still image to subscribers.
//
// The Bot API path:
//   1. forwardMessage(from public channel -> staging chat) -> server returns
//      the forwarded Message object, which carries the media's `file_id`.
//   2. getFile(file_id) -> returns a server-side `file_path`.
//   3. Construct `https://api.telegram.org/file/bot<TOKEN>/<file_path>` and
//      store it as `video_url` so `sendVideo` posts the real video bytes.
//
// Staging chat defaults to the bot's own Saved Messages (resolved from
// `getMe`), so this works zero-config; operators can override with a private
// channel's chat_id via the `telegram_video_staging_chat_id` setting.

export let _botSelfId: number | null | undefined = undefined;
export async function getBotSelfId(): Promise<number | null> {
  if (_botSelfId !== undefined) return _botSelfId;
  if (!TELEGRAM_BOT_TOKEN) return (_botSelfId = null);
  try {
    const me = await telegramCall("getMe");
    const id = Number(me?.id ?? 0);
    return (_botSelfId = id > 0 ? id : null);
  } catch {
    return (_botSelfId = null);
  }
}

// Dead Telegram video posts (e.g. embed posts where forwardMessage returns
// 400) must not be retried on every 5-minute ingest cycle. Each failure is
// logged to activity_log with detail = "<channel>/<postId>"; this checks that
// log so a known-dead post is skipped for 24h.
export async function recentlyFailedVideoFetch(channelHandle: string, postId: number): Promise<boolean> {
  try {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const rows = await rest<Array<{ id: string }>>("activity_log", {
      query: `select=id&type=eq.telegram_video&level=eq.warning&detail=eq.${enc(`${channelHandle}/${postId}`)}&created_at=gte.${enc(since)}&limit=1`,
    });
    return (rows?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function fetchTelegramVideoViaBotApi(
  channelHandle: string,
  postId: number,
  stagingOverride: number | null,
): Promise<{ fileUrl: string; fileId: string } | null> {
  if (!TELEGRAM_BOT_TOKEN) return null;
  const staging = stagingOverride ?? await getBotSelfId();
  if (!staging) return null;

  let fwdMessageId: number | null = null;
  try {
    // forwardMessage accepts a channel username for from_chat_id; we prefix
    // '@' if the operator passed a bare handle.
    const fromChatId = channelHandle.startsWith("@") ? channelHandle : `@${channelHandle}`;
    const fwd = await telegramCall("forwardMessage", {
      chat_id: staging,
      from_chat_id: fromChatId,
      message_id: postId,
      disable_notification: true,
    });
    fwdMessageId = Number(fwd?.message_id ?? 0) || null;
    if (!fwdMessageId) return null;

    // The forwarded Message is `result`. Video media exposes a `video` object
    // with `file_id`. Photos use `photo: [{file_id, ...}, ...]`. We only
    // resolve videos here; photos still go through the selector on Post.
    const video = fwd?.video;
    if (!video?.file_id) return null;
    const fileId = String(video.file_id);

    const gf = await telegramCall("getFile", { file_id: fileId });
    const filePath = String(gf?.file_path ?? "");
    if (!filePath) return null;

    return {
      fileUrl: `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`,
      fileId,
    };
  } catch (err) {
    // Any failure path: log quietly and let the caller fall back to the
    // text-with-source-link publish branch. Never block ingest on this.
    await logActivity?.("telegram_video", "warning",
      `Bot-API video fetch failed for ${channelHandle}/${postId}: ${err instanceof Error ? err.message : String(err)}`,
      `${channelHandle}/${postId}`);
    return null;
  } finally {
    // Always clean up the staging copy so Saved Messages / the staging
    // channel don't accumulate forwarded posts over time.
    if (fwdMessageId && staging) {
      await telegramCall("deleteMessage", {
        chat_id: staging,
        message_id: fwdMessageId,
      }).catch(() => { /* ignore cleanup failures */ });
    }
  }
}

export type Downloaded = { bytes: ArrayBuffer; filename: string; contentType: string };
export async function downloadImage(url: string, kind: "image" | "video"): Promise<Downloaded | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: kind === "image" ? "image/avif,image/webp,image/*,*/*;q=0.8" : "video/mp4,video/*;q=0.9,*/*;q=0.8",
        referer: "https://t.me/",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(kind === "image" ? 15_000 : 60_000),
    });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.startsWith(kind === "image" ? "image/" : "video/")) return null;
    const bytes = await res.arrayBuffer();
    const cap = kind === "image" ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
    if (bytes.byteLength === 0 || bytes.byteLength > cap) return null;
    const ext = (ct.split("/")[1] || (kind === "image" ? "jpg" : "mp4")).replace(/^jpeg$/, "jpg").split(";")[0].trim();
    return { bytes, filename: `${kind === "image" ? "photo" : "video"}.${ext || (kind === "image" ? "jpg" : "mp4")}`, contentType: ct };
  } catch {
    return null;
  }
}
export async function sendPhotoFile(chatId: number, image: Downloaded, caption: string, token = TELEGRAM_BOT_TOKEN): Promise<number | null> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("photo", new Blob([image.bytes], { type: image.contentType }), image.filename);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
  const json = (await res.json()) as { ok?: boolean; description?: string; result?: { message_id?: unknown } };
  if (!res.ok || !json.ok) throw new Error(`Telegram sendPhoto upload: ${json.description ?? "failed"}`);
  return Number(json.result?.message_id) || null;
}
export async function sendVideoUrl(chatId: number, videoUrl: string, thumbUrl: string | null, caption: string, token = TELEGRAM_BOT_TOKEN): Promise<number | null> {
  const payload: Record<string, unknown> = { chat_id: String(chatId), video: videoUrl, caption, parse_mode: "HTML", supports_streaming: true };
  if (thumbUrl) payload.thumb = thumbUrl;
  const res = await telegramCall("sendVideo", payload, token);
  return Number(res.message_id) || null;
}
export async function sendVideoFileUpload(chatId: number, video: Downloaded, thumb: Downloaded | null, caption: string, token = TELEGRAM_BOT_TOKEN): Promise<number | null> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("supports_streaming", "true");
  form.append("video", new Blob([video.bytes], { type: video.contentType }), video.filename);
  if (thumb) form.append("thumb", new Blob([thumb.bytes], { type: thumb.contentType }), thumb.filename);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  const json = (await res.json()) as { ok?: boolean; description?: string; result?: { message_id?: unknown } };
  if (!res.ok || !json.ok) throw new Error(`Telegram sendVideo upload: ${json.description ?? "failed"}`);
  return Number(json.result?.message_id) || null;
}

export async function sendPost(
  chatId: number,
  post: Post,
  fmt?: PostFormat,
  mediaKind: "photo" | "video_thumb" | null = null,
  token = TELEGRAM_BOT_TOKEN,
): Promise<{ mode: "photo" | "video" | "text"; messageId: number | null }> {
  const text = formatMessage(post, fmt);
  const mode = chooseDeliveryMode(post, mediaKind);

  // Real video → sendVideo. Wins over any image, since for Telegram posts a
  // recovered .mp4 URL is strictly better than a poster-frame fallback.
  if (mode === "video" && post.videoUrl) {
    const video = post.videoUrl;
    const thumb = post.imageUrl ?? null;
    try {
      const midVideo = await sendVideoUrl(chatId, video, thumb, fitCaption(text), token);
      return { mode: "video", messageId: midVideo };
    } catch (err) {
      if (!isDefinitiveTelegramFailure(err)) throw new DeliveryUnknownError(err);
      // Prefer a Cloudflare-cached copy (Telegram pulls bytes from R2, not
      // this function); only download bytes here as a last resort.
      const cachedVideo = await cachedMediaUrl(video, "video");
      if (cachedVideo) {
        try {
          const midCached = await sendVideoUrl(chatId, cachedVideo, thumb, fitCaption(text), token);
          return { mode: "video", messageId: midCached };
        } catch (err) {
          if (!isDefinitiveTelegramFailure(err)) throw new DeliveryUnknownError(err);
          /* fall through to byte download */
        }
      }
      const downloadedVideo = await downloadImage(video, "video");
      if (downloadedVideo) {
        try {
          const downloadedThumb = thumb ? await downloadImage(thumb, "image") : null;
          const midUpload = await sendVideoFileUpload(chatId, downloadedVideo, downloadedThumb, fitCaption(text), token);
          return { mode: "video", messageId: midUpload };
        } catch (err) {
          if (!isDefinitiveTelegramFailure(err)) throw new DeliveryUnknownError(err);
          /* fall through */
        }
      }
    }
  }

  // Real photo → sendPhoto. We refuse to sendPhoto a video_thumb: the public
  // listing HTML only carries the JPEG poster frame for a real Telegram
  // video, and shipping that as a still image is misleading — subscribers
  // cannot tell it apart from a photo post. The video-thumb fallback is the
  // text-only branch below.
  if (mode === "photo" && post.imageUrl) {
    try {
      const midPhoto = await telegramCall("sendPhoto", { chat_id: chatId, photo: post.imageUrl, caption: fitCaption(text), parse_mode: "HTML" }, token);
      return { mode: "photo", messageId: Number(midPhoto.message_id) || null };
    } catch (err) {
      if (!isDefinitiveTelegramFailure(err)) throw new DeliveryUnknownError(err);
      // Cloudflare-cached copy first (R2 URL -> Telegram downloads from there),
      // byte download + re-upload only as a last resort.
      const cachedImage = await cachedMediaUrl(post.imageUrl, "image");
      if (cachedImage) {
        try {
          const midCached = await telegramCall("sendPhoto", { chat_id: chatId, photo: cachedImage, caption: fitCaption(text), parse_mode: "HTML" }, token);
          return { mode: "photo", messageId: Number(midCached.message_id) || null };
        } catch (err) {
          if (!isDefinitiveTelegramFailure(err)) throw new DeliveryUnknownError(err);
          /* fall through to byte download */
        }
      }
      const downloaded = await downloadImage(post.imageUrl, "image");
      if (downloaded) {
        try {
          const midFile = await sendPhotoFile(chatId, downloaded, fitCaption(text), token);
          return { mode: "photo", messageId: midFile };
        } catch (err) {
          if (!isDefinitiveTelegramFailure(err)) throw new DeliveryUnknownError(err);
          /* fall through to text */
        }
      }
    }
  }

  // Build the fallback caption. For Telegram video posts that we couldn't
  // recover a real .mp4 for, append an explicit "open in Telegram" pointer
  // so the source video isn't lost — subscribers just have to tap through.
  let fallbackText = text;
  if (mediaKind === "video_thumb" && post.url) {
    fallbackText = `${text}\n\n🎬 ${post.url}`;
  }
  try {
    const midText = await telegramCall("sendMessage", {
      chat_id: chatId,
      text: fallbackText,
      parse_mode: "HTML",
      link_preview_options: {
        is_disabled: fmt?.linkPreview === false ? true : Boolean(post.imageUrl),
      },
    }, token);
    return { mode: "text", messageId: Number(midText.message_id) || null };
  } catch (err) {
    if (!isDefinitiveTelegramFailure(err)) throw new DeliveryUnknownError(err);
    throw err;
  }
}


// ── Delete a published post ────────────────────────────────────────────────
// Console "delete this post" (admin deletePublishedPost → mode=delete): find
// every published_history row for the story (one per chat), call Telegram
// deleteMessage with the recorded message id (and the same per-chat bot token
// the send used), then remove the history rows so the story can be re-picked
// from the queue if it still exists. Rows without a recorded message id
// (pre-0043 sends) are reported per chat, not silently skipped.
export async function deletePublishedPost(
  historyId: string,
): Promise<{
  ok: boolean;
  reason?: string;
  deleted: number;
  chats: Array<{ chatId: number; messageId: number | null; ok: boolean; error?: string }>;
}> {
  const found = await rest<Array<Record<string, unknown>>>("published_history", {
    query: `select=*&id=eq.${enc(historyId)}&limit=1`,
  }).catch(() => []);
  const row = Array.isArray(found) ? found[0] : undefined;
  if (!row) return { ok: false, reason: "published row not found", deleted: 0, chats: [] };
  const dedupKey = String(row.dedup_key ?? "");
  const allRows = dedupKey
    ? await rest<Array<Record<string, unknown>>>("published_history", { query: `select=*&dedup_key=eq.${enc(dedupKey)}` }).catch(() => [])
    : [row];
  const chatRows = await listActiveChats();
  const botRows = await listBots().catch(() => new Map<string, BotRow>());
  const tokenByChat: Record<string, string> = {};
  for (const c of chatRows) {
    const tok = c.bot_id ? botRows.get(String(c.bot_id))?.token : undefined;
    tokenByChat[String(c.chat_id)] = tok || TELEGRAM_BOT_TOKEN;
  }
  const results: Array<{ chatId: number; messageId: number | null; ok: boolean; error?: string }> = [];
  let deleted = 0;
  for (const r of allRows ?? []) {
    const chatId = Number(r.chat_id ?? 0);
    const messageId = Number(r.telegram_message_id ?? 0) || null;
    if (!chatId || String(r.status ?? "sent") !== "sent") continue;
    if (!messageId) {
      results.push({ chatId, messageId: null, ok: false, error: "no message id recorded (pre-delete feature post)" });
      continue;
    }
    try {
      await telegramCall("deleteMessage", { chat_id: chatId, message_id: messageId }, tokenByChat[String(chatId)] ?? TELEGRAM_BOT_TOKEN);
      results.push({ chatId, messageId, ok: true });
      deleted += 1;
    } catch (err) {
      results.push({ chatId, messageId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Drop the history rows even when a per-chat delete failed: a row whose
  // message could not be removed should not keep suppressing the story in the
  // dedup window forever — the operator sees each chat's outcome above.
  await rest("published_history", { query: `id=eq.${enc(historyId)}`, method: "DELETE", prefer: "return=minimal" }).catch(() => {});
  if (dedupKey) {
    await rest("published_history", { query: `dedup_key=eq.${enc(dedupKey)}`, method: "DELETE", prefer: "return=minimal" }).catch(() => {});
  }
  await logActivity("publish", "info", `Deleted published post (${deleted} chat${deleted === 1 ? "" : "s"}): ${String(row.headline ?? row.english_headline ?? dedupKey).slice(0, 110)}`);
  return { ok: true, deleted, chats: results };
}

// ── Publish ─────────────────────────────────────────────────────────────────
export const DEDUP_STOPWORDS = new Set(
  "the a an of in on at to for and or with by from as is are was were be been says said after over into amid new live update updates latest breaking report reports could would should about against their his her its denies say thought".split(" "),
);

export type DedupContext = {
  publishedKeys: Set<string>;
  publishedFingerprints: Set<string>;
  publishedTitles: string[];
  publishedSourceTexts: string[];
  // Precomputed event fingerprints of the in-cooldown window (status !=
  // sending), extracted once per cycle — the event-fingerprint dedup layer
  // compares structured identity against these instead of re-extracting a
  // fingerprint per candidate × per published row.
  publishedFingerprintList: EventFingerprint[];
};

// Shared dedup snapshot built from the recent published_history window. Both
// runPublish (real sends) and computePublishPreview (dry-run) use the same
// snapshot so the dashboard's "Preview next batch" verdict matches what will
// actually happen when the publish button is pressed. Rows still in 'sending'
// state (a crashed publish that reserved the idempotency row before sending)
// are invisible here so the story is retried instead of being swallowed.
export function buildDedupContext(recentPublished: Array<Record<string, unknown>>, cooldownHours: number): DedupContext {
  const cooldownStart = new Date(Date.now() - cooldownHours * 3_600_000).toISOString();
  const inCooldown = recentPublished.filter(
    (r) => String(r.status ?? "sent") !== "sending" && (!r.published_at || String(r.published_at) >= cooldownStart),
  );
  const publishedTitles = inCooldown.map((r) => String(r.english_headline || r.headline || "")).filter(Boolean);
  const publishedFingerprints = new Set(
    publishedTitles.map((t) => normalizeTitle(t).split(" ").filter((w) => w.length > 3 && !DEDUP_STOPWORDS.has(w)).join(" ")),
  );
  const publishedSourceTexts = inCooldown.map((r) => String(r.source_text || "")).filter(Boolean);
  const publishedKeys = new Set(inCooldown.map((r) => String(r.dedup_key)));
  const publishedFingerprintList: EventFingerprint[] = [];
  for (const r of inCooldown) {
    const title = String(r.english_headline || r.headline || "");
    if (!title) continue;
    publishedFingerprintList.push(fingerprintArticle(title, String(r.summary || r.source_text || "")));
  }
  return { publishedKeys, publishedFingerprints, publishedTitles, publishedSourceTexts, publishedFingerprintList };
}

export function isRepeated(
  item: { dedup_key: string; headline: string; summary: string },
  dedup: DedupContext,
  simThreshold: number,
): boolean {
  const candidateFp = normalizeTitle(item.headline).split(" ").filter((w) => w.length > 3 && !DEDUP_STOPWORDS.has(w)).join(" ");
  const candidateText = `${item.headline} ${item.summary}`;
  return (
    dedup.publishedKeys.has(item.dedup_key) ||
    (candidateFp.length > 0 && dedup.publishedFingerprints.has(candidateFp)) ||
    dedup.publishedTitles.some((t) => sameEvent(t, item.headline, simThreshold)) ||
    dedup.publishedSourceTexts.some((t) => crossLanguageSimilarity(t, candidateText) >= 0.5)
  );
}

export function queueEffectiveScore(q: Record<string, unknown>): number {
  const base = Number(q.score ?? 0);
  const parts = (q.score_parts as Record<string, unknown>) ?? {};
  const ageSource = (q.original_published_at as string) ?? (q.created_at as string);
  const ageHours = ageSource ? Math.max(0, (Date.now() - Date.parse(ageSource)) / 3_600_000) : 24;
  return base + (Math.max(0, 60 - ageHours * 5) - Number(parts.freshness ?? 0));
}


// Operator-configured footer hyperlinks (settings.post_links). Stored as a
// jsonb array of { url, text } — appended to the bottom of every post.
export function parsePostLinks(raw: unknown): Array<{ url: string; text: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ url: string; text: string }> = [];
  for (const entry of raw) {
    let link = entry;
    if (typeof link === "string") {
      try { link = JSON.parse(link); } catch { continue; }
    }
    if (!link || typeof link !== "object") continue;
    const url = String((link as { url?: unknown }).url ?? "").trim();
    const text = String((link as { text?: unknown }).text ?? "").trim();
    if (url && text) out.push({ url, text });
  }
  return out;
}

// ── "Why it matters" analysis follow-up ────────────────────────────────────
// After a breaking story publishes, generate a short explainer and enqueue it
// as a separate analysis post for the next cycle (so it respects the normal
// window-gap cadence instead of dumping two posts back-to-back). Deterministic
// dedup_key = analysis:<event_id> means the same event can never generate two
// follow-ups, and analysis_kind marks the row so publish never re-triggers the
// generator and never suppresses it as a cluster duplicate.
export async function hasWhyItMatters(eventId: string): Promise<boolean> {
  const key = `analysis:${eventId}`;
  const q = await rest<Array<{ id: string }>>("queue", {
    query: `select=id&dedup_key=eq.${enc(key)}&limit=1`,
  }).catch(() => []);
  if ((q ?? []).length > 0) return true;
  const p = await rest<Array<{ id: string }>>("published_history", {
    query: `select=id&dedup_key=eq.${enc(key)}&limit=1`,
  }).catch(() => []);
  return (p ?? []).length > 0;
}

export async function whyItMattersCountToday(): Promise<number> {
  // Budget counts BOTH published-today rows and still-pending queue rows, so a
  // burst of breaking stories in one cycle can't enqueue more follow-ups than
  // the daily cap before any of them have been sent.
  const day = new Date().toISOString().slice(0, 10);
  const [q, p] = await Promise.all([
    rest<Array<{ id: string }>>("queue", {
      // Pending analysis rows count regardless of when they were queued. A
      // follow-up that survived midnight still consumes today's cap; otherwise
      // a backlog can bypass the per-day limit indefinitely.
      query: "select=id&analysis_kind=eq.why_it_matters&status=eq.queued&limit=1000",
    }).catch(() => []),
    rest<Array<{ id: string }>>("published_history", {
      query: `select=id&analysis_kind=eq.why_it_matters&published_at=gte.${enc(day)}&limit=1000`,
    }).catch(() => []),
  ]);
  return (q?.length ?? 0) + (p?.length ?? 0);
}

export async function enqueueWhyItMatters(
  item: Record<string, unknown>,
  settings: SettingsRow,
  deadline = Number.POSITIVE_INFINITY,
): Promise<boolean> {
  const eventId = String(item.event_id ?? "");
  if (!eventId) return false;
  const maxPerDay = Math.max(0, Math.floor(Number(settings.why_it_matters_max_per_day ?? 4)));
  if (maxPerDay <= 0) return false;
  const [already, count] = await Promise.all([hasWhyItMatters(eventId), whyItMattersCountToday()]);
  if (already) return false;
  if (count >= maxPerDay) {
    await logActivity("analysis", "info", `Why-it-matters skipped (daily cap ${maxPerDay}) — ${String(item.headline ?? "").slice(0, 100)}`);
    return false;
  }
  const headline = String(item.headline ?? "");
  const summary = String(item.summary ?? "");
  const sourceText = String(item.source_text ?? `${headline} ${summary}`);
  const category = String(item.category ?? "");
  const generated = await generateWhyItMatters(
    { headline, summary, sourceText, category },
    String(settings.ai_dedup_provider ?? "groq"),
    deadline,
  );
  if (!generated?.text) return false;
  const prefix = String(settings.why_it_matters_prefix ?? "WHY IT MATTERS — ");
  // The model falls back to the literal "Why it matters" when it produced no
  // significance title — prepending the prefix would double the phrase
  // ("WHY IT MATTERS — Why it matters"). Reuse the story headline instead.
  const baseTitle = whyItMattersTitleBase(stripLinks(normalizeEditorial(generated.title)), headline);
  const title = `${prefix}${baseTitle}`.slice(0, 160);
  const text = stripLinks(normalizeEditorial(generated.text)).slice(0, 1200);
  const inserted = await insertQueueItem({
    dedup_key: `analysis:${eventId}`,
    original_title: headline.slice(0, 300),
    rewrite_provider: null,
    rewrite_model: null,
    headline: title,
    summary: text,
    category: "analysis",
    source_name: "Iran Desk",
    url: String(item.url ?? ""),
    image_url: null,
    video_url: null,
    media_kind: null,
    original_published_at: new Date().toISOString(),
    source_text: sourceText.slice(0, 1500),
    event_id: eventId,
    facts: { kind: "why_it_matters", source_event: eventId },
    is_update: false,
    importance: "analysis",
    score: 34,
    score_parts: { priority: 34, freshness: 30, severity: 0, leader: 0, breaking: 0, boost: 0, instant: false },
    breaking: false,
    analysis_kind: "why_it_matters",
    status: "queued",
    created_at: new Date().toISOString(),
  });
  if (!inserted) return false;
  await logActivity("analysis", "success", `Why-it-matters queued for: ${headline.slice(0, 120)}`);
  return true;
}

export async function runPublish(
  settings: SettingsRow,
  force = 1,
  onlyId?: string | null,
  opts: { instantOnly?: boolean; deadline?: number } = {},
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { sent: 0, items: [] as string[] };
  // "Why it matters" generation is the one remaining unbounded AI call in the
  // publish path (up to 3 providers × 20s each). Cap it to ONE per publish
  // cycle and respect the cycle deadline threaded from runCycle — by the time
  // publish runs, ingest may already have consumed most of the ~100s budget.
  // Manual mode (no deadline) falls back to a 60s window.
  const analysisDeadline = opts.deadline ?? Date.now() + 60_000;
  let analysisEnqueuedThisCycle = false;
  const chats = dedupeChats(await listActiveChats());
  const bots = await listBots().catch(() => new Map<string, BotRow>());
  if (chats.length === 0) {
    await logActivity("publish", "warning", "Publish skipped — no active destination chats configured");
    return { ...result, skipped: "no chats" };
  }

  let pool = onlyId
    ? (await rest<Array<Record<string, unknown>>>("queue", { query: `select=*&id=eq.${enc(onlyId)}&limit=1` })) ?? []
    : await listQueued();
  // Instant-only mode (5-minute fast lane): restrict the pool to posts from
  // Instant Telegram channels (score_parts.instant set at ingest; the
  // boost>=150 fallback also catches rows queued before the flag existed).
  if (opts.instantOnly) {
    pool = pool.filter((item) => {
      const parts = (item.score_parts as Record<string, unknown> | null) ?? {};
      return parts.instant === true || Number(parts.boost ?? 0) >= 150;
    });
  }
  if (pool.length === 0) return { ...result, skipped: onlyId ? "item not found or no longer queued" : "queue empty" };

  const recentPublished = await listRecentPublished(200);
  const cooldownHours = Number(settings.event_cooldown_hours ?? 8);
  const dedup = buildDedupContext(recentPublished, cooldownHours);
  const cooldownStart = new Date(Date.now() - cooldownHours * 3_600_000).toISOString();
  const sentToChat = new Set(
    recentPublished
      .filter((r) => String(r.status ?? "sent") !== "sending" && (!r.published_at || String(r.published_at) >= cooldownStart))
      .map((r) => `${r.dedup_key}:${r.chat_id}`),
  );
  // Cluster-aware dedup set: event_ids published within the cooldown window.
  // Follow-up coverage sharing one of these event_ids is dropped even when its
  // dedup key differs (cross-outlet same-event suppression).
  const publishedEventIds = new Set(
    recentPublished
      .filter((r) => String(r.status ?? "sent") !== "sending" && (!r.published_at || String(r.published_at) >= cooldownStart))
      .map((r) => String(r.event_id ?? ""))
      .filter(Boolean),
  );
  const sorted = [...pool].sort((a, b) => {
    if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
    return queueEffectiveScore(b) - queueEffectiveScore(a);
  });

  const language = (settings.default_language ?? "en") === "both" ? "ckb" : String(settings.default_language ?? "en");
  const timezone = String(settings.timezone ?? "Asia/Baghdad");
  const simThreshold = Number(settings.event_similarity_threshold ?? 0.52);
  const whyItMattersCategories = Array.isArray(settings.why_it_matters_categories)
    ? (settings.why_it_matters_categories as unknown[]).filter(Boolean).map(String)
    : ["war", "iran", "proxies", "gaza", "syria", "lebanon", "iraq", "usa"];

  // Egress guard for article-page verification: article fetches relay through
  // the Cloudflare worker (Supabase egress untouched), but each one still
  // costs time and upstream bandwidth, so the per-cycle scan cap stays. Every
  // web candidate that clears dedup gets ONE fetch serving BOTH the og:image
  // hunt and the real-article-date check — no score bar, no category gate.
  const OG_FETCH_CAP_PER_CYCLE = 10;
  let ogFetchesThisCycle = 0;
  let sentThisCycle = 0;
  let updatesPublishedThisCycle = 0;
  // Scan past duplicates/rejects instead of stopping at the first candidate.
  // Instant mode drains the complete Instant outbox until the cycle deadline;
  // regular publishing retains its configured batch limit.
  const instantDrain = Boolean(opts.instantOnly);
  const maxItems = instantDrain ? sorted.length : Math.max(force, PUBLISH_SCAN_CAP);
  const sendLimit = instantDrain ? Number.POSITIVE_INFINITY : Math.max(force, 1);
  for (const item of sorted.slice(0, maxItems)) {
    if (Date.now() >= (opts.deadline ?? Number.POSITIVE_INFINITY)) break;
    if (sentThisCycle >= sendLimit) break;
    const id = String(item.id);
    const dedupKey = String(item.dedup_key);
    let headline = String(item.headline ?? "");
    let summary = String(item.summary ?? "");
    const url = String(item.url ?? "");
    const sourceName = String(item.source_name ?? "");
    // Generated "Why it matters" editorial add-on: exempt from the beat gate
    // and from every dedup layer (it is meant to overlap the story it explains,
    // and must never be mistaken for a duplicate of it).
    const isAnalysis = String(item.analysis_kind ?? "") === "why_it_matters";
    // Editorial safety net — applies to Telegram AND web items alike, and also
    // catches rows queued before these gates existed. Anti-hate (Kurds/Muslims),
    // sectarian (Shia religious), and neutrality (enemy-framing) are re-checked
    // here on the raw source text before anything is sent.
    const editorialText = `${headline} ${summary} ${String(item.source_text ?? "")}`;
    const editorialArticle: Article = {
      provider: "", sourceName, url,
      title: headline, description: editorialText,
      imageUrl: null, publishedAt: null, mediaKind: null,
    };
    const respectCheck = respectGate(editorialArticle);
    const sectCheck = sectarianGate(headline, editorialText);
    const neutCheck = neutralityGate(headline, editorialText);
    const junkCheck = editorialJunkGate(headline, editorialText);
    const kurdCheck = kurdHostileGate(headline, editorialText);
    const editorialReason = !respectCheck.ok ? respectCheck.reason : !sectCheck.ok ? sectCheck.reason : !neutCheck.ok ? neutCheck.reason : !junkCheck.ok ? junkCheck.reason : !kurdCheck.ok ? kurdCheck.reason : null;
    if (editorialReason) {
      await setQueueStatus(id, "rejected");
      await logActivity("publish", "info", `Editorial gate (${editorialReason}) — dropped: ${headline.slice(0, 110)}`);
      continue;
    }
    // Category daily cap — prevent one category from flooding the channel.
    // Count today's published posts of this category (exact DB count, not the
    // recent-window sample) and compare against the per-category policy limit.
    // Only applies to normal news posts, not to analysis follow-ups.
    const itemCat = String(item.category ?? "");
    if (!isAnalysis && itemCat) {
      const [dailyCount, catPolicies] = await Promise.all([
        countCategoryPublishedToday(itemCat),
        getCategoryPolicies(settings.category_policy),
      ]);
      const maxPerDay = getCategoryPolicy(catPolicies, itemCat).maxPostsPerDay;
      if (maxPerDay > 0 && dailyCount >= maxPerDay) {
        // Leave the row queued: it stays eligible and is re-checked next
        // cycle, so once the cap resets (next local day) it publishes on its
        // own. Marking it "held" would strand it in manual review forever.
        await logActivity("publish", "info", `Category daily cap (${itemCat}: ${dailyCount}/${maxPerDay}) — deferred: ${headline.slice(0, 110)}`);
        continue;
      }
    }
    // Publish-time beat gate — drops any web/RSS/NewsData item whose raw
    // source text is off-beat, even if it was queued before the latest
    // relevance filter. Telegram fast-lane channels are exempt: they are the
    // operator's hand-picked sources and are translated/published as-is.
    // A MANUAL force-publish (onlyId set) is never exempt: the operator must
    // not be able to push an off-beat item through by picking it in the UI.
    if (!isAnalysis && (Boolean(onlyId) || !sourceName.startsWith("@"))) {
      const sourceText = String(item.source_text ?? `${headline} ${summary}`);
      const gate = relevanceGate(sourceText, "");
      if (!gate.ok) {
        await setQueueStatus(id, "rejected");
        await logActivity("publish", "info", `Off-beat story rejected at publish (${gate.reason}): ${headline.slice(0, 110)}`);
        continue;
      }
    }
    if (!isAnalysis && isRepeated({ dedup_key: dedupKey, headline, summary }, dedup, simThreshold)) {
      await deleteQueueRow(id);
      continue;
    }

    // Event-fingerprint dedup (structured identity): keyword similarity
    // misses rephrased coverage ("US strikes western Yemen overnight" vs
    // "American aircraft hit Houthi positions in Yemen"), but both share a
    // structured fingerprint (actor=usa, action=strike, location=yemen). If a
    // story in the cooldown window matches above the threshold, this is the
    // same event and the copy is dropped — even though token overlap alone
    // would have let it through.
    const candidateFp = fingerprintArticle(headline, summary);
    if (!isAnalysis && candidateFp && matchPublishedFingerprint(candidateFp, dedup.publishedFingerprintList)) {
      await deleteQueueRow(id);
      await logActivity("publish", "info", `Event-fingerprint duplicate — dropped: ${headline.slice(0, 110)}`);
      continue;
    }

    // Cluster-aware dedup (phase 1) + material updates (phase 2): follow-up
    // coverage sharing the same event_id as a recently published story is a
    // duplicate — UNLESS the ingest step flagged it as a material update
    // (is_update), in which case it publishes as an "UPDATE —" post of the
    // same event (subject to the update cooldown + per-cycle cap) instead of
    // a separate story.
    const itemEventId = String(item.event_id ?? "");
    const isUpdate = Boolean(item.is_update);
    if (!isAnalysis && itemEventId && publishedEventIds.has(itemEventId)) {
      if (!isUpdate) {
        await deleteQueueRow(id);
        await logActivity("publish", "info", `Cluster duplicate (event ${itemEventId.slice(0, 16)}…) — dropped: ${headline.slice(0, 110)}`);
        continue;
      }
      const updateCooldownHours = Math.max(0.5, Number(settings.update_cooldown_hours ?? 1));
      const updateStart = new Date(Date.now() - updateCooldownHours * 3_600_000).toISOString();
      const recentUpdateForEvent = recentPublished.some(
        (r) =>
          String(r.event_id ?? "") === itemEventId &&
          Boolean(r.is_update) &&
          (!r.published_at || String(r.published_at) >= updateStart),
      );
      if (recentUpdateForEvent) {
        await deleteQueueRow(id);
        await logActivity("publish", "info", `Update cooldown — dropped follow-up update: ${headline.slice(0, 110)}`);
        continue;
      }
      if (updatesPublishedThisCycle >= Math.max(1, Number(settings.max_updates_per_cycle ?? 2))) {
        await deleteQueueRow(id);
        await logActivity("publish", "info", `Max updates this cycle — dropped: ${headline.slice(0, 110)}`);
        continue;
      }
    }

    // AI final dedup (settings.ai_dedup_enabled / ai_dedup_provider): an LLM
    // double-checks borderline candidates against the cooldown window's
    // published stories. Only reached when the fast checks above passed, so
    // the API cost stays bounded to ~1-3 calls per publish cycle.
    const hasAiDecisionProvider = Boolean(GROQ_API_KEY || OPENROUTER_API_KEY || (CLOUDFLARE_API_TOKEN && CLOUDFLARE_ACCOUNT_ID));
    const aiDedupEnabled = settings.ai_dedup_enabled !== false && hasAiDecisionProvider;
    if (!isAnalysis && aiDedupEnabled && dedup.publishedSourceTexts.length > 0) {
      const ai = await aiDecideIsDuplicate(`${headline}\n\n${summary}`, dedup.publishedSourceTexts, String(settings.ai_dedup_provider ?? "groq"));
      if (ai?.verdict === "duplicate") {
        await deleteQueueRow(id);
        await logActivity("publish", "info", `AI final dedup flagged duplicate — dropped: ${headline.slice(0, 110)}`);
        continue;
      }
    }

    // #3 Update delta: an UPDATE post of an already-briefed event ships ONLY
    // what changed since the parent post, so readers who saw the first story
    // get signal instead of déjà vu. Fail-open everywhere: no parent found,
    // no provider, or thin output → the full summary goes out unchanged.
    if (
      isUpdate &&
      !isAnalysis &&
      itemEventId &&
      hasAiDecisionProvider
    ) {
      const parentRows = await rest<Array<{ english_headline?: string | null; english_summary?: string | null }>>(
        "published_history",
        {
          query: `event_id=eq.${encodeURIComponent(itemEventId)}&is_update=eq.false&order=published_at.desc&limit=1&select=english_headline,english_summary`,
        },
      ).catch(() => [] as Array<{ english_headline?: string | null; english_summary?: string | null }>);
      const parent = parentRows?.[0];
      if (parent && (parent.english_summary || parent.english_headline)) {
        const delta = await composeUpdateDelta(
          `${parent.english_headline ?? ""}\n${parent.english_summary ?? ""}`,
          `${headline}\n${summary}`,
        );
        if (delta) {
          summary = delta;
          await logActivity("publish", "info", `Update delta composed (${delta.length} chars) — shipping only what's new`);
        }
      }
    }

    let resolvedImageUrl: string | null = isValidStoryImage(item.image_url) ? String(item.image_url) : null;
    let resolvedVideoUrl: string | null = typeof item.video_url === "string" && /^https:\/\//.test(item.video_url) ? String(item.video_url) : null;
    // media_kind is the discriminator set at ingest: "photo" for a real photo,
    // "video_thumb" when the listing HTML only shipped a video poster frame
    // (no <video src=...>). The publish path uses it below so a thumb-only
    // video post never falls into "sendPhoto(thumb)" (the original migration
    // bug). If the per-post page re-fetch finds a real .mp4 URL, we upgrade
    // the queue row's media_kind to "photo" so the queue reflects reality.
    let resolvedMediaKind: "photo" | "video_thumb" | null = (item.media_kind as "photo" | "video_thumb" | null | undefined) ?? null;
    const isTelegramUrl = /^https?:\/\/t\.me\//i.test(url);
    // Per-post Telegram media re-fetch (photo vs real .mp4) — only when the
    // operator wants images attached at all. Generated analysis follow-ups
    // are text-only and must never inherit the parent article's media.
    if (!isAnalysis && settings.grab_images !== false && isTelegramUrl) {
      const [img, vid] = await Promise.all([fetchTelegramPostImage(url), fetchTelegramPostVideo(url)]);
      if (vid) {
        resolvedVideoUrl = vid;
      }
      if (img) {
        // Only accept the per-post image fetch if it's a real photo. A
        // video_thumb there would just be the same poster frame — keeping
        // it suppressed avoids the "sendPhoto(thumb)" misdelivery.
        if (img.kind === "photo") {
          resolvedImageUrl = img.url;
          resolvedMediaKind = "photo";
        }
      }
    }
    // Web article verification — ONE fetch serves TWO jobs: the og:image fill
    // (the article page's og:image is canonical, and previously items under
    // the score bar never got an image hunt at all) and the real-article-date
    // check. The date check is UNCONDITIONAL: every web candidate, any
    // category, breaking or not — a feed re-stamp of an old story (the
    // tovima.com "Vance says Iran…" crawl from June) must never go out. It
    // also runs with grab_images off, because freshness is not a media
    // preference.
    else if (!isAnalysis && !isTelegramUrl && url && !resolvedImageUrl && ogFetchesThisCycle < OG_FETCH_CAP_PER_CYCLE) {
      ogFetchesThisCycle += 1;
      const meta = await fetchArticleMeta(url);
      if (meta.imageUrl) resolvedImageUrl = meta.imageUrl;
      else await logActivity("media", "info", `No og:image found for ${hostname(url)} — posting text-only`);
      if (meta.publishedTime) {
        const check = realDateCheckOk(meta.publishedTime, `${headline} ${summary}`, Date.now(), ageLimitsFrom(settings));
        if (!check.ok) {
          await deleteQueueRow(id);
          await logActivity("publish", "info", `Real article date ${Math.round(check.ageHours)}h old (> ${check.maxAge}h) — dropped: ${headline.slice(0, 110)}`);
          continue;
        }
      }
    }

    const isTelegramItem = sourceName.startsWith("@");
    const updatePrefix = String(settings.update_prefix ?? "UPDATE — ");
    let finalHeadline = isTelegramItem ? "" : headline;
    let finalSummary = summary;
    // Material updates of an already-published event carry the UPDATE prefix:
    // titled posts get it on the headline AFTER translation (so the Sorani
    // headline stays intact); untitled Telegram posts get it on the body
    // after translation too, because translating the body overwrites
    // finalSummary (buildUpdateHeadline is idempotent, so the non-ckb path
    // stays safe).
    let usedModel = "none";

    if (language === "ckb") {
      // Telegram posts go out as-is after translation (no title line). The
      // headline for a Telegram item is just the first 180 chars of the SAME
      // summary text, so prepending it made the model repeat the opening in
      // the translated output — the "texts repetition" in the channel.
      const toTranslate = isTelegramItem ? summary : `${headline}\n\n${summary}`;
      const glossary = settings.translation_glossary as string | undefined;
      const cached = await getTranslationCache(toTranslate, glossary);
      const mode = String(settings.translation_mode ?? "gemini_first");
      const modelOrder = settings.translation_model_order as string[] | undefined;
      let translated = cached ? { text: cached.kurdish, model: cached.model } : await translateToSorani(toTranslate, glossary, mode, modelOrder);
      if (translated.text && translated.model !== "none" && !cached) {
        // Phase-2 digit-preservation guard: a translation must keep the exact
        // figures of the source ("12 killed" may not become "15 killed").
        // One retry, then accept and log — we never block publication on a
        // digit, but we never silently ship a changed figure either.
        const digits = checkDigitPreservation(toTranslate, translated.text);
        if (!digits.ok) {
          const retry = await translateToSorani(toTranslate, glossary, mode, modelOrder);
          const retryOk = Boolean(retry.text) && checkDigitPreservation(toTranslate, retry.text).ok;
          if (retryOk) translated = retry;
          await logActivity("translation", "warning", `Digit guard — ${digits.missing.slice(0, 3).join(", ")} not in source${retryOk ? " (fixed on retry)" : ""}: ${headline.slice(0, 90)}`);
        }
        await saveTranslationCache(toTranslate, translated.text, translated.model, glossary).catch(() => {});
      }
      if (translated.text) {
        usedModel = translated.model;
        // Sanitize a leaked glossary instruction block first — cached rows may
        // still hold the old "TRANSLATION GLOSSARY — …" echo, and fresh output
        // is sanitized defensively here too.
        let clean = stripGlossaryLeak(translated.text, glossary, toTranslate);
        // Split the translation back into title + body. A single-block reply
        // (no \n\n) keeps the source headline as the title and uses the whole
        // translation as the body, so the text is never duplicated.
        let split = splitTranslatedPost(clean, headline, summary, isTelegramItem);
        // The model is handed the ENGLISH headline and sometimes echoes it
        // inside its Sorani body (the "English — SoraniTitle" leak). English
        // headline text never belongs in a Sorani body — remove it up front.
        if (!isTelegramItem && split.summary) {
          const deEchoed = stripEchoedEnglishHeadline(split.summary, headline);
          if (deEchoed !== split.summary) split = { headline: split.headline, summary: deEchoed };
        }
        // The model also echoes its OWN Sorani headline inside the body — no
        // guard existed for that. Strip it (only fires when the headline is
        // actually Arabic-script, i.e. translated).
        if (!isTelegramItem && split.summary && split.headline) {
          const soraniCleaned = stripEchoedSoraniHeadline(split.summary, split.headline);
          if (soraniCleaned !== split.summary) split = { headline: split.headline, summary: soraniCleaned };
        }
        // A translated title ending in a connector, or a translated BODY ending
        // mid-phrase on a dangling connector ("…گوشار دەخەنە سەر"), is an
        // interrupted translation, not a valid stylistic variation. Retry even
        // when the first result came from cache: old cached rows can contain
        // the exact malformed output.
        if ((!isTelegramItem && (isIncompleteHeadline(split.headline) || hasRepeatedFigure(split.headline))) || isIncompleteSoraniEnding(split.summary)) {
          const retry = await translateToSorani(toTranslate, glossary, mode, modelOrder);
          if (retry.text) {
            const retryClean = stripGlossaryLeak(retry.text, glossary, toTranslate);
            const retrySplit = splitTranslatedPost(retryClean, headline, summary, isTelegramItem);
            const retryBody = isTelegramItem ? retrySplit.summary : stripEchoedSoraniHeadline(stripEchoedEnglishHeadline(retrySplit.summary, headline), retrySplit.headline);
            if (
              (isTelegramItem || (!isIncompleteHeadline(retrySplit.headline) && !hasRepeatedFigure(retrySplit.headline))) &&
              !isIncompleteSoraniEnding(retryBody)
            ) {
              translated = retry;
              usedModel = retry.model;
              clean = retryClean;
              split = { headline: retrySplit.headline, summary: retryBody };
              await saveTranslationCache(toTranslate, retry.text, retry.model, glossary).catch(() => {});
            }
          }
          if (!isTelegramItem && isIncompleteHeadline(split.headline)) {
            await logActivity("translation", "warning", `Incomplete translated headline — using complete source headline: ${headline.slice(0, 110)}`);
            // Never send a visibly unfinished title. The source headline is
            // authoritative; if it also ends in a connector, trim only that
            // connector rather than fabricating a replacement.
            split = {
              headline: safeHeadlineFallback(headline),
              summary: split.summary || clean,
            };
          } else if (!isTelegramItem && hasRepeatedFigure(split.headline)) {
            // The garbled ticker class ("٥،٤٨٢ تاکای ٥٤٨٢" — one figure twice
            // in a single translated title). Fall back to the source headline
            // instead of shipping machine garbage.
            await logActivity("translation", "warning", `Repeated figure in translated headline — using source headline: ${headline.slice(0, 110)}`);
            split = {
              headline: safeHeadlineFallback(headline),
              summary: split.summary || clean,
            };
          }
          // Body still ends mid-phrase after the retry: trim the dangling
          // connector rather than publishing a visibly incomplete sentence.
          if (isIncompleteSoraniEnding(split.summary)) {
            split = { headline: split.headline, summary: safeSoraniEnding(split.summary) };
            await logActivity("translation", "warning", `Incomplete Sorani ending — trimmed dangling connector: ${headline.slice(0, 110)}`);
          }
        }
        finalHeadline = split.headline;
        finalSummary = split.summary;
      } else {
        await logActivity("translation", "warning", `Sorani unavailable — published English fallback (all providers exhausted): ${headline.slice(0, 110)}`);
        // Record the failure so the dashboard "Translation fails" stat is
        // honest instead of always reading 0.
        await rest("translation_failures", {
          method: "POST",
          body: {
            dedup_key: dedupKey,
            headline: headline.slice(0, 300),
            target_language: "ckb",
            models_tried: ["minimax", "gemini"],
            detail: "All translation models failed or returned non-Sorani output",
          },
          prefer: "return=minimal",
        }).catch(() => {});
        usedModel = "english-fallback";
      }
    }

    // Telegram (untitled) updates must get the prefix AFTER translation —
    // translating the body overwrites finalSummary and would wipe it.
    // buildUpdateHeadline is idempotent, so the non-ckb path stays safe.
    if (isUpdate && isTelegramItem) finalSummary = buildUpdateHeadline(finalSummary, updatePrefix);
    // Collapse a headline/paragraph the model echoed twice (run before
    // stripLinks so the \n\n paragraph boundaries are still intact).
    finalSummary = dedupePostBody(finalSummary, finalHeadline);
    finalHeadline = stripSourceName(stripLinks(normalizeEditorial(finalHeadline)), sourceName);
    finalSummary = stripSourceName(stripLinks(normalizeEditorial(finalSummary)), sourceName);
    if (isUpdate && !isTelegramItem) finalHeadline = buildUpdateHeadline(finalHeadline, updatePrefix);

    // ── Title completeness guarantee ──────────────────────────────────────
    // Never publish a visibly unfinished headline, in EITHER language: the
    // English path can carry a feed-truncated <title>, and the Sorani path may
    // still be broken if every retry + fallback failed. Trim a dangling
    // connector; if nothing complete remains, drop the post instead of
    // shipping a broken title. Telegram items are title-less by design
    // (finalHeadline === ""), so they are exempt. The decision itself lives
    // in the pure resolver (resolveFinalHeadline) so it is unit-tested.
    if (finalHeadline) {
      const resolved = resolveFinalHeadline(finalHeadline);
      if (resolved.drop) {
        await deleteQueueRow(id);
        await logActivity("publish", "info", `Incomplete headline after all retries — dropped: ${headline.slice(0, 110)}`);
        continue;
      }
      finalHeadline = resolved.headline;
      if (resolved.action === "trimmed") {
        await logActivity("publish", "warning", `Trimmed dangling headline ending: ${headline.slice(0, 110)}`);
      }
    }

    const post: Post & { mediaKind: "photo" | "video_thumb" | null } = {
      headline: finalHeadline,
      summary: finalSummary,
      sourceName: sourceName || hostname(url),
      url,
      imageUrl: settings.grab_images === false ? null : resolvedImageUrl,
      videoUrl: settings.grab_images === false ? null : resolvedVideoUrl,
      originalPublishedAt: (item.original_published_at as string) ?? null,
      breaking: Boolean(item.breaking),
      timezone,
      extraSources: [],
      category: String(item.category ?? "") || null,
      articleType: isAnalysis || String(item.category ?? "") === "analysis" ? "analysis" : "news",
      mediaKind: settings.grab_images === false ? null : resolvedMediaKind,
    };
    const fmt: PostFormat = {
      footer: settings.post_footer as string | null | undefined,
      emoji: settings.post_emoji as string | null | undefined,
      linkLabel: settings.post_link_label as string | null | undefined,
      showSource: settings.post_show_source as boolean | undefined,
      showTelegramSource: settings.post_show_telegram_source as boolean | undefined,
      showWebSource: settings.post_show_web_source as boolean | undefined,
      showTimestamp: settings.post_show_timestamp as boolean | undefined,
      breakingPrefix: settings.breaking_prefix as string | null | undefined,
      linkPreview: settings.link_previews as boolean | undefined,
      links: parsePostLinks(settings.post_links),
      // Auto-hashtag follows the language the post is actually sent in
      // (default_language; "both" resolves to ckb for the Sorani output).
      autoHashtag: settings.auto_hashtag !== false,
      hashtagLang: language,
      hashtagRules: settings.hashtag_rules,
      // Source trust-tier byline (Wire / State media / Independent / Analysis).
      showSourceTier: settings.source_tier_enabled !== false,
      sourceTierLang: language,
    };

    // Primary bot blocklist (Option B): categories the MAIN bot must NOT
    // deliver (empty = delivers everything, the historical behavior).
    const primaryExcludedCats = Array.isArray(settings.primary_bot_excluded_categories)
      ? (settings.primary_bot_excluded_categories as unknown[]).filter(Boolean).map(String)
      : [];
    let sentThisItem = 0;
    let eligibleChatCount = 0;
    for (const chat of chats) {
      if (sentToChat.has(`${dedupKey}:${chat.chat_id}`)) continue;
      // N-bot routing: a chat assigned to a bot sends with that bot's token
      // and only receives the categories in the bot's whitelist (empty = all).
      // A chat whose bot was deleted or disabled is skipped — it never falls
      // back to the primary bot silently.
      const chatBot = chat.bot_id ? bots.get(String(chat.bot_id)) : undefined;
      if (chat.bot_id && !chatBot) continue;
      // Multi-category matching: an article can belong to several categories
      // (primary + every other keyword block its text hits). A bot subscribed
      // to ANY of them receives it — specialized bots can overlap.
      const itemCat = String(item.category ?? "");
      const itemSourceForCats = String(item.source_text ?? `${headline} ${summary}`);
      if (!chatBot) {
        // Primary bot (blocklist mode): delivers everything EXCEPT stories
        // whose category set intersects the excluded list. botMatchesCategories
        // is reused: matching an excluded category means the story is dropped.
        if (primaryExcludedCats.length > 0 && botMatchesCategories(primaryExcludedCats, itemCat, itemSourceForCats)) continue;
      } else {
        // A chat assigned to a bot that owns no token must be skipped — sending
        // it with the PRIMARY bot's token would deliver via the wrong bot.
        if (!chatBot.token) continue;
        const botCatList = Array.isArray(chatBot.categories)
          ? (chatBot.categories as unknown[]).filter(Boolean).map(String)
          : [];
        if (!botMatchesCategories(botCatList, itemCat, itemSourceForCats)) continue;
      }
      const sendToken = chatBot?.token || TELEGRAM_BOT_TOKEN;
      eligibleChatCount += 1;
      // Idempotency: reserve the (dedup_key, chat_id) published_history row
      // BEFORE sending so a crash between "Telegram delivered" and "database
      // written" can never cause a duplicate send on the next cycle. The
      // unique index on (dedup_key, chat_id) is the backstop; 'sending' rows
      // are invisible to the dedup snapshot (so a crashed send retries) and a
      // completed send is flipped to 'sent'.
      let historyId: string | null = null;
      try {
        const inserted = await rest<Array<{ id: string }>>("published_history", {
          method: "POST",
          body: {
            dedup_key: dedupKey,
            chat_id: Number(chat.chat_id),
            headline: isTelegramItem ? headline : finalHeadline,
            english_headline: headline,
            english_summary: summary.slice(0, 1200),
            source_text: item.source_text ?? null,
            event_id: item.event_id ?? null,
            source_name: post.sourceName,
            category: String(item.category ?? ""),
            breaking: Boolean(item.breaking),
            is_update: isUpdate,
            analysis_kind: isAnalysis ? "why_it_matters" : null,
            original_published_at: post.originalPublishedAt,
            image_url: post.imageUrl ?? null,
            video_url: post.videoUrl ?? null,
            status: "sending",
            published_at: new Date().toISOString(),
          },
          prefer: "return=representation",
        });
        historyId = (inserted as Array<{ id: string }> | null)?.[0]?.id ?? null;
      } catch {
        // Unique (dedup_key, chat_id) already exists: either a completed send
        // ('sent' — safe to skip) or a crashed reservation ('sending' — retry
        // by adopting the existing row).
        const existing = await rest<Array<{ id: string; status: string | null }>>("published_history", {
          query: `dedup_key=eq.${enc(dedupKey)}&chat_id=eq.${Number(chat.chat_id)}&limit=1`,
        }).catch(() => []);
        const ex = existing?.[0];
        if (ex && String(ex.status ?? "sent") !== "sending") continue;
        // A sending reservation is an ambiguous delivery, not permission to
        // send again. Retain it until an operator reconciles the Telegram
        // message; retrying it here can duplicate a post after a timeout.
        if (ex) continue;
        // The reservation POST failed for a reason other than a visible unique
        // conflict. Do not send without a durable reservation.
        continue;
      }
      try {
        const delivery = await sendPost(Number(chat.chat_id), post, fmt, post.mediaKind ?? null, sendToken);
        const flip = () =>
          rest(`published_history?id=eq.${enc(String(historyId))}`, {
            method: "PATCH",
            body: { status: "sent", delivery_mode: delivery.mode, telegram_message_id: delivery.messageId ?? null },
            prefer: "return=minimal",
          });
        try {
          await flip();
        } catch {
          await flip().catch(() => {});
        }
        result.sent = Number(result.sent) + 1;
        sentThisItem += 1;
        sentToChat.add(`${dedupKey}:${chat.chat_id}`);
        dedup.publishedKeys.add(dedupKey);
        if (isUpdate) updatesPublishedThisCycle += 1;
        await logActivity("publish", "success", `Published${isUpdate ? " (UPDATE)" : ""}: ${headline.slice(0, 140)}`, `${usedModel} · ${delivery.mode}`);
      } catch (err) {
        // Keep the reservation when the outcome is ambiguous. Deleting it
        // would make the next cycle resend a message that Telegram may already
        // have delivered. Definitive 4xx validation/auth failures are safe to
        // remove and retry after the underlying content/config is corrected.
        if (historyId && isDefinitiveTelegramFailure(err)) {
          // If this delete fails, the 'sending' reservation survives: it is
          // invisible to the dedup snapshot AND skipped on retry, so the
          // story can never be sent again until an operator reconciles it.
          await rest(`published_history?id=eq.${enc(String(historyId))}`, { method: "DELETE", prefer: "return=minimal" }).catch((delErr: unknown) => {
            void logActivity("publish", "error", `Failed to clear failed-send reservation ${String(historyId).slice(0, 8)}: ${delErr instanceof Error ? delErr.message : String(delErr)}`);
          });
        }
        await logActivity("publish", "warning", `Send failed to chat ${chat.chat_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (sentThisItem > 0 && sentThisItem === eligibleChatCount) {
      // "delete after post" — the post already landed in every eligible chat it
      // reached. Leaving the queue row around until pruneQueueAndRetain
      // (1h sweep) wastes Supabase rows; an immediate DELETE keeps the
      // free-plan table flat. On any subsequent restage the canonical
      // dedup_key already lives in published_history until the cooldown
      // window expires, so dup-detection still works.
      await deleteQueueRow(id);
      sentThisCycle += 1;
      // Analysis follow-up: after a breaking story actually goes out, queue a
      // short "Why it matters" explainer for the next cycle (respects the
      // window-gap cadence, capped per day, one per event).
      if (
        !analysisEnqueuedThisCycle &&
        Date.now() < analysisDeadline &&
        Boolean(item.breaking) &&
        !isUpdate &&
        !isAnalysis &&
        settings.why_it_matters_enabled === true &&
        whyItMattersCategories.includes(String(item.category ?? ""))
      ) {
        const enqueued = await enqueueWhyItMatters(item, settings, analysisDeadline).catch(async (err) => {
          await logActivity("analysis", "warning", `Why-it-matters failed: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        });
        if (enqueued) analysisEnqueuedThisCycle = true;
      }
      if (opts.instantOnly && sentThisCycle < Math.max(force, 1)) {
        await new Promise((r) => setTimeout(r, INSTANT_POST_GAP_MS));
      }
      (result.items as string[]).push(headline);
      dedup.publishedTitles.unshift(headline);
      // Same-cycle event suppression: refresh the cluster set + source texts
      // with what just went out, so a second outlet of the SAME brand-new
      // event queued behind this one is dropped by the cluster check instead
      // of slipping through until the next cycle's snapshot.
      if (itemEventId) publishedEventIds.add(itemEventId);
      const srcText = String(item.source_text ?? "");
      if (srcText) dedup.publishedSourceTexts.unshift(srcText);
    } else {
      // Keep a partially delivered item queued. The next cycle skips chats
      // already recorded as sent and retries only the remaining eligible
      // chats; deleting here would permanently lose those deliveries.
      await setQueueStatus(id, "queued");
      if (sentThisItem > 0 && eligibleChatCount > sentThisItem) {
        await logActivity("publish", "warning", `Partial delivery (${sentThisItem}/${eligibleChatCount}); retained for retry: ${headline.slice(0, 110)}`);
      }
    }
  }

  if (Number(result.sent) > 0) {
    await patchSettings(String(settings.id), { last_published_at: new Date().toISOString() });
  }
  await flushAiUsage();
  return result;
}

