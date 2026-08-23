// Admin handlers for the Scheduled Posts / Campaign engine
// (Settings → Campaigns). Kept in their own module (imported into index.ts's
// dispatcher) so the big admin file stays untouched.
//
// Wire shape (same as every other admin action):
//   POST /functions/v1/admin  body: { action, pin, ...payload }
//
// Actions:
//   listScheduled              → { campaigns(with stats), items, log }
//   saveScheduledCampaign      upsert header; optional `items[]` on create
//   saveScheduledItem          upsert a single part/post
//   deleteScheduledCampaign    cascade delete (items + log)
//   deleteScheduledItem
//   setScheduledCampaignStatus active | paused | completed
//   scheduledSkipNext          mark the next pending part skipped
//   scheduledSendNext          force-due the next pending part (campaign → active)
//   scheduledSendItem          force-due a specific part (campaign → active)
//   scheduledResetItem         failed/skipped → pending, attempts 0

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function restHeaders(prefer?: string): HeadersInit {
  const h: Record<string, string> = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) h["Prefer"] = prefer;
  return h;
}

async function rest<T = unknown>(
  table: string,
  opts: { method?: "GET" | "POST" | "PATCH" | "DELETE"; query?: string; body?: unknown; prefer?: string } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (opts.query) url += `?${opts.query}`;
  const res = await fetch(url, {
    method,
    headers: restHeaders(opts.prefer),
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PostgREST ${method} ${table} [${res.status}]: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  if (method === "GET" || opts.prefer?.includes("return=representation")) {
    return (await res.json().catch(() => [])) as T;
  }
  return undefined as T;
}

function snakeToCamel<T = Record<string, unknown>>(row: Record<string, unknown> | null | undefined): T {
  const out: Record<string, unknown> = {};
  if (!row) return out as T;
  for (const [k, v] of Object.entries(row)) {
    const camel = k.replace(/_([a-z0-9])/g, (_, m) => m.toUpperCase());
    out[camel] = v;
  }
  if ("id" in out && !("_id" in out)) out["_id"] = out["id"];
  return out as T;
}

function snakeArray<T = Record<string, unknown>>(rows: unknown): T[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => snakeToCamel<T>(r as Record<string, unknown>));
}

const enc = (v: string | number) => encodeURIComponent(String(v));

function pick(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) body[key] = value;
}

// ── List ───────────────────────────────────────────────────────────────────
export async function listScheduled(): Promise<{
  campaigns: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  log: Array<Record<string, unknown>>;
}> {
  const [campaignsRaw, itemsRaw, logRaw] = await Promise.all([
    rest<Array<Record<string, unknown>>>("scheduled_campaigns", { query: "select=*&order=created_at.desc&limit=100" }),
    rest<Array<Record<string, unknown>>>("scheduled_items", { query: "select=*&order=position.asc&limit=2000" }),
    rest<Array<Record<string, unknown>>>("scheduled_log", { query: "order=sent_at.desc&limit=60" }),
  ]);
  const items = snakeArray<Record<string, any>>(itemsRaw);
  const log = snakeArray(logRaw);
  const campaigns = snakeArray<Record<string, any>>(campaignsRaw).map((c) => {
    const own = items.filter((i) => String(i.campaignId) === String(c.id));
    const pending = own.filter((i) => i.status === "pending").sort((a, b) => a.position - b.position);
    return {
      ...c,
      stats: {
        total: own.length,
        pending: pending.length,
        sent: own.filter((i) => i.status === "sent").length,
        failed: own.filter((i) => i.status === "failed").length,
        skipped: own.filter((i) => i.status === "skipped").length,
        nextPosition: pending[0]?.position ?? null,
      },
    };
  });
  return { campaigns, items, log };
}

