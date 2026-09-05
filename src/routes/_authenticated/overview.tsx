import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Eye, Pause, Play, RefreshCw, AlertTriangle, Radio, SendHorizonal, CheckCircle2, GitBranch, Inbox, Activity, Cpu, Database, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, useAdminAction, useAdminMutation, useAdminQuery } from "@/lib/supabaseAdminHooks";
import { adminApi } from "@/lib/adminApi";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readStoredPin, clearStoredPin } from "@/routes/index";
import { useNewsroomData, refreshNewsroomData } from "@/components/AppShell";
import { ConfirmAction, Kpi, StoryCard, SectionTitle, EmptyState, relTime, clockTime } from "@/components/newsroom";
import { EditQueueItemDialog } from "@/components/newsroom";

export const Route = createFileRoute("/_authenticated/overview")({
  component: Overview,
});

function Overview() {
  const navigate = useNavigate();
  const pin = readStoredPin() ?? "";
  const pinArgs = pin ? { pin } : {};
  const supabaseConfigured = isSupabaseConfigured();
  const [slow, setSlow] = useState(false);

  const data = useNewsroomData();
  const setPauseState = useAdminMutation(api.admin.setPauseState);
  const runPipeline = useAdminAction(api.admin_actions.runPipeline);
  const previewNextBatch = useAdminAction(api.admin_actions.previewNextBatch);

  const [fetching, setFetching] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<any | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 12000);
    return () => clearTimeout(t);
  }, []);

  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong");

  async function withToast(label: string, setBusy: (v: boolean) => void, fn: () => Promise<unknown>) {
    const id = toast.loading(`${label}…`);
    const startedAt = Date.now();
    setBusy(true);
    try {
      const result = await fn();
      toast.dismiss(id);
      const r = (result as any)?.result ?? result;
      if ((r as any)?.scheduled) {
        toast.success(`${label} started — progress shows in the feed`);
        return;
      }
      const parts: string[] = [];
      if (typeof r?.fetched === "number") parts.push(`${r.fetched} fetched`);
      if (typeof r?.queued === "number") parts.push(`${r.queued} queued`);
      if (typeof r?.sent === "number") parts.push(`${r.sent} sent`);
      if (typeof r?.breaking === "number") parts.push(`${r.breaking} breaking`);
      const errors = Array.isArray(r?.errors) && r.errors.length ? `${r.errors.length} error(s)` : "";
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const time = elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${elapsedSec}s`;
      const summary = parts.length > 0 ? parts.join(", ") : "Done";
      toast.success(`${label}: ${summary} in ${time}${errors ? ` · ${errors}` : ""}`);
    } catch (err) {
      toast.dismiss(id);
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  function lock() {
    clearStoredPin();
    navigate({ to: "/", replace: true });
  }

  if (!pin) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-10">
        <div className="panel max-w-md p-8 text-center">
          <h1 className="text-xl font-semibold">Sign in required</h1>
          <p className="mt-2 text-sm text-muted-foreground">Your admin PIN isn't stored in this browser.</p>
          <Button className="mt-5 w-full" onClick={() => navigate({ to: "/", replace: true })}>
            Go to sign-in
          </Button>
        </div>
      </div>
    );
  }

  if (!data?.settings) {
    const backendDown = !supabaseConfigured;
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-10">
        <div className="panel max-w-md p-8 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">Iran Desk</p>
          <h1 className="mt-2 text-xl font-semibold">{backendDown ? "Backend offline" : "Loading newsroom…"}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {backendDown
              ? "The Supabase backend isn't reachable from this preview right now. It usually comes back within a few seconds — refresh to reconnect."
              : slow
                ? "This is taking longer than usual. The backend may have restarted — refresh to reconnect."
                : "Connecting to the backend…"}
          </p>
          <Button className="mt-5 w-full" variant="secondary" onClick={() => window.location.reload()}>
            Refresh
          </Button>
        </div>
      </div>
    );
  }

  const s = data.settings as Record<string, any>;
  const paused = Boolean(s["botPaused"]);
  const queue = (data.queueAll ?? []) as any[];
  const queuedItems = queue.filter((i) => String(i.status ?? "queued") === "queued");
  const history = (data.history ?? []) as any[];
  const activity = (data.recentActivity ?? []) as any[];
  const sources = (data.sources ?? []) as any[];
  const analytics = (data.analytics ?? []) as any[];
  const today = analytics.at(-1);
  const yesterday = analytics.at(-2);
  const publishedDelta = today && yesterday ? (today.published ?? 0) - (yesterday.published ?? 0) : null;

  const sourceFailures = sources.filter(
    (src: any) => src.autoPaused || Number(src.consecutiveRejects ?? 0) >= 3 || src.lastError,
  ).length;
  const heldForReview = queuedItems.filter(
    (i) => Boolean(i.isUpdate) || String(i.importance ?? "") === "update",
  ).length;

  const handlePublishNow = async (item: any) => {
    const rowId = String(item.id ?? item._id);
    setPublishingId(rowId);
    const id = toast.loading("Publishing…");
    try {
      const r = await adminApi.publishQueueItem({ pin, id: rowId });
      toast.dismiss(id);
      if ((r as any)?.ok === false) {
        const res = (r as any)?.result;
        throw new Error(String(res?.error ?? res?.skipped ?? "Publish failed"));
      }
      toast.success("Published to all active chats");
      refreshNewsroomData();
    } catch (e) {
      toast.dismiss(id);
      toast.error(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setPublishingId(null);
    }
  };

  // Newsroom feed: merge published history, queue items and activity events
  // into one chronological stream, newest first.
  const feed: Array<{ kind: "published" | "queued" | "event"; item: any; at: string }> = [];
  for (const h of history.slice(0, 12)) feed.push({ kind: "published", item: h, at: h.publishedAt ?? h.createdAt ?? "" });
  for (const q of queuedItems.slice(0, 12)) feed.push({ kind: "queued", item: q, at: q.createdAt ?? q.originalPublishedAt ?? "" });
  for (const a of activity.slice(0, 12)) feed.push({ kind: "event", item: a, at: a.createdAt ?? "" });
  feed.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const lastRun = activity.find((a) => a.type === "publish" || a.type === "ingest");
  const lastRunAt = lastRun?.createdAt ? new Date(lastRun.createdAt) : null;

  return (
    <div>
      {/* ── Command bar ─────────────────────────────── */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Newsroom overview</p>
          <h1 className="text-[22px] font-bold">Overview</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5 text-[11px]"
            onClick={() => withToast("Fetching news", setFetching, () => runPipeline({ ...pinArgs, action: "ingest" }))}
            disabled={paused || fetching}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {fetching ? "Fetching…" : "Fetch now"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-[11px]"
            disabled={paused || previewing}
            onClick={() => {
              setPreviewing(true);
              const id = toast.loading("Previewing next batch…");
              previewNextBatch({ ...pinArgs, limit: 3 })
                .then((r) => {
                  setPreview(r);
                  setPreviewOpen(true);
                  toast.dismiss(id);
                })
                .catch((e) => {
                  toast.dismiss(id);
                  onError(e);
                })
                .finally(() => setPreviewing(false));
            }}
          >
            <Eye className="h-3.5 w-3.5" />
            {previewing ? "Previewing…" : "Preview"}
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5 text-[11px]"
            onClick={() => withToast("Publishing", setPublishing, () => runPipeline({ ...pinArgs, action: "publish" }))}
            disabled={paused || publishing}
          >
            <SendHorizonal className="h-3.5 w-3.5" />
            {publishing ? "Publishing…" : "Run pipeline"}
          </Button>
          {paused ? (
            <Button size="sm" variant="secondary" className="h-8 gap-1.5 text-[11px]" onClick={() => setPauseState({ ...pinArgs, paused: false, reason: null }).catch(onError)}>
              <Play className="h-3.5 w-3.5" /> Resume
            </Button>
          ) : (
            <ConfirmAction
              title="Stop the bot?"
              description="Ingest, publish, polls and the Telegram webhook all pause until you resume. Queue items are kept — nothing is deleted."
              confirmLabel="Stop all"
              onConfirm={() => setPauseState({ ...pinArgs, paused: true, reason: "Stopped from overview" }).catch(onError)}
            >
              <Pause className="h-3.5 w-3.5" /> Pause
            </ConfirmAction>
          )}
          <Button size="sm" variant="ghost" className="h-8 gap-1 text-[11px] text-muted-foreground" onClick={lock}>
            Lock
          </Button>
        </div>
      </div>

      {/* Operational strip */}
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className={`flex items-center gap-1.5 font-medium ${paused ? "text-destructive" : "text-healthy"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-destructive" : "bg-healthy"}`} />
          {paused ? "PAUSED" : "OPERATIONAL"}
        </span>
        <span>
          {new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "short", year: "numeric" })}
        </span>
        {lastRunAt ? <span>Last run {lastRunAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}
      </div>

      {/* Schema drift banner */}
      {(() => {
        const sm = (data as any).schemaMigrations;
        if (!sm || sm.ok) return null;
        const missing = Object.entries(sm.missing ?? {});
        return (
          <div className="mb-5 rounded-[6px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            <p className="flex items-center gap-2 font-medium text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Database schema is behind the pipeline — the bot cannot queue or publish
            </p>
            <p className="mt-1.5 text-muted-foreground">
              Missing:{" "}
              {missing.map(([migration, cols]) => (
                <span key={migration} className="mr-2 inline-flex flex-wrap items-baseline gap-1">
                  <code className="rounded bg-muted px-1 py-0.5 text-destructive">{migration}</code>
                  <span className="text-xs text-muted-foreground">({(cols as string[]).join(", ")})</span>
                </span>
              ))}
            </p>
          </div>
        );
      })()}

      {/* ── KPI strip ───────────────────────────────── */}
      {/* On mobile: single horizontal-scroll row of chips. On desktop: 4-column grid. */}
      <div className="flex gap-2 overflow-x-auto pb-1 md:grid md:grid-cols-3 md:gap-3 lg:grid-cols-4">
        <Kpi value={data.published24h ?? 0} label="Published today" tone="healthy" delta={publishedDelta !== null && publishedDelta !== 0 ? `${publishedDelta > 0 ? "▲ +" : "▼ "}${publishedDelta} vs yesterday` : null} />
        <Kpi value={Number(data.queuedTotal ?? queuedItems.length)} label="In queue" tone="neutral" />
        <Kpi value={heldForReview} label="Held for review" tone="review" hint={heldForReview > 0 ? "Follow-up updates awaiting a decision" : undefined} />
        <Kpi value={sourceFailures} label="Source failures" tone={sourceFailures > 0 ? "danger" : "neutral"} />
      </div>

      <ControlCenter data={data} paused={paused} queued={Number(data.queuedTotal ?? queuedItems.length)} />

      <SourceTrustPanel sources={(data as any).sourceTrust ?? []} note={(data as any).sourceTrustNote} />

      {/* ── Newsroom feed ───────────────────────────── */}
      <div className="mt-6">
        <SectionTitle
          eyebrow="Live"
          title="Newsroom feed"
          hint="What the bot is doing — newest first."
          action={
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[11px]" onClick={() => navigate({ to: "/inbox" })}>
              <Inbox className="h-3.5 w-3.5" /> Open inbox
            </Button>
          }
        />
        <div className="space-y-2">
          {feed.length === 0 ? (
            <EmptyState icon={<Radio className="h-5 w-5" />} text="No activity yet — run Fetch now or wait for the next cron cycle." />
          ) : (
            feed.slice(0, 14).map((entry, idx) => {
              if (entry.kind === "event") {
                const a = entry.item;
                const icon =
                  a.level === "error" ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                  : a.level === "warning" ? <AlertTriangle className="h-3.5 w-3.5 text-review" />
                  : a.type === "publish" ? <CheckCircle2 className="h-3.5 w-3.5 text-healthy" />
                  : <Radio className="h-3.5 w-3.5 text-info" />;
                return (
                  <div key={`ev-${a.id ?? idx}`} className="panel flex items-start gap-3 px-4 py-2.5">
                    <span className="mt-0.5 shrink-0">{icon}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-foreground">{a.message}</p>
                      {a.detail ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={a.detail}>{a.detail}</p> : null}
                    </div>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{relTime(a.createdAt)}</span>
                  </div>
                );
              }
              const item = entry.item;
              const title = item.headline ?? "";
              return (
                <StoryCard
                  key={`${entry.kind}-${item.id ?? item.dedupKey ?? idx}`}
                  item={item}
                  busy={publishingId === String(item.id ?? item._id)}
                  onReview={(it) => navigate({ to: "/review", search: { id: String(it.id ?? it._id) } })}
                  onEdit={setEditing}
                  onPublish={entry.kind === "queued" ? () => handlePublishNow(item) : undefined}
                />
              );
            })
          )}
        </div>
      </div>

      {/* ── Pipeline run progress (live) ────────────── */}
      <PipelineProgress run={(s as any).pipelineRun} />

      <EditQueueItemDialog item={editing} pin={pin} onClose={() => setEditing(null)} onSaved={() => refreshNewsroomData()} />

      {/* Preview dialog */}
      <PreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} preview={preview} />
    </div>
  );
}

