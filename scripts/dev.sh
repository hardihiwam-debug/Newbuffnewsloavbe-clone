#!/usr/bin/env sh
# Dev launcher for the Freebuff preview session.
#
# The SPA talks DIRECTLY to the Supabase project (VITE_SUPABASE_URL +
# VITE_SUPABASE_ANON_KEY are baked in by vite.config.ts), which serves both
# the pipeline cron and the new `admin` Edge Function. There is no local
# backend to boot — the old version used to wait up to 45s for a Convex dev
# process on :3210, which stalled preview starts whenever the sandbox
# couldn't reach a backend the app never used anyway.
set -e
cd "$(dirname "$0")/.."

# Start Vite in the foreground (this is what the preview session supervises).
exec node_modules/.bin/vite dev
