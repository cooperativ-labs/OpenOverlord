import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect
} from '@tanstack/react-router';

import { AppSidebar } from './components/app-sidebar.tsx';
import { InitialSetupScreen } from './components/setup/InitialSetupScreen.tsx';
import { SidebarInset, SidebarProvider, SidebarTrigger } from './components/ui/sidebar.tsx';
import { useMeta } from './lib/queries.ts';
import { DatabasePage } from './pages/DatabasePage.tsx';
import { ProjectBoardShell } from './pages/ProjectBoardShell.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { TicketPanelRoute } from './pages/TicketPage.tsx';

function RootLayout() {
  const meta = useMeta();

  // A fresh instance must name its first workspace (and pick the ticket-id
  // slug) before anything else; hold rendering until we know which to show so
  // the board never flashes behind the setup step.
  if (meta.isPending) return null;
  if (meta.data?.needsSetup) return <InitialSetupScreen />;

  return (
    <SidebarProvider className="h-dvh min-h-0 overflow-hidden">
      <AppSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 md:hidden">
          <SidebarTrigger />
          <span className="font-semibold">Overlord</span>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/projects' });
  }
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage
});

const databaseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/database',
  component: DatabasePage
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: ProjectBoardShell
});

const ticketRoute = createRoute({
  getParentRoute: () => boardRoute,
  path: 'tickets/$ticketId',
  component: TicketPanelRoute
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  projectsRoute,
  databaseRoute,
  boardRoute,
  ticketRoute
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
