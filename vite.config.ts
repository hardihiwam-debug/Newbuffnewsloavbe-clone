import { defineConfig } from "vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Public Supabase values (URL + anon key) that the SPA needs at build time
// to call the `admin` Edge Function. The anon key is designed to ship to
// browsers — RLS is not used; every admin call is PIN-gated server-side,
// and the service-role key never leaves the Edge Function.
//
// If you fork or move this project elsewhere, override these via VITE_
// env vars (still required) instead of editing this file.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "https://ljvdaajfbkqeodglghwn.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.VITE_SUPABASE_ANON_KEY ??
  "sb_publishable_3pC2DqL8nQ-s_LOupzsHCw_naLqPq8N";

export default defineConfig({
  plugins: [
    TanStackRouterVite(),
    viteReact(),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  define: {
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(SUPABASE_URL),
    "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(SUPABASE_ANON_KEY),
  },
  server: {
    host: "0.0.0.0",
    port: parseInt(process.env.PORT || "5173"),
    hmr: false,
  },
});
