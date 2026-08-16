import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearStoredPin } from "@/routes/index";

// Shared sticky top bar for the authenticated console. Renders the brand,
// the Dashboard / Settings links (highlighted by route) and a Lock action.
// Kept in one place so the two pages stay in sync and the action buttons are
// never duplicated across headers.
export function ConsoleNav() {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const items: Array<{ to: "/dashboard" | "/settings"; label: string }> = [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/settings", label: "Settings" },
  ];

  return (
    <div className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-1 px-4 py-2">
        <Link to="/dashboard" className="mr-2 flex shrink-0 items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            I
          </span>
          <span className="hidden text-sm font-semibold sm:inline">Iran Desk</span>
        </Link>
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          {items.map((it) => {
            const active = path.startsWith(it.to);
            return (
              <Link
                key={it.to}
                to={it.to}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {it.label}
              </Link>
            );
          })}
        </nav>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5"
          onClick={() => {
            clearStoredPin();
            navigate({ to: "/", replace: true });
          }}
        >
          <Lock className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Lock</span>
        </Button>
      </div>
    </div>
  );
}
