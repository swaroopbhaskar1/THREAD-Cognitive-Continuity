import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { LogOut } from "lucide-react";
import { getHealthCheckQueryKey, useHealthCheck } from "@workspace/api-client-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function ThreadMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <rect width="48" height="48" rx="12" fill="hsl(200 32% 14%)" />
      <path d="M8 30c6-14 12 6 18-6s10-10 14 0" fill="none" stroke="hsl(8 64% 50%)" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="40" cy="24" r="3.4" fill="hsl(38 36% 94%)" />
      <circle cx="8" cy="30" r="2" fill="hsl(38 36% 94%)" />
    </svg>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const [loc] = useLocation();
  const active = href === "/missions" || href === "/reviews" ? loc.startsWith(href) : loc === href;
  return (
    <Link
      href={href}
      data-testid={`link-nav-${href.replace("/", "")}`}
      aria-current={active ? "page" : undefined}
      className={`relative inline-flex items-center min-h-11 px-3 py-1.5 text-sm rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
    >
      {children}
    </Link>
  );
}

function HealthDot() {
  const { data, isError, isLoading } = useHealthCheck({ query: { refetchInterval: 30000, queryKey: getHealthCheckQueryKey() } });
  const ok = data?.status === "ok" && !isError;
  const label = isLoading ? "Checking server" : ok ? "Server reachable" : "Server unreachable";
  return (
    <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground font-mono" title={label} data-testid="status-health">
      <span className={`h-1.5 w-1.5 rounded-full ${isLoading ? "bg-muted-foreground" : ok ? "bg-accent" : "bg-destructive pulse-dot"}`} />
      {isLoading ? "…" : ok ? "online" : "offline"}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { signOut } = useClerk();
  const { user } = useUser();
  const initials = (user?.firstName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "T").toUpperCase();
  return (
    <div className="min-h-[100dvh] flex flex-col">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 min-h-14 flex flex-wrap items-center gap-x-3 gap-y-2 py-2 sm:h-14 sm:flex-nowrap sm:py-0">
          <Link href="/missions" aria-label="THREAD — Missions" className="flex items-center gap-2 font-display text-lg min-h-11 rounded focus-visible:ring-2 focus-visible:ring-ring" data-testid="link-home">
            <ThreadMark /> <span className="tracking-tight hidden sm:inline">Thread</span>
          </Link>
          <nav aria-label="Main navigation" className="order-3 w-full justify-center flex flex-wrap items-center gap-0.5 sm:order-none sm:w-auto sm:gap-1 sm:ml-2">
            <NavLink href="/missions">Missions</NavLink>
            <NavLink href="/reviews">Reviews</NavLink>
            <NavLink href="/getting-started">Guide</NavLink>
            <NavLink href="/how-it-works">Execution</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <HealthDot />
            <span className="h-8 w-8 rounded-full bg-secondary text-secondary-foreground grid place-items-center text-xs font-semibold" aria-hidden="true">{initials}</span>
            <button
              type="button"
              onClick={() => signOut({ redirectUrl: basePath || "/" })}
              className="inline-flex items-center gap-1.5 min-h-11 min-w-11 justify-center text-sm text-muted-foreground hover:text-foreground rounded-full px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="button-sign-out"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" /> <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
