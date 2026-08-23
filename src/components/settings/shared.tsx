// Shared UI helpers + context for the settings tabs.
//
// The old settings page was a single 2,300-line file where every card lived
// inline under `activeTab === "X"` conditions. The shell (settings.tsx) now
// owns the shared state (data, mutations, debounced save) and exposes it to
// the per-tab components through this context; the helpers below are the
// common card/form primitives every tab uses.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/* ── Card shell (theme-aware, matches dashboard panels) ─── */
// The 13 built-in categories — shared by the Categories tab and the
// breaking-criteria editor.
export const DEFAULT_CATEGORIES = [
  "iran",
  "oil",
  "war",
  "proxies",
  "usa",
  "middle-east",
  "iraq",
  "analysis",
  "gold",
  "economic-impact",
  "gaza",
  "syria",
  "lebanon",
] as const;

export function Card({
  icon: Icon,
  title,
  hint,
  action,
  id,
  className = "",
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  // Anchor id — lets Settings search / deep links scroll this card into view.
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`panel p-4 ${id ? "scroll-mt-24" : ""} ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-card-foreground">{title}</h2>
            {hint ? <p className="text-xs text-muted-foreground mt-0.5">{hint}</p> : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

/* ── Compact form helpers ────────────────────────────────── */
export function CompactInput({
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
  const isNumber = type === "number";
  // Local draft for numeric fields so the operator can clear the value and
  // type a new number. The parent coerces `Number("")` to a fallback, which
  // otherwise snaps the field back to its old/default number the moment it is
  // emptied — the "deleted number comes back" bug.
  const [draft, setDraft] = useState<string>(() => String(value ?? ""));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(value ?? ""));
  }, [value, focused]);

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <Label className="text-xs text-muted-foreground font-medium">{label}</Label>
      <Input
        type={type}
        value={isNumber ? draft : value}
        onChange={(e) => {
          const v = e.target.value;
          if (isNumber) {
            setDraft(v);
            if (v !== "") onChange(v);
          } else {
            onChange(v);
          }
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (isNumber && (draft.trim() === "" || Number.isNaN(Number(draft)))) {
            setDraft(String(value ?? ""));
          }
        }}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        dir={type === "text" ? "auto" : undefined}
        className="h-9 rounded-lg text-sm focus:ring-primary/20 focus:border-primary"
      />
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function CompactSelect({
  label,
  value,
  onChange,
  options,
  className = "",
  selectClassName = "",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  selectClassName?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {label ? <Label className="text-xs text-muted-foreground font-medium">{label}</Label> : null}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:ring-primary/20 focus:border-primary ${selectClassName}`}
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

export function CompactToggle({
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
        <Label className="text-xs text-muted-foreground font-medium">{label}</Label>
        {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        className="data-[state=checked]:bg-primary"
      />
    </div>
  );
}

export function Pill({
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
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
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
export function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2">
      {children}
    </div>
  );
}

export function SubText({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-muted-foreground">{children}</p>;
}

export function IconBtn({
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

/* ── Settings context ──────────────────────────────────────
   The shell computes everything below once and every tab reads what it needs
   through useSettings(). Kept loosely typed (Record<string, any>) to match the
   existing settings code style. */
export type SettingsContextValue = {
  s: Record<string, any>;
  save: (patch: Record<string, unknown>) => void;
  data: Record<string, any>;
  pin: string;
  pinArgs: Record<string, unknown>;
  onError: (e: unknown) => void;
  lock: () => void;
  // Derived lists from the dashboard payload.
  chats: any[];
  bots: any[];
  sources: any[];
  topics: any[];
  polls: any[];
  translationHistory: any[];
  translationFailures: any[];
  tkeys: any[];
  geminiUsage: any[];
  envGeminiCount: number;
  botTokenConfigured: boolean;
  categories: string[];
  // Mutations / actions (from useAdminMutation / useAdminAction).
  setCronSchedule: (a: any) => Promise<any>;
  updateChat: (a: any) => Promise<any>;
  addChat: (a: any) => Promise<any>;
  saveBot: (a: any) => Promise<any>;
  deleteBot: (a: any) => Promise<any>;
  upsertTopic: (a: any) => Promise<any>;
  upsertSource: (a: any) => Promise<any>;
  upsertTranslationKey: (a: any) => Promise<any>;
  testTranslationKey: (a: any) => Promise<any>;
  testGeminiKeys: (a: any) => Promise<any>;
  testSource: (a: any) => Promise<any>;
  refreshBotInfo: (a: any) => Promise<any>;
  setWebhook: (a: any) => Promise<any>;
  enableChatWebhooks: (a: any) => Promise<any>;
  setTranslationModel: (a: any) => Promise<any>;
  listTranslationModels: (a: any) => Promise<any>;
  getRewriteLog: (a: any) => Promise<any>;
  getRewriteAnalytics: (a: any) => Promise<any>;
  syncBotChats: (a: any) => Promise<any>;
  testPoll: (a: any) => Promise<any>;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({
  value,
  children,
}: {
  value: SettingsContextValue;
  children: ReactNode;
}) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const v = useContext(SettingsContext);
  if (!v) throw new Error("useSettings must be used inside SettingsProvider");
  return v;
}
