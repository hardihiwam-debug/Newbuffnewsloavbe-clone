import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Send } from "lucide-react";
import { useNewsroomData } from "@/components/AppShell";
import { CategoryPill, StatusPill, SectionTitle, EmptyState, clockTime, relTime } from "@/components/newsroom";

export const Route = createFileRoute("/_authenticated/published")({
  head: () => ({
    meta: [
      { title: "Published · Iran Desk" },
      { name: "description", content: "Newsroom archive — what has gone out." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: Published,
});

const FILTERS = ["TODAY", "BREAKING", "IRAN", "IRAQ", "MILITARY", "ECONOMY", "ALL"] as const;
type Filter = (typeof FILTERS)[number];

function Published() {
  const data = useNewsroomData();
  const history = (data?.history ?? []) as any[];
  const [filter, setFilter] = useState<Filter>("TODAY");

  const items = history.filter((h) => {
    if (filter === "TODAY") {
      const d = h.publishedAt ?? h.createdAt;
      return d ? new Date(d).toDateString() === new Date().toDateString() : false;
    }
    if (filter === "BREAKING") return Boolean(h.breaking);
    if (filter === "IRAN") return String(h.category ?? "") === "iran";
    if (filter === "IRAQ") return String(h.category ?? "") === "iraq";
    if (filter === "MILITARY") return ["war", "proxies", "usa"].includes(String(h.category ?? ""));
    if (filter === "ECONOMY") return ["oil", "gold", "economic-impact"].includes(String(h.category ?? ""));
    return true;
  });

  return (
    <div>
      <SectionTitle
        eyebrow="Archive"
        title="Published"
        hint="What has gone out — newest first."
        action={<span className="text-[11px] tabular-nums text-muted-foreground">{items.length} item{items.length === 1 ? "" : "s"}</span>}
      />

      <div className="mb-4 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {items.length === 0 ? (
          <EmptyState icon={<Send className="h-5 w-5" />} text={filter === "TODAY" ? "Nothing published today yet." : `No published items match ${filter}.`} />
        ) : (
          items.map((h: any) => (
            <div key={h.id ?? h._id ?? h.dedupKey} className="panel-hover px-4 py-3">
              <div className="flex items-start gap-3">
                {h.imageUrl ? (
                  <img
                    src={h.imageUrl}
                    alt=""
                    loading="lazy"
                    className="mt-0.5 hidden h-14 w-20 shrink-0 rounded-[6px] border border-border object-cover sm:block"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {h.breaking ? <StatusPill status="breaking" /> : null}
                    {h.isUpdate ? <StatusPill status="update" /> : null}
                    <CategoryPill category={h.category} />
                    <span className="text-[10px] tabular-nums text-muted-foreground">{clockTime(h.publishedAt ?? h.createdAt)}</span>
                    <span className="text-[10px] text-muted-foreground">· {relTime(h.publishedAt ?? h.createdAt)} ago</span>
                  </div>
                  <p className="mt-1.5 text-[15px] font-semibold leading-snug text-foreground">{h.headline ?? h.englishHeadline ?? "(untitled)"}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground/80">{h.sourceName ?? "--"}</span>
                    {Array.isArray(h.chats) && h.chats.length > 0 ? <span>→ {h.chats.join(", ")}</span> : null}
                    {h.eventId ? <span className="truncate text-muted-foreground/70" title={String(h.eventId)}>event {String(h.eventId).slice(0, 20)}…</span> : null}
                  </div>
                </div>
                <span className="shrink-0 rounded-[4px] border border-healthy/40 bg-healthy/10 px-1.5 py-0.5 text-[10px] font-semibold text-healthy">TELEGRAM ✓</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
