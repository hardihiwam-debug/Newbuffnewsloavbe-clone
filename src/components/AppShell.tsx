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
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, useAdminQuery } from "@/lib/supabaseAdminHooks";
import { readStoredPin, clearStoredPin } from "@/routes/index";
import { Button } from "@/components/ui/button";

export const NAV_ITEMS = [
  { to: "/overview", label: "Overview", icon: LayoutDashboard },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/events", label: "Events", icon: GitBranch },
  { to: "/published", label: "Published", icon: Send },
  { to: "/sources", label: "Sources", icon: RadioTower },
  { to: "/aidesk", label: "AI Desk", icon: Sparkles },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
] as const;

const MOBILE_NAV = [
  { to: "/overview", label: "Overview", icon: LayoutDashboard },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/events", label: "Events", icon: GitBranch },
  { to: "/sources", label: "Sources", icon: RadioTower },
  { to: "/more", label: "More", icon: Menu },
] as const;

export type NavTarget = (typeof NAV_ITEMS)[number]["to"];

// One shared data hook so the shell badge, bot status and every page read
// the same live payload. The shell consumes only the count + pause state;
// pages consume the rest.
export function useNewsroomData() {
  const pin = readStoredPin();
  const pinArgs = pin ? { pin } : {};
  return useAdminQuery<{
    settings?: Record<string, unknown>;
    chats?: any[];
    sources?: any[];
    topics?: any[];
    queue?: any[];
    queueAll?: any[];
    history?: any[];
    recentActivity?: any[];
    analytics?: any[];
    queuedTotal?: number;
    published24h?: number;
    polls24h?: number;
    translationFails24h?: number;
    aiUsage24h?: { calls?: number; promptTokens?: number; completionTokens?: number; byProvider?: Record<string, any> };
    translationFailures?: any[];
    translationHistory?: any[];
    polls?: any[];
    schemaMigrations?: { ok: boolean; missing?: Record<string, string[]> };
    botConfigured?: boolean;
    newsdataConfigured?: boolean;
    clusters?: any[];
  }>(api.admin.getDashboard, pin ? pinArgs : "skip");
}

export function AppShell({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
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

  return (
    <div className="flex min-h-screen">
      {/* ── Desktop sidebar ─────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-56 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <Link to="/overview" className="flex items-center gap-2.5 border-b border-sidebar-border px-4 py-4">
          <span className="grid h-7 w-7 place-items-center rounded-[6px] bg-primary text-[11px] font-bold tracking-wider text-primary-foreground">
            ID
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-bold tracking-[0.18em] text-sidebar-foreground">IRAN DESK</span>
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
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? "text-sidebar-foreground" : ""}`} />
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
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
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
          <button
            type="button"
            onClick={lock}
            className="flex w-full items-center gap-2.5 rounded-[6px] px-3 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
          >
            <Lock className="h-4 w-4" />
            Lock console
          </button>
        </div>
      </aside>

      {/* ── Mobile top bar ──────────────────────────── */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-2.5 md:hidden">
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => setMobileOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link to="/overview" className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-[6px] bg-primary text-[10px] font-bold text-primary-foreground">
            ID
          </span>
          <span className="text-sm font-bold tracking-[0.15em]">IRAN DESK</span>
        </Link>
        <span
          className={`ml-auto flex items-center gap-1.5 text-[10px] font-medium ${
            paused ? "text-destructive" : "text-healthy"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-destructive" : "bg-healthy"}`} />
          {paused ? "PAUSED" : "OPERATIONAL"}
        </span>
        <button
          type="button"
          onClick={lock}
          className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
        >
          <Lock className="h-4 w-4" />
        </button>
      </div>

      {/* ── Mobile drawer ───────────────────────────── */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-sidebar">
            <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
              <span className="text-sm font-bold tracking-[0.15em]">IRAN DESK</span>
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
                      active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground"
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
              </span>
            </div>
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
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-background/95 md:hidden">
        {MOBILE_NAV.map((item) => {
          const active = isActive(item.to);
          const Icon = item.icon;
          const target = item.to === "/more" ? "/settings" : item.to;
          return (
            <Link
              key={item.to}
              to={target}
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
      </nav>
    </div>
  );
}
