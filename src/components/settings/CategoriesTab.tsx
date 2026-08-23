// Categories tab — the Category Policy editor, promoted to its own tab so the
// most-tuned settings aren't buried inside Editorial.

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Settings2 } from "lucide-react";
import { Card, CompactInput, CompactSelect, CompactToggle, DEFAULT_CATEGORIES, Pill, useSettings } from "./shared";

const STATUS_OPTIONS = [
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled (ignore)" },
  { value: "review", label: "Review only (hold)" },
];
const PRIORITY_OPTIONS = [
  { value: "very_high", label: "Very high (80)" },
  { value: "high", label: "High (60)" },
  { value: "normal", label: "Normal (40)" },
  { value: "low", label: "Low (20)" },
];

export function CategoriesTab() {
  const { s, save } = useSettings();
  const [catEditor, setCatEditor] = useState("war");

  const allCats = [...DEFAULT_CATEGORIES];
  const catPolicy = (s["categoryPolicy"] && typeof s["categoryPolicy"] === "object"
    ? s["categoryPolicy"] as Record<string, Record<string, unknown>>
    : {}) as Record<string, Record<string, unknown>>;
  const activePolicy = catPolicy[catEditor] ?? {};
  const updatePolicy = (field: string, value: unknown, clearOverride = false) => {
    save({
      categoryPolicy: {
        ...catPolicy,
        [catEditor]: {
          ...(catPolicy[catEditor] ?? {}),
          [field]: value,
          ...(clearOverride ? { scoreOverride: 0 } : {}),
        },
      },
    });
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
      <Card
        icon={Settings2}
        id="category-policy"
        title="Category Policy"
        hint="Per-category status, priority, freshness, daily caps, and keyword rules"
        className="sm:col-span-2 lg:col-span-3"
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground font-medium">Select category</Label>
              <div className="flex flex-wrap gap-1.5">
                {allCats.map((cat) => (
                  <Pill
                    key={cat}
                    label={cat}
                    active={catEditor === cat}
                    onClick={() => setCatEditor(cat)}
                  />
                ))}
              </div>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Configure how each category behaves in the pipeline. Disabled categories skip all articles. Review-only categories hold items for manual approval. Priority affects publish ordering. Excluded keywords disqualify articles from this category even when they match the keyword classifier.
          </p>
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <CompactSelect
                label="Status"
                value={String(activePolicy.status ?? "enabled")}
                onChange={(v) => updatePolicy("status", v)}
                options={STATUS_OPTIONS}
              />
              <CompactSelect
                label="Priority"
                value={String(activePolicy.priority ?? "normal")}
                // Picking a preset clears any scoreOverride (incl. the legacy
                // parity value seeded by migration 0042), so the chosen preset
                // actually takes effect instead of being silently overridden.
                onChange={(v) => updatePolicy("priority", v, true)}
                options={PRIORITY_OPTIONS}
              />
              <CompactInput
                label="Score override (0 = use priority)"
                value={Number(activePolicy.scoreOverride ?? 0)}
                onChange={(v) => updatePolicy("scoreOverride", Math.max(0, Number(v) || 0))}
                type="number"
                min={0}
                max={200}
                hint="Non-zero wins over the priority preset. Changing Priority above resets this to 0."
              />
              <CompactInput
                label="Freshness window (hours, 0 = global)"
                value={Number(activePolicy.freshnessHours ?? 0)}
                onChange={(v) => updatePolicy("freshnessHours", Math.max(0, Number(v) || 0))}
                type="number"
                min={0}
                max={120}
              />
              <CompactInput
                label="Max posts per day (0 = unlimited)"
                value={Number(activePolicy.maxPostsPerDay ?? 0)}
                onChange={(v) => updatePolicy("maxPostsPerDay", Math.max(0, Number(v) || 0))}
                type="number"
                min={0}
                max={50}
              />
              <CompactToggle
                label="Hashtags enabled"
                checked={activePolicy.hashtagsEnabled !== false}
                onChange={(v) => updatePolicy("hashtagsEnabled", v)}
              />
            </div>
            <Separator className="my-3" />
            <div className="space-y-2">
              <Label className="text-[11px] text-muted-foreground font-medium">Keyword rules</Label>
              <p className="text-[10px] text-muted-foreground">
                Required keywords: the article must contain at least one. They also act as triggers — when the built-in classifier finds no category, a matching keyword list classifies the story here (excluded keywords still veto, and the highest-scoring match wins).
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <Label className="text-[10px] text-muted-foreground">Required keywords (comma-separated)</Label>
                  <input
                    className="mt-1 w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs"
                    value={(activePolicy.keywords as string[] ?? []).join(", ")}
                    onChange={(e) => updatePolicy("keywords", e.target.value.split(",").map((w) => w.trim()).filter(Boolean))}
                    placeholder="e.g. ceasefire, sanctions"
                    dir="auto"
                  />
                </div>
                <div>
                  <Label className="text-[10px] text-muted-foreground">Excluded keywords (comma-separated)</Label>
                  <input
                    className="mt-1 w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs"
                    value={(activePolicy.excludedKeywords as string[] ?? []).join(", ")}
                    onChange={(e) => updatePolicy("excludedKeywords", e.target.value.split(",").map((w) => w.trim()).filter(Boolean))}
                    placeholder="e.g. analysis, opinion"
                    dir="auto"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
