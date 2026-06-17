import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useRouterState
} from '@tanstack/react-router';

import { AppSidebar } from './components/app-sidebar.tsx';
import { NavHeader } from './components/nav-header.tsx';
import { InitialSetupScreen } from './components/setup/InitialSetupScreen.tsx';
import { SidebarInset, SidebarProvider } from './components/ui/sidebar.tsx';
import { useMeta } from './lib/queries.ts';
import { ProjectBoardShell } from './pages/ProjectBoardShell.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { QuickTaskPage } from './pages/QuickTaskPage.tsx';
import { TicketPanelRoute } from './pages/TicketPage.tsx';

function RootLayout() {
  const isQuickTask = useRouterState({
    select: state => state.location.pathname === '/quick-task'
  });
  const meta = useMeta();

  if (isQuickTask) {
    return <Outlet />;
  }

  // A fresh instance must name its first workspace (and pick the ticket-id
  // slug) before anything else; hold rendering until we know which to show so
  // the board never flashes behind the setup step.
  if (meta.isPending) return null;
  if (meta.data?.needsSetup) return <InitialSetupScreen />;

  return (
    <SidebarProvider className="h-dvh min-h-0 overflow-hidden">
      <AppSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <NavHeader />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const quickTaskShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'quick-task-shell',
  component: () => <Outlet />
});

const quickTaskRoute = createRoute({
  getParentRoute: () => quickTaskShellRoute,
  path: '/quick-task',
  component: QuickTaskPage
});

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
  quickTaskShellRoute.addChildren([quickTaskRoute]),
  indexRoute,
  projectsRoute,
  boardRoute,
  ticketRoute
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
