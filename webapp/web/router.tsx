import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useRouterState
} from '@tanstack/react-router';
import { useState } from 'react';

import { AppSidebar } from './components/app-sidebar.tsx';
import { NavHeader } from './components/nav-header.tsx';
import { ProjectCreatorModal } from './components/projects/ProjectCreatorModal.tsx';
import { OrganizationOnboardingScreen } from './components/setup/OrganizationOnboardingScreen.tsx';
import { SidebarInset, SidebarProvider } from './components/ui/sidebar.tsx';
import { useMeta, useProjects, useWorkspaceMyMissions } from './lib/queries.ts';
import { shouldShowOnboarding } from './lib/router-gates.ts';
import { AcceptInvitePage } from './pages/AcceptInvitePage.tsx';
import { MissionPanelRoute } from './pages/MissionPage.tsx';
import { MyMissionsShell, WorkspaceMissionPanelRoute } from './pages/MyMissionsShell.tsx';
import { ProjectBoardShell } from './pages/ProjectBoardShell.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { QuickTaskPage } from './pages/QuickTaskPage.tsx';

function EmptyWorkspaceModal() {
  const projects = useProjects();
  const myMissions = useWorkspaceMyMissions();
  const [dismissed, setDismissed] = useState(false);

  const loaded = !projects.isPending && !myMissions.isPending;
  const isEmpty =
    (projects.data?.length ?? 1) === 0 && (myMissions.data?.missions.length ?? 1) === 0;
  const open = loaded && isEmpty && !dismissed;

  return (
    <ProjectCreatorModal
      open={open}
      onOpenChange={next => {
        if (!next) setDismissed(true);
      }}
    />
  );
}

function RootLayout() {
  const isQuickTask = useRouterState({
    select: state => state.location.pathname === '/quick-task'
  });
  const isAcceptInvite = useRouterState({
    select: state => state.location.pathname === '/accept-invite'
  });
  const meta = useMeta();

  if (isQuickTask) {
    return <Outlet />;
  }

  if (isAcceptInvite) {
    return <Outlet />;
  }

  if (meta.isPending) return null;
  if (shouldShowOnboarding(meta.data)) {
    return <OrganizationOnboardingScreen />;
  }

  return (
    <SidebarProvider className="h-dvh min-h-0 overflow-hidden">
      <AppSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <NavHeader />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>
      </SidebarInset>
      <EmptyWorkspaceModal />
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

const acceptInviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accept-invite',
  component: AcceptInvitePage
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/user' });
  }
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage
});

const myMissionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/user',
  component: MyMissionsShell
});

const workspaceLegacyRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspace',
  beforeLoad: () => {
    throw redirect({ to: '/user' });
  }
});

const workspaceMissionLegacyRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspace/missions/$missionId',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/user/missions/$missionId', params });
  }
});

const myMissionsPanelRoute = createRoute({
  getParentRoute: () => myMissionsRoute,
  path: 'missions/$missionId',
  component: WorkspaceMissionPanelRoute
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: ProjectBoardShell
});

const missionRoute = createRoute({
  getParentRoute: () => boardRoute,
  path: 'missions/$missionId',
  component: MissionPanelRoute
});

export const routeTree = rootRoute.addChildren([
  quickTaskShellRoute.addChildren([quickTaskRoute]),
  acceptInviteRoute,
  indexRoute,
  projectsRoute,
  workspaceLegacyRedirectRoute,
  workspaceMissionLegacyRedirectRoute,
  myMissionsRoute.addChildren([myMissionsPanelRoute]),
  boardRoute.addChildren([missionRoute])
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
