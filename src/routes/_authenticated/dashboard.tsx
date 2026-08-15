import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  api,
  useAdminQuery,
  useAdminMutation,
  useAdminAction,
} from "@/lib/supabaseAdminHooks";
import { isSupabaseConfigured } from "@/lib/supabase";
import { adminApi } from "@/lib/adminApi";
import { AddChat } from "@/components/AddChat";
import { AddTelegramChannel, TelegramChannelRow } from "@/components/TelegramChannels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BarChart3,
  Globe,
  Zap,
  MessageCircle,
  Clock,
  Flame,
  Languages,
  Activity,
  List,
  Play,
  Pause,
  Lock,
  HeartPulse,
  Settings2,
  Eye,
  X,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { clearStoredPin, readStoredPin } from "@/routes/index";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Console · Iran Desk Bot" },
      {
        name: "description",
        content:
          "Operations console: Telegram chats, posting cadence, breaking-news rules, sources, polling, and the publishing queue.",
      },
      { property: "og:title", content: "Iran Desk Bot Console" },
      {
        property: "og:description",
        content: "Operations console for the automated Iran–U.S. conflict news bot.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: Dashboard,
});


function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-primary">{title}</h2>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Dashboard() {
  const navigate = useNavigate();
  const pin = readStoredPin();
  const pinArgs = pin ? { pin } : {};
  // Convex had a websocket connection state we used to surface "backend
  // offline". For Supabase we just rely on the data load being stuck for the
  // 'slow' timeout — the admin edge function fetches over HTTPS so a network
  // outage produces an error boundary rather than a hung websocket.
  const supabaseConfigured = isSupabaseConfigured();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 12000);
    return () => clearTimeout(t);
  }, []);

  // Skip the backend queries entirely when no PIN is stored — the queries
  // would otherwise error out and bounce the user to the error boundary.
  const data = useAdminQuery(api.admin.getDashboard, pin ? pinArgs : "skip");
  const translationKeyData = useAdminQuery(api.admin.listTranslationKeys, pin ? pinArgs : "skip");

  const saveSettings = useAdminMutation(api.admin.saveSettings);
  const updateChat = useAdminMutation(api.admin.updateChat);
  const addChat = useAdminMutation(api.admin.addChat);
  const upsertTopic = useAdminMutation(api.admin.upsertTopic);
  const upsertSource = useAdminMutation(api.admin.upsertSource);
  const setPauseState = useAdminMutation(api.admin.setPauseState);
  const upsertTranslationKey = useAdminMutation(api.admin.upsertTranslationKey);
  const testTranslationKey = useAdminAction(api.admin_actions.testTranslationKey);
  const testSource = useAdminAction(api.admin_actions.testSource);
  const refreshBotInfo = useAdminAction(api.admin_actions.refreshBotInfo);
  const setWebhook = useAdminAction(api.admin_actions.setWebhook);
  const runPipeline = useAdminAction(api.admin_actions.runPipeline);
  const previewNextBatch = useAdminAction(api.admin_actions.previewNextBatch);
  const setTranslationModel = useAdminMutation(api.admin.setTranslationModel);
  const listTranslationModels = useAdminAction(api.admin_actions.listTranslationModels);
  const syncBotChats = useAdminAction(api.admin_actions.syncBotChats);
  const sendTestMessage = useAdminAction(api.admin_actions.sendTestMessage);
  const testPoll = useAdminAction(api.admin_actions.testPoll);

  const onError = (e: unknown) =>
    toast.error(e instanceof Error ? e.message : "Something went wrong");

  const [fetching, setFetching] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [translationLimit, setTranslationLimit] = useState(20);
  const [preview, setPreview] = useState<any | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  // Helper: wrap a pipeline action with a loading toast and success/error feedback.
  async function withToast(
    label: string,
    setBusy: (v: boolean) => void,
    fn: () => Promise<unknown>,
  ) {
    const id = toast.loading(`${label}…`);
    const startedAt = Date.now();
    setBusy(true);
    try {
      const result = await fn();
      toast.dismiss(id);
      // Try to extract a human-readable summary from the pipeline result.
      const r = (result as any)?.result ?? result;
      // Manual runs are now scheduled server-side (the client connection can't
      // stay open for a multi-minute ingest) — acknowledge the kick-off and
      // point at the live progress panel instead of a fake instant summary.
      if ((r as any)?.scheduled) {
        toast.success(`${label} started — progress shows in the panel`);
        return;
      }
      const parts: string[] = [];
      if (typeof r?.fetched === "number") parts.push(`${r.fetched} fetched`);
      if (typeof r?.queued === "number") parts.push(`${r.queued} queued`);
      if (typeof r?.sent === "number") parts.push(`${r.sent} sent`);
      if (typeof r?.breaking === "number") parts.push(`${r.breaking} breaking`);
      const errors = Array.isArray(r?.errors) && r.errors.length ? `${r.errors.length} error(s)` : "";
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const time =
        elapsedSec >= 60
          ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
          : `${elapsedSec}s`;
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
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">
            Iran Desk
          </p>
          <h1 className="mt-2 text-xl font-semibold">Sign in required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your admin PIN isn't stored in this browser. Sign in again to open the console.
          </p>
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
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">
            Iran Desk
          </p>
          <h1 className="mt-2 text-xl font-semibold">
            {backendDown ? "Backend offline" : "Loading console…"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {backendDown
              ? "The Supabase backend isn't reachable from this preview right now. It usually comes back within a few seconds — refresh to reconnect."
              : slow
                ? "This is taking longer than usual. The backend may have restarted — refresh to reconnect."
                : "Connecting to the backend…"}
          </p>
          <Button
            className="mt-5 w-full"
            variant="secondary"
            onClick={() => window.location.reload()}
          >
            Refresh
          </Button>
        </div>
      </div>
    );
  }

  const s = data.settings as Record<string, any>;
  const paused = Boolean(s["botPaused"]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">
            Iran Desk
          </p>
          <h1 className="text-2xl font-semibold">
            Bot operations console{" "}
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                paused
                  ? "bg-destructive/10 text-destructive"
                  : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              }`}
            >
              {paused ? (
                <>
                  <Pause className="h-3 w-3" /> Paused
                </>
              ) : (
                <>
                  <Play className="h-3 w-3" /> Live
                </>
              )}
            </span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate({ to: "/settings" })}
          >
            <Settings2 className="h-3.5 w-3.5" />
            Settings
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
            <Label className="text-xs font-medium whitespace-nowrap">News language:</Label>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm font-medium"
              value={s["defaultLanguage"] ?? "en"}
              onChange={(e) =>
                saveSettings({ ...pinArgs, patch: { defaultLanguage: e.target.value } }).catch(
                  onError,
                )
              }
            >
              <option value="en">English only</option>
              <option value="ckb">Kurdish Sorani only</option>
              <option value="both">Both (per chat)</option>
            </select>
          </div>
        </div>{" "}
        <div className="flex flex-wrap gap-2">
          <ConfirmAction
            title="Clear the entire queue?"
            description={`Delete all ${(data as any).queuedTotal ?? ""} queued items, then immediately fetch fresh news so the queue repopulates. This cannot be undone.`}
            confirmLabel="Clear & refetch"
            disabled={paused || clearing}
            onConfirm={() =>
              withToast("Clearing queue", setClearing, () =>
                adminApi.clearQueue({ ...pinArgs }),
              )
            }
          >
            {clearing ? "Clearing…" : "Clear queue"}
          </ConfirmAction>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              withToast("Fetching news", setFetching, () =>
                runPipeline({ ...pinArgs, action: "ingest" }),
              )
            }
            disabled={paused || fetching}
          >
            {fetching ? "Fetching…" : "Fetch now"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
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
            {previewing ? "Previewing…" : "Preview next batch"}
          </Button>
          <Button
            size="sm"
            onClick={() =>
              withToast("Publishing", setPublishing, () =>
                runPipeline({ ...pinArgs, action: "publish" }),
              )
            }
            disabled={paused || publishing}
          >
            {publishing ? "Publishing…" : "Publish top 3"}
          </Button>
          {paused ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setPauseState({ ...pinArgs, paused: false, reason: null }).catch(onError)
              }
            >
              Resume services
            </Button>
          ) : (
            <ConfirmAction
              title="Stop the bot?"
              description="Ingest, publish, polls and the Telegram webhook all pause until you resume. Queue items are kept — nothing is deleted."
              confirmLabel="Stop all"
              onConfirm={() =>
                setPauseState({
                  ...pinArgs,
                  paused: true,
                  reason: "Stopped from dashboard",
                }).catch(onError)
              }
            >
              Stop all
            </ConfirmAction>
          )}
          <Button size="sm" variant="ghost" onClick={lock}>
            Lock
          </Button>
        </div>
      </header>

      {paused ? (
        <div className="mt-6 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Services are paused. Ingest, publish, and Telegram webhook actions are blocked until you
          resume them.
          {s["botPausedReason"] ? (
            <span className="ml-2 text-destructive/80">Reason: {String(s["botPausedReason"])}</span>
          ) : null}
        </div>
      ) : null}

      <PreviewBatchDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        preview={preview}
        onClear={() => setPreview(null)}
      />

      <PipelineProgress run={(s as any).pipelineRun} />

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(() => {
          const analytics = (data as any).analytics ?? [];
          const today = analytics.at(-1);
          const yesterday = analytics.at(-2);
          const delta = (key: string) => {
            if (!today || !yesterday) return null;
            return (today[key] ?? 0) - (yesterday[key] ?? 0);
          };
          const deltaChip = (diff: number | null) => {
            if (diff === null) return null;
            if (diff === 0)
              return (
                <span className="text-xs text-muted-foreground" title="Same as yesterday">
                  — vs yesterday
                </span>
              );
            return (
              <span
                className={`text-xs font-medium ${diff > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
                title="vs yesterday"
              >
                {diff > 0 ? `▲ +${diff}` : `▼ ${diff}`} vs yesterday
              </span>
            );
          };
          const publishedDelta = delta("published");
          const pollsDelta = delta("polls");
          const translationFails = (data.translationFailures ?? []).length;
          const aiUsage = (data as any).aiUsage24h ?? {
            promptTokens: 0,
            completionTokens: 0,
            calls: 0,
            byProvider: {},
          };
          const aiTokens = (aiUsage.promptTokens ?? 0) + (aiUsage.completionTokens ?? 0);
          const aiBreakdown = Object.entries(aiUsage.byProvider ?? {})
            .map(
              ([p, v]: [string, any]) =>
                `${p}: ${((v?.promptTokens ?? 0) + (v?.completionTokens ?? 0)).toLocaleString()} tokens · ${v?.calls ?? 0} calls`,
            )
            .join("\n");
          return [
            {
              label: "Queued",
              value: (data.queuedTotal ?? (data.queue ?? []).length),
              tone: "",
              deltaChip: null,
              title: null,
            },
            {
              label: "Published 24h",
              value: data.published24h ?? (data.history ?? []).filter(
                (h: any) => h.publishedAt >= new Date(Date.now() - 86_400_000).toISOString(),
              ).length,
              tone: "",
              deltaChip: deltaChip(publishedDelta),
              title: null,
            },
            {
              label: "Active chats",
              value: (data.chats ?? []).filter((c: any) => c.active).length,
              tone: "",
              deltaChip: null,
              title: null,
            },
            {
              label: "Polls sent (24h)",
              value: data.polls24h ?? ((data as any).polls ?? []).filter(
                (p: any) => p.createdAt >= new Date(Date.now() - 86_400_000).toISOString(),
              ).length,
              tone: "",
              deltaChip: deltaChip(pollsDelta),
              title: null,
            },
            {
              label: "Translation fails (24h)",
              value: data.translationFails24h ?? translationFails,
              tone:
                (data.translationFails24h ?? translationFails) === 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-amber-600 dark:text-amber-400",
              deltaChip: null,
              title: null,
            },
            {
              label: "AI tokens (today)",
              value: aiTokens.toLocaleString(),
              tone: "",
              deltaChip: null,
              title: aiBreakdown || "No AI calls recorded today",
            },
          ].map((stat) => (
            <div key={stat.label} className="panel p-4" title={stat.title ?? undefined}>
              <p className={`text-2xl font-semibold ${stat.tone}`}>{stat.value}</p>
              <p className="text-xs text-muted-foreground">{stat.label}</p>
              {stat.deltaChip ? <div className="mt-0.5">{stat.deltaChip}</div> : null}
            </div>
          ));
        })()}
      </div>

      {(data as any).analytics?.length ? (
        <div className="mt-6">
          <Panel
            title="Analytics · last 14 days"
            hint="Published items, breaking items, and polls per day."
          >
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={(data as any).analytics}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    stroke="var(--muted-foreground)"
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11 }}
                    stroke="var(--muted-foreground)"
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--card)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Bar
                    dataKey="published"
                    name="Published"
                    fill="var(--primary)"
                    radius={[3, 3, 0, 0]}
                  />
                  <Bar
                    dataKey="breaking"
                    name="Breaking"
                    fill="var(--destructive)"
                    radius={[3, 3, 0, 0]}
                  />
                  <Bar
                    dataKey="polls"
                    name="Polls"
                    fill="#f59e0b"
                    radius={[3, 3, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>
      ) : null}

        {/* QUEUE */}
          <PipelineFunnel stats={(s as any).pipelineStats} />
          <QueueStatusTabs
            items={(data as any).queueAll ?? []}
            publishedItems={(data as any).history ?? []}
            queuedTotal={(data as any).queuedTotal}
          />


    </div>
  );
}

