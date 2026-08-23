// Settings shell — 8-tab layout grouped by job, with search and deep links.
//
// Owns everything the tabs share: PIN handling, the dashboard-derived data
// (settings/chats/bots/sources/…), the debounced settings save (one network
// call per pause, not one per keystroke), and the admin mutations/actions.
// The tab content itself lives in src/components/settings/*.tsx and reads it
// all through useSettings().
//
// Search: ⌘K / Ctrl+K (or the search button) opens SettingsSearch — typing
// filters every card across tabs; picking one switches tab, opens any
// collapsible section containing it, and scrolls the card into view.
// Deep links: /settings?tab=<id>&card=<id> lands on the tab + card.
//
// Rendered by src/routes/_authenticated/settings.tsx.

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  CalendarClock,
  Cpu,
  Flame,
  Lock,
  Palette,
  RadioTower,
  Search,
  Send,
  Server,
  Settings2,
} from "lucide-react";
import { api, useAdminAction, useAdminMutation, useAdminQuery } from "@/lib/supabaseAdminHooks";
import { Button } from "@/components/ui/button";
import { useNewsroomData } from "@/lib/newsroomStore";
import { SettingsProvider, type SettingsContextValue } from "@/components/settings/shared";
import { SettingsSearch } from "@/components/settings/SettingsSearch";
import { clearStoredPin, readStoredPin } from "@/lib/pinStorage";
import { TelegramTab } from "@/components/settings/TelegramTab";
import { SourcesTab } from "@/components/settings/SourcesTab";
import { CategoriesTab } from "@/components/settings/CategoriesTab";
import { StyleTab } from "@/components/settings/StyleTab";
import { EditorialTab } from "@/components/settings/EditorialTab";
import { SchedulingTab } from "@/components/settings/SchedulingTab";
import { CampaignsTab } from "@/components/settings/CampaignsTab";
import { AiTranslationTab } from "@/components/settings/AiTranslationTab";
import { SystemTab } from "@/components/settings/SystemTab";
import { SecurityTab } from "@/components/settings/SecurityTab";

// Job-based nav: 4 groups, each with sub-tabs. Tab ids are stable — the
// search registry and ?tab= deep links keep working across regroupings.
type TabId =
  | "telegram"
  | "sources"
  | "style"
  | "editorial"
  | "categories"
  | "scheduling"
  | "campaigns"
  | "ai"
  | "system";

type TabDef = { id: TabId; label: string; icon: React.ComponentType<{ className?: string }> };

const TAB_GROUPS: { label: string; icon?: React.ComponentType<{ className?: string }>; tabs: TabDef[] }[] = [
  {
    label: "Channels",
    icon: RadioTower,
    tabs: [
      { id: "telegram", label: "Telegram", icon: Send },
      { id: "sources", label: "Sources", icon: RadioTower },
    ],
  },
  {
    label: "Content",
    icon: Palette,
    tabs: [
      { id: "style", label: "Style", icon: Palette },
      { id: "editorial", label: "Editorial", icon: Flame },
      { id: "categories", label: "Categories", icon: Settings2 },
    ],
  },
  {
    label: "Delivery",
    icon: CalendarClock,
    tabs: [
      { id: "scheduling", label: "Scheduling", icon: CalendarClock },
      { id: "campaigns", label: "Campaigns", icon: Send },
    ],
  },
  {
    label: "Intelligence & System",
    icon: Cpu,
    tabs: [
      { id: "ai", label: "AI & Translation", icon: Cpu },
      { id: "system", label: "System & Security", icon: Server },
    ],
  },
];

const TABS = TAB_GROUPS.flatMap((g) => g.tabs);

