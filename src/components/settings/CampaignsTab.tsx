// Campaigns tab — the Scheduled Posts / automation engine (separate from the
// news pipeline). Create one-time posts, recurring posts, and series
// campaigns (e.g. a 30-part Seerah series at 20:00 daily). Parts are sent by
// the dedicated `scheduled` Edge Function (ticked every minute); a series
// advances only after a successful send, and a part that fails max_attempts
// times is auto-skipped. All state lives in the DB, so restarts never lose
// progress.
//
// Every override below (pause/resume, skip next, send next, send now, reset)
// is a PIN-gated admin action that the operator can always intervene with
// without breaking the sequence.

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CirclePause,
  History,
  ListOrdered,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Send,
  SkipForward,
  Trash2,
  X,
} from "lucide-react";
import { api, useAdminMutation, useAdminQuery } from "@/lib/supabaseAdminHooks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSettings } from "./shared";
import { Card, CompactInput, CompactSelect, Pill } from "./shared";

// ── Types (mirror the admin listScheduled payload) ────────────────────────
type ScheduledPayload = {
  campaigns: any[];
  items: any[];
  log: any[];
};
type DraftItem = {
  key: string;
  title: string;
  text: string;
  imageUrl: string;
  scheduledFor: string; // "" = unset (manual cadence per-part dates)
};

