import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./styles.css";

// ALWAYS go through the same-origin /convex proxy. The Vite dev server
// forwards /convex/* (HTTP + WebSocket) to the local Convex dev backend.
// We deliberately ignore any VITE_CONVEX_URL you might have set: the
// platform port-forward only exposes the Vite port, never Convex's own
// 3210, so a hard-coded http://127.0.0.1:3210 in the build env would make
// the browser hit ITS OWN localhost (which has no Convex) and hang.
const convexUrl = `${window.location.origin}/convex`;
const convex = new ConvexReactClient(convexUrl, { skipConvexDeploymentUrlCheck: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <RouterProvider router={router} />
    </ConvexProvider>
  </StrictMode>,
);
