// Editorial tab — editorial judgment: which categories trigger breaking
// alerts, how old a story may be to publish as breaking, the follow-up
// update rules, auto "why it matters" explainers, and how channel videos
// are posted.

import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Film, Flame, Gauge, Sparkles } from "lucide-react";
import { Card, CompactInput, CompactToggle, DEFAULT_CATEGORIES, Pill, useSettings } from "./shared";

export function EditorialTab() {
  const { s, save, categories } = useSettings();

  const breakingCats = (s["breakingCategories"] ?? []) as string[];
  const allCats = [...DEFAULT_CATEGORIES];

  const toggleBreakingCat = (cat: string) => {
    const next = breakingCats.includes(cat)
      ? breakingCats.filter((c) => c !== cat)
      : [...breakingCats, cat];
    save({ breakingCategories: next });
  };

  const whyItMattersCats = (Array.isArray(s["whyItMattersCategories"])
    ? (s["whyItMattersCategories"] as string[])
    : ["war", "iran", "proxies", "gaza", "syria", "lebanon", "iraq", "usa"]);
  const toggleWhyItMattersCat = (c: string) => {
    const next = whyItMattersCats.includes(c)
      ? whyItMattersCats.filter((x) => x !== c)
      : [...whyItMattersCats, c];
    save({ whyItMattersCategories: next });
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
      {/* Breaking-News Criteria */}
      <Card
        icon={Flame}
        id="breaking-criteria"
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

      {/* News quality */}
      <Card icon={Gauge} id="news-quality" title="News quality" hint="Breaking recency, fact consistency and update cadence">
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

      {/* Why-it-matters follow-ups */}
      <Card
        icon={Sparkles}
        id="why-it-matters"
        title="Why-it-matters follow-ups"
        hint="Auto-posts a short explainer after major breaking stories"
      >
        <div className="space-y-3">
          <CompactToggle
            label="Auto 'Why it matters' follow-ups"
            hint="After a breaking story publishes, the next cycle sends a 3–5 sentence explainer with context, consequences and what to watch next."
            checked={s["whyItMattersEnabled"] === true}
            onChange={(v) => save({ whyItMattersEnabled: v })}
          />
          <CompactInput
            label="Max per day"
            value={s["whyItMattersMaxPerDay"] ?? 4}
            onChange={(v) => save({ whyItMattersMaxPerDay: Math.max(0, Number(v) || 0) })}
            type="number"
            min={0}
            max={20}
          />
          <CompactInput
            label="Headline prefix"
            value={s["whyItMattersPrefix"] ?? "WHY IT MATTERS — "}
            onChange={(v) => save({ whyItMattersPrefix: v })}
          />
          <div>
            <Label className="text-[11px] text-muted-foreground font-medium">Trigger categories</Label>
            <p className="mb-2 text-[10px] text-muted-foreground">
              Only breaking stories in these categories get a follow-up.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <Pill
                  key={c}
                  label={c}
                  active={whyItMattersCats.includes(c)}
                  onClick={() => toggleWhyItMattersCat(c)}
                />
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Telegram Video Handling (media/output) */}
      <Card
        icon={Film}
        id="video-handling"
        title="Telegram Video Handling"
        hint="How videos from Telegram channels are posted"
      >
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
      </Card>
    </div>
  );
}
