import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./styles.css";

// Convex backend URL resolution:
// - Production (Freebuff hosting): the deploy-time VITE_CONVEX_URL points at
//   the real Convex cloud deployment (https://<deployment>.convex.cloud) and
//   is baked into the bundle at build time.
// - Sandbox (Vite dev server): we go through the same-origin /convex proxy,
//   which forwards HTTP + WebSocket to the local Convex dev backend. The
//   dev-only VITE_CONVEX_URL (http://127.0.0.1:3210) is deliberately ignored
//   because the browser can never reach the container's own localhost.
const rawConvexUrl: string | undefined = import.meta.env.VITE_CONVEX_URL;
const convexUrl =
  rawConvexUrl && rawConvexUrl.startsWith("https")
    ? rawConvexUrl
    : `${window.location.origin}/convex`;
const convex = new ConvexReactClient(convexUrl, { skipConvexDeploymentUrlCheck: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <RouterProvider router={router} />
    </ConvexProvider>
  </StrictMode>,
);