// ── Save campaign (header + optional initial items on create) ─────────────
async function insertItems(campaignId: string, items: unknown[]): Promise<number> {
  const existing = await rest<Array<{ position: number }>>("scheduled_items", {
    query: `campaign_id=eq.${enc(campaignId)}&select=position&order=position.desc&limit=1`,
  }).catch(() => [] as Array<{ position: number }>);
  let pos = Number(existing?.[0]?.position ?? 0) + 1;
  const rows: Array<Record<string, unknown>> = [];
  for (const raw of items) {
    const it = (raw ?? {}) as Record<string, any>;
    const text = String(it.text ?? "").trim();
    if (!text) continue;
    rows.push({
      campaign_id: campaignId,
      position: pos++,
      title: it.title ? String(it.title).trim() : null,
      text,
      image_url: it.imageUrl ?? it.image_url ?? null,
      scheduled_for: it.scheduledFor ?? it.scheduled_for ?? null,
    });
  }
  if (rows.length > 0) {
    await rest("scheduled_items", { method: "POST", body: rows, prefer: "return=minimal" });
  }
  return rows.length;
}

export async function saveScheduledCampaign(p: any): Promise<{ ok: boolean; id: string; itemsAdded?: number }> {
  const body: Record<string, unknown> = {};
  pick(body, "name", p.name);
  pick(body, "kind", p.kind);
  pick(body, "status", p.status);
  pick(body, "timezone", p.timezone);
  pick(body, "start_at", p.startAt ?? p.start_at);
  pick(body, "end_at", p.endAt ?? p.end_at);
  pick(body, "schedule", p.schedule);
  pick(body, "target_chat_ids", p.targetChatIds ?? p.target_chat_ids);
  pick(body, "max_attempts", p.maxAttempts ?? p.max_attempts);

  const id = p._id ?? p.id;
  if (id) {
    if (Object.keys(body).length === 0) return { ok: true, id: String(id) };
    await rest(`scheduled_campaigns?id=eq.${enc(String(id))}`, { method: "PATCH", body, prefer: "return=minimal" });
    return { ok: true, id: String(id) };
  }
  const rows = await rest<Array<{ id: string }>>("scheduled_campaigns", {
    method: "POST",
    body: { ...body, status: p.status ?? "active" },
    prefer: "return=representation",
  });
  const cid = String(rows?.[0]?.id ?? "");
  if (!cid) throw new Error("campaign create returned no id");
  const itemsAdded = Array.isArray(p.items) && p.items.length > 0 ? await insertItems(cid, p.items) : 0;
  return { ok: true, id: cid, itemsAdded };
}

// ── Item upsert / delete ───────────────────────────────────────────────────
export async function saveScheduledItem(p: any): Promise<{ ok: boolean; id: string }> {
  const body: Record<string, unknown> = {};
  pick(body, "title", p.title);
  pick(body, "text", p.text);
  pick(body, "image_url", p.imageUrl ?? p.image_url);
  pick(body, "scheduled_for", p.scheduledFor ?? p.scheduled_for);
  pick(body, "position", p.position);
  const id = p._id ?? p.id;
  if (id) {
    await rest(`scheduled_items?id=eq.${enc(String(id))}`, { method: "PATCH", body, prefer: "return=minimal" });
    return { ok: true, id: String(id) };
  }
  if (!p.campaignId) throw new Error("campaignId required for a new item");
  const rows = await rest<Array<{ id: string }>>("scheduled_items", {
    method: "POST",
    body: {
      ...body,
      campaign_id: String(p.campaignId),
      position: Number(p.position ?? 1),
      status: "pending",
      attempts: 0,
    },
    prefer: "return=representation",
  });
  return { ok: true, id: String(rows?.[0]?.id ?? "") };
}

export async function deleteScheduledCampaign(p: any): Promise<{ ok: boolean; deleted: boolean }> {
  await rest(`scheduled_campaigns?id=eq.${enc(String(p._id ?? p.id))}`, { method: "DELETE", prefer: "return=minimal" });
  return { ok: true, deleted: true };
}

