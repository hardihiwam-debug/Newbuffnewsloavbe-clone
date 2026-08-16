// Daily Bulletin scheduling logic.
//
// Canonical copy lives at supabase/functions/bulletin/_shared.ts — the edge
// function deployer only ships files inside the function's own folder, so the
// implementation must live there. This file re-exports it so the bun unit
// tests (scripts/bulletin_tests.ts) keep a single source of truth.
export { bulletinDueToday, localDateInTz, type BulletinSettingsLike } from "../bulletin/_shared.ts";
