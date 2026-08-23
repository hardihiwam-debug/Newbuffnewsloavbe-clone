// AI & Translation tab — the AI decision pipeline: final AI dedup, translation
// model selection + fallback order, provider keys, live Gemini quota usage,
// glossary, and translation history/failures. (Previously split across the old
// "AI & Quality" and "Translation" tabs.)

import { useCallback, useEffect, useRef, useState } from "react";
import { GlossaryEditor } from "./GlossaryEditor";
import { adminApi, adminActionsApi } from "@/lib/adminApi";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  Flame,
  GripVertical,
  Languages,
  ListOrdered,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Terminal,
  Trash2,
  Wand2,
} from "lucide-react";
import {
  Card,
  CompactInput,
  CompactSelect,
  CompactToggle,
  IconBtn,
  Row,
  SubText,
  useSettings,
} from "./shared";

const DEFAULT_MODEL_ORDER = ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "google/gemini-2.5-flash", "google/gemini-2.5-flash-lite", "minimax/minimax-m3"];

export function AiTranslationTab() {
  const {
    s,
    save,
    pin,
    pinArgs,
    onError,
    tkeys,
    envGeminiCount,
    geminiUsage,
    translationHistory,
    translationFailures,
    upsertTranslationKey,
    testTranslationKey,
    testGeminiKeys,
    listTranslationModels,
    getRewriteLog,
    getRewriteAnalytics,
    setTranslationModel,
  } = useSettings();

  // Translation models
  const [models, setModels] = useState<string[]>([]);
  const [currentModel, setCurrentModel] = useState("");
  const [geminiTest, setGeminiTest] = useState<any | null>(null);
  const [geminiTesting, setGeminiTesting] = useState(false);
  const [geminiConfirm, setGeminiConfirm] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());
  // Translation model order (drag-to-reorder chain). Seeded once from the
  // server, then kept in local state so the poll can't clobber a drag in
  // flight. NULL/empty on the server = the default Gemini-first chain.
  const [modelOrder, setModelOrder] = useState<string[] | null>(null);
  const [modelOrderSeeded, setModelOrderSeeded] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  // AI rewrite log (structured rewrite feedback — separate from the newsroom
  // feed). Fetched on mount + on demand via the refresh button.
  const [rewriteLog, setRewriteLog] = useState<any[]>([]);
  const [rewriteLoading, setRewriteLoading] = useState(false);
  const [expandedLog, setExpandedLog] = useState<Set<string>>(new Set());
  const loadRewriteLog = (silent = false) => {
    if (!pin) return;
    if (!silent) setRewriteLoading(true);
    getRewriteLog({ pin })
      .then((r: any) => setRewriteLog(Array.isArray(r?.entries) ? r.entries : []))
      .catch(() => {})
      .finally(() => setRewriteLoading(false));
  };
  // Rewrite analytics (7-day success/fallback rates, per-provider health +
  // latency, daily trend) — same fetch cadence as the rewrite log.
  const [rewriteAnalytics, setRewriteAnalytics] = useState<any | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const loadRewriteAnalytics = (silent = false) => {
    if (!pin) return;
    if (!silent) setAnalyticsLoading(true);
    getRewriteAnalytics({ pin })
      .then((r: any) => setRewriteAnalytics(r ?? null))
      .catch(() => {})
      .finally(() => setAnalyticsLoading(false));
  };
  useEffect(() => {
    loadRewriteLog(true);
    loadRewriteAnalytics(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);
  useEffect(() => {
    if (modelOrderSeeded || !s?.translationModelOrder) return;
    setModelOrderSeeded(true);
    const raw = (s as Record<string, any>)?.translationModelOrder;
    if (Array.isArray(raw) && raw.length > 0) setModelOrder(raw.map((x: unknown) => String(x)));
  }, [s?.translationModelOrder, modelOrderSeeded]);
  const order = modelOrder ?? DEFAULT_MODEL_ORDER;
  const commitOrder = (next: string[]) => {
    setModelOrder(next);
    save({ translationModelOrder: next });
  };
  const moveModel = (idx: number, dir: -1 | 1) => {
    const next = [...order];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    commitOrder(next);
  };
  const dropModel = (targetIdx: number) => {
    if (dragIdx === null || dragIdx === targetIdx) {
      setDragIdx(null);
      return;
    }
    const next = [...order];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(targetIdx, 0, moved);
    setDragIdx(null);
    commitOrder(next);
  };

  useEffect(() => {
    if (!pin) return;
    listTranslationModels({ pin }).then((r) => {
      // Accept both the Convex-era { supported, current } and the ported
      // { models } shapes so a shape drift can never leave `models` undefined
      // and crash the Translation tab with a .map-of-undefined error.
      setModels(Array.isArray(r?.supported) ? r.supported : (r?.models ?? []));
      setCurrentModel(String(r?.current ?? ""));
    }).catch(() => {});
  }, [pin]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
      <AiControlPlane pin={pin} onError={onError} />
          <Card icon={Cpu} id="ai-dedup" title="AI Dedup" hint="Final duplicate check (Groq/OpenRouter/Cloudflare)">
                <div className="space-y-3">
                  <CompactToggle
                    label="Enable AI final dedup"
                    checked={s["aiDedupEnabled"] !== false}
                    onChange={(v) => save({ aiDedupEnabled: v })}
                    hint="AI double-checks borderline candidates before publishing"
                  />
                  <CompactSelect
                    label="Look-back window"
                    value={s["aiDedupMode"] ?? "both"}
                    onChange={(v) => save({ aiDedupMode: v })}
                    options={[
                      { value: "hours", label: "Hours" },
                      { value: "posts", label: "Posts" },
                      { value: "both", label: "Hours + posts" },
                    ]}
                  />
                  <CompactInput
                    label="Hours to look back"
                    value={s["aiDedupWindowHours"] ?? 72}
                    onChange={(v) => save({ aiDedupWindowHours: Math.max(1, Number(v) || 72) })}
                    type="number"
                    min={1}
                    max={720}
                  />
                  <CompactInput
                    label="Max posts to compare"
                    value={s["aiDedupMaxPosts"] ?? 30}
                    onChange={(v) => save({ aiDedupMaxPosts: Math.max(1, Number(v) || 30) })}
                    type="number"
                    min={1}
                    max={200}
                  />
                  <CompactSelect
                    label="AI provider"
                    value={s["aiDedupProvider"] ?? "groq"}
                    onChange={(v) => save({ aiDedupProvider: v })}
                    options={[
                      { value: "groq", label: "Groq" },
                      { value: "openrouter", label: "OpenRouter" },
                      { value: "cloudflare", label: "Cloudflare" },
                    ]}
                  />
                </div>
              </Card>

    <Card icon={Cpu} id="translation-provider" title="Translation Provider" hint="Model selection">
                <div className="space-y-2">
                  <CompactSelect
                    label="Gemini model"
                    value={currentModel}
                    onChange={(v) =>
                      setTranslationModel({ ...pinArgs, model: v })
                        .then(() => {
                          setCurrentModel(v);
                          toast.success(`Model switched to ${v}`);
                        })
                        .catch(onError)
                    }
                    options={models.map((m) => ({ value: m, label: m }))}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-[11px] gap-1"
                    onClick={() =>
                      listTranslationModels({ pin }).then((r) => {
                        setModels(Array.isArray(r?.supported) ? r.supported : (r?.models ?? []));
                        setCurrentModel(String(r?.current ?? ""));
                        toast.success("Models refreshed");
                      }).catch(onError)
                    }
                  >
                    <RefreshCw className="h-3 w-3" /> Refresh models
                  </Button>
                </div>
              </Card>

                <Card icon={ListOrdered} id="translation-model-order" title="Translation model order" hint="Tried top to bottom — drag to reorder" className="lg:col-span-3">
                  <div className="space-y-2">
                    <p className="text-[11px] text-muted-foreground">
                      The first model that answers is used. Gemini models run against every configured Gemini key; MiniMax is the fallback
                      unless you move it higher. Drag to reorder, or use the arrows — saved instantly.
                    </p>
                    <div className="space-y-1.5">
                      {order.map((model, i) => (
                        <div
                          key={model}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "move";
                            setDragIdx(i);
                          }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => dropModel(i)}
                          className={`flex items-center gap-2 rounded-md border px-3 py-2 transition-colors ${
                            dragIdx === i ? "border-primary/60 bg-primary/5" : "border-border bg-muted/40"
                          }`}
                        >
                          <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-card-foreground">{model}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">#{i + 1}</span>
                          <button
                            type="button"
                            disabled={i === 0}
                            onClick={() => moveModel(i, -1)}
                            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                            title="Move up"
                          >
                            <ChevronUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={i === order.length - 1}
                            onClick={() => moveModel(i, 1)}
                            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                            title="Move down"
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => commitOrder(DEFAULT_MODEL_ORDER)}
                      className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <RotateCcw className="h-3 w-3" /> Reset to default order
                    </button>
                  </div>
                </Card>

    <Card
                icon={Terminal}
                id="translation-keys"
                title="Translation API Keys"
                hint={`${tkeys.length} stored${envGeminiCount > 0 ? ` · ${envGeminiCount} env` : ""}`}
                action={
                  <AddKeyButton
                    onSave={(provider, label, apiKey, model, priority) =>
                      upsertTranslationKey({ ...pinArgs, provider, label, apiKey, model, priority }).catch(onError)
                    }
                  />
                }
                className="lg:col-span-3"
              >
                <div className="space-y-1 max-h-[16rem] overflow-y-auto">
                  {tkeys.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground py-2">
                      {envGeminiCount > 0
                        ? `No keys stored here — using ${envGeminiCount} Gemini key(s) from the environment (GEMINI_API_KEY_1..${envGeminiCount}); live usage is in the Gemini Key Usage card below. Add MiniMax, Groq, OpenRouter or extra Gemini keys here to extend the pool.`
                        : "No translation keys yet — add GEMINI_API_KEY_1..6 under Keys/API keys, or store a provider key here."}
                    </p>
                  ) : (
                    tkeys.map((k: any) => (
                      <Row key={k._id}>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium truncate text-foreground">{k.label}</p>
                          <SubText>
                            {k.provider} · {k.model} · {k.apiKey ?? "••••"}
                          </SubText>
                        </div>
                        <Badge
                          variant="secondary"
                          className={`text-[10px] shrink-0 ${k.consecutiveFailures > 0 ? "bg-destructive/10 text-destructive" : "bg-healthy/10 text-healthy"}`}
                        >
                          {k.consecutiveFailures > 0 ? `${k.consecutiveFailures} fails` : "active"}
                        </Badge>
                        <Switch
                          checked={k.enabled !== false}
                          onCheckedChange={(v) =>
                            upsertTranslationKey({
                              ...pinArgs,
                              id: k._id,
                              provider: k.provider,
                              label: k.label,
                              model: k.model,
                              enabled: v,
                            }).catch(onError)
                          }
                          className="data-[state=checked]:bg-primary scale-75"
                        />
                        <IconBtn
                          title="Test"
                          tone="primary"
                          onClick={() => {
                            const id = toast.loading("Testing key…");
                            testTranslationKey({ pin, id: k._id })
                              .then(() => {
                                toast.dismiss(id);
                                toast.success("Key OK");
                              })
                              .catch((e) => {
                                toast.dismiss(id);
                                onError(e);
                              });
                          }}
                        >
                          <Activity className="h-3.5 w-3.5" />
                        </IconBtn>
                        <IconBtn
                          title="Delete"
                          tone="danger"
                          onClick={() =>
                            upsertTranslationKey({
                              ...pinArgs,
                              id: k._id,
                              provider: k.provider,
                              label: k.label,
                              model: k.model,
                              remove: true,
                            }).catch(onError)
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconBtn>
                      </Row>
                    ))
                  )}
                </div>
                {envGeminiCount > 0 ? (
                  <div className="flex items-center gap-1 flex-wrap pt-2 border-t border-border/60">
                    <span className="text-[10px] text-muted-foreground">Env Gemini keys (auto):</span>
                    {Array.from({ length: envGeminiCount }, (_, i) => (
                      <Badge key={i} variant="secondary" className="text-[10px]">
                        GEMINI_API_KEY_{i + 1}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </Card>

    <Card
                icon={Flame}
                id="gemini-usage"
                title="Gemini Key Usage"
                hint="Per-key × per-model usage + live quota check"
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-[11px] gap-1"
                    disabled={geminiTesting}
                    onClick={() => {
                      // Real quota spend: every configured key × model is fired
                      // directly at Google. Require a second click to confirm so
                      // an accidental tap doesn't burn the day's quota.
                      if (!geminiConfirm) {
                        setGeminiConfirm(true);
                        toast.warning(
                          "Live quota check — fires one request per Gemini key × model. Click again to confirm.",
                        );
                        setTimeout(() => setGeminiConfirm(false), 8000);
                        return;
                      }
                      setGeminiConfirm(false);
                      setGeminiTesting(true);
                      const id = toast.loading("Testing every Gemini key × model…");
                      testGeminiKeys({ pin })
                        .then((r) => {
                          setGeminiTest(r);
                          toast.dismiss(id);
                          const limited = (r.keys ?? []).reduce(
                            (n: number, k: any) =>
                              n + (k.models ?? []).filter((m: any) => m.status === "rate_limited").length,
                            0,
                          );
                          const ok = (r.keys ?? []).reduce(
                            (n: number, k: any) =>
                              n + (k.models ?? []).filter((m: any) => m.status === "ok").length,
                            0,
                          );
                          toast.success(`Checked: ${ok} usable, ${limited} rate-limited`);
                        })
                        .catch((e) => {
                          toast.dismiss(id);
                          onError(e);
                        })
                        .finally(() => setGeminiTesting(false));
                    }}
                  >
                    <Flame className="h-3 w-3" />
                    {geminiTesting ? "Testing…" : geminiConfirm ? "Confirm?" : "Test all keys"}
                  </Button>
                }
                className="lg:col-span-3"
              >
                <div className="space-y-1 max-h-[20rem] overflow-y-auto">
                  {geminiUsage.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground py-2">
                      No GEMINI_API_KEY_1..6 keys are configured.
                    </p>
                  ) : (
                    geminiUsage.map((g: any) => {
                      const rows = Object.entries(g.models ?? {});
                      return (
                        <div key={g.keyIndex} className="rounded-md border border-border px-3 py-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-foreground">Key {g.keyIndex}</span>
                            <span className="text-[10px] text-muted-foreground font-mono break-all">
                              {g.configured ? `${g.email ? `${g.email} · ` : ""}${g.first8}…${g.last4}` : "not configured"}
                            </span>
                            {!g.configured ? (
                              <Badge variant="secondary" className="text-[10px]">not configured</Badge>
                            ) : g.unused ? (
                              <Badge variant="secondary" className="text-[10px]">unused</Badge>
                            ) : null}
                            <span className="ml-auto text-[10px] text-muted-foreground">
                              today {g.today.calls} · total {g.total.calls} · 429 {g.total.rateLimited}
                            </span>
                          </div>
                          <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-3 gap-1">
                            {rows.length === 0 ? (
                              <span className="text-[10px] text-muted-foreground">no usage yet</span>
                            ) : (
                              rows.map(([model, v]: [string, any]) => (
                                <div
                                  key={model}
                                  className="rounded bg-muted/40 px-2 py-1 text-[10px] leading-tight"
                                >
                                  <span className="font-medium text-foreground">
                                    {model.replace(/^gemini-/, "")}
                                  </span>
                                  <span className="block text-muted-foreground">
                                    {v.calls} calls · {v.ok} ok · {v.rateLimited} 429
                                  </span>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
    
                {geminiTest ? (
                  <div className="mt-3 border-t border-border pt-3">
                    <p className="text-[11px] font-medium text-muted-foreground mb-1.5">Live check result</p>
                    <div className="space-y-1">
                      {(geminiTest.keys ?? []).map((k: any) => (
                        <div key={k.keyIndex} className="flex items-center gap-2 text-[11px] flex-wrap">
                          <span className="font-medium text-foreground w-12 shrink-0">Key {k.keyIndex}</span>
                          {k.email ? <span className="text-[10px] text-muted-foreground">{k.email}</span> : null}
                          {(k.models ?? []).map((mm: any) => (
                            <Badge
                              key={mm.model}
                              variant="secondary"
                              className={`text-[10px] ${
                                mm.status === "ok"
                                  ? "bg-healthy/10 text-healthy"
                                  : mm.status === "rate_limited"
                                    ? "bg-review/10 text-review"
                                    : "bg-destructive/10 text-destructive"
                              }`}
                              title={mm.detail}
                            >
                              {mm.model.replace(/^gemini-/, "")}: {mm.status}
                            </Badge>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </Card>

    <details id="ai-diagnostics" className="lg:col-span-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
      <summary className="flex cursor-pointer list-none items-baseline gap-2 text-sm font-semibold text-card-foreground [&::-webkit-details-marker]:hidden">
        Diagnostics &amp; logs
        <span className="text-[11px] font-normal text-muted-foreground">Translation history, failures, rewrite log &amp; analytics</span>
      </summary>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
    <Card
                icon={Clock}
                id="translation-history"
                title="Translation History"
                hint={`${translationHistory.length} recent`}
                className="lg:col-span-2"
              >
                <div className="space-y-1 max-h-[16rem] overflow-y-auto">
                  {translationHistory.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground py-2">No translations yet.</p>
                  ) : (
                    translationHistory.map((h: any, i: number) => {
                      const id = String(h._id ?? i);
                      const expanded = expandedHistory.has(id);
                      return (
                        <div
                          key={id}
                          className="rounded-md border border-border px-3 py-2 text-[11px] cursor-pointer hover:border-primary/40 transition-colors"
                          onClick={() =>
                            setExpandedHistory((prev) => {
                              const next = new Set(prev);
                              if (next.has(id)) next.delete(id);
                              else next.add(id);
                              return next;
                            })
                          }
                          title={expanded ? "Click to collapse" : "Click to expand full post"}
                        >
                          <p
                            className={`font-medium text-foreground ${
                              expanded ? "whitespace-pre-wrap break-words" : "truncate"
                            }`}
                            dir="rtl"
                          >
                            {h.kurdishText}
                          </p>
                          <p
                            className={`text-muted-foreground mt-0.5 ${
                              expanded ? "whitespace-pre-wrap break-words" : "truncate"
                            }`}
                          >
                            {h.englishText}
                          </p>
                          <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                            <span>
                              {String(h.model ?? "").replace(/^([a-z]+)[:/]/, "").replace(/^gemini-/, "")}
                            </span>
                            <span>·</span>
                            <span>{h.createdAt ? new Date(h.createdAt).toLocaleString() : ""}</span>
                            <span className="ml-auto text-primary">{expanded ? "▲ collapse" : "▼ expand"}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </Card>

    <Card
                icon={AlertTriangle}
                id="translation-failures"
                title="Translation Failures"
                hint={`${translationFailures.length} recent`}
                className="lg:col-span-2"
              >
                <div className="space-y-1 max-h-[16rem] overflow-y-auto">
                  {translationFailures.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground py-2">
                      <CheckCircle className="h-3 w-3 inline mr-1 text-healthy" />
                      All translations passing
                    </p>
                  ) : (
                    translationFailures.map((f: any, i: number) => (
                      <div
                        key={f._id ?? i}
                        className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-[11px]"
                      >
                        <p className="font-medium text-destructive truncate">
                          {f.detail || f.headline || "Unknown error"}
                        </p>
                        {f.headline ? (
                          <p className="text-destructive/70 truncate mt-0.5">{f.headline}</p>
                        ) : null}
                        <div className="flex items-center gap-2 mt-1 text-[10px] text-destructive/70">
                          <span className="truncate">{(f.modelsTried ?? []).join(", ") || "—"}</span>
                          <span>·</span>
                          <span>{f.createdAt ? new Date(f.createdAt).toLocaleString() : ""}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </Card>

    <Card
                icon={Wand2}
                id="rewrite-log"
                title="AI Rewrite Log"
                hint={`${rewriteLog.length} recent${rewriteLoading ? " · loading…" : ""}`}
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-[11px] gap-1"
                    disabled={rewriteLoading}
                    onClick={() => {
                      loadRewriteLog();
                      loadRewriteAnalytics();
                    }}
                  >
                    <RefreshCw className={`h-3 w-3 ${rewriteLoading ? "animate-spin" : ""}`} />
                    {rewriteLoading ? "Loading…" : "Refresh"}
                  </Button>
                }
                className="lg:col-span-2"
              >
                <div className="space-y-1 max-h-[20rem] overflow-y-auto">
                  {rewriteLog.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground py-2">
                      No rewrite attempts yet — the AI rewrite runs on web items only (NewsData / Google News
                      RSS / publisher feeds); Telegram items skip this step. Enable a web source under Sources and
                      every rewrite attempt lands here, success or failure.
                    </p>
                  ) : (
                    rewriteLog.map((r: any, i: number) => {
                      const id = String(r._id ?? i);
                      const expanded = expandedLog.has(id);
                      const ok = r.ok !== false;
                      const headlines = Array.isArray(r.headlines) ? r.headlines : [];
                      const preview = headlines[0] ?? "";
                      return (
                        <div
                          key={id}
                          className={`rounded-md border px-3 py-2 text-[11px] cursor-pointer hover:border-primary/40 transition-colors ${
                            ok ? "border-border" : "border-destructive/25 bg-destructive/10"
                          }`}
                          onClick={() =>
                            setExpandedLog((prev) => {
                              const next = new Set(prev);
                              if (next.has(id)) next.delete(id);
                              else next.add(id);
                              return next;
                            })
                          }
                          title={expanded ? "Click to collapse" : "Click to expand"}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge
                              variant="secondary"
                              className={`text-[10px] ${ok ? "bg-healthy/10 text-healthy" : "bg-destructive/15 text-destructive"}`}
                            >
                              {ok ? "ok" : "failed"}
                            </Badge>
                            <span className="font-medium text-foreground truncate">
                              {r.provider ? String(r.provider) : "—"}
                              {r.model ? ` / ${String(r.model)}` : ""}
                            </span>
                            <span className="text-muted-foreground">{Number(r.itemCount ?? 0)} item(s)</span>
                            <span className="ml-auto text-[10px] text-muted-foreground">
                              {r.createdAt ? new Date(r.createdAt).toLocaleString() : ""}
                            </span>
                          </div>
                          {!ok && r.error ? (
                            <p className={`mt-1 text-[10px] leading-snug ${expanded ? "whitespace-pre-wrap break-words" : "truncate"} text-destructive/80`}>
                              {String(r.error)}
                            </p>
                          ) : null}
                          {preview ? (
                            <p className={`mt-1 text-muted-foreground ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
                              {expanded ? headlines.join(" · ") : preview}
                            </p>
                          ) : null}
                          {expanded && headlines.length > 1 ? (
                            <p className="mt-1 text-[10px] text-muted-foreground">+{headlines.length - 1} more</p>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </Card>

    <Card
      icon={BarChart3}
      id="rewrite-analytics"
      title="Rewrite Analytics"
      hint={`${analyticsLoading ? "loading…" : rewriteAnalytics ? `${rewriteAnalytics.total ?? 0} attempt(s) · ${rewriteAnalytics.successRate ?? 0}% ok · ${rewriteAnalytics.fallbackRate ?? 0}% fallback` : "no data yet"}`}
      className="sm:col-span-2"
    >
      <div className="space-y-3">
        {rewriteAnalytics ? (
          <>
            {/* 7-day trend: ok vs fallback per day */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Last 7 days</p>
              <div className="mt-1.5 flex items-end gap-1">
                {(rewriteAnalytics.trend ?? []).map((d: any) => {
                  const max = Math.max(1, d.ok + d.fail, ...(rewriteAnalytics.trend ?? []).map((x: any) => x.ok + x.fail));
                  return (
                    <div key={d.day} className="flex flex-1 flex-col items-center gap-0.5" title={`${d.day}: ${d.ok} ok · ${d.fail} fallback`}>
                      <div className="flex h-16 w-full items-end justify-center gap-0.5">
                        <div className="w-1/3 rounded-t-sm bg-healthy/70" style={{ height: `${(d.ok / max) * 100}%` }} />
                        <div className="w-1/3 rounded-t-sm bg-destructive/60" style={{ height: `${(d.fail / max) * 100}%` }} />
                      </div>
                      <span className="text-[9px] tabular-nums text-muted-foreground">{d.day.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Per-provider health + latency */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Per provider</p>
              <div className="mt-1.5 space-y-1">
                {(rewriteAnalytics.providers ?? []).map((p: any) => (
                  <div key={String(p.name)} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[11px]">
                    <span className="font-medium text-foreground">{String(p.name)}</span>
                    <span className="text-muted-foreground">{p.ok} ok · {p.fail} fail</span>
                    <span className="ml-auto tabular-nums text-muted-foreground">
                      {p.avgDurationMs !== null && p.avgDurationMs !== undefined ? `${p.avgDurationMs} ms avg` : "—"}
                    </span>
                  </div>
                ))}
                {(rewriteAnalytics.providers ?? []).length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">No rewrite attempts in the last 7 days.</p>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-healthy/70" /> ok</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-destructive/60" /> fallback (raw source text)</span>
              <span className="ml-auto">{rewriteAnalytics.successRate ?? 0}% success · {rewriteAnalytics.fallbackRate ?? 0}% fallback</span>
            </div>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground py-1">
            No rewrite analytics yet — this fills after the pipeline runs a few rewrite chunks (one row per 5-item chunk, including failures).
          </p>
        )}
      </div>
    </Card>
      </div>
    </details>

    <Card
      icon={ScrollText}
      id="glossary"
      title="Translation Glossary"
      hint="One entry per row — a long translation can no longer wrap onto a second line and break the entry"
      className="sm:col-span-2"
    >
      <GlossaryEditor value={s["translationGlossary"] ?? ""} onChange={(v) => save({ translationGlossary: v })} />
    </Card>
    </div>
  );
}

function AiControlPlane({ pin, onError }: { pin: string; onError: (error: unknown) => void }) {
  const [plane, setPlane] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [action, setAction] = useState("translation");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [scenario, setScenario] = useState({ headline: "", body: "", sourceType: "web", category: "iran", targetLanguage: "English", targetLength: "500" });
  const [scenarioResult, setScenarioResult] = useState<any | null>(null);
  const [newProvider, setNewProvider] = useState({ slug: "groq", label: "", instanceKey: "default", apiKey: "", model: "" });

  const load = async () => {
    if (!pin) return;
    setLoading(true);
    try {
      setPlane(await adminApi.listAiControlPlane({ pin }));
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  const providers = (plane?.providers ?? []) as any[];
  const actions = (plane?.actions ?? []) as any[];
  const routes = (plane?.routes ?? []) as any[];
  const currentAction = actions.find((item) => item.id === action);
  const actionRoutes = routes
    .filter((route) => route.action === action)
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));

  const providerFor = (id: string) => providers.find((provider) => String(provider.id) === String(id));
  const saveActionRoutes = async (next: any[]) => {
    setBusy(`route-${action}`);
    try {
      await adminApi.saveAiActionRoutes({
        pin,
        action,
        routes: next.map((route) => ({ providerId: String(route.providerId), enabled: route.enabled !== false })),
      });
      await load();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  const updateRoute = (index: number, patch: Record<string, unknown>) => {
    void saveActionRoutes(actionRoutes.map((route, routeIndex) => (routeIndex === index ? { ...route, ...patch } : route)));
  };

  const removeRoute = (index: number) => {
    void saveActionRoutes(actionRoutes.filter((_, routeIndex) => routeIndex !== index));
  };

  const moveRoute = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= actionRoutes.length) return;
    const next = [...actionRoutes];
    [next[index], next[target]] = [next[target], next[index]];
    void saveActionRoutes(next);
  };

  const addRoute = (providerId: string) => {
    if (!providerId || actionRoutes.some((route) => String(route.providerId) === providerId)) return;
    void saveActionRoutes([...actionRoutes, { providerId, enabled: true }]);
  };

  const runConnectionTest = async (providerId: string) => {
    setBusy(`connection-${providerId}`);
    try {
      const result = await adminActionsApi.testAiProviderConnection({ pin, providerId });
      await load();
      if (result.ok) toast.success(`Connection accepted in ${result.latencyMs ?? "—"} ms`);
      else toast.error(String(result.detail ?? "Connection failed"));
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  const saveProvider = async () => {
    setBusy("provider-save");
    try {
      await adminApi.saveAiProvider({
        pin,
        slug: newProvider.slug,
        label: newProvider.label || undefined,
        instanceKey: newProvider.instanceKey || "default",
        apiKey: newProvider.apiKey || undefined,
        model: newProvider.model || undefined,
      });
      setNewProvider({ slug: "groq", label: "", instanceKey: "default", apiKey: "", model: "" });
      await load();
      toast.success("Provider saved");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  const toggleProvider = async (provider: any, enabled: boolean) => {
    setBusy(`provider-${provider.id}`);
    try {
      await adminApi.saveAiProvider({ pin, id: String(provider.id), slug: String(provider.slug), label: String(provider.label), instanceKey: String(provider.instanceKey ?? "default"), enabled });
      await load();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  const deleteProvider = async (provider: any) => {
    if (!window.confirm(`Delete ${provider.label} and its stored key globally?`)) return;
    setBusy(`delete-${provider.id}`);
    try {
      await adminApi.deleteAiProvider({ pin, id: String(provider.id) });
      await load();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  const runScenario = async () => {
    setBusy("scenario");
    try {
      const result = await adminActionsApi.testAiAction({
        pin,
        action,
        input: { ...scenario, targetLength: Number(scenario.targetLength) || 500 },
      });
      setScenarioResult(result);
      await load();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card icon={Terminal} id="ai-control-plane" title="AI Control Plane" hint="Independent provider chains, safe tests, and complete attempt history" className="lg:col-span-3">
      <div className="space-y-5">
        <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-foreground">Providers</p>
                <p className="text-[11px] text-muted-foreground">Connection tests validate auth, model response, and latency without running the editorial pipeline.</p>
              </div>
              <Button size="sm" variant="outline" className="h-8 gap-1 text-[11px]" onClick={() => void load()} disabled={loading}>
                <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
              </Button>
            </div>
            <div className="space-y-1.5">
              {providers.map((provider) => (
                <div key={String(provider.id)} className="rounded-md border border-border px-3 py-2 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{provider.label}</span>
                    <Badge variant="secondary" className="text-[9px]">{provider.instanceKey ?? "default"}</Badge>
                    <span className="truncate text-muted-foreground">{provider.model ?? "—"}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">{provider.maskedKey ?? "key missing"}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                    <Switch checked={provider.enabled !== false} onCheckedChange={(checked) => void toggleProvider(provider, checked)} disabled={busy === `provider-${provider.id}`} aria-label={`Enable ${provider.label} everywhere`} />
                    <span>{provider.enabled === false ? "disabled everywhere" : "enabled"}</span>
                    <span>·</span>
                    <span>{provider.lastStatus ?? "untested"}{provider.lastLatencyMs ? ` · ${provider.lastLatencyMs} ms` : ""}</span>
                    <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[10px]" onClick={() => void runConnectionTest(String(provider.id))} disabled={busy === `connection-${provider.id}`}>
                      <Activity className="mr-1 h-3 w-3" /> Test connection
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-destructive" onClick={() => void deleteProvider(provider)} disabled={busy === `delete-${provider.id}`}>
                      <Trash2 className="mr-1 h-3 w-3" /> Delete key/provider
                    </Button>
                  </div>
                </div>
              ))}
              {providers.length === 0 && !loading ? <p className="text-[11px] text-muted-foreground">No providers configured.</p> : null}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <CompactSelect label="Provider" value={newProvider.slug} onChange={(slug) => setNewProvider((prev) => ({ ...prev, slug }))} options={(plane?.catalog ?? []).map((provider: any) => ({ value: provider.slug, label: provider.label }))} />
              <CompactInput label="Instance label" value={newProvider.label} onChange={(label) => setNewProvider((prev) => ({ ...prev, label }))} placeholder="Gemini key 2" />
              <CompactInput label="Instance key" value={newProvider.instanceKey} onChange={(instanceKey) => setNewProvider((prev) => ({ ...prev, instanceKey }))} placeholder="key-2" />
              <CompactInput label="Model override" value={newProvider.model} onChange={(model) => setNewProvider((prev) => ({ ...prev, model }))} placeholder="Uses provider default" />
              <CompactInput label="API key (optional)" value={newProvider.apiKey} onChange={(apiKey) => setNewProvider((prev) => ({ ...prev, apiKey }))} placeholder="Stored server-side" className="sm:col-span-2" />
              <Button size="sm" className="h-8 text-[11px] sm:col-span-2" onClick={() => void saveProvider()} disabled={busy === "provider-save"}><Plus className="mr-1 h-3 w-3" /> Save provider</Button>
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <p className="text-xs font-semibold text-foreground">Action route</p>
              <p className="text-[11px] text-muted-foreground">Each action has its own chain. Changes here do not alter any other action.</p>
            </div>
            <CompactSelect label="Action" value={action} onChange={setAction} options={actions.map((item) => ({ value: item.id, label: item.label }))} />
            <p className="text-[10px] text-muted-foreground">{currentAction?.description ?? ""}</p>
            <div className="space-y-1.5">
              {actionRoutes.map((route, index) => {
                const provider = providerFor(route.providerId);
                return (
                  <div key={`${route.providerId}-${index}`} draggable onDragStart={() => setDragIndex(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => {
                    if (dragIndex === null || dragIndex === index) return setDragIndex(null);
                    const next = [...actionRoutes];
                    const [moved] = next.splice(dragIndex, 1);
                    next.splice(index, 0, moved);
                    setDragIndex(null);
                    void saveActionRoutes(next);
                  }} className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-[11px] ${dragIndex === index ? "border-primary/60 bg-primary/5" : "border-border bg-muted/30"}`}>
                    <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground" />
                    <span className="w-5 shrink-0 text-center font-semibold text-muted-foreground">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{provider?.label ?? "Missing provider"}</span>
                    <span className="max-w-28 truncate text-[10px] text-muted-foreground">{provider?.model ?? "—"}</span>
                    <Switch checked={route.enabled !== false} onCheckedChange={(checked) => updateRoute(index, { enabled: checked })} aria-label={`Enable ${provider?.label ?? "provider"} for ${action}`} />
                    <button type="button" title="Move up" className="p-1 text-muted-foreground hover:text-foreground" onClick={() => moveRoute(index, -1)}><ChevronUp className="h-3.5 w-3.5" /></button>
                    <button type="button" title="Move down" className="p-1 text-muted-foreground hover:text-foreground" onClick={() => moveRoute(index, 1)}><ChevronDown className="h-3.5 w-3.5" /></button>
                    <button type="button" title="Remove from this action" className="p-1 text-muted-foreground hover:text-destructive" onClick={() => removeRoute(index)}><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                );
              })}
              {actionRoutes.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">No route configured. The legacy chain is used until you save an action route.</p> : null}
            </div>
            <CompactSelect label="Add provider to this action" value="" onChange={addRoute} options={[{ value: "", label: "Choose provider…" }, ...providers.filter((provider) => !actionRoutes.some((route) => String(route.providerId) === String(provider.id))).map((provider) => ({ value: String(provider.id), label: `${provider.label} · ${provider.model ?? "default"}` }))]} />
            {busy === `route-${action}` ? <p className="text-[10px] text-muted-foreground">Saving route…</p> : null}
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
          <div className="space-y-2 rounded-md border border-border p-3">
            <div>
              <p className="text-xs font-semibold text-foreground">Scenario Laboratory</p>
              <p className="text-[11px] text-muted-foreground">Run one action or the configured fallback chain in test mode. Nothing is published.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <CompactInput label="Original headline" value={scenario.headline} onChange={(headline) => setScenario((prev) => ({ ...prev, headline }))} placeholder="Keep the source headline" />
              <CompactSelect label="Source type" value={scenario.sourceType} onChange={(sourceType) => setScenario((prev) => ({ ...prev, sourceType }))} options={[{ value: "web", label: "Web article" }, { value: "telegram", label: "Telegram" }, { value: "rss", label: "RSS" }]} />
              <CompactInput label="Category" value={scenario.category} onChange={(category) => setScenario((prev) => ({ ...prev, category }))} />
              <CompactInput label="Target language" value={scenario.targetLanguage} onChange={(targetLanguage) => setScenario((prev) => ({ ...prev, targetLanguage }))} />
              <CompactInput label="Desired length" value={scenario.targetLength} onChange={(targetLength) => setScenario((prev) => ({ ...prev, targetLength }))} type="number" min={40} max={5000} className="sm:col-span-2" />
            </div>
            <textarea value={scenario.body} onChange={(event) => setScenario((prev) => ({ ...prev, body: event.target.value }))} rows={5} placeholder="Paste the original article body" className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground" />
            <Button size="sm" className="h-8 gap-1 text-[11px]" onClick={() => void runScenario()} disabled={busy === "scenario" || !scenario.body.trim()}><Terminal className="h-3 w-3" /> Run {currentAction?.label ?? action}</Button>
            {scenarioResult ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-[10px] text-foreground">{JSON.stringify(scenarioResult, null, 2)}</pre> : null}
          </div>

          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div><p className="text-xs font-semibold text-foreground">Unified AI attempt log</p><p className="text-[11px] text-muted-foreground">Provider, model, fallback, latency, tokens, validation, and final decision.</p></div>
              <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => void load()}><RefreshCw className="mr-1 h-3 w-3" /> Refresh</Button>
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {(plane?.attempts ?? []).map((entry: any, index: number) => (
                <div key={String(entry.id ?? index)} className="rounded-md border border-border px-2.5 py-2 text-[10px]">
                  <div className="flex items-center gap-2"><Badge variant="secondary" className={entry.success ? "bg-healthy/10 text-healthy" : "bg-destructive/10 text-destructive"}>{entry.success ? "ok" : "fail"}</Badge><span className="font-medium text-foreground">{entry.action}</span><span className="text-muted-foreground">{entry.provider ?? "—"} / {entry.model ?? "—"}</span><span className="ml-auto text-muted-foreground">{entry.latency_ms ?? "—"} ms</span></div>
                  <p className="mt-1 text-muted-foreground">attempt {entry.attempt_number ?? "—"} · {entry.fallback_used ? "fallback" : "primary"} · {entry.validation_result ?? "not validated"}{entry.failure_reason ? ` · ${entry.failure_reason}` : ""}</p>
                </div>
              ))}
              {(plane?.attempts ?? []).length === 0 ? <p className="text-[11px] text-muted-foreground">No AI attempts recorded yet.</p> : null}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ── AddKeyButton (translation provider key) ─────────────── */
function AddKeyButton({
  onSave,
}: {
  onSave: (provider: string, label: string, apiKey: string, model: string, priority: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState("gemini");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("google/gemini-flash-latest");
  const [priority, setPriority] = useState(100);

  const handle = () => {
    if (!label.trim()) return;
    onSave(provider, label.trim(), apiKey.trim(), model, priority);
    setLabel("");
    setApiKey("");
    setOpen(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 text-[11px] gap-1">
          <Plus className="h-3 w-3" /> Add
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Add translation key</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="space-y-3">
          <CompactSelect
            label="Provider"
            value={provider}
            onChange={setProvider}
            options={[
              { value: "gemini", label: "Google Gemini" },
              { value: "minimax", label: "Minimax (via AI Gateway)" },
            ]}
          />
          <CompactInput label="Label" value={label} onChange={setLabel} placeholder="e.g. Key #5" />
          <CompactInput label="API key" value={apiKey} onChange={setApiKey} placeholder="sk-..." />
          <CompactInput label="Model" value={model} onChange={setModel} />
          <CompactInput
            label="Priority"
            value={priority}
            onChange={(v) => setPriority(Number(v) || 100)}
            type="number"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handle} disabled={!label.trim()}>
            Add key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