export async function deleteScheduledItem(p: any): Promise<{ ok: boolean; deleted: boolean }> {
  await rest(`scheduled_items?id=eq.${enc(String(p._id ?? p.id))}`, { method: "DELETE", prefer: "return=minimal" });
  return { ok: true, deleted: true };
}

// ── Status / overrides ─────────────────────────────────────────────────────
export async function setScheduledCampaignStatus(p: any): Promise<{ ok: boolean; id: string; status: string }> {
  const status = String(p.status ?? "");
  if (!["active", "paused", "completed"].includes(status)) throw new Error(`invalid status: ${status}`);
  await rest(`scheduled_campaigns?id=eq.${enc(String(p._id ?? p.id))}`, {
    method: "PATCH",
    body: { status },
    prefer: "return=minimal",
  });
  return { ok: true, id: String(p._id ?? p.id), status };
}

async function nextPendingItem(campaignId: string): Promise<Record<string, unknown> | null> {
  const rows = await rest<Array<Record<string, unknown>>>("scheduled_items", {
    query: `campaign_id=eq.${enc(campaignId)}&status=eq.pending&order=position.asc&limit=1`,
  });
  return (rows?.[0] ?? null) as Record<string, unknown> | null;
}

// \"Skip next\": the next pending part is marked skipped — the series simply
// advances to the following part on the next cycle.
export async function scheduledSkipNext(p: any): Promise<{ ok: boolean; itemId: string | null }> {
  const item = await nextPendingItem(String(p.campaignId));
  if (!item) return { ok: true, itemId: null };
  await rest(`scheduled_items?id=eq.${enc(String(item.id))}`, {
    method: "PATCH",
    body: { status: "skipped", force_due: false },
    prefer: "return=minimal",
  });
  return { ok: true, itemId: String(item.id) };
}

// \"Send next\" / \"Send now\": force the part due on the next tick. Works even
// on a paused campaign — the override also flips the campaign back to active
// so the operator can always intervene without touching the sequence.
async function forceItem(itemId: string, campaignId: string): Promise<{ ok: boolean; itemId: string }> {
  await rest(`scheduled_campaigns?id=eq.${enc(campaignId)}`, {
    method: "PATCH",
    body: { status: "active" },
    prefer: "return=minimal",
  });
  await rest(`scheduled_items?id=eq.${enc(itemId)}`, {
    method: "PATCH",
    body: { force_due: true, status: "pending", attempts: 0, error: null },
    prefer: "return=minimal",
  });
  return { ok: true, itemId };
}

export async function scheduledSendNext(p: any): Promise<{ ok: boolean; itemId: string | null }> {
  const item = await nextPendingItem(String(p.campaignId));
  if (!item) return { ok: true, itemId: null };
  return forceItem(String(item.id), String(p.campaignId));
}

export async function scheduledSendItem(p: any): Promise<{ ok: boolean; itemId: string | null }> {
  const id = String(p._id ?? p.itemId);
  if (!id) return { ok: false, itemId: null };
  const rows = await rest<Array<Record<string, unknown>>>("scheduled_items", {
    query: `id=eq.${enc(id)}&select=campaign_id&limit=1`,
  });
  const campaignId = String(rows?.[0]?.campaign_id ?? "");
  if (!campaignId) throw new Error("item not found");
  return forceItem(id, campaignId);
}

// Reset a failed/skipped part back to pending so the engine retries it in
// sequence (position order) — used after fixing a target chat / image URL.
export async function scheduledResetItem(p: any): Promise<{ ok: boolean; itemId: string }> {
  const id = String(p._id ?? p.itemId);
  await rest(`scheduled_items?id=eq.${enc(id)}`, {
    method: "PATCH",
    body: { status: "pending", attempts: 0, error: null, force_due: false },
    prefer: "return=minimal",
  });
  return { ok: true, itemId: id };
}
