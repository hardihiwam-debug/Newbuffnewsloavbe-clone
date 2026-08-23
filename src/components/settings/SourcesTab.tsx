// Sources tab — every fetch source in one place: provider list (RSS /
// NewsData / …), monitored Telegram channels, per-source quality/auto-pause
// and the search topic queries. (Previously split between the old "Sources"
// and "Telegram" tabs.)

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import { Activity, Filter, Hash, Package, Plus, Trash2 } from "lucide-react";
import { AddTelegramChannel, TelegramChannelRow } from "@/components/TelegramChannels";
import {
  Card,
  CompactInput,
  CompactSelect,
  CompactToggle,
  IconBtn,
  Row,
  SubText,
  useSettings,
} from "./shared";

export function SourcesTab() {
  const { s, save, sources, topics, upsertSource, upsertTopic, testSource, pin, pinArgs, onError } = useSettings();

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
          <Card
                icon={Package}
                id="providers"
                title="Providers"
                hint={`${sources.length} source${sources.length !== 1 ? "s" : ""} configured`}
                action={
                  <AddSourceButton
                    onSave={(name, kind, secretRef) =>
                      upsertSource({ ...pinArgs, name, kind, secretRef: secretRef || null }).catch(onError)
                    }
                  />
                }
                className="lg:col-span-3"
              >
                <div className="space-y-1">
                  {sources.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground py-2">No sources yet.</p>
                  ) : (
                    sources.map((src: any) => (
                      <SourceRow
                        key={src._id}
                        src={src}
                        onToggle={(v) =>
                          upsertSource({ ...pinArgs, id: src._id, enabled: v }).catch(onError)
                        }
                        onDelete={() =>
                          upsertSource({ ...pinArgs, id: src._id, remove: true }).catch(onError)
                        }
                        onTest={() => {
                          const tid = toast.loading("Testing source…");
                          testSource({ pin, id: src._id })
                            .then((r) => {
                              toast.dismiss(tid);
                              toast.success(`Source OK — ${(r as any)?.detail ?? "connected"}`);
                            })
                            .catch((e) => {
                              toast.dismiss(tid);
                              onError(e);
                            });
                        }}
                      />
                    ))
                  )}
                </div>
                <div className="mt-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-[10px] text-primary">
                  <strong>NewsData:</strong> Get your API key at{" "}
                  <a href="https://newsdata.io" target="_blank" rel="noopener noreferrer" className="underline">
                    newsdata.io
                  </a>{" "}
                  → paste it in the Secret ref field above. RSS feeds: use the feed URL as the secret ref.
                </div>
              </Card>

    <Card
                icon={Hash}
                id="telegram-channels"
                title="Telegram Channels"
                hint="Monitored channels"
                className="lg:col-span-3"
              >
                <div className="space-y-2">
                  {sources
                    .filter((s: any) => s.kind === "telegram")
                    .map((src: any) => (
                      <TelegramChannelRow
                        key={src._id}
                        src={src}
                        onSave={(patch) =>
                          upsertSource({ ...pinArgs, id: src._id, ...patch }).catch(onError)
                        }
                        onDelete={() =>
                          upsertSource({ ...pinArgs, id: src._id, remove: true }).catch(onError)
                        }
                      />
                    ))}
                  <AddTelegramChannel
                    onAdd={(handle) =>
                      upsertSource({
                        ...pinArgs,
                        name: handle,
                        kind: "telegram",
                        secretRef: null,
                      }).catch(onError)
                    }
                  />
                </div>
                          </Card>

    <Card
                icon={Activity}
                id="source-quality"
                title="Source Quality"
                hint="Track per-source accept/reject rates and auto-pause junk feeds"
                className="lg:col-span-3"
              >
                <div className="space-y-3">
                  <CompactToggle
                    label="Auto-pause low-quality sources"
                    checked={s["sourceAutoPauseEnabled"] !== false}
                    onChange={(v) => save({ sourceAutoPauseEnabled: v })}
                    hint="Sources rejected N times in a row are disabled automatically"
                  />
                  <CompactInput
                    label="Pause after N consecutive rejections"
                    value={s["sourceAutoPauseThreshold"] ?? 8}
                    onChange={(v) => save({ sourceAutoPauseThreshold: Math.max(1, Number(v) || 8) })}
                    type="number"
                    min={1}
                    max={100}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Every article that passes the pipeline counts as accepted; every rejection (junk,
                    off-topic, duplicate, disrespectful, stale) counts against the source that produced
                    it. When a source hits the streak it is switched off here — toggle it back on to
                    give it a clean slate.
                  </p>
                </div>
              </Card>

    <Card
                icon={Filter}
                id="topic-queries"
                title="Topic Queries"
                hint={`${topics.length} topic${topics.length !== 1 ? "s" : ""}`}
                action={<AddTopicButton onAdd={(q, cat) => upsertTopic({ ...pinArgs, query: q, category: cat }).catch(onError)} />}
                className="lg:col-span-2"
              >
                <div className="space-y-1 max-h-[20rem] overflow-y-auto">
                  {topics.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground py-2">No topic queries yet.</p>
                  ) : (
                    topics.map((t: any) => (
                      <Row key={t._id}>
                        <div className="min-w-0 flex-1 text-xs font-medium truncate text-foreground">
                          {t.query}
                        </div>
                        <Badge variant="secondary" className="text-[10px] shrink-0">
                          {t.category}
                        </Badge>
                        <Switch
                          checked={t.enabled !== false}
                          onCheckedChange={(v) =>
                            upsertTopic({ ...pinArgs, id: t._id, enabled: v, query: t.query }).catch(onError)
                          }
                          className="data-[state=checked]:bg-primary scale-75"
                        />
                        <IconBtn title="Delete" tone="danger" onClick={() => upsertTopic({ ...pinArgs, id: t._id, remove: true }).catch(onError)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconBtn>
                      </Row>
                    ))
                  )}
                </div>
              </Card>
    </div>
  );
}

