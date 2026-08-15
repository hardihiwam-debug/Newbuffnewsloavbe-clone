import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { adminApi } from "@/lib/adminApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { AdminError } from "@/lib/adminApi";

const PIN_STORAGE_KEY = "freebuff_admin_pin";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sign in · Iran Desk Bot Console" },
      {
        name: "description",
        content: "Private admin console for the Iran–U.S. conflict Telegram news bot.",
      },
      { property: "og:title", content: "Iran Desk Bot Console" },
      { property: "og:description", content: "Private operations console for an automated Iran–U.S. conflict news bot." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SignIn,
});

function SignIn() {
  const navigate = useNavigate();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && localStorage.getItem(PIN_STORAGE_KEY)) {
      navigate({ to: "/dashboard", replace: true });
    }
  }, [navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Verify the PIN against the Supabase admin edge function BEFORE
      // storing anything locally. A wrong PIN used to sail through and
      // leave the dashboard stuck on "Loading console…" — now it's
      // rejected right here on the form.
      await adminApi.verifyPin({ pin: pin.trim() });
      localStorage.setItem(PIN_STORAGE_KEY, pin.trim());
      toast.success("PIN accepted. Opening console…");
      navigate({ to: "/dashboard" });
    } catch (err) {
      const msg =
        err instanceof AdminError
          ? err.message
          : err instanceof Error
            ? err.message
            : "";
      if (/pin/i.test(msg)) {
        toast.error("Incorrect PIN — try again");
      } else {
        toast.error(msg || "Sign-in failed — is the Supabase backend reachable?");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="panel w-full max-w-sm p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">
          Iran Desk
        </p>
        <h1 className="mt-2 text-2xl font-semibold">Bot operations console</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Private access. Enter your admin PIN.
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pin">Admin PIN</Label>
            <Input
              id="pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              placeholder="••••••"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              minLength={4}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Please wait…" : "Unlock console"}
          </Button>
        </form>
      </div>
    </main>
  );
}

export function readStoredPin(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = localStorage.getItem(PIN_STORAGE_KEY);
  return value?.trim() || undefined;
}

export function clearStoredPin() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(PIN_STORAGE_KEY);
}