function stageLabel(value: string): { label: string; tone: "healthy" | "review" | "danger" | "neutral" } {
  if (value === "running") return { label: "Running", tone: "healthy" };
  if (value === "stopped" || value === "paused") return { label: value === "paused" ? "Paused" : "Stopped", tone: "danger" };
  if (value === "quota-limited") return { label: "Quota limited", tone: "review" };
  return { label: "Waiting", tone: "neutral" };
}

function ControlCenter({ data, paused, queued }: { data: any; paused: boolean; queued: number }) {
  const control = (data?.controlCenter ?? {}) as any;
  const stages = (control.stages ?? {}) as Record<string, string>;
  const usage = (data?.usage ?? {}) as any;
  const ai = (usage.ai ?? data?.aiUsage24h ?? {}) as any;
  const supabase = usage.supabase as { tracked?: boolean; note?: string } | undefined;
  const provider = String(data?.currentProvider ?? data?.settings?.translationMode ?? "unknown").replace(/_/g, " ");
  const model = String(data?.currentModel ?? data?.settings?.translationModel ?? "unknown");
  const lastCycle = control.lastSuccessfulCycle ? new Date(control.lastSuccessfulCycle) : null;
  const lastCycleLabel = lastCycle && !Number.isNaN(lastCycle.getTime()) ? relTime(control.lastSuccessfulCycle) + " ago" : "No completed cycle";
  const stageRows = [
    { key: "ingest", label: "Ingest", icon: Radio },
    { key: "rewrite", label: "Rewrite", icon: Activity },
    { key: "translation", label: "Translation", icon: Cpu },
    { key: "publish", label: "Publish", icon: SendHorizonal },
  ];
  return (
    <div className="mt-6 panel px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Operations</p>
          <h2 className="mt-1 text-[16px] font-bold text-foreground">Pipeline control center</h2>
        </div>
        <span className={`flex items-center gap-1.5 text-[11px] font-medium ${paused ? "text-destructive" : "text-healthy"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-destructive" : "bg-healthy"}`} />
          {paused ? "Automation stopped" : "Automation available"}
        </span>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {stageRows.map(({ key, label, icon: Icon }) => {
          const status = stageLabel(String(stages[key] ?? "waiting"));
          const tone = status.tone === "healthy" ? "text-healthy" : status.tone === "danger" ? "text-destructive" : status.tone === "review" ? "text-review" : "text-muted-foreground";
          return (
            <div key={key} className="flex items-center gap-2 rounded-[6px] border border-border bg-muted/20 px-3 py-2.5">
              <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} />
              <span className="min-w-0 flex-1 text-xs font-medium text-foreground">{label}</span>
              <span className={`text-[10px] font-medium ${tone}`}>{status.label}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-5">
        <ControlMetric icon={Inbox} label="Queue" value={String(queued)} />
        <ControlMetric icon={CheckCircle2} label="Last successful cycle" value={lastCycleLabel} />
        <ControlMetric icon={Cpu} label="Provider / model" value={`${provider} · ${model}`} />
        <ControlMetric icon={Activity} label="AI usage today" value={`${Number(ai.calls ?? 0).toLocaleString()} calls · ${(Number(ai.promptTokens ?? 0) + Number(ai.completionTokens ?? 0)).toLocaleString()} tokens`} />
        <ControlMetric icon={Database} label="Supabase usage" value={supabase?.tracked ? "Tracked" : "Not available"} hint={supabase?.note} />
      </div>
    </div>
  );
}

function ControlMetric({ icon: Icon, label, value, hint }: { icon: typeof Inbox; label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><Icon className="h-3 w-3" />{label}</p>
      <p className="mt-1 truncate text-xs font-medium text-foreground">{value}</p>
    </div>
  );
}

function SourceTrustPanel({ sources, note }: { sources: any[]; note?: string }) {
  const statusMeta: Record<string, { label: string; cls: string }> = {
    trusted: { label: "Trusted", cls: "border-healthy/40 bg-healthy/10 text-healthy" },
    normal: { label: "Normal", cls: "border-border bg-muted/40 text-muted-foreground" },
    degraded: { label: "Degraded", cls: "border-review/40 bg-review/10 text-review" },
    temporarily_muted: { label: "Temporarily muted", cls: "border-destructive/40 bg-destructive/10 text-destructive" },
  };
  return (
    <div className="mt-4 panel px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Source intelligence</p>
          <h2 className="mt-1 text-[16px] font-bold text-foreground">Adaptive source trust</h2>
        </div>
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
      </div>
      {sources.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No source trust data yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-[11px]">
            <thead className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="pb-2 pr-3 font-medium">Source</th>
                <th className="pb-2 pr-3 font-medium">Trust</th>
                <th className="pb-2 pr-3 font-medium">Useful</th>
                <th className="pb-2 pr-3 font-medium">Rejected</th>
                <th className="pb-2 pr-3 font-medium">Acceptance</th>
                <th className="pb-2 pr-3 font-medium">Fetch failures</th>
                <th className="pb-2 font-medium">Other rates</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source: any) => {
                const meta = statusMeta[String(source.status)] ?? statusMeta.normal;
                return (
                  <tr key={String(source.id ?? source.name)} className="border-b border-border/60 last:border-0">
                    <td className="max-w-[180px] truncate py-2.5 pr-3 font-medium text-foreground">{source.name}</td>
                    <td className="py-2.5 pr-3"><span className={`inline-flex whitespace-nowrap rounded-[4px] border px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}>{meta.label}</span></td>
                    <td className="py-2.5 pr-3 tabular-nums text-foreground">{source.usefulArticles ?? 0}</td>
                    <td className="py-2.5 pr-3 tabular-nums text-foreground">{source.rejectedArticles ?? 0}</td>
                    <td className="py-2.5 pr-3 tabular-nums text-foreground">{source.acceptanceRate === null ? "—" : `${source.acceptanceRate}%`}</td>
                    <td className={`py-2.5 pr-3 tabular-nums ${Number(source.fetchFailures ?? 0) > 0 ? "text-destructive" : "text-foreground"}`}>{source.fetchFailures ?? 0}</td>
                    <td className="py-2.5 text-muted-foreground" title="Not tracked per source in the current schema">Not tracked</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[10px] text-muted-foreground"><ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />{note ?? "Trust uses persisted source health and accepted/rejected counts. Detailed outcome rates are not tracked per source yet."}</p>
    </div>
  );
}

function PipelineProgress({ run }: { run: any }) {
  const [now, setNow] = useState(() => Date.now());
  const running = Boolean(run && !run.done && Date.now() - (run.at ? Date.parse(run.at) : 0) < 10 * 60_000);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, run?.at]);
  if (!running) return null;
  const started = run.startedAt ? Date.parse(run.startedAt) : Date.now();
  const elapsedSec = Math.max(0, Math.floor((now - started) / 1000));
  const time = elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${elapsedSec}s`;
  const pct = run.total > 0 ? Math.min(100, Math.round((run.item / run.total) * 100)) : null;
  return (
    <div className="mt-4 rounded-[6px] border border-info/30 bg-info/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-base">{run.action === "ingest" ? "🔄" : "📨"}</span>
        <span className="font-medium">{run.action === "ingest" ? "Ingesting" : "Publishing"} — {run.message}</span>
        <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">⏱ {time}{pct !== null ? ` · ${run.item}/${run.total}` : ""}</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full bg-info transition-all ${pct === null ? "w-1/3 animate-pulse" : ""}`} style={pct !== null ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}

function PreviewDialog({ open, onOpenChange, preview }: { open: boolean; onOpenChange: (v: boolean) => void; preview: any | null }) {
  const items: any[] = preview?.items ?? [];
  const ready = items.filter((i) => i.status === "ready").length;
  const statusBadge = (s: string) =>
    s === "ready" ? <span className="rounded bg-healthy/10 px-1.5 py-0.5 text-[10px] font-medium text-healthy">ready</span>
    : s === "duplicate" ? <span className="rounded bg-review/10 px-1.5 py-0.5 text-[10px] font-medium text-review">duplicate</span>
    : <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">blocked</span>;
  return (
    <div className={`fixed inset-0 z-50 ${open ? "flex" : "hidden"} items-center justify-center p-4`}>
      <div className="absolute inset-0 bg-black/60" onClick={() => onOpenChange(false)} />
      <div className="relative max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-[6px] border border-border bg-card p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold">Next publish batch</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {preview?.paused ? "Bot is paused — nothing would be published until it resumes."
                : items.length === 0 ? "Queue is empty — the next cycle would skip."
                : `${ready} of ${items.length} candidate(s) would publish · ${preview?.queued ?? 0} queued · ${preview?.chats ?? 0} active chat(s) · language ${preview?.language ?? "en"}. Dry-run only — nothing was sent.`}
            </p>
          </div>
          <button type="button" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => onOpenChange(false)}>✕</button>
        </div>
        <div className="space-y-2">
          {items.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">{preview?.paused ? "Services paused." : "No queued candidates to preview."}</p>
          ) : (
            items.map((item, idx) => (
              <div key={item._id ?? idx} className="rounded-[6px] border border-border bg-card/50 px-3 py-2">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-[10px] font-mono text-muted-foreground">{idx + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-xs font-medium text-foreground">
                      {item.breaking ? <span className="mr-1 text-[10px]">🚨</span> : null}
                      {item.headline}
                    </p>
                    {item.summary ? <p className="mt-0.5 line-clamp-2 break-words text-[11px] text-muted-foreground">{item.summary}</p> : null}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5">{item.category ?? "--"}</span>
                      <span className="font-mono">score {item.score ?? 0}</span>
                      <span className="truncate">{item.sourceName ?? "--"}</span>
                      {item.members?.length > 1 ? <span className="text-primary">+{item.members.length - 1} merged source(s)</span> : null}
                      {statusBadge(item.status)}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <Button size="sm" className="h-8 text-[11px]" onClick={() => onOpenChange(false)}>Close</Button>
        </div>
      </div>
    </div>
  );
}
