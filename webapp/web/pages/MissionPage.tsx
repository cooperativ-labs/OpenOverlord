import { useParams } from '@tanstack/react-router';

import { MissionDrawer } from '../components/MissionDrawer.tsx';
import { MissionPanel } from '../components/MissionPanel.tsx';

export function MissionPanelRoute() {
  const { projectId, missionId } = useParams({
    from: '/projects/$projectId/missions/$missionId'
  });

  return (
    <MissionDrawer>
      <MissionPanel projectId={projectId} missionId={missionId} />
    </MissionDrawer>
  );
}
