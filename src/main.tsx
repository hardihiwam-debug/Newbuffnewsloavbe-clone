import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./styles.css";

// The admin console is fully on Supabase now — no Convex runtime needed.
// The browser SPA calls the Supabase admin edge function directly through
// the helpers in src/lib/* (see supabaseAdminHooks.ts, adminApi.ts).
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
