import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

// Editable Telegram channel source row: rename in place, enable/disable,
// or delete (two-step inline confirm). Saves go through upsertSource so the
// pipeline picks them up on the next fetch.
const BOOST_OPTIONS = [
  { value: 0, label: "Normal", hint: "standard score — regular queue order" },
  { value: 1, label: "Fast", hint: "+60 score — jumps the queue, no 🚨 prefix" },
  { value: 2, label: "Instant", hint: "+150 & breaking — always first, 24/7" },
];

export function TelegramChannelRow({
  src,
  onSave,
  onDelete,
}: {
  src: any;
  onSave: (patch: { name?: string; enabled?: boolean; boost?: number }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(
    String(src.config?.channel ?? src.name ?? "").replace(/^@/, ""),
  );
  const [confirming, setConfirming] = useState(false);
  const channel = String(src.config?.channel ?? src.name ?? "").replace(/^@/, "");
  const boost = Number(src.config?.boost ?? 0);
  const autoPaused = Boolean(src.autoPaused);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
      <span className="text-sm font-semibold">@</span>
      {autoPaused ? (
        <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
          auto-paused
        </span>
      ) : null}
      <Input
        className="min-w-36 flex-1"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          const clean = name.trim().replace(/^@/, "");
          if (clean && clean !== channel) onSave({ name: `@${clean}` });
          else setName(channel);
        }}
      />
      <select
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        value={boost}
        title={BOOST_OPTIONS.find((o) => o.value === boost)?.hint}
        onChange={(e) => onSave({ boost: Number(e.target.value) })}
      >
        {BOOST_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Switch checked={src.enabled !== false} onCheckedChange={(v) => onSave({ enabled: v })} />
      {confirming ? (
        <span className="flex items-center gap-1.5">
          <span className="text-xs text-destructive">Remove?</span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
          >
            Yes
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            No
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          ✕
        </Button>
      )}
    </div>
  );
}

// Simple "add a Telegram source" row: just paste a public @channel handle.
export function AddTelegramChannel({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  const submit = () => {
    const clean = name.trim().replace(/^@/, "");
    if (clean) {
      onAdd(`@${clean}`);
      setName("");
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-3">
      <span className="text-xs font-semibold text-muted-foreground">@</span>
      <Input
        className="min-w-40 flex-1"
        placeholder="channel_username — no @ needed"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <Button size="sm" variant="secondary" onClick={submit}>
        Add Telegram channel
      </Button>
    </div>
  );
}
