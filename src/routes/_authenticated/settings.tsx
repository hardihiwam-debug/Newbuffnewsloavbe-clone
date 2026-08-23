import { createFileRoute } from "@tanstack/react-router";
import { SettingsShell } from "@/components/settings/SettingsShell";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsShell,
});