function PipelineFunnel({ stats }: { stats: any }) {
  if (!stats) {
    return (
      <Panel title="Pipeline · latest run" hint="Run Fetch now or wait for the next cron cycle to populate.">
        <p className="text-sm text-muted-foreground">
          No pipeline run recorded yet. Hit &ldquo;Fetch now&rdquo; to see the funnel.
        </p>
      </Panel>
    );
  }
  const steps = [
    { label: "Fetched", value: Number(stats.fetched ?? 0), bar: "bg-sky-500" },
    { label: "Passed gates", value: Number(stats.passed ?? 0), bar: "bg-blue-500" },
    { label: "Unique", value: Number(stats.unique ?? 0), bar: "bg-indigo-500" },
    { label: "Queued", value: Number(stats.queued ?? 0), bar: "bg-violet-500" },
    { label: "Sent", value: Number(stats.sent ?? 0), bar: "bg-emerald-500" },
  ];
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <Panel
      title="Pipeline · latest run"
      hint={`${new Date(stats.at).toLocaleString()} · ${stats.breaking ?? 0} breaking · ${stats.errors ?? 0} error(s)`}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {steps.map((st, i) => (
          <div key={st.label} className="rounded-md border border-border p-3">
            <p className="text-2xl font-semibold tabular-nums">{st.value}</p>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${st.bar}`}
                style={{ width: `${Math.max(4, (st.value / max) * 100)}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {i + 1}. {st.label}
            </p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// Queue kanban — 4 status columns over the latest 300 items.
// expands in steps of 12 (capped at 40) so a full column never dumps 300
// cards on the user at once.
function PipelineProgress({ run }: { run: any }) {
  const [now, setNow] = useState(() => Date.now());
  // A run is "running" only if it hasn't finished AND it's fresh. Runs older
  // than 10 minutes with done:false are crashes from before the try/finally
  // guard — treat them as finished so the panel can't get stuck.
  const running = Boolean(
    run &&
      !run.done &&
      Date.now() - (run.at ? Date.parse(run.at) : 0) < 10 * 60_000,
  );
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, run?.at]);

  if (!running) return null;

  const started = run.startedAt ? Date.parse(run.startedAt) : Date.now();
  const elapsedSec = Math.max(0, Math.floor((now - started) / 1000));
  const time =
    elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${elapsedSec}s`;
  const pct = run.total > 0 ? Math.min(100, Math.round((run.item / run.total) * 100)) : null;

  return (
    <div className="mt-6 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-base">{run.action === "ingest" ? "🔄" : "📨"}</span>
        <span className="font-medium">
          {run.action === "ingest" ? "Ingesting" : "Publishing"} — {run.message}
        </span>
        <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">
          ⏱ {time}
          {pct !== null ? ` · ${run.item}/${run.total}` : ""}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full bg-primary transition-all ${pct === null ? "w-1/3 animate-pulse" : ""}`}
          style={pct !== null ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}
// Dry-run dialog for "Preview next batch": shows the exact candidates the
// next publish cycle would pick (same scoring + clustering + deterministic
// gates), with a status per item — no AI calls, no sends, nothing claimed.
function PreviewBatchDialog({
  open,
  onOpenChange,
  preview,
  onClear,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  preview: any | null;
  onClear: () => void;
}) {
  const items: any[] = preview?.items ?? [];
  const ready = items.filter((i) => i.status === "ready").length;
  const statusBadge = (s: string) =>
    s === "ready" ? (
      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
        ready
      </span>
    ) : s === "duplicate" ? (
      <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
        duplicate
      </span>
    ) : (
      <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
        blocked
      </span>
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto max-w-2xl">
        <DialogHeader>
          <DialogTitle>Next publish batch</DialogTitle>
          <DialogDescription>
            {preview?.paused
              ? "Bot is paused — nothing would be published until it resumes."
              : items.length === 0
                ? "Queue is empty — the next cycle would skip."
                : `${ready} of ${items.length} candidate(s) would publish · ${preview?.queued ?? 0} queued · ${preview?.chats ?? 0} active chat(s) · language ${preview?.language ?? "en"}. Dry-run only — nothing was sent.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {items.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              {preview?.paused ? "Services paused." : "No queued candidates to preview."}
            </p>
          ) : (
            items.map((item, idx) => (
              <div
                key={item._id ?? idx}
                className="rounded-md border border-border bg-card/50 px-3 py-2"
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-[10px] font-mono text-muted-foreground">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground break-words">
                      {item.breaking ? <span className="mr-1 text-[10px]">🚨</span> : null}
                      {item.headline}
                    </p>
                    {item.summary ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2 break-words">
                        {item.summary}
                      </p>
                    ) : null}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5">{item.category ?? "--"}</span>
                      <span className="font-mono">score {item.score ?? 0}</span>
                      <span className="truncate">{item.sourceName ?? "--"}</span>
                      {item.members?.length > 1 ? (
                        <span className="text-primary">+{item.members.length - 1} merged source(s)</span>
                      ) : null}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      {statusBadge(item.status)}
                      <span className="text-[10px] text-muted-foreground">{item.reason}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-[11px] gap-1"
            onClick={onClear}
          >
            <X className="h-3 w-3" /> Clear
          </Button>
          <Button size="sm" className="h-8 text-[11px]" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Reusable confirm-before-destructive-action wrapper. Renders a button that
// opens a shadcn AlertDialog; the action only fires after the user confirms.
function ConfirmAction({
  title,
  description,
  confirmLabel = "Confirm",
  variant = "destructive",
  size = "sm",
  disabled = false,
  onConfirm,
  children,
}: {
  title: string;
  description?: string;
  confirmLabel?: string;
  variant?: "default" | "destructive" | "secondary" | "ghost" | "outline" | "link";
  size?: "default" | "sm" | "lg" | "icon";
  disabled?: boolean;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} disabled={disabled}>
          {children}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Simple status-tabbed queue view — replaces the 4-column kanban with a flat
// row list split by status.  Each sub-tab shows a compact row with category,
// score, source, and age; click to expand full detail.
function QueueStatusTabs({
  items,
  publishedItems,
  queuedTotal,
}: {
  items: any[];
  publishedItems: any[];
  queuedTotal?: number | null;
}) {
  const [status, setStatus] = useState("queued");
  const [expanded, setExpanded] = useState<string | null>(null);

  // Human labels for the stored scoreParts breakdown.
  const PART_LABELS: Record<string, string> = {
    priority: "Category priority",
    freshness: "Freshness",
    quotaPenalty: "Quota penalty",
    rotationBonus: "Rotation bonus",
    breakingBonus: "Breaking",
    leaderBonus: "Leader statement",
    severityBonus: "Severity",
    sourcePenalty: "Source penalty",
    signalBonus: "Telegram signal",
    telegramBoost: "Channel boost",
  };
  const partParts = (item: any): Array<{ label: string; value: number }> => {
    const parts = item.scoreParts ?? {};
    return Object.entries(parts)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => ({ label: PART_LABELS[k] ?? k, value: Number(v) }));
  };

  const statuses = ["queued", "published", "rejected", "last100"] as const;
  const label = (s: string) => {
    if (s === "last100") return "Published (last 100)";
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  // "Queued" shows the true live backlog (uncapped); published/rejected
  // badges count what this loaded window can actually display, so a badge
  // never claims more than the list under it.
  const counts: Record<string, number> = {};
  for (const s of statuses) {
    if (s === "last100") counts[s] = publishedItems.length;
    else if (s === "queued") counts[s] = queuedTotal ?? items.filter((i: any) => i.status === "queued").length;
    else counts[s] = items.filter((i: any) => i.status === s).length;
  }

  const filtered = status === "last100"
    ? publishedItems
    : items.filter((i: any) => i.status === status);

  return (
    <Panel title="Queue" hint={`Showing the latest ${items.length} items · ${counts.queued} queued in total.`}>
      <div className="flex flex-wrap gap-1 mb-3">
        {statuses.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              status === s
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {label(s)} · {counts[s] ?? 0}
          </button>
        ))}
      </div>
      <div className="max-h-[28rem] overflow-y-auto space-y-1">
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">No items in this view.</p>
        ) : (
          filtered.slice(0, 100).map((item: any, idx: number) => {
            const h = status === "last100" ? (item.headline ?? "") : (item.headline ?? "");
            const cat = status === "last100" ? (item.category ?? "--") : (item.category ?? "--");
            const score = item.score != null ? String(item.score) : null;
            const src = item.sourceName ?? "--";
            const ts = item.createdAt ?? item.publishedAt ?? "";
            const age = ts
              ? (() => {
                  const ms = Date.now() - Date.parse(ts);
                  if (Number.isNaN(ms)) return "";
                  const m = Math.floor(ms / 60000);
                  if (m < 60) return `${m}m`;
                  const h = Math.floor(m / 60);
                  if (h < 24) return `${h}h`;
                  return `${Math.floor(h / 24)}d`;
                })()
              : "";
            const isBreaking = item.breaking;
            const rowId = item._id ?? item.dedupKey ?? String(idx);
            const isExpanded = expanded === rowId;
            const breakdown = partParts(item);
            const deliveredChats: string[] = status === "last100" ? (item.chats ?? []) : [];

            return (
              <div key={rowId}>
                <button
                  type="button"
                  onClick={() => setExpanded(isExpanded ? null : rowId)}
                  className="flex w-full items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-xs text-left hover:bg-card"
                >
                  {isBreaking ? (
                    <span className="shrink-0 text-[10px] font-bold text-destructive">🚨</span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate font-medium">{h || "(untitled)"}</span>
                  {cat !== "--" ? (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px]">{cat}</span>
                  ) : null}
                  {score ? (
                    <span
                      className={`shrink-0 font-mono text-[10px] ${
                        breakdown.length > 0 ? "text-primary underline decoration-dotted underline-offset-2" : "text-muted-foreground"
                      }`}
                      title="Click to see score breakdown"
                    >
                      {score}
                    </span>
                  ) : null}
                  {deliveredChats.length > 0 ? (
                    <span className="hidden md:flex shrink-0 items-center gap-1">
                      {deliveredChats.slice(0, 3).map((c) => (
                        <span
                          key={c}
                          className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400"
                          title={`Delivered to ${deliveredChats.join(", ")}`}
                        >
                          {c}
                        </span>
                      ))}
                      {deliveredChats.length > 3 ? (
                        <span className="text-[10px] text-muted-foreground">
                          +{deliveredChats.length - 3}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  <span className="hidden sm:inline shrink-0 text-[10px] text-muted-foreground">{src}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{age}</span>
                </button>
                {isExpanded && breakdown.length > 0 ? (
                  <div className="ml-5 mt-0.5 mb-1 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                    {breakdown.map((p) => (
                      <div key={p.label} className="flex items-center justify-between gap-4 text-[10px]">
                        <span className="text-muted-foreground">{p.label}</span>
                        <span className={`font-mono tabular-nums ${p.value > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
                          {p.value > 0 ? `+${p.value}` : p.value}
                        </span>
                      </div>
                    ))}
                    <div className="mt-1 flex items-center justify-between gap-4 border-t border-border/60 pt-1 text-[10px]">
                      <span className="font-medium">Total</span>
                      <span className="font-mono tabular-nums text-primary">{score ?? "—"}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}
