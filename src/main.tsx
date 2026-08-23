import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { clearStoredPin } from "@/lib/pinStorage";
import "./styles.css";

// The admin console is fully on Supabase now — no Convex runtime needed.
// The browser SPA calls the Supabase admin edge function directly through
// the helpers in src/lib/* (see supabaseAdminHooks.ts, adminApi.ts).

// A rejected/expired session (403 wrong PIN, 429 lockout) clears the stored
// PIN in adminApi.ts and dispatches this event. Navigate back to the sign-in
// form so the operator is never stuck on "Loading console…" with a stale PIN.
let lastAuthRejectedAt = 0;
window.addEventListener("freebuff:auth-rejected", ((e: CustomEvent<{ status?: number }>) => {
  clearStoredPin();
  // A stale-PIN page mount fires several parallel polls, each dispatching
  // this event in the same tick — coalesce to one toast + redirect.
  const now = Date.now();
  if (now - lastAuthRejectedAt < 2_000) return;
  lastAuthRejectedAt = now;
  // Already on the sign-in page? The form's own catch already shows the
  // exact server message (including lockout seconds) — only toast + redirect
  // when this event actually kicked us out of an authenticated page.
  if (router.state.location.pathname === "/") return;
  const status = e.detail?.status;
  toast.error(
    status === 429
      ? "Too many failed attempts — try again in a few minutes"
      : "Session expired — enter your PIN",
  );
  router.navigate({ to: "/", replace: true });
}) as EventListener);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
    <Toaster position="top-right" richColors closeButton />
  </StrictMode>,
);