/* ── AddSourceButton ─────────────────────────────────────── */
function AddSourceButton({
  onSave,
}: {
  onSave: (name: string, kind: string, secretRef: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("rss");
  const [secretRef, setSecretRef] = useState("");

  const handle = () => {
    if (!name.trim()) return;
    onSave(name.trim(), kind, secretRef.trim());
    setName("");
    setSecretRef("");
    setOpen(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 text-[11px] gap-1">
          <Plus className="h-3 w-3" /> Add
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Add provider</AlertDialogTitle>
          <AlertDialogDescription>
            Enter the source name, type, and API key or URL reference.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <CompactInput label="Name" value={name} onChange={setName} placeholder="e.g. Reuters RSS" />
          <CompactSelect
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: "rss", label: "RSS" },
              { value: "newsdata", label: "NewsData.io" },
              { value: "telegram", label: "Telegram" },
            ]}
          />
          <CompactInput
            label="Secret ref (API key / URL)"
            value={secretRef}
            onChange={setSecretRef}
            placeholder="NEWSDATA_API_KEY or https://..."
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handle} disabled={!name.trim()}>
            Add source
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ── AddTopicButton ──────────────────────────────────────── */
function AddTopicButton({
  onAdd,
}: {
  onAdd: (query: string, category: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("iran");

  const handle = () => {
    if (!query.trim()) return;
    onAdd(query.trim(), category);
    setQuery("");
    setOpen(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 text-[11px] gap-1">
          <Plus className="h-3 w-3" /> Add
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Add topic query</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="space-y-3">
          <CompactInput label="Query" value={query} onChange={setQuery} placeholder="e.g. IRGC drills" />
          <CompactSelect
            label="Category"
            value={category}
            onChange={setCategory}
            options={[
              "iran",
              "proxies",
              "iraq",
              "usa",
              "war",
              "oil",
              "middle-east",
              "analysis",
              "gold",
              "economic-impact",
              "gaza",
              "syria",
              "lebanon",
            ].map((c) => ({ value: c, label: c }))}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handle} disabled={!query.trim()}>
            Add topic
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ── Source row (non-telegram) ──────────────────────────── */
function SourceRow({
  src,
  onToggle,
  onDelete,
  onTest,
}: {
  src: any;
  onToggle: (v: boolean) => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  if (src.kind === "telegram") return null; // handled by TelegramChannelRow
  const autoPaused = Boolean(src.autoPaused);
  return (
    <Row>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate text-foreground">
          {src.name}
          {autoPaused ? (
            <span className="ml-2 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
              auto-paused
            </span>
          ) : null}
        </p>
        <SubText>
          {src.kind} · {src.secretRef ? "API key set" : "No key"}
          <span className="ml-1.5">
            {Number(src.publishedCount ?? 0)} ok · {Number(src.rejectedCount ?? 0)} rejected
          </span>
        </SubText>
      </div>
      <Badge variant="secondary" className="text-[10px] shrink-0">
        {src.kind}
      </Badge>
      <Switch
        checked={src.enabled !== false}
        onCheckedChange={onToggle}
        className="data-[state=checked]:bg-primary scale-75"
      />
      <IconBtn title="Test" tone="primary" onClick={onTest}>
        <Activity className="h-3.5 w-3.5" />
      </IconBtn>
      <ConfirmDelete onConfirm={onDelete} />
    </Row>
  );
}

function ConfirmDelete({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <button type="button" className="p-1 text-muted-foreground hover:text-destructive transition-colors">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
            className="bg-destructive hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
