import { Outlet, useNavigate, useParams } from '@tanstack/react-router';

import { ProjectWorkspaceErrorBoundary } from '../components/ProjectWorkspaceErrorBoundary.tsx';
import { MissionDrawer } from '../components/MissionDrawer.tsx';
import { MissionPanel } from '../components/MissionPanel.tsx';

import { MyMissionsPage } from './MyMissionsPage.tsx';

/** Layout for the My Missions surface: the aggregate board plus the nested panel. */
export function MyMissionsShell() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ProjectWorkspaceErrorBoundary region="board">
          <MyMissionsPage />
        </ProjectWorkspaceErrorBoundary>
      </main>
      <ProjectWorkspaceErrorBoundary region="mission panel">
        <Outlet />
      </ProjectWorkspaceErrorBoundary>
    </div>
  );
}

/** The mission panel opened from a My Missions card; closes back to `/workspace`. */
export function WorkspaceMissionPanelRoute() {
  const { missionId } = useParams({ from: '/workspace/missions/$missionId' });
  const navigate = useNavigate();
  return (
    <MissionDrawer>
      <MissionPanel
        projectId=""
        missionId={missionId}
        onClose={() => void navigate({ to: '/workspace' })}
        onProjectChanged={() =>
          void navigate({ to: '/workspace/missions/$missionId', params: { missionId } })
        }
      />
    </MissionDrawer>
  );
}
