// System tab — deployed backend health: schema/migrations, configured
// credentials, live counters and the pg_cron scheduler ticker.

import { Clock, Server } from "lucide-react";
import { Card, useSettings } from "./shared";

export function SystemTab() {
  const { data } = useSettings();

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
      <Card icon={Server} id="system-status" title="System Status" hint="Deployed backend health" className="lg:col-span-2">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Schema</p>
            <p className={`mt-0.5 text-xs font-medium ${(data as any).schemaMigrations?.ok ? "text-healthy" : "text-destructive"}`}>
              {(data as any).schemaMigrations?.ok ? "migrations 0001–0018 applied" : "migrations missing — pipeline cannot queue"}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Telegram bot</p>
            <p className={`mt-0.5 text-xs font-medium ${(data as any).botConfigured ? "text-healthy" : "text-destructive"}`}>
              {(data as any).botConfigured ? "token configured" : "no token"}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">NewsData</p>
            <p className={`mt-0.5 text-xs font-medium ${(data as any).newsdataConfigured ? "text-healthy" : "text-muted-foreground"}`}>
              {(data as any).newsdataConfigured ? "API key set" : "no key"}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Queue</p>
            <p className="mt-0.5 text-xs font-medium text-foreground">{data.queuedTotal ?? 0} queued</p>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Published 24h</p>
            <p className="mt-0.5 text-xs font-medium text-foreground">{data.published24h ?? 0}</p>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Translation fails 24h</p>
            <p className={`mt-0.5 text-xs font-medium tabular-nums ${Number(data.translationFails24h ?? 0) > 0 ? "text-destructive" : "text-foreground"}`}>
              {data.translationFails24h ?? 0}
            </p>
          </div>
        </div>
      </Card>
      <Card icon={Clock} id="cron-health" title="Scheduler (pg_cron)" hint="Automatic pipeline ticker" className="lg:col-span-3">
        {(() => {
          const jobs = ((data as any).cronHealth ?? []) as any[];
          if (!jobs.length) {
            return (
              <p className="text-xs text-muted-foreground">
                No cron jobs visible — apply migration 0014 (cron health view) or confirm pg_cron is enabled.
              </p>
            );
          }
          return (
            <div className="space-y-2">
              {jobs.map((j: any) => {
                const status = j.lastRunStatus;
                const failed = status === "failed";
                const ok = ["succeeded", "running", "starting", "sending", "connecting"].includes(status);
                const stateLabel = !j.active ? "inactive" : status || "no runs yet";
                const stateClass = !j.active || failed ? "text-destructive" : ok ? "text-healthy" : "text-muted-foreground";
                return (
                  <div key={j.jobname} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-foreground">{j.jobname}</p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {j.schedule} · last run {j.lastRunFinishedAt ? new Date(j.lastRunFinishedAt).toLocaleString() : "—"}
                      </p>
                    </div>
                    <span className={`shrink-0 text-[10px] font-medium ${stateClass}`}>{stateLabel}</span>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </Card>
    </div>
  );
}
