import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";
import { adminApi } from "@/lib/adminApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminError } from "@/lib/adminApi";
import { toast } from "sonner";

const PIN_STORAGE_KEY = "freebuff_admin_pin";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sign in · Iran Desk" },
      {
        name: "description",
        content: "Private admin console for the Iran–U.S. conflict Telegram news bot.",
      },
      { property: "og:title", content: "Iran Desk" },
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
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );

  function toggleTheme() {
    const next: "dark" | "light" = document.documentElement.classList.contains("dark") ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* ignore storage errors */
    }
    setTheme(next);
  }

  useEffect(() => {
    if (typeof window !== "undefined" && localStorage.getItem(PIN_STORAGE_KEY)) {
      navigate({ to: "/overview", replace: true });
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
      toast.success("PIN accepted. Opening newsroom…");
      navigate({ to: "/overview" });
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
    <main className="relative flex min-h-screen flex-col items-center justify-center px-4">
      <button
        type="button"
        onClick={toggleTheme}
        className="absolute right-4 top-4 rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
      <div className="w-full max-w-sm text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">
          Newsroom operations
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-[0.08em] text-foreground">
          IRAN DESK
        </h1>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Private access — enter your admin PIN.
        </p>

        <form onSubmit={submit} className="mx-auto mt-8 max-w-[240px] space-y-3">
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
            className="h-11 text-center text-lg tracking-[0.35em]"
          />
          <Button type="submit" className="h-11 w-full" disabled={busy}>
            {busy ? "Verifying…" : "ENTER NEWSROOM"}
          </Button>
        </form>

        <p className="mt-8 flex items-center justify-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-healthy" />
          System online
        </p>
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
