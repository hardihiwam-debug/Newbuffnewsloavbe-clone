import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Inbox,
  GitBranch,
  Send,
  RadioTower,
  Sparkles,
  BarChart3,
  Settings,
  Lock,
  Menu,
  X,
  Sun,
  Moon,
  ChevronUp,
  Clock,
} from "lucide-react";
import { useState, type ReactNode, useRef, useEffect, useCallback } from "react";
import { clearStoredPin } from "@/lib/pinStorage";
import { NewsroomProvider, useNewsroomData } from "@/lib/newsroomStore";
import { Button } from "@/components/ui/button";

const NAV_ITEMS = [
  { to: "/overview", label: "Overview", icon: LayoutDashboard },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/events", label: "Events", icon: GitBranch },
  { to: "/published", label: "Published", icon: Send },
  { to: "/sources", label: "Sources", icon: RadioTower },
  { to: "/aidesk", label: "AI Desk", icon: Sparkles },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
] as const;

const MOBILE_PRIMARY = [
  { to: "/overview", label: "Overview", icon: LayoutDashboard },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/events", label: "Events", icon: GitBranch },
  { to: "/published", label: "Published", icon: Send },
] as const;

const MORE_ITEMS = [
  { to: "/sources", label: "Sources", icon: RadioTower },
  { to: "/aidesk", label: "AI Desk", icon: Sparkles },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

// The shell badge, bot status and every page read the same live payload from
// the shared NewsroomProvider (one set of fetches on per-resource cadences,
// instead of every mounted component polling the whole dashboard).
export { useNewsroomData, refreshNewsroomData } from "@/lib/newsroomStore";

export function AppShell({ children }: { children?: ReactNode }) {
  return (
    <NewsroomProvider>
      <AppShellInner>{children}</AppShellInner>
    </NewsroomProvider>
  );
}

function AppShellInner({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );

  function toggleTheme() {
    const next: "dark" | "light" = document.documentElement.classList.contains("dark") ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* ignore storage errors */
    }
    setTheme(next);
  }
  const data = useNewsroomData();
  const s = (data?.settings ?? {}) as Record<string, any>;
  const paused = Boolean(s["botPaused"]);
  const queued = Number(data?.queuedTotal ?? data?.queueAll?.length ?? 0);
  const recentActivity = (data?.recentActivity ?? []) as any[];
  const lastRun = recentActivity.find((a) => a.type === "publish" || a.type === "ingest");
  const lastRunAt = lastRun?.createdAt ? new Date(lastRun.createdAt) : null;

  function lock() {
    clearStoredPin();
    navigate({ to: "/", replace: true });
  }

  const isActive = (to: string) => path.startsWith(to);

  // Close More sheet on outside click
  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (sheetRef.current && !sheetRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    // Delay listeners to avoid the click that opened the sheet
    const t = setTimeout(() => {
      document.addEventListener("pointerdown", onPointer);
    }, 100);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [moreOpen]);

  // Close on navigation
  useEffect(() => { setMoreOpen(false); setMobileOpen(false); }, [path]);

  const lastRunLabel = lastRunAt
    ? `${Math.round((Date.now() - lastRunAt.getTime()) / 60_000)}m ago`
    : null;

  return (
    <div className="flex min-h-screen">
      {/* ── Desktop sidebar ─────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-56 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <Link to="/overview" className="flex items-center gap-2.5 border-b border-sidebar-border px-4 py-4">
          <span className="grid h-7 w-7 place-items-center rounded-[6px] bg-brand text-[11px] font-bold tracking-wider text-brand-foreground">
            ID
          </span>
          <span className="leading-tight">
            <span className="block font-display text-sm font-bold tracking-[0.16em] text-sidebar-foreground">IRAN DESK</span>
            <span className="block text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
              Newsroom
            </span>
          </span>
        </Link>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-2.5 rounded-[6px] px-3 py-2 text-[13px] font-medium transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? "text-primary-foreground" : ""}`} />
                <span className="flex-1">{item.label}</span>
                {item.to === "/inbox" && queued > 0 ? (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                      active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {queued}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-sidebar-border p-2">
          <Link
            to="/settings"
            className={`flex items-center gap-2.5 rounded-[6px] px-3 py-2 text-[13px] font-medium transition-colors ${
              isActive("/settings")
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
            }`}
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>
          <div className="mt-1 flex items-center gap-2 px-3 py-2">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                paused ? "bg-destructive" : "bg-healthy"
              }`}
            />
            <span className="text-[11px] text-muted-foreground">
              {paused ? "Bot paused" : "Bot operational"}
              {lastRunAt ? ` · last run ${lastRunAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
            </span>
          </div>
          <div className="mt-1 flex flex-col gap-0.5 border-t border-sidebar-border pt-1.5">
            <button
              type="button"
              onClick={toggleTheme}
              className="flex w-full items-center gap-2.5 rounded-[6px] px-3 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
            <button
              type="button"
              onClick={lock}
              className="flex w-full items-center gap-2.5 rounded-[6px] px-3 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
            >
              <Lock className="h-4 w-4" />
              Lock console
            </button>
          </div>
        </div>
      </aside>

      {/* ── Mobile top bar ──────────────────────────── */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-2 md:hidden">
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => setMobileOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link to="/overview" className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-[6px] bg-brand text-[10px] font-bold text-brand-foreground">
            ID
          </span>
          <span className="font-display text-xs font-bold tracking-[0.12em]">IRAN DESK</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          {/* Last-run timestamp */}
          {lastRunLabel ? (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
              <Clock className="h-3 w-3" />
              {lastRunLabel}
            </span>
          ) : null}
          <span
            className={`flex items-center gap-1.5 text-[10px] font-medium ${
              paused ? "text-destructive" : "text-healthy"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-destructive" : "bg-healthy"}`} />
            {paused ? "PAUSED" : "LIVE"}
          </span>
          <button
            type="button"
            onClick={toggleTheme}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={lock}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground"
          >
            <Lock className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Mobile drawer ───────────────────────────── */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-sidebar">
            <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
              <span className="font-display text-sm font-bold tracking-[0.14em]">IRAN DESK</span>
              <button type="button" onClick={() => setMobileOpen(false)} className="rounded-md p-1 text-muted-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
              {[...NAV_ITEMS, { to: "/settings", label: "Settings", icon: Settings }].map((item) => {
                const active = isActive(item.to);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-2.5 rounded-[6px] px-3 py-2 text-[13px] font-medium ${
                      active ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="flex-1">{item.label}</span>
                    {item.to === "/inbox" && queued > 0 ? (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
                        {queued}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </nav>
            <div className="border-t border-sidebar-border px-4 py-3 text-[11px] text-muted-foreground">
              <span className={`flex items-center gap-1.5 ${paused ? "text-destructive" : "text-healthy"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-destructive" : "bg-healthy"}`} />
                {paused ? "Bot paused" : "Bot operational"}
                {lastRunAt ? ` · ${lastRunAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── More bottom sheet ───────────────────────── */}
      {moreOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMoreOpen(false)} />
          <div
            ref={sheetRef}
            className="absolute inset-x-0 bottom-0 animate-in slide-in-from-bottom rounded-t-2xl border-t border-border bg-sidebar pb-safe"
          >
            <div className="flex items-center justify-center pt-2 pb-1">
              <div className="h-1 w-10 rounded-full bg-border" />
            </div>
            <div className="flex items-center justify-between px-4 pb-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">More</span>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                className="rounded-full p-1 text-muted-foreground hover:text-foreground"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
            </div>
            <nav className="px-2 pb-4 space-y-0.5">
              {MORE_ITEMS.map((item) => {
                const active = isActive(item.to);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={() => setMoreOpen(false)}
                    className={`flex items-center gap-3 rounded-xl px-4 py-3 text-[14px] font-medium ${
                      active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-sidebar-accent/60"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      ) : null}

      {/* ── Main column ─────────────────────────────── */}
      <div className="min-w-0 flex-1 md:pl-56">
        <main className="mx-auto max-w-6xl px-4 pb-24 pt-14 md:px-6 md:pb-10 md:pt-6">
          {children ?? <Outlet />}
        </main>
      </div>

      {/* ── Mobile bottom nav ───────────────────────── */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-background/95 pb-safe md:hidden">
        {MOBILE_PRIMARY.map((item) => {
          const active = isActive(item.to);
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[9px] font-medium ${
                active ? "text-primary" : "text-muted-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
              {item.label}
              {item.to === "/inbox" && queued > 0 ? (
                <span className="absolute -mt-7 ml-5 rounded-full bg-primary px-1 text-[8px] font-bold text-primary-foreground">
                  {queued}
                </span>
              ) : null}
            </Link>
          );
        })}
        {/* "More" button opens bottom sheet instead of routing to /settings */}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[9px] font-medium ${
            MORE_ITEMS.some((m) => isActive(m.to))
              ? "text-primary"
              : "text-muted-foreground"
          }`}
        >
          <Menu className="h-4 w-4" />
          More
        </button>
      </nav>
    </div>
  );
}
