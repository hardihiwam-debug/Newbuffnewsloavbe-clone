import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { readStoredPin } from "@/routes/index";

export const Route = createFileRoute("/_authenticated")({
  component: ProtectedLayout,
});

function ProtectedLayout() {
  const navigate = useNavigate();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!readStoredPin()) {
      navigate({ to: "/", replace: true });
    }
  }, [navigate]);

  if (typeof window === "undefined" || !readStoredPin()) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Authenticating…</p>
      </div>
    );
  }

  return <Outlet />;
}
