// Security tab — how the console is protected + the lock action.

import { Button } from "@/components/ui/button";
import { Lock, ShieldCheck } from "lucide-react";
import { Card, useSettings } from "./shared";

export function SecurityTab() {
  const { lock } = useSettings();

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
      <Card icon={ShieldCheck} id="security" title="Security" hint="How this console is protected" className="lg:col-span-2">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 rounded-full bg-healthy" />
            <span className="text-xs font-medium text-foreground">PIN-secured session active</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Every action in this console is gated by the admin PIN, validated server-side against the{" "}
            <code className="rounded bg-muted px-1 py-0.5">ADMIN_PIN</code> secret in Supabase — never a hardcoded
            default. The browser only talks to the PIN-gated{" "}
            <code className="rounded bg-muted px-1 py-0.5">admin</code> edge function; the database itself is
            locked down with row-level security (migration 0007) and is never reached directly.
          </p>
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 rounded-full bg-healthy" />
            <span className="text-xs font-medium text-foreground">Brute-force lockout active</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Wrong login attempts are counted per IP: <span className="font-medium text-foreground">5 failed
            attempts within 15 minutes</span> lock that IP out (HTTP 429) until the window expires. A correct PIN
            clears the counter. Dashboard polls with a stale stored PIN return 403 without counting — only real
            login attempts do. If the <code className="rounded bg-muted px-1 py-0.5">ADMIN_PIN</code> secret is
            missing, the console refuses every PIN (fail-closed) until it is set.
          </p>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[11px] border-destructive/40 text-destructive hover:bg-destructive/10" onClick={lock}>
            <Lock className="h-3.5 w-3.5" /> Lock console now
          </Button>
        </div>
      </Card>
    </div>
  );
}
