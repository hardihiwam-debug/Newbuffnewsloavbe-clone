import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { GitBranch, Radio } from "lucide-react";
import { useNewsroomData } from "@/components/AppShell";
import { CategoryPill, SectionTitle, StatusPill, EmptyState, clockTime, relTime } from "@/components/newsroom";

export const Route = createFileRoute("/_authenticated/events")({
  head: () => ({
    meta: [
      { title: "Events · Iran Desk" },
      { name: "description", content: "Developing events and their timelines." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: Events,
});

function Events() {
  const data = useNewsroomData();
  const clusters = (data?.clusters ?? []) as any[];
  const queueAll = (data?.queueAll ?? []) as any[];
  const history = (data?.history ?? []) as any[];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Timeline = queue + published rows that share the cluster's event_id.
  const timeline = (eventId: string) => {
    const rows: Array<{ kind: "queued" | "published"; item: any; at: string }> = [];
    for (const q of queueAll) {
      if (String(q.eventId ?? q.event_id ?? "") === eventId) rows.push({ kind: "queued", item: q, at: q.createdAt ?? q.originalPublishedAt ?? "" });
    }
    for (const h of history) {
      if (String(h.eventId ?? h.event_id ?? "") === eventId) rows.push({ kind: "published", item: h, at: h.publishedAt ?? h.createdAt ?? "" });
    }
    return rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  };

  const selected = clusters.find((c) => String(c.id ?? c._id) === selectedId) ?? null;

  if (clusters.length === 0) {
    return (
      <div>
        <SectionTitle eyebrow="Developing stories" title="Events" hint="Cross-outlet event clusters the pipeline is tracking." />
        <EmptyState icon={<GitBranch className="h-5 w-5" />} text="No active events right now — clusters appear as the pipeline groups coverage of the same story." />
      </div>
    );
  }

  return (
    <div>
      <SectionTitle eyebrow="Developing stories" title="Events" hint="Cross-outlet event clusters — click one for its timeline." />
      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Event list ────────────────────────────── */}
        <div className="space-y-2">
          {clusters.slice(0, 40).map((c: any) => {
            const active = String(c.id ?? c._id) === selectedId;
            const posts = Number(c.postCount ?? 1);
            const t = timeline(String(c.eventId ?? c.event_id ?? ""));
            const hours = c.lastSeenAt ? Math.max(0, Math.round((Date.now() - Date.parse(c.lastSeenAt)) / 3_600_000)) : null;
            return (
              <button
                key={c.id ?? c._id}
                type="button"
                onClick={() => setSelectedId(active ? null : String(c.id ?? c._id))}
                className={`panel-hover block w-full px-4 py-3 text-left transition-colors ${active ? "border-primary/60" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${hours !== null && hours <= 6 ? "bg-healthy" : "bg-review"}`} />
                  <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{c.label ?? c.lastHeadline ?? "Untitled event"}</p>
                  {c.category ? <CategoryPill category={c.category} /> : null}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span>{posts} post{posts === 1 ? "" : "s"}</span>
                  <span>{t.length} timeline item{t.length === 1 ? "" : "s"}</span>
                  {hours !== null ? <span>{hours}h ago</span> : null}
                  {c.lastHeadline ? <span className="truncate text-muted-foreground/70">last: {c.lastHeadline}</span> : null}
                </div>
              </button>
            );
          })}
        </div>

        {/* ── Timeline ──────────────────────────────── */}
        <div>
          {selected ? (
            <div className="panel px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Timeline</p>
              <h2 className="mt-1 text-[15px] font-bold leading-snug text-foreground">{selected.label ?? selected.lastHeadline ?? "Event"}</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {String(selected.eventId ?? selected.event_id ?? "").slice(0, 48)}
                {selected.firstSeenAt ? ` · first seen ${relTime(selected.firstSeenAt)}` : ""}
              </p>
              <div className="mt-3 space-y-0">
                {timeline(String(selected.eventId ?? selected.event_id ?? "")).map((row, idx) => {
                  const it = row.item;
                  return (
                    <div key={`${row.kind}-${it.id ?? it._id ?? idx}`} className="relative flex gap-3 pb-3 pl-4">
                      <span className={`absolute left-0 top-1.5 h-1.5 w-1.5 rounded-full ${row.kind === "published" ? "bg-healthy" : "bg-info"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusPill status={row.kind === "published" ? "published" : it.breaking ? "breaking" : it.isUpdate ? "update" : "queued"} />
                          <span className="text-[10px] tabular-nums text-muted-foreground">{clockTime(row.at)}</span>
                        </div>
                        <p className="mt-1 text-[13px] font-medium leading-snug text-foreground">{it.headline ?? it.englishHeadline ?? ""}</p>
                        <p className="text-[11px] text-muted-foreground">{it.sourceName ?? "--"}</p>
                      </div>
                    </div>
                  );
                })}
                {timeline(String(selected.eventId ?? selected.event_id ?? "")).length === 0 ? (
                  <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                    <Radio className="h-3.5 w-3.5" /> No queue/published rows carry this event id yet — the cluster was created by the pipeline's event matcher.
                  </p>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-40 items-center justify-center rounded-[6px] border border-dashed border-border px-6 py-10 text-center">
              <p className="text-xs text-muted-foreground">Select an event to see its timeline.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
