import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { RadioTower } from "lucide-react";
import { useNewsroomData } from "@/components/AppShell";
import { SectionTitle, EmptyState, relTime } from "@/components/newsroom";

export const Route = createFileRoute("/_authenticated/sources")({
  head: () => ({
    meta: [
      { title: "Sources · Iran Desk" },
      { name: "description", content: "Source monitoring — where information comes from." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: Sources,
});

function Sources() {
  const data = useNewsroomData();
  const sources = (data?.sources ?? []) as any[];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = sources.find((s) => String(s.id ?? s._id) === selectedId) ?? null;

  const health = (src: any): { state: "healthy" | "degraded" | "down"; label: string } => {
    if (src.autoPaused || Number(src.consecutiveFailures ?? 0) >= 3) return { state: "down", label: "Failing" };
    if (src.lastError || Number(src.consecutiveRejects ?? 0) >= 3) return { state: "degraded", label: "Degraded" };
    return { state: "healthy", label: "Healthy" };
  };

  if (sources.length === 0) {
    return (
      <div>
        <SectionTitle eyebrow="Monitoring" title="Sources" hint="Every configured source and its live health." />
        <EmptyState icon={<RadioTower className="h-5 w-5" />} text="No sources configured — add them under Settings → Sources." />
      </div>
    );
  }

  return (
    <div>
      <SectionTitle
        eyebrow="Monitoring"
        title="Sources"
        hint="Live health from the last pipeline cycle. Edit or add sources under Settings → Sources."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          {sources.map((src: any) => {
            const h = health(src);
            const active = String(src.id ?? src._id) === selectedId;
            const ok = Number(src.publishedCount ?? 0);
            const rej = Number(src.rejectedCount ?? 0);
            const total = ok + rej;
            const rate = total > 0 ? Math.round((ok / total) * 100) : null;
            return (
              <button
                key={src.id ?? src._id}
                type="button"
                onClick={() => setSelectedId(active ? null : String(src.id ?? src._id))}
                className={`panel-hover block w-full px-4 py-3 text-left transition-colors ${active ? "border-primary/60" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${h.state === "healthy" ? "bg-healthy" : h.state === "degraded" ? "bg-review" : "bg-destructive"}`} />
                  <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{src.name}</p>
                  <span className={`shrink-0 rounded-[4px] border px-1.5 py-0.5 text-[10px] font-medium ${
                    h.state === "healthy" ? "border-healthy/40 bg-healthy/10 text-healthy"
                    : h.state === "degraded" ? "border-review/40 bg-review/10 text-review"
                    : "border-destructive/40 bg-destructive/10 text-destructive"
                  }`}>{h.label}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span>{src.kind}</span>
                  <span>{ok} ok · {rej} rejected</span>
                  {src.dailyQuota ? <span className="tabular-nums">{Number(src.usedToday ?? 0)} / {Number(src.dailyQuota)} used today</span> : null}
                  {rate !== null ? <span>{rate}% accepted</span> : null}
                  {src.lastSuccessAt ? <span>last fetch {relTime(src.lastSuccessAt)}</span> : <span>no successful fetch yet</span>}
                  {src.enabled === false ? <span className="text-destructive">disabled</span> : null}
                </div>
              </button>
            );
          })}
        </div>

        <div>
          {selected ? (
            <div className="panel px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Source profile</p>
              <h2 className="mt-1 text-[15px] font-bold text-foreground">{selected.name}</h2>
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Kind</p>
                  <p className="mt-0.5 font-medium text-foreground">{selected.kind}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Priority</p>
                  <p className="mt-0.5 font-medium text-foreground">{selected.priority ?? "—"}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Articles today</p>
                  <p className="mt-0.5 font-medium tabular-nums text-foreground">{Number(selected.publishedCount ?? 0)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Quota today</p>
                  <p className="mt-0.5 font-medium tabular-nums text-foreground">
                    {selected.dailyQuota ? `${Number(selected.usedToday ?? 0)} / ${Number(selected.dailyQuota)}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Rejected</p>
                  <p className="mt-0.5 font-medium tabular-nums text-foreground">{Number(selected.rejectedCount ?? 0)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Fetch failures</p>
                  <p className={`mt-0.5 font-medium tabular-nums ${Number(selected.consecutiveFailures ?? 0) > 0 ? "text-destructive" : "text-foreground"}`}>
                    {Number(selected.consecutiveFailures ?? 0)} consecutive
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Reject streak</p>
                  <p className={`mt-0.5 font-medium tabular-nums ${Number(selected.consecutiveRejects ?? 0) >= 3 ? "text-review" : "text-foreground"}`}>
                    {Number(selected.consecutiveRejects ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Last success</p>
                  <p className="mt-0.5 font-medium text-foreground">{selected.lastSuccessAt ? new Date(selected.lastSuccessAt).toLocaleString() : "never"}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Auto-paused</p>
                  <p className={`mt-0.5 font-medium ${selected.autoPaused ? "text-destructive" : "text-foreground"}`}>{selected.autoPaused ? "Yes" : "No"}</p>
                </div>
              </div>
              {selected.lastError ? (
                <div className="mt-3 rounded-[6px] border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  Last error: {selected.lastError}
                </div>
              ) : null}
              {selected.autoPaused ? (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  This source was auto-paused by the pipeline after repeated failures — re-enable it in Settings → Sources to give it a clean slate.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full min-h-40 items-center justify-center rounded-[6px] border border-dashed border-border px-6 py-10 text-center">
              <p className="text-xs text-muted-foreground">Select a source to see its profile.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
