// Vite bakes `VITE_`-prefixed vars at build time. The two keys needed here
// are VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

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
