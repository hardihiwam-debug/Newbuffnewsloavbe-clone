// Settings search — ⌘K / Ctrl+K, or the search button in the header.
// Filters the settings index by label/tab/keywords and jumps to a card:
// switches tab, opens any collapsing <details> containing the card, and
// scrolls it into view.

import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { SETTINGS_INDEX, type SettingsTabId } from "./searchRegistry";

export function SettingsSearch({
  open,
  onClose,
  onJump,
}: {
  open: boolean;
  onClose: () => void;
  onJump: (tab: SettingsTabId, cardId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SETTINGS_INDEX.slice(0, 30);
    const terms = q.split(/\s+/).filter(Boolean);
    return SETTINGS_INDEX.filter((entry) => {
      const hay = `${entry.label} ${entry.tab} ${(entry.keywords ?? []).join(" ")}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = results[activeIdx];
        if (hit) onJump(hit.tab, hit.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, results, activeIdx, onClose, onJump]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            placeholder="Search settings… e.g. hashtag, category, delay"
            className="h-7 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Nothing matches “{query}” — try “hashtag”, “category”, “delay”…
            </p>
          ) : (
            results.map((entry, i) => (
              <button
                key={entry.id}
                type="button"
                data-idx={i}
                onClick={() => onJump(entry.tab, entry.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  i === activeIdx ? "bg-primary/10" : "hover:bg-muted/70"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-foreground">{entry.label}</p>
                  {entry.hint ? <p className="truncate text-[11px] text-muted-foreground">{entry.hint}</p> : null}
                </div>
                <span className="shrink-0 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground">
                  {entry.tab}
                </span>
                {i === activeIdx ? <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
