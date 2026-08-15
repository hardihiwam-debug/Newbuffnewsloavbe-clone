import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Register a chat by numeric ID from the dashboard. Each chat keeps its own
// stored settings (language, polls, active) server-side — add any ID (e.g.
// 200006) even before the bot has seen a single Telegram message from it.
export function AddChat({
  onAdd,
}: {
  onAdd: (v: { chatId: number; title?: string; type?: string }) => void;
}) {
  const [chatId, setChatId] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("private");

  function submit() {
    const n = Number(chatId.trim().replace(/^@/, ""));
    if (!n || Number.isNaN(n)) {
      toast.error(
        "Enter a valid numeric chat ID (e.g. 200006, or -1001234567890 for a channel)",
      );
      return;
    }
    onAdd({ chatId: n, title: title.trim() || undefined, type });
    setChatId("");
    setTitle("");
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-3">
      <div className="min-w-44 flex-1">
        <p className="text-xs font-medium text-muted-foreground">Register a chat</p>
        <p className="text-xs text-muted-foreground/70">
          Add any chat ID so its language, polls, and status are stored on the server — even
          before the bot receives its first message from it.
        </p>
      </div>
      <Input
        className="max-w-36"
        placeholder="Chat ID"
        inputMode="numeric"
        value={chatId}
        onChange={(e) => setChatId(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <Input
        className="max-w-44"
        placeholder="Title (optional)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <select
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={type}
        onChange={(e) => setType(e.target.value)}
      >
        <option value="private">Private chat</option>
        <option value="group">Group</option>
        <option value="supergroup">Supergroup</option>
        <option value="channel">Channel</option>
      </select>
      <Button size="sm" variant="secondary" onClick={submit} disabled={!chatId.trim()}>
        Add chat
      </Button>
    </div>
  );
}
