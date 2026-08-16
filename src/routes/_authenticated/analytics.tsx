import { createFileRoute } from "@tanstack/react-router";
import { BarChart as BarChartIcon } from "lucide-react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useNewsroomData } from "@/components/AppShell";
import { SectionTitle, EmptyState } from "@/components/newsroom";

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics · Iran Desk" },
      { name: "description", content: "How the newsroom is performing." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: Analytics,
});

function Analytics() {
  const data = useNewsroomData();
  const days = (data?.analytics ?? []) as any[];
  const sources = (data?.sources ?? []) as any[];
  const history = (data?.history ?? []) as any[];
  const ai = (data?.aiUsage24h ?? {}) as any;

  const totalPublished = days.reduce((a: number, d: any) => a + Number(d.published ?? 0), 0);
  const totalBreaking = days.reduce((a: number, d: any) => a + Number(d.breaking ?? 0), 0);
  const totalPolls = days.reduce((a: number, d: any) => a + Number(d.polls ?? 0), 0);

  // Per-source counts from the retained published history (real rows).
  const bySource = new Map<string, number>();
  for (const h of history) {
    const name = String(h.sourceName ?? "unknown");
    bySource.set(name, (bySource.get(name) ?? 0) + 1);
  }
  const sourceRows = [...bySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const sourceMax = sourceRows.length > 0 ? sourceRows[0][1] : 1;

  const aiCalls = Number(ai.calls ?? 0);
  const aiTokens = Number(ai.promptTokens ?? 0) + Number(ai.completionTokens ?? 0);
  const byProvider = (ai.byProvider ?? {}) as Record<string, { calls: number }>;
  const providerRows = Object.entries(byProvider).sort((a, b) => b[1].calls - a[1].calls);
  const providerMax = providerRows.length > 0 ? providerRows[0][1].calls : 1;

  const chartData = days.map((d) => ({
    day: d.date.slice(5),
    published: Number(d.published ?? 0),
    breaking: Number(d.breaking ?? 0),
    polls: Number(d.polls ?? 0),
  }));

  return (
    <div>
      <SectionTitle eyebrow="Performance" title="Analytics" hint="14-day retention of real published/poll rows — nothing here is estimated." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiBox value={Number(data?.published24h ?? 0)} label="Published today" />
        <KpiBox value={totalPublished} label="Published · 14d" />
        <KpiBox value={totalBreaking} label="Breaking · 14d" />
        <KpiBox value={totalPolls} label="Polls · 14d" />
      </div>

      {chartData.length === 0 ? (
        <div className="mt-4">
          <EmptyState icon={<BarChartIcon className="h-5 w-5" />} text="No analytics yet — the 14-day series fills as the bot publishes." />
        </div>
      ) : (
        <div className="panel mt-4 px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Content · last 14 days</p>
          <div className="mt-2 h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 0, left: -18, bottom: 0 }}>
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip
                  cursor={{ fill: "var(--muted)" }}
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: "var(--foreground)" }}
                />
                <Bar dataKey="published" name="Published" fill="var(--primary)" radius={[3, 3, 0, 0]} />
                <Bar dataKey="breaking" name="Breaking" fill="var(--destructive)" radius={[3, 3, 0, 0]} />
                <Bar dataKey="polls" name="Polls" fill="var(--muted-foreground)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* ── Source analytics ──────────────────────── */}
        <div className="panel px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Sources · retained published rows</p>
          <div className="mt-3 space-y-2">
            {sourceRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No published rows retained yet.</p>
            ) : (
              sourceRows.map(([name, count]) => (
                <div key={name} className="flex items-center gap-2 text-[11px]">
                  <span className="w-32 shrink-0 truncate font-medium text-foreground">{name}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-healthy" style={{ width: `${Math.max(4, Math.round((count / sourceMax) * 100))}%` }} />
                  </div>
                  <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">{count}</span>
                </div>
              ))
            )}
            <p className="pt-1 text-[10px] text-muted-foreground">{sources.length} source(s) configured · counts reflect the retained window (16h).</p>
          </div>
        </div>

        {/* ── AI analytics ──────────────────────────── */}
        <div className="panel px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">AI · today</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-[6px] border border-border bg-muted/30 px-3 py-2.5">
              <p className="text-xl font-bold tabular-nums text-foreground">{aiCalls}</p>
              <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Calls</p>
            </div>
            <div className="rounded-[6px] border border-border bg-muted/30 px-3 py-2.5">
              <p className="text-xl font-bold tabular-nums text-foreground">{aiTokens.toLocaleString()}</p>
              <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Tokens</p>
            </div>
          </div>
          {providerRows.length > 0 ? (
            <div className="mt-3 space-y-2">
              {providerRows.map(([provider, v]) => (
                <div key={provider} className="flex items-center gap-2 text-[11px]">
                  <span className="w-24 shrink-0 truncate font-medium text-foreground">{provider}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-info" style={{ width: `${Math.max(4, Math.round((v.calls / providerMax) * 100))}%` }} />
                  </div>
                  <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">{v.calls}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">No AI usage recorded today.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiBox({ value, label }: { value: number; label: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-[28px] font-bold leading-none tabular-nums text-foreground">{value}</p>
      <p className="mt-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}
