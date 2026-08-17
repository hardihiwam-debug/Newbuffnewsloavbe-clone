import { useRef, useState, type ReactNode, type TouchEvent } from "react";
import { Pencil, SendHorizonal, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import { adminApi } from "@/lib/adminApi";

// ── Time helpers ────────────────────────────────────────────────────────────
export function relTime(iso?: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function clockTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const CATEGORY_COLORS: Record<string, string> = {
  war: "text-destructive border-destructive/40 bg-destructive/10",
  iran: "text-info border-info/40 bg-info/10",
  proxies: "text-[color:oklch(0.68_0.14_305)] border-[color:oklch(0.68_0.14_305)]/40 bg-[color:oklch(0.68_0.14_305)]/10",
  usa: "text-info border-info/40 bg-info/10",
  oil: "text-[color:oklch(0.72_0.12_85)] border-[color:oklch(0.72_0.12_85)]/40 bg-[color:oklch(0.72_0.12_85)]/10",
  gold: "text-review border-review/40 bg-review/10",
  "economic-impact": "text-healthy border-healthy/40 bg-healthy/10",
  "middle-east": "text-[color:oklch(0.68_0.14_305)] border-[color:oklch(0.68_0.14_305)]/40 bg-[color:oklch(0.68_0.14_305)]/10",
  analysis: "text-muted-foreground border-border bg-muted/40",
  iraq: "text-healthy border-healthy/40 bg-healthy/10",
};

export function CategoryPill({ category }: { category?: string | null }) {
  const c = String(category ?? "unknown");
  return (
    <span className={`rounded-[4px] border px-1.5 py-0.5 text-[10px] font-medium ${CATEGORY_COLORS[c] ?? "text-muted-foreground border-border bg-muted/40"}`}>
      {c}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    breaking: { label: "BREAKING", cls: "text-destructive border-destructive/50 bg-destructive/10" },
    update: { label: "UPDATE", cls: "text-review border-review/50 bg-review/10" },
    queued: { label: "READY", cls: "text-healthy border-healthy/50 bg-healthy/10" },
    rejected: { label: "REJECTED", cls: "text-muted-foreground border-border bg-muted/40" },
    published: { label: "PUBLISHED", cls: "text-healthy border-healthy/50 bg-healthy/10" },
    held: { label: "HELD", cls: "text-review border-review/50 bg-review/10" },
    minor: { label: "MINOR", cls: "text-muted-foreground border-border bg-muted/40" },
  };
  const entry = map[status] ?? { label: status.toUpperCase(), cls: "text-muted-foreground border-border bg-muted/40" };
  return <span className={`rounded-[4px] border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${entry.cls}`}>{entry.label}</span>;
}

// ── KPI strip item ──────────────────────────────────────────────────────────
export function Kpi({
  value,
  label,
  tone = "neutral",
  delta,
  hint,
}: {
  value: ReactNode;
  label: string;
  tone?: "neutral" | "danger" | "review" | "healthy";
  delta?: string | null;
  hint?: string;
}) {
  const toneCls =
    tone === "danger" ? "text-destructive" : tone === "review" ? "text-review" : tone === "healthy" ? "text-healthy" : "text-foreground";
  return (
    <div className="panel px-4 py-3">
      <p className={`text-[28px] font-bold leading-none tabular-nums ${toneCls}`}>{value}</p>
      <p className="mt-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      {delta ? <p className="mt-0.5 text-[10px] text-muted-foreground">{delta}</p> : null}
      {hint ? <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// ── Editorial story card (Inbox / feed) ─────────────────────────────────────
export function StoryCard({
  item,
  onReview,
  onPublish,
  onEdit,
  onReject,
  onDelete,
  busy,
  showFacts = true,
}: {
  item: any;
  onReview?: (item: any) => void;
  onPublish?: (item: any) => void;
  onEdit?: (item: any) => void;
  onReject?: (item: any) => void;
  onDelete?: (item: any) => void;
  busy?: boolean;
  showFacts?: boolean;
}) {
  const facts = (item?.facts ?? null) as Record<string, unknown> | null;
  const numbers = Array.isArray(facts?.numbers) ? (facts.numbers as string[]) : [];
  // Swipe-left-to-delete: a horizontal left swipe hard-deletes the item
  // (no confirmation) — preferring onDelete, falling back to onReject.
  const swipeDelete = onDelete ?? onReject;
  const swipeXRef = useRef(0);
  const [swipeX, setSwipeX] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onSwipeStart = (e: TouchEvent<HTMLDivElement>) => {
    if (!swipeDelete) return;
    const t = e.touches[0];
    if (t) touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onSwipeMove = (e: TouchEvent<HTMLDivElement>) => {
    if (!swipeDelete || !touchStart.current) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      const clamped = Math.max(-96, Math.min(0, dx));
      swipeXRef.current = clamped;
      setSwipeX(clamped);
    }
  };
  const onSwipeEnd = () => {
    if (!swipeDelete) return;
    const shouldDelete = swipeXRef.current <= -60;
    touchStart.current = null;
    swipeXRef.current = 0;
    setSwipeX(0);
    if (shouldDelete) swipeDelete(item);
  };
  return (
    <div
      className="panel-hover hover:border-border/100 px-4 py-3"
      style={{ transform: `translateX(${swipeX}px)`, transition: swipeX === 0 ? "transform 150ms ease" : "none", touchAction: "pan-y" }}
      onTouchStart={onSwipeStart}
      onTouchMove={onSwipeMove}
      onTouchEnd={onSwipeEnd}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {item.breaking ? <StatusPill status="breaking" /> : null}
            {item.isUpdate ? <StatusPill status="update" /> : null}
            <CategoryPill category={item.category} />
            {item.importance === "minor" && !item.breaking ? <StatusPill status="minor" /> : null}
          </div>
          <button
            type="button"
            onClick={() => onReview?.(item)}
            className="mt-1.5 block w-full text-left text-[15px] font-semibold leading-snug text-foreground hover:text-primary"
          >
            {item.headline || "(untitled)"}
          </button>
          {item.summary ? (
            <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{item.summary}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground/80">{item.sourceName ?? "--"}</span>
            <span>{clockTime(item.createdAt ?? item.originalPublishedAt)}</span>
            {typeof item.score === "number" ? <span className="tabular-nums">score {item.score}</span> : null}
            {showFacts && numbers.length > 0 ? (
              <span className="text-review" title="Figures preserved from source">
                {numbers.length} figure{numbers.length === 1 ? "" : "s"} preserved
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {onReview ? (
            <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={() => onReview(item)}>
              Review
            </Button>
          ) : null}
          <div className="flex items-center gap-1">
            {onEdit ? (
              <button type="button" title="Edit" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => onEdit(item)}>
                <Pencil className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {onPublish ? (
              <button
                type="button"
                title="Publish now"
                disabled={busy}
                className="rounded p-1 text-healthy hover:text-foreground disabled:opacity-40"
                onClick={() => onPublish(item)}
              >
                <SendHorizonal className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {onReject ? (
              <button type="button" title="Reject" className="rounded p-1 text-muted-foreground hover:text-destructive" onClick={() => onReject(item)}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Confirm-before-destructive-action ───────────────────────────────────────
export function ConfirmAction({
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

// ── Edit & publish dialog ───────────────────────────────────────────────────
export const EDIT_CATEGORIES = [
  "war", "iran", "proxies", "usa", "oil", "gold", "economic-impact",
  "middle-east", "analysis", "iraq",
];

export function EditQueueItemDialog({
  item,
  pin,
  onClose,
  onSaved,
}: {
  item: any | null;
  pin?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  return (
    <Dialog open={Boolean(item)} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        {item ? (
          <EditQueueForm key={String(item.id ?? item._id ?? "item")} item={item} pin={pin} onDone={() => { onClose(); onSaved?.(); }} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EditQueueForm({ item, pin, onDone }: { item: any; pin?: string; onDone: () => void }) {
  const [headline, setHeadline] = useState(String(item.headline ?? ""));
  const [summary, setSummary] = useState(String(item.summary ?? ""));
  const [category, setCategory] = useState(String(item.category ?? "iran"));
  const [breaking, setBreaking] = useState(Boolean(item.breaking));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!pin || !headline.trim()) return;
    setSaving(true);
    const id = String(item.id ?? item._id);
    try {
      await adminApi.editQueueItem({ pin, id, headline, summary, category, breaking });
      toast.success("Queue item updated");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit story</DialogTitle>
        <DialogDescription>Correct the copy, then use “Publish now” (or the next cycle) to send it.</DialogDescription>
      </DialogHeader>
      <div className="mt-2 space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Headline</Label>
          <Textarea value={headline} onChange={(e) => setHeadline(e.target.value)} rows={2} className="text-sm" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Summary</Label>
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} className="text-sm" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Category</Label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-9 w-full rounded-[6px] border border-input bg-background px-2 text-sm"
            >
              {EDIT_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end justify-between gap-2 pb-1">
            <div className="space-y-1.5">
              <Label className="text-xs">Breaking</Label>
              <p className="text-[10px] text-muted-foreground">🚨 bypasses the posting window</p>
            </div>
            <Switch checked={breaking} onCheckedChange={setBreaking} />
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={onDone}>Cancel</Button>
        <Button size="sm" className="h-8 gap-1 text-[11px]" disabled={saving || !headline.trim()} onClick={save}>
          <Pencil className="h-3 w-3" /> {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </>
  );
}

// ── Section header ──────────────────────────────────────────────────────────
export function SectionTitle({ eyebrow, title, hint, action }: {
  eyebrow?: string;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
      <div>
        {eyebrow ? <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">{eyebrow}</p> : null}
        <h1 className="text-[22px] font-bold leading-tight text-foreground">{title}</h1>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function EmptyState({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[6px] border border-dashed border-border px-6 py-10 text-center">
      {icon ? <div className="mb-2 text-muted-foreground">{icon}</div> : null}
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}

export function CloseIcon() {
  return <X className="h-3.5 w-3.5" />;
}
