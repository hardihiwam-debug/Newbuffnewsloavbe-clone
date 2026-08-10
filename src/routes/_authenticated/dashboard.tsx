import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useAction, useConvexConnectionState } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
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

const CATEGORIES = [
  "iraq",
  "war",
  "iran",
  "middle-east",
  "analysis",
  "proxies",
  "gold",
  "usa",
  "oil",
  "economic-impact",
];

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
  const connection = useConvexConnectionState();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 12000);
    return () => clearTimeout(t);
  }, []);

  // Skip the backend queries entirely when no PIN is stored — the queries
  // would otherwise error out and bounce the user to the error boundary.
  const data = useQuery(api.admin.getDashboard, pin ? pinArgs : "skip");
  const translationKeyData = useQuery(api.admin.listTranslationKeys, pin ? pinArgs : "skip");

  const saveSettings = useMutation(api.admin.saveSettings);
  const updateChat = useMutation(api.admin.updateChat);
  const upsertTopic = useMutation(api.admin.upsertTopic);
  const upsertSource = useMutation(api.admin.upsertSource);
  const setPauseState = useMutation(api.admin.setPauseState);
  const upsertTranslationKey = useMutation(api.admin.upsertTranslationKey);
  const testTranslationKey = useAction(api.admin_actions.testTranslationKey);
  const refreshBotInfo = useAction(api.admin_actions.refreshBotInfo);
  const setWebhook = useAction(api.admin_actions.setWebhook);
  const runPipeline = useAction(api.admin_actions.runPipeline);
  const setTranslationModel = useAction(api.admin_actions.setTranslationModel);
  const listTranslationModels = useAction(api.admin_actions.listTranslationModels);
  const syncBotChats = useAction(api.admin_actions.syncBotChats);
  const sendTestMessage = useAction(api.admin_actions.sendTestMessage);
  const testPoll = useAction(api.admin_actions.testPoll);

  const onError = (e: unknown) =>
    toast.error(e instanceof Error ? e.message : "Something went wrong");

  const [fetching, setFetching] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // Helper: wrap a pipeline action with a loading toast and success/error feedback.
  async function withToast(
    label: string,
    setBusy: (v: boolean) => void,
    fn: () => Promise<unknown>,
  ) {
    const id = toast.loading(`${label}…`);
    setBusy(true);
    try {
      const result = await fn();
      toast.dismiss(id);
      // Try to extract a human-readable summary from the pipeline result.
      const r = (result as any)?.result ?? result;
      const parts: string[] = [];
      if (typeof r?.fetched === "number") parts.push(`${r.fetched} fetched`);
      if (typeof r?.queued === "number") parts.push(`${r.queued} queued`);
      if (typeof r?.sent === "number") parts.push(`${r.sent} sent`);
      if (typeof r?.breaking === "number") parts.push(`${r.breaking} breaking`);
      const summary = parts.length > 0 ? parts.join(", ") : "Done";
      toast.success(`${label}: ${summary}`);
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
    const backendDown = connection?.isWebSocketConnected === false;
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
              ? "The Convex backend isn't reachable from this preview right now. It usually comes back within a few seconds — refresh to reconnect."
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
          <h1 className="text-2xl font-semibold">Bot operations console</h1>
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
        </div>        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => withToast("Fetching news", setFetching, () => runPipeline({ ...pinArgs, action: "ingest" }))} disabled={paused || fetching}>{fetching ? "Fetching…" : "Fetch now"}</Button>
          <Button size="sm" onClick={() => withToast("Publishing", setPublishing, () => runPipeline({ ...pinArgs, action: "publish" }))} disabled={paused || publishing}>{publishing ? "Publishing…" : "Publish top 3"}</Button>
          <Button
            size="sm"
            variant={paused ? "secondary" : "destructive"}
            onClick={() =>
              setPauseState({
                ...pinArgs,
                paused: !paused,
                reason: paused ? null : "Stopped from dashboard",
              }).catch(onError)
            }
          >
            {paused ? "Resume services" : "Stop all"}
          </Button>
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

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Queued", value: (data.queue ?? []).length },
          {
            label: "Published 24h",
            value: (data.history ?? []).filter(
              (h: any) => h.publishedAt >= new Date(Date.now() - 86_400_000).toISOString(),
            ).length,
          },
          { label: "Active chats", value: (data.chats ?? []).filter((c: any) => c.active).length },
          {
            label: "Polls sent",
            value: ((data as any).polls ?? []).filter(
              (p: any) => p.createdAt >= new Date(Date.now() - 86_400_000).toISOString(),
            ).length,
          },
          { label: "Translation fails", value: (data.translationFailures ?? []).length },
          { label: "Status", value: paused ? "Paused" : "Live" },
        ].map((stat) => (
          <div key={stat.label} className="panel p-4">
            <p className="text-2xl font-semibold">{stat.value}</p>
            <p className="text-xs text-muted-foreground">{stat.label}</p>
          </div>
        ))}
      </div>

      <Tabs defaultValue="queue" className="mt-8">
        <TabsList className="flex-wrap">
          <TabsTrigger value="queue">Queue &amp; history</TabsTrigger>
          <TabsTrigger value="bot">Bot &amp; chats</TabsTrigger>
          <TabsTrigger value="cadence">Cadence</TabsTrigger>
          <TabsTrigger value="breaking">Breaking</TabsTrigger>
          <TabsTrigger value="sources">Sources &amp; topics</TabsTrigger>
          <TabsTrigger value="translation">Translation</TabsTrigger>
          <TabsTrigger value="polls">Polls</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        {/* QUEUE */}
        <TabsContent value="queue" className="mt-4 space-y-4">
          <Panel title="Queued" hint="Ranked by breaking flag, then score.">
            {(data.queue ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing queued yet. Run the ingest cycle.
              </p>
            ) : (
              data.queue.map((q: any) => (
                <div key={q._id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{q.category}</Badge>
                    <span className="text-xs text-muted-foreground">
                      score {Math.round(q.score)}
                    </span>
                    <span className="text-xs text-muted-foreground">· {q.sourceName}</span>
                  </div>
                  <p className="mt-2 font-medium">{q.headline}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{q.summary}</p>
                </div>
              ))
            )}
          </Panel>
          <Panel title="Published (last 100)">
            {(data.history ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing published yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.history.map((h: any) => (
                  <li key={h._id} className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {new Date(h.publishedAt).toLocaleTimeString()}
                    </span>
                    <Badge variant="secondary">{h.category}</Badge>
                    <span className="flex-1">{h.headline}</span>
                    <span className="text-xs text-muted-foreground">chat {String(h.chatId)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>

        {/* BOT */}
        <TabsContent value="bot" className="mt-4 space-y-4">
          <Panel
            title="Bot connection"
            hint="The bot token is stored as a server-side secret and never sent to this browser."
          >
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge variant={data.botConfigured ? "default" : "destructive"}>
                {data.botConfigured ? "Token saved ••••••••" : "No token configured"}
              </Badge>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  refreshBotInfo({ ...pinArgs })
                    .then((r: any) =>
                      toast.success(r.username ? `Connected as @${r.username}` : "Bot reachable"),
                    )
                    .catch(onError)
                }
              >
                Test connection
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  setWebhook({ ...pinArgs, baseUrl: window.location.origin + "/convex" })
                    .then(() => toast.success("Telegram webhook registered"))
                    .catch(onError)
                }
              >
                Register webhook
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  syncBotChats({ ...pinArgs })
                    .then((r: any) => {
                      if (r.count > 0)
                        toast.success(
                          `Found ${r.count} chat(s): ${r.found.map((f: any) => f.title ?? f.username ?? f.chatId).join(", ")}`,
                        );
                      else
                        toast.warning(
                          r.note ??
                            "No chats found — press Start on your bot in Telegram first, then sync again.",
                        );
                    })
                    .catch(onError)
                }
              >
                Sync chats
              </Button>
            </div>
            <TestMessageSender
              onSend={(chatId, msg) =>
                sendTestMessage({
                  ...pinArgs,
                  chatId,
                  ...(msg?.trim() ? { message: msg.trim() } : {}),
                })
                  .then((r: any) => toast.success(`Test message sent to ${r.chatId}`))
                  .catch(onError)
              }
            />
            <p className="text-xs text-muted-foreground">
              Telegram does not let a bot list the groups or channels it belongs to. Press{" "}
              <b>Sync chats</b> and the bot will pull every chat it has ever received an update from
              (users who pressed Start, groups/channels it was added to).
            </p>
          </Panel>
          <Panel
            title="Chats"
            hint="Each chat has its own language override and a per-chat polls toggle."
          >
            {(data.chats ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No chats yet. Add the bot to a group or channel, or send it /start.
              </p>
            ) : (
              data.chats.map((c: any) => (
                <div
                  key={c._id}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
                >
                  <div className="min-w-40 flex-1">
                    <p className="font-medium">{c.title ?? c.username ?? `Chat ${c.chatId}`}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.type} · {String(c.chatId)} {c.username ? `· @${c.username}` : ""}
                    </p>
                  </div>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                    value={c.language ?? ""}
                    onChange={(e) =>
                      updateChat({
                        ...pinArgs,
                        id: c._id,
                        language: e.target.value === "" ? null : e.target.value,
                      }).catch(onError)
                    }
                  >
                    <option value="">Use global default</option>
                    <option value="en">English</option>
                    <option value="ckb">Kurdish Sorani</option>
                  </select>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span>Polls</span>
                    <Switch
                      checked={c.pollsEnabled !== false}
                      onCheckedChange={(v) =>
                        updateChat({ ...pinArgs, id: c._id, pollsEnabled: v }).catch(onError)
                      }
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={c.active}
                      onCheckedChange={(v) =>
                        updateChat({ ...pinArgs, id: c._id, active: v }).catch(onError)
                      }
                    />
                    <span className="text-xs text-muted-foreground">
                      {c.active ? "Active" : "Muted"}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      updateChat({ ...pinArgs, id: c._id, remove: true }).catch(onError)
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))
            )}
            <div className="text-xs text-muted-foreground">
              Chats are stored locally. The bot can only message chats it is a member of — for
              groups/channels make sure the bot is an <b>admin</b> (so Telegram lets it post), and
              for private chats the user must have pressed Start on the bot.
            </div>
          </Panel>
        </TabsContent>

        {/* CADENCE */}
        <TabsContent value="cadence" className="mt-4 space-y-4">
          <Panel title="Language" hint="Global default; each chat can override it above.">
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={s["defaultLanguage"] ?? "en"}
              onChange={(e) =>
                saveSettings({ ...pinArgs, patch: { defaultLanguage: e.target.value } }).catch(
                  onError,
                )
              }
            >
              <option value="en">English only</option>
              <option value="ckb">Kurdish Sorani only</option>
              <option value="both">Both</option>
            </select>
          </Panel>
          <Panel title="Posting windows">
            <TimeWindow
              label="Daytime"
              start={s["dayStart"]}
              end={s["dayEnd"]}
              min={s["dayMinMinutes"]}
              max={s["dayMaxMinutes"]}
              onSave={(v) =>
                saveSettings({
                  ...pinArgs,
                  patch: {
                    dayStart: v.start,
                    dayEnd: v.end,
                    dayMinMinutes: v.min,
                    dayMaxMinutes: v.max,
                  },
                }).catch(onError)
              }
            />
            <Separator />
            <TimeWindow
              label="Night"
              start={s["nightStart"]}
              end={s["nightEnd"]}
              min={s["nightMinMinutes"]}
              max={s["nightMaxMinutes"]}
              onSave={(v) =>
                saveSettings({
                  ...pinArgs,
                  patch: {
                    nightStart: v.start,
                    nightEnd: v.end,
                    nightMinMinutes: v.min,
                    nightMaxMinutes: v.max,
                  },
                }).catch(onError)
              }
            />
            <Separator />
            <div className="flex items-center gap-3">
              <Switch
                checked={s["breakingInterruptsNight"]}
                onCheckedChange={(v) =>
                  saveSettings({ ...pinArgs, patch: { breakingInterruptsNight: v } }).catch(onError)
                }
              />
              <span className="text-sm">Breaking news may interrupt the night window</span>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tz">Timezone</Label>
              <Input
                id="tz"
                defaultValue={s["timezone"]}
                onBlur={(e) =>
                  e.target.value !== s["timezone"] &&
                  saveSettings({ ...pinArgs, patch: { timezone: e.target.value } }).catch(onError)
                }
                className="max-w-xs"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Next scheduled post:{" "}
              {s["nextPublishAt"]
                ? new Date(s["nextPublishAt"]).toLocaleString()
                : "as soon as the queue fills"}
            </p>
            <Separator />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cooldown">Event cooldown (hours)</Label>
                <Input
                  id="cooldown"
                  type="number"
                  min="1"
                  max="336"
                  defaultValue={s["eventCooldownHours"] ?? 72}
                  onBlur={(e) =>
                    saveSettings({
                      ...pinArgs,
                      patch: { eventCooldownHours: Number(e.target.value) },
                    }).catch(onError)
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="similarity">Similarity threshold</Label>
                <Input
                  id="similarity"
                  type="number"
                  min="0.3"
                  max="0.9"
                  step="0.01"
                  defaultValue={s["eventSimilarityThreshold"] ?? 0.52}
                  onBlur={(e) =>
                    saveSettings({
                      ...pinArgs,
                      patch: { eventSimilarityThreshold: Number(e.target.value) },
                    }).catch(onError)
                  }
                />
              </div>
            </div>
          </Panel>
        </TabsContent>

        {/* BREAKING */}
        <TabsContent value="breaking" className="mt-4">
          <Panel
            title="Breaking-news criteria"
            hint="Breaking items skip the queue and the posting interval."
          >
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((cat) => {
                const on = (s["breakingCategories"] ?? []).includes(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => {
                      const current: string[] = s["breakingCategories"] ?? [];
                      saveSettings({
                        ...pinArgs,
                        patch: {
                          breakingCategories: on
                            ? current.filter((c) => c !== cat)
                            : [...current, cat],
                        },
                      }).catch(onError);
                    }}
                  >
                    <Badge variant={on ? "default" : "secondary"}>{cat}</Badge>
                  </button>
                );
              })}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="oil">Major oil move (%)</Label>
                <Input
                  id="oil"
                  type="number"
                  step="0.1"
                  defaultValue={s["oilMoveThreshold"]}
                  onBlur={(e) =>
                    saveSettings({
                      ...pinArgs,
                      patch: { oilMoveThreshold: Number(e.target.value) },
                    }).catch(onError)
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gold">Major gold move (%)</Label>
                <Input
                  id="gold"
                  type="number"
                  step="0.1"
                  defaultValue={s["goldMoveThreshold"]}
                  onBlur={(e) =>
                    saveSettings({
                      ...pinArgs,
                      patch: { goldMoveThreshold: Number(e.target.value) },
                    }).catch(onError)
                  }
                />
              </div>
            </div>
          </Panel>
        </TabsContent>

        {/* SOURCES */}
        <TabsContent value="sources" className="mt-4 space-y-4">
          <Panel
            title="Providers"
            hint="For Telegram, enter a public @channel handle and choose Telegram channel."
          >
            {(data.sources ?? []).map((src: any) => (
              <div
                key={src._id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-44 flex-1">
                  <p className="font-medium">{src.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {src.kind} · secret: {src.secretRef ?? "none needed"} · priority {src.priority}
                  </p>
                  {src.lastError ? (
                    <p className="text-xs text-destructive">
                      {String(src.lastError).slice(0, 120)}
                    </p>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {src.dailyQuota ? `${src.usedToday}/${src.dailyQuota} used today` : "unlimited"}
                </div>
                <Switch
                  checked={src.enabled}
                  onCheckedChange={(v) =>
                    upsertSource({ ...pinArgs, id: src._id, enabled: v }).catch(onError)
                  }
                />
              </div>
            ))}
            <AddSource
              onAdd={(payload) => upsertSource({ ...pinArgs, ...(payload as any) }).catch(onError)}
            />
          </Panel>
          <Panel title="Topic queries" hint="Run against every enabled provider each cycle.">
            <div className="flex flex-wrap gap-2">
              {(data.topics ?? []).map((t: any) => (
                <span
                  key={t._id}
                  className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm"
                >
                  <button
                    type="button"
                    onClick={() =>
                      upsertTopic({ ...pinArgs, id: t._id, enabled: !t.enabled }).catch(onError)
                    }
                  >
                    <Badge variant={t.enabled ? "default" : "secondary"}>{t.query}</Badge>
                  </button>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      upsertTopic({ ...pinArgs, id: t._id, remove: true }).catch(onError)
                    }
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <AddTopic
              onAdd={(payload) => upsertTopic({ ...pinArgs, ...(payload as any) }).catch(onError)}
            />
          </Panel>
        </TabsContent>

        {/* TRANSLATION */}
        <TabsContent value="translation" className="mt-4">
          <Panel
            title="Translation provider manager"
            hint="Gemini and MiniMax keys are stored server-side. Keys are never returned to the browser; only masked metadata is shown."
          >
            <div className="rounded-md border border-border p-3 text-sm">
              <p className="font-medium">Mode</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {[
                  ["gemini_first", "Google Gemini only"],
                  ["minimax_first", "MiniMax only"],
                  ["both", "Gemini → MiniMax fallback"],
                ].map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={
                      String(s["translationMode"] ?? "gemini_first") === value
                        ? "default"
                        : "secondary"
                    }
                    onClick={() =>
                      saveSettings({ ...pinArgs, patch: { translationMode: value } }).catch(onError)
                    }
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                In Gemini-only mode, MiniMax is never called. In MiniMax-only mode, Google is never
                called. "Both" is conservative fallback mode.
              </p>
            </div>
            {(translationKeyData as any)?.hardcodedGemini?.length > 0 && (
              <div className="rounded-md border border-primary/20 bg-primary/5 p-4">
                <p className="text-sm font-semibold">🔑 Hardcoded Gemini keys</p>
                <p className="text-xs text-muted-foreground">
                  These are the admin's server-side API keys — they rotate automatically and are
                  never sent to the browser in full.
                </p>
                <ul className="mt-2 space-y-1 text-xs">
                  {((translationKeyData as any).hardcodedGemini).map(
                    (g: { index: number; first8: string; last4: string }) => (
                      <li key={g.index} className="rounded border border-border px-2 py-1 font-mono">
                        Key {g.index}: {g.first8}…{g.last4}
                      </li>
                    ),
                  )}
                </ul>
              </div>
            )}
            <TranslationKeyManager
              keys={translationKeyData?.keys ?? []}
              envDefaults={translationKeyData?.envDefaults ?? { gemini: 0, minimax: false }}
              pinArgs={pinArgs}
              onSave={(payload) =>
                upsertTranslationKey({ ...pinArgs, ...(payload as any) }).catch(onError)
              }
              onTest={(id) =>
                testTranslationKey({ ...pinArgs, id })
                  .then((r: any) => toast.success(`Translation test passed: ${r.preview}`))
                  .catch(onError)
              }
            />
            <ModelPicker
              pinArgs={pinArgs}
              onLoad={() => listTranslationModels(pinArgs as any)}
              onSave={(model) =>
                setTranslationModel({ ...(pinArgs as any), model })
                  .then((r: any) => toast.success(`Switched translation model to ${r.model}`))
                  .catch(onError)
              }
            />
          </Panel>
          <Panel
            title="Translation history"
            hint="Every successful English → Kurdish Sorani translation, with the model that produced it."
          >
            {((data as any).translationHistory ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No translations yet. Kurdish Sorani translations appear here after the bot publishes
                to a Kurdish-configured chat.
              </p>
            ) : (
              <ul className="space-y-3 text-sm">
                {(data as any).translationHistory.map((t: any) => (
                  <li key={t._id} className="rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="default">{t.model}</Badge>
                      {t.chatId ? (
                        <span className="text-xs text-muted-foreground">
                          chat {String(t.chatId)}
                        </span>
                      ) : null}
                      <span className="text-xs text-muted-foreground">
                        · {new Date(t.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-2 font-medium text-muted-foreground">
                      {t.englishText.slice(0, 200)}
                    </p>
                    <p className="mt-1 text-base leading-relaxed">{t.kurdishText.slice(0, 300)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel
            title="Translation failures"
            hint="Every configured provider/key failed or returned invalid Sorani."
          >
            {(data.translationFailures ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No failures logged.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.translationFailures.map((f: any) => (
                  <li key={f._id} className="rounded-md border border-border p-3">
                    <p className="font-medium">{f.headline}</p>
                    <p className="text-xs text-muted-foreground">
                      {f.targetLanguage} · tried {(f.modelsTried ?? []).join(", ")} · {f.detail}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>

        {/* POLLS */}
        <TabsContent value="polls" className="mt-4 space-y-4">
          <Panel
            title="Polls on breaking events"
            hint="Telegram polls are auto-posted after breaking news, in chat language (or Kurdish Sorani by default)."
          >
            <div className="flex flex-wrap items-center gap-4 rounded-md border border-border p-3 text-sm">
              <Switch
                checked={Boolean(s["pollsEnabled"])}
                onCheckedChange={(v) =>
                  saveSettings({ ...pinArgs, patch: { pollsEnabled: v } }).catch(onError)
                }
              />
              <span>Polls enabled globally</span>
              <div className="flex items-center gap-1">
                <Label className="text-xs">Max per chat per hour</Label>
                <Input
                  type="number"
                  min="0"
                  max="6"
                  className="w-20"
                  defaultValue={s["pollsMaxPerHour"] ?? 1}
                  onBlur={(e) =>
                    saveSettings({
                      ...pinArgs,
                      patch: { pollsMaxPerHour: Math.max(0, Number(e.target.value || 0)) },
                    }).catch(onError)
                  }
                />
              </div>
              <div className="flex items-center gap-1">
                <Label className="text-xs">Auto-close (minutes)</Label>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  className="w-20"
                  defaultValue={s["pollsAutoCloseMinutes"] ?? 60}
                  onBlur={(e) =>
                    saveSettings({
                      ...pinArgs,
                      patch: {
                        pollsAutoCloseMinutes: Math.max(
                          1,
                          Math.min(10, Number(e.target.value || 0)),
                        ),
                      },
                    }).catch(onError)
                  }
                />
              </div>
              <div className="flex items-center gap-1">
                <Label className="text-xs">Default language</Label>
                <select
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={s["pollsDefaultLanguage"] ?? "chat"}
                  onChange={(e) =>
                    saveSettings({
                      ...pinArgs,
                      patch: { pollsDefaultLanguage: e.target.value },
                    }).catch(onError)
                  }
                >
                  <option value="chat">Match chat language</option>
                  <option value="ckb">Always Kurdish Sorani</option>
                  <option value="en">Always English</option>
                </select>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 rounded-md border border-border p-3 text-sm">
              <p className="w-full text-xs font-medium text-muted-foreground">
                Categories that trigger a poll (click to toggle)
              </p>
              {CATEGORIES.map((cat) => {
                const on = (s["pollsCategories"] ?? ["war", "iran", "proxies", "usa"]).includes(
                  cat,
                );
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => {
                      const current: string[] = s["pollsCategories"] ?? [
                        "war",
                        "iran",
                        "proxies",
                        "usa",
                      ];
                      saveSettings({
                        ...pinArgs,
                        patch: {
                          pollsCategories: on
                            ? current.filter((c) => c !== cat)
                            : [...current, cat],
                        },
                      }).catch(onError);
                    }}
                  >
                    <Badge variant={on ? "default" : "secondary"}>{cat}</Badge>
                  </button>
                );
              })}
            </div>
            <TestPollSender
              onSend={(chatId) =>
                testPoll({ ...pinArgs, chatId })
                  .then((r: any) => toast.success(`Poll sent: ${r.question}`))
                  .catch(onError)
              }
            />
          </Panel>
          {/* ACTIVITY */}
          <TabsContent value="activity" className="mt-4">
            <Panel
              title="Recent activity"
              hint="Every pipeline event, admin action, chat change, and error. Auto-pruned: entries older than 48 hours are deleted, and only the newest 500 are kept."
            >
              <ActivityFeed items={data.recentActivity ?? []} />
            </Panel>
          </TabsContent>

          <Panel title="Recent polls" hint="Telegram keeps vote counts — refresh to see updates.">
            {((data as any).polls ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No polls yet. Hit &ldquo;Send poll&rdquo; above to send one now.
              </p>
            ) : (
              <ul className="space-y-3 text-sm">
                {(data as any).polls.map((p: any) => (
                  <li key={p._id} className="rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={p.language === "ckb" ? "default" : "secondary"}>
                        {p.language === "ckb" ? "Sorani" : "English"}
                      </Badge>
                      <span className="text-xs text-muted-foreground">chat {String(p.chatId)}</span>
                      <span className="text-xs text-muted-foreground">
                        · {new Date(p.createdAt).toLocaleString()}
                      </span>
                      {p.closedAt ? <Badge variant="outline">closed</Badge> : null}
                    </div>
                    <p className="mt-2 font-medium">{p.question}</p>
                    <ul className="ml-4 mt-1 list-disc text-xs text-muted-foreground">
                      {p.options.map((o: string, i: number) => (
                        <li key={i} className={p.mostVotedIndex === i ? "text-primary" : ""}>
                          {o}
                          {p.mostVotedIndex === i ? " 🏆" : ""}
                        </li>
                      ))}
                    </ul>
                    {p.totalVoterCount !== undefined ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {p.totalVoterCount} vote(s)
                      </p>
                    ) : null}
                    {p.itemHeadline ? (
                      <p className="mt-2 text-xs italic text-muted-foreground">
                        After: {p.itemHeadline}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TranslationKeyManager({
  keys,
  envDefaults,
  onSave,
  onTest,
  busy,
  pinArgs,
}: {
  keys: any[];
  envDefaults: { gemini: number; minimax: boolean };
  onSave: (v: any) => void;
  onTest: (id: string) => void;
  busy?: boolean;
  pinArgs: { pin?: string };
}) {
  const [provider, setProvider] = useState<"gemini" | "minimax">("gemini");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gemini-2.5-flash");
  const [priority, setPriority] = useState(10);
  function add() {
    if (!label.trim() || !apiKey.trim()) return;
    onSave({ provider, label: label.trim(), apiKey: apiKey.trim(), model, priority });
    setLabel("");
    setApiKey("");
  }
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border p-3">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={provider}
            onChange={(e) => {
              const v = e.target.value as "gemini" | "minimax";
              setProvider(v);
              setModel(v === "gemini" ? "gemini-2.5-flash" : "minimax/minimax-m3");
            }}
          >
            <option value="gemini">Google Gemini</option>
            <option value="minimax">MiniMax / Vercel</option>
          </select>
          <Input placeholder="Key label" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Input
            placeholder="API key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Input placeholder="Model" value={model} onChange={(e) => setModel(e.target.value)} />
          <Button size="sm" onClick={add} disabled={busy || !label.trim() || !apiKey.trim()}>
            Add key
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Environment defaults detected: {envDefaults?.gemini ?? 0} Gemini key(s),{" "}
          {envDefaults?.minimax ? "MiniMax configured" : "no MiniMax gateway key"}.
        </p>
      </div>
      {keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No database-managed translation keys. Environment keys will still work.
        </p>
      ) : (
        keys.map((key: any) => (
          <div
            key={key._id}
            className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
          >
            <div className="min-w-52 flex-1">
              <p className="font-medium">
                {key.label} <Badge variant="secondary">{key.provider}</Badge>
              </p>
              <p className="text-xs text-muted-foreground">
                {key.model} · priority {key.priority} · {key.enabled ? "enabled" : "disabled"} ·
                last status {key.lastStatus ?? "—"}
              </p>
              {key.cooldownUntil ? (
                <p className="text-xs text-destructive">
                  Cooldown until {new Date(key.cooldownUntil).toLocaleTimeString()}
                </p>
              ) : null}
              {key.lastError ? (
                <p className="text-xs text-muted-foreground">
                  {String(key.lastError).slice(0, 140)}
                </p>
              ) : null}
            </div>
            <Switch
              checked={key.enabled}
              onCheckedChange={(v) =>
                onSave({
                  id: key._id,
                  provider: key.provider,
                  label: key.label,
                  model: key.model,
                  enabled: v,
                  priority: key.priority,
                })
              }
            />
            <Button size="sm" variant="secondary" onClick={() => onTest(key._id)} disabled={busy}>
              Test
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                const lbl = window.prompt("Key label", key.label);
                if (lbl === null) return;
                const mdl = window.prompt("Model", key.model);
                if (mdl === null) return;
                const pri = window.prompt("Priority", String(key.priority));
                if (pri === null) return;
                const ak = window.prompt("New API key (Cancel = keep current)", "");
                onSave({
                  id: key._id,
                  provider: key.provider,
                  label: lbl.trim(),
                  model: mdl.trim(),
                  priority: Number(pri) || key.priority,
                  ...(ak?.trim() ? { apiKey: ak.trim() } : {}),
                });
              }}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() =>
                onSave({
                  id: key._id,
                  provider: key.provider,
                  label: key.label,
                  model: key.model,
                  priority: key.priority,
                  remove: true,
                })
              }
              disabled={busy}
            >
              Remove
            </Button>
          </div>
        ))
      )}
    </div>
  );
}

function TestPollSender({ onSend }: { onSend: (chatId: number) => void }) {
  const [chatId, setChatId] = useState("");
  function send() {
    const id = Number(chatId.trim().replace(/^@/, ""));
    if (!id || Number.isNaN(id)) {
      toast.error("Enter a valid numeric chat ID");
      return;
    }
    onSend(id);
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
      <div className="min-w-36 flex-1">
        <p className="text-xs font-medium text-muted-foreground">Send a test poll</p>
        <p className="text-xs text-muted-foreground/70">
          Uses a sample breaking-news headline to demonstrate what an auto-poll looks like.
        </p>
      </div>
      <Input
        className="max-w-40"
        placeholder="Chat ID"
        inputMode="numeric"
        value={chatId}
        onChange={(e) => setChatId(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && send()}
      />
      <Button size="sm" onClick={send} disabled={!chatId.trim()}>
        Send poll
      </Button>
    </div>
  );
}

function TestMessageSender({ onSend }: { onSend: (chatId: number, message: string) => void }) {
  const [chatId, setChatId] = useState("");
  const [message, setMessage] = useState("");
  function send() {
    const id = Number(chatId.trim().replace(/^@/, ""));
    if (!id || Number.isNaN(id)) {
      toast.error(
        "Enter a valid numeric chat ID (e.g. 123456789, or -1001234567890 for a channel)",
      );
      return;
    }
    onSend(id, message);
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
      <div className="min-w-36 flex-1">
        <p className="text-xs font-medium text-muted-foreground">Send a test message</p>
        <p className="text-xs text-muted-foreground/70">
          Find chat IDs via @userinfobot or by syncing chats. Group/channel IDs are negative.
        </p>
      </div>
      <Input
        className="max-w-40"
        placeholder="Chat ID"
        inputMode="numeric"
        value={chatId}
        onChange={(e) => setChatId(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && send()}
      />
      <Input
        className="max-w-64"
        placeholder="Optional custom message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && send()}
      />
      <Button size="sm" onClick={send} disabled={!chatId.trim()}>
        Send test
      </Button>
    </div>
  );
}

function ModelPicker({
  pinArgs,
  onLoad,
  onSave,
}: {
  pinArgs: { pin?: string };
  onLoad: () => Promise<{ supported: string[]; current: string }>;
  onSave: (model: string) => Promise<unknown>;
}) {
  const [supported, setSupported] = useState<string[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [pendingModel, setPendingModel] = useState<string>("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await onLoad();
        if (cancelled) return;
        setSupported(r.supported ?? []);
        setCurrent(r.current ?? "");
        setPendingModel(r.current ?? "");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load model list");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinArgs.pin]);

  const currentLabel: Record<string, string> = {
    "google/gemini-2.5-flash-lite": "2.5 Flash-Lite — fastest, lowest cost, great for polls",
    "google/gemini-2.5-flash": "2.5 Flash — fast, solid quality, default for big batches",
    "google/gemini-2.5-pro": "2.5 Pro — slower, smarter, ideal for editor-grade rewrites",
    "google/gemini-3-pro-preview": "Gemini 3 Pro Preview — newest frontier, strongest reasoning",
  };

  return (
    <div className="rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">Gemini translation model</p>
          <p className="text-xs text-muted-foreground">
            Currently:{" "}
            <span className="text-foreground">{loading ? "loading…" : current || "not set"}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-9 min-w-72 rounded-md border border-input bg-background px-2 text-sm"
            value={pendingModel}
            onChange={(e) => setPendingModel(e.target.value)}
            disabled={loading || supported.length === 0}
          >
            {supported.length === 0 ? (
              <option value="">No models available</option>
            ) : (
              supported.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {currentLabel[m] ? ` — ${currentLabel[m]}` : ""}
                </option>
              ))
            )}
          </select>
          <Button
            size="sm"
            onClick={() => onSave(pendingModel)}
            disabled={loading || !pendingModel || pendingModel === current}
          >
            Apply model
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        All three keys rotate automatically, so picking the model here is independent of which API
        key is used.
      </p>
    </div>
  );
}

function TimeWindow({
  label,
  start,
  end,
  min,
  max,
  onSave,
}: {
  label: string;
  start: string;
  end: string;
  min: number;
  max: number;
  onSave: (v: { start: string; end: string; min: number; max: number }) => void;
}) {
  const [v, setV] = useState({
    start: (start ?? "08:00").slice(0, 5),
    end: (end ?? "23:00").slice(0, 5),
    min: min ?? 25,
    max: max ?? 60,
  });
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label} window</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs">Start</Label>
          <Input
            type="time"
            value={v.start}
            onChange={(e) => setV({ ...v, start: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">End</Label>
          <Input type="time" value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Min minutes</Label>
          <Input
            type="number"
            value={v.min}
            onChange={(e) => setV({ ...v, min: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Max minutes</Label>
          <Input
            type="number"
            value={v.max}
            onChange={(e) => setV({ ...v, max: Number(e.target.value) })}
          />
        </div>
      </div>
      <Button size="sm" variant="secondary" onClick={() => onSave(v)}>
        Save {label.toLowerCase()} window
      </Button>
    </div>
  );
}

function AddTopic({ onAdd }: { onAdd: (v: { query: string; category: string }) => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("iran");
  return (
    <div className="flex flex-wrap gap-2">
      <Input
        className="max-w-xs"
        placeholder="New topic query"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <select
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      >
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          if (query.trim()) {
            onAdd({ query: query.trim(), category });
            setQuery("");
          }
        }}
      >
        Add topic
      </Button>
    </div>
  );
}

const ACTIVITY_TYPES = [
  { value: "all", label: "All" },
  { value: "ingest", label: "🔄 Ingest" },
  { value: "publish", label: "📨 Publish" },
  { value: "breaking", label: "🚨 Breaking" },
  { value: "poll", label: "📊 Poll" },
  { value: "translation", label: "🌐 Translation" },
  { value: "chat", label: "💬 Chat" },
  { value: "admin", label: "🛠 Admin" },
  { value: "system", label: "⚙️ System" },
];

const ACTIVITY_TYPE_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  breaking: "destructive",
  publish: "default",
  ingest: "secondary",
  poll: "secondary",
  translation: "outline",
  chat: "outline",
  admin: "outline",
  system: "outline",
};

const ACTIVITY_LEVEL_DOT: Record<string, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
  info: "bg-slate-400",
};

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function ActivityFeed({ items }: { items: any[] }) {
  const [filter, setFilter] = useState("all");
  const shown = filter === "all" ? items : items.filter((a) => a.type === filter);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {ACTIVITY_TYPES.map((t) => (
          <Button
            key={t.value}
            size="sm"
            variant={filter === t.value ? "default" : "secondary"}
            onClick={() => setFilter(t.value)}
          >
            {t.label}
          </Button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No activity yet{filter !== "all" ? ` for “${filter}”` : ""}. Events appear here as the bot
          fetches, publishes, and runs.
        </p>
      ) : (
        <ul className="space-y-2">
          {shown.map((a: any) => (
            <li key={a._id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${ACTIVITY_LEVEL_DOT[a.level] ?? ACTIVITY_LEVEL_DOT.info}`}
                />
                <Badge variant={ACTIVITY_TYPE_VARIANT[a.type] ?? "outline"}>{a.type}</Badge>
                <span className="min-w-0 flex-1 text-sm font-medium">{a.message}</span>
                <span
                  className="shrink-0 text-xs text-muted-foreground"
                  title={new Date(a.createdAt).toLocaleString()}
                >
                  {timeAgo(a.createdAt)}
                </span>
              </div>
              {a.detail ? (
                <p className="mt-1 pl-4 text-xs text-muted-foreground">{a.detail}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Auto-retention: entries older than 48 hours are deleted, and the log is capped at the newest
        500 events.
      </p>
    </div>
  );
}

function AddSource({
  onAdd,
}: {
  onAdd: (v: { name: string; kind: string; secretRef: string | null }) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("rss");
  const [secretRef, setSecretRef] = useState("");
  return (
    <div className="flex flex-wrap gap-2">
      <Input
        className="max-w-48"
        placeholder={kind === "telegram" ? "@channel" : "Provider name"}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={kind}
        onChange={(e) => setKind(e.target.value)}
      >
        <option value="rss">RSS provider</option>
        <option value="newsdata">NewsData</option>
        <option value="telegram">Telegram channel</option>
      </select>
      <Input
        className="max-w-48"
        placeholder="SECRET_NAME (optional)"
        value={secretRef}
        onChange={(e) => setSecretRef(e.target.value)}
      />
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          if (!name.trim()) return;
          onAdd({ name: name.trim(), kind, secretRef: secretRef.trim() || null });
          setName("");
          setSecretRef("");
        }}
      >
        Add provider
      </Button>
    </div>
  );
}