export function SettingsShell() {
  const navigate = useNavigate();
  const pin = readStoredPin();
  // Stable identities: pinArgs/onError feed flushSave's useCallback deps, and
  // the unmount-flush effect must only fire on unmount — if these churned every
  // render, the cleanup would flush pending debounced saves on every re-render
  // (e.g. the 5–10s dashboard polls), defeating the debounce.
  const pinArgs = useMemo(() => (pin ? { pin } : {}), [pin]);

  const data = useNewsroomData();
  // listTranslationKeys reads up to 5,000 usage rows per call — only the
  // AI & Translation tab needs it, so it polls every 30s (not the 5s default)
  // and only while this page is mounted.
  const translationKeyData = useAdminQuery(
    api.admin.listTranslationKeys,
    pin ? pinArgs : ("skip" as const),
    { refetchIntervalMs: 30_000 },
  );

  const saveSettings = useAdminMutation(api.admin.saveSettings);
  const updateChat = useAdminMutation(api.admin.updateChat);
  const addChat = useAdminMutation(api.admin.addChat);
  const saveBot = useAdminMutation(api.admin.saveBot);
  const deleteBot = useAdminMutation(api.admin.deleteBot);
  const upsertTopic = useAdminMutation(api.admin.upsertTopic);
  const upsertSource = useAdminMutation(api.admin.upsertSource);
  const upsertTranslationKey = useAdminMutation(api.admin.upsertTranslationKey);
  const testTranslationKey = useAdminAction(api.admin_actions.testTranslationKey);
  const testGeminiKeys = useAdminAction(api.admin_actions.testGeminiKeys);
  const testSource = useAdminAction(api.admin_actions.testSource);
  const refreshBotInfo = useAdminAction(api.admin_actions.refreshBotInfo);
  const setWebhook = useAdminAction(api.admin_actions.setWebhook);
  const enableChatWebhooks = useAdminAction(api.admin_actions.enableChatWebhooks);
  const setTranslationModel = useAdminMutation(api.admin.setTranslationModel);
  const setCronSchedule = useAdminAction(api.admin_actions.setCronSchedule);
  const listTranslationModels = useAdminAction(api.admin_actions.listTranslationModels);
  const getRewriteLog = useAdminAction(api.admin_actions.getRewriteLog);
  const getRewriteAnalytics = useAdminAction(api.admin_actions.getRewriteAnalytics);
  const syncBotChats = useAdminAction(api.admin_actions.syncBotChats);
  const testPoll = useAdminAction(api.admin_actions.testPoll);

  const onError = useCallback(
    (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong"),
    [],
  );

  // ── Debounced settings save ─────────────────────────────────────────────
  // The optimistic overlay updates synchronously on every change so inputs
  // stay stable (no char-vanish while a save is in flight). The network call
  // is coalesced with a 600ms debounce so typing a long value fires ONE
  // request instead of one per keystroke, and it flushes on unmount so a
  // mid-debounce navigation never loses the last edits.
  const [optimisticSettings, setOptimisticSettings] = useState<Record<string, any>>({});
  const pendingRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saving, setSaving] = useState(false);

  // Dirty-dot tracking: which tabs have unsaved edits. The save() call comes
  // from whichever tab is mounted, so we attribute the patch to the active
  // tab and clear the dot once the debounced flush succeeds.
  const dirtyRef = useRef<Set<TabId>>(new Set());
  const [dirtyTabs, setDirtyTabs] = useState<ReadonlySet<TabId>>(new Set());
  const activeTabRef = useRef<TabId>("telegram");

  const flushSave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const patch = pendingRef.current;
    if (!patch || Object.keys(patch).length === 0) return;
    pendingRef.current = {};
    setSaving(true);
    saveSettings({ ...pinArgs, patch })
      .then(() => {
        dirtyRef.current.clear();
        setDirtyTabs(new Set());
      })
      .catch(onError)
      .finally(() => setSaving(false));
  }, [pinArgs, onError, saveSettings]);

  const save = useCallback(
    (patch: Record<string, unknown>) => {
      setOptimisticSettings((prev) => ({ ...prev, ...patch }));
      pendingRef.current = { ...pendingRef.current, ...patch };
      dirtyRef.current.add(activeTabRef.current);
      setDirtyTabs(new Set(dirtyRef.current));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flushSave, 600);
    },
    [flushSave],
  );

  useEffect(() => () => flushSave(), [flushSave]);

  // ── Tab state + deep links ──────────────────────────────────────────────
  // Deep links (/settings?tab=<id>&card=<id>) are read straight from the URL
  // and written back with history.replaceState — the settings route keeps no
  // router search schema, so nothing here fights the router's navigation.
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t && TABS.some((x) => x.id === t) ? (t as TabId) : "telegram";
  });

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // A card target from a deep link / search jump is scrolled into view once
  // its tab has mounted (opening any collapsible section containing it).
  const pendingCardRef = useRef<string | null>(null);

  useEffect(() => {
    const card = new URLSearchParams(window.location.search).get("card");
    if (card) pendingCardRef.current = card;
  }, []);

  useEffect(() => {
    if (!pendingCardRef.current) return;
    const id = pendingCardRef.current;
    pendingCardRef.current = null;
    const t = setTimeout(() => {
      const el = document.getElementById(id);
      if (el) {
        const details = el.closest("details");
        if (details instanceof HTMLDetailsElement) details.open = true;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 150);
    return () => clearTimeout(t);
  }, [activeTab]);

  const scrollToCard = useCallback((cardId: string) => {
    setTimeout(() => {
      const el = document.getElementById(cardId);
      if (el) {
        const details = el.closest("details");
        if (details instanceof HTMLDetailsElement) details.open = true;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 60);
  }, []);

  const selectTab = useCallback((id: TabId) => {
    setActiveTab(id);
    window.history.replaceState(null, "", `/settings?tab=${id}`);
  }, []);

  // ── Search modal ────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const jumpTo = useCallback(
    (tab: TabId, cardId: string) => {
      setSearchOpen(false);
      window.history.replaceState(null, "", `/settings?tab=${tab}&card=${cardId}`);
      if (tab === activeTabRef.current) {
        scrollToCard(cardId);
      } else {
        pendingCardRef.current = cardId;
        setActiveTab(tab);
      }
    },
    [scrollToCard],
  );

  function lock() {
    clearStoredPin();
    navigate({ to: "/", replace: true });
  }

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
  const bots = (data.bots ?? []) as any[];
  const sources = (data.sources ?? []) as any[];
  const topics = (data.topics ?? []) as any[];
  const polls = (data.polls ?? []) as any[];
  const translationHistory = (data.translationHistory ?? []) as any[];
  const translationFailures = (data.translationFailures ?? []) as any[];
  const tkeys = (translationKeyData as any)?.keys ?? [];
  const geminiUsage = (translationKeyData as any)?.geminiUsage ?? [];
  // Count of GEMINI_API_KEY_1..N read from the runtime env — these keys are
  // picked up by the pipeline automatically and are the keys that actually do
  // the translation; the table below only holds ADDITIONAL stored keys.
  const envGeminiCount = Number((translationKeyData as any)?.envDefaults?.gemini ?? 0);
  // Token presence comes from the dashboard summary (botConfigured), NOT from
  // the bot list — the summary reflects the runtime env.
  const botTokenConfigured = Boolean((data as any).botConfigured);
  const categories = ((data as any).categories ?? []) as string[];

  const ctxValue: SettingsContextValue = {
    s,
    save,
    data,
    pin,
    pinArgs,
    onError,
    lock,
    chats,
    bots,
    sources,
    topics,
    polls,
    translationHistory,
    translationFailures,
    tkeys,
    geminiUsage,
    envGeminiCount,
    botTokenConfigured,
    categories,
    updateChat,
    addChat,
    saveBot,
    deleteBot,
    upsertTopic,
    upsertSource,
    upsertTranslationKey,
    testTranslationKey,
    testGeminiKeys,
    testSource,
    refreshBotInfo,
    setWebhook,
    enableChatWebhooks,
    setTranslationModel,
    setCronSchedule,
    listTranslationModels,
    getRewriteLog,
    getRewriteAnalytics,
    syncBotChats,
    testPoll,
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
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
            <p className="text-xs text-muted-foreground">Channels, content, scheduling &amp; system</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-muted-foreground"
            onClick={() => setSearchOpen(true)}
            title="Search settings (⌘K / Ctrl+K)"
          >
            <Search className="h-3.5 w-3.5" />
            Search settings…
            <kbd className="ml-1 rounded border border-border bg-muted px-1 text-[9px]">⌘K</kbd>
          </Button>
          <span
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium ${
              saving
                ? "bg-muted text-muted-foreground"
                : "border border-healthy/25 bg-healthy/10 text-healthy"
            }`}
          >
            {saving ? "Saving…" : "All changes saved"}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={lock}
          >
            <Lock className="h-3.5 w-3.5" />
            Lock console
          </Button>
        </div>
      </header>

      {/* ── Settings navigation ───────────────────────────────── */}
      <div className="mb-6 grid gap-4 lg:grid-cols-[180px_1fr]">
        <nav className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
          {TAB_GROUPS.map((group) => (
            <div key={group.label} className="flex shrink-0 gap-1 lg:flex-col">
              {/* Group header — desktop only; on mobile tabs scroll flat. */}
              <p className="hidden px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70 lg:block">
                {group.label}
              </p>
              {group.tabs.map((t) => {
                const Icon = t.icon;
                const dirty = dirtyTabs.has(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => selectTab(t.id)}
                    className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] font-medium transition-colors lg:w-full lg:pl-6 ${
                      activeTab === t.id
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{t.label}</span>
                    {dirty ? (
                      <span className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${activeTab === t.id ? "bg-primary-foreground" : "bg-primary"}`} />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="min-w-0">
          <SettingsProvider value={ctxValue}>
            {activeTab === "telegram" && <TelegramTab />}
            {activeTab === "sources" && <SourcesTab />}
            {activeTab === "categories" && <CategoriesTab />}
            {activeTab === "style" && <StyleTab />}
            {activeTab === "editorial" && <EditorialTab />}
            {activeTab === "scheduling" && <SchedulingTab />}
            {activeTab === "campaigns" && <CampaignsTab />}
            {activeTab === "ai" && <AiTranslationTab />}
            {activeTab === "system" && (
              <div className="space-y-4">
                <SystemTab />
                <SecurityTab />
              </div>
            )}
          </SettingsProvider>
        </div>
      </div>

      <SettingsSearch open={searchOpen} onClose={() => setSearchOpen(false)} onJump={jumpTo} />
    </div>
  );
}
