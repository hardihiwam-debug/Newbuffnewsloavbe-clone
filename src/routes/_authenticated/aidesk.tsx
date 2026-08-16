import { createFileRoute } from "@tanstack/react-router";
import { Sparkles, CheckCircle2, AlertTriangle, Cpu } from "lucide-react";
import { useNewsroomData } from "@/components/AppShell";
import { api, useAdminQuery } from "@/lib/supabaseAdminHooks";
import { readStoredPin } from "@/routes/index";
import { SectionTitle, EmptyState } from "@/components/newsroom";

export const Route = createFileRoute("/_authenticated/aidesk")({
  head: () => ({
    meta: [
      { title: "AI Desk · Iran Desk" },
      { name: "description", content: "What the AI is doing — pipeline stages, usage and translation activity." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: AiDesk,
});

function AiDesk() {
  const pin = readStoredPin() ?? "";
  const data = useNewsroomData();
  const keys = useAdminQuery(api.admin.listTranslationKeys, pin ? { pin } : "skip") as any;
  const s = (data?.settings ?? {}) as Record<string, any>;
  const sources = (data?.sources ?? []) as any[];
  const ai = (data?.aiUsage24h ?? {}) as any;
  const byProvider = (ai.byProvider ?? {}) as Record<string, { calls: number; promptTokens: number; completionTokens: number }>;
  const translationHistory = (data?.translationHistory ?? []) as any[];
  const translationFailures = (data?.translationFailures ?? []) as any[];
  const envGeminiCount = Number(keys?.envDefaults?.gemini ?? 0);
  const storedKeys = (keys?.keys ?? []) as any[];
  const geminiUsage = (keys?.geminiUsage ?? []) as any[];
  const schemaOk = Boolean((data as any).schemaMigrations?.ok);

  const stages = [
    { name: "Ingestion", ok: sources.length > 0, detail: sources.length > 0 ? `${sources.length} source(s) configured` : "No sources configured yet" },
    { name: "Event detection", ok: schemaOk, detail: schemaOk ? "Event clustering active (48h window)" : "Schema pending — run migrations 0001–0011" },
    { name: "Deduplication", ok: s["aiDedupEnabled"] !== false, detail: s["aiDedupEnabled"] !== false ? `AI final dedup on (${s["aiDedupProvider"] ?? "groq"})` : "AI final dedup disabled" },
    { name: "Fact extraction & summarization", ok: schemaOk, detail: schemaOk ? "Structured facts + headlines from Groq" : "Waiting on schema" },
    { name: "Translation", ok: envGeminiCount > 0 || storedKeys.length > 0, detail: envGeminiCount > 0 ? `${envGeminiCount} Gemini env key(s) · ${s["translationMode"] ?? "gemini_first"}` : storedKeys.length > 0 ? `${storedKeys.length} stored key(s)` : "No translation keys configured" },
    { name: "Quality check", ok: Number(s["breakingMaxAgeHours"] ?? 8) > 0, detail: "Fact-consistency + freshness gates active" },
  ];

  const totalCalls = Number(ai.calls ?? 0);
  const totalTokens = Number(ai.promptTokens ?? 0) + Number(ai.completionTokens ?? 0);

  return (
    <div>
      <SectionTitle eyebrow="AI operations" title="AI Desk" hint="What the AI pipeline is doing — every status below is derived from live configuration and usage." />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── Pipeline stages ───────────────────────── */}
        <div className="panel px-4 py-3 lg:col-span-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">AI pipeline</p>
          <div className="mt-3 space-y-2">
            {stages.map((st) => (
              <div key={st.name} className="flex items-start gap-2.5 rounded-[6px] border border-border bg-muted/30 px-3 py-2">
                {st.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-healthy" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-review" />}
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground">{st.name}</p>
                  <p className="text-[10px] text-muted-foreground">{st.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Today ─────────────────────────────────── */}
        <div className="panel px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Today</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Metric value={totalCalls} label="AI calls" />
            <Metric value={Number(data?.published24h ?? 0)} label="Published" />
            <Metric value={Number(data?.translationFails24h ?? 0)} label="Translation failures" tone={Number(data?.translationFails24h ?? 0) > 0 ? "danger" : "healthy"} />
            <Metric value={totalTokens.toLocaleString()} label="Tokens" />
          </div>
          {Object.keys(byProvider).length > 0 ? (
            <div className="mt-4 border-t border-border pt-3">
              <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                <Cpu className="h-3 w-3" /> By provider
              </p>
              <div className="space-y-1.5">
                {Object.entries(byProvider).map(([provider, v]) => (
                  <div key={provider} className="flex items-center gap-2 text-[11px]">
                    <span className="w-24 shrink-0 truncate font-medium text-foreground">{provider}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-info" style={{ width: `${totalCalls > 0 ? Math.max(4, Math.round((v.calls / totalCalls) * 100)) : 0}%` }} />
                    </div>
                    <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{v.calls}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {/* ── Key health (real per-key usage) ──────── */}
        <div className="panel px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Gemini keys</p>
          <div className="mt-3 space-y-1.5">
            {geminiUsage.length === 0 ? (
              <p className="text-xs text-muted-foreground">No GEMINI_API_KEY_1..6 usage recorded yet.</p>
            ) : (
              geminiUsage.map((g: any) => (
                <div key={g.keyIndex} className="rounded-[6px] border border-border px-3 py-2 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground">Key {g.keyIndex}</span>
                    {g.configured ? <span className="font-mono text-[10px] text-muted-foreground">{g.first8}…{g.last4}</span> : <span className="text-[10px] text-muted-foreground">not configured</span>}
                    <span className="ml-auto tabular-nums text-muted-foreground">today {g.today?.calls ?? 0} · 429 {g.total?.rateLimited ?? 0}</span>
                  </div>
                </div>
              ))
            )}
            <p className="pt-1 text-[10px] text-muted-foreground">
              {envGeminiCount > 0 ? `${envGeminiCount} env Gemini key(s) active. Full per-model quotas live under Settings → Translation.` : "Add GEMINI_API_KEY_1..6 under Keys/API keys to enable Gemini translation."}
            </p>
          </div>
        </div>
      </div>

      {/* ── Translation activity ───────────────────── */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="panel px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Recent translations · {translationHistory.length}</p>
          <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
            {translationHistory.length === 0 ? (
              <EmptyState icon={<Sparkles className="h-4 w-4" />} text="No translations yet this session." />
            ) : (
              translationHistory.slice(0, 15).map((h: any, i: number) => (
                <div key={h.id ?? h._id ?? i} className="rounded-[6px] border border-border px-3 py-2 text-[11px]">
                  <p className="truncate text-foreground" dir="rtl">{h.kurdishText}</p>
                  <p className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{String(h.model ?? "").replace(/^([a-z]+)[:/]/, "").replace(/^gemini-/, "")}</span>
                    <span>·</span>
                    <span>{h.createdAt ? new Date(h.createdAt).toLocaleString() : ""}</span>
                  </p>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Translation failures · {translationFailures.length}</p>
          <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
            {translationFailures.length === 0 ? (
              <EmptyState icon={<CheckCircle2 className="h-4 w-4" />} text="All translations passing." />
            ) : (
              translationFailures.slice(0, 15).map((f: any, i: number) => (
                <div key={f.id ?? f._id ?? i} className="rounded-[6px] border border-destructive/25 bg-destructive/10 px-3 py-2 text-[11px]">
                  <p className="truncate font-medium text-destructive">{f.detail ?? f.headline ?? "Unknown error"}</p>
                  <p className="mt-0.5 truncate text-[10px] text-destructive/70">{(f.modelsTried ?? []).join(", ") || "—"} · {f.createdAt ? new Date(f.createdAt).toLocaleString() : ""}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ── Performance (honest placeholder) ────────── */}
      <div className="panel mt-4 px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">AI performance</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Headline quality, summary quality, fact-consistency and translation-QA scores are not tracked by the backend yet. The metrics above (calls, tokens, per-provider load, per-key usage, translation failures) are live; the quality-score panel is ready to be connected when the backend records it.
        </p>
      </div>
    </div>
  );
}

function Metric({ value, label, tone = "neutral" }: { value: string | number; label: string; tone?: "neutral" | "danger" | "healthy" }) {
  return (
    <div className="rounded-[6px] border border-border bg-muted/30 px-3 py-2.5">
      <p className={`text-xl font-bold tabular-nums ${tone === "danger" ? "text-destructive" : tone === "healthy" ? "text-healthy" : "text-foreground"}`}>{value}</p>
      <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}
