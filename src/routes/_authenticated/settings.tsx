import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import {
  api,
  useAdminQuery,
  useAdminMutation,
  useAdminAction,
} from "@/lib/supabaseAdminHooks";
import { AddChat } from "@/components/AddChat";
import { AddTelegramChannel, TelegramChannelRow } from "@/components/TelegramChannels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
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
  ArrowLeft,
  Lock,
  Zap,
  Globe,
  Clock,
  Flame,
  Languages,
  MessageCircle,
  Activity,
  Cpu,
  Hash,
  Terminal,
  Plus,
  Trash2,
  RefreshCw,
  Wifi,
  Play,
  ScrollText,
  BarChart3,
  Filter,
  AlertTriangle,
  CheckCircle,
  Gauge,
  FileText,
  BookOpen,
  CalendarClock,
  Package,
  Vote,
  SlidersHorizontal,
  Send,
  RadioTower,
  Server,
  ShieldCheck,
} from "lucide-react";
import { clearStoredPin, readStoredPin } from "@/routes/index";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings · Iran Desk Bot" },
      { name: "description", content: "Bot publishing, sources & system configuration" },
      { property: "og:title", content: "Iran Desk Bot Settings" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SettingsPage,
});

/* ── Card shell (theme-aware, matches dashboard panels) ─── */
function Card({
  icon: Icon,
  title,
  hint,
  action,
  className = "",
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`panel p-4 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-card-foreground">{title}</h2>
            {hint ? <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p> : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

/* ── Compact form helpers ────────────────────────────────── */
function CompactInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  min,
  max,
  step,
  className = "",
  hint,
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  hint?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <Label className="text-[11px] text-muted-foreground font-medium">{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        dir={type === "text" ? "auto" : undefined}
        className="h-9 rounded-lg text-sm focus:ring-primary/20 focus:border-primary"
      />
      {hint ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function CompactSelect({
  label,
  value,
  onChange,
  options,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {label ? <Label className="text-[11px] text-muted-foreground font-medium">{label}</Label> : null}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:ring-primary/20 focus:border-primary"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function CompactToggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div>
        <Label className="text-[11px] text-muted-foreground font-medium">{label}</Label>
        {hint ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        className="data-[state=checked]:bg-primary"
      />
    </div>
  );
}

function Pill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/80"
      }`}
    >
      {label}
    </button>
  );
}

/* Row shell for tables/lists inside cards. */
function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2">
      {children}
    </div>
  );
}

function SubText({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] text-muted-foreground">{children}</p>;
}

