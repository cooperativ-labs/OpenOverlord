import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
  useParams,
} from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { useState } from "react";

import { SettingsModal } from "./components/modals/SettingsModal.tsx";
import { ThemeToggle } from "./components/theme-toggle.tsx";
import { Button } from "./components/ui/button.tsx";
import { useMeta, useProjects } from "./lib/queries.ts";
import { useRealtime, type LinkState } from "./lib/realtime.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";
import { ProjectBoardShell } from "./pages/ProjectBoardShell.tsx";
import { TicketPanelRoute } from "./pages/TicketPage.tsx";

function RealtimeIndicator() {
  const { state } = useRealtime();
  const config: Record<LinkState, { label: string; dot: string }> = {
    live: { label: "Live", dot: "bg-emerald-400" },
    connecting: { label: "Connecting…", dot: "bg-amber-400" },
    reconnecting: { label: "Reconnecting…", dot: "bg-amber-400 animate-pulse" },
  };
  const c = config[state];
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${c.dot}`} />
      {c.label}
    </div>
  );
}

function ProjectNav() {
  const projects = useProjects();
  // Highlight the active project from the URL without coupling to a specific route.
  const params = useParams({ strict: false }) as { projectId?: string };

  if (!projects.data || projects.data.length === 0) return null;

  return (
    <nav className="mt-2 space-y-0.5">
      {projects.data.map((p) => {
        const active = params.projectId === p.id;
        return (
          <Link
            key={p.id}
            to="/projects/$projectId"
            params={{ projectId: p.id }}
            className={`flex items-center justify-between rounded-md px-2 py-1.5 text-sm ${
              active
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <span className="truncate">{p.name}</span>
            <span className="ml-2 shrink-0 text-xs opacity-60">{p.ticketCount}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function RootLayout() {
  const meta = useMeta();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
        <div className="px-4 py-4">
          <Link to="/projects" className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded bg-primary text-sm font-bold text-primary-foreground">
              O
            </span>
            <span className="font-semibold">Overlord</span>
          </Link>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {meta.data?.workspace.name ?? 'Workspace'}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto px-2">
          <div className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Projects
          </div>
          <ProjectNav />
        </div>
        <div className="space-y-2 border-t border-border px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <RealtimeIndicator />
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label="Settings"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings />
              </Button>
              <ThemeToggle />
            </div>
          </div>
          {meta.data && (
            <p
              className="truncate text-[10px] text-muted-foreground"
              title={meta.data.databasePath}
            >
              {meta.data.databasePath.split('/').slice(-2).join('/')}
            </p>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden bg-background">
        <Outlet />
      </main>
      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/projects" });
  },
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectsPage,
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: ProjectBoardShell,
});

const ticketRoute = createRoute({
  getParentRoute: () => boardRoute,
  path: "tickets/$ticketId",
  component: TicketPanelRoute,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  projectsRoute,
  boardRoute,
  ticketRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
