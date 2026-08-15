import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser Supabase client. The dashboard is a private admin console, so we
// only ever expose the anon key here (the service-role key is server-only
// and will be used by the future Supabase Edge Functions / pipeline worker,
// never in the Vite bundle).
//
// Vite bakes `VITE_`-prefixed vars at build time. The two keys needed here
// are VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let client: SupabaseClient | null = null;

/** Return a shared browser client. Returns null until VITE_SUPABASE_URL and
 *  VITE_SUPABASE_ANON_KEY are configured, so the app can render its "backend
 *  not configured" state instead of throwing during module evaluation. */
export function getSupabase(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  if (!client) {
    client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return client;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

/** Supabase Edge Function URL (server-side, anon-callable). Used by the SPA
 *  to talk to the `admin` console API. Returns null until VITE_SUPABASE_URL
 *  is set. */
export function adminFunctionUrl(): string | null {
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  if (!url) return null;
  return `${url.replace(/\/$/, "")}/functions/v1/admin`;
}

export const SUPABASE_PROJECT_URL = supabaseUrl ?? "";
