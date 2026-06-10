import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect
} from '@tanstack/react-router';

import { AppSidebar } from './components/app-sidebar.tsx';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger
} from './components/ui/sidebar.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { ProjectBoardShell } from './pages/ProjectBoardShell.tsx';
import { TicketPanelRoute } from './pages/TicketPage.tsx';

function RootLayout() {
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
  boardRoute,
  ticketRoute
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
