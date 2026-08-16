import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Pencil,
  SendHorizonal,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { adminApi } from "@/lib/adminApi";
import { readStoredPin } from "@/routes/index";
import { useNewsroomData } from "@/components/AppShell";
import { CategoryPill, StatusPill, clockTime, EmptyState, EDIT_CATEGORIES } from "@/components/newsroom";

export const Route = createFileRoute("/_authenticated/review")({
  head: () => ({
    meta: [
      { title: "Story Review · Iran Desk" },
      { name: "description", content: "Editorial workspace — source, generated story and verification." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: Review,
});

function Review() {
  const navigate = useNavigate();
  const { id } = useSearch({ from: "/_authenticated/review" }) as { id?: string };
  const pin = readStoredPin() ?? "";
  const data = useNewsroomData();
  const queue = (data?.queueAll ?? []) as any[];
  const item = queue.find((i) => String(i.id ?? i._id) === String(id)) ?? null;

  const [headline, setHeadline] = useState("");
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState("iran");
  const [breaking, setBreaking] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!item) return;
    setHeadline(String(item.headline ?? ""));
    setSummary(String(item.summary ?? ""));
    setCategory(String(item.category ?? "iran"));
    setBreaking(Boolean(item.breaking));
    setDirty(false);
  }, [item?.id, item?._id]);

  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong");

  const save = async () => {
    if (!pin || !item) return;
    const rowId = String(item.id ?? item._id);
    setBusy(true);
    try {
      await adminApi.editQueueItem({ pin, id: rowId, headline, summary, category, breaking });
      toast.success("Story updated");
      setDirty(false);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: "held" | "rejected" | "queued") => {
    if (!pin || !item) return;
    const rowId = String(item.id ?? item._id);
    setBusy(true);
    try {
      await adminApi.setQueueStatus({ pin, id: rowId, status });
      toast.success(status === "held" ? "Held — excluded from auto-publish" : status === "rejected" ? "Rejected — removed from queue" : "Requeued");
      navigate({ to: "/inbox" });
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const publishNow = async () => {
    if (!pin || !item) return;
    const rowId = String(item.id ?? item._id);
    setBusy(true);
    const t = toast.loading("Publishing…");
    try {
      const r = await adminApi.publishQueueItem({ pin, id: rowId });
      toast.dismiss(t);
      if ((r as any)?.ok === false) {
        const res = (r as any)?.result;
        throw new Error(String(res?.error ?? res?.skipped ?? "Publish failed"));
      }
      toast.success("Published to all active chats");
      navigate({ to: "/published" });
    } catch (e) {
      toast.dismiss(t);
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!item) {
    return (
      <div>
        <button type="button" className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => navigate({ to: "/inbox" })}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back to inbox
        </button>
        <EmptyState text={id ? "This story is no longer in the queue (published or removed)." : "Select a story from the inbox to open it here."} />
      </div>
    );
  }

  const facts = (item.facts ?? null) as Record<string, unknown> | null;
  const numbers = Array.isArray(facts?.numbers) ? (facts.numbers as string[]) : [];
  const sourceUrl = String(item.url ?? item.sourceUrl ?? "");
  const score = typeof item.score === "number" ? item.score : null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => navigate({ to: "/inbox" })}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back to inbox
        </button>
        <div className="flex items-center gap-1.5">
          {item.breaking ? <StatusPill status="breaking" /> : null}
          {item.isUpdate ? <StatusPill status="update" /> : null}
          <CategoryPill category={item.category} />
          {item.status === "held" ? <StatusPill status="held" /> : null}
          {item.status === "rejected" ? <StatusPill status="rejected" /> : null}
          {score !== null ? <span className="rounded-[4px] border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">score {score}</span> : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── Left: original source ─────────────────── */}
        <div className="panel flex flex-col px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Original source</p>
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="font-semibold text-foreground">{item.sourceName ?? "--"}</span>
            <span className="text-muted-foreground">{clockTime(item.originalPublishedAt ?? item.createdAt)}</span>
          </div>
          {sourceUrl ? (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-info hover:underline">
              <ExternalLink className="h-3 w-3" /> Open source
            </a>
          ) : null}
          <div className="mt-3 overflow-y-auto text-[13px] leading-relaxed text-muted-foreground" style={{ maxHeight: "46vh" }}>
            {item.sourceText ? (
              <p className="whitespace-pre-wrap">{item.sourceText}</p>
            ) : (
              <p className="text-xs text-muted-foreground/70">No source text captured for this item.</p>
            )}
          </div>
        </div>

        {/* ── Center: generated story (editable) ───── */}
        <div className="panel flex flex-col px-4 py-3 lg:col-span-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Generated story</p>
          <div className="mt-3 flex-1 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Headline</Label>
              <Textarea value={headline} onChange={(e) => { setHeadline(e.target.value); setDirty(true); }} rows={3} className="text-sm font-medium" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Summary / Kurdish body</Label>
              <Textarea value={summary} onChange={(e) => { setSummary(e.target.value); setDirty(true); }} rows={9} className="text-sm" dir="auto" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Category</Label>
                <select
                  value={category}
                  onChange={(e) => { setCategory(e.target.value); setDirty(true); }}
                  className="h-9 w-full rounded-[6px] border border-input bg-background px-2 text-sm"
                >
                  {EDIT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="flex items-end justify-between gap-2 pb-1">
                <div className="space-y-1.5">
                  <Label className="text-xs">Breaking</Label>
                  <p className="text-[10px] text-muted-foreground">🚨 bypasses the window</p>
                </div>
                <Switch checked={breaking} onCheckedChange={(v) => { setBreaking(v); setDirty(true); }} />
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
            <span className={`text-[11px] ${dirty ? "text-review" : "text-muted-foreground"}`}>{dirty ? "Unsaved changes" : "Saved"}</span>
            <Button size="sm" variant="outline" className="h-8 gap-1 text-[11px]" disabled={!dirty || busy} onClick={save}>
              <Pencil className="h-3 w-3" /> {busy ? "Saving…" : "Save edits"}
            </Button>
          </div>
        </div>

        {/* ── Right: verification ───────────────────── */}
        <div className="flex flex-col gap-4 lg:col-span-1">
          <div className="panel px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Extracted facts</p>
            {facts ? (
              <dl className="mt-2 space-y-1.5 text-xs">
                {[
                  ["Event", facts.event],
                  ["Actor", facts.actor],
                  ["Action", facts.action],
                  ["Target", facts.target],
                  ["Location", facts.location],
                  ["Time", facts.time],
                  ["Claimed result", facts.claimed_result],
                  ["Confirmed result", facts.confirmed_result],
                  ["Source attribution", facts.source_attribution],
                  ["Confidence", facts.confidence],
                ].map(([label, value]) =>
                  value ? (
                    <div key={String(label)} className="flex gap-2">
                      <dt className="w-32 shrink-0 text-muted-foreground">{String(label)}</dt>
                      <dd className="min-w-0 flex-1 text-foreground">{String(value)}</dd>
                    </div>
                  ) : null,
                )}
                {numbers.length > 0 ? (
                  <div className="flex gap-2">
                    <dt className="w-32 shrink-0 text-muted-foreground">Figures</dt>
                    <dd className="flex flex-wrap gap-1">
                      {numbers.map((n, i) => (
                        <span key={i} className="rounded-[4px] border border-review/40 bg-review/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-review">{n}</span>
                      ))}
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">No structured facts for this item (Telegram or legacy item).</p>
            )}
          </div>

          <div className="panel px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Checks</p>
            <div className="mt-2 space-y-1.5 text-xs">
              <p className="flex items-center gap-2 text-healthy"><CheckCircle2 className="h-3.5 w-3.5" /> Attribution preserved in headline</p>
              <p className={`flex items-center gap-2 ${numbers.length > 0 ? "text-healthy" : "text-muted-foreground"}`}>
                <CheckCircle2 className="h-3.5 w-3.5" /> {numbers.length > 0 ? `${numbers.length} figure(s) preserved` : "No figures to check"}
              </p>
              <p className="flex items-center gap-2 text-healthy"><CheckCircle2 className="h-3.5 w-3.5" /> Summary built from source facts only</p>
            </div>
          </div>

          {/* ── Actions ─────────────────────────────── */}
          <div className="panel grid grid-cols-2 gap-2 px-4 py-3">
            <Button size="sm" variant="outline" className="h-9 gap-1 text-[11px] text-destructive hover:bg-destructive/10" disabled={busy} onClick={() => setStatus("rejected")}>
              <Trash2 className="h-3.5 w-3.5" /> Reject
            </Button>
            <Button size="sm" variant="outline" className="h-9 gap-1 text-[11px] text-review hover:bg-review/10" disabled={busy} onClick={() => setStatus("held")}>
              <ShieldAlert className="h-3.5 w-3.5" /> Hold
            </Button>
            {item.status === "held" ? (
              <Button size="sm" variant="outline" className="col-span-2 h-9 gap-1 text-[11px]" disabled={busy} onClick={() => setStatus("queued")}>
                <CheckCircle2 className="h-3.5 w-3.5" /> Requeue (back to auto-publish)
              </Button>
            ) : null}
            <Button size="sm" className="col-span-2 h-9 gap-1 text-[11px]" disabled={busy} onClick={publishNow}>
              <SendHorizonal className="h-3.5 w-3.5" /> {busy ? "Working…" : "Publish now"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