function IconBtn({
  title,
  tone = "muted",
  onClick,
  children,
}: {
  title: string;
  tone?: "muted" | "primary" | "danger";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const toneCls =
    tone === "danger"
      ? "text-muted-foreground hover:text-destructive"
      : tone === "primary"
        ? "text-muted-foreground hover:text-primary"
        : "text-muted-foreground hover:text-foreground";
  return (
    <button type="button" title={title} className={`p-1 transition-colors ${toneCls}`} onClick={onClick}>
      {children}
    </button>
  );
}

/* ── Main component ─────────────────────────────────────── */
type SettingsCat = "general" | "publishing" | "ai" | "sources" | "translation" | "telegram" | "scheduler" | "system" | "security";

function SettingsPage() {
  const navigate = useNavigate();
  const pin = readStoredPin();
  const pinArgs = pin ? { pin } : {};

  const data = useAdminQuery(api.admin.getDashboard, pin ? pinArgs : "skip");
  const translationKeyData = useAdminQuery(api.admin.listTranslationKeys, pin ? pinArgs : "skip");

  const saveSettings = useAdminMutation(api.admin.saveSettings);
  const updateChat = useAdminMutation(api.admin.updateChat);
  const addChat = useAdminMutation(api.admin.addChat);
  const upsertTopic = useAdminMutation(api.admin.upsertTopic);
  const upsertSource = useAdminMutation(api.admin.upsertSource);
  const upsertTranslationKey = useAdminMutation(api.admin.upsertTranslationKey);
  const testTranslationKey = useAdminAction(api.admin_actions.testTranslationKey);
  const testGeminiKeys = useAdminAction(api.admin_actions.testGeminiKeys);
  const testSource = useAdminAction(api.admin_actions.testSource);
  const refreshBotInfo = useAdminAction(api.admin_actions.refreshBotInfo);
  const setWebhook = useAdminAction(api.admin_actions.setWebhook);
  const setTranslationModel = useAdminMutation(api.admin.setTranslationModel);
  const listTranslationModels = useAdminAction(api.admin_actions.listTranslationModels);
  const syncBotChats = useAdminAction(api.admin_actions.syncBotChats);
  const testPoll = useAdminAction(api.admin_actions.testPoll);

  const onError = (e: unknown) =>
    toast.error(e instanceof Error ? e.message : "Something went wrong");

  // Optimistic overlay for settings inputs. The inputs are controlled by the
  // reactive getDashboard query, and every keystroke fires a save mutation.
  // Without a local overlay, the input reverts to the stale committed value for
  // the whole mutation→query round-trip, so typing feels broken (chars vanish).
  // The overlay updates synchronously on each change, keeping the field stable.
  const [optimisticSettings, setOptimisticSettings] = useState<Record<string, any>>({});

  const save = (patch: Record<string, unknown>) => {
    setOptimisticSettings((prev) => ({ ...prev, ...patch }));
    saveSettings({ ...pinArgs, patch }).catch(onError);
  };

  const [activeTab, setActiveTab] = useState<SettingsCat>("general");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [geminiTest, setGeminiTest] = useState<any | null>(null);
  const [geminiTesting, setGeminiTesting] = useState(false);
  const [geminiConfirm, setGeminiConfirm] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());

  // Translation models
  const [models, setModels] = useState<string[]>([]);
  const [currentModel, setCurrentModel] = useState("");
  // Bot info learned from the "Refresh bot info" action (username/name only).
  const [botInfo, setBotInfo] = useState<{ username?: string | null; name?: string | null } | null>(null);
  // Operator-configured footer hyperlinks (post_links jsonb) — seeded once
  // from the server, then treated as local state so typing isn't clobbered
  // by the 5s poll while an edit is in flight.
  const [postLinks, setPostLinks] = useState<Array<{ url: string; text: string }>>([]);
  const [postLinksSeeded, setPostLinksSeeded] = useState(false);
  useEffect(() => {
    if (postLinksSeeded || !data?.settings) return;
    setPostLinksSeeded(true);
    const raw = (data.settings as Record<string, any>)?.postLinks;
    const parsed: Array<{ url: string; text: string }> = [];
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        let link = entry as any;
        if (typeof link === "string") { try { link = JSON.parse(link); } catch { continue; } }
        if (!link || typeof link !== "object") continue;
        const url = String(link.url ?? "").trim();
        const text = String(link.text ?? "").trim();
        if (url && text) parsed.push({ url, text });
      }
    }
    setPostLinks(parsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.settings, postLinksSeeded]);
  const commitPostLinks = (next: Array<{ url: string; text: string }>) => {
    setPostLinks(next);
    save({ postLinks: next });
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

  if (!pin) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-10">
        <div className="panel max-w-md p-8 text-center">
          <h1 className="text-xl font-semibold text-card-foreground">Sign in required</h1>
          <p className="mt-2 text-sm text-muted-foreground">Your admin PIN isn't stored in this browser.</p>
          <Button className="mt-5 w-full" onClick={() => navigate({ to: "/", replace: true })}>
            Go to sign-in
          </Button>
        </div>
      </div>
    );
  }

  if (!data?.settings) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-10">
        <div className="panel max-w-md p-8 text-center">
          <h1 className="text-xl font-semibold text-card-foreground">Loading settings…</h1>
          <p className="mt-2 text-sm text-muted-foreground">Connecting to the backend…</p>
        </div>
      </div>
    );
  }

  const s = { ...(data.settings as Record<string, any>), ...optimisticSettings };
  const chats = (data.chats ?? []) as any[];
  const sources = (data.sources ?? []) as any[];
  const topics = (data.topics ?? []) as any[];
  const polls = ((data as any).polls ?? []) as any[];
  const translationHistory = ((data as any).translationHistory ?? []) as any[];
  const translationFailures = ((data as any).translationFailures ?? []) as any[];
  const tkeys = (translationKeyData as any)?.keys ?? [];
  const geminiUsage = (translationKeyData as any)?.geminiUsage ?? [];
  // Count of GEMINI_API_KEY_1..N read from the runtime env — these keys are
  // picked up by the pipeline automatically and are the keys that actually do
  // the translation; the table below only holds ADDITIONAL stored keys.
  const envGeminiCount = Number((translationKeyData as any)?.envDefaults?.gemini ?? 0);
  // Token presence comes from the dashboard query (botConfigured), NOT from
  // botInfo — getDashboard never returned botInfo, so the old status always
  // read "No token" even when a token was configured.
  const botTokenConfigured = Boolean((data as any).botConfigured);

  function lock() {
    clearStoredPin();
    navigate({ to: "/", replace: true });
  }

  const tabs: Array<{ id: SettingsCat; label: string; icon: any }> = [
    { id: "general", label: "General", icon: SlidersHorizontal },
    { id: "publishing", label: "Publishing", icon: Send },
    { id: "ai", label: "AI & Quality", icon: Cpu },
    { id: "sources", label: "Sources", icon: RadioTower },
    { id: "translation", label: "Translation", icon: Languages },
    { id: "telegram", label: "Telegram", icon: Hash },
    { id: "scheduler", label: "Scheduler", icon: Clock },
    { id: "system", label: "System", icon: Server },
    { id: "security", label: "Security", icon: ShieldCheck },
  ];

  /* ── Publishing helpers ──────────────────────────── */
  const dayWin = {
    start: s["dayStart"] ?? "06:00",
    end: s["dayEnd"] ?? "22:00",
    min: s["dayMinMinutes"] ?? 6,
    max: s["dayMaxMinutes"] ?? 16,
  };
  const nightWin = {
    start: s["nightStart"] ?? "22:00",
    end: s["nightEnd"] ?? "06:00",
    min: s["nightMinMinutes"] ?? 10,
    max: s["nightMaxMinutes"] ?? 20,
  };

  const breakingCats = (s["breakingCategories"] ?? []) as string[];
  const allCats = ["iran", "oil", "war", "proxies", "usa", "middle-east", "gulf", "nuclear", "sanctions", "gaza", "iraq"];

  const toggleBreakingCat = (cat: string) => {
    const next = breakingCats.includes(cat)
      ? breakingCats.filter((c) => c !== cat)
      : [...breakingCats, cat];
    save({ breakingCategories: next });
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* ── Header ────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => navigate({ to: "/overview" })}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Overview
          </Button>
          <div>
            <h1 className="text-xl font-semibold text-card-foreground">Settings</h1>
            <p className="text-xs text-muted-foreground">Bot publishing, sources &amp; system configuration</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={lock}
        >
          <Lock className="h-3.5 w-3.5" />
          Lock console
        </Button>
      </header>

      {/* ── Green persistence banner ───────────────── */}
      <div className="mb-5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-4 py-2.5 text-[11px] font-medium text-emerald-400">
        Every setting saves automatically. Nothing resets on login, refresh, or redeploy.
      </div>

      {/* ── Settings navigation ───────────────────── */}
      <div className="mb-6 grid gap-4 lg:grid-cols-[180px_1fr]">
        <nav className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] font-medium transition-colors lg:w-full ${
                  activeTab === t.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </nav>
        <div className="min-w-0">
      {/* ════════════════════════════════════════════════
            PUBLISHING TAB
          ════════════════════════════════════════════════ */}
      {
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
          {/* Publishing Speed */}
                    {activeTab === "publishing" && (
<Card icon={Gauge} title="Publishing Speed" hint="Delay between consecutive posts">
            <div className="flex items-end gap-3">
              <CompactInput
                label="Delay (seconds)"
                value={s["sendDelayMs"] ? Math.round(Number(s["sendDelayMs"]) / 1000) : 30}
                onChange={(v) =>
                  save({ sendDelayMs: Math.max(1000, Number(v) * 1000 || 30000) })
                }
                type="number"
                min={1}
                max={300}
              />
              <span className="text-[11px] text-muted-foreground pb-2">
                {s["sendDelayMs"] ? Math.round(Number(s["sendDelayMs"]) / 1000) : 30}s
              </span>
            </div>
          </Card>
          )}

          {/* Post Format */}
                    {activeTab === "general" && (
<Card icon={FileText} title="Post Format" hint="Customise how posts appear in Telegram">
            <div className="space-y-3">
              <CompactInput
                label="Footer text"
                value={s["postFooter"] ?? ""}
                onChange={(v) => save({ postFooter: v })}
                placeholder='e.g. "Iran Desk · @yourchannel"'
              />
              <CompactInput
                label="Footer emoji"
                value={s["postEmoji"] ?? ""}
                onChange={(v) => save({ postEmoji: v })}
                placeholder="📌"
              />
              <CompactInput
                label='"Read more" link label'
                value={s["postLinkLabel"] ?? "Read more"}
                onChange={(v) => save({ postLinkLabel: v })}
              />
              <CompactInput
                label="Breaking prefix"
                value={s["breakingPrefix"] ?? "🚨 BREAKING"}
                onChange={(v) => save({ breakingPrefix: v })}
              />
              <Separator className="!my-2" />
              <CompactToggle
                label="Show timestamp"
                checked={s["postShowTimestamp"] !== false}
                onChange={(v) => save({ postShowTimestamp: v })}
              />
              <CompactToggle
                label="Telegram link previews"
                checked={s["linkPreviews"] !== false}
                onChange={(v) => save({ linkPreviews: v })}
                hint="Shows URL preview cards under posts"
              />
              <CompactToggle
                label="Grab article image"
                checked={s["grabImages"] !== false}
                onChange={(v) => save({ grabImages: v })}
                hint="On: always grabs the source image and posts it beside the text. Off: text only."
              />
              <CompactToggle
                label="Rich summaries"
                checked={s["enrichSummaries"] !== false}
                onChange={(v) => save({ enrichSummaries: v })}
                hint="Fetches the full article when the feed snippet is short, so posts are complete without opening the source link."
              />
              <Separator className="!my-2" />
              <div>
                <Label className="text-xs">Footer hyperlinks</Label>
                <p className="mb-2 text-[10px] text-muted-foreground">
                  Shown as the last line of every post — add, edit or remove.
                </p>
                {postLinks.length === 0 ? (
                  <p className="mb-2 text-[10px] text-muted-foreground/70">No links yet.</p>
                ) : (
                  <div className="space-y-2">
                    {postLinks.map((link, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          value={link.text}
                          onChange={(e) => commitPostLinks(postLinks.map((l, j) => (j === i ? { ...l, text: e.target.value } : l)))}
                          placeholder="Label"
                          className="h-8 text-xs"
                        />
                        <Input
                          value={link.url}
                          onChange={(e) => commitPostLinks(postLinks.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)))}
                          placeholder="https://…"
                          className="h-8 text-xs"
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 shrink-0 p-0 text-destructive"
                          onClick={() => commitPostLinks(postLinks.filter((_, j) => j !== i))}
                        >
                          ✕
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 h-8 text-[11px]"
                  onClick={() => commitPostLinks([...postLinks, { url: "", text: "" }])}
                >
                  + Add link
                </Button>
              </div>
            </div>
          </Card>
          )}

          {/* Scheduler */}
                    {activeTab === "scheduler" && (
<Card icon={Clock} title="Scheduler" hint="How often each job runs (live, no redeploy)">
            <div className="space-y-3">
              <CompactInput
                label="News search + queue (minutes)"
                value={s["ingestIntervalMinutes"] ?? 15}
                onChange={(v) => save({ ingestIntervalMinutes: Math.max(1, Number(v) || 15) })}
                type="number"
                min={1}
                max={1440}
              />
              <CompactInput
                label="Telegram channel fetch (minutes)"
                value={s["telegramSignalsIntervalMinutes"] ?? 5}
                onChange={(v) => save({ telegramSignalsIntervalMinutes: Math.max(1, Number(v) || 5) })}
                type="number"
                min={1}
                max={1440}
              />
              <CompactInput
                label="Min gap between posts (minutes)"
                value={s["minPostGapMinutes"] ?? 1}
                onChange={(v) => save({ minPostGapMinutes: Math.max(0, Number(v) || 0) })}
                type="number"
                min={0}
                max={120}
              />
              <CompactInput
                label="Daily bulletin check (minutes)"
                value={s["bulletinIntervalMinutes"] ?? 15}
                onChange={(v) => save({ bulletinIntervalMinutes: Math.max(1, Number(v) || 15) })}
                type="number"
                min={1}
                max={1440}
              />
            </div>
          </Card>
          )}

          {/* AI Dedup */}
                    {activeTab === "ai" && (
<Card icon={Cpu} title="AI Dedup" hint="Final duplicate check (Groq/OpenRouter/Cloudflare)">
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
          )}

          {/* News quality */}
                    {activeTab === "ai" && (
<Card icon={Gauge} title="News quality" hint="Breaking recency, fact consistency and update cadence">
            <div className="space-y-3">
              <CompactInput
                label="Breaking max age (hours)"
                value={s["breakingMaxAgeHours"] ?? 8}
                onChange={(v) => save({ breakingMaxAgeHours: Math.max(1, Number(v) || 8) })}
                type="number"
                min={1}
                max={72}
                hint="Stories older than this never publish as breaking"
              />
              <CompactInput
                label="Update prefix"
                value={s["updatePrefix"] ?? "UPDATE — "}
                onChange={(v) => save({ updatePrefix: v })}
                hint="Prefix for material follow-ups of a published event"
              />
              <CompactInput
                label="Update cooldown (hours)"
                value={s["updateCooldownHours"] ?? 1}
                onChange={(v) => save({ updateCooldownHours: Math.max(0.5, Number(v) || 1) })}
                type="number"
                min={0.5}
                max={24}
                step={0.5}
              />
              <CompactInput
                label="Update material threshold"
                value={s["updateMaterialThreshold"] ?? 0.7}
                onChange={(v) =>
                  save({ updateMaterialThreshold: Math.max(0.4, Math.min(0.95, Number(v) || 0.7)) })
                }
                type="number"
                min={0.4}
                max={0.95}
                step={0.05}
                hint="Similarity above this = re-report (dropped), below = update"
              />
              <CompactInput
                label="Max updates per cycle"
                value={s["maxUpdatesPerCycle"] ?? 2}
                onChange={(v) => save({ maxUpdatesPerCycle: Math.max(1, Number(v) || 2) })}
                type="number"
                min={1}
                max={10}
              />
            </div>
          </Card>
          )}

          {/* Daily Bulletin */}
                    {activeTab === "publishing" && (
<Card icon={BookOpen} title="Daily Bulletin" hint="Auto-generated morning summary">
            <div className="space-y-3">
              <CompactInput
                label="Bulletin time"
                value={s["bulletinTime"] ?? "00:00"}
                onChange={(v) => save({ bulletinTime: v })}
                type="time"
              />
              <CompactInput
                label="Lookback (hours)"
                value={s["bulletinHours"] ?? 24}
                onChange={(v) => save({ bulletinHours: Number(v) || 24 })}
                type="number"
                min={1}
                max={72}
              />
              <CompactToggle
                label="Enabled"
                checked={s["bulletinEnabled"] !== false}
                onChange={(v) => save({ bulletinEnabled: v })}
              />
            </div>
          </Card>
          )}

          {/* Language */}
                    {activeTab === "general" && (
<Card icon={Languages} title="Language" hint="Default output language">
            <CompactSelect
              label="News language"
              value={s["defaultLanguage"] ?? "en"}
              onChange={(v) => save({ defaultLanguage: v })}
              options={[
                { value: "en", label: "English" },
                { value: "ckb", label: "Kurdish Sorani" },
                { value: "both", label: "Both (per chat)" },
              ]}
            />
          </Card>
          )}

          {/* Posting Windows */}
                    {activeTab === "publishing" && (
<Card
            icon={CalendarClock}
            title="Posting Windows"
            hint="Spacing between posts = this window's Min–Max (randomized). Night also gates breaking unless interrupted"
            className="sm:col-span-2"
          >
            <div className="space-y-3">
              {/* Day window */}
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-3">
                <p className="text-[11px] font-semibold text-muted-foreground mb-2">
                  🌅 Day ({dayWin.start} – {dayWin.end})
                </p>
                <div className="grid grid-cols-4 gap-2">
                  <CompactInput label="Start"
                    value={dayWin.start} onChange={(v) => save({ dayStart: v })} type="time" />
                  <CompactInput label="End"
                    value={dayWin.end} onChange={(v) => save({ dayEnd: v })} type="time" />
                  <CompactInput label="Min (min)"
                    value={dayWin.min} onChange={(v) => save({ dayMinMinutes: Number(v) })} type="number" min={1} />
                  <CompactInput label="Max (min)"
                    value={dayWin.max} onChange={(v) => save({ dayMaxMinutes: Number(v) })} type="number" min={1} />
                </div>
              </div>
              {/* Night window */}
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-3">
                <p className="text-[11px] font-semibold text-muted-foreground mb-2">
                  🌙 Night ({nightWin.start} – {nightWin.end})
                </p>
                <div className="grid grid-cols-4 gap-2">
                  <CompactInput label="Start"
                    value={nightWin.start} onChange={(v) => save({ nightStart: v })} type="time" />
                  <CompactInput label="End"
                    value={nightWin.end} onChange={(v) => save({ nightEnd: v })} type="time" />
                  <CompactInput label="Min (min)"
                    value={nightWin.min} onChange={(v) => save({ nightMinMinutes: Number(v) })} type="number" min={1} />
                  <CompactInput label="Max (min)"
                    value={nightWin.max} onChange={(v) => save({ nightMaxMinutes: Number(v) })} type="number" min={1} />
                </div>
              </div>
            </div>
          </Card>
          )}

          {/* Breaking-News Criteria */}
                    {activeTab === "general" && (
<Card
            icon={Flame}
            title="Breaking-News Criteria"
            hint="Toggle categories that trigger breaking alerts"
            className="sm:col-span-2"
          >
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {allCats.map((cat) => (
                  <Pill
                    key={cat}
                    label={cat}
                    active={breakingCats.includes(cat)}
                    onClick={() => toggleBreakingCat(cat)}
                  />
                ))}
              </div>
              <Separator />
              <CompactToggle
                label="Breaking can interrupt night window"
                checked={s["breakingInterruptsNight"] !== false}
                onChange={(v) => save({ breakingInterruptsNight: v })}
              />
            </div>
          </Card>
          )}

          {/* Translation Glossary */}
                    {activeTab === "translation" && (
<Card
            icon={ScrollText}
            title="Translation Glossary"
            hint="One term per line: English = Kurdish Sorani"
            className="sm:col-span-2"
          >
            <textarea
              value={s["translationGlossary"] ?? ""}
              onChange={(e) => save({ translationGlossary: e.target.value })}
              rows={8}
              placeholder={`Strait of Hormuz = تەنگی هورمز\nIRGC = سوپای پاسداران\nCENTCOM = سێنتکام`}
              dir="auto"
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:ring-primary/20 focus:border-primary resize-y font-mono"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              {(s["translationGlossary"] ?? "").length} characters
            </p>
          </Card>
          )}
        </div>
      }

      {/* ════════════════════════════════════════════════
            SOURCES & TRANSLATION TAB
          ════════════════════════════════════════════════ */}
      {
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
          {/* Providers */}
                    {activeTab === "sources" && (
<Card
            icon={Package}
            title="Providers"
            hint={`${sources.length} source${sources.length !== 1 ? "s" : ""} configured`}
            action={
              <AddSourceButton
                onSave={(name, kind, secretRef) =>
                  upsertSource({ ...pinArgs, name, kind, secretRef: secretRef || null }).catch(onError)
                }
              />
            }
            className="lg:col-span-3"
          >
            <div className="space-y-1">
              {sources.length === 0 ? (
                <p className="text-[11px] text-muted-foreground py-2">No sources yet.</p>
              ) : (
                sources.map((src: any) => (
                  <SourceRow
                    key={src._id}
                    src={src}
                    onToggle={(v) =>
                      upsertSource({ ...pinArgs, id: src._id, enabled: v }).catch(onError)
                    }
                    onDelete={() =>
                      upsertSource({ ...pinArgs, id: src._id, remove: true }).catch(onError)
                    }
                    onTest={() => {
                      const tid = toast.loading("Testing source…");
                      testSource({ pin, id: src._id })
                        .then((r) => {
                          toast.dismiss(tid);
                          toast.success(`Source OK — ${(r as any)?.detail ?? "connected"}`);
                        })
                        .catch((e) => {
                          toast.dismiss(tid);
                          onError(e);
                        });
                    }}
                  />
                ))
              )}
            </div>
            <div className="mt-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-[10px] text-primary">
              <strong>NewsData:</strong> Get your API key at{" "}
              <a href="https://newsdata.io" target="_blank" rel="noopener noreferrer" className="underline">
                newsdata.io
              </a>{" "}
              → paste it in the Secret ref field above. RSS feeds: use the feed URL as the secret ref.
            </div>
          </Card>
          )}

          {/* Telegram Channels */}
                    {activeTab === "telegram" && (
<Card
            icon={Hash}
            title="Telegram Channels"
            hint="Monitored channels"
            className="lg:col-span-3"
          >
            <div className="space-y-2">
              {sources
                .filter((s: any) => s.kind === "telegram")
                .map((src: any) => (
                  <TelegramChannelRow
                    key={src._id}
                    src={src}
                    onSave={(patch) =>
                      upsertSource({ ...pinArgs, id: src._id, ...patch }).catch(onError)
                    }
                    onDelete={() =>
                      upsertSource({ ...pinArgs, id: src._id, remove: true }).catch(onError)
                    }
                  />
                ))}
              <AddTelegramChannel
                onAdd={(handle) =>
                  upsertSource({
                    ...pinArgs,
                    name: handle,
                    kind: "telegram",
                    secretRef: null,
                  }).catch(onError)
                }
              />
            </div>
            <div className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-3">
              <p className="mb-2 text-[11px] font-semibold text-muted-foreground">
                🎬 Telegram video handling
              </p>
              <div className="space-y-3">
                <CompactToggle
                  label="Try Bot API for Telegram videos"
                  hint="On (default): forwards each candidate video into the bot's Saved Messages, calls getFile, and posts the real .mp4. Off: Telegram video posts degrade to text + source link instead of the misleading thumbnail-as-photo."
                  checked={(s["telegramVideoFetchMode"] ?? "bot_api") === "bot_api"}
                  onChange={(v) => save({ telegramVideoFetchMode: v ? "bot_api" : "off" })}
                />
                <CompactInput
                  label="Bot API staging chat id (optional)"
                  hint="If set, the pipeline uses this chat (e.g. a private staging channel you admin the bot in) for forwardMessage/getFile. If blank, the bot's own Saved Messages are used as the staging destination."
                  value={s["telegramVideoStagingChatId"] ?? ""}
                  onChange={(v) => {
                    const n = Number(String(v).trim());
                    save({ telegramVideoStagingChatId: Number.isFinite(n) && n > 0 ? Math.floor(n) : null });
                  }}
                  type="number"
                  min={0}
                />
              </div>
            </div>
          </Card>
          )}

          {/* Source Quality */}
                    {activeTab === "sources" && (
<Card
            icon={Activity}
            title="Source Quality"
            hint="Track per-source accept/reject rates and auto-pause junk feeds"
            className="lg:col-span-3"
          >
            <div className="space-y-3">
              <CompactToggle
                label="Auto-pause low-quality sources"
                checked={s["sourceAutoPauseEnabled"] !== false}
                onChange={(v) => save({ sourceAutoPauseEnabled: v })}
                hint="Sources rejected N times in a row are disabled automatically"
              />
              <CompactInput
                label="Pause after N consecutive rejections"
                value={s["sourceAutoPauseThreshold"] ?? 8}
                onChange={(v) => save({ sourceAutoPauseThreshold: Math.max(1, Number(v) || 8) })}
                type="number"
                min={1}
                max={100}
              />
              <p className="text-[10px] text-muted-foreground">
                Every article that passes the pipeline counts as accepted; every rejection (junk,
                off-topic, duplicate, disrespectful, stale) counts against the source that produced
                it. When a source hits the streak it is switched off here — toggle it back on to
                give it a clean slate.
              </p>
            </div>
          </Card>
          )}

          {/* Topic Queries */}
                    {activeTab === "telegram" && (
<Card
            icon={Filter}
            title="Topic Queries"
            hint={`${topics.length} topic${topics.length !== 1 ? "s" : ""}`}
            action={<AddTopicButton onAdd={(q, cat) => upsertTopic({ ...pinArgs, query: q, category: cat }).catch(onError)} />}
            className="lg:col-span-2"
          >
            <div className="space-y-1 max-h-[20rem] overflow-y-auto">
              {topics.length === 0 ? (
                <p className="text-[11px] text-muted-foreground py-2">No topic queries yet.</p>
              ) : (
                topics.map((t: any) => (
                  <Row key={t._id}>
                    <div className="min-w-0 flex-1 text-xs font-medium truncate text-foreground">
                      {t.query}
                    </div>
                    <Badge variant="secondary" className="text-[10px] shrink-0">
                      {t.category}
                    </Badge>
                    <Switch
                      checked={t.enabled !== false}
                      onCheckedChange={(v) =>
                        upsertTopic({ ...pinArgs, id: t._id, enabled: v, query: t.query }).catch(onError)
                      }
                      className="data-[state=checked]:bg-primary scale-75"
                    />
                    <IconBtn title="Delete" tone="danger" onClick={() => upsertTopic({ ...pinArgs, id: t._id, remove: true }).catch(onError)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconBtn>
                  </Row>
                ))
              )}
            </div>
          </Card>
          )}

          {/* Translation Provider */}
                    {activeTab === "translation" && (
<Card icon={Cpu} title="Translation Provider" hint="Model selection">
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
          )}

          {/* Translation API Keys */}
                    {activeTab === "translation" && (
<Card
            icon={Terminal}
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
                      className={`text-[10px] shrink-0 ${k.consecutiveFailures > 0 ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-400"}`}
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
          )}

          {/* Gemini Key Usage */}
                    {activeTab === "translation" && (
<Card
            icon={Flame}
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
                          {g.configured ? `${g.first8}…${g.last4}` : "not configured"}
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
                      {(k.models ?? []).map((mm: any) => (
                        <Badge
                          key={mm.model}
                          variant="secondary"
                          className={`text-[10px] ${
                            mm.status === "ok"
                              ? "bg-emerald-500/10 text-emerald-400"
                              : mm.status === "rate_limited"
                                ? "bg-amber-500/10 text-amber-400"
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
          )}

          {/* Translation History */}
                    {activeTab === "translation" && (
<Card
            icon={Clock}
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
          )}

          {/* Translation Failures */}
                    {activeTab === "translation" && (
<Card
            icon={AlertTriangle}
            title="Translation Failures"
            hint={`${translationFailures.length} recent`}
            className="lg:col-span-2"
          >
            <div className="space-y-1 max-h-[16rem] overflow-y-auto">
              {translationFailures.length === 0 ? (
                <p className="text-[11px] text-muted-foreground py-2">
                  <CheckCircle className="h-3 w-3 inline mr-1 text-emerald-400" />
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
          )}
        </div>
      }

      {/* ════════════════════════════════════════════════
            SYSTEM TAB
          ════════════════════════════════════════════════ */}
      {
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
          {/* Bot Connection */}
                    {activeTab === "telegram" && (
<Card
            icon={Wifi}
            title="Bot Connection"
            hint="Telegram bot status"
            className="lg:col-span-2"
          >
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex h-2 w-2 rounded-full ${
                    botTokenConfigured ? "bg-emerald-500" : "bg-destructive"
                  }`}
                />
                <span className="text-xs font-medium text-foreground">
                  {botTokenConfigured ? "Token configured" : "No token"}
                </span>
              </div>
              {botInfo?.username ? (
                <p className="text-xs text-muted-foreground">@{botInfo.username}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-[11px] gap-1"
                  onClick={() =>
                    refreshBotInfo({ pin })
                      .then((r) => {
                        setBotInfo({
                          username: (r as any).username ?? null,
                          name: (r as any).name ?? null,
                        });
                        toast.success(`Connected — @${(r as any).username ?? "unknown"}`);
                      })
                      .catch(onError)
                  }
                >
                  <RefreshCw className="h-3 w-3" /> Refresh bot info
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-[11px] gap-1"
                  onClick={() => {
                    const url = webhookUrl.trim() || window.location.origin;
                    const id = toast.loading("Setting webhook…");
                    setWebhook({ pin, baseUrl: url })
                      .then(() => {
                        toast.dismiss(id);
                        toast.success(`Webhook set → ${url}/telegram/webhook`);
                      })
                      .catch((e) => {
                        toast.dismiss(id);
                        onError(e);
                      });
                  }}
                >
                  <Wifi className="h-3 w-3" /> Set webhook
                </Button>
              </div>
              <CompactInput
                label="Webhook base URL"
                value={webhookUrl}
                onChange={setWebhookUrl}
                placeholder={window.location.origin}
              />
            </div>
          </Card>
          )}

          {/* Chats */}
                    {activeTab === "telegram" && (
<Card
            icon={MessageCircle}
            title="Chats"
            hint={`${chats.length} chat${chats.length !== 1 ? "s" : ""}`}
            className="lg:col-span-3"
          >
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-[11px] gap-1"
                  onClick={() =>
                    syncBotChats({ pin })
                      .then((r: any) => toast.success(`Synced — found ${r?.total ?? 0} chat(s)`))
                      .catch(onError)
                  }
                >
                  <RefreshCw className="h-3 w-3" /> Sync chats
                </Button>
                <AddChat
                  onAdd={(v) =>
                    addChat({ ...pinArgs, chatId: v.chatId, title: v.title, type: v.type }).catch(onError)
                  }
                />
              </div>
              <div className="space-y-1 max-h-[20rem] overflow-y-auto">
                {chats.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground py-2">No chats registered.</p>
                ) : (
                  chats.map((c: any) => (
                    <Row key={c._id}>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium truncate text-foreground">
                          {c.title ?? `Chat ${c.chatId}`}
                        </p>
                        <SubText>
                          {c.chatId} · {c.type ?? "private"}
                        </SubText>
                      </div>
                      <CompactSelect
                        label=""
                        value={c.language ?? "inherit"}
                        onChange={(v) =>
                          updateChat({
                            ...pinArgs,
                            id: c._id,
                            language: v === "inherit" ? null : v,
                          }).catch(onError)
                        }
                        options={[
                          { value: "inherit", label: "Inherit" },
                          { value: "en", label: "EN" },
                          { value: "ckb", label: "KU" },
                        ]}
                        className="!flex-row items-center gap-1"
                      />
                      <Switch
                        checked={c.active !== false}
                        onCheckedChange={(v) =>
                          updateChat({ ...pinArgs, id: c._id, active: v }).catch(onError)
                        }
                        className="data-[state=checked]:bg-primary scale-75"
                      />
                      <IconBtn
                        title="Remove"
                        tone="danger"
                        onClick={() =>
                          updateChat({ ...pinArgs, id: c._id, remove: true }).catch(onError)
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconBtn>
                    </Row>
                  ))
                )}
              </div>
            </div>
          </Card>
          )}

          {/* Polls */}
                    {activeTab === "telegram" && (
<Card icon={Vote} title="Polls" hint="Send a test poll">
            <div className="space-y-2">
              <input id="poll-chat-id" type="number" placeholder="e.g. -1001234567890" className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground" />
              <Button
                size="sm"
                className="h-8 text-[11px] w-full"
                onClick={() => {
                  const el = document.querySelector<HTMLInputElement>("#poll-chat-id");
                  const chatId = el ? Number(el.value) : 0;
                  if (!chatId) { toast.error("Enter a chat ID"); return; }
                  testPoll({ pin, chatId })
                    .then(() => toast.success("Test poll sent"))
                    .catch(onError);
                }}
              >
                <Play className="h-3 w-3 mr-1" /> Send test poll
              </Button>
            </div>
          </Card>
          )}

          {/* Recent Polls */}
                    {activeTab === "telegram" && (
<Card
            icon={BarChart3}
            title="Recent Polls"
            hint={`${polls.length} poll${polls.length !== 1 ? "s" : ""}`}
            className="lg:col-span-3"
          >
            <div className="space-y-1 max-h-[24rem] overflow-y-auto">
              {polls.length === 0 ? (
                <p className="text-[11px] text-muted-foreground py-2">No polls sent yet.</p>
              ) : (
                polls.map((p: any) => (
                  <div key={p._id} className="rounded-md border border-border px-3 py-2">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Badge variant="secondary" className="text-[10px]">
                        {p.language ?? "en"}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">{p.chatId}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {p.createdAt ? new Date(p.createdAt).toLocaleString() : ""}
                      </span>
                      <Badge
                        className={`text-[10px] ${p.closed ? "bg-muted text-muted-foreground" : "bg-emerald-500/10 text-emerald-400"}`}
                      >
                        {p.closed ? "Closed" : "Open"}
                      </Badge>
                    </div>
                    <p className="text-xs font-medium text-foreground">{p.question}</p>
                    {p.options?.length > 0 ? (
                      <div className="mt-1 space-y-0.5">
                        {p.options.map((opt: any, oi: number) => {
                          const total = p.options.reduce((a: number, o: any) => a + (o.voterCount ?? 0), 0);
                          const pct = total > 0 ? Math.round(((opt.voterCount ?? 0) / total) * 100) : 0;
                          const isWinner = total > 0 && opt.voterCount === Math.max(...p.options.map((o: any) => o.voterCount ?? 0));
                          return (
                            <div key={oi} className="flex items-center gap-2 text-[10px]">
                              <span className="w-16 shrink-0 text-muted-foreground truncate">
                                {isWinner ? "🏆 " : ""}{opt.text ?? `Option ${oi + 1}`}
                              </span>
                              <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${isWinner ? "bg-primary" : "bg-muted-foreground/40"}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="w-10 text-right tabular-nums text-muted-foreground">
                                {opt.voterCount ?? 0}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </Card>
          )}
        </div>
      }
      </div>
      </div>
      {/* ════════════════════════════════════════════════
            SYSTEM TAB
          ════════════════════════════════════════════════ */}
      {activeTab === "system" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
          <Card icon={Server} title="System Status" hint="Deployed backend health" className="lg:col-span-2">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Schema</p>
                <p className={`mt-0.5 text-xs font-medium ${(data as any).schemaMigrations?.ok ? "text-emerald-400" : "text-destructive"}`}>
                  {(data as any).schemaMigrations?.ok ? "migrations 0001–0011 applied" : "migrations missing — pipeline cannot queue"}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Telegram bot</p>
                <p className={`mt-0.5 text-xs font-medium ${(data as any).botConfigured ? "text-emerald-400" : "text-destructive"}`}>
                  {(data as any).botConfigured ? "token configured" : "no token"}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">NewsData</p>
                <p className={`mt-0.5 text-xs font-medium ${(data as any).newsdataConfigured ? "text-emerald-400" : "text-muted-foreground"}`}>
                  {(data as any).newsdataConfigured ? "API key set" : "no key"}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Queue</p>
                <p className="mt-0.5 text-xs font-medium text-foreground">{data.queuedTotal ?? 0} queued</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Published 24h</p>
                <p className="mt-0.5 text-xs font-medium text-foreground">{data.published24h ?? 0}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Translation fails 24h</p>
                <p className={`mt-0.5 text-xs font-medium tabular-nums ${Number(data.translationFails24h ?? 0) > 0 ? "text-destructive" : "text-foreground"}`}>
                  {data.translationFails24h ?? 0}
                </p>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ════════════════════════════════════════════════
            SECURITY TAB
          ════════════════════════════════════════════════ */}
      {activeTab === "security" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
          <Card icon={ShieldCheck} title="Security" hint="How this console is protected" className="lg:col-span-2">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-xs font-medium text-foreground">PIN-secured session active</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Every action in this console is gated by the admin PIN stored in this browser. The dashboard talks only
                to the PIN-gated <code className="rounded bg-muted px-1 py-0.5">admin</code> edge function — the database
                itself is locked down with row-level security (migration 0007) and is never reached directly from the
                browser.
              </p>
              <p className="text-[11px] text-muted-foreground">
                Settings save automatically as you type — nothing resets on login, refresh or redeploy.
              </p>
              <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[11px] border-destructive/40 text-destructive hover:bg-destructive/10" onClick={lock}>
                <Lock className="h-3.5 w-3.5" /> Lock console now
              </Button>
            </div>
          </Card>
        </div>
      )}

    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────── */

function AddSourceButton({
  onSave,
}: {
  onSave: (name: string, kind: string, secretRef: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("rss");
  const [secretRef, setSecretRef] = useState("");

  const handle = () => {
    if (!name.trim()) return;
    onSave(name.trim(), kind, secretRef.trim());
    setName("");
    setSecretRef("");
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
          <AlertDialogTitle>Add provider</AlertDialogTitle>
          <AlertDialogDescription>
            Enter the source name, type, and API key or URL reference.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <CompactInput label="Name" value={name} onChange={setName} placeholder="e.g. Reuters RSS" />
          <CompactSelect
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: "rss", label: "RSS" },
              { value: "newsdata", label: "NewsData.io" },
              { value: "telegram", label: "Telegram" },
            ]}
          />
          <CompactInput
            label="Secret ref (API key / URL)"
            value={secretRef}
            onChange={setSecretRef}
            placeholder="NEWSDATA_API_KEY or https://..."
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handle} disabled={!name.trim()}>
            Add source
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AddTopicButton({
  onAdd,
}: {
  onAdd: (query: string, category: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("iran");

  const handle = () => {
    if (!query.trim()) return;
    onAdd(query.trim(), category);
    setQuery("");
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
          <AlertDialogTitle>Add topic query</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="space-y-3">
          <CompactInput label="Query" value={query} onChange={setQuery} placeholder="e.g. IRGC drills" />
          <CompactSelect
            label="Category"
            value={category}
            onChange={setCategory}
            options={[
              "iran",
              "proxies",
              "iraq",
              "usa",
              "war",
              "oil",
              "middle-east",
              "nuclear",
            ].map((c) => ({ value: c, label: c }))}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handle} disabled={!query.trim()}>
            Add topic
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

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

/* ── Source row (non-telegram) ──────────────────────────── */
function SourceRow({
  src,
  onToggle,
  onDelete,
  onTest,
}: {
  src: any;
  onToggle: (v: boolean) => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  if (src.kind === "telegram") return null; // handled by TelegramChannelRow
  const autoPaused = Boolean(src.autoPaused);
  return (
    <Row>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate text-foreground">
          {src.name}
          {autoPaused ? (
            <span className="ml-2 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
              auto-paused
            </span>
          ) : null}
        </p>
        <SubText>
          {src.kind} · {src.secretRef ? "API key set" : "No key"}
          <span className="ml-1.5">
            {Number(src.publishedCount ?? 0)} ok · {Number(src.rejectedCount ?? 0)} rejected
          </span>
        </SubText>
      </div>
      <Badge variant="secondary" className="text-[10px] shrink-0">
        {src.kind}
      </Badge>
      <Switch
        checked={src.enabled !== false}
        onCheckedChange={onToggle}
        className="data-[state=checked]:bg-primary scale-75"
      />
      <IconBtn title="Test" tone="primary" onClick={onTest}>
        <Activity className="h-3.5 w-3.5" />
      </IconBtn>
      <ConfirmDelete onConfirm={onDelete} />
    </Row>
  );
}

function ConfirmDelete({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <button type="button" className="p-1 text-muted-foreground hover:text-destructive transition-colors">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
            className="bg-destructive hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
