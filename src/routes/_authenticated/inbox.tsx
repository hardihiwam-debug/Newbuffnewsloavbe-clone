import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Inbox as InboxIcon, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { adminApi } from "@/lib/adminApi";
import { readStoredPin } from "@/routes/index";
import { useNewsroomData } from "@/components/AppShell";
import {
  EmptyState,
  SectionTitle,
  StoryCard,
  StatusPill,
  EditQueueItemDialog,
  clockTime,
} from "@/components/newsroom";

export const Route = createFileRoute("/_authenticated/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox · Iran Desk" },
      { name: "description", content: "Editorial queue — what needs your decision." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: Inbox,
});

type Tab = "ALL" | "REVIEW" | "READY" | "HELD" | "FAILED";

function Inbox() {
  const navigate = useNavigate();
  const pin = readStoredPin() ?? "";
  const data = useNewsroomData();
  const [tab, setTab] = useState<Tab>("ALL");
  const [editing, setEditing] = useState<any | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());

  const queue = ((data?.queueAll ?? []) as any[]).filter(
    (i) =>
      !["published"].includes(String(i.status ?? "")) &&
      !removedIds.has(String(i.id ?? i._id)),
  );
  const activity = (data?.recentActivity ?? []) as any[];
  const translationFailures = (data?.translationFailures ?? []) as any[];

  const byTab = (tab: Tab): any[] => {
    switch (tab) {
      case "REVIEW":
        return queue.filter((i) => Boolean(i.breaking) || Boolean(i.isUpdate));
      case "READY":
        return queue.filter(
          (i) =>
            String(i.status ?? "queued") === "queued" &&
            !Boolean(i.breaking) &&
            !Boolean(i.isUpdate),
        );
      case "HELD":
        return queue.filter((i) => String(i.status ?? "") === "held");
      case "FAILED":
        return queue.filter((i) => String(i.status ?? "") === "rejected");
      default:
        return queue;
    }
  };

  const counts: Record<Tab, number> = {
    ALL: queue.length,
    REVIEW: byTab("REVIEW").length,
    READY: byTab("READY").length,
    HELD: byTab("HELD").length,
    FAILED: byTab("FAILED").length,
  };

  const failEvents = activity.filter(
    (a) => a.level === "error" || (a.level === "warning" && a.type !== "source"),
  ).slice(0, 12);

  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong");

  const setStatus = async (item: any, status: "held" | "rejected" | "queued") => {
    if (!pin) return;
    const id = String(item.id ?? item._id);
    setBusyId(id);
    try {
      await adminApi.setQueueStatus({ pin, id, status });
      toast.success(status === "rejected" ? "Rejected — removed from the queue" : status === "held" ? "Held for review" : "Requeued");
    } catch (e) {
      onError(e);
    } finally {
      setBusyId(null);
    }
  };

  const deleteItem = async (item: any) => {
    if (!pin) return;
    const id = String(item.id ?? item._id);
    // Remove immediately so the swipe doesn't leave a dead row on screen;
    // re-add it only if the server delete fails.
    setRemovedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      await adminApi.deleteQueueItem({ pin, id });
      toast.success("Deleted");
    } catch (e) {
      setRemovedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      onError(e);
    }
  };

  const publishNow = async (item: any) => {
    if (!pin) return;
    const id = String(item.id ?? item._id);
    setBusyId(id);
    const t = toast.loading("Publishing…");
    try {
      const r = await adminApi.publishQueueItem({ pin, id });
      toast.dismiss(t);
      if ((r as any)?.ok === false) {
        const res = (r as any)?.result;
        throw new Error(String(res?.error ?? res?.skipped ?? "Publish failed"));
      }
      toast.success("Published to all active chats");
    } catch (e) {
      toast.dismiss(t);
      onError(e);
    } finally {
      setBusyId(null);
    }
  };

  const items = byTab(tab);

  return (
    <div>
      <SectionTitle
        eyebrow="Editorial queue"
        title="Inbox"
        hint="What the bot has surfaced — decide, edit, hold or publish."
        action={
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[11px]" onClick={() => setTab("ALL")}>
            <InboxIcon className="h-3.5 w-3.5" /> Refresh list
          </Button>
        }
      />

      {/* Tabs */}
      <div className="mb-4 flex flex-wrap gap-1">
        {(["ALL", "REVIEW", "READY", "HELD", "FAILED"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {t}
            <span className={`ml-1.5 tabular-nums ${tab === t ? "text-primary-foreground/80" : "text-muted-foreground/70"}`}>
              {counts[t]}
            </span>
          </button>
        ))}
      </div>

      {/* FAILED tab also surfaces live failure events */}
      {tab === "FAILED" ? (
        <div className="mb-4 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Rejected items · {counts.FAILED}
          </p>
          {counts.FAILED === 0 ? (
            <div className="flex items-center gap-2 rounded-[6px] border border-healthy/30 bg-healthy/10 px-3 py-2 text-xs text-healthy">
              <CheckCircle2 className="h-3.5 w-3.5" /> No rejected items.
            </div>
          ) : null}
          {failEvents.length > 0 ? (
            <>
              <p className="pt-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Recent operational failures
              </p>
              <div className="space-y-1.5">
                {failEvents.map((a, i) => (
                  <div key={a.id ?? i} className="flex items-start gap-2.5 rounded-[6px] border border-destructive/25 bg-destructive/10 px-3 py-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-foreground">{a.message}</p>
                      {a.detail ? <p className="truncate text-[10px] text-muted-foreground">{a.detail}</p> : null}
                    </div>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{clockTime(a.createdAt)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {translationFailures.length > 0 ? (
            <>
              <p className="pt-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Translation failures · {translationFailures.length} recent
              </p>
              <div className="space-y-1.5">
                {translationFailures.slice(0, 6).map((f, i) => (
                  <div key={f.id ?? i} className="rounded-[6px] border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs">
                    <p className="truncate font-medium text-destructive">{f.detail ?? f.headline ?? "Translation failed"}</p>
                    <p className="truncate text-[10px] text-muted-foreground">{f.headline}</p>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {/* List */}
      <div className="space-y-2">
        {items.length === 0 ? (
          <EmptyState icon={<InboxIcon className="h-5 w-5" />} text={tab === "ALL" ? "Queue is empty — the bot is caught up." : `Nothing in ${tab}.`} />
        ) : (
          items.map((item: any) => {
            const id = String(item.id ?? item._id);
            return (
              <StoryCard
                key={id}
                item={item}
                busy={busyId === id}
                onReview={(it) => navigate({ to: "/review", search: { id: String(it.id ?? it._id) } })}
                onEdit={setEditing}
                onPublish={() => publishNow(item)}
                onReject={() => setStatus(item, "rejected")}
                onDelete={() => deleteItem(item)}
              />
            );
          })
        )}
      </div>

      {items.length > 0 ? (
        <div className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground">
          <StatusPill status="breaking" /> breaking needs review · <StatusPill status="update" /> follow-up updates · held items are excluded from auto-publish
        </div>
      ) : null}

      <EditQueueItemDialog item={editing} pin={pin} onClose={() => setEditing(null)} />
    </div>
  );
}
