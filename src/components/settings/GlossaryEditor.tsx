// Row-based Translation Glossary editor (Settings → AI & Translation).
//
// Replaces the free-text textarea: each entry is a ROW with two inputs
// (English term | Kurdish translation), so a long translation can never wrap
// onto a second line and silently break the "one entry per line" contract the
// pipeline parser (buildGlossaryBlock) relies on. Rows serialize back to the
// same `term = translation` per-line string, so nothing else changes.
//
// Legacy/raw values (including pasted blocks with wrapped lines) are parsed
// into rows on mount: a line without `=`/`:` continues the previous entry —
// matching the backend's continuation-aware parser.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";

type Row = { term: string; translation: string };

// Split a glossary block into entries with continuation support (a line
// without a separator appends to the previous entry's translation).
function parseGlossary(value: string): Row[] {
  const rows: Row[] = [];
  for (const line of value.split("\n")) {
    const entry = line.trim();
    if (!entry) continue;
    const sep = entry.search(/[=:]/);
    if (sep >= 0) {
      rows.push({ term: entry.slice(0, sep).trim(), translation: entry.slice(sep + 1).trim() });
    } else if (rows.length > 0) {
      const last = rows[rows.length - 1]!;
      last.translation = `${last.translation} ${entry}`.trim();
    } else {
      rows.push({ term: entry, translation: "" });
    }
  }
  return rows;
}

function serializeGlossary(rows: Row[]): string {
  return rows
    .map((r) => {
      const term = r.term.trim();
      const translation = r.translation.trim();
      if (!term && !translation) return "";
      if (!translation) return term;
      return `${term} = ${translation}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function GlossaryEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [seeded, setSeeded] = useState(false);
  // Paste-import textarea (collapsed by default).
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const importRef = useRef<HTMLTextAreaElement | null>(null);

  // Seed rows once from the stored value (the same poll-safe pattern as
  // PostingTab's footer links — after seeding, local edits own the state so
  // typing is never clobbered by a settings poll mid-edit).
  useEffect(() => {
    if (seeded || value === undefined) return;
    setSeeded(true);
    setRows(parseGlossary(value ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, seeded]);

  const commit = (next: Row[]) => {
    setRows(next);
    onChange(serializeGlossary(next));
  };

  const setRow = (i: number, patch: Partial<Row>) => {
    commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const moveRow = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j]!, next[i]!];
    commit(next);
  };

  const removeRow = (i: number) => {
    commit(rows.filter((_, j) => j !== i));
  };

  const doImport = () => {
    const parsed = parseGlossary(importText);
    if (parsed.length === 0) return;
    commit([...rows, ...parsed]);
    setImportText("");
    setImportOpen(false);
  };

  const filled = rows.filter((r) => r.term.trim() || r.translation.trim()).length;

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground/70">
          No glossary terms yet — add one below, or paste a block of{" "}
          <span className="font-mono">English = Kurdish</span> lines to import.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => moveRow(i, -1)}
                  disabled={i === 0}
                  className="rounded p-0.5 text-muted-foreground/60 hover:text-foreground disabled:opacity-30"
                  title="Move up"
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => moveRow(i, 1)}
                  disabled={i === rows.length - 1}
                  className="rounded p-0.5 text-muted-foreground/60 hover:text-foreground disabled:opacity-30"
                  title="Move down"
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </div>
              <Input
                value={row.term}
                onChange={(e) => setRow(i, { term: e.target.value })}
                placeholder="English term"
                className="h-8 text-xs font-medium"
              />
              <span className="text-muted-foreground/50">=</span>
              <Input
                value={row.translation}
                onChange={(e) => setRow(i, { translation: e.target.value })}
                placeholder="Kurdish translation"
                dir="auto"
                className="h-8 text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 w-8 shrink-0 p-0 text-destructive"
                onClick={() => removeRow(i)}
                title="Remove this term"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-[11px] gap-1"
          onClick={() => commit([...rows, { term: "", translation: "" }])}
        >
          <Plus className="h-3 w-3" /> Add term
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-[11px]"
          onClick={() => {
            setImportOpen((o) => !o);
            if (!importOpen) setTimeout(() => importRef.current?.focus(), 0);
          }}
        >
          {importOpen ? "Cancel import" : "Paste list to import"}
        </Button>
        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
          {filled} term{filled === 1 ? "" : "s"} · {serializeGlossary(rows).length} characters
        </span>
      </div>

      {importOpen ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-[10px] text-muted-foreground">
            Paste one entry per line — <span className="font-mono">English = Kurdish</span>. Wrapped
            lines (no <span className="font-mono">=</span>) merge into the entry above.
          </p>
          <textarea
            ref={importRef}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={5}
            dir="auto"
            placeholder={`Strait of Hormuz = تەنگی هورمز\nIRGC = سوپای پاسداران`}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:ring-primary/20 focus:border-primary resize-y font-mono break-words"
          />
          <Button type="button" size="sm" className="h-8 text-[11px]" onClick={doImport} disabled={!importText.trim()}>
            Import {importText.split("\n").filter((l) => l.trim()).length} line(s)
          </Button>
        </div>
      ) : null}
    </div>
  );
}
