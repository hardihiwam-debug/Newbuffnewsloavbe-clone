// Scheduler tab — job cadence: how often each pipeline job runs, which fetch
// sources are enabled, and the automatic queue cap.

import { Separator } from "@/components/ui/separator";
import { Clock, History, Timer } from "lucide-react";
import { Card, CompactInput, CompactSelect, CompactToggle, SubText, useSettings } from "./shared";

export function SchedulerTab() {
  const { s, save, setCronSchedule } = useSettings() as any;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
      {/* Scheduler */}
      <Card icon={Clock} id="scheduler" title="Scheduler" hint="How often each job runs (live, no redeploy)">
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
          <Separator className="!my-2" />
          <p className="text-[11px] font-medium text-muted-foreground">Fetch sources</p>
          <CompactToggle
            label="Telegram channels"
            checked={s["fetchTelegramEnabled"] !== false}
            onChange={(v) => save({ fetchTelegramEnabled: v })}
            hint="7 channels — t.me snapshots, the fast lane (~5 min)"
          />
          <CompactToggle
            label="NewsData.io"
            checked={s["fetchNewsdataEnabled"] !== false}
            onChange={(v) => save({ fetchNewsdataEnabled: v })}
            hint="1 source — up to 8 query groups per cycle (200 calls/day)"
          />
          <CompactToggle
            label="Google News RSS"
            checked={s["fetchGoogleNewsEnabled"] !== false}
            onChange={(v) => save({ fetchGoogleNewsEnabled: v })}
            hint="1 source — up to 12 topic queries, last 24h each"
          />
          <CompactToggle
            label="Publisher RSS feeds"
            checked={s["fetchPublisherFeedsEnabled"] !== false}
            onChange={(v) => save({ fetchPublisherFeedsEnabled: v })}
            hint="28 built-in sites — Al Jazeera, BBC, Mehr News, Rudaw, …"
          />
          <Separator className="!my-2" />
          <CompactInput
            label="Max queue size"
            value={s["maxQueueSize"] != null ? String(Number(s["maxQueueSize"])) : "150"}
            onChange={(v) => save({ maxQueueSize: Math.max(0, Math.floor(Number(v) || 0)) })}
            hint="0 = off · when the backlog exceeds this, the lowest-score non-breaking items are dropped automatically"
            type="number"
            min={0}
            max={2000}
          />
        </div>
      </Card>

      {/* Pipeline ticker */}
      <Card icon={Timer} id="ticker" title="Pipeline ticker (cron)" hint="How often the scheduler wakes — publish gaps are only checked on a wake">
        <div className="space-y-3">
          <CompactSelect
            label="Wake-up interval"
            value={s["cronSchedule"] ?? "* * * * *"}
            onChange={(v: string) => setCronSchedule({ schedule: v })}
            options={[
              { value: "* * * * *", label: "Every minute (gaps exact)" },
              { value: "*/2 * * * *", label: "Every 2 minutes" },
              { value: "*/5 * * * *", label: "Every 5 minutes (lowest cost)" },
              { value: "*/10 * * * *", label: "Every 10 minutes" },
              { value: "*/15 * * * *", label: "Every 15 minutes" },
            ]}
          />
          <SubText>
            With a 4–6 min gap setting: every minute = exact · every 2 min = gaps land at 4 or 6 · every 5+ min rounds gaps up to the wake-up tick
          </SubText>
        </div>
      </Card>

      {/* Freshness limits */}
      <Card icon={History} id="freshness" title="Freshness limits" hint="Max article age before auto-drop (live)">
        <div className="space-y-3">
          <CompactInput
            label="Breaking / conflict (hours)"
            value={s["maxAgeBreakingHours"] ?? 14}
            onChange={(v) => save({ maxAgeBreakingHours: Math.max(1, Number(v) || 14) })}
            hint="Strike, missile, drone, Hormuz, nuclear… stories older than this are dropped before queueing"
            type="number"
            min={1}
            max={168}
          />
          <CompactInput
            label="Regular news (hours)"
            value={s["maxAgeNewsHours"] ?? 22}
            onChange={(v) => save({ maxAgeNewsHours: Math.max(1, Number(v) || 22) })}
            type="number"
            min={1}
            max={168}
          />
          <CompactInput
            label="Analysis / opinion (hours)"
            value={s["maxAgeAnalysisHours"] ?? 48}
            onChange={(v) => save({ maxAgeAnalysisHours: Math.max(1, Number(v) || 48) })}
            type="number"
            min={1}
            max={336}
          />
          <CompactInput
            label="Telegram fast lane (hours)"
            value={s["telegramMaxAgeHours"] ?? 6}
            onChange={(v) => save({ telegramMaxAgeHours: Math.max(1, Number(v) || 6) })}
            hint="Channel posts older than this never enter the pipeline"
            type="number"
            min={1}
            max={72}
          />
        </div>
      </Card>
    </div>
  );
}
