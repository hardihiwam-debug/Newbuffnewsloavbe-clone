import { defineConfig } from "vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const CONVEX_BACKEND = process.env.CONVEX_BACKEND_URL || "http://127.0.0.1:3210";

export default defineConfig({
  plugins: [
    TanStackRouterVite(),
    viteReact(),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host: "0.0.0.0",
    port: parseInt(process.env.PORT || "5173"),
    hmr: false,
    // Same-origin proxy so the browser can reach the Convex dev backend
    // without a CORS- or websocket-cross-origin dance (Freebuff port-forwards
    // the preview, but doesn't expose arbitrary container ports).
    proxy: {
      "/convex": {
        target: CONVEX_BACKEND,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/convex/, ""),
      },
    },
  },
});
