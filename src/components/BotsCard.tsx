import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";
import { readStoredPin } from "@/routes/index";

type BotRow = {
  _id: string;
  name?: string | null;
  // The server never sends the raw token — only whether one is configured
  // (and a masked preview). Tokens stay server-side.
  tokenConfigured?: boolean;
  tokenMasked?: string | null;
  categories?: string[] | null;
};

export function BotsCard({
  bots,
  categories,
  saveBot,
  deleteBot,
}: {
  bots: BotRow[];
  categories: string[];
  saveBot: (p: Record<string, unknown>) => Promise<unknown>;
  deleteBot: (p: { id: string }) => Promise<unknown>;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newToken, setNewToken] = useState("");
  // Every admin call is PIN-gated server-side. settings.tsx normally spreads
  // its own pinArgs into mutations; BotsCard reads the stored PIN itself so
  // the Add/toggle/remove actions work the same way.
  const pin = readStoredPin();
  const pinArgs = pin ? { pin } : {};

  const onError = (e: unknown) =>
    toast.error(e instanceof Error ? e.message : "Something went wrong");

  async function addBot() {
    if (!newName.trim()) {
      toast.error("Enter a bot name");
      return;
    }
    if (!newToken.trim()) {
      toast.error("Paste the bot token from @BotFather");
      return;
    }
    try {
      await saveBot({ ...pinArgs, name: newName.trim(), token: newToken });
      setNewName("");
      setNewToken("");
      setAdding(false);
      toast.success("Bot added — assign chats to it below");
    } catch (e) {
      onError(e);
    }
  }

  const catList = (b: BotRow): string[] =>
    Array.isArray(b.categories) ? b.categories.map(String) : [];

  return (
    <div className="space-y-3">
      {bots.length === 0 ? (
        <p className="text-[11px] text-muted-foreground py-1">
          No additional bots. The primary bot (env token) delivers everything to all chats.
        </p>
      ) : (
        bots.map((b) => {
          const cats = catList(b);
          return (
            <div key={b._id} className="rounded-lg border border-border p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate text-foreground">{b.name ?? "Bot"}</p>
                  <p className="text-[10px] text-muted-foreground">
                    <span
                      className={`inline-flex h-1.5 w-1.5 rounded-full mr-1 align-middle ${
                        b.tokenConfigured ? "bg-healthy" : "bg-destructive"
                      }`}
                    />
                    {b.tokenConfigured ? "Connected" : "No token"}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    deleteBot({ ...pinArgs, id: b._id })
                      .then(() => toast.success("Bot removed — its chats revert to the primary bot"))
                      .catch(onError)
                  }
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove
                </Button>
              </div>
              <div>
                <Label className="text-[11px] font-medium text-foreground">
                  {cats.length === 0
                    ? "Sends: ALL categories"
                    : `Sends: ${cats.join(", ")}`}
                </Label>
                <p className="text-[10px] text-muted-foreground">
                  Tap a category to include it; tap again to remove it. Empty selection = ALL
                  categories. Any story matching one of the selected categories is delivered by
                  this bot.
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    saveBot({ ...pinArgs, id: b._id, categories: [] }).catch(onError)
                  }
                  className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
                    cats.length === 0
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}
                  title="Clear the selection — this bot receives all categories"
                >
                  All
                </button>
                {categories.map((cat) => {
                  const active = cats.includes(cat);
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() =>
                        saveBot({
                          ...pinArgs,
                          id: b._id,
                          categories: active ? cats.filter((c) => c !== cat) : [...cats, cat],
                        }).catch(onError)
                      }
                      className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
                        active
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-muted/80"
                      }`}
                    >
                      {cat}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })
      )}

      {adding ? (
        <div className="rounded-lg border border-dashed border-border p-3 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1">
              <Label className="text-[11px] text-muted-foreground font-medium">Bot name</Label>
              <Input
                className="h-9 rounded-lg text-sm"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Gold bot"
              />
            </div>
            <div className="min-w-52 flex-1">
              <Label className="text-[11px] text-muted-foreground font-medium">Bot token</Label>
              <Input
                type="password"
                className="h-9 rounded-lg text-sm font-mono"
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
                placeholder="Paste @BotFather token"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" className="h-9 text-[11px]" onClick={addBot}>
                Add
              </Button>
              <Button size="sm" variant="ghost" className="h-9 text-[11px]" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            The token is a secret — it is stored in the database and never shown again after
            saving. Chats where this bot is already a member are discovered automatically; check
            the Chats card (or press Sync chats) to confirm, then tap the category chips on the
            bot card to choose what it sends (empty selection = all categories).
          </p>
          <p className="text-[10px] text-muted-foreground">
            Note: video recovery runs through the primary bot, so a channel where only this bot is a
            member delivers text-only posts (no video) — everything else (photos, text, categories)
            works normally.
          </p>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-[11px] gap-1"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3 w-3" /> Add bot
        </Button>
      )}
    </div>
  );
}
