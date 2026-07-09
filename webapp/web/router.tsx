import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
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
import { shouldShowOnboarding, shouldShowOnboardingSetup } from './lib/router-gates.ts';

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
  const isOAuthApprove = useRouterState({
    select: state => state.location.pathname === '/oauth/approve'
  });
  const meta = useMeta();
  const [onboardingSetupDismissed, setOnboardingSetupDismissed] = useState(false);

  if (isQuickTask || isAcceptInvite || isOAuthApprove) {
    return <Outlet />;
  }

  if (meta.isPending) return null;
  if (shouldShowOnboarding(meta.data)) {
    return <OrganizationOnboardingScreen />;
  }
  if (!onboardingSetupDismissed && shouldShowOnboardingSetup(meta.data)) {
    return (
      <OrganizationOnboardingScreen
        onDesktopSetupComplete={() => setOnboardingSetupDismissed(true)}
      />
    );
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
  component: lazyRouteComponent(() => import('./pages/QuickTaskPage.tsx'), 'QuickTaskPage')
});

const acceptInviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accept-invite',
  component: lazyRouteComponent(() => import('./pages/AcceptInvitePage.tsx'), 'AcceptInvitePage')
});

const oauthApproveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/oauth/approve',
  component: lazyRouteComponent(() => import('./pages/OAuthApprovePage.tsx'), 'OAuthApprovePage')
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
  component: lazyRouteComponent(() => import('./pages/ProjectsPage.tsx'), 'ProjectsPage')
});

const myMissionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/user',
  component: lazyRouteComponent(() => import('./pages/MyMissionsShell.tsx'), 'MyMissionsShell')
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
  component: lazyRouteComponent(
    () => import('./pages/MyMissionsShell.tsx'),
    'WorkspaceMissionPanelRoute'
  )
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: lazyRouteComponent(() => import('./pages/ProjectBoardShell.tsx'), 'ProjectBoardShell')
});

const missionRoute = createRoute({
  getParentRoute: () => boardRoute,
  path: 'missions/$missionId',
  component: lazyRouteComponent(() => import('./pages/MissionPage.tsx'), 'MissionPanelRoute')
});

export const routeTree = rootRoute.addChildren([
  quickTaskShellRoute.addChildren([quickTaskRoute]),
  acceptInviteRoute,
  oauthApproveRoute,
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