const KIND_LABELS: Record<string, string> = {
  series: "Series",
  recurring: "Recurring",
  one_time: "One-time",
};
const STATUS_TONES: Record<string, { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-healthy/10 text-healthy" },
  paused: { label: "Paused", cls: "bg-muted text-muted-foreground" },
  completed: { label: "Completed", cls: "bg-info/10 text-info" },
  expired: { label: "Expired", cls: "bg-destructive/10 text-destructive" },
};
const TIMEZONES = [
  "Asia/Baghdad",
  "Asia/Erbil",
  "Asia/Tehran",
  "Asia/Dubai",
  "Asia/Riyadh",
  "Africa/Cairo",
  "Europe/Istanbul",
  "Europe/London",
  "Asia/Karachi",
  "Asia/Kolkata",
  "America/New_York",
  "UTC",
];
const WEEKDAYS = [
  { iso: 1, label: "Mon" },
  { iso: 2, label: "Tue" },
  { iso: 3, label: "Wed" },
  { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" },
  { iso: 6, label: "Sat" },
  { iso: 7, label: "Sun" },
];

function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CampaignsTab() {
  const { pin, pinArgs, onError, chats } = useSettings();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const qArgs = useMemo(
    () => (pin ? { ...pinArgs, __r: tick } : ("skip" as const)),
    [pin, pinArgs, tick],
  );
  const scheduled = useAdminQuery<ScheduledPayload>(api.admin.listScheduled, qArgs, {
    refetchIntervalMs: 30_000,
  });

  const saveCampaign = useAdminMutation(api.admin.saveScheduledCampaign);
  const saveItem = useAdminMutation(api.admin.saveScheduledItem);
  const deleteCampaign = useAdminMutation(api.admin.deleteScheduledCampaign);
  const deleteItem = useAdminMutation(api.admin.deleteScheduledItem);
  const setStatus = useAdminMutation(api.admin.setScheduledCampaignStatus);
  const skipNext = useAdminMutation(api.admin.scheduledSkipNext);
  const sendNext = useAdminMutation(api.admin.scheduledSendNext);
  const sendItem = useAdminMutation(api.admin.scheduledSendItem);
  const resetItem = useAdminMutation(api.admin.scheduledResetItem);

  const [filter, setFilter] = useState("All");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const withBusy = async (key: string, fn: () => Promise<unknown>, successMsg?: string) => {
    if (busy.has(key)) return;
    setBusy((prev) => new Set(prev).add(key));
    try {
      await fn();
      if (successMsg) toast.success(successMsg);
      refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  // ── Editor state ────────────────────────────────────────────────────────
  const [editing, setEditing] = useState<any | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("series");
  const [status, setStatus_] = useState("active");
  const [timezone, setTimezone] = useState("Asia/Baghdad");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [cadence, setCadence] = useState("daily");
  const [sendTime, setSendTime] = useState("20:00");
  const [intervalDays, setIntervalDays] = useState("3");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const [maxAttempts, setMaxAttempts] = useState("3");
  const [targetChatIds, setTargetChatIds] = useState<number[]>([]);
  const [bulkText, setBulkText] = useState("");
  const [draftItems, setDraftItems] = useState<DraftItem[]>([]);
  const [singleTitle, setSingleTitle] = useState("");
  const [singleText, setSingleText] = useState("");
  const [singleImage, setSingleImage] = useState("");

  const openNew = () => {
    setEditing(null);
    setName("");
    setKind("series");
    setStatus_("active");
    setTimezone("Asia/Baghdad");
    setStartAt("");
    setEndAt("");
    setCadence("daily");
    setSendTime("20:00");
    setIntervalDays("3");
    setWeekdays([1, 2, 3, 4, 5, 6, 7]);
    setMaxAttempts("3");
    setTargetChatIds([]);
    setBulkText("");
    setDraftItems([]);
    setSingleTitle("");
    setSingleText("");
    setSingleImage("");
    setOpen(true);
  };

  const openEdit = (c: any) => {
    const sched = c.schedule ?? {};
    setEditing(c);
    setName(c.name ?? "");
    setKind(c.kind ?? "series");
    setStatus_(c.status ?? "active");
    setTimezone(c.timezone ?? "Asia/Baghdad");
    setStartAt(toDatetimeLocal(c.startAt ?? c.start_at));
    setEndAt(toDatetimeLocal(c.endAt ?? c.end_at));
    setCadence(String(sched.cadence ?? sched.frequency ?? "daily"));
    setSendTime(String((sched.times ?? ["20:00"])[0] ?? "20:00"));
    setIntervalDays(String(sched.interval_days ?? "3"));
    setWeekdays(Array.isArray(sched.weekdays) ? (sched.weekdays as number[]) : [1, 2, 3, 4, 5, 6, 7]);
    setMaxAttempts(String(c.maxAttempts ?? c.max_attempts ?? 3));
    setTargetChatIds(Array.isArray(c.targetChatIds ?? c.target_chat_ids) ? (c.targetChatIds ?? c.target_chat_ids) : []);
    setBulkText("");
    setDraftItems([]);
    setSingleTitle("");
    setSingleText("");
    setSingleImage("");
    setOpen(true);
  };

  const itemsFor = (campaignId: string) =>
    (scheduled?.items ?? []).filter((i: any) => String(i.campaignId) === String(campaignId));

  const toggleWeekday = (iso: number) =>
    setWeekdays((prev) => (prev.includes(iso) ? prev.filter((w) => w !== iso) : [...prev, iso].sort((a, b) => a - b)));

  const addBulk = () => {
    const lines = bulkText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    const next = [...draftItems];
    for (const line of lines) {
      next.push({ key: `${Date.now()}-${next.length}`, title: "", text: line, imageUrl: "", scheduledFor: "" });
    }
    setDraftItems(next);
    setBulkText("");
    toast.success(`Added ${lines.length} part(s)`);
  };

  const scheduleConfig = (): Record<string, unknown> => {
    const times = sendTime.trim() ? [sendTime.trim()] : ["20:00"];
    if (kind === "series") {
      const base: Record<string, unknown> = { cadence, times };
      if (cadence === "selected_days") base.weekdays = weekdays;
      if (cadence === "custom") base.interval_days = Math.max(1, Number(intervalDays) || 1);
      return base;
    }
    // recurring
    const base: Record<string, unknown> = { frequency: cadence, times };
    if (cadence === "weekly") base.weekdays = weekdays;
    if (cadence === "custom") base.interval_days = Math.max(1, Number(intervalDays) || 1);
    return base;
  };

  const buildItems = (): Array<Record<string, unknown>> | undefined => {
    if (kind === "series") {
      if (draftItems.length === 0) return undefined;
      return draftItems.map((d) => ({
        title: d.title.trim() || null,
        text: d.text,
        imageUrl: d.imageUrl.trim() || null,
        scheduledFor: cadence === "manual" && d.scheduledFor ? new Date(d.scheduledFor).toISOString() : null,
      }));
    }
    if (!singleText.trim()) return undefined;
    return [
      {
        title: singleTitle.trim() || null,
        text: singleText,
        imageUrl: singleImage.trim() || null,
        scheduledFor: null,
      },
    ];
  };

  const onSave = async () => {
    if (!name.trim()) {
      toast.error("Give the campaign a name");
      return;
    }
    if (!startAt) {
      toast.error("Set a start date/time");
      return;
    }
    if (targetChatIds.length === 0) {
      toast.error("Pick at least one target chat");
      return;
    }
    const items = buildItems();
    if (kind === "series" && (!items || items.length === 0)) {
      toast.error("Import at least one part, or write one in the editor");
      return;
    }
    if (kind !== "series" && !items) {
      toast.error("Write the message content first");
      return;
    }
    await withBusy("save", async () => {
      const r = await saveCampaign({
        pin,
        ...(editing?._id ? { _id: editing._id } : {}),
        name: name.trim(),
        kind,
        status,
        timezone,
        startAt: new Date(startAt).toISOString(),
        endAt: endAt ? new Date(endAt).toISOString() : null,
        schedule: scheduleConfig(),
        targetChatIds,
        maxAttempts: Math.max(1, Number(maxAttempts) || 3),
        items,
      });
      // Editing an existing campaign → update its items one by one (new items
      // appended by the engine's insertItems are only for the create flow).
      if (editing?._id && items) {
        const existing = itemsFor(editing._id);
        for (let i = 0; i < items.length; i++) {
          const it = items[i] as Record<string, any>;
          const old = existing[i];
          if (old) {
            await saveItem({
              pin,
              _id: old._id,
              title: it.title,
              text: it.text,
              imageUrl: it.imageUrl,
              scheduledFor: it.scheduledFor,
              position: i + 1,
            });
          } else {
            await saveItem({ pin, campaignId: editing._id, title: it.title, text: it.text, imageUrl: it.imageUrl, scheduledFor: it.scheduledFor, position: i + 1 });
          }
        }
        // Remove leftover items beyond the new count (shrink).
        for (let i = items.length; i < existing.length; i++) {
          await deleteItem({ pin, _id: existing[i]._id });
        }
      }
      toast.success(r?.id ? "Campaign saved" : "Saved");
      setOpen(false);
    });
  };

  const swap = async (a: any, b: any) => {
    // Swap two adjacent items without tripping unique(campaign_id, position):
    // move A to a temp position first.
    await withBusy(`swap-${a._id}`, async () => {
      await saveItem({ pin, _id: a._id, position: 999999 });
      await saveItem({ pin, _id: b._id, position: a.position });
      await saveItem({ pin, _id: a._id, position: b.position });
    });
  };

  const move = (list: any[], item: any, dir: -1 | 1) => {
    const idx = list.findIndex((i) => String(i._id) === String(item._id));
    const other = list[idx + dir];
    if (!other) return;
    swap(item, other);
  };

  const campaigns = useMemo(() => {
    const list = scheduled?.campaigns ?? [];
    if (filter === "All") return list;
    if (["Series", "Recurring", "One-time"].includes(filter)) {
      const kindKey = filter === "One-time" ? "one_time" : filter.toLowerCase();
      return list.filter((c) => c.kind === kindKey);
    }
    return list.filter((c) => c.status === filter.toLowerCase());
  }, [scheduled, filter]);

  const chatTitle = (chatId: number) => {
    const c = (chats ?? []).find((x: any) => Number(x.chatId) === Number(chatId));
    return c?.title ?? `#${chatId}`;
  };

  const editable = kind === "series";
  const scheduleLabel = (c: any) => {
    const s = c.schedule ?? {};
    if (c.kind === "one_time") return c.startAt ? new Date(c.startAt).toLocaleString() : "—";
    if (c.kind === "recurring") {
      const f = String(s.frequency ?? "daily");
      const t = (s.times ?? ["20:00"])[0];
      return `${f === "custom" ? `Every ${s.interval_days ?? 3} day(s)` : f === "weekly" ? "Weekly" : "Daily"} at ${t}`;
    }
    const cad = String(s.cadence ?? "daily");
    const t = (s.times ?? ["20:00"])[0];
    if (cad === "selected_days") return `Selected days at ${t}`;
    if (cad === "custom") return `Every ${s.interval_days ?? 1} day(s) at ${t}`;
    if (cad === "manual") return "Manual dates";
    return `${cad === "weekly" ? "Weekly" : "Daily"} at ${t}`;
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      {/* ── Campaigns dashboard ─────────────────────────────────────── */}
      <Card
        icon={CalendarClock}
        id="campaigns"
        title="Campaigns"
        hint="Scheduled posts & series — sent by the dedicated engine every minute"
        action={
          <Button size="sm" variant="outline" className="h-8 gap-1 text-[11px]" onClick={openNew}>
            <Plus className="h-3.5 w-3.5" /> New campaign
          </Button>
        }
      >
        <div className="mb-3 flex flex-wrap gap-1.5">
          {["All", "Active", "Paused", "Completed", "Series", "Recurring", "One-time", "Failed"].map((f) => (
            <Pill key={f} label={f} active={filter === f} onClick={() => setFilter(f)} />
          ))}
        </div>

        {!scheduled ? (
          <p className="py-4 text-center text-[11px] text-muted-foreground">Loading campaigns…</p>
        ) : campaigns.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-6 text-center">
            <p className="text-xs text-muted-foreground">
              {filter === "All" ? "No campaigns yet — create your first scheduled post or series." : `Nothing in ${filter}.`}
            </p>
            {filter === "All" ? (
              <Button size="sm" className="mt-3 h-8 gap-1 text-[11px]" onClick={openNew}>
                <Plus className="h-3.5 w-3.5" /> New campaign
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            {campaigns.map((c: any) => {
              const st = STATUS_TONES[c.status] ?? { label: c.status, cls: "bg-muted text-muted-foreground" };
              const s = c.stats ?? {};
              const items = itemsFor(c._id);
              const nextSent = c.nextSendAt ?? c.next_send_at;
              return (
                <div key={String(c._id)} className="rounded-md border border-border bg-card/40 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-semibold text-foreground">{c.name}</span>
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          {KIND_LABELS[c.kind] ?? c.kind}
                        </Badge>
                        <Badge className={`shrink-0 text-[10px] ${st.cls}`}>{st.label}</Badge>
                      </div>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {scheduleLabel(c)} · {c.timezone} · → {(c.targetChatIds ?? c.target_chat_ids ?? []).map(chatTitle).join(", ") || "no chats"}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {c.kind === "recurring" ? (
                          <>
                            Next send: <span className="tabular-nums">{nextSent ? new Date(nextSent).toLocaleString() : "—"}</span>
                            {c.lastSentAt ? <> · Last: {new Date(c.lastSentAt).toLocaleString()}</> : null}
                          </>
                        ) : (
                          <>
                            {s.sent ?? 0} sent · {s.pending ?? 0} remaining · {s.failed ?? 0} failed{s.skipped ? ` · ${s.skipped} skipped` : ""}
                            {nextSent ? <> · Next: <span className="tabular-nums">{new Date(nextSent).toLocaleString()}</span></> : null}
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      {c.status === "active" ? (
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]" disabled={busy.has(`st-${c._id}`)} onClick={() => withBusy(`st-${c._id}`, () => setStatus({ pin, _id: c._id, status: "paused" }), "Paused")}>
                          <CirclePause className="h-3 w-3" /> Pause
                        </Button>
                      ) : c.status === "paused" ? (
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]" disabled={busy.has(`st-${c._id}`)} onClick={() => withBusy(`st-${c._id}`, () => setStatus({ pin, _id: c._id, status: "active" }), "Resumed")}>
                          <Play className="h-3 w-3" /> Resume
                        </Button>
                      ) : null}
                      {c.status === "active" && (s.pending ?? 0) > 0 ? (
                        <>
                          <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]" disabled={busy.has(`skip-${c._id}`)} onClick={() => withBusy(`skip-${c._id}`, () => skipNext({ pin, campaignId: c._id }), "Skipped next part")}>
                            <SkipForward className="h-3 w-3" /> Skip next
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]" disabled={busy.has(`send-${c._id}`)} onClick={() => withBusy(`send-${c._id}`, () => sendNext({ pin, campaignId: c._id }), "Next part queued — sends within a minute")}>
                            <Send className="h-3 w-3" /> Send next
                          </Button>
                        </>
                      ) : null}
                      <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]" onClick={() => openEdit(c)}>
                        <Pencil className="h-3 w-3" /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-[10px] text-destructive hover:bg-destructive/10"
                        disabled={busy.has(`del-${c._id}`)}
                        onClick={() => {
                          if (!confirm(`Delete campaign "${c.name}" and all ${items.length} part(s)?`)) return;
                          withBusy(`del-${c._id}`, () => deleteCampaign({ pin, _id: c._id }), "Campaign deleted");
                        }}
                      >
                        <Trash2 className="h-3 w-3" /> Delete
                      </Button>
                    </div>
                  </div>

                  {open && editing?._id === c._id ? (
                    <div className="mt-3 rounded-md border border-primary/25 bg-primary/5 px-3 py-2">
                      <p className="text-[10px] text-muted-foreground">Editing this campaign — the editor below is open.</p>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ── Editor ──────────────────────────────────────────────────── */}
      {open ? (
        <Card
          icon={editing ? Pencil : Plus}
          title={editing ? `Edit: ${editing.name}` : "New campaign"}
          hint="Series parts advance one by one on schedule; failed parts auto-skip after max attempts"
          action={
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => setOpen(false)} title="Close">
              <X className="h-4 w-4" />
            </Button>
          }
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <CompactInput label="Campaign name" value={name} onChange={setName} placeholder="e.g. Seerah Series — 30 Parts" />
            <CompactSelect
              label="Type"
              value={kind}
              onChange={setKind}
              options={[
                { value: "series", label: "Series (ordered parts, e.g. 30 Seerah parts)" },
                { value: "recurring", label: "Recurring (same post daily / weekly / custom)" },
                { value: "one_time", label: "One-time (single post at a date & time)" },
              ]}
            />
            <CompactSelect
              label="Status"
              value={status}
              onChange={setStatus_}
              options={[
                { value: "active", label: "Active (sends on schedule)" },
                { value: "paused", label: "Paused (hold until resumed)" },
              ]}
            />
            <CompactSelect
              label="Timezone"
              value={timezone}
              onChange={setTimezone}
              options={TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
            />
            <CompactInput label="Start date & time (local browser time)" value={startAt} onChange={setStartAt} type="datetime-local" />
            {kind !== "one_time" ? <CompactInput label="End date & time (optional)" value={endAt} onChange={setEndAt} type="datetime-local" /> : <div />}

            {kind === "series" ? (
              <CompactSelect
                label="Cadence"
                value={cadence}
                onChange={setCadence}
                options={[
                  { value: "daily", label: "Daily" },
                  { value: "weekly", label: "Weekly" },
                  { value: "selected_days", label: "Selected weekdays" },
                  { value: "custom", label: "Custom interval (days)" },
                  { value: "manual", label: "Manual dates per part" },
                ]}
              />
            ) : (
              <CompactSelect
                label="Frequency"
                value={cadence}
                onChange={setCadence}
                options={[
                  { value: "daily", label: "Daily" },
                  { value: "weekly", label: "Weekly" },
                  { value: "custom", label: "Custom interval (days)" },
                ]}
              />
            )}
            <CompactInput label="Send time (HH:MM, campaign timezone)" value={sendTime} onChange={setSendTime} placeholder="20:00" />
            {cadence === "custom" ? <CompactInput label="Interval (days)" value={intervalDays} onChange={setIntervalDays} type="number" min={1} /> : <div />}
            <CompactInput label="Max attempts before auto-skip" value={maxAttempts} onChange={setMaxAttempts} type="number" min={1} hint="A part that fails this many times is marked failed and the series advances" />
          </div>

          {cadence === "selected_days" || (kind === "recurring" && cadence === "weekly") ? (
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Send on</p>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((d) => (
                  <button
                    key={d.iso}
                    type="button"
                    onClick={() => toggleWeekday(d.iso)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      weekdays.includes(d.iso) ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-3">
            <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Target chats</p>
            <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
              {(chats ?? []).length === 0 ? (
                <p className="text-[11px] text-muted-foreground">No chats configured — add bots/chats in the Telegram tab first.</p>
              ) : (
                (chats ?? []).map((c: any) => {
                  const id = Number(c.chatId);
                  const on = targetChatIds.includes(id);
                  return (
                    <button
                      key={String(c.chatId)}
                      type="button"
                      onClick={() => setTargetChatIds((prev) => (on ? prev.filter((x) => x !== id) : [...prev, id]))}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"
                      }`}
                    >
                      {c.title ?? `#${c.chatId}`}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="mt-4">
            <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
              {editable ? "Parts / sequence" : "Message content"}
            </p>
            {editable ? (
              <>
                <div className="flex gap-2">
                  <textarea
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    rows={3}
                    placeholder={"Paste many parts at once — one part per line. They are auto-numbered in order:\nPart 1: In the name of Allah...\nPart 2: The Prophet's early life...\n..."}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:ring-primary/20 resize-y font-mono"
                  />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" variant="outline" className="h-8 gap-1 text-[11px]" onClick={addBulk} disabled={!bulkText.trim()}>
                    <ListOrdered className="h-3.5 w-3.5" /> Add to sequence
                  </Button>
                  <span className="text-[10px] text-muted-foreground">{draftItems.length} part(s) staged{editing ? " · edits below apply to existing parts" : ""}</span>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <CompactInput label="Title (optional)" value={singleTitle} onChange={setSingleTitle} placeholder="Part heading — appears bold above the text" />
                <CompactInput label="Image URL (optional)" value={singleImage} onChange={setSingleImage} placeholder="https://…" />
              </div>
            )}
            {editable ? (
              <div className="mt-3 space-y-2">
                {draftItems.length === 0 && !editing ? (
                  <p className="text-[11px] text-muted-foreground">No parts yet — paste above or add one below.</p>
                ) : null}
                {draftItems.map((d, idx) => (
                  <div key={d.key} className="rounded-md border border-border bg-card/40 p-2">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-muted-foreground">#{idx + 1}</span>
                      <input
                        value={d.title}
                        onChange={(e) => setDraftItems((prev) => prev.map((x) => (x.key === d.key ? { ...x, title: e.target.value } : x)))}
                        placeholder="Title (optional)"
                        className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-[11px] text-foreground focus:border-primary"
                      />
                      <input
                        value={d.imageUrl}
                        onChange={(e) => setDraftItems((prev) => prev.map((x) => (x.key === d.key ? { ...x, imageUrl: e.target.value } : x)))}
                        placeholder="Image URL"
                        className="h-7 w-36 rounded-md border border-input bg-background px-2 text-[11px] text-foreground focus:border-primary"
                      />
                      {cadence === "manual" ? (
                        <input
                          type="datetime-local"
                          value={d.scheduledFor}
                          onChange={(e) => setDraftItems((prev) => prev.map((x) => (x.key === d.key ? { ...x, scheduledFor: e.target.value } : x)))}
                          className="h-7 rounded-md border border-input bg-background px-2 text-[11px] text-foreground focus:border-primary"
                        />
                      ) : null}
                      <div className="flex shrink-0 gap-0.5">
                        <button type="button" title="Move up" disabled={idx === 0} onClick={() => setDraftItems((prev) => swapArr(prev, idx, -1))} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30">
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" title="Move down" disabled={idx === draftItems.length - 1} onClick={() => setDraftItems((prev) => swapArr(prev, idx, 1))} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30">
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" title="Remove" onClick={() => setDraftItems((prev) => prev.filter((x) => x.key !== d.key))} className="p-1 text-muted-foreground hover:text-destructive">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <textarea
                      value={d.text}
                      onChange={(e) => setDraftItems((prev) => prev.map((x) => (x.key === d.key ? { ...x, text: e.target.value } : x)))}
                      rows={2}
                      className="mt-1.5 w-full rounded-md border border-input bg-background px-2 py-1.5 text-[11px] text-foreground focus:border-primary resize-y font-mono"
                    />
                  </div>
                ))}
                {editable ? (
                  <button
                    type="button"
                    onClick={() => setDraftItems((prev) => [...prev, { key: `${Date.now()}-${prev.length}`, title: "", text: "", imageUrl: "", scheduledFor: "" }])}
                    className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground hover:border-primary/40 hover:text-primary"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add a part
                  </button>
                ) : null}
              </div>
            ) : (
              <textarea
                value={singleText}
                onChange={(e) => setSingleText(e.target.value)}
                rows={5}
                placeholder="The message content — sent exactly as written (HTML formatting like <b>bold</b> is allowed)."
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:ring-primary/20 resize-y"
              />
            )}
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" className="h-8 gap-1 text-[11px]" onClick={onSave} disabled={busy.has("save")}>
              {busy.has("save") ? "Saving…" : <><CheckCircle2 className="h-3.5 w-3.5" /> Save campaign</>}
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {editing ? (
              <span className="text-[10px] text-muted-foreground">Editing an existing campaign updates the header + all parts in place.</span>
            ) : (
              <span className="text-[10px] text-muted-foreground">
                {editable ? `Series: Part 1 → ${startAt ? new Date(startAt).toLocaleString() : "start"}, then one part per ${scheduleCadenceLabel()}.` : "First send at the start date/time."}
              </span>
            )}
          </div>
        </Card>
      ) : null}

      {/* ── Sequence / parts of the edited campaign (existing) ───────── */}
      {editing && !open ? (
        <Card icon={ListOrdered} title={`Parts — ${editing.name}`} hint="Existing parts in send order. Edit text, reorder, send now, or reset a failed part.">
          {itemsFor(editing._id).length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No parts yet — open Edit to add content.</p>
          ) : (
            <div className="space-y-1.5">
              {itemsFor(editing._id).map((it: any, idx: number, arr: any[]) => (
                <div key={String(it._id)} className="rounded-md border border-border bg-card/40 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-muted-foreground">#{it.position}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{it.title || it.text}</span>
                    <Badge
                      className={`shrink-0 text-[10px] ${
                        it.status === "sent"
                          ? "bg-healthy/10 text-healthy"
                          : it.status === "failed"
                            ? "bg-destructive/10 text-destructive"
                            : it.status === "skipped"
                              ? "bg-muted text-muted-foreground"
                              : "bg-info/10 text-info"
                      }`}
                    >
                      {it.status}
                    </Badge>
                    {it.attempts > 0 ? <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{it.attempts}×</span> : null}
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button type="button" title="Send now" disabled={busy.has(`si-${it._id}`)} onClick={() => withBusy(`si-${it._id}`, () => sendItem({ pin, _id: it._id }), "Queued — sends within a minute")} className="p-1 text-muted-foreground hover:text-primary disabled:opacity-30">
                        <Send className="h-3.5 w-3.5" />
                      </button>
                      {it.status === "failed" || it.status === "skipped" ? (
                        <button type="button" title="Reset to pending (retry)" disabled={busy.has(`ri-${it._id}`)} onClick={() => withBusy(`ri-${it._id}`, () => resetItem({ pin, _id: it._id }), "Reset to pending")} className="p-1 text-muted-foreground hover:text-primary disabled:opacity-30">
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                      <button type="button" title="Move up" disabled={idx === 0} onClick={() => move(arr, it, -1)} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30">
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" title="Move down" disabled={idx === arr.length - 1} onClick={() => move(arr, it, 1)} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30">
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Delete part"
                        disabled={busy.has(`di-${it._id}`)}
                        onClick={() => {
                          if (!confirm("Delete this part?")) return;
                          withBusy(`di-${it._id}`, () => deleteItem({ pin, _id: it._id }), "Part deleted");
                        }}
                        className="p-1 text-muted-foreground hover:text-destructive disabled:opacity-30"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {it.error ? <p className="mt-1 truncate text-[10px] text-destructive/80" title={String(it.error)}>{String(it.error)}</p> : null}
                  {it.sentAt ? <p className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">Sent {new Date(it.sentAt).toLocaleString()}</p> : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}

      {/* ── Delivery history ───────────────────────────────────────── */}
      <Card icon={History} title="Delivery history" hint="Recent sends per part × chat (ok / failed)" className="sm:col-span-1">
        {!scheduled ? (
          <p className="text-[11px] text-muted-foreground">Loading…</p>
        ) : scheduled.log.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Nothing sent yet — history fills as the engine delivers parts.</p>
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {scheduled.log.map((l: any, i: number) => (
              <div key={l._id ?? i} className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-[10px]">
                <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-bold ${l.ok ? "bg-healthy/10 text-healthy" : "bg-destructive/10 text-destructive"}`}>
                  {l.ok ? "ok" : "fail"}
                </span>
                <span className="truncate font-medium text-foreground">
                  {(() => {
                    const c = (scheduled.campaigns ?? []).find((x: any) => String(x._id) === String(l.campaignId));
                    return c?.name ?? "campaign";
                  })()}
                </span>
                <span className="truncate text-muted-foreground">→ {chatTitle(l.chatId)}</span>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{new Date(l.sentAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );

  function swapArr<T>(arr: T[], idx: number, dir: -1 | 1): T[] {
    const next = [...arr];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return next;
    [next[idx], next[j]] = [next[j], next[idx]!];
    return next;
  }

  function scheduleCadenceLabel(): string {
    if (cadence === "selected_days") return "selected day";
    if (cadence === "custom") return `${Math.max(1, Number(intervalDays) || 1)} days`;
    if (cadence === "manual") return "its manual date";
    return cadence === "weekly" ? "week" : "day";
  }
}
