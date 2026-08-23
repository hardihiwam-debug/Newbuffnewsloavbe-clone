// Scheduling tab — WHEN things run and send: job cadence, publishing speed
// and day/night posting windows. Campaigns live in their own Delivery sub-tab.

import { CalendarClock, Gauge } from "lucide-react";
import { Card, CompactInput, useSettings } from "./shared";
import { SchedulerTab } from "./SchedulerTab";

export function SchedulingTab() {
  const { s, save } = useSettings();

  const dayWin = {
    start: s["dayStart"] ?? "06:00",
    end: s["dayEnd"] ?? "22:00",
    min: s["dayMinMinutes"] ?? 6,
    max: s["dayMaxMinutes"] ?? 16,
  };
  const nightWin = {
    start: s["nightStart"] ?? "22:00",
    end: s["nightEnd"] ?? "06:00",
    min: s["nightMinMinutes"] ?? 10,
    max: s["nightMaxMinutes"] ?? 20,
  };

  return (
    <div className="space-y-4">
      <SchedulerTab />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
        {/* Publishing Speed */}
        <Card icon={Gauge} id="publishing-speed" title="Publishing Speed" hint="Delay between consecutive posts">
          <div className="flex items-end gap-3">
            <CompactInput
              label="Delay (seconds)"
              value={s["sendDelayMs"] ? Math.round(Number(s["sendDelayMs"]) / 1000) : 30}
              onChange={(v) =>
                save({ sendDelayMs: Math.max(1000, Number(v) * 1000 || 30000) })
              }
              type="number"
              min={1}
              max={300}
            />
            <span className="text-[11px] text-muted-foreground pb-2">
              {s["sendDelayMs"] ? Math.round(Number(s["sendDelayMs"]) / 1000) : 30}s
            </span>
          </div>
        </Card>

        {/* Posting Windows */}
        <Card
          icon={CalendarClock}
          id="posting-windows"
          title="Posting Windows"
          hint="Spacing between posts = this window's Min–Max (randomized). Night also gates breaking unless interrupted"
          className="sm:col-span-2"
        >
          <div className="space-y-3">
            {/* Day window */}
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-3">
              <p className="text-[11px] font-semibold text-muted-foreground mb-2">
                🌅 Day ({dayWin.start} – {dayWin.end})
              </p>
              <div className="grid grid-cols-4 gap-2">
                <CompactInput label="Start"
                  value={dayWin.start} onChange={(v) => save({ dayStart: v })} type="time" />
                <CompactInput label="End"
                  value={dayWin.end} onChange={(v) => save({ dayEnd: v })} type="time" />
                <CompactInput label="Min (min)"
                  value={dayWin.min} onChange={(v) => save({ dayMinMinutes: Number(v) })} type="number" min={1} />
                <CompactInput label="Max (min)"
                  value={dayWin.max} onChange={(v) => save({ dayMaxMinutes: Number(v) })} type="number" min={1} />
              </div>
            </div>
            {/* Night window */}
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-3">
              <p className="text-[11px] font-semibold text-muted-foreground mb-2">
                🌙 Night ({nightWin.start} – {nightWin.end})
              </p>
              <div className="grid grid-cols-4 gap-2">
                <CompactInput label="Start"
                  value={nightWin.start} onChange={(v) => save({ nightStart: v })} type="time" />
                <CompactInput label="End"
                  value={nightWin.end} onChange={(v) => save({ nightEnd: v })} type="time" />
                <CompactInput label="Min (min)"
                  value={nightWin.min} onChange={(v) => save({ nightMinMinutes: Number(v) })} type="number" min={1} />
                <CompactInput label="Max (min)"
                  value={nightWin.max} onChange={(v) => save({ nightMaxMinutes: Number(v) })} type="number" min={1} />
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
