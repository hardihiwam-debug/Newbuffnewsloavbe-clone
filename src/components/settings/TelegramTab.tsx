// Telegram tab — pure delivery: bot connection (token status / webhook),
// the N-bot category-routing setup, destination chats, and the poll tool.
// (The fetch-side Telegram channels moved to Sources with the other sources.)

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  BarChart3,
  Bot,
  Hash,
  HelpCircle,
  MessageCircle,
  Play,
  RefreshCw,
  Trash2,
  Vote,
  Wifi,
} from "lucide-react";
import { AddChat } from "@/components/AddChat";
import { BotsCard } from "@/components/BotsCard";
import {
  Card,
  CompactInput,
  CompactSelect,
  IconBtn,
  Row,
  SubText,
  useSettings,
} from "./shared";

export function TelegramTab() {
  const {
    s,
    save,
    bots,
    chats,
    polls,
    categories,
    botTokenConfigured,
    pin,
    pinArgs,
    onError,
    saveBot,
    deleteBot,
    updateChat,
    addChat,
    syncBotChats,
    refreshBotInfo,
    enableChatWebhooks,
    testPoll,
  } = useSettings();

  // Bot info learned from the "Refresh bot info" action (username/name only).
  const [botInfo, setBotInfo] = useState<{ username?: string | null; name?: string | null } | null>(null);

  // ── Chats grouped by their assigned bot (Option C) ─────────────────────
  // Primary bot (env token) first, then one section per additional bot, then
  // stragglers whose bot was deleted. The per-row Bot dropdown stays so a
  // chat can be moved between groups without leaving the card.
  const primaryChats = chats.filter((c: any) => !c.botId);
  const botGroups = new Map<string, any[]>();
  for (const b of bots) botGroups.set(b._id, []);
  for (const c of chats) {
    if (c.botId && botGroups.has(c.botId)) botGroups.get(c.botId)!.push(c);
  }
  const orphanChats = chats.filter((c: any) => c.botId && !botGroups.has(c.botId));
  const chatGroups: Array<{
    key: string;
    title: string;
    icon: typeof Bot;
    badge: string | null;
    chats: any[];
  }> = [
    ...(primaryChats.length
      ? [{ key: "__primary", title: "Primary bot", icon: Hash, badge: "env token", chats: primaryChats }]
      : []),
    ...[...botGroups.entries()]
      .filter(([, list]) => list.length > 0)
      .map(([id, list]) => ({
        key: id,
        title: bots.find((b: any) => b._id === id)?.name ?? "Bot",
        icon: Bot,
        badge: null as string | null,
        chats: list,
      })),
    ...(orphanChats.length
      ? [{ key: "__orphan", title: "Unassigned", icon: HelpCircle, badge: null as string | null, chats: orphanChats }]
      : []),
  ];

  const renderChatRow = (c: any) => (
    <Row key={c._id}>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate text-foreground">{c.title ?? `Chat ${c.chatId}`}</p>
        <SubText>{c.chatId} · {c.type ?? "private"}</SubText>
      </div>
      <CompactSelect
        label="Bot"
        value={c.botId && botGroups.has(c.botId) ? c.botId : ""}
        onChange={(v) =>
          updateChat({
            ...pinArgs,
            id: c._id,
            botId: v || null,
          }).catch(onError)
        }
        options={[
          { value: "", label: "Primary bot" },
          ...bots.map((b: any) => ({ value: b._id, label: b.name ?? "Bot" })),
        ]}
        className="w-36 shrink-0"
        selectClassName="w-full"
      />
      <CompactSelect
        label="Language"
        value={c.language ?? "inherit"}
        onChange={(v) =>
          updateChat({
            ...pinArgs,
            id: c._id,
            language: v === "inherit" ? null : v,
          }).catch(onError)
        }
        options={[
          { value: "inherit", label: "Inherit" },
          { value: "en", label: "EN" },
          { value: "ckb", label: "KU" },
        ]}
        className="w-24 shrink-0"
        selectClassName="w-full"
      />
      <div className="flex shrink-0 flex-col gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">Active</span>
        <Switch
          checked={c.active !== false}
          onCheckedChange={(v) => updateChat({ ...pinArgs, id: c._id, active: v }).catch(onError)}
          className="data-[state=checked]:bg-primary"
        />
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">Remove</span>
        <IconBtn
          title="Remove"
          tone="danger"
          onClick={() => updateChat({ ...pinArgs, id: c._id, remove: true }).catch(onError)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </IconBtn>
      </div>
    </Row>
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
          <Card
                icon={Wifi}
                id="bot-connection"
                title="Bot Connection"
                hint="Telegram bot status"
                className="lg:col-span-2"
              >
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex h-2 w-2 rounded-full ${
                        botTokenConfigured ? "bg-healthy" : "bg-destructive"
                      }`}
                    />
                    <span className="text-xs font-medium text-foreground">
                      {botTokenConfigured ? "Token configured" : "No token"}
                    </span>
                  </div>
                  {botInfo?.username ? (
                    <p className="text-xs text-muted-foreground">@{botInfo.username}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-[11px] gap-1"
                      onClick={() =>
                        refreshBotInfo({ pin })
                          .then((r) => {
                            setBotInfo({
                              username: (r as any).username ?? null,
                              name: (r as any).name ?? null,
                            });
                            toast.success(`Connected — @${(r as any).username ?? "unknown"}`);
                          })
                          .catch(onError)
                      }
                    >
                      <RefreshCw className="h-3 w-3" /> Refresh bot info
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-[11px] gap-1"
                    onClick={() => {
                      const id = toast.loading("Enabling real-time chat discovery…");
                      enableChatWebhooks({ pin })
                        .then((r: any) => {
                          toast.dismiss(id);
                          const res = (r?.results ?? []) as Array<{ label: string; ok: boolean }>;
                          const ok = res.filter((x) => x.ok).length;
                          if (ok === res.length && ok > 0) {
                            toast.success(`Real-time discovery on for ${ok} bot(s) — new chats appear instantly`);
                          } else {
                            toast.warning(`Enabled on ${ok}/${res.length} bot(s)`);
                          }
                        })
                        .catch((e) => {
                          toast.dismiss(id);
                          onError(e);
                        });
                    }}
                  >
                    <Wifi className="h-3 w-3" /> Enable real-time chat discovery
                  </Button>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Registers a channel the moment the bot is added as admin — no more waiting for the
                    24h update poll or the manual Sync button. Each bot's webhook points at this app's
                    own receiver; the periodic getUpdates scan automatically skips webhook-covered bots.
                  </p>
                </div>
              </Card>

    <Card
                icon={Bot}
                id="bots"
                title="Bots"
                hint="Extra bots for category-specific delivery"
                className="lg:col-span-3"
              >
                <BotsCard
                  bots={bots}
                  categories={categories}
                  saveBot={saveBot}
                  deleteBot={deleteBot}
                  primaryExcluded={
                    Array.isArray(s.primaryBotExcludedCategories)
                      ? (s.primaryBotExcludedCategories as string[]).map(String)
                      : []
                  }
                  onPrimaryExcludedChange={(next) => save({ primaryBotExcludedCategories: next })}
                />
              </Card>

    <Card icon={Vote} id="polls" title="Polls" hint="Send a test poll">
                <div className="space-y-2">
                  <input id="poll-chat-id" type="number" placeholder="e.g. -1001234567890" className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground" />
                  <Button
                    size="sm"
                    className="h-8 text-[11px] w-full"
                    onClick={() => {
                      const el = document.querySelector<HTMLInputElement>("#poll-chat-id");
                      const chatId = el ? Number(el.value) : 0;
                      if (!chatId) { toast.error("Enter a chat ID"); return; }
                      testPoll({ pin, chatId })
                        .then(() => toast.success("Test poll sent"))
                        .catch(onError);
                    }}
                  >
                    <Play className="h-3 w-3 mr-1" /> Send test poll
                  </Button>
                </div>
              </Card>

    <Card
                icon={BarChart3}
                title="Recent Polls"
                hint={`${polls.length} poll${polls.length !== 1 ? "s" : ""}`}
                className="lg:col-span-3"
              >
                <div className="space-y-1 max-h-[24rem] overflow-y-auto">
                  {polls.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground py-2">No polls sent yet.</p>
                  ) : (
                    polls.map((p: any) => (
                      <div key={p._id} className="rounded-md border border-border px-3 py-2">
                        <div className="flex items-center gap-2 mb-1.5">
                          <Badge variant="secondary" className="text-[10px]">
                            {p.language ?? "en"}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">{p.chatId}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {p.createdAt ? new Date(p.createdAt).toLocaleString() : ""}
                          </span>
                          <Badge
                            className={`text-[10px] ${p.closed ? "bg-muted text-muted-foreground" : "bg-healthy/10 text-healthy"}`}
                          >
                            {p.closed ? "Closed" : "Open"}
                          </Badge>
                        </div>
                        <p className="text-xs font-medium text-foreground">{p.question}</p>
                        {p.options?.length > 0 ? (
                          <div className="mt-1 space-y-0.5">
                            {p.options.map((opt: any, oi: number) => {
                              const total = p.options.reduce((a: number, o: any) => a + (o.voterCount ?? 0), 0);
                              const pct = total > 0 ? Math.round(((opt.voterCount ?? 0) / total) * 100) : 0;
                              const isWinner = total > 0 && opt.voterCount === Math.max(...p.options.map((o: any) => o.voterCount ?? 0));
                              return (
                                <div key={oi} className="flex items-center gap-2 text-[10px]">
                                  <span className="w-16 shrink-0 text-muted-foreground truncate">
                                    {isWinner ? "🏆 " : ""}{opt.text ?? `Option ${oi + 1}`}
                                  </span>
                                  <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                                    <div
                                      className={`h-full rounded-full ${isWinner ? "bg-primary" : "bg-muted-foreground/40"}`}
                                      style={{ width: `${pct}%` }}
                                    />
                                  </div>
                                  <span className="w-10 text-right tabular-nums text-muted-foreground">
                                    {opt.voterCount ?? 0}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </Card>

    <Card
                icon={MessageCircle}
                id="chats"
                title="Chats"
                hint={`${chats.length} chat${chats.length !== 1 ? "s" : ""} — each chat routes to one bot (Primary bot = env token, all categories)`}
                className="sm:col-span-2 lg:col-span-3"
              >
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-[11px] gap-1"
                      onClick={() =>
                        syncBotChats({ pin })
                          .then((r: any) =>
                            toast.success(
                              `Synced — ${r?.chats ?? 0} new chat(s)${r?.scanned ? ` from ${r.scanned} update(s)` : ""}${r?.errors?.length ? ` · ${r.errors.length} bot error(s)` : ""}`,
                            ),
                          )
                          .catch(onError)
                      }
                    >
                      <RefreshCw className="h-3 w-3" /> Sync chats
                    </Button>
                    <AddChat
                      onAdd={(v) =>
                        addChat({ ...pinArgs, chatId: v.chatId, title: v.title, type: v.type }).catch(onError)
                      }
                    />
                  </div>
                  <div className="max-h-[24rem] space-y-3 overflow-y-auto">
                    {chats.length === 0 ? (
                      <p className="py-2 text-[11px] text-muted-foreground">No chats registered yet — add a chat, or press Sync chats above to auto-discover every bot's channels.</p>
                    ) : (
                      chatGroups.map((g) => (
                        <div key={g.key} className="space-y-1">
                          <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5">
                            <div className="flex items-center gap-2">
                              <g.icon className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">{g.title}</span>
                              {g.badge ? (
                                <span className="rounded-full border border-border px-1.5 py-px text-[9px] font-medium uppercase tracking-wider text-muted-foreground">{g.badge}</span>
                              ) : null}
                            </div>
                            <span className="text-[10px] tabular-nums text-muted-foreground">
                              {g.chats.length} chat{g.chats.length !== 1 ? "s" : ""}
                            </span>
                          </div>
                          {g.chats.map(renderChatRow)}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </Card>
    </div>
  );
}
